import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { ProjectIdSchema } from "../contracts/common";
import { redactDeep } from "./redaction";
import { safeJsonParse } from "./safe-json";
import { atomicAppendFile, atomicWriteFile } from "./atomic-write";

const MAX_LEDGER_EVENT_BYTES = 1_000_000;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 5;
const OWNERLESS_LOCK_STALE_MS = 30_000;
const MAX_CACHED_EVENTS = 1_000;
const MAX_CACHED_EVENT_IDS = 4_096;
const MAX_CACHED_EVENT_BYTES = 8 * 1024 * 1024;

export const LedgerIntegritySchema = z.object({
  algorithm: z.enum(["sha256", "hmac-sha256"]),
  keyId: z.string().max(128).nullable(),
}).strict();

export const LedgerRecordV2Schema = z.object({
  version: z.literal(2),
  sequence: z.number().int().positive(),
  timestamp: z.number().int().nonnegative(),
  projectId: ProjectIdSchema,
  principal: z.string().min(1).max(128),
  eventId: z.string().uuid(),
  previousHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  integrity: LedgerIntegritySchema,
  type: z.string().min(1).max(128),
  payload: z.record(z.unknown()),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type LedgerRecordV2 = z.infer<typeof LedgerRecordV2Schema>;

const MigrationManifestV2Schema = z.object({
  version: z.literal(2),
  state: z.enum(["importing", "completed"]),
  migrationId: z.string().regex(/^[a-f0-9]{64}$/),
  sourcePath: z.string().min(1).max(4_096),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceBytes: z.number().int().nonnegative(),
  sourceEvents: z.number().int().nonnegative(),
  importedEvents: z.number().int().nonnegative(),
  startSequence: z.number().int().nonnegative(),
  startHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  migrationEventId: z.string().uuid(),
  importedAt: z.number().int().nonnegative().nullable(),
  targetLedger: z.string().min(1).max(4_096),
}).strict().superRefine((manifest, context) => {
  if (manifest.importedEvents > manifest.sourceEvents) context.addIssue({ code: z.ZodIssueCode.custom, message: "Migration progress exceeds the verified source event count." });
  if (manifest.state === "completed" && (manifest.importedEvents !== manifest.sourceEvents || manifest.importedAt === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Completed migration manifest is incomplete." });
  }
});

type LedgerRecordWithoutHash = Omit<LedgerRecordV2, "hash">;

type LockOwner = {
  pid: number;
  processStart: string;
  host: string;
  nonce: string;
  acquiredAt: number;
};

type ReadCache = {
  offset: number;
  partial: string;
  lastSequence: number;
  lastHash: string | null;
  eventCount: number;
  cachedEventBytes: number;
  historyComplete: boolean;
  events: LedgerRecordV2[];
  seenEventIds: string[];
  prefixSha256: string | null;
};

export type LedgerV2Options = {
  ledgerPath: string;
  readModelPath: string;
  projectId: string;
  principal: string;
  /** Legacy single-key convenience. The derived key id is stable across restarts. */
  hmacKey?: string;
  /** Explicit active writer key. Use with `hmacKey` to give rotations a durable id. */
  hmacKeyId?: string;
  /** Verification keys for mixed historical HMAC records and key rotation. */
  hmacKeyring?: Readonly<Record<string, string>>;
  /** Selects the keyring entry used for new records. */
  activeHmacKeyId?: string;
};

export function ledgerIntegrityOptionsFromEnv(env: NodeJS.ProcessEnv = process.env) {
  let hmacKeyring: Record<string, string> | undefined;
  if (env.HEADLESS_LEDGER_KEYS) {
    hmacKeyring = z.record(z.string().min(16)).parse(safeJsonParse(env.HEADLESS_LEDGER_KEYS));
  }
  return {
    hmacKey: env.HEADLESS_LEDGER_KEY,
    hmacKeyId: env.HEADLESS_LEDGER_KEY_ID,
    hmacKeyring,
    activeHmacKeyId: env.HEADLESS_LEDGER_ACTIVE_KEY_ID,
  };
}

type LedgerIntegrityKeys = {
  active: { id: string; key: string } | null;
  keyring: ReadonlyMap<string, string>;
};

export class LedgerV2IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerV2IntegrityError";
  }
}

export class LedgerV2 {
  readonly ledgerPath: string;
  readonly readModelPath: string;
  readonly projectId: string;
  readonly principal: string;
  readonly hmacKey?: string;
  readonly hmacKeyId?: string;
  private readonly integrityKeys: LedgerIntegrityKeys;
  private cache: ReadCache;
  private fullEvents: LedgerRecordV2[] | null = null;
  /** Exact in-process index; the persisted read projection remains bounded. */
  private exactEventIndex: Map<string, LedgerRecordV2> | null = null;
  private persistedSequence = 0;
  private lastMtimeMs = 0;

  constructor(options: LedgerV2Options) {
    this.ledgerPath = options.ledgerPath;
    this.readModelPath = options.readModelPath;
    this.projectId = ProjectIdSchema.parse(options.projectId);
    this.principal = z.string().min(1).max(128).parse(options.principal);
    this.integrityKeys = ledgerIntegrityKeys(options);
    this.hmacKey = this.integrityKeys.active?.key;
    this.hmacKeyId = this.integrityKeys.active?.id;
    mkdirPrivate(dirname(this.ledgerPath));
    mkdirPrivate(dirname(this.readModelPath));
    // Persisted read models are bounded projections, never authority. Their
    // ledger-prefix digest is checked before their offset/head is trusted.
    const loaded = loadReadCache(this.readModelPath);
    this.cache = loaded && cachedPrefixMatches(this.ledgerPath, loaded, this.projectId, this.integrityKeys) ? loaded : emptyReadCache();
    this.persistedSequence = this.cache.lastSequence;
    this.refresh();
  }

  append(type: string, payload: Record<string, unknown>, eventId: string = randomUUID()) {
    return this.appendWithDisposition(type, payload, eventId).record;
  }

  appendWithDisposition(type: string, payload: Record<string, unknown>, eventId: string = randomUUID()) {
    const parsedEventId = z.string().uuid().parse(eventId);
    return withOwnedLock(`${this.ledgerPath}.lock`, () => {
      this.refresh();
      if (this.cache.partial.length > 0) {
        throw new LedgerV2IntegrityError(`Cannot append while ${this.ledgerPath} ends with an incomplete JSON line.`);
      }
      const existing = this.ensureExactEventIndex().get(parsedEventId);
      if (existing) return { record: existing, appended: false as const };

      const safePayload = redactDeep(payload).value;
      const integrity = writerIntegrity(this.ledgerPath, this.cache, this.integrityKeys);
      const withoutHash: LedgerRecordWithoutHash = {
        version: 2,
        sequence: this.cache.lastSequence + 1,
        timestamp: Date.now(),
        projectId: this.projectId,
        principal: this.principal,
        eventId: parsedEventId,
        previousHash: this.cache.lastHash,
        integrity,
        type: z.string().min(1).max(128).parse(type),
        payload: z.record(z.unknown()).parse(safePayload),
      };
      const record = LedgerRecordV2Schema.parse({
        ...withoutHash,
        hash: hashRecord(withoutHash, integrityKey(integrity, this.integrityKeys)),
      });
      const line = `${JSON.stringify(record)}\n`;
      if (Buffer.byteLength(line) > MAX_LEDGER_EVENT_BYTES) {
        throw new Error(`Ledger event exceeds ${MAX_LEDGER_EVENT_BYTES} bytes after redaction.`);
      }
      appendDurably(this.ledgerPath, line);
      this.refresh();
      return { record, appended: true as const };
    });
  }

  refresh() {
    const stat = fileStat(this.ledgerPath);
    const size = stat.size;
    if (size === this.cache.offset && this.lastMtimeMs !== 0 && stat.mtimeMs !== this.lastMtimeMs) {
      this.cache = emptyReadCache();
      this.fullEvents = null;
      this.exactEventIndex = null;
      this.persistedSequence = 0;
    }
    if (size < this.cache.offset) {
      this.cache = emptyReadCache();
      this.fullEvents = null;
      this.exactEventIndex = null;
      this.persistedSequence = 0;
    }
    if (size === this.cache.offset) {
      this.lastMtimeMs = stat.mtimeMs;
      return this.cache.events;
    }

    const before = cloneReadCache(this.cache);
    const beforeFullLength = this.fullEvents?.length ?? null;
    const exactIndexBefore = this.exactEventIndex;
    const exactIdsAdded: string[] = [];
    const previousMtimeMs = this.lastMtimeMs;
    const fd = openSync(this.ledgerPath, "r");
    try {
      const length = size - this.cache.offset;
      const bytes = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const count = readSync(fd, bytes, read, length - read, this.cache.offset + read);
        if (count === 0) break;
        read += count;
      }
      this.cache.offset += read;
      this.consume(`${this.cache.partial}${bytes.subarray(0, read).toString("utf8")}`, exactIdsAdded);
      this.lastMtimeMs = fileStat(this.ledgerPath).mtimeMs;
      if (shouldPersistCache(this.persistedSequence, this.cache.lastSequence)) {
        persistReadCache(this.readModelPath, this.ledgerPath, this.cache);
        this.persistedSequence = this.cache.lastSequence;
      }
      return this.cache.events;
    } catch (error) {
      // Verification is transactional. An invalid later line must not advance the
      // trusted offset past the corruption or retain a partially-updated chain.
      this.cache = before;
      if (beforeFullLength !== null && this.fullEvents) this.fullEvents.splice(beforeFullLength);
      if (exactIndexBefore === null) this.exactEventIndex = null;
      else for (const eventId of exactIdsAdded) exactIndexBefore.delete(eventId);
      this.lastMtimeMs = previousMtimeMs;
      throw error;
    } finally {
      closeSync(fd);
    }
  }

  readAll() {
    this.refresh();
    if (!this.fullEvents) {
      this.fullEvents = scanVerifiedLedger(this.ledgerPath, this.projectId, this.integrityKeys);
      this.exactEventIndex = new Map(this.fullEvents.map((record) => [record.eventId, record]));
    }
    return [...this.fullEvents];
  }

  readRecent(limit = 40) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError("Ledger read limit must be a non-negative safe integer.");
    const events = this.refresh();
    if (limit > events.length && this.cache.eventCount > events.length) {
      const all = this.readAll();
      return all.slice(Math.max(0, all.length - limit));
    }
    return events.slice(Math.max(0, events.length - limit));
  }

  snapshot() {
    this.refresh();
    return {
      offset: this.cache.offset,
      sequence: this.cache.lastSequence,
      headHash: this.cache.lastHash,
      partialLineBytes: Buffer.byteLength(this.cache.partial),
      eventCount: this.cache.eventCount,
    };
  }

  private consume(text: string, exactIdsAdded: string[] = []) {
    const lines = text.split("\n");
    this.cache.partial = lines.pop() ?? "";
    if (Buffer.byteLength(this.cache.partial) > MAX_LEDGER_EVENT_BYTES) {
      throw new LedgerV2IntegrityError(`Incomplete ledger line exceeds ${MAX_LEDGER_EVENT_BYTES} bytes.`);
    }
    const seen = this.ensureExactEventIndex();
    for (const line of lines) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > MAX_LEDGER_EVENT_BYTES) {
        throw new LedgerV2IntegrityError(`Ledger line exceeds ${MAX_LEDGER_EVENT_BYTES} bytes.`);
      }
      let record: LedgerRecordV2;
      try {
        record = LedgerRecordV2Schema.parse(safeJsonParse(line));
      } catch (error) {
        throw new LedgerV2IntegrityError(`Invalid v2 ledger record after sequence ${this.cache.lastSequence}: ${messageOf(error)}`);
      }
      verifyRecord(record, this.cache.lastSequence + 1, this.cache.lastHash, this.projectId, this.integrityKeys);
      this.cache.lastSequence = record.sequence;
      this.cache.lastHash = record.hash;
      if (seen.has(record.eventId)) continue;
      seen.set(record.eventId, record);
      exactIdsAdded.push(record.eventId);
      this.cache.seenEventIds.push(record.eventId);
      this.cache.events.push(record);
      this.cache.cachedEventBytes += Buffer.byteLength(JSON.stringify(record));
      this.cache.eventCount += 1;
      this.fullEvents?.push(record);
      while (this.cache.events.length > MAX_CACHED_EVENTS || this.cache.cachedEventBytes > MAX_CACHED_EVENT_BYTES) {
        const removed = this.cache.events.shift();
        if (!removed) break;
        this.cache.cachedEventBytes -= Buffer.byteLength(JSON.stringify(removed));
        this.cache.historyComplete = false;
      }
      if (this.cache.seenEventIds.length > MAX_CACHED_EVENT_IDS) {
        this.cache.seenEventIds.splice(0, this.cache.seenEventIds.length - MAX_CACHED_EVENT_IDS);
      }
    }
  }

  private ensureExactEventIndex() {
    if (this.exactEventIndex) return this.exactEventIndex;
    const index = scanVerifiedLedgerPrefixIndex(
      this.ledgerPath,
      this.projectId,
      this.integrityKeys,
      this.cache.lastSequence,
    );
    if (index.size !== this.cache.eventCount) {
      throw new LedgerV2IntegrityError(
        `Ledger event index mismatch at sequence ${this.cache.lastSequence}: expected ${this.cache.eventCount} unique events, got ${index.size}.`,
      );
    }
    this.exactEventIndex = index;
    return index;
  }
}

