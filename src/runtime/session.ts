import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { EventInput, HeadlessEvent } from "./events";
import {
  cleanupAbandonedLedgerLock,
  cleanupOwnedLedgerLock,
  importV1Ledger,
  ledgerIntegrityOptionsFromEnv,
  LedgerV2,
  LedgerV2IntegrityError,
  type LedgerRecordV2,
} from "./ledger-v2";
import {
  ensureOwnerOnlyDirectory,
  ensureProjectStateDirectories,
  getProjectStatePaths,
  type ProjectStateOptions,
  type ProjectStatePaths,
} from "./project-state";
import { atomicWriteFile } from "./atomic-write";
import { redactDeep } from "./redaction";
import { emptyTaskState, projectTaskState, readContext, type ReadContextView, type TaskState } from "./read-model";
import { readOwnerOnlyJson, writeOwnerOnlyJson } from "./owner-json";
import { recordRuntimeDiagnostic } from "./diagnostics";
export { safeJsonParse } from "./safe-json";

const CURRENT_SESSION_FILE = "current-session";
const MAX_PROJECTED_EVENTS = 1_000;
const MAX_PROJECTED_EVENT_BYTES = 8 * 1024 * 1024;
const MAX_PROJECTED_SUMMARY_BYTES = 2 * 1024 * 1024;
const ledgers = new Map<string, LedgerV2>();
const RESERVED_EVENT_FIELDS = new Set([
  "schema",
  "version",
  "id",
  "eventId",
  "timestamp",
  "sessionId",
  "seq",
  "sequence",
  "prevHash",
  "previousHash",
  "hash",
  "integrity",
  "projectId",
  "principal",
  "source",
]);

export class LedgerIntegrityError extends LedgerV2IntegrityError {
  constructor(message: string) {
    super(message);
    this.name = "LedgerIntegrityError";
  }
}

export type HeadlessSession = {
  root: string;
  projectId: string;
  principal: string;
  sessionId: string;
  sessionDir: string;
  ledgerPath: string;
  state: ProjectStatePaths;
  ledger: LedgerV2;
  includeAllPrincipals: boolean;
};

export type SessionOptions = {
  cwd?: string;
  sessionId?: string;
  /** Deprecated and ignored. Event principals are assigned by the runtime/daemon. */
  source?: string;
  /** Internal daemon-authenticated principal. Public callers should not set this. */
  authenticatedPrincipal?: string;
  /** Internal administrator audit view; never accepted from client payloads. */
  includeAllPrincipals?: boolean;
  state?: ProjectStateOptions;
};

const SessionProjectionSchema = z.object({
  version: z.literal(2),
  projectId: z.string().regex(/^[a-f0-9]{64}$/),
  principal: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(160),
  lastSequence: z.number().int().nonnegative(),
  lastHash: z.string().nullable(),
  started: z.boolean(),
  summary: z.custom<TaskState>(isTaskState),
  recent: z.array(z.custom<HeadlessEvent>(isProjectedEvent)).max(MAX_PROJECTED_EVENTS),
}).strict().refine((projection) => Buffer.byteLength(JSON.stringify(projection.recent)) <= MAX_PROJECTED_EVENT_BYTES, "Projected event window exceeds its byte limit.")
  .refine((projection) => Buffer.byteLength(JSON.stringify(projection.summary)) <= MAX_PROJECTED_SUMMARY_BYTES, "Projected summary exceeds its byte limit.");

type SessionProjection = z.infer<typeof SessionProjectionSchema>;

