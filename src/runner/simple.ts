import { spawn, type Subprocess } from "bun";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExecOptions } from "../index";
import type { ExperimentalExecResult as ExecResult } from "../experimental/exec-result";
import { assertModeAllowed, getBackendDefinition, requiredContainmentSecurityGaps, type BackendDefinition } from "../backends/registry";
import { appendAdapterDiagnostic, classifyAdapterFailure, normalizeAdapterResult } from "../backends/result-normalization";
import { executeBoundedProbe, probeBackendDefinition, type ProbeExecutor } from "../backends/probe";
import { runIsolationAttestation } from "../runtime/isolation-attestation";
import {
  buildLinuxReadOnlyArgs,
  buildLinuxWriteSandboxArgs,
  cleanupSandboxProfile,
  DARWIN_SANDBOX_EXEC,
  probeDarwinSandboxWriteDenial,
  probeHardlinkRisk,
  probeLinuxBwrap,
  sandboxCredentialRoots,
  writeDarwinReadOnlySandboxProfile,
  writeDarwinWriteSandboxProfile,
  BWRAP,
} from "../runtime/os-sandbox";
import {
  captureWriteDiff,
  createWriteWorktree,
  planWriteWorktree,
  removeWriteWorktree,
  type WorktreeLeaseHooks,
  type WriteDiff,
} from "../runtime/worktree";
import { redactAndTruncate, StreamingRedactor } from "../runtime/redaction";
import { createWorkerEnvironment, type WorkerEnvironment } from "../runtime/worker-environment";
import { installNativeAuthCapsule, nativeAuthMinimumValidityMs, supportsNativeAuthCapsule } from "../runtime/native-auth-capsule";
import { terminateProcessTree as terminateChildProcessTree } from "../runtime/process-tree";
import { positiveTimeout } from "../runtime/validation";
import { cleanupWithDiagnostic, recordRuntimeDiagnostic } from "../runtime/diagnostics";
import { HeadlessError, isHeadlessError, toHeadlessError } from "../runtime/headless-error";
import { BROKER_UNIX_ONLY_RELAY_PORT } from "../broker/server";
import { installRunToolClient, withRunToolInstructions, type RunToolWorkerAccess } from "../runtime/run-tool-client";
import { executableReadRoots, resolveExecutable } from "../runtime/executable-read-roots";
import { stageDarwinBunScript } from "../runtime/darwin-bun-stage";
import {
  integrateWriteCandidate,
  type WriteExecutionSummary,
  type WriteIntegrationPolicy,
  type WriteIntegrationResult,
} from "../runtime/write-integration";

const DEFAULT_TIMEOUT = 180_000;
const STREAM_CAP_BYTES = 262_144;
const TERMINATION_GRACE_MS = 1_500;

type ExecutionSupervisorState = {
  activeProcesses: Set<Subprocess>;
  darwinProbe: ReturnType<typeof probeDarwinSandboxWriteDenial> | null;
  linuxProbe: ReturnType<typeof probeLinuxBwrap> | null;
};

type SandboxWrap = {
  cmd: string[];
  cleanup: () => void;
  sandboxed: boolean;
  reason: string;
  network: "broker-only" | "native-direct-unrestricted" | "denied" | "unrestricted";
  credentialAccess: "backend-native" | "broker-lease" | "none";
};

/**
 * A daemon-issued provider lease as it is handed to one worker.
 *
 * `baseUrl` is the only provider endpoint the worker ever learns, and the lease
 * token travels with it. Whether that URL resolves to anything depends on the
 * broker's edges, so the issuer must state it rather than let the runner guess.
 */
export type BrokerWorkerAccess = {
  provider: string;
  baseUrl: string;
  token: string;
  unixSocket?: string;
  /**
   * False when the issuing broker has NO host loopback TCP listener. `baseUrl`
   * then names the synthetic relay port, which exists only inside a Linux
   * worker network namespace where the containment supervisor binds it and
   * forwards to `unixSocket`. Absent means the caller owns a real host listener
   * on `baseUrl` (direct library and test callers that serve their own port).
   */
  hostLoopbackListener?: boolean;
};

export type InternalRunOptions = ExecOptions & {
  backend: string;
  jobId?: string;
  /** Test/daemon-owned host home used only to derive an audited native capsule. */
  authHomeDir?: string;
  resumeNativeSessionId?: string;
  /** Opaque daemon-issued lease; intentionally absent from the public ExecOptions. */
  broker?: BrokerWorkerAccess;
  /** Daemon-owned write policy. Direct library callers intentionally cannot set this through ExecOptions. */
  writeIntegration?: WriteIntegrationPolicy;
  /** Daemon-owned durable checkout manifests. */
  worktreeLease?: WorktreeLeaseHooks;
  /** Chain this write onto an earlier candidate commit instead of primary HEAD. */
  candidateBase?: string | null;
  /** Short-lived daemon cooperation capability; absent from public ExecOptions. */
  runTool?: RunToolWorkerAccess;
};

/** Owns containment probes, active descendants, deadlines, cleanup, and output bounds. */
export class ExecutionSupervisor {
  private readonly state: ExecutionSupervisorState = {
    activeProcesses: new Set(),
    darwinProbe: null,
    linuxProbe: null,
  };

  execute(options: InternalRunOptions): Promise<ExecResult> {
    return executeSupervisedRun(options, this.state);
  }

  async terminateAll(signal: "SIGTERM" | "SIGKILL" = "SIGTERM") {
    return await Promise.all(
      [...this.state.activeProcesses].map((process) => terminateProcessTree(
        process,
        signal === "SIGKILL" ? 0 : TERMINATION_GRACE_MS,
      )),
    );
  }

