import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { IdentifierSchema } from "../contracts/common";
import { RunEventSchema, type RunEvent, type RunResult } from "../contracts/run";
import {
  buildRunEvent,
  DEFAULT_MAX_RUN_EVENT_BYTES,
  type RunEventBuilderOptions,
  type RunEventInput,
} from "../runtime/run-event";
import { readOwnerOnlyJson, writeOwnerOnlyJson } from "../runtime/owner-json";
import { ensureOwnerOnlyDirectory, ensureOwnerOnlyFile } from "../runtime/project-state";
import { HeadlessError } from "../runtime/headless-error";
import { atomicAppendFile } from "../runtime/atomic-write";
import { decodePersistedRunEvent } from "../runtime/persisted-run-result";

export const DEFAULT_MAX_RUN_EVENT_STORE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_RETAINED_RUN_EVENTS = 4_000;
export const DEFAULT_PROTECTED_RUN_EVENT_SEGMENT_BYTES = 1024 * 1024;

const SafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const RunEventRecordSchema = z.object({
  cursor: SafeIntegerSchema.positive(),
  event: RunEventSchema,
}).strict();

const PersistedRunEventRecordSchema = z.object({
  cursor: SafeIntegerSchema.positive(),
  event: z.record(z.unknown()),
}).strict().transform((record) => RunEventRecordSchema.parse({
  ...record,
  event: decodePersistedRunEvent(record.event),
}));

