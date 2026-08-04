import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunRequestSchema, type RunResult } from "../src/contracts/run";
import { JobStore } from "../src/daemon/job-store";
import { WorkflowService, type WorkflowSubmitOptions } from "../src/daemon/workflow-service";
import { FinalityStore } from "../src/runtime/finality-store";
import { ensureProjectStateDirectories, getProjectStatePaths } from "../src/runtime/project-state";
import type { AuthenticatedCredential } from "../src/runtime/credential-store";
import { schedulingDeadline, schedulingWindow, setTestTimeout } from "./support/timing";

// The harness observes each step's product deadline plus the service's own 10s
// margin, so the longest step here (30s) is a 40s window. Under bun's 5s default
// the harness threw before the workflow could reach any terminal state.
setTestTimeout(40_000);

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("WorkflowService", () => {
  test("passes durable dependency output to a later step and evaluates finality", async () => {
    const harness = createHarness((request) => request.prompt.includes("review the seed")
      ? request.prompt.includes("seed-output") ? succeeded("review-saw-actual-seed") : succeeded("review-missed-seed")
      : succeeded("seed-output"));

    const workflow = harness.service.create({
      id: "service-dependency-workflow",
      requirements: { policy: true, tests: false, review: true, vote: false, budget: true },
      steps: [
        { id: "seed", backend: "opencode", prompt: "produce seed", timeoutMs: 5_000 },
        { id: "review", kind: "review", backend: "opencode", prompt: "review the seed", dependsOn: ["seed"], timeoutMs: 5_000 },
      ],
    }, credential());

    const completed = await harness.service.wait(workflow.id, 5_000);
    expect(completed.state).toBe("succeeded");
    expect(completed.finality?.allowed).toBe(true);
    expect(completed.steps[1]?.result?.output).toBe("review-saw-actual-seed");
    expect(completed.steps.every((step) => harness.jobs.get(step.lastJobId!)?.workflowId === workflow.id)).toBe(true);
  });

  /**
   * Blast-radius containment: one node dying must not silence the rest of the
   * graph. A required dependency still blocks, but an optional one only has to
   * settle, and its failure is handed to the dependent as evidence.
   */
  test("runs a step whose optional dependency failed and gives it the failure as evidence", async () => {
    const harness = createHarness((request) => request.prompt.includes("verify")
      ? succeeded(request.prompt.includes("broken-repair") ? "verifier-saw-the-failure" : "verifier-was-blind")
      : request.prompt.includes("fix b") ? failed("broken-repair", false) : succeeded("fixed-a"));

    const workflow = harness.service.create({
      id: "optional-dependency-workflow",
      steps: [
        { id: "fix-a", backend: "opencode", prompt: "fix a", timeoutMs: 5_000 },
        { id: "fix-b", backend: "opencode", prompt: "fix b", timeoutMs: 5_000 },
        { id: "verify", kind: "test", backend: "opencode", prompt: "verify", optionalDependsOn: ["fix-a", "fix-b"], timeoutMs: 5_000 },
      ],
    }, credential());

    const completed = await harness.service.wait(workflow.id, schedulingWindow(5_000));
    const verify = completed.steps.find((step) => step.id === "verify")!;
    expect(verify.state).toBe("succeeded");
    expect(verify.result?.output).toBe("verifier-saw-the-failure");
    // The failed sibling is still a failure; the workflow does not pretend otherwise.
    expect(completed.steps.find((step) => step.id === "fix-b")?.state).toBe("failed");
    expect(completed.state).toBe("failed");
  });

  test("still blocks a step whose required dependency failed", async () => {
    const harness = createHarness((request) => request.prompt.includes("fix")
      ? failed("broken", false)
      : succeeded("should-not-run"));

    const workflow = harness.service.create({
      id: "required-dependency-workflow",
      steps: [
        { id: "fix", backend: "opencode", prompt: "fix", timeoutMs: 5_000 },
        { id: "after", backend: "opencode", prompt: "after", dependsOn: ["fix"], timeoutMs: 5_000 },
      ],
    }, credential());

    const completed = await harness.service.wait(workflow.id, schedulingWindow(5_000));
    expect(completed.steps.find((step) => step.id === "after")?.state).toBe("blocked");
    expect(completed.state).toBe("blocked");
  });

  test("rejects a dependency declared both required and optional", () => {
    const harness = createHarness(() => succeeded("unused"));
    expect(() => harness.service.create({
      id: "conflicting-dependency-workflow",
      steps: [
        { id: "a", backend: "opencode", prompt: "a", timeoutMs: 5_000 },
        { id: "b", backend: "opencode", prompt: "b", dependsOn: ["a"], optionalDependsOn: ["a"], timeoutMs: 5_000 },
      ],
    }, credential())).toThrow();
  });

  test("rejects a cycle formed through optional edges", () => {
    const harness = createHarness(() => succeeded("unused"));
    expect(() => harness.service.create({
      id: "optional-cycle-workflow",
      steps: [
        { id: "a", backend: "opencode", prompt: "a", optionalDependsOn: ["b"], timeoutMs: 5_000 },
        { id: "b", backend: "opencode", prompt: "b", optionalDependsOn: ["a"], timeoutMs: 5_000 },
      ],
    }, credential())).toThrow();
  });

  test("retries ordinary failed work up to the durable step attempt bound", async () => {
    let calls = 0;
    const retryNumbers: number[] = [];
    const harness = createHarness((_request, options) => {
      calls += 1;
      retryNumbers.push(options.retryNumber);
      return calls === 1
        ? failed("temporary failure", true)
        : succeeded("recovered");
    });

    const workflow = harness.service.create({
      id: "service-retry-workflow",
      steps: [{ id: "retry", backend: "opencode", prompt: "retry me", maxAttempts: 2, timeoutMs: 5_000 }],
    }, credential());
    const completed = await harness.service.wait(workflow.id, 5_000);

    expect(completed.state).toBe("succeeded");
    expect(completed.steps[0]?.attempt).toBe(2);
    expect(completed.steps[0]?.jobIds).toHaveLength(2);
    expect(retryNumbers).toEqual([0, 1]);
  });

  test("recovers a durable queued workflow after service construction", async () => {
    const harness = createHarness(() => succeeded("recovered-after-restart"));
    const stored = harness.service.store.create({
      id: "service-recovery-workflow",
      principal: "coordinator",
      sessionId: null,
      authMode: "native-login",
      approvalPolicy: "ask",
      requirements: { policy: true, tests: false, review: false, vote: false, budget: true },
      steps: [{
        id: "resume",
        kind: "execution",
        backend: "opencode",
        prompt: "resume durable work",
        mode: "read-only",
        authMode: "native-login",
        approvalPolicy: "ask",
        model: null,
        agent: null,
        timeoutMs: 5_000,
        dependsOn: [],
        maxAttempts: 1,
      }],
    });

    expect(harness.service.recover()).toBe(1);
    expect(harness.service.recover()).toBe(0);
    const completed = await harness.service.wait(stored.id, 5_000);
    expect(completed.state).toBe("succeeded");
    expect(completed.steps[0]?.result?.output).toBe("recovered-after-restart");
  });

  test("cancels the bound active job and resolves every unstarted step", async () => {
    const harness = createHarness(() => null);
    const workflow = harness.service.create({
      id: "service-cancel-workflow",
      steps: [
        { id: "slow", backend: "opencode", prompt: "stay active", timeoutMs: 30_000 },
        { id: "never", backend: "opencode", prompt: "never run", dependsOn: ["slow"], timeoutMs: 5_000 },
      ],
    }, credential());
    await waitFor(() => harness.service.require(workflow.id).steps[0]?.state === "running");

    harness.service.cancel(workflow.id);
    const completed = await harness.service.wait(workflow.id, 5_000);

    expect(completed.state).toBe("cancelled");
    expect(completed.error?.code).toBe("CANCELLED");
    expect(completed.steps.every((step) => step.state === "cancelled")).toBe(true);
    expect(harness.cancelledJobs).toHaveLength(1);
  });
});

