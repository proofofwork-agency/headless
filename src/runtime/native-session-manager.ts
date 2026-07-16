import type { ExperimentalExecResult as ExecResult } from "../experimental/exec-result";
import type { DurableSession } from "../contracts/durable";
import type { ExecOptions } from "../index";
import { getBackendDefinition, requiredContainmentSecurityGaps, type BackendDefinition } from "../backends/registry";
import { executableReadRoots, maybeWrapWithSandbox } from "../runner/simple";
import { installNativeAuthCapsule, supportsNativeAuthCapsule } from "./native-auth-capsule";
import { installGrokIsolation, validateGrokIsolationInspection } from "./grok-isolation";
import { createWorkerEnvironment, type WorkerEnvironment } from "./worker-environment";
import type { PersistentSessionStore } from "./persistent-sessions";
import {
  BunSessionExecutor,
  SessionDriverFactory,
  type SessionDriver,
  type SessionExecutor,
  type SessionHandle,
  type SessionInspection,
  type SessionTransport,
  type SessionTurnResult,
} from "./session-drivers/index";
import { SessionDriverError } from "./session-drivers/errors";
import { cleanupWithDiagnostic, recordRuntimeDiagnostic } from "./diagnostics";
import { isHeadlessError } from "./headless-error";
import { redactAndTruncate } from "./redaction";

type NativeRuntime = {
  driver: SessionDriver;
  handle: SessionHandle;
  worker: WorkerEnvironment;
  env: NodeJS.ProcessEnv;
  model: string | null;
  authProfileFingerprint: string;
  restoringNative: boolean;
  replayAttempted: boolean;
  forcedReplayReason: string | null;
};

type InitializingRuntime = {
  worker: WorkerEnvironment;
  controller: AbortController;
  promise: Promise<NativeRuntime>;
};

/** Backends with both an audited auth capsule and a concrete session driver. */
export function isAuditedNativeSessionDriverBackend(backend: string) {
  return supportsNativeAuthCapsule(backend);
}

export function prepareNativeSessionEnvironment(
  adapter: BackendDefinition,
  worker: WorkerEnvironment,
  options: ExecOptions,
  platform: NodeJS.Platform = process.platform,
) {
  const env = adapter.buildEnv ? adapter.buildEnv(worker.env, options) : { ...worker.env };
  adapter.prepareEnvironment?.(env, { worker, platform, authMode: options.authMode ?? "broker" });
  return env;
}

export class NativeSessionManager {
  private readonly runtimes = new Map<string, NativeRuntime>();
  private readonly initializations = new Map<string, InitializingRuntime>();
  private readonly turnTails = new Map<string, Promise<void>>();
  private readonly closingSessions = new Set<string>();
  private readonly diagnostic: (message: string, error?: unknown) => void;

  constructor(
    private readonly projectRoot: string,
    private readonly sessions: PersistentSessionStore,
    private readonly options: {
      diagnostic?: (message: string, error?: unknown) => void;
      authHomeDir?: string;
      workerBaseDir?: string;
    } = {},
  ) {
    this.diagnostic = options.diagnostic ?? ((message, error) => recordRuntimeDiagnostic("state", message, error ?? message));
  }

