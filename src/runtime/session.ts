import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, rmdirSync } from "fs";
import { dirname, join } from "path";
import type { EventInput, HeadlessEvent } from "./events";
import { atomicWriteFile } from "./atomic-write";

export type HeadlessSession = {
  root: string;
  sessionId: string;
  sessionDir: string;
  ledgerPath: string;
};

export type SessionOptions = {
  cwd?: string;
  sessionId?: string;
  source?: string;
};

const HEADLESS_DIR = ".headless";
const CURRENT_SESSION_FILE = "current-session";
const LOCK_RETRY_MS = 5;
const LOCK_RETRIES = 1_000;

export class LedgerIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerIntegrityError";
  }
}

export function getOrCreateSession(opts: SessionOptions = {}): HeadlessSession {
  const root = opts.cwd || process.cwd();
  const headlessDir = join(root, HEADLESS_DIR);
  mkdirSync(headlessDir, { recursive: true });

  const sessionId = sanitizeSessionId(opts.sessionId) || readCurrentSession(headlessDir) || newSessionId();
  const sessionDir = join(headlessDir, "sessions", sessionId);
  const ledgerPath = join(sessionDir, "ledger.jsonl");
  mkdirSync(sessionDir, { recursive: true });
  writeCurrentSession(headlessDir, sessionId);

  const session = { root, sessionId, sessionDir, ledgerPath };
  ensureSessionStarted(session, opts.source || "headless");

  return session;
}

export function appendEvent(session: HeadlessSession, input: EventInput): HeadlessEvent {
  return withLedgerLock(session, () => {
    const events = readLedgerUnlocked(session);
    const previous = events.at(-1);
    // seq counts only chained events, matching verifyEvent on read. For an
    // all-chained ledger this equals events.length + 1; for a legacy prefix it
    // numbers the first real chained event as 1 so append+re-read round-trips.
    const chainedCount = events.filter(isChainedEvent).length;
    const eventWithoutHash: Omit<HeadlessEvent, "hash"> = {
      schema: "v1",
      id: input.id || crypto.randomUUID(),
      timestamp: input.timestamp || Date.now(),
      sessionId: session.sessionId,
      seq: chainedCount + 1,
      prevHash: previous?.hash || null,
      ...input,
    };
    const event: HeadlessEvent = {
      ...eventWithoutHash,
      hash: hashEvent(eventWithoutHash),
    };

    mkdirSync(dirname(session.ledgerPath), { recursive: true });
    const existing = existsSync(session.ledgerPath) ? readFileSync(session.ledgerPath, "utf8") : "";
    atomicWriteFile(session.ledgerPath, existing + `${JSON.stringify(event)}\n`, { mode: 0o600 });
    return event;
  });
}

export function readLedger(session: HeadlessSession): HeadlessEvent[] {
  return readLedgerUnlocked(session);
}

export function readRecentEvents(session: HeadlessSession, limit = 40): HeadlessEvent[] {
  const events = readLedger(session);
  return events.slice(Math.max(0, events.length - limit));
}

function ensureSessionStarted(session: HeadlessSession, source: string) {
  withLedgerLock(session, () => {
    const existing = readLedgerUnlocked(session);
    if (existing.length > 0) return;
    const eventWithoutHash: Omit<HeadlessEvent, "hash"> = {
      schema: "v1",
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      sessionId: session.sessionId,
      seq: 1,
      prevHash: null,
      type: "session_started",
      source,
      content: "Headless session started.",
      meta: { root: session.root },
    };
    const event = { ...eventWithoutHash, hash: hashEvent(eventWithoutHash) };
    const existingRaw = existsSync(session.ledgerPath) ? readFileSync(session.ledgerPath, "utf8") : "";
    atomicWriteFile(session.ledgerPath, existingRaw + `${JSON.stringify(event)}\n`, { mode: 0o600 });
  });
}

function readLedgerUnlocked(session: HeadlessSession): HeadlessEvent[] {
  if (!existsSync(session.ledgerPath)) return [];
  const text = readFileSync(session.ledgerPath, "utf8");
  const events: HeadlessEvent[] = [];

  let lineNumber = 0;
  let chainedCount = 0;
  for (const line of text.split("\n")) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: HeadlessEvent;
    try {
      event = JSON.parse(trimmed) as HeadlessEvent;
    } catch (error) {
      throw new LedgerIntegrityError(`Invalid ledger JSON at ${session.ledgerPath}:${lineNumber}: ${error instanceof Error ? error.message : String(error)}`);
    }
    verifyEvent(session, event, events.at(-1), chainedCount + 1, lineNumber);
    if (isChainedEvent(event)) chainedCount += 1;
    events.push(event);
  }

  return events;
}

function readCurrentSession(headlessDir: string) {
  const currentPath = join(headlessDir, CURRENT_SESSION_FILE);
  if (!existsSync(currentPath)) return null;
  return sanitizeSessionId(readFileSync(currentPath, "utf8"));
}

function writeCurrentSession(headlessDir: string, sessionId: string) {
  const currentPath = join(headlessDir, CURRENT_SESSION_FILE);
  atomicWriteFile(currentPath, `${sessionId}\n`, { mode: 0o600 });
}

function newSessionId() {
  return `session_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}

function sanitizeSessionId(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120);
}

function verifyEvent(session: HeadlessSession, event: HeadlessEvent, previous: HeadlessEvent | undefined, expectedSeq: number, lineNumber: number) {
  if (!isChainedEvent(event)) {
    if (previous && isChainedEvent(previous)) {
      throw new LedgerIntegrityError(`Legacy unchained ledger event after chained event at ${session.ledgerPath}:${lineNumber}.`);
    }
    return;
  }
  if (event.seq !== expectedSeq) {
    throw new LedgerIntegrityError(`Ledger sequence mismatch at ${session.ledgerPath}:${lineNumber}: expected ${expectedSeq}, got ${event.seq ?? "missing"}`);
  }
  const expectedPrevHash = previous?.hash || null;
  if (event.prevHash !== expectedPrevHash) {
    throw new LedgerIntegrityError(`Ledger previous hash mismatch at ${session.ledgerPath}:${lineNumber}.`);
  }
  if (!event.hash) {
    throw new LedgerIntegrityError(`Ledger hash missing at ${session.ledgerPath}:${lineNumber}.`);
  }
  const { hash: _hash, ...withoutHash } = event;
  const expectedHash = hashEvent(withoutHash);
  if (event.hash !== expectedHash) {
    throw new LedgerIntegrityError(`Ledger hash mismatch at ${session.ledgerPath}:${lineNumber}.`);
  }
}

function isChainedEvent(event: HeadlessEvent) {
  return !!event.hash || event.seq !== undefined || event.prevHash !== undefined;
}

function hashEvent(event: Omit<HeadlessEvent, "hash">) {
  return createHash("sha256").update(JSON.stringify(event)).digest("hex");
}

function withLedgerLock<T>(session: HeadlessSession, fn: () => T): T {
  const lockDir = `${session.ledgerPath}.lock`;
  mkdirSync(dirname(lockDir), { recursive: true });
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      mkdirSync(lockDir);
      try {
        return fn();
      } finally {
        rmdirSync(lockDir);
      }
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      sleepSync(LOCK_RETRY_MS);
    }
  }
  throw new Error(`Timed out waiting for ledger lock: ${lockDir}`);
}

function isAlreadyExists(error: unknown) {
  return !!error && typeof error === "object" && "code" in error && error.code === "EEXIST";
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