export function importV1Ledger(options: {
  sourcePath: string;
  target: LedgerV2;
  manifestPath: string;
  hmacKey?: string;
}) {
  if (!existsSync(options.sourcePath)) return null;
  const sourceText = readFileSync(options.sourcePath, "utf8");
  const sourceEvents = verifyV1Ledger(sourceText, options.sourcePath, options.hmacKey);
  const sourceHash = createHash("sha256").update(sourceText).digest("hex");
  const migrationId = createHash("sha256").update(`${options.sourcePath}\0${sourceHash}`).digest("hex");
  const existingManifest = existsSync(options.manifestPath) ? safeJsonParse<Record<string, unknown>>(readFileSync(options.manifestPath, "utf8")) : null;
  // A completed v0.2 manifest from the first implementation remains valid.
  if (existingManifest?.version === 1) return existingManifest;
  let manifest = existingManifest
    ? MigrationManifestV2Schema.parse(existingManifest)
    : createMigrationManifest(options, sourceText, sourceEvents.length, sourceHash, migrationId);
  if (manifest.sourcePath !== options.sourcePath || manifest.sourceSha256 !== sourceHash || manifest.targetLedger !== options.target.ledgerPath || manifest.migrationId !== migrationId) {
    throw new LedgerV2IntegrityError("Existing v1 migration manifest does not match the verified source and target ledger. Preserve both files and use an audited recovery tool.");
  }
  if (manifest.sourceEvents !== sourceEvents.length || manifest.sourceBytes !== Buffer.byteLength(sourceText)) {
    throw new LedgerV2IntegrityError("Verified v1 source dimensions changed during migration. Preserve the source and use an audited recovery tool.");
  }
  if (manifest.state === "completed") return manifest;

  manifest = reconcileMigrationProgress(manifest, options.target);
  writePrivateJson(options.manifestPath, manifest);
  for (let index = manifest.importedEvents; index < sourceEvents.length; index += 1) {
    const event = sourceEvents[index];
    const record = event as Record<string, unknown>;
    options.target.append("v1_import", {
      migrationId,
      sourceIndex: index,
      sourceSchema: "v1",
      sourceEventId: record.id ?? null,
      sourceSessionId: record.sessionId ?? null,
      sourceSequence: record.seq ?? null,
      event: record,
    }, migrationRecordId(migrationId, `event:${index}`));
    manifest = MigrationManifestV2Schema.parse({ ...manifest, importedEvents: index + 1 });
    writePrivateJson(options.manifestPath, manifest);
  }
  const current = options.target.readAll();
  if (!current.some((record) => record.eventId === manifest.migrationEventId)) {
    options.target.append("migration", {
      migrationId,
      from: "v1",
      sourcePath: options.sourcePath,
      sourceSha256: sourceHash,
      importedEvents: sourceEvents.length,
    }, manifest.migrationEventId);
  }
  manifest = MigrationManifestV2Schema.parse({ ...manifest, state: "completed", importedEvents: sourceEvents.length, importedAt: Date.now() });
  writePrivateJson(options.manifestPath, manifest);
  return manifest;
}

