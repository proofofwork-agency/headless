import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerBackendDefinition, unregisterBackendDefinition, type BackendDefinition } from "../src/backends/registry";
import { ProviderBroker } from "../src/broker/server";
import { RunRequestSchema, type SerializedRunRequest } from "../src/contracts/run";
import { JobAdmissionService, daemonFailureResult, delegatedApprovalPolicy } from "../src/daemon/job-admission-service";
import type { RunExecutionControls } from "../src/daemon/run-execution-service";
import { JobStore } from "../src/daemon/job-store";
import { RunEventStore } from "../src/daemon/run-event-store";
import { TaskStore } from "../src/daemon/task-store";
import { ApprovalStore } from "../src/runtime/approval-store";
import { AuthorityStore } from "../src/runtime/authority-store";
import { BudgetStore } from "../src/runtime/budget-store";
import { HeadlessError } from "../src/runtime/headless-error";
import { ensureProjectStateDirectories, getProjectStatePaths } from "../src/runtime/project-state";
import { ProjectTrustStore } from "../src/runtime/project-trust-store";
import { PersistentSessionStore } from "../src/runtime/persistent-sessions";
import { registerPricing, unregisterPricing } from "../src/runtime/pricing";

const roots: string[] = [];
const adapters: string[] = [];
const pricingIds: string[] = [];