  async turn(session: DurableSession, prompt: string, timeoutMs: number, signal?: AbortSignal): Promise<ExecResult> {
    const started = Date.now();
    let runtime: NativeRuntime | null = null;
    try {
      return await this.withTurnLock(session.id, signal, async () => {
        throwIfCancelled(signal, `Native session ${session.id} was cancelled before initialization.`);
        if (this.closingSessions.has(session.id)) throw cancelledError(`Native session ${session.id} is closing.`);
        runtime = await this.ensureRuntime(session, timeoutMs, prompt, signal);
        throwIfCancelled(signal, `Native session ${session.id} was cancelled before its turn started.`);
        if (this.closingSessions.has(session.id)) throw cancelledError(`Native session ${session.id} is closing.`);
        const cancel = () => {
          if (!runtime) return;
          void runtime.driver.cancel(runtime.handle)
            .catch((error) => this.diagnostic(`Native-session cancellation failed for ${session.id}.`, error));
        };
        signal?.addEventListener("abort", cancel, { once: true });
        try {
          throwIfCancelled(signal, `Native session ${session.id} was cancelled before its turn started.`);
          let result = await runtime.driver.send(runtime.handle, prompt, { timeoutMs });
          if (shouldReplayLostSession(runtime, result)) {
            result = await this.replayLostSession(session, runtime, prompt, timeoutMs);
          }
          const inspection = await runtime.driver.inspect(runtime.handle);
          this.persistInspection(session.id, inspection);
          return sessionExecResult(session, runtime.handle.driverKind, result, Date.now() - started, true);
        } finally {
          signal?.removeEventListener("abort", cancel);
        }
      });
    } catch (error) {
      const failedRuntime = this.runtimes.get(session.id);
      if (failedRuntime) {
        try {
          this.persistInspection(session.id, await failedRuntime.driver.inspect(failedRuntime.handle));
        } catch (inspectionError) {
          this.diagnostic(`Unable to persist native-session inspection for ${session.id}.`, inspectionError);
        }
      }
      return failedSessionExecResult(
        session,
        error,
        Date.now() - started,
        signal?.aborted ?? false,
        failedRuntime?.handle.driverKind ?? null,
      );
    }
  }

  async cancel(sessionId: string) {
    const initialization = this.initializations.get(sessionId);
    if (initialization) {
      initialization.controller.abort(`Native session ${sessionId} was cancelled during initialization.`);
      try {
        await initialization.promise;
      } catch (error) {
        if (!isSessionCancellation(error)) throw error;
      }
    }
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return null;
    const inspection = await runtime.driver.cancel(runtime.handle);
    this.persistInspection(sessionId, inspection);
    return inspection;
  }

  async inspect(sessionId: string) {
    const runtime = this.runtimes.get(sessionId);
    return runtime ? runtime.driver.inspect(runtime.handle) : null;
  }

  async close(sessionId: string) {
    this.closingSessions.add(sessionId);
    let initializationError: unknown = null;
    let cancellationError: unknown = null;
    try {
      const initialization = this.initializations.get(sessionId);
      initialization?.controller.abort(`Native session ${sessionId} was closed during initialization.`);
      try {
        await initialization?.promise;
      } catch (error) {
        if (!isSessionCancellation(error)) initializationError = error;
      }
      const active = this.runtimes.get(sessionId);
      if (active) {
        try {
          await active.driver.cancel(active.handle);
        } catch (error) {
          cancellationError = error;
        }
      }
      await this.turnTails.get(sessionId);
      await this.closeReadyRuntime(sessionId);
      if (initializationError) throw initializationError;
      if (cancellationError) throw cancellationError;
    } finally {
      this.closingSessions.delete(sessionId);
    }
  }

  async closeAll() {
    const sessionIds = new Set([
      ...this.runtimes.keys(),
      ...this.initializations.keys(),
      ...this.turnTails.keys(),
    ]);
    const closed = await Promise.allSettled([...sessionIds].map((id) => this.close(id)));
    const failures = closed.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    for (const error of failures) this.diagnostic("Native-session shutdown failed.", error);
    if (failures.length > 0) throw new AggregateError(failures, `${failures.length} native session${failures.length === 1 ? "" : "s"} failed to close.`);
  }

  private async withTurnLock<T>(sessionId: string, signal: AbortSignal | undefined, run: () => Promise<T>) {
    const previous = this.turnTails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.turnTails.set(sessionId, tail);
    try {
      await waitForPromise(previous, signal);
      throwIfCancelled(signal, `Native session ${sessionId} was cancelled while waiting for its turn.`);
      return await run();
    } finally {
      release();
      if (this.turnTails.get(sessionId) === tail) this.turnTails.delete(sessionId);
    }
  }

