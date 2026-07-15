import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { platform as osPlatform, arch } from "node:process";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { connectOrStartDaemon } from "../src/daemon/connect";
import { atomicWriteFile } from "../src/runtime/atomic-write";
import {
  ReleaseEvidenceProvenanceSchema,
  releaseEvidenceArtifact,
  type ReleaseEvidenceProvenance,
} from "../src/runtime/release-evidence-anchor";
import { HEADLESS_VERSION } from "../src/version";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..");
const BACKEND_BINARIES = {
  "claude-code": "claude",
  codex: "codex",
  opencode: "opencode",
  "grok-build": "grok",
} as const;

export function releaseEvidenceProvenance(options: {
  repositoryRoot?: string;
  generatedAt?: string;
  commit?: string | null;
  backendVersions?: Record<string, string | null>;
} = {}): ReleaseEvidenceProvenance {
  const repositoryRoot = options.repositoryRoot ?? REPOSITORY_ROOT;
  return ReleaseEvidenceProvenanceSchema.parse({
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    commit: options.commit === undefined ? repositoryCommit(repositoryRoot) : options.commit,
    platform: `${osPlatform}-${arch}`,
    headlessVersion: HEADLESS_VERSION,
    backendVersions: boundedBackendVersions(options.backendVersions ?? probeBackendVersions()),
  });
}

export function writeReleaseEvidenceFile<T extends Record<string, unknown>>(options: {
  path: string;
  evidence: T;
  provenance?: ReleaseEvidenceProvenance;
  repositoryRoot?: string;
}) {
  const provenance = options.provenance ?? releaseEvidenceProvenance({ repositoryRoot: options.repositoryRoot });
  const document = { ...options.evidence, provenance };
  const bytes = `${JSON.stringify(document, null, 2)}\n`;
  mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
  atomicWriteFile(options.path, bytes, { mode: 0o600 });
  return {
    document,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function writeAnchoredReleaseEvidence<T extends Record<string, unknown>>(options: {
  path: string;
  evidence: T & { releaseGatePassed: boolean };
  repositoryRoot?: string;
  anchorRoot?: string;
  provenance?: ReleaseEvidenceProvenance;
}) {
  const repositoryRoot = resolve(options.repositoryRoot ?? REPOSITORY_ROOT);
  const anchorRoot = resolve(options.anchorRoot ?? process.env.HEADLESS_EVIDENCE_ANCHOR_ROOT ?? repositoryRoot);
  const written = writeReleaseEvidenceFile({
    path: options.path,
    evidence: options.evidence,
    provenance: options.provenance,
    repositoryRoot,
  });
  const relativePath = relative(anchorRoot, resolve(options.path)).split(sep).join("/");
  if (!relativePath || relativePath.startsWith("../") || isAbsolute(relativePath)) {
    throw new Error(`Release-evidence path must be inside its explicit anchor root: ${options.path}`);
  }
  // Deliberately do not pass the smoke's disposable child environment. This
  // authenticates to (or starts) the repository project's normal daemon and
  // leaves that operator-owned daemon running after the opt-in smoke exits.
  const client = await connectOrStartDaemon({ projectRoot: anchorRoot });
  const anchor = releaseEvidenceArtifact({
    relativePath,
    sha256: written.sha256,
    provenance: written.document.provenance,
    releaseGatePassed: options.evidence.releaseGatePassed,
  });
  const receipt = await client.call<{ sequence: number; hash: string }>("ledger.artifact", anchor);
  return { ...written, relativePath, receipt };
}

function repositoryCommit(repositoryRoot: string) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 16_384,
  });
  const value = result.status === 0 ? result.stdout.trim().toLowerCase() : "";
  return /^[a-f0-9]{40,64}$/.test(value) ? value : null;
}

function probeBackendVersions() {
  return Object.fromEntries(Object.entries(BACKEND_BINARIES).map(([backend, binary]) => {
    const result = spawnSync(binary, ["--version"], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 16_384,
    });
    const value = result.status === 0 ? `${result.stdout}\n${result.stderr}`.trim().slice(0, 256) : "";
    return [backend, value || null];
  }));
}

