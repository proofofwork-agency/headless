import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  cleanupAbandonedLedgerLock,
  getProcessStartIdentity,
  importV1Ledger,
  LedgerV2,
  LedgerV2IntegrityError,
  repairLedgerPartialTail,
} from "../src/runtime/ledger-v2";
import { getReadContext, getTaskState } from "../src/runtime/ledger-api";
import { appendEvent, getOrCreateSession } from "../src/runtime/session";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture(principal = "test-principal") {
  const root = mkdtempSync(join(tmpdir(), "headless-ledger-v2-"));
  roots.push(root);
  const projectId = createHash("sha256").update(root).digest("hex");
  return {
    root,
    projectId,
    ledgerPath: join(root, "ledger.jsonl"),
    readModelPath: join(root, "read-model.json"),
    ledger: new LedgerV2({ ledgerPath: join(root, "ledger.jsonl"), readModelPath: join(root, "read-model.json"), projectId, principal }),
  };
}

function verifiedLedgerLines(projectId: string, count: number) {
  let previousHash: string | null = null;
  return Array.from({ length: count }, (_, index) => {
    const withoutHash = {
      version: 2 as const,
      sequence: index + 1,
      timestamp: Date.now(),
      projectId,
      principal: "test-principal",
      eventId: crypto.randomUUID(),
      previousHash,
      integrity: { algorithm: "sha256" as const, keyId: null },
      type: "entry",
      payload: { index },
    };
    const record = { ...withoutHash, hash: createHash("sha256").update(JSON.stringify(withoutHash)).digest("hex") };
    previousHash = record.hash;
    return JSON.stringify(record);
  });
}