  private async closeReadyRuntime(sessionId: string) {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    this.runtimes.delete(sessionId);
    try {
      await runtime.driver.close(runtime.handle);
      this.persistInspection(sessionId, await runtime.driver.inspect(runtime.handle));
    } finally {
      await cleanupWithDiagnostic(`native-session.worker:${sessionId}`, runtime.worker.cleanup);
    }
  }

  private async ensureRuntime(
    session: DurableSession,
    timeoutMs: number,
    currentPrompt: string,
    signal?: AbortSignal,
  ) {
    const existing = this.runtimes.get(session.id);
    if (existing) return existing;
    const initializing = this.initializations.get(session.id);
    if (initializing) return waitForPromise(initializing.promise, signal);
    throwIfCancelled(signal, `Native session ${session.id} was cancelled before initialization.`);
    const worker = createWorkerEnvironment({ baseDir: this.options.workerBaseDir });
    const controller = new AbortController();
    const detach = forwardAbort(signal, controller);
    let initialization: InitializingRuntime;
    const promise = this.initializeRuntime(session, timeoutMs, currentPrompt, worker, controller.signal)
      .finally(() => {
        detach();
        if (this.initializations.get(session.id) === initialization) this.initializations.delete(session.id);
      });
    initialization = { worker, controller, promise };
    this.initializations.set(session.id, initialization);
    return promise;
  }

