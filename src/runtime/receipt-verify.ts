import { z } from "zod";
import {
  RECEIPT_SECTIONS,
  ReceiptSchema,
  Sha256HexSchema,
  type Receipt,
  type ReceiptSection,
} from "../contracts/receipt";
import {
  LedgerRecordV2Schema,
  verifyLedgerChain,
  verifyUnkeyedLedgerRecordHash,
  type LedgerRecordV2,
  type LedgerV2Options,
  type LedgerVerificationVerdict,
} from "./ledger-v2";
import { parseReceiptAnchorRecord } from "./receipt-anchor";
import { canonicalReceiptJson, receiptSectionDigests, receiptSelfDigest } from "./receipt-canonical";

type VerificationKeys = Pick<
  LedgerV2Options,
  "hmacKey" | "hmacKeyId" | "hmacKeyring" | "activeHmacKeyId"
>;

export type ReceiptSelfDigestVerdict = {
  ok: boolean;
  failingSection?: ReceiptSection;
  reason?: string;
};

export type ReceiptAnchorVerificationVerdict = {
  ok: boolean;
  reason?: string;
};

export type ReceiptVerificationVerdict = {
  ok: boolean;
  ledger: LedgerVerificationVerdict;
  anchor: ReceiptAnchorVerificationVerdict;
  selfDigest: ReceiptSelfDigestVerdict;
  reason?: string;
};

/** Recompute the receipt root digest, localizing a mismatch to its first body section. */
export function verifyReceiptSelfDigest(receipt: Receipt): ReceiptSelfDigestVerdict {
  if (receiptSelfDigest(receipt.body) === receipt.integrity.selfDigest) return { ok: true };
  const actualSections = receiptSectionDigests(receipt.body);
  const failingSection = RECEIPT_SECTIONS.find(
    (section) => actualSections[section] !== receipt.sectionDigests[section],
  );
  return {
    ok: false,
    ...(failingSection ? { failingSection } : {}),
    reason: failingSection
      ? `Receipt self-digest mismatch in section ${failingSection}.`
      : "Receipt self-digest mismatch.",
  };
}

/** Confirm that the receipt points to the exact durable anchor record supplied by the ledger. */
export function verifyReceiptAgainstLedger(
  receipt: Receipt,
  records: readonly LedgerRecordV2[],
): ReceiptAnchorVerificationVerdict {
  const expected = receipt.integrity.ledgerAnchor;
  if (receipt.body.projectId !== expected.projectId) {
    return { ok: false, reason: "Receipt body project does not match its ledger anchor project." };
  }
  const record = records.find((candidate) => candidate.sequence === expected.sequence);
  if (!record) return { ok: false, reason: `Ledger anchor sequence ${expected.sequence} is missing.` };
  if (record.hash !== expected.hash) return { ok: false, reason: "Ledger anchor hash does not match the receipt." };
  if (record.projectId !== expected.projectId) return { ok: false, reason: "Ledger anchor project does not match the receipt." };
  const marker = parseReceiptAnchorRecord(record);
  if (!marker) return { ok: false, reason: "Ledger record does not contain one valid execution-receipt anchor." };
  if (marker.receiptId !== receipt.body.receiptId || marker.runId !== receipt.body.runId) {
    return { ok: false, reason: "Ledger anchor identifies a different receipt or run." };
  }
  if (marker.sha256 !== receipt.integrity.selfDigest) {
    return { ok: false, reason: "Ledger anchor digest does not match the receipt self-digest." };
  }
  return { ok: true };
}

/** Verify the complete live ledger before checking inclusion and the receipt's own bytes. */
export function verifyReceipt(input: {
  receipt: Receipt;
  records: readonly LedgerRecordV2[];
} & VerificationKeys): ReceiptVerificationVerdict {
  const { receipt, records, ...keys } = input;
  const ledger = verifyLedgerChain({
    records,
    projectId: receipt.integrity.ledgerAnchor.projectId,
    ...keys,
  });
  const anchor = verifyReceiptAgainstLedger(receipt, records);
  const selfDigest = verifyReceiptSelfDigest(receipt);
  const ok = ledger.ok && anchor.ok && selfDigest.ok;
  return {
    ok,
    ledger,
    anchor,
    selfDigest,
    ...(!ok ? {
      reason: !ledger.ok
        ? `Ledger verification failed: ${ledger.reason ?? "unknown integrity failure"}`
        : !anchor.ok
          ? anchor.reason
          : selfDigest.reason,
    } : {}),
  };
}

export const ExportedReceiptSchema = z.object({
  receipt: ReceiptSchema,
  anchorRecord: LedgerRecordV2Schema,
  exportEnvelope: z.object({
    exportedAt: z.string().datetime(),
    exporterVersion: z.string().min(1).max(128),
    ledgerHead: z.object({
      sequence: z.number().int().positive(),
      hash: Sha256HexSchema,
    }).strict(),
  }).strict(),
}).strict();

