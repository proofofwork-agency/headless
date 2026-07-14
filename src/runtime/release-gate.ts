import { redactAndTruncate } from "./redaction";
import { recordArtifact } from "./ledger-api";
import { executableReadRoots, maybeWrapWithSandbox, terminateProcessTree } from "../runner/simple";
import { getBackendDefinition } from "../backends/registry";
import { createWorkerEnvironment } from "./worker-environment";
import type { ProjectStateOptions } from "./project-state";
import { cleanupWithDiagnostic, recordRuntimeDiagnostic } from "./diagnostics";

const MAX_GATE_OUTPUT_BYTES = 2_000_000;
const MAX_GATE_TIMEOUT_MS = 86_400_000;

export interface GateCheck { name: string; command: string; args: string[]; }
export interface GateCheckResult extends GateCheck {
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  output: string;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
  containment: { enforced: boolean; mechanism: string };
}
export interface ReleaseGateReport { ok: boolean; startedAt: number; completedAt: number; checks: GateCheckResult[]; timeoutMs: number; }

export const DEFAULT_GATES: GateCheck[] = [
  { name: "check", command: "bun", args: ["run", "check"] },
  { name: "build", command: "bun", args: ["run", "build"] },
];

export interface RunGateOptions {
  checks?: GateCheck[];
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  sessionId?: string;
  authenticatedPrincipal?: string;
  state?: ProjectStateOptions;
  /** When gates run for a candidate, the primary checkout remains read-only. */
  primaryRoot?: string;
  /** Internal callers may record a single project-scoped finality artifact instead. */
  recordArtifact?: boolean;
}

export async function runReleaseGate(checksOrOptions: GateCheck[] | RunGateOptions = DEFAULT_GATES, cwd = process.cwd()) {
  const options = Array.isArray(checksOrOptions) ? { checks: checksOrOptions, cwd } : { ...checksOrOptions, cwd: checksOrOptions.cwd ?? cwd };
  const checks = options.checks ?? DEFAULT_GATES;
  const timeoutMs = boundedTimeout(options.timeoutMs ?? 120_000);
  const startedAt = Date.now();
  const results: GateCheckResult[] = [];

  for (const check of checks) {
    const result = await runGateCheck(check, options.cwd, timeoutMs, options.signal, options.primaryRoot);
    results.push(result);
    if (!result.ok) break;
  }
  const completedAt = Date.now();
  const ok = results.length === checks.length && results.every((result) => result.ok);
  const status = ok ? "passed" : results.some((result) => result.timedOut) ? "timed_out" : "failed";
  if (options.recordArtifact !== false) {
    recordArtifact({
      cwd: options.cwd,
      state: options.state,
      sessionId: options.sessionId,
      authenticatedPrincipal: options.authenticatedPrincipal,
      kind: "release_gate",
      title: "Release gate",
      summary: ok ? "passed" : status,
      status,
      evidence: results.map((result) => `${result.name}:${result.ok ? "PASS" : result.timedOut ? "TIMEOUT" : result.cancelled ? "CANCELLED" : "FAIL"}`),
    });
  }
  return { ok, startedAt, completedAt, checks: results, timeoutMs } satisfies ReleaseGateReport;
}

export function runGateAndReport(options: GateCheck[] | RunGateOptions = DEFAULT_GATES, cwd?: string) {
  return runReleaseGate(Array.isArray(options) ? options : { ...options, cwd: options.cwd ?? cwd }, cwd);
}

