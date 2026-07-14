import type { BackendProbe } from "../contracts/backend";
import { terminateProcessTree } from "../runtime/process-tree";
import { positiveTimeout } from "../runtime/validation";
import { recordRuntimeDiagnostic } from "../runtime/diagnostics";
import { getBackendDefinition, resolveBackendId, type BackendDefinitionProbeSpec } from "./registry";

export type ProbeExecution = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  overflowed: boolean;
  error?: string;
};

export type BoundedProbeExecutionOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};

export type ProbeExecutor = (argv: readonly string[], limits: Pick<BackendDefinitionProbeSpec, "timeoutMs" | "maxOutputBytes">) => Promise<ProbeExecution>;

/** Probe the exact CLI flags Headless relies on, with bounded time and output. */
export async function probeBackendDefinition(id: string, execute?: ProbeExecutor): Promise<BackendProbe> {
  const resolved = resolveBackendId(id);
  const adapter = getBackendDefinition(resolved);
  if (!adapter) return failedProbe("Adapter is not registered.");
  if (!execute) return { ok: false, version: null, capabilities: adapter.capabilities, reason: "A contained probe executor is required." };
  const limits = { timeoutMs: adapter.probe.timeoutMs, maxOutputBytes: adapter.probe.maxOutputBytes };
  const versionResult = await execute(adapter.probe.versionCommand, limits);
  if (versionResult.error) return { ok: false, version: null, capabilities: adapter.capabilities, reason: versionResult.error.slice(0, 2_048) };
  if (versionResult.timedOut) return { ok: false, version: null, capabilities: adapter.capabilities, reason: "Version probe timed out." };
  if (versionResult.overflowed) return { ok: false, version: null, capabilities: adapter.capabilities, reason: "Version probe exceeded its output limit." };
  if (versionResult.exitCode !== 0) return { ok: false, version: null, capabilities: adapter.capabilities, reason: `Version probe exited ${String(versionResult.exitCode)}.` };
  const version = parseVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
  if (adapter.probe.minimumVersion && (!version || compareVersions(version, adapter.probe.minimumVersion) < 0)) {
    return {
      ok: false,
      version,
      capabilities: adapter.capabilities,
      reason: version
        ? `Backend version ${version} is older than required ${adapter.probe.minimumVersion}.`
        : `Backend did not report a version; ${adapter.probe.minimumVersion} or newer is required.`,
    };
  }

  const helpResult = await execute(adapter.probe.helpCommand, limits);
  if (helpResult.error) return { ok: false, version, capabilities: adapter.capabilities, reason: helpResult.error.slice(0, 2_048) };
  if (helpResult.timedOut) return { ok: false, version, capabilities: adapter.capabilities, reason: "Capability probe timed out." };
  if (helpResult.overflowed) return { ok: false, version, capabilities: adapter.capabilities, reason: "Capability probe exceeded its output limit." };
  if (helpResult.exitCode !== 0) return { ok: false, version, capabilities: adapter.capabilities, reason: `Capability probe exited ${String(helpResult.exitCode)}.` };
  const help = `${helpResult.stdout}\n${helpResult.stderr}`;
  const missing = adapter.probe.requiredHelpFragments.filter((fragment) => !help.includes(fragment));
  return missing.length
    ? { ok: false, version, capabilities: adapter.capabilities, reason: `Required CLI capabilities are unavailable: ${missing.join(", ")}.`.slice(0, 2_048) }
    : { ok: true, version, capabilities: adapter.capabilities, reason: null };
}

export async function executeBoundedProbe(
  argv: readonly string[],
  { timeoutMs, maxOutputBytes }: Pick<BackendDefinitionProbeSpec, "timeoutMs" | "maxOutputBytes">,
  options: BoundedProbeExecutionOptions,
): Promise<ProbeExecution> {
  const boundedTimeoutMs = positiveTimeout(timeoutMs, { max: 30_000, name: "probe timeoutMs" });
  if (options.signal?.aborted) {
    return { exitCode: null, stdout: "", stderr: "", timedOut: false, overflowed: false, error: "Capability probe was cancelled." };
  }
  let child;
  try {
    child = Bun.spawn([...argv], {
      cwd: options.cwd,
      env: options.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
  } catch (error) {
    recordRuntimeDiagnostic("transport", "backend-probe.spawn", error);
    return { exitCode: null, stdout: "", stderr: "", timedOut: false, overflowed: false, error: "Capability probe process could not be started." };
  }
  let timedOut = false;
  let overflowed = false;
  let cancelled = false;
  let stopping: ReturnType<typeof terminateProcessTree> | null = null;
  const stop = () => {
    stopping ??= terminateProcessTree(child, { graceMs: 100 });
  };
  const abort = () => {
    cancelled = true;
    stop();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timeout = setTimeout(() => {
    timedOut = true;
    stop();
  }, boundedTimeoutMs);
  timeout.unref?.();
  const budget = { remaining: maxOutputBytes };
  let exitFailure = false;
  const [stdout, stderr, exitCode] = await Promise.all([
    readBounded(child.stdout, budget, () => { overflowed = true; stop(); }),
    readBounded(child.stderr, budget, () => { overflowed = true; stop(); }),
    child.exited.catch((error) => {
      exitFailure = true;
      recordRuntimeDiagnostic("transport", "backend-probe.exit", error);
      return null;
    }),
  ]);
  clearTimeout(timeout);
  options.signal?.removeEventListener("abort", abort);
  if (stopping) await stopping;
  return {
    exitCode,
    stdout,
    stderr,
    timedOut,
    overflowed,
    error: cancelled ? "Capability probe was cancelled." : exitFailure ? "Capability probe exit status was unavailable." : undefined,
  };
}

async function readBounded(stream: ReadableStream<Uint8Array>, budget: { remaining: number }, overflow: () => void) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = budget.remaining;
      if (value.byteLength > remaining) {
        if (remaining > 0) output += decoder.decode(value.subarray(0, remaining), { stream: true });
        budget.remaining = 0;
        overflow();
        break;
      }
      budget.remaining -= value.byteLength;
      output += decoder.decode(value, { stream: true });
    }
  } finally {
    try {
      reader.releaseLock();
    } catch (error) {
      recordRuntimeDiagnostic("cleanup", "backend-probe.reader-release", error);
    }
  }
  return output + decoder.decode();
}

function parseVersion(output: string) {
  return output.match(/(?:^|[^0-9])(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/)?.[1] ?? null;
}

function compareVersions(left: string, right: string) {
  const a = left.split(/[+-]/, 1)[0].split(".").map(Number);
  const b = right.split(/[+-]/, 1)[0].split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

function failedProbe(reason: string): BackendProbe {
  return {
    ok: false,
    version: null,
    capabilities: {
      write: false,
      streaming: false,
      structuredOutput: false,
      nativeResume: false,
      cancellation: false,
      tools: false,
      effort: false,
      brokerCompatible: false,
    },
    reason,
  };
}
