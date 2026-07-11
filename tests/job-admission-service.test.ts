import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAdapter, unregisterAdapter, type BackendAdapter } from "../src/backends/registry";
import { RunRequestSchema, type SerializedRunRequest } from "../src/contracts/run";
import { JobAdmissionService, daemonFailureResult } from "../src/daemon/job-admission-service";
import { JobStore } from "../src/daemon/job-store";
import { RunEventStore } from "../src/daemon/run-event-store";
import { TaskStore } from "../src/daemon/task-store";
import { ApprovalStore } from "../src/runtime/approval-store";
import { AuthorityStore } from "../src/runtime/authority-store";
import { BudgetStore } from "../src/runtime/budget-store";
import { HeadlessError } from "../src/runtime/headless-error";
import { ensureProjectStateDirectories, getProjectStatePaths } from "../src/runtime/project-state";
import { ProjectTrustStore } from "../src/runtime/project-trust-store";

const roots: string[] = [];
const adapters: string[] = [];

afterEach(() => {
  while (adapters.length) unregisterAdapter(adapters.pop()!);
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("job admission service", () => {
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
  registerAdapter(adapter(backend));
  adapters.push(backend);
  const jobs = new JobStore(paths.jobsDir);
  const tasks = new TaskStore(paths.tasksDir, { recoverOnOpen: false });
  const events = new RunEventStore(paths.runEventsPath, { compactOnOpen: false });
  const budgets = new BudgetStore(paths);
  const approvals = new ApprovalStore(paths, { expiryActor: "coordinator" });
  const started: string[] = [];
  const approvedTurns: string[] = [];
  const releases = new Map<string, () => void>();

  const service = new JobAdmissionService({
    projectId: paths.projectId,
    projectRoot: paths.canonicalProjectRoot,
    ...limits,
    jobs,
    tasks,
    runEvents: events,
    approvals,
    trust: new ProjectTrustStore(paths),
    authority: new AuthorityStore(paths, { coordinator: "coordinator" }),
    budgets,
    isStopping: () => false,
    execute: async (jobId, request, controls) => {
      jobs.claim(jobId, "test-daemon", request.timeoutMs);
      jobs.transition(jobId, "running");
      started.push(request.prompt);
      if (controls.coderToolApproved) approvedTurns.push(request.prompt);
      await new Promise<void>((resolve) => releases.set(request.prompt, resolve));
      budgets.commit(jobId);
      jobs.complete(jobId, {
        ...daemonFailureResult(request, jobId, "fixture success"),
        status: "succeeded",
        error: null,
        output: request.prompt,
      });
    },
    abort: () => undefined,
    completed: () => undefined,
  });

  return {
    paths,
    backend,
    jobs,
    tasks,
    events,
    budgets,
    approvals,
    service,
    started,
    approvedTurns,
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

function adapter(id: string): BackendAdapter {
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
      brokerCompatible: false,
    },
    security: {
      outerContainmentRequired: true,
      strictAuth: "credential-free",
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
    buildCommand: () => ["/usr/bin/true"],
    parse: () => ({
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

async function waitUntil(check: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for fixture state.");
    await Bun.sleep(5);
  }
}