function createMigrationManifest(
  options: { sourcePath: string; target: LedgerV2; manifestPath: string },
  sourceText: string,
  sourceEvents: number,
  sourceSha256: string,
  migrationId: string,
) {
  const snapshot = options.target.snapshot();
  if (snapshot.sequence !== 0) {
    throw new LedgerV2IntegrityError(
      "A verified v1 ledger exists but the v2 target is non-empty and has no migration manifest. Refusing an ambiguous partial import; preserve both ledgers and use an audited recovery tool.",
    );
  }
  const manifest = MigrationManifestV2Schema.parse({
    version: 2,
    state: "importing",
    migrationId,
    sourcePath: options.sourcePath,
    sourceSha256,
    sourceBytes: Buffer.byteLength(sourceText),
    sourceEvents,
    importedEvents: 0,
    startSequence: snapshot.sequence,
    startHash: snapshot.headHash,
    migrationEventId: migrationRecordId(migrationId, "complete"),
    importedAt: null,
    targetLedger: options.target.ledgerPath,
  });
  // This durable intent precedes the first target append. A restart can always
  // distinguish a fresh import from a partially applied one.
  writePrivateJson(options.manifestPath, manifest);
  return manifest;
}

function reconcileMigrationProgress(manifest: z.infer<typeof MigrationManifestV2Schema>, target: LedgerV2) {
  const records = target.readAll().filter((record) => record.sequence > manifest.startSequence);
  let importedEvents = 0;
  let completionSeen = false;
  for (const record of records) {
    const expectedEventId = migrationRecordId(manifest.migrationId, `event:${importedEvents}`);
    if (record.eventId === expectedEventId && record.type === "v1_import") {
      const payload = record.payload;
      if (payload.migrationId !== manifest.migrationId || payload.sourceIndex !== importedEvents) {
        throw new LedgerV2IntegrityError("Partial v1 import marker does not match its deterministic source index.");
      }
      importedEvents += 1;
      continue;
    }
    if (record.eventId === manifest.migrationEventId && record.type === "migration" && importedEvents === manifest.sourceEvents) {
      completionSeen = true;
      continue;
    }
    throw new LedgerV2IntegrityError("Unexpected v2 ledger activity intersects an unfinished v1 migration. Preserve both ledgers and use an audited recovery tool.");
  }
  if (importedEvents > manifest.sourceEvents) throw new LedgerV2IntegrityError("Partial v1 import contains more records than the verified source.");
  if (completionSeen) {
    return MigrationManifestV2Schema.parse({ ...manifest, state: "completed", importedEvents, importedAt: manifest.importedAt ?? Date.now() });
  }
  return MigrationManifestV2Schema.parse({ ...manifest, importedEvents });
}