afterEach(() => {
  while (adapters.length) unregisterBackendDefinition(adapters.pop()!);
  while (pricingIds.length) unregisterPricing(pricingIds.pop()!);
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("job admission service", () => {
  test("composes delegated approval policy without transferring bypass", () => {
    expect(delegatedApprovalPolicy("ask")).toBe("ask");
    expect(delegatedApprovalPolicy("auto")).toBe("auto");
    expect(delegatedApprovalPolicy("bypass")).toBe("auto");
  });
  test("preserves eligible FIFO order, emits positions, rejects overflow, and cancels queued work", async () => {
    const fixture = createFixture({ maxConcurrency: 1, maxQueued: 2 });
    const first = fixture.service.submit(run(fixture.backend, "first"), "coordinator");
    const second = fixture.service.submit(run(fixture.backend, "second"), "coordinator");
    const third = fixture.service.submit(run(fixture.backend, "third"), "coordinator");

    expect(fixture.started).toEqual(["first"]);
    expect(fixture.service.load()).toEqual({ activeJobs: 1, queuedJobs: 2 });
    expect(fixture.events.snapshot({ jobId: second.id }).events).toContainEqual(expect.objectContaining({
      kind: "lifecycle",
      detail: "queue position 1 of 2",
    }));
    expect(fixture.events.snapshot({ jobId: third.id }).events).toContainEqual(expect.objectContaining({
      kind: "lifecycle",
      detail: "queue position 2 of 2",
    }));

    let overflow: unknown;
    try {
      fixture.service.submit(run(fixture.backend, "overflow"), "coordinator");
    } catch (error) {
      overflow = error;
    }
    expect(overflow).toBeInstanceOf(HeadlessError);
    expect((overflow as HeadlessError).code).toBe("QUEUE_CAPACITY_EXCEEDED");
    expect(fixture.jobs.list()).toHaveLength(3);

    expect(fixture.service.cancel(second.id).state).toBe("cancelled");
    expect(fixture.service.load().queuedJobs).toBe(1);
    fixture.release("first");
    await waitUntil(() => fixture.started.includes("third"));
    expect(fixture.started).toEqual(["first", "third"]);
    fixture.release("third");
    await fixture.service.waitForIdle();
    fixture.service.dispose();
  });

  test("serializes writes while allowing a later read-only job to use spare capacity", async () => {
    const fixture = createFixture({ maxConcurrency: 2, maxQueued: 4 });
    fixture.service.submit(run(fixture.backend, "write-one", "write"), "coordinator");
    fixture.service.submit(run(fixture.backend, "write-two", "write"), "coordinator");
    fixture.service.submit(run(fixture.backend, "read", "read-only"), "coordinator");

    expect(fixture.started).toEqual(["write-one", "read"]);
    expect(fixture.service.load()).toEqual({ activeJobs: 2, queuedJobs: 1 });
    fixture.release("write-one");
    await waitUntil(() => fixture.started.includes("write-two"));
    expect(fixture.started).toEqual(["write-one", "read", "write-two"]);

    fixture.release("read");
    fixture.release("write-two");
    await fixture.service.waitForIdle();
    fixture.service.dispose();
  });

  test("expires queued work across its total lifecycle without starting it", async () => {
    const fixture = createFixture({ maxConcurrency: 1, maxQueued: 2 });
    fixture.service.submit(run(fixture.backend, "active", "read-only", 5_000), "coordinator");
    const queued = fixture.service.submit(run(fixture.backend, "expires", "read-only", 30), "coordinator");

    await waitUntil(() => fixture.jobs.get(queued.id)?.state === "timed_out", 2_000);
    expect(fixture.started).toEqual(["active"]);
    expect(fixture.jobs.get(queued.id)?.result?.error?.code).toBe("TIMED_OUT");
    expect(fixture.budgets.getReservation(queued.id)).toBeNull();
    expect(fixture.tasks.list({ jobId: queued.id })[0]?.state).toBe("failed");

    fixture.release("active");
    await fixture.service.waitForIdle();
    fixture.service.dispose();
  });

  test("durably pauses an ask-mode write and launches the same job after one-turn tool approval", async () => {
    const fixture = createFixture({ maxConcurrency: 1, maxQueued: 2 });
    const job = fixture.service.submit(run(fixture.backend, "approved-write", "write", 5_000, "ask"), "coordinator");

    expect(fixture.started).toEqual([]);
    expect(fixture.service.load()).toEqual({ activeJobs: 0, queuedJobs: 1 });
    const pending = fixture.approvals.list({ collaborationId: job.id, status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: "coder_tool", assignedTo: "coordinator" });

    const approval = fixture.approvals.resolveAsAdministrator(pending[0]!.id, "owner", "approved", "Allow this contained write turn.");
    expect(fixture.service.handleApprovalResolution(approval)).toBe(job.id);
    await waitUntil(() => fixture.started.includes("approved-write"));
    expect(fixture.approvedTurns).toEqual(["approved-write"]);

    fixture.release("approved-write");
    await fixture.service.waitForIdle();
    fixture.service.dispose();
  });

  test("terminalizes a rejected coder-tool request without launching or retaining budget", () => {
    const fixture = createFixture({ maxConcurrency: 1, maxQueued: 2 });
    const job = fixture.service.submit(run(fixture.backend, "rejected-write", "write", 5_000, "ask"), "coordinator");
    const pending = fixture.approvals.list({ collaborationId: job.id, status: "pending" })[0]!;

    const approval = fixture.approvals.resolveAsAdministrator(pending.id, "owner", "rejected", "Mutation was not approved.");
    expect(fixture.service.handleApprovalResolution(approval)).toBe(job.id);
    expect(fixture.started).toEqual([]);
    expect(fixture.jobs.get(job.id)).toMatchObject({ state: "blocked", result: { error: { code: "POLICY_DENIED" } } });
    expect(fixture.budgets.getReservation(job.id)).toBeNull();
    expect(fixture.tasks.list({ jobId: job.id })[0]?.state).toBe("failed");
    expect(fixture.service.load()).toEqual({ activeJobs: 0, queuedJobs: 0 });
    fixture.service.dispose();
  });

  test("cancels a pending coder-tool request with its queued ask-mode job", () => {
    const fixture = createFixture({ maxConcurrency: 1, maxQueued: 2 });
    const job = fixture.service.submit(run(fixture.backend, "cancelled-write", "write", 5_000, "ask"), "coordinator");
    const approval = fixture.approvals.list({ collaborationId: job.id, status: "pending" })[0]!;

    expect(fixture.service.cancel(job.id)).toMatchObject({ state: "cancelled" });
    expect(fixture.approvals.get(approval.id)).toMatchObject({
      status: "cancelled",
      resolution: "Job cancelled before coder-tool approval.",
    });
    expect(fixture.started).toEqual([]);
    expect(fixture.budgets.getReservation(job.id)).toBeNull();
    expect(fixture.service.load()).toEqual({ activeJobs: 0, queuedJobs: 0 });
    fixture.service.dispose();
  });

  test("expires a pending coder-tool request when the queued job reaches its lifecycle deadline", async () => {
    const fixture = createFixture({ maxConcurrency: 1, maxQueued: 2 });
    const job = fixture.service.submit(run(fixture.backend, "expired-write", "write", 30, "ask"), "coordinator");
    const approval = fixture.approvals.list({ collaborationId: job.id, status: "pending" })[0]!;

    await waitUntil(() => fixture.jobs.get(job.id)?.state === "timed_out", 2_000);
    expect(fixture.approvals.get(approval.id)?.status).not.toBe("pending");
    expect(fixture.started).toEqual([]);
    expect(fixture.budgets.getReservation(job.id)).toBeNull();
    expect(fixture.tasks.list({ jobId: job.id })[0]?.state).toBe("failed");
    expect(fixture.service.load()).toEqual({ activeJobs: 0, queuedJobs: 0 });
    fixture.service.dispose();
  });

  test("requires a fresh one-turn coder-tool approval after a crashed durable attempt", async () => {
    const fixture = createFixture({ maxConcurrency: 1, maxQueued: 2 });
    const request = RunRequestSchema.parse({
      ...run(fixture.backend, "retried-write", "write", 5_000, "ask"),
      projectRoot: fixture.paths.canonicalProjectRoot,
    });
    const job = fixture.jobs.create({
      projectId: fixture.paths.projectId,
      principal: "coordinator",
      request,
      maxAttempts: 2,
    });
    const firstApproval = fixture.approvals.create({
      collaborationId: job.id,
      requestedBy: job.principal,
      assignedTo: job.principal,
      kind: "coder_tool",
      summary: "Approve attempt one.",
      details: { attempt: 1, scope: "single-write-turn" },
      expiresAt: Date.now() + 5_000,
    });
    fixture.approvals.resolveAsAdministrator(firstApproval.id, "owner", "approved");
    fixture.jobs.claim(job.id, "crashed-daemon", 5_000);
    fixture.jobs.transition(job.id, "running");
    expect(fixture.jobs.recoverInterruptedJobs(true)[0]).toMatchObject({ id: job.id, state: "queued", attempt: 2 });

    fixture.service.recoverBudgetReservations();
    fixture.service.recoverQueuedJobs();

    expect(fixture.started).toEqual([]);
    const pending = fixture.approvals.list({ collaborationId: job.id, status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: "coder_tool", details: { attempt: 2, scope: "single-write-turn" } });
    expect(fixture.approvals.get(firstApproval.id)?.status).toBe("approved");

    const secondApproval = fixture.approvals.resolveAsAdministrator(pending[0]!.id, "owner", "approved");
    expect(fixture.service.handleApprovalResolution(secondApproval)).toBe(job.id);
    await waitUntil(() => fixture.started.includes("retried-write"));
    expect(fixture.approvedTurns).toEqual(["retried-write"]);
    fixture.release("retried-write");
    await fixture.service.waitForIdle();
    fixture.service.dispose();
  });

  test("rejects named agents for adapters that do not explicitly support them", () => {
    const fixture = createFixture({ maxConcurrency: 1, maxQueued: 2 });
    expect(() => fixture.service.submit({ ...run(fixture.backend, "ignored-agent"), agent: "reviewer" }, "coordinator"))
      .toThrow("does not support named agents");
    expect(fixture.jobs.list()).toHaveLength(0);
    fixture.service.dispose();
  });

  test("rejects every persisted-session conflict before creating a job or reserving budget", () => {
    const fixture = createFixture({ maxConcurrency: 1, maxQueued: 2 });
    const session = fixture.sessions.create({
      principal: "coordinator",
      backend: fixture.backend,
      model: "persisted-model",
      containment: "required",
      authMode: "native-login",
      approvalPolicy: "ask",
    });
    const conflicting = [
      { backend: "codex" },
      { model: "different-model" },
      { agent: "reviewer" },
      { containment: "unsafe" },
      { authMode: "broker" },
      { approvalPolicy: "auto" },
      { mode: "write" },
    ];
    for (const conflict of conflicting) {
      try {
        fixture.service.submit({
          sessionId: session.id,
          prompt: "conflicting session turn",
          timeoutMs: 5_000,
          ...conflict,
        }, "coordinator");
        throw new Error("Expected persisted-session conflict.");
      } catch (error) {
        expect(error).toMatchObject({ code: "CONFLICT" });
      }
      expect(fixture.jobs.list()).toHaveLength(0);
      expect(fixture.budgets.getState().reservations).toHaveLength(0);
    }
    expect(() => fixture.service.submit({
      sessionId: session.id,
      prompt: "cross-principal turn",
      timeoutMs: 5_000,
    }, "other-principal")).toThrow("cannot cross authenticated principals");
    expect(fixture.jobs.list()).toHaveLength(0);
    expect(fixture.budgets.getState().reservations).toHaveLength(0);
    fixture.service.dispose();
  });

  test("keeps the durable terminal job authoritative when completion event persistence fails", async () => {
    const fixture = createFixture({ maxConcurrency: 1, maxQueued: 2 });
    fixture.service.submit(run(fixture.backend, "active"), "coordinator");
    const queued = fixture.service.submit(run(fixture.backend, "terminal-without-event"), "coordinator");
    fixture.events.reconcileTerminal = (() => { throw new Error("injected terminal event failure"); }) as typeof fixture.events.reconcileTerminal;

    expect(fixture.service.cancel(queued.id)).toMatchObject({
      state: "cancelled",
      result: { status: "cancelled", jobId: queued.id },
    });
    expect(fixture.jobs.get(queued.id)).toMatchObject({ state: "cancelled", result: { status: "cancelled" } });
    expect(fixture.budgets.getReservation(queued.id)).toBeNull();

    fixture.release("active");
    await fixture.service.waitForIdle();
    fixture.service.dispose();
  });

  test("admits one child immediately, replays its request id, and never queues behind the parent", async () => {
    const fixture = createFixture({ maxConcurrency: 2, maxQueued: 2 });
    const childBackend = `delegated-${crypto.randomUUID()}`;
    registerBackendDefinition(adapter(childBackend));
    adapters.push(childBackend);
    const parent = fixture.service.submit({ ...run(fixture.backend, "parent", "read-only", 30_000), authMode: "broker" }, "coordinator");
    await waitUntil(() => fixture.jobs.get(parent.id)?.state === "running");
    const requestId = crypto.randomUUID();
    const first = fixture.service.admitDelegation({
      parentJobId: parent.id,
      requestId,
      backend: childBackend,
      prompt: "bounded child",
      timeoutMs: 5_000,
      budgetFraction: 0.25,
    });
    expect(first.existing).toBe(false);
    expect(first.job.delegationOf).toMatchObject({ parentJobId: parent.id, requestId, depth: 1 });
    expect(fixture.service.admitDelegation({
      parentJobId: parent.id,
      requestId,
      backend: childBackend,
      prompt: "bounded child",
      timeoutMs: 5_000,
      budgetFraction: 0.25,
    })).toMatchObject({ existing: true, job: { id: first.job.id } });
    expect(() => fixture.service.admitDelegation({
      parentJobId: parent.id,
      requestId: crypto.randomUUID(),
      backend: childBackend,
      prompt: "second child",
      timeoutMs: 5_000,
      budgetFraction: 0.25,
    })).toThrow("single delegated child");
    expect(fixture.service.load()).toEqual({ activeJobs: 2, queuedJobs: 0 });

    fixture.release("bounded child");
    fixture.release("parent");
    await fixture.service.waitForIdle();
    fixture.service.dispose();
  });

  test("admits one cross-provider child through canonical linked holds and hands off one unretained target bearer", async () => {
    const fixture = createFixture({ maxConcurrency: 2, maxQueued: 2 });
    const parentBackend = `linked-parent-${crypto.randomUUID()}`;
    const childBackend = `linked-child-${crypto.randomUUID()}`;
    registerBackendDefinition(adapter(parentBackend, { provider: "anthropic", strictAuth: "broker-api-key" }));
    registerBackendDefinition(adapter(childBackend, { provider: "openai", strictAuth: "broker-api-key" }));
    adapters.push(parentBackend, childBackend);
    for (const [id, provider, model, rate] of [
      [`parent-pricing-${crypto.randomUUID()}`, "anthropic", "parent-model", 1_000],
      [`child-pricing-${crypto.randomUUID()}`, "openai", "child-model", 1],
    ] as const) {
      registerPricing({ id, provider, model, effectiveFrom: 0, inputUsdPerMillion: rate, outputUsdPerMillion: rate });
      pricingIds.push(id);
    }
    const oldAnthropic = process.env.ANTHROPIC_API_KEY;
    const oldOpenAi = process.env.OPENAI_API_KEY;
    process.env.ANTHROPIC_API_KEY = "fixture-parent-key";
    process.env.OPENAI_API_KEY = "fixture-target-key";
    try {
      await fixture.broker.start(0);
      const parent = fixture.service.submit({
        ...run(parentBackend, "parent with transferable provider authority", "read-only", 30_000, "bypass"),
        authMode: "broker",
        model: "parent-model",
      }, "coordinator");
      await waitUntil(() => fixture.jobs.get(parent.id)?.state === "running");
      fixture.broker.issueLease({
        runId: parent.id,
        provider: "anthropic",
        models: ["parent-model"],
        endpointClasses: ["messages"],
        expiresAt: Date.now() + 30_000,
        maxRequests: 8,
        maxCostUsd: 5,
      });
      const requestId = crypto.randomUUID();
      const child = fixture.service.admitDelegation({
        parentJobId: parent.id,
        requestId,
        backend: childBackend,
        model: "child-model",
        prompt: "bounded cross-provider child",
        timeoutMs: 5_000,
        budgetFraction: 0.25,
      }).job;
      expect(fixture.service.admitDelegation({
        parentJobId: parent.id,
        requestId,
        backend: childBackend,
        model: "child-model",
        prompt: "bounded cross-provider child",
        timeoutMs: 5_000,
        budgetFraction: 0.25,
      })).toMatchObject({ existing: true, job: { id: child.id } });

      const [hold] = fixture.budgets.getState().linkedHolds;
      expect(hold).toMatchObject({
        state: "leased",
        transitionNumber: 4,
        parentJobId: parent.id,
        childJobId: child.id,
        childReservationId: child.id,
        parentProvider: "anthropic",
        targetProvider: "openai",
        parentCarveId: `${hold!.linkId}:parent`,
        targetQuotaId: `headless-linked-target-${hold!.linkId}`,
        brokerEvidence: {
          parentCarveId: `${hold!.linkId}:parent`,
          targetLeaseId: `${hold!.linkId}:target`,
          targetTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          targetQuotaScope: {
            provider: "openai",
            runQuotaId: `headless-linked-target-${hold!.linkId}`,
          },
        },
      });
      expect(fixture.budgets.getReservation(child.id)).toMatchObject({
        active: true,
        provider: "openai",
        parentReservationId: parent.id,
      });
      expect(fixture.executionControls.get(child.id)?.linkedBrokerLease).toMatchObject({
        linkId: hold!.linkId,
        id: `${hold!.linkId}:target`,
        provider: "openai",
      });
      expect(JSON.stringify(fixture.budgets.getState())).not.toContain("fixture-target-key");
      expect(JSON.stringify(fixture.budgets.getState())).not.toContain(fixture.executionControls.get(child.id)!.linkedBrokerLease!.token);
      expect(() => fixture.budgets.commit(child.id)).toThrow("ordinary commit is prohibited");

      fixture.release("bounded cross-provider child");
      fixture.release("parent with transferable provider authority");
      await fixture.service.waitForIdle();
      fixture.service.dispose();
    } finally {
      await fixture.broker.stop();
      restoreEnv("ANTHROPIC_API_KEY", oldAnthropic);
      restoreEnv("OPENAI_API_KEY", oldOpenAi);
    }
  });

  test("keeps broker-authenticated same-provider delegation on the v1 reservation and carve path", async () => {
    const fixture = createFixture({ maxConcurrency: 2, maxQueued: 2 });
    const parentBackend = `same-provider-parent-${crypto.randomUUID()}`;
    const childBackend = `same-provider-child-${crypto.randomUUID()}`;
    registerBackendDefinition(adapter(parentBackend, { provider: "openai", strictAuth: "broker-api-key" }));
    registerBackendDefinition(adapter(childBackend, { provider: "openai", strictAuth: "broker-api-key" }));
    adapters.push(parentBackend, childBackend);
    for (const [id, model, rate] of [
      [`same-parent-pricing-${crypto.randomUUID()}`, "same-parent-model", 1_000],
      [`same-child-pricing-${crypto.randomUUID()}`, "same-child-model", 1],
    ] as const) {
      registerPricing({ id, provider: "openai", model, effectiveFrom: 0, inputUsdPerMillion: rate, outputUsdPerMillion: rate });
      pricingIds.push(id);
    }
    const oldOpenAi = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "fixture-same-provider-key";
    try {
      await fixture.broker.start(0);
      const parent = fixture.service.submit({
        ...run(parentBackend, "same-provider parent", "read-only", 30_000, "auto"),
        authMode: "broker",
        model: "same-parent-model",
      }, "coordinator");
      await waitUntil(() => fixture.jobs.get(parent.id)?.state === "running");
      fixture.broker.issueLease({
        runId: parent.id,
        provider: "openai",
        models: ["same-parent-model"],
        endpointClasses: ["responses"],
        expiresAt: Date.now() + 30_000,
        maxRequests: 8,
        maxCostUsd: 5,
      });
      const child = fixture.service.admitDelegation({
        parentJobId: parent.id,
        requestId: crypto.randomUUID(),
        backend: childBackend,
        model: "same-child-model",
        prompt: "same-provider child",
        timeoutMs: 5_000,
        budgetFraction: 0.25,
      }).job;

      expect(fixture.budgets.getState().linkedHolds).toEqual([]);
      expect(fixture.budgets.getReservation(child.id)).toMatchObject({
        provider: "openai",
        parentReservationId: parent.id,
        budgetIds: fixture.budgets.getReservation(parent.id)!.budgetIds,
      });
      expect(fixture.executionControls.get(child.id)?.linkedBrokerLease).toBeUndefined();

      fixture.release("same-provider child");
      fixture.release("same-provider parent");
      await fixture.service.waitForIdle();
      fixture.service.dispose();
    } finally {
      await fixture.broker.stop();
      restoreEnv("OPENAI_API_KEY", oldOpenAi);
    }
  });

  test("fails delegation immediately when maxConcurrency one is occupied by its parent", async () => {
    const fixture = createFixture({ maxConcurrency: 1, maxQueued: 2 });
    const targetBackend = `capacity-child-${crypto.randomUUID()}`;
    registerBackendDefinition(adapter(targetBackend));
    adapters.push(targetBackend);
    const parent = fixture.service.submit({ ...run(fixture.backend, "sole parent", "read-only", 30_000), authMode: "broker" }, "coordinator");
    await waitUntil(() => fixture.jobs.get(parent.id)?.state === "running");
    let denied: unknown;
    try {
      fixture.service.admitDelegation({
        parentJobId: parent.id,
        requestId: crypto.randomUUID(),
        backend: targetBackend,
        prompt: "must not queue",
        timeoutMs: 5_000,
        budgetFraction: 0.25,
      });
    } catch (error) {
      denied = error;
    }
    expect(denied).toMatchObject({ code: "DELEGATION_CAPACITY_UNAVAILABLE", retryable: true });
    expect(fixture.service.load()).toEqual({ activeJobs: 1, queuedJobs: 0 });
    fixture.release("sole parent");
    await fixture.service.waitForIdle();
    fixture.service.dispose();
  });

  test("cascades parent cancellation to its live delegated child", async () => {
    const fixture = createFixture({ maxConcurrency: 2, maxQueued: 2 });
    const childBackend = `cancel-child-${crypto.randomUUID()}`;
    registerBackendDefinition(adapter(childBackend));
    adapters.push(childBackend);
    const parent = fixture.service.submit({ ...run(fixture.backend, "cancel parent", "read-only", 30_000), authMode: "broker" }, "coordinator");
    await waitUntil(() => fixture.jobs.get(parent.id)?.state === "running");
    const child = fixture.service.admitDelegation({
      parentJobId: parent.id,
      requestId: crypto.randomUUID(),
      backend: childBackend,
      prompt: "cancel child",
      timeoutMs: 5_000,
      budgetFraction: 0.25,
    }).job;
    await waitUntil(() => fixture.jobs.get(child.id)?.state === "running");
    fixture.service.cancel(parent.id);
    expect(fixture.jobs.get(parent.id)?.state).toBe("cancelling");
    expect(fixture.jobs.get(child.id)?.state).toBe("cancelling");
    expect(fixture.aborted).toEqual([child.id, parent.id]);
    fixture.release("cancel child");
    fixture.release("cancel parent");
    await fixture.service.waitForIdle();
    expect(fixture.jobs.get(child.id)?.state).toBe("cancelled");
    expect(fixture.jobs.get(parent.id)?.state).toBe("cancelled");
    fixture.service.dispose();
  });

  test("recovers an interrupted parent and child with fail-closed child-slice exhaustion", () => {
    const fixture = createFixture({ maxConcurrency: 2, maxQueued: 2 });
    const childBackend = `recovery-child-${crypto.randomUUID()}`;
    registerBackendDefinition(adapter(childBackend));
    adapters.push(childBackend);
    const parentRequest = RunRequestSchema.parse({
      ...run(fixture.backend, "recovery parent", "read-only", 30_000),
      projectRoot: fixture.paths.canonicalProjectRoot,
      authMode: "broker",
    });
    const parent = fixture.jobs.create({ projectId: fixture.paths.projectId, principal: "coordinator", request: parentRequest });
    fixture.budgets.reserve({
      id: parent.id,
      projectId: fixture.paths.projectId,
      principal: parent.principal,
      provider: null,
      inputTokens: 1_000,
      outputTokens: 4_096,
      costUsd: null,
    });
    fixture.budgets.activate(parent.id);
    fixture.jobs.claim(parent.id, "crashed-daemon", 30_000);
    fixture.jobs.transition(parent.id, "running");
    const childRequest = RunRequestSchema.parse({
      ...run(childBackend, "recovery child", "read-only", 5_000),
      projectRoot: fixture.paths.canonicalProjectRoot,
      authMode: "broker",
    });
    const childId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const carved = fixture.budgets.subreserveDelegation({
      id: childId,
      parentReservationId: parent.id,
      requestId,
      provider: null,
      inputTokens: 100,
      outputTokens: 4_096,
      costUsd: null,
    });
    expect(carved.allowed).toBe(true);
    fixture.budgets.activate(childId);
    const child = fixture.jobs.create({
      id: childId,
      projectId: fixture.paths.projectId,
      principal: parent.principal,
      request: childRequest,
      delegationOf: { parentJobId: parent.id, requestId, depth: 1, budgetFraction: 0.25 },
    });
    fixture.jobs.claim(child.id, "crashed-daemon", 5_000);
    fixture.jobs.transition(child.id, "running");

    expect(fixture.jobs.recoverInterruptedJobs(true).map((job) => job.id).sort()).toEqual([child.id, parent.id].sort());
    fixture.service.recoverBudgetReservations();
    expect(fixture.budgets.getState().reservations).toHaveLength(0);
    expect(fixture.jobs.get(child.id)?.delegationOf).toMatchObject({ parentJobId: parent.id, requestId, depth: 1 });
    expect(fixture.jobs.get(child.id)?.result?.error?.message).toBe("Daemon stopped while the job lease was active.");
    fixture.service.dispose();
  });
});

function createFixture(limits: { maxConcurrency: number; maxQueued: number }) {
  const root = mkdtempSync(join(tmpdir(), "headless-admission-service-"));
  roots.push(root);
  const project = join(root, "project");
  mkdirSync(project);
  const paths = ensureProjectStateDirectories(getProjectStatePaths(project, {
    env: { ...process.env, HEADLESS_STATE_HOME: join(root, "state") },
  }));
  const backend = `admission-${crypto.randomUUID()}`;
  registerBackendDefinition(adapter(backend));
  adapters.push(backend);
  const jobs = new JobStore(paths.jobsDir);
  const tasks = new TaskStore(paths.tasksDir, { recoverOnOpen: false });
  const events = new RunEventStore(paths.runEventsPath, { compactOnOpen: false });
  const budgets = new BudgetStore(paths);
  const approvals = new ApprovalStore(paths, { expiryActor: "coordinator" });
  const sessions = new PersistentSessionStore(paths);
  const started: string[] = [];
  const approvedTurns: string[] = [];
  const aborted: string[] = [];
  const executionControls = new Map<string, RunExecutionControls>();
  const releases = new Map<string, () => void>();

  const broker = new ProviderBroker();

  const service = new JobAdmissionService({
    projectId: paths.projectId,
    projectRoot: paths.canonicalProjectRoot,
    ...limits,
    jobs,
    tasks,
    runEvents: events,
    approvals,
    sessions,
    trust: new ProjectTrustStore(paths),
    authority: new AuthorityStore(paths, { coordinator: "coordinator" }),
    budgets,
    broker,
    activeLeadBackend: () => null,
    isStopping: () => false,
    execute: async (jobId, request, controls) => {
      executionControls.set(jobId, controls);
      jobs.claim(jobId, "test-daemon", request.timeoutMs);
      jobs.transition(jobId, "running");
      started.push(request.prompt);
      if (controls.coderToolApproved) approvedTurns.push(request.prompt);
      await new Promise<void>((resolve) => releases.set(request.prompt, resolve));
      budgets.commit(jobId);
      const cancelled = jobs.get(jobId)?.state === "cancelling";
      jobs.complete(jobId, cancelled ? {
        ...daemonFailureResult(request, jobId, "fixture cancellation"),
        status: "cancelled",
        error: { code: "CANCELLED", message: "fixture cancellation", retryable: false },
        output: "fixture cancellation",
      } : {
        ...daemonFailureResult(request, jobId, "fixture success"),
        status: "succeeded",
        error: null,
        output: request.prompt,
      });
    },
    abort: (jobId) => { aborted.push(jobId); },
    completed: () => undefined,
  });

  return {
    paths,
    backend,
    jobs,
    tasks,
    events,
    budgets,
    broker,
    approvals,
    sessions,
    service,
    started,
    approvedTurns,
    aborted,
    executionControls,
    release(prompt: string) {
      const resolve = releases.get(prompt);
      if (!resolve) throw new Error(`No active fixture execution for ${prompt}.`);
      releases.delete(prompt);
      resolve();
    },
  };
}

function run(
  backend: string,
  prompt: string,
  mode: "read-only" | "write" = "read-only",
  timeoutMs = 5_000,
  approvalPolicy: "ask" | "auto" | "bypass" = mode === "write" ? "auto" : "ask",
) {
  return {
    backend,
    prompt,
    mode,
    timeoutMs,
    containment: "required",
    authMode: "native-login",
    approvalPolicy,
  } satisfies Partial<SerializedRunRequest>;
}

function adapter(id: string, options: { provider?: string; strictAuth?: "broker-api-key" | "credential-free" } = {}): BackendDefinition {
  return {
    id,
    metadata: {
      id,
      aliases: [],
      promptDelivery: "argv",
      timeoutMs: 5_000,
      maxDepth: null,
      canRead: true,
      canWrite: true,
    },
    capabilities: {
      write: true,
      streaming: false,
      structuredOutput: false,
      nativeResume: false,
      cancellation: true,
      tools: false,
      effort: false,
      brokerCompatible: options.strictAuth === "broker-api-key",
    },
    security: {
      outerContainmentRequired: true,
      strictAuth: options.strictAuth ?? "credential-free",
      disablesProjectConfig: true,
      disablesHooks: true,
      disablesMcp: true,
      disablesSkills: true,
    },
    probe: {
      versionCommand: ["/usr/bin/true"],
      helpCommand: ["/usr/bin/true"],
      requiredHelpFragments: [],
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    },
    stdinPrompt: false,
    credentialPrefixes: [],
    provider: options.provider,
    prepareCommand: () => ["/usr/bin/true"],
    decodeOutput: () => ({
      output: "",
      stderr: "",
      tokens: null,
      model: null,
      sessionId: null,
      malformedLines: 0,
      rawEvents: [],
    }),
  };
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function waitUntil(check: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for fixture state.");
    await Bun.sleep(5);
  }
}