  private async initializeRuntime(
    session: DurableSession,
    timeoutMs: number,
    currentPrompt: string,
    worker: WorkerEnvironment,
    signal: AbortSignal,
  ) {
    let opened: { driver: SessionDriver; handle: SessionHandle } | null = null;
    try {
      const adapter = getBackendDefinition(session.backend);
      if (!adapter) throw new Error(`Backend ${session.backend} is unavailable for native sessions.`);
      if (session.containment === "required") {
        const gaps = requiredContainmentSecurityGaps(adapter, "read-only");
        if (gaps.length > 0) {
          throw new SessionDriverError(
            "BACKEND_UNSUPPORTED",
            `Backend ${session.backend} cannot start a required native session because it does not disable: ${gaps.join(", ")}.`,
          );
        }
      }
      throwIfCancelled(signal, `Native session ${session.id} was cancelled before authentication setup.`);
      let capsule;
      try {
        capsule = installNativeAuthCapsule(worker, session.backend, {
          homeDir: this.options.authHomeDir,
          requestedModel: session.model ?? undefined,
          resolveOpenCodeModel: session.backend === "opencode",
        });
      } catch (error) {
        if (isHeadlessError(error) && error.code === "INVALID_REQUEST") {
          throw new SessionDriverError("INVALID_REQUEST", error.safeMessage);
        }
        throw new SessionDriverError("NATIVE_AUTH_UNAVAILABLE", "Native authentication state could not be prepared safely.");
      }
      if (!capsule.available || !capsule.manifest) {
        throw new SessionDriverError("NATIVE_AUTH_UNAVAILABLE", capsule.reason ?? "Native authentication is unavailable.");
      }
      const selectedModel = capsule.model ?? session.model;
      if (session.backend === "grok-build") installGrokIsolation(worker, { homeDir: this.options.authHomeDir });
      const options = {
        backend: session.backend,
        prompt: "",
        cwd: this.projectRoot,
        mode: "read-only" as const,
        model: selectedModel ?? undefined,
        agent: session.agent ?? undefined,
        containment: session.containment,
        authMode: "native-login" as const,
        approvalPolicy: session.approvalPolicy,
      };
      const env = prepareNativeSessionEnvironment(adapter, worker, options);
      const processExecutor = new BunSessionExecutor({
        prepare: async (request) => {
          const sandboxOptions = request.purpose === "capability-probe"
            ? { ...options, containment: "required" as const, authMode: "broker" as const, sandboxNetwork: "denied" as const }
            : request.purpose === "auth-probe"
              ? { ...options, sandboxNetwork: "native-auth-local" as const }
              : options;
          const wrapped = maybeWrapWithSandbox(
            request.argv,
            sandboxOptions,
            adapter,
            request.cwd,
            undefined,
            worker,
            executableReadRoots(request.argv, request.env),
          );
          if ((request.purpose === "capability-probe" || session.containment === "required") && !wrapped.sandboxed) {
            await cleanupWithDiagnostic("native-session.unavailable-sandbox", wrapped.cleanup);
            throw new Error(`Required native-session containment is unavailable: ${wrapped.reason}`);
          }
          return { argv: wrapped.cmd, cleanup: wrapped.cleanup };
        },
      });
      const executor = executorWithInitializationSignal(processExecutor, signal);
      if (session.backend === "grok-build") {
        const attestation = await executor.execute({
          argv: ["grok", "inspect", "--json"],
          cwd: this.projectRoot,
          env,
          stdin: null,
          timeoutMs: Math.min(timeoutMs, 30_000),
          signal,
          protocol: "text",
          purpose: "capability-probe",
        });
        const failure = grokSessionAttestationFailure(attestation);
        if (failure) throw new SessionDriverError("BACKEND_UNSUPPORTED", `Grok isolation attestation failed before provider access: ${failure}`);
      }
      const factory = new SessionDriverFactory({ executor });
      const selected = await factory.select(session.backend, {
        cwd: this.projectRoot,
        env,
        timeoutMs: Math.min(timeoutMs, 30_000),
        signal,
      });
      throwIfCancelled(signal, `Native session ${session.id} was cancelled during driver selection.`);
      const transcript = this.sessions.transcript(session.id).map((entry) => ({ role: entry.role, content: entry.content }));
      const nativeSessionId = session.native?.nativeSessionId ?? session.nativeSessionId;
      const forcedReplayReason = nativeSessionId
        ? nativeResumeMismatchReason(session, selected.driver.kind, capsule.manifest.fingerprint)
        : null;
      let restoringNative = !!nativeSessionId && forcedReplayReason === null;
      let replayAttempted = forcedReplayReason !== null;
      let handle: SessionHandle;
      if (nativeSessionId && forcedReplayReason === null) {
        try {
          handle = await selected.driver.resume({
            cwd: this.projectRoot,
            mode: "read-only",
            containment: session.containment,
            model: selectedModel ?? undefined,
            agent: session.agent ?? undefined,
            env,
            approvalPolicy: session.approvalPolicy,
            authProfileFingerprint: capsule.manifest.fingerprint,
            sessionId: session.id,
            nativeSessionId,
            nativeResumeAvailable: session.native?.recovery.state !== "lost",
            transcript,
            timeoutMs,
          });
        } catch (error) {
          if (!isNativeSessionLost(error)) throw error;
          restoringNative = false;
          replayAttempted = true;
          handle = await selected.driver.resume({
            cwd: this.projectRoot,
            mode: "read-only",
            containment: session.containment,
            model: selectedModel ?? undefined,
            agent: session.agent ?? undefined,
            env,
            approvalPolicy: session.approvalPolicy,
            authProfileFingerprint: capsule.manifest.fingerprint,
            sessionId: session.id,
            nativeSessionId: null,
            nativeResumeAvailable: false,
            transcript: replayTranscript(this.sessions, session.id, currentPrompt),
            timeoutMs,
          });
        }
      } else if (nativeSessionId) {
        try {
          handle = await selected.driver.resume({
            cwd: this.projectRoot,
            mode: "read-only",
            containment: session.containment,
            model: selectedModel ?? undefined,
            agent: session.agent ?? undefined,
            env,
            approvalPolicy: session.approvalPolicy,
            authProfileFingerprint: capsule.manifest.fingerprint,
            sessionId: session.id,
            nativeSessionId: null,
            nativeResumeAvailable: false,
            transcript: replayTranscript(this.sessions, session.id, currentPrompt),
            timeoutMs,
          });
        } catch (error) {
          this.persistLostRecovery(session, selected.driver, capsule.manifest.fingerprint, forcedReplayReason!);
          throw error;
        }
      } else {
        handle = await selected.driver.create({
            cwd: this.projectRoot,
            mode: "read-only",
            containment: session.containment,
            model: selectedModel ?? undefined,
            agent: session.agent ?? undefined,
            env,
            approvalPolicy: session.approvalPolicy,
            authProfileFingerprint: capsule.manifest.fingerprint,
            sessionId: session.id,
          timeoutMs,
        });
      }
      opened = { driver: selected.driver, handle };
      throwIfCancelled(signal, `Native session ${session.id} was cancelled during initialization.`);
      const runtime = {
        driver: selected.driver,
        handle,
        worker,
        env,
        model: selectedModel,
        authProfileFingerprint: capsule.manifest.fingerprint,
        restoringNative,
        replayAttempted,
        forcedReplayReason,
      };
      const inspection = await selected.driver.inspect(handle);
      throwIfCancelled(signal, `Native session ${session.id} was cancelled during initialization.`);
      this.runtimes.set(session.id, runtime);
      this.persistInspection(session.id, inspection);
      return runtime;
    } catch (error) {
      if (opened) {
        await cleanupWithDiagnostic(`native-session.driver-rollback:${session.id}`, () => opened!.driver.close(opened!.handle));
      }
      this.runtimes.delete(session.id);
      await cleanupWithDiagnostic(`native-session.worker-rollback:${session.id}`, worker.cleanup);
      throw error;
    }
  }