function migrationRecordId(migrationId: string, suffix: string) {
  const hex = createHash("sha256").update(`${migrationId}\0${suffix}`).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = "8";
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function verifyV1Ledger(text: string, sourcePath: string, hmacKey?: string) {
  const events: unknown[] = [];
  let previousHash: string | null = null;
  let sequence = 0;
  let lineNumber = 0;
  for (const line of text.split("\n")) {
    lineNumber += 1;
    if (!line.trim()) continue;
    let value: Record<string, unknown>;
    try {
      value = z.record(z.unknown()).parse(safeJsonParse(line));
    } catch (error) {
      throw migrationFailure(sourcePath, lineNumber, `invalid JSON: ${messageOf(error)}`);
    }
    sequence += 1;
    if (value.seq !== sequence || value.prevHash !== previousHash || typeof value.hash !== "string") {
      throw migrationFailure(sourcePath, lineNumber, "sequence or previous hash mismatch");
    }
    const { hash, ...withoutHash } = value;
    const expected = hmacKey
      ? createHmac("sha256", hmacKey).update(JSON.stringify(withoutHash)).digest("hex")
      : createHash("sha256").update(JSON.stringify(withoutHash)).digest("hex");
    if (hash !== expected) throw migrationFailure(sourcePath, lineNumber, "hash verification failed");
    previousHash = hash;
    events.push(value);
  }
  return events;
}

export function cleanupOwnedLedgerLock(lockPath: string) {
  const owner = readLockOwner(lockPath);
  if (!owner || owner.pid !== process.pid || owner.processStart !== currentProcessStart()) return false;
  rmSync(lockPath, { recursive: true, force: true });
  return true;
}

/**
 * Explicit recovery for a crash-truncated final append. This never repairs a
 * malformed complete record or a broken verified prefix. The caller must have
 * already enforced administrator authority.
 */
export function repairLedgerPartialTail(options: LedgerV2Options & { backupPath?: string }) {
  const repair = withOwnedLock(`${options.ledgerPath}.lock`, () => {
    if (!existsSync(options.ledgerPath)) throw new LedgerV2IntegrityError("Ledger does not exist; there is no partial tail to repair.");
    const bytes = readFileSync(options.ledgerPath);
    const lastNewline = bytes.lastIndexOf(0x0a);
    const completeBytes = lastNewline < 0 ? Buffer.alloc(0) : bytes.subarray(0, lastNewline + 1);
    const trailingBytes = bytes.length - completeBytes.length;
    if (trailingBytes === 0) throw new LedgerV2IntegrityError("Ledger has no partial trailing bytes to repair.");

    const keys = ledgerIntegrityKeys(options);
    scanVerifiedLedgerText(completeBytes.toString("utf8"), options.projectId, keys);
    const backupPath = options.backupPath ?? `${options.ledgerPath}.partial-tail-${Date.now()}.bak`;
    if (existsSync(backupPath)) throw new LedgerV2IntegrityError(`Ledger repair backup already exists: ${backupPath}`);
    atomicWriteFile(backupPath, bytes, { mode: 0o600 });

    atomicWriteFile(options.ledgerPath, completeBytes, { mode: 0o600 });
    rmSync(options.readModelPath, { force: true });
    return {
      backupPath,
      truncatedBytes: trailingBytes,
      truncatedSha256: createHash("sha256").update(bytes.subarray(completeBytes.length)).digest("hex"),
    };
  });
  const ledger = new LedgerV2(options);
  const recovery = ledger.append("ledger_tail_repaired", {
    backupPath: repair.backupPath,
    truncatedBytes: repair.truncatedBytes,
    truncatedSha256: repair.truncatedSha256,
    verifiedPrefixSequence: ledger.snapshot().sequence,
    repairedAt: Date.now(),
  });
  return { backupPath: repair.backupPath, truncatedBytes: repair.truncatedBytes, recovery };
}

function scanVerifiedLedgerText(text: string, projectId: string, keys: LedgerIntegrityKeys) {
  let sequence = 0;
  let previousHash: string | null = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > MAX_LEDGER_EVENT_BYTES) {
      throw new LedgerV2IntegrityError(`Ledger line exceeds ${MAX_LEDGER_EVENT_BYTES} bytes.`);
    }
    let record: LedgerRecordV2;
    try {
      record = LedgerRecordV2Schema.parse(safeJsonParse(line));
    } catch (error) {
      throw new LedgerV2IntegrityError(`Invalid v2 ledger record after sequence ${sequence}: ${messageOf(error)}`);
    }
    verifyRecord(record, sequence + 1, previousHash, projectId, keys);
    sequence = record.sequence;
    previousHash = record.hash;
  }
  return sequence;
}

