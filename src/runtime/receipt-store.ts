import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decodePersistedReceipt, type Receipt } from "../contracts/receipt";
import { atomicWriteFile } from "./atomic-write";
import { ensureOwnerOnlyDirectory, ensureOwnerOnlyFile } from "./project-state";
import { safeJsonParse } from "./safe-json";

const DEFAULT_LIST_LIMIT = 1_000;
const MAX_LIST_LIMIT = 10_000;

/**
 * One owner-only, atomically replaced file per run keeps Receipt durability
 * independent from the bounded RunEventStore and its compaction lifecycle.
 */
export class ReceiptStore {
  readonly directory: string;

  constructor(receiptsDir: string) {
    this.directory = ensureOwnerOnlyDirectory(receiptsDir);
  }

  put(receipt: Receipt): void {
    const parsed = decodePersistedReceipt(receipt);
    const path = this.path(parsed.body.runId);
    atomicWriteFile(path, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
    ensureOwnerOnlyFile(path);
  }

  get(runId: string): Receipt | null {
    const path = this.path(runId);
    if (!existsSync(path)) return null;
    return readReceipt(path);
  }

  /**
   * Receipt ids are not file keys in v1, so this intentionally scans the
   * bounded directory listing. A future index can replace the O(n) scan
   * without changing the persisted per-run file contract.
   */
  getByReceiptId(receiptId: string): Receipt | null {
    const expected = boundedIdentifier(receiptId, "receipt");
    return readAvailableReceipts(this.directory).find((receipt) => receipt.body.receiptId === expected) ?? null;
  }

  list(opts: { limit?: number } = {}): Receipt[] {
    const limit = boundedLimit(opts.limit);
    return readAvailableReceipts(this.directory)
      .sort((left, right) => (
        right.body.provenance.endedAt.localeCompare(left.body.provenance.endedAt)
        || left.body.runId.localeCompare(right.body.runId)
      ))
      .slice(0, limit);
  }

  private path(runId: string) {
    return join(this.directory, `${safeFileId(runId, "run")}.receipt.json`);
  }
}

function readReceipt(path: string) {
  ensureOwnerOnlyFile(path);
  return decodePersistedReceipt(safeJsonParse(readFileSync(path, "utf8")));
}

function readAvailableReceipts(directory: string) {
  const receipts: Receipt[] = [];
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".receipt.json")) continue;
    try {
      receipts.push(readReceipt(join(directory, name)));
    } catch {
      // One malformed, unreadable, or non-regular record must not hide the
      // remaining durable receipts from an auditor.
    }
  }
  return receipts;
}

function boundedLimit(value: number | undefined) {
  if (value === undefined) return DEFAULT_LIST_LIMIT;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_LIST_LIMIT) {
    throw new TypeError(`Receipt list limit must be an integer between 1 and ${MAX_LIST_LIMIT}.`);
  }
  return value;
}

function boundedIdentifier(value: string, kind: string) {
  if (typeof value !== "string" || value.length < 1 || value.length > 160 || value.trim() !== value) {
    throw new Error(`Invalid ${kind} id.`);
  }
  return value;
}

function safeFileId(value: string, kind: string) {
  const id = boundedIdentifier(value, kind);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`Invalid ${kind} id.`);
  return id;
}