  wrapWithSandbox(
    command: string[],
    options: ExecOptions & {
      backend: string;
      broker?: InternalRunOptions["broker"];
      runTool?: RunToolWorkerAccess;
      sandboxNetwork?: "denied" | "native-auth-local" | "provider-direct";
    },
    adapter: BackendDefinition,
    cwd: string,
    primaryRootForWrite?: string,
    worker?: WorkerEnvironment,
    runtimeReadRoots: string[] = [],
  ) {
    return wrapWithSandboxWithoutState(
      command,
      options,
      adapter,
      cwd,
      primaryRootForWrite,
      worker,
      runtimeReadRoots,
      this.state,
    );
  }
}

export const defaultExecutionSupervisor = new ExecutionSupervisor();

/** Experimental compatibility entry; stable callers submit through exec(). */
export function runHeadless(options: InternalRunOptions) {
  return defaultExecutionSupervisor.execute(options);
}

export function killAllActiveRunners(signal: "SIGTERM" | "SIGKILL" = "SIGTERM") {
  return defaultExecutionSupervisor.terminateAll(signal);
}

async function executeSupervisedRun(
  options: InternalRunOptions,
  supervisor: ExecutionSupervisorState,
): Promise<ExecResult> {
  const started = Date.now();
  const cwd = options.cwd ?? process.cwd();
  const containment = containmentRequirement(options);
  const authMode = options.authMode ?? "broker";
  const timeoutMs = timeout(options.timeoutMs);

  if (process.platform === "win32") {
    return failedResult(options.backend, "UNSUPPORTED_PLATFORM", "Headless v0.2 supports macOS and Linux; Windows is unsupported.", Date.now() - started, containment);
  }
  if (options.signal?.aborted) {
    return failedResult(options.backend, "CANCELLED", "Run was cancelled before preparation.", Date.now() - started, containment, "cancelled");
  }

  const adapter = getBackendDefinition(options.backend);
  if (!adapter) return failedResult(options.backend, "BACKEND_UNAVAILABLE", `Backend adapter ${options.backend} is not registered.`, Date.now() - started, containment);

  // Gate the lease before any worker environment, credential capsule, sandbox
  // profile, or process exists: an endpoint nothing will answer must never be
  // paired with a bearer token in a worker's environment.
  if (options.broker) {
    try {
      assertBrokerEndpointIsServed(options.broker, { containment });
    } catch (error) {
      const typed = toHeadlessError(error, {
        code: "CONTAINMENT_UNAVAILABLE",
        safeMessage: "The daemon provider broker endpoint cannot be served to this worker.",
      });
      return failedResult(options.backend, typed.code, typed.safeMessage, Date.now() - started, containment, "blocked");
    }
  }

  if (containment === "required") {
    if (authMode === "broker" && adapter.security.strictAuth === "broker-api-key" && !options.broker) {
      return failedResult(options.backend, "AUTH_UNAVAILABLE", `Backend ${options.backend} requires a daemon-issued provider broker lease in required containment. OAuth, keychain, and host credential fallback are disabled.`, Date.now() - started, containment);
    }
    const unsupported = requiredContainmentSecurityGaps(adapter, options.mode);
    if (unsupported.length) {
      return failedResult(options.backend, "BACKEND_UNSUPPORTED", `Backend ${options.backend} cannot run in required containment because it does not disable: ${unsupported.join(", ")}.`, Date.now() - started, containment);
    }
  }

  try {
    assertModeAllowed(options.backend, options.mode);
  } catch (error) {
    return failedResult(options.backend, "BACKEND_UNSUPPORTED", messageOf(error), Date.now() - started, containment);
  }

  const worker = createWorkerEnvironment();
  try {
    let nativeOptions = options;
    if (authMode === "native-login" && adapter.security.strictAuth !== "credential-free") {
      let capsule;
      try {
        capsule = installNativeAuthCapsule(worker, adapter.id, {
          homeDir: options.authHomeDir,
          requestedModel: options.model,
          resolveOpenCodeModel: adapter.nativeAuth?.resolveModel ?? false,
          minimumValidityMs: nativeAuthMinimumValidityMs(options.timeoutMs ?? adapter.metadata.timeoutMs),
        });
      } catch (error) {
        if (isHeadlessError(error)) {
          return failedResult(options.backend, error.code, error.safeMessage, Date.now() - started, containment);
        }
        return failedResult(
          options.backend,
          "NATIVE_AUTH_UNAVAILABLE",
          "Native authentication state could not be prepared safely.",
          Date.now() - started,
          containment,
          "blocked",
        );
      }
      if (!capsule.available) {
        return failedResult(options.backend, "NATIVE_AUTH_UNAVAILABLE", capsule.reason ?? "Native authentication is unavailable.", Date.now() - started, containment, "blocked");
      }
      if (capsule.model) nativeOptions = { ...options, model: capsule.model };
    }
    adapter.configureWorker?.(worker, { authHomeDir: options.authHomeDir });
    if (containment === "required") {
      const probe = await probeBackendDefinition(options.backend, containedProbeExecutor(options, adapter, cwd, worker, supervisor));
      if (!probe.ok) {
        if (options.signal?.aborted) {
          return failedResult(options.backend, "CANCELLED", "Run was cancelled during the backend capability probe.", Date.now() - started, containment, "cancelled");
        }
        return failedResult(options.backend, "BACKEND_UNAVAILABLE", `Backend ${options.backend} capability probe failed: ${probe.reason ?? "unknown failure"}`, Date.now() - started, containment);
      }
    }
    if (adapter.isolationAttestation) {
      const inspection = adapter.isolationAttestation;
      const limits = { timeoutMs: inspection.timeoutMs, maxOutputBytes: inspection.maxOutputBytes };
      const failure = await runIsolationAttestation({
        spec: inspection,
        primaryCwd: cwd,
        worker,
        // Each cwd needs its own sandbox profile, so the executor is rebuilt per
        // inspection rather than bound once.
        inspect: (inspectCwd) =>
          containedProbeExecutor(options, adapter, inspectCwd, worker, supervisor)(inspection.command, limits),
      });
      if (failure) {
        return failedResult(
          options.backend,
          "BACKEND_UNSUPPORTED",
          `Grok isolation attestation failed before provider access: ${failure}`,
          Date.now() - started,
          containment,
          "blocked",
        );
      }
    }
    if (options.runTool) {
      if (containment !== "required") throw new Error("Run-scoped daemon tools are available only in required containment.");
      Object.assign(worker.env, installRunToolClient(worker, options.runTool));
    }
    const prepared = nativeOptions.runTool
      ? { ...nativeOptions, prompt: withRunToolInstructions(nativeOptions.prompt, options.runTool!.operations) }
      : nativeOptions;
    const env = adapterEnvironment(adapter, worker, prepared);
    if (prepared.mode === "write") return await runContainedWrite(prepared, adapter, cwd, env, worker, started, timeoutMs, containment, supervisor);
    return await runBackendProcess(prepared, adapter, cwd, env, worker, started, timeoutMs, containment, undefined, supervisor);
  } finally {
    await cleanupWithDiagnostic("runner.worker-environment", worker.cleanup);
  }
}

