export type BackendCapabilities = {
  write: boolean;
  streaming: boolean;
  structuredOutput: boolean;
  nativeResume: boolean;
  cancellation: boolean;
  tools: boolean;
  effort: boolean;
  brokerCompatible: boolean;
};

export type BackendProbe = {
  ok: boolean;
  version: string | null;
  capabilities: BackendCapabilities;
  reason: string | null;
};