function verifyRecord(
  record: LedgerRecordV2,
  expectedSequence: number,
  expectedPreviousHash: string | null,
  projectId: string,
  keys: LedgerIntegrityKeys,
) {
  if (record.sequence !== expectedSequence) throw new LedgerV2IntegrityError(`Expected sequence ${expectedSequence}, got ${record.sequence}.`);
  if (record.previousHash !== expectedPreviousHash) throw new LedgerV2IntegrityError(`Previous hash mismatch at sequence ${record.sequence}.`);
  if (record.projectId !== projectId) throw new LedgerV2IntegrityError(`Project ID mismatch at sequence ${record.sequence}.`);
  const { hash, ...withoutHash } = record;
  const key = integrityKey(record.integrity, keys, record.sequence);
  if (hash !== hashRecord(withoutHash, key)) throw new LedgerV2IntegrityError(`Hash mismatch at sequence ${record.sequence}.`);
}

function hashRecord(record: LedgerRecordWithoutHash, hmacKey?: string) {
  const body = JSON.stringify(record);
  return hmacKey
    ? createHmac("sha256", hmacKey).update(body).digest("hex")
    : createHash("sha256").update(body).digest("hex");
}

function integrityMetadata(active: LedgerIntegrityKeys["active"]) {
  return active
    ? { algorithm: "hmac-sha256" as const, keyId: active.id }
    : { algorithm: "sha256" as const, keyId: null };
}