async function runContainedWrite(
  options: InternalRunOptions,
  adapter: BackendDefinition,
  cwd: string,
  env: NodeJS.ProcessEnv,
  worker: WorkerEnvironment,
  started: number,
  timeoutMs: number,
  containment: "required" | "unsafe",
  supervisor: ExecutionSupervisorState,
) {
  let plan;
  let leasePrepared = false;
  try {
    plan = planWriteWorktree({
      primaryRoot: cwd,
      label: options.backend,
      tempBase: options.worktreeLease?.tempBase,
      baseSha: options.candidateBase ?? undefined,
    });
    options.worktreeLease?.onPlanned(plan, "candidate");
    leasePrepared = !!options.worktreeLease;
    createWriteWorktree(plan);
    try {
      options.worktreeLease?.onCreated(plan, "candidate");
    } catch (error) {
      try {
        removeWriteWorktree(plan, { force: true, pruneBranch: true });
      } catch (cleanupError) {
        recordRuntimeDiagnostic("state", "runner.worktree-create-rollback", cleanupError);
        throw new Error(`${messageOf(error)}; worktree rollback also failed: ${messageOf(cleanupError)}`, { cause: error });
      }
      throw error;
    }
  } catch (error) {
    let leaseFailure: string | null = null;
    if (plan && leasePrepared) {
      try {
        options.worktreeLease?.onTerminal(plan, "creation_failed", [messageOf(error)]);
      } catch (terminalError) {
        leaseFailure = `Failed to persist terminal worktree lease: ${messageOf(terminalError)}`;
        recordRuntimeDiagnostic("state", "runner.worktree-lease-creation-failure", terminalError);
      }
    }
    const baseMessage = messageOf(error).includes("not a git worktree root") ? `write mode requires a git repository: ${cwd}` : messageOf(error);
    const message = leaseFailure ? `${baseMessage}; ${leaseFailure}` : baseMessage;
    return failedResult(options.backend, "PROCESS_ERROR", message, Date.now() - started, containment);
  }

  let result = failedResult(options.backend, "PROCESS_ERROR", "Write backend did not run.", Date.now() - started, containment);
  let captured: WriteDiff | null = null;
  let integration: WriteIntegrationResult | null = null;
  let integrationOwnsCleanup = false;
  try {
    result = await runBackendProcess(options, adapter, plan.worktreePath, env, worker, started, timeoutMs, containment, cwd, supervisor);
    try {
      captured = captureWriteDiff(plan);
    } catch (error) {
      result = markFailed(result, "PROCESS_ERROR", `Failed to capture write diff: ${messageOf(error)}`);
    }
    if (captured && options.writeIntegration) {
      integrationOwnsCleanup = true;
      integration = await integrateWriteCandidate({
        plan,
        diff: captured,
        execution: executionSummary(result),
        policy: { ...options.writeIntegration, worktreeLease: options.worktreeLease },
      });
      result = applyWriteIntegration(result, integration);
    }
  } catch (error) {
    result = failedResult(options.backend, "PROCESS_ERROR", messageOf(error), Date.now() - started, containment);
  } finally {
    if (!integrationOwnsCleanup) {
      try {
        removeWriteWorktree(plan, { force: true });
      } catch (error) {
        result = markFailed(result, "PROCESS_ERROR", `Failed to clean up write worktree: ${messageOf(error)}`);
      }
    }
    if (leasePrepared) {
      try {
        options.worktreeLease!.onTerminal(
          plan,
          integration?.outcome ?? result.status ?? (result.ok ? "succeeded" : "failed"),
          integration?.evidence,
        );
      } catch (error) {
        result = markFailed(result, "PROCESS_ERROR", `Failed to persist terminal worktree lease: ${messageOf(error)}`);
      }
    }
  }
  const safeDiff = captured ? redactWriteDiff(captured) : null;
  const diffTruncated = captured
    ? Buffer.byteLength(captured.diff) > STREAM_CAP_BYTES
      || Buffer.byteLength(captured.status) > 65_536
      || captured.files.length > 256
      || captured.files.some((file) => Buffer.byteLength(file) > 2_000)
    : false;
  return {
    ...result,
    outputTruncated: result.truncated,
    truncated: result.truncated || diffTruncated,
    diffTruncated,
    diff: safeDiff ? {
      ...safeDiff,
      baseCommit: integration?.baseCommit ?? plan.baseSha,
      candidateCommit: integration?.candidateCommit ?? null,
      resultingCommit: integration?.resultingCommit ?? null,
    } : null,
    worktreeBranch: integration?.branch ?? plan.branch,
    commit: integration ? {
      base: integration.baseCommit,
      candidate: integration.candidateCommit,
      result: integration.resultingCommit,
      merged: integration.merged,
    } : null,
    writeOutcome: integration?.outcome ?? null,
  };
}

