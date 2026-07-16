import { createHash } from "node:crypto";
import { RECEIPT_SECTIONS, type ReceiptBody, type ReceiptSection } from "../contracts/receipt";

/**
 * Deterministic, key-sorted JSON with no insignificant whitespace (JCS-style):
 * object keys are sorted by UTF-16 code unit, array order is preserved, numbers
 * use JavaScript's canonical JSON formatting. This is the receipt's documented
 * canonicalization — deliberately distinct from the ledger's construction-order
 * `hashRecord` — so any external verifier recomputes the same digest regardless
 * of key order. `undefined` members are dropped (they are not valid JSON); the
 * strict receipt schema never produces them.
 */
export function canonicalReceiptJson(value: unknown): string {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "string" || type === "boolean") return JSON.stringify(value);
  if (type === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot canonicalize a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalReceiptJson).join(",")}]`;
  if (type === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalReceiptJson(record[key])}`).join(",")}}`;
  }
  throw new Error(`Cannot canonicalize a value of type ${type}.`);
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** SHA-256 over the canonical serialization of the receipt body — the attested self-digest. */
export function receiptSelfDigest(body: ReceiptBody): string {
  return sha256Hex(canonicalReceiptJson(body));
}

/**
 * Per-section digests. Used only to localize which section changed when a
 * self-digest check fails — the root of trust is `receiptSelfDigest` over the
 * whole body plus the ledger anchor, so these are a diagnostic aid.
 */
export function receiptSectionDigests(body: ReceiptBody): Record<ReceiptSection, string> {
  const digests = {} as Record<ReceiptSection, string>;
  for (const section of RECEIPT_SECTIONS) {
    digests[section] = sha256Hex(canonicalReceiptJson(body[section]));
  }
  return digests;
}