function writerIntegrity(ledgerPath: string, cache: ReadCache, keys: LedgerIntegrityKeys) {
  const integrity = integrityMetadata(keys.active);
  if (cache.lastSequence === 0) return integrity;
  const tail = readCachedPrefixTail(ledgerPath, cache.offset, Buffer.byteLength(cache.partial));
  if (tail?.integrity?.algorithm === "hmac-sha256" && !keys.active) {
    throw new LedgerV2IntegrityError(
      `Refusing to append an unsigned SHA record after HMAC sequence ${tail.sequence}; configure an active HMAC key.`,
    );
  }
  return integrity;
}

function integrityKey(
  integrity: LedgerRecordV2["integrity"],
  keys: LedgerIntegrityKeys,
  sequence?: number,
) {
  if (integrity.algorithm === "sha256") {
    if (integrity.keyId !== null) {
      throw new LedgerV2IntegrityError(`SHA record${sequence ? ` at sequence ${sequence}` : ""} must not declare a key id.`);
    }
    return undefined;
  }
  if (!integrity.keyId) {
    throw new LedgerV2IntegrityError(`HMAC record${sequence ? ` at sequence ${sequence}` : ""} is missing its key id.`);
  }
  const key = keys.keyring.get(integrity.keyId);
  if (!key) {
    throw new LedgerV2IntegrityError(
      `HMAC record${sequence ? ` at sequence ${sequence}` : ""} declares unknown key id ${integrity.keyId}.`,
    );
  }
  return key;
}

function ledgerIntegrityKeys(options: Pick<LedgerV2Options, "hmacKey" | "hmacKeyId" | "hmacKeyring" | "activeHmacKeyId">): LedgerIntegrityKeys {
  const keyring = new Map<string, string>();
  for (const [id, key] of Object.entries(options.hmacKeyring ?? {})) {
    keyring.set(ledgerKeyId(id), ledgerKey(key));
  }
  if (options.hmacKey) {
    const id = ledgerKeyId(options.hmacKeyId ?? createHash("sha256").update(options.hmacKey).digest("hex").slice(0, 16));
    const key = ledgerKey(options.hmacKey);
    const existing = keyring.get(id);
    if (existing && existing !== key) throw new TypeError(`Ledger key id ${id} resolves to multiple keys.`);
    keyring.set(id, key);
  }
  const activeId = options.activeHmacKeyId ?? (options.hmacKey ? options.hmacKeyId ?? createHash("sha256").update(options.hmacKey).digest("hex").slice(0, 16) : undefined);
  if (!activeId) return { active: null, keyring };
  const id = ledgerKeyId(activeId);
  const key = keyring.get(id);
  if (!key) throw new TypeError(`Active ledger HMAC key id ${id} is absent from the keyring.`);
  return { active: { id, key }, keyring };
}

function ledgerKeyId(value: string) {
  return z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).parse(value);
}

function ledgerKey(value: string) {
  if (Buffer.byteLength(value) < 16) throw new TypeError("Ledger HMAC keys must contain at least 16 bytes.");
  return value;
}