async function runBackendProcess(
  options: InternalRunOptions,
  adapter: BackendDefinition,
  cwd: string,
  env: NodeJS.ProcessEnv,
  worker: WorkerEnvironment,
  started: number,
  timeoutMs: number,
  containment: "required" | "unsafe",
  primaryRootForWrite?: string,
  supervisor?: ExecutionSupervisorState,
): Promise<ExecResult> {
  let command: string[];
  try {
    command = options.resumeNativeSessionId
      ? adapter.buildResumeCommand?.(options, cwd, options.resumeNativeSessionId)
        ?? (() => { throw new Error(`Backend ${adapter.id} does not implement native resume.`); })()
      : adapter.prepareCommand(options, cwd);
  } catch (error) {
    return failedResult(options.backend, "BACKEND_UNAVAILABLE", `Backend command preparation failed: ${messageOf(error)}`, Date.now() - started, containment);
  }
  const runtimeReadRoots = executableReadRoots(command, env);
  const wrapped = wrapWithSandboxWithoutState(
    command,
    options,
    adapter,
    cwd,
    primaryRootForWrite,
    worker,
    runtimeReadRoots,
    supervisor,
  );

  if (containment === "required" && !wrapped.sandboxed) {
    await cleanupWithDiagnostic("runner.unavailable-sandbox", wrapped.cleanup);
    return failedResult(options.backend, "CONTAINMENT_UNAVAILABLE", `Required containment is unavailable: ${wrapped.reason}`, Date.now() - started, containment);
  }
  if (containment === "required") {
    const hardlink = probeHardlinkRisk(cwd);
    if (!hardlink.ok) {
      await cleanupWithDiagnostic("runner.hardlink-probe", wrapped.cleanup);
      return failedResult(options.backend, "CONTAINMENT_UNAVAILABLE", hardlink.reason, Date.now() - started, containment);
    }
  }

  let process: Subprocess | null = null;
  let timedOut = false;
  let cancelled = false;
  let overflowed = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let stopping: ReturnType<typeof terminateProcessTree> | null = null;
  const stop = () => {
    if (process) stopping ??= terminateProcessTree(process);
    return stopping;
  };
  const abort = () => {
    cancelled = true;
    stop();
  };
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    process = spawn(wrapped.cmd, {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: adapter.stdinPrompt ? "pipe" : undefined,
      detached: true,
    });
    supervisor?.activeProcesses.add(process);
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    timeoutHandle.unref?.();

    if (adapter.stdinPrompt && process.stdin && typeof process.stdin !== "number") {
      process.stdin.write(`${options.prompt}\n`);
      process.stdin.end();
    }

    const onOverflow = () => {
      overflowed = true;
      stop();
    };
    const stream = safeStreamCallback(options.onStdoutChunk);
    const [exitCode, stdoutRead, stderrRead] = await Promise.all([
      process.exited,
      readStreamCapped(process.stdout as ReadableStream<Uint8Array>, STREAM_CAP_BYTES, onOverflow, stream?.push)
        .finally(() => stream?.finish()),
      // stderr is retained separately and redacted as one bounded value below.
      // Sending it through the stdout callback would misclassify durable events.
      readStreamCapped(process.stderr as ReadableStream<Uint8Array>, STREAM_CAP_BYTES, onOverflow),
    ]);
    const durationMs = Date.now() - started;
    const parsed = normalizeAdapterResult(adapter.decodeOutput(stdoutRead.text), adapter.id);
    const callbackFailures = stream?.failureCount() ?? 0;
    if (callbackFailures > 0) {
      appendAdapterDiagnostic(
        parsed.diagnostics,
        `User stdout callback failed ${callbackFailures} time${callbackFailures === 1 ? "" : "s"}; backend execution continued.`,
        { ignored: callbackFailures },
      );
    }
    const parsedOutput = parsed.output || parsed.error || stderrRead.text.trim() || "No assistant output was produced by the backend.";
    const output = redactSafely(parsedOutput);
    const stderr = redactSafely(stderrRead.text);
    const noAssistantOutput = !parsed.output && !parsed.error;
    const ok = isSuccessfulRun({ timedOut, cancelled, overflowed, parseError: parsed.error, noAssistantOutput, exitCode });
    const classified = ok || cancelled || timedOut || overflowed ? null : classifyAdapterFailure({
      authMode: options.authMode ?? "broker",
      error: parsed.error,
      output: parsed.output,
      stderr: stderrRead.text,
      malformedEvents: parsed.diagnostics.malformedEvents,
    });
    const status = cancelled
      ? "cancelled"
      : timedOut
        ? "timed_out"
        : ok
          ? "succeeded"
          : classified?.status ?? "failed";
    const errorCode = cancelled
      ? "CANCELLED"
      : timedOut
        ? "TIMED_OUT"
        : overflowed
          ? "OUTPUT_OVERFLOW"
          : ok
            ? null
            : classified?.code ?? "PROCESS_ERROR";
    return {
      ok,
      status,
      error: errorCode ? { code: errorCode, message: output.text, retryable: classified?.retryable ?? false } : null,
      backend: options.backend,
      output: output.text,
      stderr: stderr.text,
      diagnostics: parsed.diagnostics,
      cost: parsed.cost,
      tokens: parsed.tokens,
      usage: parsed.usage,
      durationMs,
      exitCode,
      signal: process.signalCode ?? null,
      timedOut,
      sandboxed: wrapped.sandboxed,
      sandboxReason: wrapped.reason,
      containment: containmentEvidence(containment, wrapped, worker),
      redacted: output.redacted || stderr.redacted,
      truncated: output.truncated || stderr.truncated || stdoutRead.truncated || stderrRead.truncated,
    };
  } catch (error) {
    return failedResult(options.backend, cancelled ? "CANCELLED" : "PROCESS_ERROR", messageOf(error), Date.now() - started, containment, cancelled ? "cancelled" : "failed", wrapped, worker);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    options.signal?.removeEventListener("abort", abort);
    const pendingTermination = stopping as ReturnType<typeof terminateProcessTree> | null;
    if (pendingTermination) {
      const termination = await pendingTermination;
      if (!termination.exited) {
        recordRuntimeDiagnostic("cleanup", "runner.process-tree", new Error("Backend process tree did not exit after bounded TERM to KILL escalation."));
      }
    }
    if (process) supervisor?.activeProcesses.delete(process);
    await cleanupWithDiagnostic("runner.sandbox-wrapper", wrapped.cleanup);
  }
}

