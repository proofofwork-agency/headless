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

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value ? value : null;
}
