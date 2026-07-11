import { randomUUID } from "node:crypto";
import type { AssembledSessionEvents } from "./event-assembler";
import { SessionDriverError, sessionDriverError } from "./errors";
import { replayPrompt, decideReplayFallback } from "./replay";
import { safeSessionOption, sessionTimeout } from "./options";
import { safeAgentName } from "../validation";
import type {
  CreateSessionInput,
  ResumeSessionInput,
  SendOptions,
  SessionDriver,
  SessionDriverCapabilities,
  SessionDriverKind,
  SessionHandle,
  SessionInspection,
  SessionProbeInput,
  SessionDriverProbe,
  SessionRateLimit,
  SessionRecovery,
  SessionTurnResult,
  StartTurnInput,
  SessionBackend,
} from "./types";

export type SessionDriverRuntime = {
  handle: SessionHandle;
  cwd: string;
  mode: "read-only" | "write";
  model: string | null;
  agent: string | null;
  env: NodeJS.ProcessEnv;
  approvalPolicy: "ask" | "auto" | "bypass";
  nativeSessionId: string | null;
  backendVersion: string | null;
  authProfileFingerprint: string | null;
  status: SessionInspection["status"];
  activeTurnId: string | null;
  activeNativeTurnId: string | null;
  activeNativeTurnReady: Promise<string | null> | null;
  activeController: AbortController | null;
  lastTurn: SessionTurnResult | null;
  rateLimit: SessionRateLimit;
  recovery: SessionRecovery;
  pendingReplay: string;
  turns: number;
  resource: unknown;
  createdAt: number;
  updatedAt: number;
};

export type OpenSessionResult = {
  nativeSessionId?: string | null;
  backendVersion?: string | null;
  resource?: unknown;
};

export type BaseSessionDriverOptions = {
  createId?: () => string;
  now?: () => number;
};

export abstract class BaseSessionDriver implements SessionDriver {
  abstract readonly backend: SessionBackend;
  abstract readonly kind: SessionDriverKind;
  abstract readonly capabilities: SessionDriverCapabilities;
  private readonly sessions = new Map<string, SessionDriverRuntime>();
  protected readonly createId: () => string;
  protected readonly now: () => number;

  constructor(options: BaseSessionDriverOptions = {}) {
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? Date.now;
  }

  abstract probe(input?: SessionProbeInput): Promise<SessionDriverProbe>;

  async create(input: CreateSessionInput) {
    const runtime = this.newRuntime(input, freshRecovery());
    const opened = await this.openFresh(runtime, sessionTimeout(input.timeoutMs));
    applyOpened(runtime, opened);
    this.sessions.set(runtime.handle.id, runtime);
    return runtime.handle;
  }

  async resume(input: ResumeSessionInput) {
    const decision = decideReplayFallback({
      nativeResumeSupported: this.capabilities.nativeResume,
      nativeResumeAvailable: input.nativeResumeAvailable,
      nativeSessionId: input.nativeSessionId,
      transcript: input.transcript,
    });
    if (decision.strategy === "unavailable") {
      throw new SessionDriverError("NATIVE_SESSION_LOST", decision.reason, false);
    }

    const recovery: SessionRecovery = decision.strategy === "native-resume"
      ? { status: "native-resumed", reason: decision.reason, replayBytes: 0, replayTruncated: false }
      : {
          status: "replay-pending",
          reason: decision.reason,
          replayBytes: decision.bytes,
          replayTruncated: decision.truncated,
        };
    const runtime = this.newRuntime(input, recovery);
    runtime.pendingReplay = decision.text;
    try {
      const opened = decision.strategy === "native-resume"
        ? await this.openNative(runtime, input.nativeSessionId!, sessionTimeout(input.timeoutMs))
        : await this.openFresh(runtime, sessionTimeout(input.timeoutMs));
      applyOpened(runtime, opened);
    } catch (error) {
      runtime.recovery = { ...runtime.recovery, status: "native-lost", reason: errorMessage(error) };
      throw sessionDriverError(error, "NATIVE_SESSION_LOST");
    }
    this.sessions.set(runtime.handle.id, runtime);
    return runtime.handle;
  }