export function isSuccessfulRun(input: {
  timedOut: boolean;
  cancelled?: boolean;
  overflowed?: boolean;
  parseError: string | null;
  noAssistantOutput: boolean;
  exitCode: number | null;
}) {
  return !input.timedOut && !input.cancelled && !input.overflowed && !input.parseError && !input.noAssistantOutput && input.exitCode === 0;
}

export function maybeWrapWithSandbox(
  command: string[],
  options: ExecOptions & {
    backend: string;
    broker?: InternalRunOptions["broker"];
    runTool?: RunToolWorkerAccess;
    /** Daemon-only probe restriction; never accepted at a public boundary. */
    sandboxNetwork?: "denied" | "native-auth-local" | "provider-direct";
  },
  adapter: BackendDefinition,
  cwd: string,
  primaryRootForWrite?: string,
  worker?: WorkerEnvironment,
  runtimeReadRoots: string[] = [],
): SandboxWrap {
  return defaultExecutionSupervisor.wrapWithSandbox(
    command,
    options,
    adapter,
    cwd,
    primaryRootForWrite,
    worker,
    runtimeReadRoots,
  );
}

function wrapWithSandboxWithoutState(
  command: string[],
  options: ExecOptions & {
    backend: string;
    broker?: InternalRunOptions["broker"];
    runTool?: RunToolWorkerAccess;
    sandboxNetwork?: "denied" | "native-auth-local" | "provider-direct";
  },
  adapter: BackendDefinition,
  cwd: string,
  primaryRootForWrite?: string,
  worker?: WorkerEnvironment,
  runtimeReadRoots: string[] = [],
  supervisor?: ExecutionSupervisorState,
): SandboxWrap {
  const containment = containmentRequirement(options);
  // Second, independent gate for callers that reach the sandbox builder without
  // going through executeSupervisedRun. It runs before the unsafe-containment
  // early return so no profile can open the synthetic relay port and no
  // uncontained command can be built around an unowned endpoint.
  if (options.broker) assertBrokerEndpointIsServed(options.broker, { containment });
  const authMode = options.authMode ?? "broker";
  // Provider-direct is granted only to an audited backend with a concrete
  // regular-file capsule path. Legacy strictAuth describes broker compatibility;
  // it is not a native-login capability flag.
  const usesNativeCredentials = authMode === "native-login" && supportsNativeAuthCapsule(adapter.id);
  const sandboxNetwork = options.sandboxNetwork === "native-auth-local"
    ? "denied"
    : options.sandboxNetwork ?? (usesNativeCredentials ? "provider-direct" : "denied");
  const network = sandboxNetwork === "provider-direct" ? "native-direct-unrestricted" : options.broker ? "broker-only" : "denied";
  const credentialAccess = usesNativeCredentials ? "backend-native" : options.broker ? "broker-lease" : "none";
  if (containment === "unsafe") return { cmd: command, cleanup: noop, sandboxed: false, reason: "explicit unsafe execution", network: "unrestricted", credentialAccess };
  if (!worker) return { cmd: command, cleanup: noop, sandboxed: false, reason: "isolated worker environment was not prepared", network: "denied", credentialAccess: "none" };
  const backendControls = adapter.projectControlPaths
    ? [...adapter.projectControlPaths(cwd), ...(primaryRootForWrite ? adapter.projectControlPaths(primaryRootForWrite) : [])]
    : [];
  const credentialRoots = sandboxCredentialRoots();
  const denyReadRoots = [...credentialRoots, ...backendControls];

  if (process.platform === "darwin") {
    const darwinProbe = supervisor?.darwinProbe?.ok
      ? supervisor.darwinProbe
      : probeDarwinSandboxWriteDenial();
    if (supervisor) supervisor.darwinProbe = darwinProbe;
    if (!darwinProbe.ok) return { cmd: command, cleanup: noop, sandboxed: false, reason: darwinProbe.reason, network: "denied", credentialAccess };
    const staged = stageDarwinBunScript(command, worker.env.PATH, worker, cwd);
    if (staged.kind === "rejected") {
      return { cmd: command, cleanup: staged.cleanup, sandboxed: false, reason: staged.reason, network: "denied", credentialAccess };
    }
    const stagedRuntimeRoots = staged.kind === "staged"
      ? [
          ...runtimeReadRoots,
          ...executableReadRoots(command, worker.env),
          ...executableReadRoots(staged.command, worker.env),
        ]
      : runtimeReadRoots;
    let profile: string;
    try {
      profile = primaryRootForWrite
        ? writeDarwinWriteSandboxProfile({
            worktree: cwd,
            primaryRoot: primaryRootForWrite,
            worker,
            runtimeReadRoots: stagedRuntimeRoots,
            denyWriteRoots: credentialRoots,
            denyReadRoots,
            brokerPort: brokerPort(options.broker),
            network: sandboxNetwork,
            runToolSocket: options.runTool?.socketPath,
          })
        : writeDarwinReadOnlySandboxProfile({
            workdir: cwd,
            worker,
            runtimeReadRoots: stagedRuntimeRoots,
            denyWriteRoots: credentialRoots,
            denyReadRoots,
            brokerPort: brokerPort(options.broker),
            network: sandboxNetwork,
            runToolSocket: options.runTool?.socketPath,
          });
    } catch (error) {
      staged.cleanup();
      throw error;
    }
    return {
      cmd: [DARWIN_SANDBOX_EXEC, "-f", profile, ...staged.command],
      cleanup: () => cleanupDarwinLaunch(profile, staged.cleanup),
      sandboxed: true,
      reason: primaryRootForWrite ? "darwin-seatbelt-write" : "darwin-seatbelt-read",
      network,
      credentialAccess,
    };
  }

  if (process.platform === "linux") {
    const linuxProbe = supervisor?.linuxProbe?.ok ? supervisor.linuxProbe : probeLinuxBwrap();
    if (supervisor) supervisor.linuxProbe = linuxProbe;
    if (!linuxProbe.ok) return { cmd: command, cleanup: noop, sandboxed: false, reason: linuxProbe.reason, network: "denied", credentialAccess };
    const relay = resolveLinuxRelayEntry();
    const bun = resolveExecutable("bun", worker.env.PATH);
    if (!relay || !bun) return { cmd: command, cleanup: noop, sandboxed: false, reason: "Linux containment supervisor runtime is unavailable", network: "denied", credentialAccess };
    const supervisorArguments = ["supervise"];
    let brokerSocket: string | undefined;
    let mechanism = primaryRootForWrite ? "linux-bwrap-write" : "linux-bwrap-read";
    const linuxRuntimeRoots = [...runtimeReadRoots, relay, bun];
    let providerPort: number | undefined;
    if (options.broker) {
      brokerSocket = options.broker.unixSocket;
      if (!brokerSocket || !existsSync(brokerSocket)) return { cmd: command, cleanup: noop, sandboxed: false, reason: "daemon broker Unix socket is unavailable", network: "denied", credentialAccess };
      providerPort = brokerPort(options.broker);
      supervisorArguments.push("--broker", brokerSocket, String(providerPort));
      mechanism += "-broker-relay";
    }
    if (options.runTool) {
      if (!existsSync(options.runTool.socketPath)) return { cmd: command, cleanup: noop, sandboxed: false, reason: "daemon run-tool Unix socket is unavailable", network: "denied", credentialAccess };
      supervisorArguments.push("--run-tool", options.runTool.socketPath, String(linuxRunToolRelayPort(providerPort)));
      mechanism += "-run-tools";
    }
    const sandboxCommand = [bun, relay, ...supervisorArguments, "--", ...command];
    if (primaryRootForWrite) {
      return {
        cmd: [BWRAP, ...buildLinuxWriteSandboxArgs({
          worktree: cwd,
          primaryRoot: primaryRootForWrite,
          worker,
          denyWriteRoots: credentialRoots,
          denyReadRoots,
          runtimeReadRoots: linuxRuntimeRoots,
          brokerSocket,
          runToolSocket: options.runTool?.socketPath,
          network: sandboxNetwork,
        }), "--", ...sandboxCommand],
        cleanup: noop,
        sandboxed: true,
        reason: mechanism,
        network,
        credentialAccess,
      };
    }
    return {
      cmd: [BWRAP, ...buildLinuxReadOnlyArgs({
        workdir: cwd,
        worker,
        denyWriteRoots: credentialRoots,
        denyReadRoots,
        runtimeReadRoots: linuxRuntimeRoots,
        brokerSocket,
        runToolSocket: options.runTool?.socketPath,
        network: sandboxNetwork,
      }), "--", ...sandboxCommand],
      cleanup: noop,
      sandboxed: true,
      reason: mechanism,
      network,
      credentialAccess,
    };
  }

  return { cmd: command, cleanup: noop, sandboxed: false, reason: `unsupported platform: ${process.platform}`, network: "denied", credentialAccess: "none" };
}

