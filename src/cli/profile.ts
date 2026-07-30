/**
 * Named exec presets that collapse multi-flag ceremony into one --profile
 * (Product Gate P.STEPS / P.TTFV). Profiles never weaken containment.
 */

export type ExecProfileId = "read-only-native" | "broker-readonly";

export type ExecProfile = {
  id: ExecProfileId;
  authMode: "native-login" | "broker";
  mode: "read-only";
  containment: "required";
  description: string;
};

export const EXEC_PROFILES: Record<ExecProfileId, ExecProfile> = {
  "read-only-native": {
    id: "read-only-native",
    authMode: "native-login",
    mode: "read-only",
    containment: "required",
    description: "Read-only native subscription login under required OS containment.",
  },
  "broker-readonly": {
    id: "broker-readonly",
    authMode: "broker",
    mode: "read-only",
    containment: "required",
    description: "Read-only broker lease under required OS containment (daemon holds API keys).",
  },
};

export function parseExecProfile(value: string | undefined): ExecProfile | undefined {
  if (!value) return undefined;
  const profile = EXEC_PROFILES[value as ExecProfileId];
  if (!profile) {
    const known = Object.keys(EXEC_PROFILES).join("|");
    throw new Error(`Invalid --profile ${value}. Expected ${known}.`);
  }
  return profile;
}

export function profileChoices() {
  return Object.keys(EXEC_PROFILES) as ExecProfileId[];
}
