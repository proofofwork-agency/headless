import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunEventStore } from "../src/daemon/run-event-store";
import type { RunResult } from "../src/contracts/run";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("durable run event store", () => {
  test("assigns trusted envelopes and independent job/session sequences", () => {
    const fixture = createStore();
    const first = fixture.store.append(
      { jobId: "job-a", sessionId: "session-a" },
      { kind: "stdout", text: "secret sk-1234567890abcdefghijkl", truncated: false, sequence: 99, eventId: "spoof" } as never,
    );
    const otherJob = fixture.store.append(
      { jobId: "job-b", sessionId: "session-a" },
      { kind: "lifecycle", state: "running" },
    );
    const second = fixture.store.append(
      { jobId: "job-a", sessionId: "session-a" },
      { kind: "stderr", text: "again", truncated: false },
    );
    const otherSession = fixture.store.append(
      { jobId: "job-a", sessionId: "session-b" },
      { kind: "lifecycle", state: "queued" },
    );

    expect(first.event).toMatchObject({ version: 2, sequence: 0, redacted: true, jobId: "job-a", sessionId: "session-a" });
    expect(first.event.eventId).not.toBe("spoof");
    expect(first.event.kind === "stdout" && first.event.text).toContain("[REDACTED_OPENAI_KEY]");
    expect(otherJob.event.sequence).toBe(0);
    expect(second.event.sequence).toBe(1);
    expect(otherSession.event.sequence).toBe(0);
    expect(statSync(fixture.path).mode & 0o777).toBe(0o600);
    expect(readFileSync(fixture.path, "utf8")).not.toContain("sk-1234567890abcdefghijkl");

    const reloaded = new RunEventStore(fixture.path, { createId: fixture.createId });
    expect(reloaded.snapshot({ jobId: "job-a", sessionId: "session-a" }).events.map((event) => event.sequence)).toEqual([0, 1]);
    expect(reloaded.append({ jobId: "job-a", sessionId: "session-a" }, { kind: "lifecycle", state: "succeeded" }).event.sequence).toBe(2);
  });

  test("filters snapshots, advances cursors, and reports retention gaps", () => {
    const fixture = createStore({ maxEventBytes: 4_096, maxStoreBytes: 40_000, maxEvents: 3 });
    fixture.store.append({ jobId: "job-a", sessionId: "s" }, { kind: "lifecycle", state: "queued" });
    const cursor = fixture.store.append({ jobId: "job-b", sessionId: "s" }, { kind: "lifecycle", state: "queued" }).cursor;
    fixture.store.append({ jobId: "job-a", sessionId: "s" }, { kind: "lifecycle", state: "running" });
    fixture.store.append({ jobId: "job-a", sessionId: "s" }, { kind: "lifecycle", state: "succeeded" });

    const filtered = fixture.store.snapshot({ jobId: "job-a", afterCursor: cursor, limit: 1 });
    expect(filtered.events).toHaveLength(1);
    expect(filtered.hasMore).toBe(true);
    const remainder = fixture.store.snapshot({ jobId: "job-a", afterCursor: filtered.nextCursor });
    expect(remainder.events).toHaveLength(1);
    expect(remainder.hasMore).toBe(false);

    const expired = fixture.store.snapshot({ afterCursor: 0 });
    expect(expired.cursorExpired).toBe(true);
    expect(expired.oldestCursor).toBe(2);
    expect(expired.events).toHaveLength(3);
    expect(fixture.store.protectedSnapshot({ limit: 10 }).records).toHaveLength(4);
  });

  test("archives protected evidence across projection compaction, segments, and restart while rejecting corruption", () => {
    const root = temporaryDirectory();
    const path = join(root, "segmented-run-events.json");
    let id = 0;
    const options = {
      maxEventBytes: 4_096,
      maxStoreBytes: 40_000,
      maxEvents: 3,
      maxProtectedSegmentBytes: 20_480,
      createId: () => `protected-${++id}`,
    };
    const store = new RunEventStore(path, options);
    store.append({ jobId: "job" }, { kind: "stdout", text: "display only", truncated: false });
    for (let index = 0; index < 80; index += 1) {
      store.append({ jobId: "job" }, {
        kind: "policy",
        decision: index % 2 === 0 ? "allowed" : "deferred",
        rule: `policy-${index}`,
        reason: `${index}:${"e".repeat(1_500)}`,
      });
    }
    store.append({ jobId: "job" }, { kind: "lifecycle", state: "succeeded" });
    store.append({ jobId: "job" }, { kind: "completion", result: failedResult("archive-safe") });

    expect(store.snapshot().events).toHaveLength(3);
    const archived = store.protectedSnapshot({ limit: 1_000 });
    expect(archived.records).toHaveLength(82);
    expect(archived.records.every((record) => ["policy", "lifecycle", "completion"].includes(record.event.kind))).toBe(true);
    expect(archived.records.map((record) => record.cursor)).toEqual([...archived.records.map((record) => record.cursor)].sort((a, b) => a - b));
    const archiveDir = `${path}.protected`;
    const segments = readdirSync(archiveDir).sort();
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.every((name) => statSync(join(archiveDir, name)).size <= options.maxProtectedSegmentBytes)).toBe(true);
    expect(segments.every((name) => (statSync(join(archiveDir, name)).mode & 0o777) === 0o600)).toBe(true);

    const reopened = new RunEventStore(path, { ...options, createId: () => "reopened" });
    expect(reopened.protectedSnapshot({ limit: 1_000 }).records.map((record) => record.cursor))
      .toEqual(archived.records.map((record) => record.cursor));

    const corruptPath = join(archiveDir, segments[0]!);
    const corrupt = readFileSync(corruptPath, "utf8").replace('"decision":"allowed"', '"decision":"denied"');
    writeFileSync(corruptPath, corrupt, { mode: 0o600 });
    expect(() => new RunEventStore(path, options)).toThrow("hash mismatch");
  });

  test("can defer compaction until after daemon socket ownership", () => {
    const fixture = createStore({ maxEventBytes: 4_096, maxStoreBytes: 40_000, maxEvents: 10 });
    for (let index = 0; index < 3; index += 1) {
      fixture.store.append({ jobId: "job" }, { kind: "lifecycle", state: "running", detail: String(index) });
    }
    const before = readFileSync(fixture.path, "utf8");
    const deferred = new RunEventStore(fixture.path, {
      maxEventBytes: 4_096,
      maxStoreBytes: 40_000,
      maxEvents: 1,
      compactOnOpen: false,
    });

    expect(deferred.snapshot().events).toHaveLength(3);
    expect(readFileSync(fixture.path, "utf8")).toBe(before);
    deferred.append({ jobId: "job" }, { kind: "lifecycle", state: "succeeded" });
    expect(deferred.snapshot().events).toHaveLength(1);
  });

  test("waits for a matching filtered event, times out empty, and supports cancellation", async () => {
    const fixture = createStore();
    const current = fixture.store.append({ jobId: "job-target" }, { kind: "lifecycle", state: "queued" }).cursor;
    const waiting = fixture.store.waitForSnapshot({ jobId: "job-target", afterCursor: current, timeoutMs: 1_000 });
    fixture.store.append({ jobId: "job-other" }, { kind: "lifecycle", state: "running" });
    fixture.store.append({ jobId: "job-target" }, { kind: "lifecycle", state: "running" });

    const snapshot = await waiting;
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events[0]).toMatchObject({ jobId: "job-target", kind: "lifecycle", state: "running" });
    expect((await fixture.store.waitForSnapshot({ afterCursor: snapshot.latestCursor, timeoutMs: 10 })).events).toEqual([]);

    const controller = new AbortController();
    const cancelled = fixture.store.waitForSnapshot({ afterCursor: fixture.store.snapshot().latestCursor, timeoutMs: 1_000, signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "CANCELLED" });
  });

  test("fails closed when redaction throws and bounds event plus total retained bytes", () => {
    const root = temporaryDirectory();
    const path = join(root, "run-events.json");
    let id = 0;
    const failing = new RunEventStore(path, {
      maxEventBytes: 4_096,
      maxStoreBytes: 40_000,
      maxEvents: 100,
      createId: () => `event-${++id}`,
      redact: () => { throw new Error("redactor leaked raw-secret-value"); },
    });
    const suppressed = failing.append({ jobId: "job" }, { kind: "stdout", text: "raw-secret-value", truncated: false });
    expect(suppressed.event.kind === "stdout" && suppressed.event.text).toBe("[SUPPRESSED: REDACTION_FAILED]");
    expect(readFileSync(path, "utf8")).not.toContain("raw-secret-value");

    const bounded = createStore({ maxEventBytes: 4_096, maxStoreBytes: 40_000, maxEvents: 100 });
    for (let index = 0; index < 100; index += 1) {
      const record = bounded.store.append({ jobId: "job" }, { kind: "stdout", text: "🙂".repeat(20_000), truncated: false });
      expect(Buffer.byteLength(JSON.stringify(record.event))).toBeLessThanOrEqual(4_096);
    }
    expect(statSync(bounded.path).size).toBeLessThanOrEqual(40_000);
    expect(bounded.store.snapshot().events.length).toBeLessThan(100);
  });

  test("deeply redacts and bounds completion results while binding trusted ids", () => {
    const fixture = createStore();
    const secret = "sk-1234567890abcdefghijkl";
    const record = fixture.store.append(
      { jobId: "trusted-job", sessionId: "trusted-session" },
      { kind: "completion", result: failedResult(secret) },
    );
    expect(record.event.kind).toBe("completion");
    if (record.event.kind !== "completion") throw new Error("Expected completion event.");
    expect(record.event.result.jobId).toBe("trusted-job");
    expect(record.event.result.sessionId).toBe("trusted-session");
    expect(record.event.result.output).toContain("[REDACTED_OPENAI_KEY]");
    expect(record.event.result.error?.message).toContain("[REDACTED_OPENAI_KEY]");
    expect(JSON.stringify(record.event.result.error?.details)).toContain("[REDACTED_OPENAI_KEY]");
    expect(record.event.result.diff?.patch).toContain("[REDACTED_OPENAI_KEY]");
    expect(readFileSync(fixture.path, "utf8")).not.toContain(secret);
  });

  test("suppresses an oversized completion to the configured event bound", () => {
    const fixture = createStore({ maxEventBytes: 4_096, maxStoreBytes: 40_000 });
    const result = failedResult("sk-1234567890abcdefghijkl");
    result.output = "x".repeat(200_000);
    if (result.error) result.error.message = "y".repeat(16_000);
    const record = fixture.store.append({ jobId: "job" }, { kind: "completion", result });

    expect(record.event.kind).toBe("completion");
    expect(Buffer.byteLength(JSON.stringify(record.event))).toBeLessThanOrEqual(4_096);
    if (record.event.kind === "completion") {
      expect(record.event.result.output).toBe("[SUPPRESSED: EVENT_SIZE_LIMIT]");
      expect(record.event.result.truncation.events).toBe(true);
    }
  });

  test("rejects corrupt cursor and stream metadata instead of silently replaying it", () => {
    const fixture = createStore();
    fixture.store.append({ jobId: "job" }, { kind: "lifecycle", state: "queued" });
    const corrupt = JSON.parse(readFileSync(fixture.path, "utf8"));
    corrupt.nextCursor = 99;
    writeFileSync(fixture.path, `${JSON.stringify(corrupt)}\n`);

    expect(() => new RunEventStore(fixture.path, { compactOnOpen: false }))
      .toThrow("cursor metadata");
  });
});