function cleanupDarwinLaunch(profile: string, stagedCleanup: () => void) {
  const errors: unknown[] = [];
  try {
    cleanupSandboxProfile(profile);
  } catch (error) {
    errors.push(error);
  }
  try {
    stagedCleanup();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) throw new AggregateError(errors, "Failed to clean up a contained macOS launch.");
}

export async function terminateProcessTree(process: Subprocess, graceMs = TERMINATION_GRACE_MS) {
  return await terminateChildProcessTree(process, { graceMs });
}

function adapterEnvironment(adapter: BackendDefinition, worker: WorkerEnvironment, options: InternalRunOptions) {
  const base = { ...worker.env, HEADLESS_DEPTH: process.env.HEADLESS_DEPTH ?? "0" };
  const env: NodeJS.ProcessEnv = adapter.buildEnv ? adapter.buildEnv(base, options) : base;
  adapter.prepareEnvironment?.(env, {
    worker,
    platform: process.platform,
    authMode: options.authMode ?? "broker",
  });
  if (options.broker) applyBrokerEnvironment(env, options.broker);
  return env;
}

function containedProbeExecutor(
  options: InternalRunOptions,
  adapter: BackendDefinition,
  cwd: string,
  worker: WorkerEnvironment,
  supervisor: ExecutionSupervisorState,
): ProbeExecutor {
  return async (argv, limits) => {
    const probeOptions: InternalRunOptions = {
      ...options,
      mode: "read-only",
      containment: "required",
      // Version/help probes never need provider egress or credentials, even
      // when the eventual native session does.
      authMode: "broker",
      broker: undefined,
      runTool: undefined,
      onStdoutChunk: undefined,
      signal: undefined,
    };
    const command = [...argv];
    const wrapped = wrapWithSandboxWithoutState(
      command,
      probeOptions,
      adapter,
      cwd,
      undefined,
      worker,
      executableReadRoots(command, worker.env),
      supervisor,
    );
    if (!wrapped.sandboxed) {
      wrapped.cleanup();
      return {
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        overflowed: false,
        error: `Required probe containment is unavailable: ${wrapped.reason}`,
      };
    }
    try {
      return await executeBoundedProbe(wrapped.cmd, limits, { cwd, env: worker.env, signal: options.signal });
    } finally {
      wrapped.cleanup();
    }
  };
}

