export function nativeSmokeEvidenceValid(
  result: Record<string, unknown> | null,
  native: Record<string, unknown> | null,
) {
  const containment = objectValue(result?.containment);
  return result?.status === "succeeded"
    && containment?.requirement === "required"
    && containment.enforced === true
    && containment.network === "native-direct-unrestricted"
    && containment.credentialAccess === "backend-native"
    && containment.unsafe === false
    && stringValue(native?.driverKind) !== null
    && stringValue(native?.authProfileFingerprint) !== null;
}

export function nativeSmokeContainmentSummary(value: Record<string, unknown> | null) {
  if (!value) return null;
  return {
    mechanism: stringValue(value.mechanism),
    network: stringValue(value.network),
    credentialAccess: stringValue(value.credentialAccess),
  };
}

// Grok stays experimental (isolation-attestation-gated), so it is not part of
// the kernel-beta native-subscription gate; the required subscription backends
// are Claude, Codex, and OpenCode (docs/plan.md Gate A #2).
export const NATIVE_SMOKE_REQUIRED_BACKENDS = ["claude-code", "codex", "opencode"] as const;

// A documented, accepted fail-closed limitation satisfies the gate instead of
// failing it: macOS keychain-only Claude login (unavailable under required
// Seatbelt containment) and the experimental Grok isolation-attestation gate.
// Keyed on the structured terminal code, mirroring the live-agent matrix.
export function nativeSmokeAcceptedLimitation(
  backend: string,
  code: string | null,
  platform: NodeJS.Platform,
) {
  if (backend === "claude-code" && code === "NATIVE_AUTH_UNAVAILABLE" && platform === "darwin") return true;
  if (backend === "grok-build" && code === "BACKEND_UNSUPPORTED") return true;
  return false;
}

// Per-backend release-gate evaluation. The gate passes when the primary is
// unchanged, every required backend either passed or is a documented accepted
// limitation, and at least one required backend actually completed a native
// turn (an all-skips result proves nothing). Grok and any non-required backend
// are informational only.
export function evaluateNativeSmokeGate(
  results: ReadonlyArray<{ backend: string; status: string; acceptedLimitation: boolean }>,
  repositoryUnchanged: boolean,
) {
  const required = NATIVE_SMOKE_REQUIRED_BACKENDS.map(
    (backend) => results.find((result) => result.backend === backend) ?? null,
  );
  const requiredPresent = required.every((result) => result !== null);
  const requiredSatisfied = requiredPresent
    && required.every((result) => result!.status === "passed" || result!.acceptedLimitation);
  const requiredRealPass = required.some((result) => result?.status === "passed");
  return {
    releaseGatePassed: repositoryUnchanged && requiredSatisfied && requiredRealPass,
    requiredBackends: [...NATIVE_SMOKE_REQUIRED_BACKENDS],
    requiredSatisfied,
    requiredRealPass,
  };
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value ? value : null;
}
