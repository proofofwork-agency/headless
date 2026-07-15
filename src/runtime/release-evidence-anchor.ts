import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { z } from "zod";
import type { LedgerRecordV2 } from "./ledger-v2";
import { safeJsonParse } from "./safe-json";

export const RELEASE_EVIDENCE_ARTIFACT_KIND = "release_evidence";
export const RELEASE_EVIDENCE_MARKER_PREFIX = "headless-release-evidence:";
const MAX_EVIDENCE_ANCHORS = 1_024;

export const ReleaseEvidenceProvenanceSchema = z.object({
  generatedAt: z.string().datetime(),
  commit: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  platform: z.string().min(1).max(128),
  headlessVersion: z.string().min(1).max(128),
  backendVersions: z.record(z.string().max(256).nullable()),
}).strict().refine((value) => Object.keys(value.backendVersions).length <= 32, "Evidence provenance has too many backend versions.");

export type ReleaseEvidenceProvenance = z.infer<typeof ReleaseEvidenceProvenanceSchema>;

const ReleaseEvidenceAnchorSchema = z.object({
  version: z.literal(1),
  path: z.string().min(1).max(512),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  provenance: ReleaseEvidenceProvenanceSchema,
}).strict().refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 3_500, "Evidence anchor marker exceeds its durable ledger bound.");

type ReleaseEvidenceAnchor = z.infer<typeof ReleaseEvidenceAnchorSchema>;

export type ReleaseEvidenceVerification = {
  checked: number;
  matched: number;
  mismatched: number;
  missing: number;
  malformed: number;
  artifacts: Array<{
    path: string | null;
    sequence: number;
    expectedSha256: string | null;
    actualSha256: string | null;
    status: "matched" | "mismatched" | "missing" | "malformed" | "unsafe_path";
    reason?: string;
  }>;
};

export function releaseEvidenceArtifact(input: {
  relativePath: string;
  sha256: string;
  provenance: ReleaseEvidenceProvenance;
  releaseGatePassed: boolean;
}) {
  const anchor = ReleaseEvidenceAnchorSchema.parse({
    version: 1,
    path: input.relativePath,
    sha256: input.sha256,
    provenance: input.provenance,
  });
  return {
    kind: RELEASE_EVIDENCE_ARTIFACT_KIND,
    title: `Release evidence: ${anchor.path}`,
    summary: `Release evidence ${input.releaseGatePassed ? "passed" : "failed"}; exact file bytes are anchored by SHA-256.`,
    status: input.releaseGatePassed ? "passed" as const : "failed" as const,
    evidence: [`${RELEASE_EVIDENCE_MARKER_PREFIX}${JSON.stringify(anchor)}`],
  };
}

export function verifyReleaseEvidenceAnchors(records: readonly LedgerRecordV2[], projectRoot: string): ReleaseEvidenceVerification {
  const latest = new Map<string, { anchor: ReleaseEvidenceAnchor; sequence: number }>();
  const malformed: ReleaseEvidenceVerification["artifacts"] = [];
  let releaseEvidenceEvents = 0;
  for (const record of records) {
    const artifact = artifactValue(record);
    if (!artifact || artifact.kind !== RELEASE_EVIDENCE_ARTIFACT_KIND) continue;
    releaseEvidenceEvents += 1;
    const parsed = parseAnchor(artifact.evidence);
    if (!parsed) {
      malformed.push({
        path: null,
        sequence: record.sequence,
        expectedSha256: null,
        actualSha256: null,
        status: "malformed",
        reason: "Release-evidence artifact is missing one strict anchor marker.",
      });
      continue;
    }
    latest.set(parsed.path, { anchor: parsed, sequence: record.sequence });
  }

  if (latest.size + malformed.length > MAX_EVIDENCE_ANCHORS) {
    return {
      checked: 0,
      matched: 0,
      mismatched: 0,
      missing: 0,
      malformed: 1,
      artifacts: [{
        path: null,
        sequence: records.at(-1)?.sequence ?? 0,
        expectedSha256: null,
        actualSha256: null,
        status: "malformed",
        reason: `Release-evidence anchors exceed the ${MAX_EVIDENCE_ANCHORS} artifact verification limit.`,
      }],
    };
  }

  const root = resolve(projectRoot);
  const artifacts = [...latest.values()].map(({ anchor, sequence }) => verifyEvidenceFile(root, anchor, sequence));
  artifacts.push(...malformed);
  return {
    checked: latest.size,
    matched: artifacts.filter((artifact) => artifact.status === "matched").length,
    mismatched: artifacts.filter((artifact) => artifact.status === "mismatched" || artifact.status === "unsafe_path").length,
    missing: artifacts.filter((artifact) => artifact.status === "missing").length,
    malformed: artifacts.filter((artifact) => artifact.status === "malformed").length,
    artifacts: artifacts.sort((left, right) => left.sequence - right.sequence),
  };
}

function artifactValue(record: LedgerRecordV2) {
  const event = record.payload.event;
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const artifact = (event as Record<string, unknown>).artifact;
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return null;
  return artifact as { kind?: unknown; evidence?: unknown };
}

function parseAnchor(value: unknown) {
  if (!Array.isArray(value)) return null;
  const markers = value.filter((item): item is string => typeof item === "string" && item.startsWith(RELEASE_EVIDENCE_MARKER_PREFIX));
  if (markers.length !== 1) return null;
  try {
    return ReleaseEvidenceAnchorSchema.parse(safeJsonParse(markers[0]!.slice(RELEASE_EVIDENCE_MARKER_PREFIX.length)));
  } catch {
    return null;
  }
}

function verifyEvidenceFile(root: string, anchor: ReleaseEvidenceAnchor, sequence: number): ReleaseEvidenceVerification["artifacts"][number] {
  const path = resolve(root, anchor.path);
  if (path === root || !path.startsWith(`${root}${sep}`)) {
    return {
      path: anchor.path,
      sequence,
      expectedSha256: anchor.sha256,
      actualSha256: null,
      status: "unsafe_path",
      reason: "Anchored evidence path escapes the verified project root.",
    };
  }
  if (!existsSync(path)) {
    return { path: anchor.path, sequence, expectedSha256: anchor.sha256, actualSha256: null, status: "missing" };
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return {
      path: anchor.path,
      sequence,
      expectedSha256: anchor.sha256,
      actualSha256: null,
      status: "unsafe_path",
      reason: "Anchored evidence path is not a regular non-symlink file.",
    };
  }
  const actualSha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  return {
    path: anchor.path,
    sequence,
    expectedSha256: anchor.sha256,
    actualSha256,
    status: actualSha256 === anchor.sha256 ? "matched" : "mismatched",
  };
}