const ProtectedRunEventRecordSchema = z.object({
  version: z.literal(1),
  cursor: SafeIntegerSchema.positive(),
  event: RunEventSchema,
  previousHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const PersistedProtectedRunEventRecordSchema = ProtectedRunEventRecordSchema.extend({
  event: z.record(z.unknown()),
});

type ProtectedRunEventRecord = z.infer<typeof ProtectedRunEventRecordSchema>;

const StreamStateSchema = z.object({
  nextSequence: SafeIntegerSchema,
  lastCursor: SafeIntegerSchema.positive(),
}).strict();

const RunEventStoreStateSchema = z.object({
  version: z.literal(2),
  nextCursor: SafeIntegerSchema.positive(),
  streams: z.record(StreamStateSchema),
  records: z.array(RunEventRecordSchema),
}).strict();

const PersistedRunEventStoreStateSchema = RunEventStoreStateSchema.extend({
  records: z.array(PersistedRunEventRecordSchema),
});

export type RunEventRecord = z.infer<typeof RunEventRecordSchema>;
export type RunEventSnapshot = {
  events: RunEvent[];
  nextCursor: number;
  latestCursor: number;
  oldestCursor: number | null;
  cursorExpired: boolean;
  hasMore: boolean;
};

export type RunEventSnapshotOptions = {
  jobId?: string;
  /** `null` filters for events without a session; `undefined` disables the filter. */
  sessionId?: string | null;
  afterCursor?: number;
  limit?: number;
};

export type RunEventWaitOptions = RunEventSnapshotOptions & {
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type RunEventStoreOptions = RunEventBuilderOptions & {
  maxStoreBytes?: number;
  maxEvents?: number;
  maxStreams?: number;
  now?: () => number;
  /** Disable until the daemon has won the canonical project socket. */
  compactOnOpen?: boolean;
  /** Byte bound for each append-only protected-event archive segment. */
  maxProtectedSegmentBytes?: number;
};

/** Durable, redacted event retention for the single project daemon. */
export class RunEventStore {
  private readonly emitter = new EventEmitter();
  private readonly maxStoreBytes: number;
  private readonly maxEvents: number;
  private readonly maxStreams: number;
  private readonly builder: RunEventBuilderOptions;
  private readonly now: () => number;
  private readonly protectedArchive: ProtectedRunEventArchive;
  private protectedArchiveFailure: Error | null = null;
  private state: z.infer<typeof RunEventStoreStateSchema>;

  constructor(private readonly path: string, options: RunEventStoreOptions = {}) {
    const maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_RUN_EVENT_BYTES;
    this.maxStoreBytes = checkedInteger(
      options.maxStoreBytes ?? DEFAULT_MAX_RUN_EVENT_STORE_BYTES,
      maxEventBytes + 32 * 1024,
      32 * 1024 * 1024,
      "Run event store byte limit",
    );
    this.maxEvents = checkedInteger(options.maxEvents ?? DEFAULT_MAX_RETAINED_RUN_EVENTS, 1, 100_000, "Run event retention limit");
    this.maxStreams = checkedInteger(options.maxStreams ?? Math.max(4_096, this.maxEvents), this.maxEvents, 100_000, "Run event stream limit");
    this.builder = { createId: options.createId, maxEventBytes, redact: options.redact };
    this.now = options.now ?? Date.now;
    this.emitter.setMaxListeners(256);
    ensureOwnerOnlyDirectory(dirname(path));
    const existing = readOwnerOnlyJson(path, PersistedRunEventStoreStateSchema);
    this.state = validateState(existing ?? emptyState());
    this.protectedArchive = new ProtectedRunEventArchive(
      `${path}.protected`,
      checkedInteger(
        options.maxProtectedSegmentBytes ?? DEFAULT_PROTECTED_RUN_EVENT_SEGMENT_BYTES,
        maxEventBytes + 16_384,
        16 * 1024 * 1024,
        "Protected run event segment byte limit",
      ),
      this.state.records.filter((record) => isProtectedEvent(record.event)),
      this.state.nextCursor,
    );
    if (options.compactOnOpen ?? true) {
      const compacted = this.compact(structuredClone(this.state));
      if (stateJson(compacted) !== stateJson(this.state)) {
        this.persist(compacted);
        this.state = compacted;
      }
    }
  }

  append(context: { jobId: string; sessionId?: string | null }, input: RunEventInput): RunEventRecord {
    return this.appendTrusted(context, input);
  }

  reconcileTerminal(
    context: { jobId: string; sessionId?: string | null },
    result: RunResult,
    timestamp = this.now(),
  ) {
    const events = [
      { id: terminalEventId(context.jobId, "lifecycle"), input: { kind: "lifecycle", state: result.status } as RunEventInput },
      { id: terminalEventId(context.jobId, "completion"), input: { kind: "completion", result } as RunEventInput },
    ];
    const records: RunEventRecord[] = [];
    for (const event of events) {
      if (this.hasEventId(event.id)) continue;
      records.push(this.appendTrusted(context, event.input, { eventId: event.id, timestamp }));
    }
    return records;
  }

  private appendTrusted(
    context: { jobId: string; sessionId?: string | null },
    input: RunEventInput,
    envelope: { eventId?: string; timestamp?: number } = {},
  ): RunEventRecord {
    if (this.protectedArchiveFailure) {
      throw new HeadlessError("INTERNAL_ERROR", `Protected run event archive is unavailable: ${this.protectedArchiveFailure.message}`);
    }
    const jobId = IdentifierSchema.parse(context.jobId);
    const sessionId = context.sessionId === undefined || context.sessionId === null
      ? null
      : IdentifierSchema.parse(context.sessionId);
    if (this.state.nextCursor >= Number.MAX_SAFE_INTEGER) throw new Error("Run event cursor space is exhausted.");
    const streamKey = JSON.stringify([jobId, sessionId]);
    const prior = this.state.streams[streamKey];
    const sequence = prior?.nextSequence ?? 0;
    if (sequence >= Number.MAX_SAFE_INTEGER) throw new Error("Run event sequence space is exhausted.");
    const cursor = this.state.nextCursor;
    const event = buildRunEvent(
      {
        jobId,
        sessionId,
        sequence,
        timestamp: checkedTimestamp(envelope.timestamp ?? this.now()),
        eventId: envelope.eventId,
      },
      input,
      this.builder,
    );
    const record = RunEventRecordSchema.parse({ cursor, event });
    const next = this.compact({
      version: 2,
      nextCursor: cursor + 1,
      streams: { ...this.state.streams, [streamKey]: { nextSequence: sequence + 1, lastCursor: cursor } },
      records: [...this.state.records, record],
    });
    if (!next.records.some((entry) => entry.cursor === cursor)) {
      throw new HeadlessError("OUTPUT_OVERFLOW", "Run event could not fit within durable retention.");
    }
    this.persist(next);
    this.state = next;
    if (isProtectedEvent(record.event)) {
      try {
        this.protectedArchive.append(record);
      } catch (error) {
        this.protectedArchiveFailure = error instanceof Error ? error : new Error(String(error));
        throw new HeadlessError("INTERNAL_ERROR", `Protected run event archival failed: ${this.protectedArchiveFailure.message}`, {
          cause: error,
        });
      }
    }
    this.emitter.emit("append", record);
    return record;
  }

  private hasEventId(eventId: string) {
    return this.state.records.some((record) => record.event.eventId === eventId)
      || this.protectedArchive.hasEventId(eventId);
  }

  /** Bounded evidence access; ordinary subscribers continue using snapshot(). */
  protectedSnapshot(options: { afterCursor?: number; limit?: number } = {}) {
    const afterCursor = checkedInteger(options.afterCursor ?? 0, 0, Number.MAX_SAFE_INTEGER, "Protected event cursor");
    const limit = checkedInteger(options.limit ?? 200, 1, 1_000, "Protected event snapshot limit");
    return this.protectedArchive.snapshot(afterCursor, limit);
  }

  snapshot(options: RunEventSnapshotOptions = {}): RunEventSnapshot {
    const filter = validatedSnapshotOptions(options);
    const latestCursor = this.state.nextCursor - 1;
    const oldestCursor = this.state.records[0]?.cursor ?? null;
    const requestedCursor = Math.min(filter.afterCursor ?? 0, latestCursor);
    const cursorExpired = filter.afterCursor !== undefined
      && oldestCursor !== null
      && filter.afterCursor < oldestCursor - 1;
    let nextCursor = requestedCursor;
    const events: RunEvent[] = [];
    let stoppedAtLimit = false;

    for (const record of this.state.records) {
      if (record.cursor <= requestedCursor) continue;
      nextCursor = record.cursor;
      if (!matches(record.event, filter)) continue;
      events.push(record.event);
      if (events.length >= filter.limit) {
        stoppedAtLimit = true;
        break;
      }
    }
    if (!stoppedAtLimit) nextCursor = latestCursor;
    const hasMore = stoppedAtLimit && this.state.records.some((record) => record.cursor > nextCursor && matches(record.event, filter));
    return { events, nextCursor, latestCursor, oldestCursor, cursorExpired, hasMore };
  }

  waitForSnapshot(options: RunEventWaitOptions = {}) {
    const timeoutMs = checkedInteger(options.timeoutMs ?? 30_000, 1, 60_000, "Run event wait timeout");
    let cursor = options.afterCursor;
    const initial = this.snapshot({ ...options, afterCursor: cursor });
    cursor = initial.nextCursor;
    if (initial.events.length > 0 || initial.cursorExpired) return Promise.resolve(initial);
    if (options.signal?.aborted) return Promise.reject(cancelled());

    return new Promise<RunEventSnapshot>((resolve, reject) => {
      let settled = false;
      const finish = (snapshot: RunEventSnapshot) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(snapshot);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const check = () => {
        const snapshot = this.snapshot({ ...options, afterCursor: cursor });
        cursor = snapshot.nextCursor;
        if (snapshot.events.length > 0 || snapshot.cursorExpired) finish(snapshot);
      };
      const onAbort = () => fail(cancelled());
      const timer = setTimeout(() => finish(this.snapshot({ ...options, afterCursor: cursor })), timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.emitter.off("append", check);
        options.signal?.removeEventListener("abort", onAbort);
      };
      this.emitter.on("append", check);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      // Close the append-between-snapshot-and-subscribe race.
      check();
    });
  }

  private compact(state: z.infer<typeof RunEventStoreStateSchema>) {
    if (state.records.length > this.maxEvents) state.records = state.records.slice(-this.maxEvents);
    this.trimStreams(state);
    while (storeBytes(state) > this.maxStoreBytes && state.records.length > 1) {
      state.records.shift();
      this.trimStreams(state);
    }
    while (storeBytes(state) > this.maxStoreBytes && this.removeOldestInactiveStream(state)) {
      // Remove sequence metadata only after retained event payloads have been bounded.
    }
    if (storeBytes(state) > this.maxStoreBytes) {
      throw new HeadlessError("OUTPUT_OVERFLOW", "Run event state exceeds its durable size limit.");
    }
    return validateState(RunEventStoreStateSchema.parse(state));
  }

  private trimStreams(state: z.infer<typeof RunEventStoreStateSchema>) {
    while (Object.keys(state.streams).length > this.maxStreams) {
      if (!this.removeOldestInactiveStream(state)) {
        const oldest = Object.entries(state.streams).sort((left, right) => left[1].lastCursor - right[1].lastCursor)[0];
        if (!oldest) return;
        delete state.streams[oldest[0]];
      }
    }
  }

  private removeOldestInactiveStream(state: z.infer<typeof RunEventStoreStateSchema>) {
    const active = new Set(state.records.map((record) => JSON.stringify([record.event.jobId, record.event.sessionId])));
    const oldest = Object.entries(state.streams)
      .filter(([key]) => !active.has(key))
      .sort((left, right) => left[1].lastCursor - right[1].lastCursor)[0];
    if (!oldest) return false;
    delete state.streams[oldest[0]];
    return true;
  }

  private persist(state: z.infer<typeof RunEventStoreStateSchema>) {
    writeOwnerOnlyJson(this.path, state);
  }
}

function emptyState(): z.infer<typeof RunEventStoreStateSchema> {
  return { version: 2, nextCursor: 1, streams: {}, records: [] };
}

function validatedSnapshotOptions(options: RunEventSnapshotOptions) {
  return {
    jobId: options.jobId === undefined ? undefined : IdentifierSchema.parse(options.jobId),
    sessionId: options.sessionId === undefined || options.sessionId === null
      ? options.sessionId
      : IdentifierSchema.parse(options.sessionId),
    afterCursor: options.afterCursor === undefined
      ? undefined
      : checkedInteger(options.afterCursor, 0, Number.MAX_SAFE_INTEGER, "Run event cursor"),
    limit: checkedInteger(options.limit ?? 200, 1, 1_000, "Run event snapshot limit"),
  };
}

function matches(event: RunEvent, filter: ReturnType<typeof validatedSnapshotOptions>) {
  if (filter.jobId !== undefined && event.jobId !== filter.jobId) return false;
  if (filter.sessionId !== undefined && event.sessionId !== filter.sessionId) return false;
  return true;
}

function isProtectedEvent(event: RunEvent) {
  return event.kind === "lifecycle" || event.kind === "policy" || event.kind === "completion";
}

class ProtectedRunEventArchive {
  private segment = 0;
  private segmentBytes = 0;
  private lastCursor = 0;
  private lastHash: string | null = null;
  private readonly eventIds = new Set<string>();

  constructor(
    private readonly directory: string,
    private readonly maxSegmentBytes: number,
    projected: RunEventRecord[],
    nextProjectionCursor: number,
  ) {
    ensureOwnerOnlyDirectory(directory);
    const targetCursors = new Set(projected.map((record) => record.cursor));
    const scan = this.scan(targetCursors, (record) => this.eventIds.add(record.event.eventId));
    this.segment = scan.lastSegment;
    this.segmentBytes = scan.lastSegmentBytes;
    this.lastCursor = scan.lastCursor;
    this.lastHash = scan.lastHash;
    if (this.lastCursor >= nextProjectionCursor) {
      throw new Error(`Protected run event archive cursor ${this.lastCursor} is not behind projection cursor ${nextProjectionCursor}.`);
    }
    for (const record of projected.sort((left, right) => left.cursor - right.cursor)) {
      if (record.cursor <= this.lastCursor) {
        if (!scan.foundTargets.has(record.cursor)) {
          throw new Error(`Protected run event archive is missing retained cursor ${record.cursor}.`);
        }
        continue;
      }
      this.append(record);
    }
  }

  append(record: RunEventRecord) {
    if (!isProtectedEvent(record.event)) throw new Error("Only protected run events may enter the protected archive.");
    if (record.cursor <= this.lastCursor) {
      throw new Error(`Protected run event cursor ${record.cursor} does not advance beyond ${this.lastCursor}.`);
    }
    const withoutHash = {
      version: 1 as const,
      cursor: record.cursor,
      event: record.event,
      previousHash: this.lastHash,
    };
    const archived = ProtectedRunEventRecordSchema.parse({
      ...withoutHash,
      hash: protectedRecordHash(withoutHash),
    });
    const line = `${JSON.stringify(archived)}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > this.maxSegmentBytes) throw new Error("A protected run event exceeds its archive segment bound.");
    if (this.segment === 0 || this.segmentBytes + bytes > this.maxSegmentBytes) {
      this.segment += 1;
      this.segmentBytes = 0;
    }
    atomicAppendFile(this.segmentPath(this.segment), line, { mode: 0o600 });
    ensureOwnerOnlyFile(this.segmentPath(this.segment));
    this.segmentBytes += bytes;
    this.lastCursor = archived.cursor;
    this.lastHash = archived.hash;
    this.eventIds.add(archived.event.eventId);
  }

  snapshot(afterCursor: number, limit: number) {
    const records: RunEventRecord[] = [];
    this.scan(new Set(), (record) => {
      if (record.cursor > afterCursor && records.length <= limit) {
        records.push({ cursor: record.cursor, event: record.event });
      }
    });
    const hasMore = records.length > limit;
    if (hasMore) records.length = limit;
    return {
      records,
      nextCursor: records.at(-1)?.cursor ?? afterCursor,
      latestCursor: this.lastCursor,
      hasMore,
    };
  }

  hasEventId(eventId: string) {
    return this.eventIds.has(eventId);
  }

  private scan(targetCursors: Set<number>, visitor?: (record: ProtectedRunEventRecord) => void) {
    const files = protectedSegmentFiles(this.directory);
    let expectedSegment = 1;
    let previousCursor = 0;
    let previousHash: string | null = null;
    let lastSegmentBytes = 0;
    const foundTargets = new Set<number>();
    for (const file of files) {
      if (file.segment !== expectedSegment) throw new Error(`Protected run event archive segment ${expectedSegment} is missing.`);
      expectedSegment += 1;
      const path = join(this.directory, file.name);
      ensureOwnerOnlyFile(path);
      const size = statSync(path).size;
      if (size <= 0 || size > this.maxSegmentBytes) {
        throw new Error(`Protected run event archive segment ${file.name} violates its byte bound.`);
      }
      const text = readFileSync(path, "utf8");
      if (!text.endsWith("\n")) throw new Error(`Protected run event archive segment ${file.name} ends with an incomplete record.`);
      const lines = text.slice(0, -1).split("\n");
      for (const [index, line] of lines.entries()) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (error) {
          throw new Error(`Invalid protected run event JSON in ${file.name}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
        }
        const persisted = PersistedProtectedRunEventRecordSchema.parse(parsed);
        if (persisted.cursor <= previousCursor) throw new Error(`Protected run event cursor order is invalid at ${persisted.cursor}.`);
        if (persisted.previousHash !== previousHash) throw new Error(`Protected run event hash chain breaks at cursor ${persisted.cursor}.`);
        const { hash, ...withoutHash } = persisted;
        if (hash !== protectedRecordHash(withoutHash)) throw new Error(`Protected run event hash mismatch at cursor ${persisted.cursor}.`);
        const record = ProtectedRunEventRecordSchema.parse({
          ...persisted,
          event: decodePersistedRunEvent(persisted.event),
        });
        previousCursor = persisted.cursor;
        previousHash = persisted.hash;
        if (targetCursors.has(persisted.cursor)) foundTargets.add(persisted.cursor);
        visitor?.(record);
      }
      lastSegmentBytes = size;
    }
    return {
      lastSegment: files.at(-1)?.segment ?? 0,
      lastSegmentBytes,
      lastCursor: previousCursor,
      lastHash: previousHash,
      foundTargets,
    };
  }

  private segmentPath(segment: number) {
    return join(this.directory, `segment-${String(segment).padStart(8, "0")}.jsonl`);
  }
}