  private persistLostRecovery(
    session: DurableSession,
    driver: SessionDriver,
    authProfileFingerprint: string,
    reason: string,
  ) {
    const now = Date.now();
    this.sessions.setNativeMetadata(session.id, {
      driverKind: driver.kind,
      nativeSessionId: null,
      backendVersion: session.native?.backendVersion ?? null,
      authProfileFingerprint,
      capabilities: {
        nativeResume: driver.capabilities.nativeResume,
        persistentTransport: driver.capabilities.persistentTransport,
        structuredEvents: driver.capabilities.structuredEvents,
        cancellation: driver.capabilities.cancellation,
        providerDirect: true,
        discoveredAt: now,
      },
      lastTurnId: session.native?.lastTurnId ?? null,
      rateLimit: session.native?.rateLimit ?? {
        limited: false,
        retryAfterMs: null,
        detectedAt: null,
        attempt: 0,
      },
      recovery: {
        state: "lost",
        reason,
        updatedAt: now,
      },
    });
  }

  private persistInspection(sessionId: string, inspection: SessionInspection) {
    const forcedReplayReason = this.runtimes.get(sessionId)?.forcedReplayReason ?? null;
    this.sessions.setNativeMetadata(sessionId, {
      driverKind: inspection.handle.driverKind,
      nativeSessionId: inspection.nativeSessionId,
      backendVersion: inspection.backendVersion,
      authProfileFingerprint: inspection.authProfileFingerprint,
      capabilities: {
        nativeResume: inspection.capabilities.nativeResume,
        persistentTransport: inspection.capabilities.persistentTransport,
        structuredEvents: inspection.capabilities.structuredEvents,
        cancellation: inspection.capabilities.cancellation,
        providerDirect: true,
        discoveredAt: inspection.updatedAt,
      },
      lastTurnId: inspection.lastTurn?.id ?? null,
      rateLimit: {
        limited: inspection.rateLimit.limited,
        retryAfterMs: inspection.rateLimit.retryAfterMs,
        detectedAt: inspection.rateLimit.observedAt,
        attempt: inspection.rateLimit.limited ? 1 : 0,
      },
      recovery: {
        state: recoveryState(inspection),
        reason: forcedReplayReason ?? inspection.recovery.reason,
        updatedAt: inspection.updatedAt,
      },
    });
  }