function withOwnedLock<T>(lockPath: string, operation: () => T) {
  const started = Date.now();
  const owner: LockOwner = {
    pid: process.pid,
    processStart: currentProcessStart(),
    host: hostname(),
    nonce: randomUUID(),
    acquiredAt: Date.now(),
  };
  while (true) {
    if (acquireOwnedLock(lockPath, owner)) break;
    cleanupAbandonedLedgerLock(lockPath);
    if (Date.now() - started >= LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for ledger lock: ${lockPath}`);
    sleepSync(LOCK_RETRY_MS);
  }
  try {
    return operation();
  } finally {
    releaseOwnedLock(lockPath, owner);
  }
}

function acquireOwnedLock(lockPath: string, owner: LockOwner) {
  try {
    mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return false;
    throw error;
  }
  try {
    writeFileSync(join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: "wx" });
    return true;
  } catch (error) {
    rmSync(lockPath, { recursive: true, force: true });
    throw error;
  }
}

function releaseOwnedLock(lockPath: string, expected: LockOwner) {
  const actual = readLockOwner(lockPath);
  if (!actual || actual.nonce !== expected.nonce || actual.processStart !== expected.processStart || actual.pid !== expected.pid) return;
  rmSync(lockPath, { recursive: true, force: true });
}

export function cleanupAbandonedLedgerLock(lockPath: string) {
  if (!existsSync(lockPath)) return false;
  const owner = readLockOwner(lockPath);
  if (owner) {
    // A foreign host's PID namespace and process-start identity cannot be
    // verified locally. Fail closed instead of stealing a potentially-live
    // shared-volume lock.
    if (owner.host !== hostname()) return false;
    if (processMatches(owner.pid, owner.processStart)) return false;
    rmSync(lockPath, { recursive: true, force: true });
    return true;
  }
  let age: number;
  try {
    age = Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return false;
  }
  if (age < OWNERLESS_LOCK_STALE_MS) return false;
  rmSync(lockPath, { recursive: true, force: true });
  return true;
}

function readLockOwner(lockPath: string): LockOwner | null {
  try {
    return z.object({
      pid: z.number().int().positive(),
      processStart: z.string().min(1),
      host: z.string().min(1),
      nonce: z.string().uuid(),
      acquiredAt: z.number().int().nonnegative(),
    }).strict().parse(safeJsonParse(readFileSync(join(lockPath, "owner.json"), "utf8")));
  } catch {
    return null;
  }
}

function processMatches(pid: number, expectedStart: string) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return getProcessStartIdentity(pid) === expectedStart;
}

function currentProcessStart() {
  return getProcessStartIdentity(process.pid);
}

export function getProcessStartIdentity(pid = process.pid) {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return `linux:${tail[19]}`;
    } catch {
      // /proc is optional (and absent on macOS/locked-down Linux). The bounded
      // `ps` identity fallback below still prevents PID-only lock stealing.
    }
  }
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 1_000 });
  const value = result.status === 0 ? result.stdout.trim() : "";
  return value ? `${process.platform}:${value}` : `${process.platform}:pid:${pid}`;
}

function emptyReadCache(): ReadCache {
  return {
    offset: 0,
    partial: "",
    lastSequence: 0,
    lastHash: null,
    eventCount: 0,
    cachedEventBytes: 0,
    historyComplete: true,
    events: [],
    seenEventIds: [],
    prefixSha256: null,
  };
}

function cloneReadCache(cache: ReadCache): ReadCache {
  return {
    offset: cache.offset,
    partial: cache.partial,
    lastSequence: cache.lastSequence,
    lastHash: cache.lastHash,
    eventCount: cache.eventCount,
    cachedEventBytes: cache.cachedEventBytes,
    historyComplete: cache.historyComplete,
    events: [...cache.events],
    seenEventIds: [...cache.seenEventIds],
    prefixSha256: cache.prefixSha256,
  };
}

function loadReadCache(path: string): ReadCache {
  if (!existsSync(path)) return emptyReadCache();
  try {
    return z.object({
      offset: z.number().int().nonnegative(),
      partial: z.string(),
      lastSequence: z.number().int().nonnegative(),
      lastHash: z.string().nullable(),
      eventCount: z.number().int().nonnegative(),
      cachedEventBytes: z.number().int().nonnegative().max(MAX_CACHED_EVENT_BYTES),
      historyComplete: z.boolean(),
      events: z.array(LedgerRecordV2Schema).max(MAX_CACHED_EVENTS),
      seenEventIds: z.array(z.string().uuid()).max(MAX_CACHED_EVENT_IDS),
      prefixSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    }).strict().parse(safeJsonParse(readFileSync(path, "utf8")));
  } catch {
    return emptyReadCache();
  }
}

function persistReadCache(path: string, ledgerPath: string, cache: ReadCache) {
  writePrivateJson(path, {
    ...cache,
    prefixSha256: hashFilePrefix(ledgerPath, cache.offset),
  });
}

function shouldPersistCache(previousSequence: number, nextSequence: number) {
  if (nextSequence <= previousSequence) return false;
  if (previousSequence === 0) return true;
  // Geometric checkpoints keep total projection bytes written across N
  // appends O(N), instead of rewriting an ever-growing JSON projection N
  // times. A later opener incrementally consumes the bounded tail after the
  // last checkpoint.
  return nextSequence >= previousSequence * 2;
}

function cachedPrefixMatches(ledgerPath: string, cache: ReadCache, projectId: string, keys: LedgerIntegrityKeys) {
  if (cache.offset === 0) {
    return cache.lastSequence === 0
      && cache.lastHash === null
      && cache.eventCount === 0
      && cache.events.length === 0;
  }
  const stat = fileStat(ledgerPath);
  if (cache.offset > stat.size || !cache.prefixSha256) return false;
  if (hashFilePrefix(ledgerPath, cache.offset) !== cache.prefixSha256) return false;
  if (cache.eventCount < cache.events.length) return false;
  if (cache.eventCount > cache.lastSequence) return false;
  if (cache.lastSequence > 0 && cache.events.length === 0) return false;
  if (cache.cachedEventBytes !== cache.events.reduce((total, record) => total + Buffer.byteLength(JSON.stringify(record)), 0)) return false;
  if (cache.historyComplete && cache.eventCount !== cache.events.length) return false;
  const seen = new Set(cache.seenEventIds);
  if (cache.events.some((record) => !seen.has(record.eventId))) return false;
  try {
    for (const record of cache.events) {
      if (record.projectId !== projectId) return false;
      const { hash, ...withoutHash } = record;
      if (hash !== hashRecord(withoutHash, integrityKey(record.integrity, keys, record.sequence))) return false;
    }
    const tail = readCachedPrefixTail(ledgerPath, cache.offset, Buffer.byteLength(cache.partial));
    if (!tail) return false;
    return tail.sequence === cache.lastSequence && tail.hash === cache.lastHash;
  } catch {
    return false;
  }
}

function readCachedPrefixTail(path: string, offset: number, partialBytes: number) {
  const completeEnd = offset - partialBytes;
  if (completeEnd <= 0) return { sequence: 0, hash: null as string | null };
  const length = Math.min(completeEnd, MAX_LEDGER_EVENT_BYTES + 2);
  const start = completeEnd - length;
  const fd = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(length);
    const read = readSync(fd, bytes, 0, length, start);
    const text = bytes.subarray(0, read).toString("utf8").replace(/\n+$/, "");
    const line = text.slice(text.lastIndexOf("\n") + 1);
    const record = LedgerRecordV2Schema.parse(safeJsonParse(line));
    return { sequence: record.sequence, hash: record.hash, integrity: record.integrity };
  } finally {
    closeSync(fd);
  }
}

function hashFilePrefix(path: string, length: number) {
  const hash = createHash("sha256");
  if (length === 0) return hash.digest("hex");
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(64 * 1024, length));
    let offset = 0;
    while (offset < length) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, length - offset), offset);
      if (count === 0) throw new Error("Ledger prefix ended before the persisted read offset.");
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

function scanVerifiedLedger(path: string, projectId: string, keys: LedgerIntegrityKeys) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  lines.pop(); // A partial final line is buffered by refresh and is not visible.
  let sequence = 0;
  let previousHash: string | null = null;
  const seen = new Set<string>();
  const events: LedgerRecordV2[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > MAX_LEDGER_EVENT_BYTES) {
      throw new LedgerV2IntegrityError(`Ledger line exceeds ${MAX_LEDGER_EVENT_BYTES} bytes.`);
    }
    let record: LedgerRecordV2;
    try {
      record = LedgerRecordV2Schema.parse(safeJsonParse(line));
    } catch (error) {
      throw new LedgerV2IntegrityError(`Invalid v2 ledger record after sequence ${sequence}: ${messageOf(error)}`);
    }
    verifyRecord(record, sequence + 1, previousHash, projectId, keys);
    sequence = record.sequence;
    previousHash = record.hash;
    if (seen.has(record.eventId)) continue;
    seen.add(record.eventId);
    events.push(record);
  }
  return events;
}

function scanVerifiedLedgerPrefixIndex(
  path: string,
  projectId: string,
  keys: LedgerIntegrityKeys,
  expectedSequence: number,
) {
  const index = new Map<string, LedgerRecordV2>();
  if (expectedSequence === 0) return index;
  if (!existsSync(path)) throw new LedgerV2IntegrityError(`Ledger ended before sequence ${expectedSequence}.`);
  const lines = readFileSync(path, "utf8").split("\n");
  let sequence = 0;
  let previousHash: string | null = null;
  for (const line of lines) {
    if (sequence === expectedSequence) break;
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > MAX_LEDGER_EVENT_BYTES) {
      throw new LedgerV2IntegrityError(`Ledger line exceeds ${MAX_LEDGER_EVENT_BYTES} bytes.`);
    }
    let record: LedgerRecordV2;
    try {
      record = LedgerRecordV2Schema.parse(safeJsonParse(line));
    } catch (error) {
      throw new LedgerV2IntegrityError(`Invalid v2 ledger record after sequence ${sequence}: ${messageOf(error)}`);
    }
    verifyRecord(record, sequence + 1, previousHash, projectId, keys);
    sequence = record.sequence;
    previousHash = record.hash;
    if (!index.has(record.eventId)) index.set(record.eventId, record);
  }
  if (sequence !== expectedSequence) {
    throw new LedgerV2IntegrityError(`Ledger ended at sequence ${sequence}, before indexed prefix ${expectedSequence}.`);
  }
  return index;
}

function writePrivateJson(path: string, value: unknown) {
  mkdirPrivate(dirname(path));
  atomicWriteFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function appendDurably(path: string, text: string) {
  mkdirPrivate(dirname(path));
  atomicAppendFile(path, text, { mode: 0o600 });
}

function mkdirPrivate(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function fileSize(path: string) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function fileStat(path: string) {
  try {
    const stat = statSync(path);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return { size: 0, mtimeMs: 0 };
  }
}

function migrationFailure(path: string, line: number, reason: string) {
  return new LedgerV2IntegrityError(
    `Refusing to import the v1 ledger because verification failed at ${path}:${line}: ${reason}. ` +
    "Preserve the original file, restore it from a trusted backup or repair it with an audited recovery tool, then retry.",
  );
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
