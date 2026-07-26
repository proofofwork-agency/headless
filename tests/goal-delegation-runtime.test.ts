import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Goal } from "../src/contracts/collaboration";
import { DelegationScheduler } from "../src/runtime/delegation-scheduler";
import {
  GoalDelegationRuntime,
  type GoalDelegationAttempt,
  type GoalDelegationEvent,
} from "../src/runtime/goal-delegation-runtime";
import { GoalStore } from "../src/runtime/goal-store";
import { HeadlessError } from "../src/runtime/headless-error";
import { ensureProjectStateDirectories, getProjectStatePaths } from "../src/runtime/project-state";
import { schedulingAttempts } from "./support/timing";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable goal delegation runtime", () => {
  test("admits in FIFO order, respects project concurrency, and persists queue positions", async () => {
    const fixture = createFixture({ maxActive: 2, maxQueued: 4 });
    const goals = [fixture.createGoal("first"), fixture.createGoal("second"), fixture.createGoal("third")];
    const started: string[] = [];
    const attempts = new Map<string, ReturnType<typeof deferredAttempt>>();
    const run = (goal: Goal) => fixture.run(goal, (delegation) => {
      started.push(delegation.goalId);
      const attempt = deferredAttempt();
      attempts.set(delegation.goalId, attempt);
      return attempt.promise;
    });

    const first = run(goals[0]!);
    const second = run(goals[1]!);
    const third = run(goals[2]!);

    expect(started).toEqual([goals[0]!.id, goals[1]!.id]);
    expect(fixture.scheduler.activeCount()).toBe(2);
    const queued = fixture.scheduler.list("queued");
    expect(queued.map((delegation) => delegation.goalId)).toEqual([goals[2]!.id]);
    expect(fixture.events.filter((event) => event.kind === "queued" && event.delegation.id === queued[0]!.id)).toHaveLength(1);
    expect(fixture.events.find((event) => event.kind === "queued" && event.delegation.id === queued[0]!.id)?.queuePosition).toBe(1);

    attempts.get(goals[0]!.id)!.resolve(succeeded("first", "turn-first"));
    await expect(first).resolves.toBe("first");
    expect(started).toEqual([goals[0]!.id, goals[1]!.id, goals[2]!.id]);

    attempts.get(goals[1]!.id)!.resolve(succeeded("second", "turn-second"));
    attempts.get(goals[2]!.id)!.resolve(succeeded("third", "turn-third"));
    await expect(Promise.all([second, third])).resolves.toEqual(["second", "third"]);
    expect(fixture.scheduler.activeCount()).toBe(0);
    expect(goals.map((goal) => fixture.goals.get(goal.id)?.delegations[0]?.state)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
  });

  test("allows only one active turn for a known native session", async () => {
    const fixture = createFixture({ maxActive: 2, maxQueued: 3 });
    const goal = fixture.createGoal("session-lock");
    const started: string[] = [];
    const attempts: Array<ReturnType<typeof deferredAttempt>> = [];
    const run = () => fixture.run(goal, (delegation) => {
      started.push(delegation.id);
      const attempt = deferredAttempt();
      attempts.push(attempt);
      return attempt.promise;
    }, { nativeSessionId: "native-thread" });

    const first = run();
    const second = run();
    expect(started).toHaveLength(1);
    expect(fixture.scheduler.activeCount()).toBe(1);
    expect(fixture.scheduler.queuedCount()).toBe(1);

    attempts[0]!.resolve(succeeded("first", "turn-session-first"));
    await first;
    expect(started).toHaveLength(2);
    attempts[1]!.resolve(succeeded("second", "turn-session-second"));
    await second;
    expect(fixture.scheduler.list().map((delegation) => delegation.state)).toEqual(["succeeded", "succeeded"]);
  });

  test("rejects overflow without dropping admitted work and cancels queued work", async () => {
    const fixture = createFixture({ maxActive: 1, maxQueued: 1 });
    const activeGoal = fixture.createGoal("active");
    const queuedGoal = fixture.createGoal("queued");
    const overflowGoal = fixture.createGoal("overflow");
    const activeAttempt = deferredAttempt();
    let queuedStarted = false;
    const active = fixture.run(activeGoal, () => activeAttempt.promise);
    const queued = fixture.run(queuedGoal, () => {
      queuedStarted = true;
      return Promise.resolve(succeeded("queued", "turn-queued"));
    });

    let overflow: unknown;
    try {
      fixture.run(overflowGoal, () => Promise.resolve(succeeded("overflow", "turn-overflow")));
    } catch (error) {
      overflow = error;
    }
    expect(overflow).toBeInstanceOf(HeadlessError);
    expect((overflow as HeadlessError).code).toBe("QUEUE_CAPACITY_EXCEEDED");
    expect(fixture.scheduler.list().map((delegation) => delegation.goalId)).toEqual([activeGoal.id, queuedGoal.id]);
    expect(fixture.goals.get(overflowGoal.id)?.delegations).toEqual([]);

    const queuedOutcome = queued.catch((error) => error);
    expect(fixture.runtime.cancelGoal(queuedGoal.id)).toMatchObject([{ state: "cancelled" }]);
    const cancellation = await queuedOutcome;
    expect(cancellation).toBeInstanceOf(HeadlessError);
    expect((cancellation as HeadlessError).code).toBe("CANCELLED");
    expect(queuedStarted).toBe(false);
    expect(fixture.goals.get(queuedGoal.id)?.delegations[0]?.state).toBe("cancelled");

    activeAttempt.resolve(succeeded("active", "turn-active"));
    await active;
    expect(fixture.scheduler.get(fixture.goals.get(activeGoal.id)!.delegations[0]!.id)?.state).toBe("succeeded");
  });

  test("recovers rate limits only within retry budget and deadline", async () => {
    const fixture = createFixture({ maxActive: 1, maxQueued: 4 });
    const recoverable = fixture.createGoal("recoverable", 1_000);
    let attempts = 0;
    const recovered = fixture.run(recoverable, () => {
      attempts += 1;
      return Promise.resolve(attempts === 1
        ? rateLimited(100, "HTTP 429 retry-after=100")
        : succeeded("recovered", "turn-recovered"));
    }, { maxAttempts: 2 });

    await settleUntil(() => fixture.scheduler.list("queued")[0]?.attempt === 1);
    const waiting = fixture.scheduler.list("queued")[0]!;
    expect(waiting).toMatchObject({
      availableAt: 200,
      rateLimit: { retryAfterMs: 100, evidence: "HTTP 429 retry-after=100" },
    });
    fixture.clock.now = 199;
    fixture.runtime.pump();
    expect(attempts).toBe(1);
    fixture.clock.now = 200;
    fixture.runtime.pump();
    await expect(recovered).resolves.toBe("recovered");
    expect(attempts).toBe(2);
    expect(fixture.goals.get(recoverable.id)?.delegations[0]).toMatchObject({
      state: "succeeded",
      attempt: 2,
      resultTurnId: "turn-recovered",
      rateLimit: { retryAfterMs: 100, evidence: "HTTP 429 retry-after=100" },
    });

    const exhausted = fixture.createGoal("exhausted", 1_000);
    const exhaustedOutcome = fixture.run(
      exhausted,
      () => Promise.resolve(rateLimited(10, "retry budget evidence")),
      { maxAttempts: 1 },
    ).catch((error) => error);
    const exhaustedError = await exhaustedOutcome;
    expect(exhaustedError).toBeInstanceOf(HeadlessError);
    expect(exhaustedError).toMatchObject({ code: "RATE_LIMITED", details: { retryReason: "retry_exhausted" } });
    expect(fixture.goals.get(exhausted.id)?.delegations[0]).toMatchObject({ state: "failed", attempt: 1 });

    const deadline = fixture.createGoal("deadline", 250);
    const deadlineOutcome = fixture.run(
      deadline,
      () => Promise.resolve(rateLimited(50, "deadline evidence")),
      { maxAttempts: 2 },
    ).catch((error) => error);
    const deadlineError = await deadlineOutcome;
    expect(deadlineError).toBeInstanceOf(HeadlessError);
    expect(deadlineError).toMatchObject({ code: "RATE_LIMITED", details: { retryReason: "deadline_exceeded" } });
    expect(fixture.goals.get(deadline.id)?.delegations[0]).toMatchObject({ state: "expired", attempt: 1 });
  });

  test("retries an ordinary failed attempt within the configured attempt budget", async () => {
    const fixture = createFixture({ maxActive: 1, maxQueued: 4 });
    const goal = fixture.createGoal("ordinary-retry", 1_000);
    let attempts = 0;
    const outcome = fixture.run(goal, () => {
      attempts += 1;
      return Promise.resolve(attempts === 1
        ? { kind: "failed" as const, error: "transient worker failure" }
        : succeeded("recovered", "turn-ordinary-retry"));
    }, { maxAttempts: 2 });

    await expect(outcome).resolves.toBe("recovered");
    expect(attempts).toBe(2);
    expect(fixture.goals.get(goal.id)?.delegations[0]).toMatchObject({
      state: "succeeded",
      attempt: 2,
      resultTurnId: "turn-ordinary-retry",
    });
    expect(fixture.events.some((event) => event.kind === "requeued")).toBe(true);

    const exhausted = fixture.createGoal("ordinary-exhausted", 1_000);
    const error = await fixture.run(
      exhausted,
      () => Promise.resolve({ kind: "failed" as const, error: "permanent failure" }),
      { maxAttempts: 1 },
    ).catch((failure) => failure);
    expect(error).toMatchObject({ code: "PROCESS_ERROR", details: { retryReason: "retry_exhausted" } });
    expect(fixture.goals.get(exhausted.id)?.delegations[0]).toMatchObject({ state: "failed", attempt: 1 });
  });

  test("expires active and queued work before capacity admission and propagates cancellation", async () => {
    const fixture = createFixture({ maxActive: 1, maxQueued: 1 });
    const activeGoal = fixture.createGoal("expiring-active", 150);
    const queuedGoal = fixture.createGoal("expiring-queued", 150);
    const replacementGoal = fixture.createGoal("replacement", 300);
    const never = deferredAttempt();
    const cancelled: string[] = [];
    const activeOutcome = fixture.run(
      activeGoal,
      () => never.promise,
      { cancel: () => cancelled.push("active") },
    ).catch((error) => error);
    const queuedOutcome = fixture.run(
      queuedGoal,
      () => Promise.resolve(succeeded("unreachable", "turn-unreachable")),
      { cancel: () => cancelled.push("queued") },
    ).catch((error) => error);

    fixture.clock.now = 150;
    const replacement = fixture.run(
      replacementGoal,
      () => Promise.resolve(succeeded("replacement", "turn-replacement")),
    );

    expect(await activeOutcome).toMatchObject({ code: "TIMED_OUT" });
    expect(await queuedOutcome).toMatchObject({ code: "TIMED_OUT" });
    await expect(replacement).resolves.toBe("replacement");
    expect(cancelled.sort()).toEqual(["active", "queued"]);
    expect(fixture.scheduler.list().map((delegation) => delegation.state)).toEqual([
      "expired",
      "expired",
      "succeeded",
    ]);
  });
});