function createHarness(
  resultFor: (request: ReturnType<typeof RunRequestSchema.parse>, options: WorkflowSubmitOptions) => Omit<RunResult, "backend" | "jobId" | "sessionId"> | null,
) {
  const root = mkdtempSync(join(tmpdir(), "headless-workflow-service-"));
  roots.push(root);
  const projectRoot = join(root, "project");
  mkdirSync(projectRoot);
  const paths = ensureProjectStateDirectories(getProjectStatePaths(projectRoot, {
    env: { ...process.env, HEADLESS_STATE_HOME: join(root, "state") },
  }));
  const jobs = new JobStore(paths.jobsDir);
  const finality = new FinalityStore(paths);
  const cancelledJobs: string[] = [];
  const service = new WorkflowService({
    paths,
    projectRoot,
    isStopping: () => false,
    assertSessionOwnership: () => undefined,
    estimate: () => ({ cost: { amountUsd: null } }),
    authorize: () => ({
      allowed: true,
      coordinator: true,
      grantId: null,
      mergeAllowed: true,
      maxCostUsd: null,
      reason: "test coordinator",
    }),
    submit: (params, principal, options) => {
      const request = RunRequestSchema.parse({ ...params, projectRoot });
      let job = jobs.create({
        projectId: paths.projectId,
        principal,
        request,
        workflowId: options.workflowId,
        mergePolicy: options.mergePolicy,
        retryNumber: options.retryNumber,
      });
      job = jobs.claim(job.id, "workflow-test", 60_000);
      job = jobs.transition(job.id, "running");
      const result = resultFor(request, options);
      if (result) queueMicrotask(() => jobs.complete(job.id, { ...result, backend: request.backend, jobId: job.id, sessionId: request.sessionId ?? null }));
      return job;
    },
    getJob: (jobId) => jobs.get(jobId),
    getJobRequest: (jobId) => jobs.request(jobId),
    waitJob: async (jobId, timeoutMs) => {
      // The caller's timeout is a product deadline; this harness only observes
      // it, so the observation ceiling scales with the machine.
      const deadline = schedulingDeadline(timeoutMs);
      for (;;) {
        const job = jobs.get(jobId);
        if (!job) throw new Error(`Unknown test job: ${jobId}`);
        if (job.result) return job;
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for test job: ${jobId}`);
        await Bun.sleep(1);
      }
    },
    cancelJob: (jobId) => {
      cancelledJobs.push(jobId);
      const job = jobs.get(jobId);
      if (!job || job.result) return;
      jobs.transition(jobId, "cancelling");
      jobs.complete(jobId, { ...cancelled(), backend: job.backend, jobId, sessionId: job.sessionId });
    },
    evaluateFinality: (evaluation) => finality.evaluate(evaluation),
  });
  return { service, jobs, cancelledJobs };
}

function credential(): AuthenticatedCredential {
  return {
    id: "root",
    principal: "coordinator",
    kind: "root",
    scopes: ["admin"],
    createdAt: Date.now(),
    expiresAt: null,
    revokedAt: null,
  };
}

function succeeded(output: string) {
  return result("succeeded", output, null);
}

function failed(output: string, retryable: boolean) {
  return result("failed", output, { code: "PROCESS_ERROR", message: output, retryable });
}

function cancelled() {
  return result("cancelled", "cancelled", { code: "CANCELLED", message: "cancelled", retryable: false });
}

function result(
  status: RunResult["status"],
  output: string,
  error: RunResult["error"],
): Omit<RunResult, "backend" | "jobId" | "sessionId"> {
  return {
    status,
    error,
    output,
    stderr: "",
    diagnostics: { format: "test", malformedEvents: 0, ignoredEvents: 0, messages: [] },
    exitCode: status === "succeeded" ? 0 : 1,
    signal: null,
    usage: { input: null, output: null, reasoning: null, cached: null, providerTotal: null },
    cost: { amountUsd: null, source: "unknown", pricingId: null, observedRequests: 0 },
    containment: {
      requirement: "required",
      enforced: true,
      platform: "other",
      mechanism: "test",
      probe: null,
      isolatedHome: true,
      credentialsIsolated: true,
      network: "denied",
      credentialAccess: "none",
      unsafe: false,
    },
    durationMs: 1,
    diff: null,
    commit: null,
    truncation: { stdout: false, stderr: false, output: false, events: false, artifacts: false, diff: false },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + schedulingWindow(timeoutMs);
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for workflow service state.");
}