describe("ledger v2", () => {
  test("assigns immutable envelope fields and keeps attempted overrides inside payload", () => {
    const { ledger, projectId } = fixture();
    const record = ledger.append("note", {
      version: 999,
      sequence: 999,
      projectId: "attacker",
      principal: "attacker",
      eventId: "attacker",
      previousHash: "attacker",
      content: "safe",
    });

    expect(record.version).toBe(2);
    expect(record.sequence).toBe(1);
    expect(record.projectId).toBe(projectId);
    expect(record.principal).toBe("test-principal");
    expect(record.previousHash).toBeNull();
    expect(record.payload.projectId).toBe("attacker");
  });

  test("buffers a partial final line and validates it when the rest arrives", () => {
    const { ledger, ledgerPath, root, projectId } = fixture();
    ledger.append("one", { value: 1 });
    ledger.append("two", { value: 2 });
    const [first, second] = readFileSync(ledgerPath, "utf8").trimEnd().split("\n");
    const midpoint = Math.floor(second.length / 2);
    writeFileSync(ledgerPath, `${first}\n${second.slice(0, midpoint)}`, { mode: 0o600 });
    const reader = new LedgerV2({ ledgerPath, readModelPath: join(root, "reader.json"), projectId, principal: "test-principal" });

    expect(reader.readAll()).toHaveLength(1);
    expect(reader.snapshot().partialLineBytes).toBeGreaterThan(0);
    writeFileSync(ledgerPath, second.slice(midpoint) + "\n", { flag: "a" });
    expect(reader.readAll()).toHaveLength(2);
    expect(reader.snapshot().partialLineBytes).toBe(0);
  });

  test("suppresses duplicate event IDs before appending them to the verified chain", () => {
    const { ledger } = fixture();
    const first = ledger.append("one", { value: 1 });
    const duplicate = ledger.appendWithDisposition("duplicate", { value: 2 }, first.eventId);

    expect(ledger.readAll()).toHaveLength(1);
    expect(ledger.snapshot().sequence).toBe(1);
    expect(duplicate).toEqual({ record: first, appended: false });
  });

  test("keeps exact incremental duplicate suppression beyond the bounded persisted id window", () => {
    const { ledgerPath, readModelPath, projectId } = fixture();
    const firstEventId = crypto.randomUUID();
    let previousHash: string | null = null;
    const lines: string[] = [];
    for (let index = 0; index < 4_097; index += 1) {
      const withoutHash = {
        version: 2,
        sequence: index + 1,
        timestamp: Date.now(),
        projectId,
        principal: "test-principal",
        eventId: index === 0 ? firstEventId : crypto.randomUUID(),
        previousHash,
        integrity: { algorithm: "sha256", keyId: null },
        type: "entry",
        payload: { index },
      };
      const record = { ...withoutHash, hash: createHash("sha256").update(JSON.stringify(withoutHash)).digest("hex") };
      previousHash = record.hash;
      lines.push(JSON.stringify(record));
    }
    writeFileSync(ledgerPath, `${lines.join("\n")}\n`, { mode: 0o600 });
    const projector = new LedgerV2({ ledgerPath, readModelPath, projectId, principal: "test-principal" });
    expect(projector.snapshot()).toMatchObject({ sequence: 4_097, eventCount: 4_097 });
    const reader = new LedgerV2({ ledgerPath, readModelPath, projectId, principal: "test-principal" });
    const previous = JSON.parse(readFileSync(ledgerPath, "utf8").trimEnd().split("\n").at(-1)!) as Record<string, unknown>;
    const withoutHash = {
      version: 2,
      sequence: 4_098,
      timestamp: Date.now(),
      projectId,
      principal: "test-principal",
      eventId: firstEventId,
      previousHash: previous.hash,
      integrity: { algorithm: "sha256", keyId: null },
      type: "late_duplicate",
      payload: { index: "duplicate" },
    };
    const duplicate = { ...withoutHash, hash: createHash("sha256").update(JSON.stringify(withoutHash)).digest("hex") };
    writeFileSync(ledgerPath, `${JSON.stringify(duplicate)}\n`, { flag: "a" });

    expect(reader.readRecent(1)[0]?.payload.index).toBe(4_096);
    expect(reader.snapshot()).toMatchObject({ sequence: 4_098, eventCount: 4_097 });
    expect(reader.readAll()).toHaveLength(4_097);
  });

  test("does not advance the trusted incremental offset past a corrupt later line", () => {
    const { ledger, ledgerPath, root, projectId } = fixture();
    ledger.append("one", { value: 1 });
    const reader = new LedgerV2({ ledgerPath, readModelPath: join(root, "transactional-reader.json"), projectId, principal: "test-principal" });
    ledger.append("two", { value: 2 });
    writeFileSync(ledgerPath, "{not-json}\n", { flag: "a" });

    expect(() => reader.readAll()).toThrow(LedgerV2IntegrityError);
    expect(() => reader.readAll()).toThrow(LedgerV2IntegrityError);
  });

  test("verifies each mixed SHA/HMAC record with its declared key and rotates without downgrade", () => {
    const { ledger, ledgerPath, readModelPath, projectId, root } = fixture();
    ledger.append("sha", { value: 1 });
    const firstKey = "first-ledger-key-material-0001";
    const secondKey = "second-ledger-key-material-0002";
    const hmac = new LedgerV2({
      ledgerPath,
      readModelPath: join(root, "hmac-read-model.json"),
      projectId,
      principal: "test-principal",
      hmacKeyring: { first: firstKey },
      activeHmacKeyId: "first",
    });
    hmac.append("hmac-one", { value: 2 });
    const rotated = new LedgerV2({
      ledgerPath,
      readModelPath: join(root, "rotated-read-model.json"),
      projectId,
      principal: "test-principal",
      hmacKeyring: { first: firstKey, second: secondKey },
      activeHmacKeyId: "second",
    });
    rotated.append("hmac-two", { value: 3 });

    expect(rotated.readAll().map((record) => record.integrity)).toEqual([
      { algorithm: "sha256", keyId: null },
      { algorithm: "hmac-sha256", keyId: "first" },
      { algorithm: "hmac-sha256", keyId: "second" },
    ]);
    expect(() => new LedgerV2({
      ledgerPath,
      readModelPath: join(root, "missing-key-read-model.json"),
      projectId,
      principal: "test-principal",
      hmacKeyring: { second: secondKey },
    })).toThrow(/unknown key id first/i);
    const verifierOnly = new LedgerV2({
      ledgerPath,
      readModelPath: join(root, "verifier-read-model.json"),
      projectId,
      principal: "test-principal",
      hmacKeyring: { first: firstKey, second: secondKey },
    });
    expect(verifierOnly.readAll()).toHaveLength(3);
    expect(() => verifierOnly.append("downgrade", { value: 4 })).toThrow(/Refusing to append an unsigned SHA record/i);
  });

  test("backs up and repairs only a verified partial tail, then records recovery", () => {
    const { ledger, ledgerPath, readModelPath, projectId, root } = fixture();
    ledger.append("one", { value: 1 });
    const verified = readFileSync(ledgerPath);
    writeFileSync(ledgerPath, "{\"partial\":", { flag: "a" });
    const damaged = readFileSync(ledgerPath);
    const backupPath = join(root, "ledger.partial.bak");

    const repaired = repairLedgerPartialTail({
      ledgerPath,
      readModelPath,
      projectId,
      principal: "test-principal",
      backupPath,
    });

    expect(repaired).toMatchObject({ backupPath, truncatedBytes: damaged.length - verified.length });
    expect(readFileSync(backupPath)).toEqual(damaged);
    const reopened = new LedgerV2({ ledgerPath, readModelPath, projectId, principal: "test-principal" });
    expect(reopened.readAll().map((record) => record.type)).toEqual(["one", "ledger_tail_repaired"]);
    expect(reopened.snapshot().partialLineBytes).toBe(0);
  });

  test("refuses partial-tail repair when the complete prefix is corrupt", () => {
    const { ledger, ledgerPath, readModelPath, projectId, root } = fixture();
    ledger.append("one", { value: 1 });
    writeFileSync(ledgerPath, "{not-json}\n{partial", { flag: "a" });
    const backupPath = join(root, "must-not-exist.bak");

    expect(() => repairLedgerPartialTail({
      ledgerPath,
      readModelPath,
      projectId,
      principal: "test-principal",
      backupPath,
    })).toThrow(/Invalid v2 ledger record/i);
    expect(existsSync(backupPath)).toBe(false);
  });

  test("does not remove an old lock owned by a verified live process", () => {
    const { ledgerPath } = fixture();
    const lockPath = `${ledgerPath}.lock`;
    mkdirSync(lockPath, { mode: 0o700 });
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
      pid: process.pid,
      processStart: getProcessStartIdentity(),
      host: hostname(),
      nonce: crypto.randomUUID(),
      acquiredAt: Date.now() - 3_600_000,
    }), { mode: 0o600 });
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(lockPath, old, old);

    expect(cleanupAbandonedLedgerLock(lockPath)).toBe(false);
    expect(Bun.file(join(lockPath, "owner.json")).size).toBeGreaterThan(0);
  });

  test("fails closed on a lock owned by a foreign host", () => {
    const { ledgerPath } = fixture();
    const lockPath = `${ledgerPath}.lock`;
    mkdirSync(lockPath, { mode: 0o700 });
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
      pid: 999_999,
      processStart: "foreign:start",
      host: `foreign-${hostname()}`,
      nonce: crypto.randomUUID(),
      acquiredAt: 0,
    }), { mode: 0o600 });

    expect(cleanupAbandonedLedgerLock(lockPath)).toBe(false);
    expect(readFileSync(join(lockPath, "owner.json"), "utf8")).toContain("foreign:start");
  });

  test("loads a bounded persisted projection and preserves full read semantics", () => {
    const { ledgerPath, readModelPath, projectId } = fixture();
    const lines = verifiedLedgerLines(projectId, 1_025);
    writeFileSync(ledgerPath, `${lines.slice(0, 1_024).join("\n")}\n`, { mode: 0o600 });
    new LedgerV2({ ledgerPath, readModelPath, projectId, principal: "test-principal" });
    writeFileSync(ledgerPath, `${lines[1_024]}\n`, { flag: "a" });

    const persisted = JSON.parse(readFileSync(readModelPath, "utf8")) as {
      lastSequence: number;
      eventCount: number;
      cachedEventBytes: number;
      events: unknown[];
      seenEventIds: string[];
      prefixSha256: string;
    };
    expect(persisted.lastSequence).toBe(1_024);
    expect(persisted.eventCount).toBe(1_024);
    expect(persisted.events).toHaveLength(1_000);
    expect(persisted.cachedEventBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(persisted.seenEventIds.length).toBeLessThanOrEqual(4_096);
    expect(persisted.prefixSha256).toMatch(/^[a-f0-9]{64}$/);

    const startedAt = performance.now();
    const reopened = new LedgerV2({ ledgerPath, readModelPath, projectId, principal: "test-principal" });
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(reopened.snapshot()).toMatchObject({ sequence: 1_025, eventCount: 1_025 });
    expect(reopened.readRecent(2).map((record) => record.payload.index)).toEqual([1_023, 1_024]);
    expect(reopened.readAll()).toHaveLength(1_025);
  });

  test("imports a verified v1 ledger without modifying the source", () => {
    const { ledger, root } = fixture();
    const sourcePath = join(root, "v1.jsonl");
    const withoutHash = {
      schema: "v1",
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      sessionId: "legacy",
      seq: 1,
      prevHash: null,
      type: "note",
      source: "legacy",
      content: "legacy content",
    };
    const event = { ...withoutHash, hash: createHash("sha256").update(JSON.stringify(withoutHash)).digest("hex") };
    const source = `${JSON.stringify(event)}\n`;
    writeFileSync(sourcePath, source, { mode: 0o600 });

    const manifest = importV1Ledger({ sourcePath, target: ledger, manifestPath: join(root, "import.json") });

    expect(manifest).toMatchObject({ importedEvents: 1 });
    expect(readFileSync(sourcePath, "utf8")).toBe(source);
    expect(ledger.readAll().map((entry) => entry.type)).toEqual(["v1_import", "migration"]);
  });

  test("resumes a crash after a durable import append without duplicating v1 events", () => {
    const { ledger, root, projectId, ledgerPath, readModelPath } = fixture();
    const sourcePath = join(root, "v1-crash.jsonl");
    let previousHash: string | null = null;
    const lines = ["first", "second"].map((content, index) => {
      const withoutHash = {
        schema: "v1",
        id: crypto.randomUUID(),
        timestamp: Date.now() + index,
        sessionId: "legacy",
        seq: index + 1,
        prevHash: previousHash,
        type: "note",
        source: "legacy",
        content,
      };
      const event = { ...withoutHash, hash: createHash("sha256").update(JSON.stringify(withoutHash)).digest("hex") };
      previousHash = event.hash;
      return JSON.stringify(event);
    });
    writeFileSync(sourcePath, `${lines.join("\n")}\n`, { mode: 0o600 });
    const manifestPath = join(root, "crash-import.json");
    const append = ledger.append.bind(ledger);
    let crashed = false;
    ledger.append = ((...args: Parameters<LedgerV2["append"]>) => {
      const record = append(...args);
      if (!crashed && record.type === "v1_import") {
        crashed = true;
        throw new Error("injected crash after durable append");
      }
      return record;
    }) as LedgerV2["append"];

    expect(() => importV1Ledger({ sourcePath, target: ledger, manifestPath })).toThrow(/injected crash/);
    const reopened = new LedgerV2({ ledgerPath, readModelPath, projectId, principal: "test-principal" });
    const manifest = importV1Ledger({ sourcePath, target: reopened, manifestPath });
    const records = reopened.readAll();

    expect(manifest).toMatchObject({ version: 2, state: "completed", importedEvents: 2 });
    expect(records.filter((record) => record.type === "v1_import")).toHaveLength(2);
    expect(records.filter((record) => record.type === "migration")).toHaveLength(1);
    expect(records.map((record) => record.payload.sourceIndex).filter((value) => value !== undefined)).toEqual([0, 1]);
  });

  test("fails a corrupt v1 import with actionable recovery text", () => {
    const { ledger, root } = fixture();
    const sourcePath = join(root, "v1.jsonl");
    writeFileSync(sourcePath, `${JSON.stringify({ seq: 1, prevHash: null, hash: "bad" })}\n`);

    expect(() => importV1Ledger({ sourcePath, target: ledger, manifestPath: join(root, "import.json") }))
      .toThrow(/Preserve the original file.*trusted backup/i);
    expect(() => ledger.readAll()).not.toThrow();
  });

  test("uses owner-only permissions for ledger and read model", () => {
    const { ledger, ledgerPath, readModelPath } = fixture();
    ledger.append("note", { content: "x" });
    chmodSync(ledgerPath, 0o600);
    expect(Bun.file(ledgerPath).size).toBeGreaterThan(0);
    expect(Bun.file(readModelPath).size).toBeGreaterThan(0);
  });

  test("serves context and task state from the maintained session projection", () => {
    const root = mkdtempSync(join(tmpdir(), "headless-session-projection-"));
    roots.push(root);
    const project = join(root, "project");
    mkdirSync(project);
    const options = {
      cwd: project,
      state: { env: { ...process.env, HEADLESS_STATE_HOME: join(root, "state") } },
      authenticatedPrincipal: "projection-principal",
      sessionId: "projection-session",
    };
    const session = getOrCreateSession(options);
    appendEvent(session, {
      type: "handoff",
      source: "spoofed",
      content: "review",
      handoff: { from: "projection-principal", to: "reviewer", reason: "review", ask: "inspect" },
    });
    appendEvent(session, {
      type: "artifact",
      source: "spoofed",
      content: "evidence",
      artifact: { kind: "test", title: "projection", summary: "passed", status: "passed" },
    });
    const scan = session.ledger.readAll;
    session.ledger.readAll = (() => { throw new Error("unexpected full ledger scan"); }) as typeof scan;
    try {
      const context = getReadContext({ ...options, view: "summary", limit: 10 });
      const task = getTaskState(options);
      expect(context.entries).toHaveLength(3);
      expect(task.taskBoard.activeCount).toBe(1);
      expect(task.artifacts[0]?.title).toBe("projection");
    } finally {
      session.ledger.readAll = scan;
    }
  });

  test("does not double-apply an explicit event retry to the semantic projection", () => {
    const root = mkdtempSync(join(tmpdir(), "headless-session-dedupe-"));
    roots.push(root);
    const project = join(root, "project");
    mkdirSync(project);
    const options = {
      cwd: project,
      state: { env: { ...process.env, HEADLESS_STATE_HOME: join(root, "state") } },
      authenticatedPrincipal: "dedupe-principal",
      sessionId: "dedupe-session",
    };
    const session = getOrCreateSession(options);
    const eventId = crypto.randomUUID();
    appendEvent(session, {
      type: "artifact",
      source: "ignored",
      content: "first",
      artifact: { kind: "test", title: "first", summary: "passed", status: "passed" },
    }, eventId);
    const retry = appendEvent(session, {
      type: "artifact",
      source: "ignored",
      content: "retry",
      artifact: { kind: "test", title: "retry", summary: "must not apply", status: "failed" },
    }, eventId);

    const state = getTaskState(options);
    expect(retry.content).toBe("first");
    expect(state.artifacts.map((artifact) => artifact.title)).toEqual(["first"]);
    expect(session.ledger.snapshot()).toMatchObject({ sequence: 2, eventCount: 2 });
  });
});