  async startTurn(session: SessionHandle | string, input: StartTurnInput) {
    const runtime = this.require(session);
    if (runtime.status === "closed") throw new SessionDriverError("SESSION_CLOSED", `Session ${runtime.handle.id} is closed.`);
    if (runtime.activeController) throw new SessionDriverError("SESSION_BUSY", `Session ${runtime.handle.id} already has an active turn.`, true);
    const prompt = checkedPrompt(input.prompt);
    const turnId = this.createId();
    const startedAt = this.now();
    const controller = new AbortController();
    runtime.activeController = controller;
    runtime.activeTurnId = turnId;
    runtime.status = "running";
    runtime.updatedAt = startedAt;

    let result: SessionTurnResult;
    try {
      const assembled = await this.performTurn(
        runtime,
        replayPrompt(runtime.pendingReplay, prompt),
        sessionTimeout(input.timeoutMs),
        controller,
      );
      result = turnResult(turnId, assembled, startedAt, this.now());
    } catch (error) {
      result = failedTurn(turnId, startedAt, this.now(), error, controller.signal.aborted);
    } finally {
      runtime.activeController = null;
      runtime.activeTurnId = null;
      runtime.activeNativeTurnId = null;
      runtime.activeNativeTurnReady = null;
    }

    runtime.turns += 1;
    runtime.lastTurn = result;
    runtime.nativeSessionId = result.nativeSessionId ?? runtime.nativeSessionId;
    runtime.rateLimit = result.rateLimit;
    runtime.status = result.status === "rate-limited" ? "rate-limited" : result.status === "failed" ? "failed" : "idle";
    if (runtime.pendingReplay && result.status === "completed") {
      runtime.pendingReplay = "";
      runtime.recovery = { ...runtime.recovery, status: "replayed" };
    }
    runtime.updatedAt = this.now();
    return structuredClone(result);
  }

  send(session: SessionHandle | string, message: string, options: SendOptions = {}) {
    return this.startTurn(session, { prompt: message, ...options });
  }

  async cancel(session: SessionHandle | string) {
    const runtime = this.require(session);
    if (!runtime.activeController) return this.snapshot(runtime);
    try {
      await this.cancelRuntime(runtime);
    } finally {
      runtime.activeController?.abort("session turn cancelled");
    }
    if (runtime.status !== "closed") runtime.status = "idle";
    runtime.updatedAt = this.now();
    return this.snapshot(runtime);
  }

  async inspect(session: SessionHandle | string) {
    return this.snapshot(this.require(session));
  }

  async close(session: SessionHandle | string) {
    const runtime = this.require(session);
    if (runtime.status === "closed") return;
    runtime.activeController?.abort("session closed");
    await this.closeRuntime(runtime);
    runtime.resource = null;
    runtime.status = "closed";
    runtime.activeController = null;
    runtime.activeTurnId = null;
    runtime.updatedAt = this.now();
  }

  protected abstract openFresh(runtime: SessionDriverRuntime, timeoutMs: number): Promise<OpenSessionResult>;
  protected abstract openNative(runtime: SessionDriverRuntime, nativeSessionId: string, timeoutMs: number): Promise<OpenSessionResult>;
  protected abstract performTurn(
    runtime: SessionDriverRuntime,
    prompt: string,
    timeoutMs: number,
    controller: AbortController,
  ): Promise<AssembledSessionEvents>;

  protected async cancelRuntime(_runtime: SessionDriverRuntime) {}
  protected async closeRuntime(_runtime: SessionDriverRuntime) {}