export function getOrCreateSession(options: SessionOptions = {}): HeadlessSession {
  const state = ensureProjectStateDirectories(getProjectStatePaths(options.cwd ?? process.cwd(), options.state));
  const principal = authenticatedPrincipal(options.authenticatedPrincipal);
  const currentPath = join(state.projectDir, CURRENT_SESSION_FILE);
  const requested = sanitizeSessionId(options.sessionId);
  const existing = readCurrentSession(currentPath);
  const sessionId = requested ?? existing ?? newSessionId();
  const sessionDir = ensureOwnerOnlyDirectory(join(state.sessionsDir, sessionId));
  atomicWriteFile(currentPath, `${sessionId}\n`, { mode: 0o600 });

  const ledgerKey = `${state.ledgerPath}\0${principal}`;
  let ledger = ledgers.get(ledgerKey);
  if (!ledger) {
    ledger = new LedgerV2({
      ledgerPath: state.ledgerPath,
      readModelPath: state.readModelPath,
      projectId: state.projectId,
      principal,
      ...ledgerIntegrityOptionsFromEnv(),
    });
    ledgers.set(ledgerKey, ledger);
  }
  migrateLegacyLedger(state, ledger);
  const session = {
    root: state.canonicalProjectRoot,
    projectId: state.projectId,
    principal,
    sessionId,
    sessionDir,
    ledgerPath: state.ledgerPath,
    state,
    ledger,
    includeAllPrincipals: options.includeAllPrincipals === true,
  };
  ensureSessionProjection(session);
  ensureSessionStarted(session);
  return session;
}

export function appendEvent(session: HeadlessSession, input: EventInput, eventId?: string): HeadlessEvent {
  const projection = ensureSessionProjection(session);
  const event = eventPayload(input, session);
  const payload = { sessionId: session.sessionId, event };
  const record = eventId === undefined
    ? session.ledger.append(event.type, payload)
    : session.ledger.append(event.type, payload, eventId);
  const projected = recordToEvent(record);
  if (record.sequence === projection.lastSequence + 1) {
    updateSessionProjection(session, projection, projected, record.sequence, record.hash);
  } else if (record.sequence > projection.lastSequence) {
    // Another authenticated writer advanced the shared ledger between the
    // projection read and this append. Rebuild from the newly verified head.
    ensureSessionProjection(session);
  }
  return projected;
}

export function readLedger(session: HeadlessSession): HeadlessEvent[] {
  try {
    return session.ledger.readAll()
      .filter((record) => (session.includeAllPrincipals || record.principal === session.principal) && record.payload.sessionId === session.sessionId && isNativeEventRecord(record))
      .map(recordToEvent);
  } catch (error) {
    if (error instanceof LedgerV2IntegrityError) throw new LedgerIntegrityError(error.message);
    throw error;
  }
}

export function readRecentEvents(session: HeadlessSession, limit = 40): HeadlessEvent[] {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError("Recent event limit must be a non-negative safe integer.");
  const events = ensureSessionProjection(session).recent;
  return events.slice(Math.max(0, events.length - limit));
}

export function readProjectedContext(session: HeadlessSession, options: { view?: ReadContextView; limit?: number } = {}) {
  const projection = ensureSessionProjection(session);
  const limit = options.limit ?? 40;
  const recent = projection.recent.slice(Math.max(0, projection.recent.length - limit));
  if (options.view === "raw") return { entries: recent };
  const entries = readContext(recent, { view: "recent", limit }).entries;
  if (options.view === "recent") return { entries };
  return { summary: structuredClone(projection.summary), entries };
}

export function readProjectedTaskState(session: HeadlessSession) {
  return structuredClone(ensureSessionProjection(session).summary);
}

export function cleanupLedgerLock(session: HeadlessSession) {
  return cleanupOwnedLedgerLock(`${session.ledgerPath}.lock`);
}

export function cleanupStaleLedgerLock(session: HeadlessSession) {
  return cleanupAbandonedLedgerLock(`${session.ledgerPath}.lock`);
}