export function terminalEventId(jobId: string, kind: "lifecycle" | "completion") {
  const hex = createHash("sha256").update(`headless-terminal\0${jobId}\0${kind}`).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = "8";
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function protectedSegmentFiles(directory: string) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .flatMap((name) => {
      const match = /^segment-(\d{8})\.jsonl$/.exec(name);
      if (!match) throw new Error(`Unexpected protected run event archive entry: ${name}`);
      return [{ name, segment: Number(match[1]) }];
    })
    .sort((left, right) => left.segment - right.segment);
}

function protectedRecordHash(record: { version: 1; cursor: number; event: unknown; previousHash: string | null }) {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

function checkedInteger(value: number, minimum: number, maximum: number, name: string) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function checkedTimestamp(value: number) {
  return checkedInteger(value, 0, Number.MAX_SAFE_INTEGER, "Run event timestamp");
}

function cancelled() {
  return new HeadlessError("CANCELLED", "Run event wait was cancelled.");
}

function storeBytes(state: z.infer<typeof RunEventStoreStateSchema>) {
  return Buffer.byteLength(stateJson(state), "utf8");
}

function stateJson(state: z.infer<typeof RunEventStoreStateSchema>) {
  return `${JSON.stringify(state, null, 2)}\n`;
}

function validateState(state: z.infer<typeof RunEventStoreStateSchema>) {
  let priorCursor = 0;
  const eventIds = new Set<string>();
  const retainedStreams = new Map<string, { sequence: number; cursor: number }>();
  for (const record of state.records) {
    if (record.cursor <= priorCursor) throw new Error("Run event state has non-monotonic cursors.");
    if (eventIds.has(record.event.eventId)) throw new Error("Run event state has a duplicate event id.");
    priorCursor = record.cursor;
    eventIds.add(record.event.eventId);
    const key = JSON.stringify([record.event.jobId, record.event.sessionId]);
    const prior = retainedStreams.get(key);
    if (prior && record.event.sequence !== prior.sequence + 1) {
      throw new Error("Run event state has a non-contiguous retained stream sequence.");
    }
    retainedStreams.set(key, { sequence: record.event.sequence, cursor: record.cursor });
  }
  if (state.records.length > 0 && state.nextCursor !== priorCursor + 1) {
    throw new Error("Run event state cursor metadata does not follow retained records.");
  }
  for (const [key, retained] of retainedStreams) {
    const stream = state.streams[key];
    if (!stream || stream.nextSequence !== retained.sequence + 1 || stream.lastCursor !== retained.cursor) {
      throw new Error("Run event state stream metadata does not match retained records.");
    }
  }
  return state;
}