  private newRuntime(input: CreateSessionInput, recovery: SessionRecovery): SessionDriverRuntime {
    const now = this.now();
    const id = input.sessionId ? safeSessionOption(input.sessionId, "id")! : this.createId();
    if (input.agent && this.backend !== "opencode" && this.backend !== "grok-build") {
      throw new SessionDriverError("INVALID_REQUEST", `${this.backend} does not support named agents in contained Headless sessions.`);
    }
    return {
      handle: { id, backend: this.backend, driverKind: this.kind },
      cwd: input.cwd,
      mode: input.mode ?? "read-only",
      model: safeSessionOption(input.model, "model") ?? null,
      agent: input.agent ? safeAgentName(input.agent, this.backend) : null,
      env: { ...(input.env ?? {}) },
      approvalPolicy: input.approvalPolicy ?? "ask",
      nativeSessionId: null,
      backendVersion: null,
      authProfileFingerprint: input.authProfileFingerprint ?? null,
      status: "idle",
      activeTurnId: null,
      activeNativeTurnId: null,
      activeNativeTurnReady: null,
      activeController: null,
      lastTurn: null,
      rateLimit: emptyRateLimit(),
      recovery,
      pendingReplay: "",
      turns: 0,
      resource: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  private require(session: SessionHandle | string) {
    const id = typeof session === "string" ? session : session.id;
    const runtime = this.sessions.get(id);
    if (!runtime) throw new SessionDriverError("INVALID_REQUEST", `Unknown ${this.kind} session: ${id}`);
    if (typeof session !== "string" && (session.backend !== this.backend || session.driverKind !== this.kind)) {
      throw new SessionDriverError("INVALID_REQUEST", `Session ${id} belongs to ${session.driverKind}, not ${this.kind}.`);
    }
    return runtime;
  }

  private snapshot(runtime: SessionDriverRuntime): SessionInspection {
    return structuredClone({
      handle: runtime.handle,
      status: runtime.status,
      cwd: runtime.cwd,
      mode: runtime.mode,
      model: runtime.model,
      agent: runtime.agent,
      approvalPolicy: runtime.approvalPolicy,
      nativeSessionId: runtime.nativeSessionId,
      backendVersion: runtime.backendVersion,
      authProfileFingerprint: runtime.authProfileFingerprint,
      capabilities: this.capabilities,
      activeTurnId: runtime.activeTurnId,
      lastTurn: runtime.lastTurn,
      rateLimit: runtime.rateLimit,
      recovery: runtime.recovery,
      createdAt: runtime.createdAt,
      updatedAt: runtime.updatedAt,
    });
  }
}

function applyOpened(runtime: SessionDriverRuntime, opened: OpenSessionResult) {
  runtime.nativeSessionId = opened.nativeSessionId ?? runtime.nativeSessionId;
  runtime.backendVersion = opened.backendVersion ?? runtime.backendVersion;
  runtime.resource = opened.resource ?? runtime.resource;
}

function turnResult(id: string, value: AssembledSessionEvents, startedAt: number, completedAt: number): SessionTurnResult {
  const errorCode = value.errorCode ?? (value.status === "rate-limited"
    ? "RATE_LIMITED"
    : value.status === "cancelled"
      ? "CANCELLED"
      : value.status === "failed" || value.status === "incomplete"
        ? "PROCESS_ERROR"
        : null);
  return {
    id,
    status: value.status,
    output: value.output,
    events: value.events,
    usage: value.usage,
    costUsd: value.costUsd,
    nativeSessionId: value.nativeSessionId,
    nativeTurnId: value.nativeTurnId,
    startedAt,
    completedAt,
    malformedEvents: value.malformedEvents,
    inferredCompletion: value.inferredCompletion,
    truncated: value.truncated,
    rateLimit: value.rateLimit,
    error: errorCode ? {
      code: errorCode,
      message: value.error ?? "Session turn did not complete.",
      retryable: errorCode === "RATE_LIMITED",
    } : null,
  };
}

function failedTurn(id: string, startedAt: number, completedAt: number, error: unknown, cancelled: boolean): SessionTurnResult {
  const failure = sessionDriverError(error, cancelled ? "CANCELLED" : "PROCESS_ERROR");
  return {
    id,
    status: cancelled ? "cancelled" : failure.code === "RATE_LIMITED" ? "rate-limited" : "failed",
    output: "",
    events: [],
    usage: { input: null, output: null, reasoning: null, cached: null, total: null },
    costUsd: null,
    nativeSessionId: null,
    nativeTurnId: null,
    startedAt,
    completedAt,
    malformedEvents: 0,
    inferredCompletion: false,
    truncated: failure.code === "OUTPUT_OVERFLOW",
    rateLimit: {
      limited: failure.code === "RATE_LIMITED",
      retryAfterMs: null,
      observedAt: failure.code === "RATE_LIMITED" ? completedAt : null,
      reason: failure.code === "RATE_LIMITED" ? failure.message : null,
    },
    error: { code: failure.code, message: failure.message, retryable: failure.retryable },
  };
}

function freshRecovery(): SessionRecovery {
  return { status: "fresh", reason: null, replayBytes: 0, replayTruncated: false };
}

function emptyRateLimit(): SessionRateLimit {
  return { limited: false, retryAfterMs: null, observedAt: null, reason: null };
}

function checkedPrompt(value: string) {
  if (typeof value !== "string" || !value.trim()) throw new SessionDriverError("INVALID_REQUEST", "Session turn prompt is required.");
  if (Buffer.byteLength(value) > 500_000) throw new SessionDriverError("INVALID_REQUEST", "Session turn prompt exceeds 500000 UTF-8 bytes.");
  return value;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