export function tailLedger(
  session: HeadlessSession,
  onEvent: (event: HeadlessEvent) => void,
  pollMs = 250,
) {
  if (!Number.isSafeInteger(pollMs) || pollMs < 25) throw new TypeError("Ledger polling interval must be an integer of at least 25ms.");
  let seenSequence = session.ledger.snapshot().sequence;
  let callbackFailures = 0;
  const timer = setInterval(() => {
    try {
      const records = session.ledger.readAll();
      for (const record of records) {
        if (record.sequence <= seenSequence) continue;
        seenSequence = record.sequence;
        if ((!session.includeAllPrincipals && record.principal !== session.principal) || record.payload.sessionId !== session.sessionId || !isNativeEventRecord(record)) continue;
        const event = recordToEvent(record);
        try {
          onEvent(event);
        } catch (error) {
          callbackFailures += 1;
          if (callbackFailures <= 3) recordRuntimeDiagnostic("stream-callback", "ledger.tail-callback", error);
        }
      }
    } catch (error) {
      // The verified reader retains the last safe offset. Consumers can perform
      // an explicit read to surface the integrity error; raw bytes are never emitted.
      recordRuntimeDiagnostic("state", "ledger.tail-read", error);
    }
  }, pollMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export const observeLedgerTail = tailLedger;

function ensureSessionStarted(session: HeadlessSession) {
  if (ensureSessionProjection(session).started) return;
  appendEvent(session, {
    type: "session_started",
    source: session.principal,
    content: "Headless session started.",
    meta: { root: session.root, projectId: session.projectId },
  });
}

function ensureSessionProjection(session: HeadlessSession): SessionProjection {
  const path = sessionProjectionPath(session);
  const snapshot = session.ledger.snapshot();
  const existing = readOwnerOnlyJson(path, SessionProjectionSchema);
  if (
    existing
    && existing.projectId === session.projectId
    && existing.principal === session.principal
    && existing.sessionId === session.sessionId
    && existing.lastSequence === snapshot.sequence
    && existing.lastHash === snapshot.headHash
  ) return existing;

  let summary = emptyTaskState(session.sessionId);
  const events: HeadlessEvent[] = [];
  let started = false;
  for (const record of session.ledger.readAll()) {
    if ((!session.includeAllPrincipals && record.principal !== session.principal) || record.payload.sessionId !== session.sessionId || !isNativeEventRecord(record)) continue;
    const event = recordToEvent(record);
    summary = projectTaskState(summary, event);
    boundProjectedSummary(summary);
    events.push(event);
    trimProjectedEvents(events);
    if (record.type === "session_started" && record.principal === session.principal) started = true;
  }
  const projection = SessionProjectionSchema.parse({
    version: 2,
    projectId: session.projectId,
    principal: session.principal,
    sessionId: session.sessionId,
    lastSequence: snapshot.sequence,
    lastHash: snapshot.headHash,
    started,
    summary,
    recent: events,
  });
  writeOwnerOnlyJson(path, projection);
  return projection;
}

function updateSessionProjection(session: HeadlessSession, current: SessionProjection, event: HeadlessEvent, sequence: number, hash: string) {
  if (current.lastSequence !== sequence - 1 || current.lastHash !== event.previousHash) {
    throw new Error("Session projection does not match the ledger prefix before append.");
  }
  const recent = [...current.recent, event];
  trimProjectedEvents(recent);
  const summary = projectTaskState(current.summary, event);
  boundProjectedSummary(summary);
  const next = SessionProjectionSchema.parse({
    ...current,
    lastSequence: sequence,
    lastHash: hash,
    started: current.started || event.type === "session_started",
    summary,
    recent,
  });
  writeOwnerOnlyJson(sessionProjectionPath(session), next);
}

function sessionProjectionPath(session: HeadlessSession) {
  const principalId = createHash("sha256").update(session.principal).digest("hex").slice(0, 24);
  return join(session.sessionDir, `read-model-${principalId}${session.includeAllPrincipals ? "-all" : ""}.json`);
}

function trimProjectedEvents(events: HeadlessEvent[]) {
  while (events.length > MAX_PROJECTED_EVENTS || Buffer.byteLength(JSON.stringify(events)) > MAX_PROJECTED_EVENT_BYTES) events.shift();
}

function boundProjectedSummary(summary: TaskState) {
  const collections: Array<unknown[]> = [
    summary.taskBoard.lanes,
    summary.workRequests,
    summary.taskClaims,
    summary.artifacts,
    summary.finality.proposals,
  ];
  while (Buffer.byteLength(JSON.stringify(summary)) > MAX_PROJECTED_SUMMARY_BYTES) {
    const target = collections.sort((left, right) => right.length - left.length)[0];
    if (!target?.length) throw new Error("Session semantic projection exceeds its byte limit.");
    target.shift();
  }
  summary.taskBoard.activeCount = summary.taskBoard.lanes.filter((lane) => lane.status === "active").length;
  summary.taskBoard.handledCount = summary.taskBoard.lanes.length - summary.taskBoard.activeCount;
  summary.finality.blockers = [
    summary.taskBoard.activeCount ? `${summary.taskBoard.activeCount} active handoff${summary.taskBoard.activeCount === 1 ? "" : "s"}` : null,
    summary.taskBoard.pendingMoreWork ? `${summary.taskBoard.pendingMoreWork} agents asking for more work` : null,
    summary.taskBoard.backupRequests ? `${summary.taskBoard.backupRequests} backup requests open` : null,
    summary.runs.failed ? `${summary.runs.failed} failed run${summary.runs.failed === 1 ? "" : "s"}` : null,
    summary.runs.timedOut ? `${summary.runs.timedOut} timed out run${summary.runs.timedOut === 1 ? "" : "s"}` : null,
  ].filter((value): value is string => Boolean(value));
}

function isProjectedEvent(value: unknown): value is HeadlessEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return event.schema === "v2" && event.version === 2 && typeof event.id === "string" && typeof event.type === "string" && typeof event.sequence === "number";
}

function isTaskState(value: unknown): value is TaskState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<TaskState>;
  return !!state.taskBoard && Array.isArray(state.taskBoard.lanes) && Array.isArray(state.workRequests) && Array.isArray(state.taskClaims)
    && Array.isArray(state.artifacts) && !!state.finality && Array.isArray(state.finality.proposals) && !!state.runs;
}