  private async replayLostSession(
    session: DurableSession,
    runtime: NativeRuntime,
    prompt: string,
    timeoutMs: number,
  ) {
    runtime.replayAttempted = true;
    runtime.forcedReplayReason = "The backend reported that the persisted native session was lost; Headless used one bounded redacted replay.";
    await runtime.driver.close(runtime.handle);
    runtime.handle = await runtime.driver.resume({
      cwd: this.projectRoot,
      mode: "read-only",
      containment: session.containment,
      model: runtime.model ?? undefined,
      agent: session.agent ?? undefined,
      env: runtime.env,
      approvalPolicy: session.approvalPolicy,
      authProfileFingerprint: runtime.authProfileFingerprint,
      sessionId: session.id,
      nativeSessionId: null,
      nativeResumeAvailable: false,
      transcript: replayTranscript(this.sessions, session.id, prompt),
      timeoutMs,
    });
    runtime.restoringNative = false;
    this.persistInspection(session.id, await runtime.driver.inspect(runtime.handle));
    return runtime.driver.send(runtime.handle, prompt, { timeoutMs });
  }
}

function grokSessionAttestationFailure(result: Awaited<ReturnType<SessionExecutor["execute"]>>) {
  if (result.timedOut) return "inspect timed out";
  if (result.overflowed) return "inspect output exceeded its bound";
  if (result.exitCode !== 0) return result.stderr || `inspect exited ${result.exitCode}`;
  try {
    return validateGrokIsolationInspection(JSON.parse(result.stdout ?? ""));
  } catch {
    return "inspect returned malformed JSON";
  }
}

function sessionExecResult(
  session: DurableSession,
  driverKind: SessionHandle["driverKind"] | "prelaunch",
  result: SessionTurnResult,
  durationMs: number,
  runtimeReady: boolean,
): ExecResult {
  const approvalRequired = result.error && /(?:approval|required permission|permission request)/i.test(result.error.message);
  const code = approvalRequired ? "APPROVAL_REQUIRED" : runErrorCode(result.error?.code);
  const blockedPrelaunch = !runtimeReady && (code === "NATIVE_AUTH_UNAVAILABLE" || code === "BACKEND_UNSUPPORTED");
  const status = result.status === "completed"
    ? "succeeded"
    : result.status === "cancelled"
      ? "cancelled"
      : code === "TIMED_OUT"
        ? "timed_out"
        : approvalRequired
          ? "blocked"
          : blockedPrelaunch
            ? "blocked"
            : "failed";
  const rateLimitDetails = code === "RATE_LIMITED"
    ? {
        retryAfterMs: result.rateLimit.retryAfterMs,
        evidence: result.rateLimit.reason ?? result.error?.message ?? "Backend rate limit reported.",
      }
    : undefined;
  return {
    ok: status === "succeeded",
    status,
    error: status === "succeeded" ? null : {
      code,
      message: result.error?.message ?? "Native session turn did not complete.",
      retryable: code === "RATE_LIMITED",
      ...(rateLimitDetails ? { details: rateLimitDetails } : {}),
    },
    backend: session.backend,
    output: result.output,
    stderr: "",
    diagnostics: {
      format: runtimeReady ? `native-session:${driverKind}` : "native-session:prelaunch",
      malformedEvents: result.malformedEvents,
      ignoredEvents: 0,
      messages: result.inferredCompletion ? ["Completion was inferred from stable backend lifecycle evidence."] : [],
    },
    cost: result.costUsd,
    tokens: result.usage.total,
    usage: {
      input: result.usage.input,
      output: result.usage.output,
      reasoning: result.usage.reasoning,
      cached: result.usage.cached,
      providerTotal: result.usage.total,
    },
    durationMs,
    exitCode: status === "succeeded" ? 0 : null,
    signal: status === "cancelled" ? "SIGTERM" : null,
    timedOut: status === "timed_out",
    sandboxed: runtimeReady && session.containment === "required",
    ...(runtimeReady ? { sandboxReason: `native-session:${driverKind}` } : {}),
    containment: {
      requirement: session.containment,
      enforced: runtimeReady && session.containment === "required",
      platform: platform(),
      mechanism: runtimeReady ? `native-session:${driverKind}` : null,
      probe: runtimeReady ? "session-driver-factory" : null,
      isolatedHome: true,
      credentialsIsolated: true,
      network: runtimeReady
        ? session.containment === "unsafe" ? "unrestricted" : "native-direct-unrestricted"
        : "denied",
      credentialAccess: runtimeReady ? "backend-native" : "none",
      unsafe: runtimeReady && session.containment === "unsafe",
    },
    redacted: true,
    truncated: result.truncated,
  };
}

