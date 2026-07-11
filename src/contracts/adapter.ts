import type { RunEvent, RunRequest, RunResult } from "./run";

export type AdapterCapabilities = {
  write: boolean;
  streaming: boolean;
  structuredOutput: boolean;
  nativeResume: boolean;
  cancellation: boolean;
  tools: boolean;
  effort: boolean;
  brokerCompatible: boolean;
};

export type AdapterProbe = {
  ok: boolean;
  version: string | null;
  capabilities: AdapterCapabilities;
  reason: string | null;
};

export type PreparedCommand = {
  argv: string[];
  env: Record<string, string>;
  stdin: string | null;
};

export type AdapterParseResult = {
  output: string;
  events: RunEvent[];
  result: Pick<RunResult, "usage" | "cost" | "diagnostics">;
  error: string | null;
};

export interface Adapter {
  readonly id: string;
  readonly capabilities: AdapterCapabilities;
  probe(request: RunRequest): Promise<AdapterProbe>;
  prepare(request: RunRequest): Promise<PreparedCommand>;
  parse(stdout: string, stderr: string): AdapterParseResult;
  configureBroker(request: RunRequest, endpoint: string, token: string): Record<string, string>;
  resume?(request: RunRequest, nativeSessionId: string): Promise<PreparedCommand>;
  replay?(request: RunRequest, transcript: string): Promise<PreparedCommand>;
  cancel?(jobId: string): Promise<void>;
}
