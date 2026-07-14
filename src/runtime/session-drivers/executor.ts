import type { SessionBackend } from "./types";

export type SessionExecutionProtocol = "text" | "jsonl" | "json-rpc-jsonl";

export type SessionExecutionRequest = {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string | null;
  timeoutMs: number;
  signal: AbortSignal;
  protocol: SessionExecutionProtocol;
  purpose?: "capability-probe" | "auth-probe" | "turn";
};

export type SessionExecutionResult = {
  exitCode: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
  events?: unknown[];
  /** True only when the executor's own watchdog elapsed. */
  timedOut?: boolean;
  /** True when the combined bounded output budget was exhausted. */
  overflowed?: boolean;
};

export type SessionTransportOpenRequest = {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal: AbortSignal;
  protocol: "json-rpc-jsonl";
  purpose?: "capability-probe" | "turn";
};

export type SessionTransportRequest = {
  method: string;
  params: unknown;
  waitFor?: string[];
  timeoutMs: number;
  signal: AbortSignal;
};

export type SessionTransportResult = {
  result?: unknown;
  events?: unknown[];
  stderr?: string;
};

export type SessionAuthProbeRequest = {
  backend: SessionBackend;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal: AbortSignal;
};

export type SessionAuthProbeResult = {
  available: boolean;
  reason: string | null;
  profileFingerprint?: string | null;
};

export interface SessionTransport {
  readonly id: string;
  request(input: SessionTransportRequest): Promise<SessionTransportResult>;
  inspect?(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export interface SessionExecutor {
  execute(input: SessionExecutionRequest): Promise<SessionExecutionResult>;
  open?(input: SessionTransportOpenRequest): Promise<SessionTransport>;
  probeAuth?(input: SessionAuthProbeRequest): Promise<SessionAuthProbeResult>;
}