function eventPayload(input: EventInput, session: HeadlessSession) {
  const event: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (RESERVED_EVENT_FIELDS.has(key)) continue;
    event[key] = value;
  }
  event.type = typeof input.type === "string" ? input.type : "note";
  event.source = session.principal;
  const redaction = redactDeep(event);
  const safe = redaction.value as EventInput;
  if (redaction.redacted || redaction.truncated) {
    safe.meta = {
      ...(safe.meta ?? {}),
      redacted: redaction.redacted,
      truncated: redaction.truncated,
    };
  }
  return safe;
}

function recordToEvent(record: LedgerRecordV2): HeadlessEvent {
  const payload = record.payload.event as Record<string, unknown>;
  return {
    ...payload,
    schema: "v2",
    version: 2,
    id: record.eventId,
    eventId: record.eventId,
    timestamp: record.timestamp,
    sessionId: String(record.payload.sessionId),
    projectId: record.projectId,
    principal: record.principal,
    source: record.principal,
    seq: record.sequence,
    sequence: record.sequence,
    prevHash: record.previousHash,
    previousHash: record.previousHash,
    hash: record.hash,
    integrity: record.integrity,
  } as HeadlessEvent;
}

function isNativeEventRecord(record: LedgerRecordV2) {
  return !!record.payload.event && typeof record.payload.event === "object" && !Array.isArray(record.payload.event);
}

function migrateLegacyLedger(state: ProjectStatePaths, ledger: LedgerV2) {
  const legacyRoot = join(state.canonicalProjectRoot, ".headless");
  const current = readCurrentSession(join(legacyRoot, CURRENT_SESSION_FILE));
  if (!current) return;
  const sourcePath = join(legacyRoot, "sessions", current, "ledger.jsonl");
  if (!existsSync(sourcePath)) return;
  importV1Ledger({
    sourcePath,
    target: ledger,
    manifestPath: state.migrationManifestPath,
    hmacKey: ledger.hmacKey,
  });
}

function authenticatedPrincipal(value?: string) {
  const configured = value?.trim() || process.env.HEADLESS_PRINCIPAL?.trim();
  if (configured) return configured.slice(0, 128);
  try {
    return `local:${userInfo().username}`.slice(0, 128);
  } catch {
    return `local:uid-${typeof process.getuid === "function" ? process.getuid() : process.pid}`;
  }
}

function readCurrentSession(path: string) {
  if (!existsSync(path)) return null;
  return sanitizeSessionId(readFileSync(path, "utf8"));
}

function newSessionId() {
  return `session_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}

function sanitizeSessionId(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const cleaned = trimmed.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120);
  return /^\.+$/.test(cleaned) ? null : cleaned;
}