function applyBrokerEnvironment(env: NodeJS.ProcessEnv, broker: NonNullable<InternalRunOptions["broker"]>) {
  // CLI backends speak HTTP BASE_URL only. On Linux strict containment the
  // supervisor rewrites connectivity: it binds 127.0.0.1:<port> INSIDE the
  // worker netns and relays to the host AF_UNIX broker socket (unixSocket).
  // Host-side TCP is not required and is gated off by default when a Unix
  // socket is configured (see ProviderBroker.allowLoopbackTcp).
  if (broker.provider === "anthropic") {
    env.ANTHROPIC_API_KEY = broker.token;
    env.ANTHROPIC_BASE_URL = broker.baseUrl;
  } else if (broker.provider === "gemini") {
    env.GEMINI_API_KEY = broker.token;
    env.GOOGLE_API_KEY = broker.token;
    env.GEMINI_BASE_URL = broker.baseUrl;
  } else if (broker.provider === "xai") {
    env.XAI_API_KEY = broker.token;
    env.XAI_BASE_URL = broker.baseUrl;
  } else {
    env.OPENAI_API_KEY = broker.token;
    env.OPENAI_BASE_URL = broker.baseUrl;
  }
  env.HEADLESS_BROKER_TOKEN = broker.token;
  if (broker.unixSocket) env.HEADLESS_BROKER_UNIX_SOCKET = broker.unixSocket;
}

function brokerPort(broker?: InternalRunOptions["broker"]) {
  if (!broker) return undefined;
  // Prefer baseUrl port (real TCP listener or synthetic Unix-only relay port).
  // When unixSocket is set, this port is the in-netns relay listen port on Linux
  // (host cannot reach it); on Darwin residual-trust it is the host loopback port.
  const url = new URL(broker.baseUrl);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "::1") {
    throw new Error("Strict broker endpoint must be loopback-only.");
  }
  const port = Number(url.port);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) throw new Error("Strict broker endpoint must include a valid port.");
  return port;
}

function linuxRunToolRelayPort(providerPort?: number) {
  return providerPort === BROKER_UNIX_ONLY_RELAY_PORT ? BROKER_UNIX_ONLY_RELAY_PORT + 1 : BROKER_UNIX_ONLY_RELAY_PORT;
}

/**
 * Refuse to hand a worker a provider endpoint that nothing will answer.
 *
 * A Unix-socket-only broker mints a lease whose `baseUrl` names the synthetic
 * relay port. That URL is only meaningful inside a Linux worker network
 * namespace, where the containment supervisor binds the port and forwards to
 * the broker's AF_UNIX socket. Everywhere else the port has no owner, yet the
 * worker would still receive the lease bearer token as its provider API key and
 * (on macOS) a Seatbelt profile that opens exactly that port — so any local
 * process able to squat it would collect the token.
 *
 * The question this answers is "will a relay exist for THIS run", not "what
 * platform is this": a Linux run with `containment: "unsafe"` gets no namespace
 * and therefore no relay either.
 */
export function assertBrokerEndpointIsServed(
  broker: BrokerWorkerAccess,
  context: { containment: "required" | "unsafe"; platform?: NodeJS.Platform },
): void {
  const platform = context.platform ?? process.platform;
  const port = brokerPort(broker)!;
  // The issuer states it. The reserved relay port is a fail-closed backstop for
  // any caller that forgets to, since nothing else may bind it (see
  // linuxRunToolRelayPort, which already treats it as reserved).
  const relayOnly = broker.hostLoopbackListener === false
    || (broker.hostLoopbackListener === undefined && port === BROKER_UNIX_ONLY_RELAY_PORT);
  if (!relayOnly) return;

  const detail = { port, platform, containment: context.containment };
  if (platform !== "linux") {
    throw new HeadlessError(
      "CONTAINMENT_UNAVAILABLE",
      `The provider broker has no host loopback listener, so its lease endpoint port ${port} has no owner on ${platform}. `
        + "Only a Linux contained worker can reach that port, through the in-namespace relay. "
        + "Refusing to hand a worker a lease bearer token addressed to an unowned local port; "
        + "re-enable the broker loopback listener (clear HEADLESS_BROKER_ALLOW_LOOPBACK_TCP=0) or run contained on Linux.",
      { details: detail },
    );
  }
  if (context.containment !== "required") {
    throw new HeadlessError(
      "CONTAINMENT_UNAVAILABLE",
      `The provider broker has no host loopback listener, so its lease endpoint port ${port} is served only by the Linux `
        + "in-namespace relay, and unsafe containment creates no namespace and no relay. "
        + "Refusing to hand an uncontained worker a lease bearer token addressed to an unowned local port; "
        + "use required containment or re-enable the broker loopback listener.",
      { details: detail },
    );
  }
  if (!broker.unixSocket || !existsSync(broker.unixSocket)) {
    throw new HeadlessError(
      "CONTAINMENT_UNAVAILABLE",
      `The provider broker has no host loopback listener and its Unix socket is unavailable, so nothing can serve lease `
        + `endpoint port ${port} inside the worker namespace.`,
      { details: detail },
    );
  }
}

export { executableReadRoots } from "../runtime/executable-read-roots";

export function resolveLinuxRelayEntry() {
  const candidates = [
    join(import.meta.dir, "broker", "linux-relay.js"),
    join(import.meta.dir, "..", "broker", "linux-relay.js"),
    join(import.meta.dir, "..", "broker", "linux-relay.ts"),
  ];
  for (const candidate of candidates) {
    const resolved = resolveExecutable(candidate, undefined);
    if (resolved) return resolved;
  }
  return null;
}