function failedSessionExecResult(
  session: DurableSession,
  error: unknown,
  durationMs: number,
  cancelled: boolean,
  readyDriverKind: SessionHandle["driverKind"] | null,
): ExecResult {
  const rawMessage = nativeSessionErrorMessage(error);
  const safeMessage = redactNativeSessionFailure(rawMessage);
  const message = safeMessage.text;
  const wasCancelled = cancelled || (error instanceof SessionDriverError && error.code === "CANCELLED");
  const nativeAuth = /auth|login|credential/i.test(rawMessage);
  const code = wasCancelled
    ? "CANCELLED"
    : error instanceof SessionDriverError
      ? runErrorCode(error.code)
      : nativeAuth ? "NATIVE_AUTH_UNAVAILABLE" : "PROCESS_ERROR";
  return {
    ...sessionExecResult(session, readyDriverKind ?? "prelaunch", {
      id: "failed",
      status: wasCancelled ? "cancelled" : "failed",
      output: message,
      events: [],
      usage: { input: null, output: null, reasoning: null, cached: null, total: null },
      costUsd: null,
      nativeSessionId: null,
      nativeTurnId: null,
      startedAt: Date.now() - durationMs,
      completedAt: Date.now(),
      malformedEvents: 0,
      inferredCompletion: false,
      truncated: safeMessage.truncated,
      rateLimit: { limited: false, retryAfterMs: null, observedAt: null, reason: null },
      error: { code: wasCancelled ? "CANCELLED" : error instanceof SessionDriverError ? error.code : nativeAuth ? "NATIVE_AUTH_UNAVAILABLE" : "PROCESS_ERROR", message, retryable: error instanceof SessionDriverError && error.retryable },
    }, durationMs, readyDriverKind !== null),
    error: { code, message, retryable: error instanceof SessionDriverError && error.retryable },
  };
}

function nativeSessionErrorMessage(error: unknown) {
  try {
    const message = error instanceof Error ? error.message : String(error);
    return typeof message === "string" && message ? message : "Native session failed without a safe error message.";
  } catch {
    return "Native session failed; error details were suppressed.";
  }
}

function redactNativeSessionFailure(message: string) {
  try {
    return redactAndTruncate(message, 16_384);
  } catch {
    return {
      text: "Native session failed; error details were suppressed because redaction could not be completed.",
      redacted: true,
      truncated: true,
    };
  }
}

function runErrorCode(code: import("./session-drivers/errors").SessionDriverErrorCode | undefined): NonNullable<ExecResult["error"]>["code"] {
  if (code === "NATIVE_AUTH_UNAVAILABLE" || code === "NATIVE_SESSION_LOST" || code === "RATE_LIMITED" || code === "CANCELLED") return code;
  if (code === "BACKEND_UNAVAILABLE") return "BACKEND_UNAVAILABLE";
  if (code === "BACKEND_UNSUPPORTED") return "BACKEND_UNSUPPORTED";
  if (code === "INVALID_REQUEST") return "INVALID_REQUEST";
  if (code === "TIMED_OUT") return "TIMED_OUT";
  if (code === "OUTPUT_OVERFLOW") return "OUTPUT_OVERFLOW";
  return "PROCESS_ERROR";
}