function createFixture(options: { maxActive: number; maxQueued: number }) {
  const root = mkdtempSync(join(tmpdir(), "headless-goal-delegation-"));
  const runtimeRoot = join("/tmp", `hgd-${process.pid}-${roots.length}`);
  const projectRoot = join(root, "project");
  mkdirSync(projectRoot);
  roots.push(root, runtimeRoot);
  const paths = ensureProjectStateDirectories(getProjectStatePaths(projectRoot, {
    env: { ...process.env, HEADLESS_STATE_HOME: join(root, "state"), HEADLESS_RUNTIME_HOME: runtimeRoot },
  }));
  const clock = { now: 100 };
  let goalId = 0;
  let delegationId = 0;
  const goals = new GoalStore(paths, { now: () => clock.now });
  const scheduler = new DelegationScheduler({
    statePath: join(paths.projectDir, "delegation-scheduler.json"),
    maxActive: options.maxActive,
    maxQueued: options.maxQueued,
    clock: () => clock.now,
  });
  const events: GoalDelegationEvent[] = [];
  const runtime = new GoalDelegationRuntime({
    goals,
    scheduler,
    now: () => clock.now,
    id: () => String(++delegationId),
    onEvent: (event) => events.push(event),
  });
  const createGoal = (name: string, deadlineAt = 1_000) => goals.create({
    id: `goal-${name}-${++goalId}`,
    principal: "owner",
    fleetProfileId: "fleet-main",
    objective: `Execute ${name}.`,
    authMode: "native-login",
    approvalPolicy: "ask",
    synthesizer: { kind: "automatic" },
    synthesizerAgentId: "leader",
    autonomous: false,
    deadlineAt,
  }).goal;
  const run = <T>(
    goal: Goal,
    execute: Parameters<GoalDelegationRuntime["run"]>[0]["execute"],
    overrides: { nativeSessionId?: string | null; maxAttempts?: number; cancel?: () => void } = {},
  ) => runtime.run({
    goal,
    fromAgentId: "leader",
    toAgentId: "worker",
    nativeSessionId: overrides.nativeSessionId ?? null,
    task: `Work on ${goal.id}.`,
    maxActive: options.maxActive,
    maxQueued: options.maxQueued,
    maxAttempts: overrides.maxAttempts ?? 2,
    cancel: overrides.cancel,
    execute,
  }) as Promise<T>;
  return { clock, goals, scheduler, runtime, events, createGoal, run };
}

function succeeded(value: string, resultTurnId: string): GoalDelegationAttempt<string> {
  return { kind: "succeeded", value, resultTurnId };
}

function rateLimited(retryAfterMs: number, evidence: string): GoalDelegationAttempt<never> {
  return { kind: "rate_limited", error: "Provider rate limit.", retryAfterMs, evidence };
}

function deferredAttempt() {
  let resolve!: (attempt: GoalDelegationAttempt<string>) => void;
  const promise = new Promise<GoalDelegationAttempt<string>>((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function settleUntil(predicate: () => boolean) {
  for (let attempt = 0; attempt < schedulingAttempts(50); attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Expected delegation state did not settle.");
}
