import { z } from "zod";
import { IdentifierSchema, RunModeSchema } from "../contracts/common";
import { Sha256HexSchema } from "../contracts/receipt";
import type { LedgerRecordV2 } from "./ledger-v2";
import { safeJsonParse } from "./safe-json";

export const RECEIPT_ANCHOR_ARTIFACT_KIND = "execution_receipt";
export const RECEIPT_ANCHOR_MARKER_PREFIX = "headless-execution-receipt:";
/** Keep the durable marker small so anchoring every run (incl. read-only) stays cheap. */
const MAX_RECEIPT_ANCHOR_BYTES = 3_500;

const RunStatusSchema = z.enum(["succeeded", "failed", "timed_out", "cancelled", "blocked"]);

/** Bounded provenance carried inside the anchor marker (a lite subset of the receipt's provenance envelope). */
const AnchorProvenanceSchema = z.object({
  generatedAt: z.string().datetime(),
  headlessVersion: z.string().min(1).max(128),
  platform: z.string().min(1).max(128),
  commit: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
}).strict();

/**
 * The digest + metadata anchored into the tamper-evident ledger for one run.
 * `sha256` equals the receipt's `integrity.selfDigest`; the full receipt lives
 * in the durable receipt store, only this marker goes into the ledger.
 */
export const ReceiptAnchorSchema = z.object({
  version: z.literal(1),
  receiptId: IdentifierSchema,
  runId: IdentifierSchema,
  sha256: Sha256HexSchema,
  mode: RunModeSchema,
  status: RunStatusSchema,
  provenance: AnchorProvenanceSchema,
}).strict().refine(
  (value) => Buffer.byteLength(JSON.stringify(value)) <= MAX_RECEIPT_ANCHOR_BYTES,
  "Receipt anchor marker exceeds its durable ledger bound.",
);

export type ReceiptAnchor = z.infer<typeof ReceiptAnchorSchema>;

/** Build the ledger artifact that anchors a receipt's self-digest into the tamper-evident chain. */
export function receiptAnchorArtifact(anchor: ReceiptAnchor) {
  const parsed = ReceiptAnchorSchema.parse(anchor);
  return {
    kind: RECEIPT_ANCHOR_ARTIFACT_KIND,
    title: `Execution receipt: ${parsed.runId}`,
    summary: `Run ${parsed.runId} (${parsed.mode}) completed ${parsed.status}; receipt bytes anchored by SHA-256.`,
    status: parsed.status === "succeeded" ? ("passed" as const) : ("failed" as const),
    evidence: [`${RECEIPT_ANCHOR_MARKER_PREFIX}${JSON.stringify(parsed)}`],
  };
}

/** Parse the single receipt-anchor marker out of an artifact's evidence array. */
export function parseReceiptAnchor(evidence: unknown): ReceiptAnchor | null {
  if (!Array.isArray(evidence)) return null;
  const markers = evidence.filter(
    (item): item is string => typeof item === "string" && item.startsWith(RECEIPT_ANCHOR_MARKER_PREFIX),
  );
  if (markers.length !== 1) return null;
  try {
    return ReceiptAnchorSchema.parse(safeJsonParse(markers[0]!.slice(RECEIPT_ANCHOR_MARKER_PREFIX.length)));
  } catch {
    return null;
  }
}

/** Locate the latest anchor record for a given receiptId within a set of ledger records. */
export function findReceiptAnchor(
  records: readonly LedgerRecordV2[],
  receiptId: string,
): { anchor: ReceiptAnchor; sequence: number } | null {
  let found: { anchor: ReceiptAnchor; sequence: number } | null = null;
  for (const record of records) {
    const anchor = parseReceiptAnchorRecord(record);
    if (!anchor || anchor.receiptId !== receiptId) continue;
    if (!found || record.sequence > found.sequence) found = { anchor, sequence: record.sequence };
  }
  return found;
}

/** Parse a receipt anchor only from the expected artifact record shape. */
export function parseReceiptAnchorRecord(record: LedgerRecordV2): ReceiptAnchor | null {
  const artifact = artifactValue(record);
  if (!artifact || artifact.kind !== RECEIPT_ANCHOR_ARTIFACT_KIND) return null;
  return parseReceiptAnchor(artifact.evidence);
}

function artifactValue(record: LedgerRecordV2) {
  const event = record.payload.event;
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const artifact = (event as Record<string, unknown>).artifact;
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return null;
  return artifact as { kind?: unknown; evidence?: unknown };
}