export type ExportedReceipt = z.infer<typeof ExportedReceiptSchema>;
export type ExportedReceiptVerdict = {
  ok: boolean;
  assurance: "full-chain" | "embedded-record" | "structural-only" | "failed";
  selfDigest: ReceiptSelfDigestVerdict;
  anchor: "verified" | "embedded-unverified" | "failed";
  ledger: {
    status: "not-provided" | "verified" | "failed";
    verdict?: LedgerVerificationVerdict;
  };
  reason?: string;
};

/**
 * Verify a portable receipt without requiring the project daemon or ledger.
 * Offline SHA records can be re-hashed, while HMAC records are necessarily
 * reported as embedded-unverified until the real ledger and its keys are
 * supplied. Passing `records` upgrades the result to full in-chain proof.
 */
export function verifyExportedReceipt(
  value: unknown,
  options: { records?: readonly LedgerRecordV2[] } & VerificationKeys = {},
): ExportedReceiptVerdict {
  const parsed = ExportedReceiptSchema.safeParse(value);
  if (!parsed.success) return failedExport("Exported receipt envelope is invalid.");
  const exported = parsed.data;
  const selfDigest = verifyReceiptSelfDigest(exported.receipt);
  if (!selfDigest.ok) return failedExport(selfDigest.reason ?? "Receipt self-digest mismatch.", selfDigest);

  const structuralAnchor = verifyReceiptAgainstLedger(exported.receipt, [exported.anchorRecord]);
  if (!structuralAnchor.ok) return failedExport(structuralAnchor.reason ?? "Embedded anchor mismatch.", selfDigest);
  if (exported.exportEnvelope.ledgerHead.sequence < exported.anchorRecord.sequence) {
    return failedExport("Exported ledger head precedes the embedded anchor record.", selfDigest);
  }
  if (
    exported.exportEnvelope.ledgerHead.sequence === exported.anchorRecord.sequence
    && exported.exportEnvelope.ledgerHead.hash !== exported.anchorRecord.hash
  ) {
    return failedExport("Exported ledger head conflicts with the embedded anchor record.", selfDigest);
  }

  let anchor: ExportedReceiptVerdict["anchor"];
  let assurance: ExportedReceiptVerdict["assurance"];
  if (exported.anchorRecord.integrity.algorithm === "sha256") {
    if (!verifyUnkeyedLedgerRecordHash(exported.anchorRecord)) {
      return failedExport("Embedded unkeyed ledger record hash is invalid.", selfDigest);
    }
    anchor = "verified";
    assurance = "embedded-record";
  } else {
    if (!exported.anchorRecord.integrity.keyId) {
      return failedExport("Embedded HMAC ledger record is missing its key id.", selfDigest);
    }
    anchor = "embedded-unverified";
    assurance = "structural-only";
  }

  if (!options.records) {
    return {
      ok: true,
      assurance,
      selfDigest,
      anchor,
      ledger: { status: "not-provided" },
      ...(anchor === "embedded-unverified" ? {
        reason: "The embedded HMAC ledger record is structurally consistent, but authenticity requires the live ledger and verification key.",
      } : {}),
    };
  }

  const { records, ...keys } = options;
  const live = verifyReceipt({ receipt: exported.receipt, records, ...keys });
  const liveRecord = records.find((record) => record.sequence === exported.anchorRecord.sequence);
  const sameRecord = !!liveRecord
    && canonicalReceiptJson(liveRecord) === canonicalReceiptJson(exported.anchorRecord);
  const sameHead = live.ledger.head?.sequence === exported.exportEnvelope.ledgerHead.sequence
    && live.ledger.head.hash === exported.exportEnvelope.ledgerHead.hash;
  if (!live.ok || !sameRecord || !sameHead) {
    const reason = !live.ok
      ? live.reason ?? "Live ledger verification failed."
      : !sameRecord
        ? "The live ledger anchor record differs from the exported record."
        : "The live ledger head differs from the export envelope.";
    return {
      ok: false,
      assurance: "failed",
      selfDigest,
      anchor: "failed",
      ledger: { status: "failed", verdict: live.ledger },
      reason,
    };
  }
  return {
    ok: true,
    assurance: "full-chain",
    selfDigest,
    anchor: "verified",
    ledger: { status: "verified", verdict: live.ledger },
  };
}

function failedExport(
  reason: string,
  selfDigest: ReceiptSelfDigestVerdict = { ok: false, reason },
): ExportedReceiptVerdict {
  return {
    ok: false,
    assurance: "failed",
    selfDigest,
    anchor: "failed",
    ledger: { status: "not-provided" },
    reason,
  };
}