async function runGateCheck(check: GateCheck, cwd: string, timeoutMs: number, signal?: AbortSignal, primaryRoot?: string): Promise<GateCheckResult> {
  const started = Date.now();
  if (signal?.aborted) return gateFailure(check, started, "Gate cancelled before launch.", false, true);
  const adapter = getBackendDefinition("opencode");
  if (!adapter) return gateFailure(check, started, "Gate containment adapter is unavailable.", false, false);
  const worker = createWorkerEnvironment();
  const runtimeReadRoots = executableReadRoots([check.command], worker.env);
  const wrapped = maybeWrapWithSandbox(
    [check.command, ...check.args],
    { backend: "opencode", prompt: "release gate", mode: primaryRoot ? "write" : "read-only", containment: "required", authMode: "broker" },
    adapter,
    cwd,
    primaryRoot,
    worker,
    runtimeReadRoots,
  );
  if (!wrapped.sandboxed) {
    await cleanupWithDiagnostic("release-gate.unavailable-worker", worker.cleanup);
    await cleanupWithDiagnostic("release-gate.unavailable-sandbox", wrapped.cleanup);
    return gateFailure(check, started, `Required gate containment is unavailable: ${wrapped.reason}`, false, false);
  }
  let process;
  try {
    process = Bun.spawn(wrapped.cmd, { cwd, env: worker.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
  } catch (error) {
    await cleanupWithDiagnostic("release-gate.spawn-sandbox", wrapped.cleanup);
    await cleanupWithDiagnostic("release-gate.spawn-worker", worker.cleanup);
    return gateFailure(check, started, error instanceof Error ? error.message : String(error), false, false);
  }
  let timedOut = false;
  let cancelled = false;
  let stopping: ReturnType<typeof terminateProcessTree> | null = null;
  const stop = () => {
    stopping ??= terminateProcessTree(process);
    return stopping;
  };
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);
  timeoutHandle.unref?.();
  const abort = () => {
    cancelled = true;
    stop();
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      readCapped(process.stdout as ReadableStream<Uint8Array>, MAX_GATE_OUTPUT_BYTES, stop),
      readCapped(process.stderr as ReadableStream<Uint8Array>, MAX_GATE_OUTPUT_BYTES, stop),
    ]);
    const combined = stdout.text || stderr.text;
    const safe = redactAndTruncate(combined, MAX_GATE_OUTPUT_BYTES);
    return {
      ...check,
      ok: exitCode === 0 && !timedOut && !cancelled && !stdout.truncated && !stderr.truncated,
      exitCode,
      signal: process.signalCode ?? null,
      durationMs: Date.now() - started,
      output: safe.text,
      timedOut,
      cancelled,
      truncated: stdout.truncated || stderr.truncated || safe.truncated,
      containment: { enforced: true, mechanism: wrapped.reason },
    };
  } catch (error) {
    return gateFailure(check, started, error instanceof Error ? error.message : String(error), timedOut, cancelled);
  } finally {
    clearTimeout(timeoutHandle);
    signal?.removeEventListener("abort", abort);
    const pendingTermination = stopping as ReturnType<typeof terminateProcessTree> | null;
    if (pendingTermination) {
      const termination = await pendingTermination;
      if (!termination.exited) {
        recordRuntimeDiagnostic("cleanup", "release-gate.process-tree", new Error("Release-gate process tree did not exit after bounded TERM to KILL escalation."));
      }
    }
    await cleanupWithDiagnostic("release-gate.sandbox", wrapped.cleanup);
    await cleanupWithDiagnostic("release-gate.worker", worker.cleanup);
  }
}

async function readCapped(stream: ReadableStream<Uint8Array>, limit: number, overflow: () => void) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > limit) {
        truncated = true;
        overflow();
        await reader.cancel().catch((error) => recordRuntimeDiagnostic("cleanup", "release-gate.reader-cancel", error));
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    try {
      reader.releaseLock();
    } catch (error) {
      recordRuntimeDiagnostic("cleanup", "release-gate.reader-release", error);
    }
  }
  return { text, truncated };
}

function gateFailure(check: GateCheck, started: number, message: string, timedOut: boolean, cancelled: boolean): GateCheckResult {
  return {
    ...check,
    ok: false,
    exitCode: null,
    signal: null,
    durationMs: Date.now() - started,
    output: redactSafely(message),
    timedOut,
    cancelled,
    truncated: false,
    containment: { enforced: false, mechanism: "unavailable" },
  };
}

function redactSafely(value: string) {
  try {
    return redactAndTruncate(value, MAX_GATE_OUTPUT_BYTES).text;
  } catch {
    return "[SUPPRESSED: REDACTION FAILURE]";
  }
}

function boundedTimeout(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_GATE_TIMEOUT_MS) throw new TypeError("Gate timeout must be a positive bounded integer.");
  return value;
}