function boundedBackendVersions(values: Record<string, string | null>) {
  return Object.fromEntries(Object.entries(values).slice(0, 32).map(([backend, version]) => [
    backend.slice(0, 128),
    version === null ? null : version.slice(0, 256),
  ]));
}

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
// Code keeps its ordinary login token in the login Keychain, which required
// containment cannot read; operators can opt into the reviewed setup-token
// capsule, but the macOS baseline gate still requires Codex and OpenCode. On
// Linux a file-credential Claude login is required (docs/plan.md Gate A #1).
export function requiredNativeSmokeBackends(platform: NodeJS.Platform) {
  return platform === "darwin"
    ? (["codex", "opencode"] as const)
    : (["claude-code", "codex", "opencode"] as const);
}

// A documented, accepted fail-closed limitation classifies as an informational
// skip rather than a gate failure: the experimental Grok isolation-attestation
// gate, and macOS Claude auth unavailability when the optional setup-token
// capsule is absent. Keyed on the structured terminal code, mirroring the
// live-agent matrix.
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
  return evaluateRequiredNativeBackends(results, repositoryUnchanged, platform);
}

// The write smoke reuses the containment portion of nativeSmokeEvidenceValid: a
// native-login write turn must still run under enforced required containment with
// native-direct-unrestricted egress and backend-native credential access. The
// write RunResult carries no durable-session `native` block, so driver/fingerprint
// evidence is not asserted here; the candidate Git commit and its integration into
// primary carry the end-to-end write proof instead.
export function nativeWriteSmokeContainmentValid(containment: Record<string, unknown> | null) {
  return containment?.requirement === "required"
    && containment.enforced === true
    && containment.network === "native-direct-unrestricted"
    && containment.credentialAccess === "backend-native"
    && containment.unsafe === false;
}

// A candidate integration outcome that actually advanced primary. Preserved or
// blocked outcomes are deliberately excluded: the write gate proves the edit
// reached primary, whether by the inline fast-forward or an authorized
// `candidate integrate` of a preserved candidate.
export function isNativeWriteMergeOutcome(outcome: string | null) {
  return outcome === "merged_fast_forward"
    || outcome === "merged_advanced"
    || outcome === "recovered_applied";
}

// The native-write harness submits one backend at a time into a disposable
// project. Select only the pending, daemon-attributed coder-tool approval whose
// durable collaboration id matches its job id and whose backend/mode match the
// submitted turn. Any ambiguity fails closed instead of approving unrelated
// work.
export function pendingNativeWriteCoderApproval(value: unknown, backend: string) {
  if (!Array.isArray(value)) throw new Error("approval.list did not return an array.");
  const matches = value.flatMap((entry) => {
    const approval = objectValue(entry);
    const details = objectValue(approval?.details);
    if (approval?.status !== "pending" || approval.kind !== "coder_tool") return [];
    if (details?.backend !== backend || details.mode !== "write") return [];
    const approvalId = stringValue(approval.id);
    const collaborationId = stringValue(approval.collaborationId);
    const jobId = stringValue(details.jobId);
    if (!approvalId || !collaborationId || !jobId || collaborationId !== jobId) {
      throw new Error(`Pending ${backend} coder-tool approval was malformed.`);
    }
    return [{ approvalId, jobId }];
  });
  if (matches.length > 1) throw new Error(`Multiple pending coder-tool approvals matched ${backend}.`);
  return matches[0] ?? null;
}

// Per-backend release-gate evaluation for the write smoke. Mirrors
// evaluateNativeSmokeGate exactly, except the repository invariant is that no
// preserved candidate mutated primary before its authorized integration
// (`primaryPreservedBeforeIntegration`) rather than primary being unchanged
// throughout — a write smoke is expected to advance primary once the candidate is
// authorized. Required set, accepted limitations, and transient rate-limit
// handling are identical to the read gate.
export function evaluateNativeWriteSmokeGate(
  results: ReadonlyArray<{ backend: string; status: string; acceptedLimitation: boolean; code?: string | null }>,
  primaryPreservedBeforeIntegration: boolean,
  platform: NodeJS.Platform,
) {
  return evaluateRequiredNativeBackends(results, primaryPreservedBeforeIntegration, platform);
}

function evaluateRequiredNativeBackends(
  results: ReadonlyArray<{ backend: string; status: string; acceptedLimitation: boolean; code?: string | null }>,
  repositoryInvariantHeld: boolean,
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
    releaseGatePassed: repositoryInvariantHeld && requiredSatisfied && requiredRealPass,
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
