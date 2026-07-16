export type SessionBackend = "codex" | "claude-code" | "opencode" | "grok-build";

export type SessionDriverKind =
  | "codex-app-server"
  | "codex-exec-resume"
  | "claude-print-resume"
  | "opencode-session"
  | "grok-resume";

export type SessionApprovalPolicy = "ask" | "auto" | "bypass";

export type SessionDriverCapabilities = {
  nativeResume: boolean;
  persistentTransport: boolean;
  replayFallback: boolean;
  structuredEvents: boolean;
  cancellation: boolean;
};

export type SessionDriverProbe = {
  ok: boolean;
  backend: SessionBackend;
  kind: SessionDriverKind;
  version: string | null;
  capabilities: SessionDriverCapabilities;
  auth: {
    available: boolean | null;
    reason: string | null;
    profileFingerprint: string | null;
  };
  reason: string | null;
  evidence: string[];
};

export type SessionHandle = {
  id: string;
  backend: SessionBackend;
  driverKind: SessionDriverKind;
};

export type SessionTranscriptEntry = {
  role: "user" | "assistant" | "tool" | "summary";
  content: string;
};

export type SessionRecovery = {
  status: "fresh" | "native-resumed" | "replay-pending" | "replayed" | "native-lost";
  reason: string | null;
  replayBytes: number;
  replayTruncated: boolean;
};

export type SessionRateLimit = {
  limited: boolean;
  retryAfterMs: number | null;
  observedAt: number | null;
  reason: string | null;
};

export type SessionTokenUsage = {
  input: number | null;
  output: number | null;
  reasoning: number | null;
  cached: number | null;
  total: number | null;
};

export type SessionEventKind =
  | "session"
  | "turn"
  | "text"
  | "tool"
  | "usage"
  | "completion"
  | "rate-limit"
  | "error"
  | "diagnostic";

export type SessionEvent = {
  id: string;
  kind: SessionEventKind;
  backend: SessionBackend;
  sequence: number;
  providerSequence: number | null;
  sessionId: string | null;
  turnId: string | null;
  itemId: string | null;
  text: string | null;
  usage: SessionTokenUsage | null;
  costUsd: number | null;
  retryAfterMs: number | null;
  inferred: boolean;
};

export type SessionTurnResult = {
  id: string;
  status: "completed" | "failed" | "cancelled" | "rate-limited" | "incomplete";
  output: string;
  events: SessionEvent[];
  usage: SessionTokenUsage;
  /** Provider-reported charge for this turn. Null when the native CLI did not report one. */
  costUsd: number | null;
  nativeSessionId: string | null;
  nativeTurnId: string | null;
  startedAt: number;
  completedAt: number;
  malformedEvents: number;
  inferredCompletion: boolean;
  truncated: boolean;
  rateLimit: SessionRateLimit;
  error: {
    code: SessionDriverErrorCode;
    message: string;
    retryable: boolean;
  } | null;
};

export type SessionInspection = {
  handle: SessionHandle;
  status: "idle" | "running" | "rate-limited" | "failed" | "closed";
  cwd: string;
  mode: "read-only" | "write";
  model: string | null;
  agent: string | null;
  approvalPolicy: SessionApprovalPolicy;
  nativeSessionId: string | null;
  backendVersion: string | null;
  authProfileFingerprint: string | null;
  capabilities: SessionDriverCapabilities;
  activeTurnId: string | null;
  lastTurn: SessionTurnResult | null;
  rateLimit: SessionRateLimit;
  recovery: SessionRecovery;
  createdAt: number;
  updatedAt: number;
};

export type SessionProbeInput = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type CreateSessionInput = {
  cwd: string;
  mode?: "read-only" | "write";
  containment?: "required" | "unsafe";
  model?: string;
  agent?: string;
  env?: NodeJS.ProcessEnv;
  approvalPolicy?: SessionApprovalPolicy;
  authProfileFingerprint?: string;
  sessionId?: string;
  timeoutMs?: number;
};

export type ResumeSessionInput = CreateSessionInput & {
  nativeSessionId?: string | null;
  transcript?: SessionTranscriptEntry[];
  nativeResumeAvailable?: boolean;
};

export type StartTurnInput = {
  prompt: string;
  timeoutMs?: number;
};

export type SendOptions = Omit<StartTurnInput, "prompt">;

export interface SessionDriver {
  readonly backend: SessionBackend;
  readonly kind: SessionDriverKind;
  readonly capabilities: SessionDriverCapabilities;
  probe(input?: SessionProbeInput): Promise<SessionDriverProbe>;
  create(input: CreateSessionInput): Promise<SessionHandle>;
  startTurn(session: SessionHandle | string, input: StartTurnInput): Promise<SessionTurnResult>;
  send(session: SessionHandle | string, message: string, options?: SendOptions): Promise<SessionTurnResult>;
  resume(input: ResumeSessionInput): Promise<SessionHandle>;
  cancel(session: SessionHandle | string): Promise<SessionInspection>;
  inspect(session: SessionHandle | string): Promise<SessionInspection>;
  close(session: SessionHandle | string): Promise<void>;
}
import type { SessionDriverErrorCode } from "./errors";
