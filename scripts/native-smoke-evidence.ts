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

// Required subscription backends for the kernel-beta native gate. Grok stays
// experimental (isolation-attestation-gated) and is never required. macOS Claude
// Code keeps its live OAuth token in the login Keychain, which required
// containment cannot read; only the regular ~/.claude/.credentials.json file is
// copyable and it is commonly a stale snapshot. So on macOS the gate requires
// only Codex and OpenCode and Claude is a documented limitation there; on Linux
// a file-credential Claude login is required (docs/plan.md Gate A #2).
export function requiredNativeSmokeBackends(platform: NodeJS.Platform) {
  return platform === "darwin"
    ? (["codex", "opencode"] as const)
    : (["claude-code", "codex", "opencode"] as const);
}

// A documented, accepted fail-closed limitation classifies as an informational
// skip rather than a gate failure: the experimental Grok isolation-attestation
// gate, and macOS keychain-only Claude auth unavailability. Keyed on the
// structured terminal code, mirroring the live-agent matrix.
export function nativeSmokeAcceptedLimitation(
  backend: string,
  code: string | null,
  platform: NodeJS.Platform,
) {
  if (backend === "grok-build" && code === "BACKEND_UNSUPPORTED") return true;
  if (backend === "claude-code" && code === "NATIVE_AUTH_UNAVAILABLE" && platform === "darwin") return true;
  return false;
}

// Per-backend release-gate evaluation. The gate passes when the primary is
// unchanged, every required backend either passed, is a documented accepted
// limitation, or is transiently rate-limited (authenticated and contained, but
// the subscription throttled this run), and at least one required backend
// actually completed a native turn (an all-skips result proves nothing).
export function evaluateNativeSmokeGate(
  results: ReadonlyArray<{ backend: string; status: string; acceptedLimitation: boolean; code?: string | null }>,
  repositoryUnchanged: boolean,
  platform: NodeJS.Platform,
) {
  const requiredBackends = [...requiredNativeSmokeBackends(platform)];
  const required = requiredBackends.map((backend) => results.find((result) => result.backend === backend) ?? null);
  const rateLimited = (result: { code?: string | null }) => result.code === "RATE_LIMITED";
  const requiredPresent = required.every((result) => result !== null);
  const requiredSatisfied = requiredPresent
    && required.every((result) => result!.status === "passed" || result!.acceptedLimitation || rateLimited(result!));
  const requiredRealPass = required.some((result) => result?.status === "passed");
  const transientRateLimited = required.filter((result) => result && rateLimited(result)).map((result) => result!.backend);
  return {
    releaseGatePassed: repositoryUnchanged && requiredSatisfied && requiredRealPass,
    requiredBackends,
    requiredSatisfied,
    requiredRealPass,
    transientRateLimited,
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