function createStore(options: ConstructorParameters<typeof RunEventStore>[1] = {}) {
  const root = temporaryDirectory();
  const path = join(root, "run-events.json");
  let id = 0;
  const createId = () => `event-${++id}`;
  return { path, createId, store: new RunEventStore(path, { ...options, createId }) };
}

function temporaryDirectory() {
  const path = mkdtempSync(join(tmpdir(), "headless-run-event-store-"));
  roots.push(path);
  return path;
}

function failedResult(secret: string): RunResult {
  return {
    status: "failed",
    error: { code: "PROCESS_ERROR", message: `failed ${secret}`, retryable: false, details: { nested: { token: secret } } },
    backend: "fixture",
    output: `output ${secret}`,
    stderr: `stderr ${secret}`,
    diagnostics: { format: "fixture", malformedEvents: 0, ignoredEvents: 0, messages: [`diagnostic ${secret}`] },
    exitCode: 1,
    signal: null,
    usage: { input: 1, output: 2, reasoning: null, cached: null, providerTotal: 3 },
    cost: { amountUsd: null, source: "unknown", pricingId: null, observedRequests: 0 },
    containment: {
      requirement: "required",
      enforced: true,
      platform: "linux",
      mechanism: "fixture",
      probe: `probe ${secret}`,
      isolatedHome: true,
      credentialsIsolated: true,
      network: "denied",
      unsafe: false,
    },
    durationMs: 1,
    sessionId: "spoofed-session",
    jobId: "spoofed-job",
    diff: {
      patch: `+${secret}`,
      status: "M file",
      files: ["file"],
      baseCommit: null,
      candidateCommit: null,
      resultingCommit: null,
    },
    commit: null,
    truncation: { stdout: false, stderr: false, output: false, events: false, artifacts: false, diff: false },
  };
}