async function readStreamCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onOverflow: () => void,
  onChunk?: (text: string) => void,
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let bytes = 0;
  let truncated = false;
  try {
    while (true) {
      let value: Uint8Array | undefined;
      let done = false;
      try {
        ({ value, done } = await reader.read());
      } catch (error) {
        recordRuntimeDiagnostic("transport", "runner.stdout-reader", error);
        throw error;
      }
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        truncated = true;
        onOverflow();
        try {
          await reader.cancel();
        } catch (error) {
          recordRuntimeDiagnostic("cleanup", "runner.stream-cancel-after-overflow", error);
        }
        break;
      }
      const text = decoder.decode(value, { stream: true });
      if (text) onChunk?.(text);
      output += text;
    }
    const tail = decoder.decode();
    if (tail) onChunk?.(tail);
    output += tail;
  } finally {
    try {
      reader.releaseLock();
    } catch (error) {
      recordRuntimeDiagnostic("cleanup", "runner.stream-reader-release", error);
    }
  }
  return { text: output, truncated };
}

function safeStreamCallback(callback?: (chunk: string) => void) {
  if (!callback) return undefined;
  let failures = 0;
  const stream = new StreamingRedactor((chunk) => {
    try {
      callback(chunk);
    } catch (error) {
      failures += 1;
      if (failures <= 3) recordRuntimeDiagnostic("stream-callback", "runner.stdout-callback", error);
    }
  });
  return {
    push: (chunk: string) => stream.push(chunk),
    finish: () => stream.finish(),
    failureCount: () => failures,
  };
}

function redactSafely(value: string) {
  try {
    return redactAndTruncate(value, STREAM_CAP_BYTES);
  } catch {
    return { text: "[SUPPRESSED: REDACTION FAILURE]", redacted: true, truncated: true };
  }
}

function containmentRequirement(options: ExecOptions) {
  return options.containment ?? "required";
}

function timeout(value?: number) {
  return positiveTimeout(value, { defaultValue: DEFAULT_TIMEOUT });
}

function containmentEvidence(requirement: "required" | "unsafe", wrapped?: SandboxWrap, worker?: WorkerEnvironment): NonNullable<ExecResult["containment"]> {
  const platform = process.platform === "darwin" || process.platform === "linux" || process.platform === "win32" ? process.platform : "other";
  return {
    requirement,
    enforced: !!wrapped?.sandboxed,
    platform,
    mechanism: wrapped?.sandboxed ? wrapped.reason : null,
    probe: wrapped?.reason ?? null,
    isolatedHome: !!worker,
    credentialsIsolated: !!worker,
    network: wrapped?.network ?? (requirement === "unsafe" ? "unrestricted" : "denied"),
    credentialAccess: wrapped?.credentialAccess ?? "none",
    unsafe: requirement === "unsafe",
  };
}

function failedResult(
  backend: string,
  code: NonNullable<ExecResult["error"]>["code"],
  message: string,
  durationMs: number,
  containment: "required" | "unsafe",
  status: NonNullable<ExecResult["status"]> = code === "CANCELLED" ? "cancelled" : code === "TIMED_OUT" ? "timed_out" : code === "POLICY_DENIED" || code === "CONTAINMENT_UNAVAILABLE" ? "blocked" : "failed",
  wrapped?: SandboxWrap,
  worker?: WorkerEnvironment,
): ExecResult {
  const safe = redactSafely(message);
  return {
    ok: false,
    status,
    error: { code, message: safe.text, retryable: false },
    backend,
    output: safe.text,
    stderr: "",
    diagnostics: { format: "none", malformedEvents: 0, ignoredEvents: 0, messages: [] },
    cost: null,
    tokens: null,
    usage: { input: null, output: null, reasoning: null, cached: null, providerTotal: null },
    durationMs,
    exitCode: null,
    signal: null,
    timedOut: status === "timed_out",
    containment: containmentEvidence(containment, wrapped, worker),
    sandboxed: !!wrapped?.sandboxed,
    sandboxReason: wrapped?.reason,
    redacted: safe.redacted,
    truncated: safe.truncated,
  };
}

function markFailed(result: ExecResult, code: NonNullable<ExecResult["error"]>["code"], message: string) {
  const safe = redactSafely(message);
  return {
    ...result,
    ok: false,
    status: "failed" as const,
    error: { code, message: safe.text, retryable: false },
    output: result.output ? `${result.output}\n\n${safe.text}` : safe.text,
  };
}

function executionSummary(result: ExecResult): WriteExecutionSummary {
  const status = result.status ?? (result.timedOut ? "timed_out" : result.ok ? "succeeded" : "failed");
  return {
    succeeded: result.ok && status === "succeeded",
    status,
    failureCode: result.error?.code ?? null,
    usage: result.usage ?? {
      input: null,
      output: result.tokens,
      reasoning: null,
      cached: null,
      providerTotal: result.tokens,
    },
    costUsd: typeof result.cost === "number" ? result.cost : null,
  };
}

function applyWriteIntegration(result: ExecResult, integration: WriteIntegrationResult): ExecResult {
  if (!result.ok) return result;
  if (integration.outcome === "merged_fast_forward" || integration.outcome === "merged_advanced" || integration.outcome === "no_changes") {
    return result;
  }
  if (integration.outcome === "commit_failed") {
    return markFailed(result, "PROCESS_ERROR", integration.reason);
  }
  const code = integration.outcome === "preserved_no_merge_authority"
    ? "POLICY_DENIED"
    : integration.outcome === "blocked_candidate_gates" || integration.outcome === "blocked_integration_gates"
      ? "GATE_FAILED"
      : "CONFLICT";
  return {
    ...result,
    ok: false,
    status: "blocked",
    error: { code, message: integration.reason, retryable: false, details: { outcome: integration.outcome, evidence: integration.evidence } },
  };
}

function redactWriteDiff(diff: WriteDiff) {
  const patch = redactSafely(diff.diff);
  let status;
  try {
    status = redactAndTruncate(diff.status, 65_536);
  } catch {
    status = { text: "[SUPPRESSED: REDACTION FAILURE]", redacted: true, truncated: true };
  }
  return {
    patch: patch.text,
    status: status.text,
    files: diff.files.slice(0, 256).map((file) => {
      try {
        return redactAndTruncate(file, 2_000).text;
      } catch {
        return "[SUPPRESSED: REDACTION FAILURE]";
      }
    }),
  };
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function noop() {}
