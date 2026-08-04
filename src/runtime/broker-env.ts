export const BROKER_ENV_VARS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "XAI_API_KEY",
] as const;

export type BrokerEnvReadiness = {
  variable: typeof BROKER_ENV_VARS[number];
  present: boolean;
};

/** Redacted provider-key inventory: names and presence only, never values. */
export function brokerEnvReadiness(env: NodeJS.ProcessEnv = process.env): BrokerEnvReadiness[] {
  return BROKER_ENV_VARS.map((variable) => ({
    variable,
    present: Boolean(env[variable]?.trim()),
  }));
}