function recoveryState(inspection: SessionInspection) {
  if (inspection.status === "closed") return "closed" as const;
  if (inspection.recovery.status === "native-lost") return "lost" as const;
  if (inspection.recovery.status === "replay-pending") return "replaying" as const;
  return "ready" as const;
}

function shouldReplayLostSession(runtime: NativeRuntime, result: SessionTurnResult) {
  if (!runtime.restoringNative || runtime.replayAttempted || result.status !== "failed" || result.output) return false;
  const message = result.error?.message ?? "";
  return result.error?.code === "NATIVE_SESSION_LOST"
    || /(?:session|conversation|thread).*(?:not found|unknown|missing|lost|invalid|cannot resume|could not resume)/i.test(message)
    || /(?:not found|unknown|missing|lost|invalid).*(?:session|conversation|thread)/i.test(message);
}

function isNativeSessionLost(error: unknown) {
  return error instanceof SessionDriverError && error.code === "NATIVE_SESSION_LOST";
}

function nativeResumeMismatchReason(
  session: DurableSession,
  selectedDriverKind: SessionHandle["driverKind"],
  authProfileFingerprint: string,
) {
  const reasons: string[] = [];
  if (session.native?.driverKind !== selectedDriverKind) {
    reasons.push("the selected session driver differs from the persisted driver");
  }
  if (session.native?.authProfileFingerprint !== authProfileFingerprint) {
    reasons.push("the native authentication profile fingerprint changed");
  }
  if (reasons.length === 0) return null;
  return `Native resume was refused because ${reasons.join(" and ")}; Headless used an explicit bounded redacted replay instead.`;
}

function cancelledError(message: string) {
  return new SessionDriverError("CANCELLED", message);
}

function isSessionCancellation(error: unknown) {
  return error instanceof SessionDriverError && error.code === "CANCELLED";
}

function throwIfCancelled(signal: AbortSignal | undefined, message: string) {
  if (signal?.aborted) throw cancelledError(message);
}

function forwardAbort(signal: AbortSignal | undefined, controller: AbortController) {
  if (!signal) return () => undefined;
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function executorWithInitializationSignal(executor: SessionExecutor, signal: AbortSignal) {
  const linked: SessionExecutor = {
    execute: (request) => executor.execute({ ...request, signal: AbortSignal.any([request.signal, signal]) }),
  };
  if (executor.probeAuth) {
    linked.probeAuth = (request) => executor.probeAuth!({ ...request, signal: AbortSignal.any([request.signal, signal]) });
  }
  if (executor.open) {
    linked.open = async (request) => {
      const transport = await executor.open!({ ...request, signal: AbortSignal.any([request.signal, signal]) });
      return transportWithInitializationSignal(transport, signal);
    };
  }
  return linked;
}

function transportWithInitializationSignal(transport: SessionTransport, signal: AbortSignal) {
  const linked: SessionTransport = {
    id: transport.id,
    request: (request) => transport.request({ ...request, signal: AbortSignal.any([request.signal, signal]) }),
    close: () => transport.close(),
  };
  if (transport.inspect) linked.inspect = () => transport.inspect!();
  return linked;
}

async function waitForPromise<T>(promise: Promise<T>, signal?: AbortSignal) {
  if (!signal) return promise;
  throwIfCancelled(signal, "Native session operation was cancelled.");
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(cancelledError("Native session operation was cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function replayTranscript(store: PersistentSessionStore, sessionId: string, currentPrompt: string) {
  const transcript = store.transcript(sessionId).map((entry) => ({ role: entry.role, content: entry.content }));
  const latest = transcript.at(-1);
  if (latest?.role === "user" && latest.content === currentPrompt) transcript.pop();
  return transcript;
}

function platform(): NonNullable<ExecResult["containment"]>["platform"] {
  if (process.platform === "darwin" || process.platform === "linux" || process.platform === "win32") return process.platform;
  return "other";
}
