import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../src/daemon/task-store";
import { TaskClaimParamsSchema } from "../src/daemon/protocol";

const roots: string[] = [];
const projectId = "a".repeat(64);

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("durable task store", () => {
  test("persists an owner-only claim, renewal, and terminal outcome", () => {
    const root = temporaryDirectory();
    let now = 1_000;
    const store = new TaskStore(join(root, "tasks"), { now: () => now, createId: () => "task-one" });
    const created = store.create({ jobId: "job-one", projectId, capability: "review.diff" });

    expect(created.state).toBe("pending");
    expect(statSync(join(root, "tasks")).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "tasks", "task-one.task.json")).mode & 0o777).toBe(0o600);

    const claimed = store.claim({ taskId: created.id, principal: "agent-one", leaseMs: 500 });
    expect(claimed).toMatchObject({ state: "claimed", claimedBy: "agent-one", leaseExpiresAt: 1_500 });
    expect(() => store.renew({ taskId: created.id, principal: "agent-two", leaseMs: 500 }))
      .toThrow("another authenticated principal");

    now = 1_200;
    expect(store.renew({ taskId: created.id, principal: "agent-one", leaseMs: 600 }).leaseExpiresAt).toBe(1_800);
    const reloaded = new TaskStore(join(root, "tasks"), { now: () => now });
    expect(reloaded.get(created.id)?.state).toBe("claimed");
    expect(reloaded.complete({ taskId: created.id, principal: "agent-one", outcome: "completed" }))
      .toMatchObject({ state: "completed", claimedBy: "agent-one", leaseExpiresAt: null });
    expect(new TaskStore(join(root, "tasks"), { now: () => now }).get(created.id)?.state).toBe("completed");
  });

  test("recovers an expired lease and lets a different authenticated principal claim it", () => {
    const root = temporaryDirectory();
    let now = 10_000;
    const store = new TaskStore(join(root, "tasks"), { now: () => now, createId: () => "stale-task" });
    const task = store.create({ jobId: "job-stale", projectId, capability: "execute" });
    store.claim({ taskId: task.id, principal: "lost-worker", leaseMs: 100 });

    now = 10_100;
    const recovered = new TaskStore(join(root, "tasks"), { now: () => now });
    expect(recovered.get(task.id)).toMatchObject({ state: "pending", claimedBy: null, leaseExpiresAt: null });
    expect(recovered.claim({ taskId: task.id, principal: "replacement", leaseMs: 200 }))
      .toMatchObject({ state: "claimed", claimedBy: "replacement", leaseExpiresAt: 10_300 });
  });

  test("daemon terminal resolution is not blocked by an external or expired claim", () => {
    const root = temporaryDirectory();
    let now = 15_000;
    const store = new TaskStore(join(root, "tasks"), { now: () => now, createId: () => "externally-claimed" });
    const task = store.create({ jobId: "job", projectId, capability: "execute" });
    store.claim({ taskId: task.id, principal: "external-worker", leaseMs: 100 });
    now += 1_000;

    expect(store.resolveFromDaemon({ taskId: task.id, principal: "job-owner", outcome: "completed" }))
      .toMatchObject({ state: "completed", claimedBy: "external-worker", leaseExpiresAt: null });
  });

  test("can defer stale recovery until after daemon socket ownership", () => {
    const root = temporaryDirectory();
    let now = 30_000;
    const path = join(root, "tasks");
    const initial = new TaskStore(path, { now: () => now, createId: () => "deferred-task" });
    const task = initial.create({ jobId: "job", projectId, capability: "execute" });
    initial.claim({ taskId: task.id, principal: "old-owner", leaseMs: 10 });
    now += 10;
    const before = readFileSync(join(path, "deferred-task.task.json"), "utf8");

    const deferred = new TaskStore(path, { now: () => now, recoverOnOpen: false });
    expect(deferred.get(task.id)?.state).toBe("claimed");
    expect(readFileSync(join(path, "deferred-task.task.json"), "utf8")).toBe(before);
    expect(deferred.recoverStaleLeases()).toHaveLength(1);
    expect(deferred.get(task.id)?.state).toBe("pending");
  });

  test("supports filtered lists and authenticated cancellation without reopening terminal tasks", () => {
    const root = temporaryDirectory();
    let nextId = 0;
    const store = new TaskStore(join(root, "tasks"), { now: () => 20_000, createId: () => `task-${++nextId}` });
    const first = store.create({ jobId: "job-one", projectId, capability: "proposal" });
    store.create({ jobId: "job-two", projectId, capability: "review" });

    expect(store.list({ jobId: "job-one" }).map((task) => task.id)).toEqual([first.id]);
    expect(store.cancel({ taskId: first.id, principal: "coordinator" }))
      .toMatchObject({ state: "cancelled", claimedBy: "coordinator" });
    expect(store.list({ state: "cancelled" })).toHaveLength(1);
    expect(() => store.claim({ taskId: first.id, principal: "worker", leaseMs: 100 })).toThrow("cannot be claimed");
    expect(() => store.cancel({ taskId: first.id, principal: "   " })).toThrow();
  });

  test("rejects invalid lease bounds and refuses corrupt persisted tasks", () => {
    const root = temporaryDirectory();
    const store = new TaskStore(join(root, "tasks"), { createId: () => "bounded-task" });
    const task = store.create({ jobId: "job", projectId, capability: "test" });

    expect(() => store.claim({ taskId: task.id, principal: "worker", leaseMs: 0 })).toThrow();
    expect(() => store.claim({ taskId: task.id, principal: "worker", leaseMs: 86_400_001 })).toThrow();
    const path = join(root, "tasks", "bounded-task.task.json");
    const corrupt = { ...JSON.parse(readFileSync(path, "utf8")), state: "claimed", claimedBy: null, leaseExpiresAt: null };
    writeFileSync(path, `${JSON.stringify(corrupt)}\n`);
    expect(() => new TaskStore(join(root, "tasks"), { recoverOnOpen: false }).get(task.id)).toThrow("require an authenticated owner");
  });

  test("does not accept claimant identity in untrusted daemon parameters", () => {
    expect(TaskClaimParamsSchema.parse({ taskId: "task", leaseMs: 1_000 }))
      .toEqual({ taskId: "task", leaseMs: 1_000 });
    expect(() => TaskClaimParamsSchema.parse({ taskId: "task", leaseMs: 1_000, principal: "spoofed" }))
      .toThrow();
    expect(() => TaskClaimParamsSchema.parse({ taskId: "task", leaseMs: 1_000, claimedBy: "spoofed" }))
      .toThrow();
  });
});

function temporaryDirectory() {
  const path = mkdtempSync(join(tmpdir(), "headless-task-store-"));
  roots.push(path);
  return path;
}
