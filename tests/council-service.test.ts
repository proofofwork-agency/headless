import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobSchema, type Job } from "../src/contracts/durable";
import { RunResultSchema } from "../src/contracts/run";
import { CouncilService } from "../src/daemon/council-service";
import { CouncilStore } from "../src/runtime/council-store";
import { FinalityStore } from "../src/runtime/finality-store";
import { ensureProjectStateDirectories, getProjectStatePaths } from "../src/runtime/project-state";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("CouncilService", () => {
  test("reconciles durable phase slots and grounds reviews and votes in actual jobs", async () => {
    const fixture = createFixture();
    const councils = new CouncilStore(fixture.paths);
    const finality = new FinalityStore(fixture.paths);
    const jobs = new Map<string, Job>();
    const prompts: string[] = [];
    let sequence = 0;
    let submitted = 0;
    const record = councils.create("recover and review", ["alpha", "beta"], "coordinator", {
      mode: "read-only",
      timeoutMs: 5_000,
    });
    const orphan = makeJob({
      id: "orphan-proposal",
      projectId: fixture.paths.projectId,
      backend: "alpha",
      councilId: record.council.id,
      councilSlot: "proposalJobs:0",
      output: "durable orphan proposal evidence",
    });
    jobs.set(orphan.id, orphan);

    const tracked: Promise<void>[] = [];
    const service = new CouncilService({
      projectId: fixture.paths.projectId,
      councils,
      jobs: {
        get: (id) => jobs.get(id) ?? null,
        list: () => [...jobs.values()],
        request: () => ({ timeoutMs: 5_000 }),
      },
      submit: (params, principal, options) => {
        submitted += 1;
        const prompt = String(params.prompt);
        prompts.push(prompt);
        const id = `phase-${++sequence}`;
        let output = "proposal evidence";
        let patch: string | null = null;
        if (prompt.includes("EXECUTION PHASE")) {
          output = "actual candidate evidence";
          patch = "diff --git a/result.txt b/result.txt\n+actual candidate patch";
        }
        if (prompt.includes("REVIEW PHASE")) output = "review of actual candidate evidence and patch";
        if (prompt.includes("VOTE PHASE")) {
          const reference = prompt.match(/Eligible review job IDs \(another participant only\): ([^,\n]+)/)?.[1]?.trim();
          output = JSON.stringify({ vote: "approve", references: [reference], rationale: "grounded review passed" });
        }
        const job = makeJob({
          id,
          projectId: fixture.paths.projectId,
          principal,
          backend: String(params.backend),
          mode: params.mode === "write" ? "write" : "read-only",
          councilId: options.councilId,
          councilSlot: options.councilSlot,
          mergePolicy: options.mergePolicy,
          output,
          patch,
        });
        jobs.set(id, job);
        return job;
      },
      wait: async () => { throw new Error("completed fixtures must not wait"); },
      authorize: () => ({ allowed: true, reason: "test coordinator" }),
      resolveBackend: (backend) => backend,
      getBackend: () => ({ capabilities: { write: false } } as never),
      latestFinality: (jobId) => finality.latest(jobId),
      listFinality: () => finality.list().map(({ decision }) => decision),
      evaluateFinality: (input) => finality.evaluate(input),
      trackExecution: (execution) => tracked.push(execution),
    });

    const result = await service.launch(record.council.id);
    await Promise.all(tracked);

    expect(result.decision?.approved, result.decision?.reason).toBe(true);
    expect(result.proposalJobs).toContain(orphan.id);
    expect(submitted).toBe(7);
    expect(prompts.find((prompt) => prompt.includes("REVIEW PHASE"))).toContain("actual candidate patch");
    expect(result.votes).toHaveLength(2);
    expect(result.votes.every((vote) => result.reviewJobs.includes(vote.references[0]))).toBe(true);
    expect(result.votes.every((vote) => !result.reviewJobs.includes(vote.jobId))).toBe(true);
  });

  test("rejects unsafe containment and duplicate attributable participants before creating state", async () => {
    const fixture = createFixture();
    const councils = new CouncilStore(fixture.paths);
    const finality = new FinalityStore(fixture.paths);
    const service = new CouncilService({
      projectId: fixture.paths.projectId,
      councils,
      jobs: { get: () => null, list: () => [], request: () => null },
      submit: () => { throw new Error("not reached"); },
      wait: async () => { throw new Error("not reached"); },
      authorize: () => ({ allowed: true, reason: "test coordinator" }),
      resolveBackend: (backend) => backend === "alias" ? "alpha" : backend,
      getBackend: () => null,
      latestFinality: (jobId) => finality.latest(jobId),
      listFinality: () => [],
      evaluateFinality: (input) => finality.evaluate(input),
    });

    await expect(service.run({ question: "unsafe", agents: ["alpha", "beta"], containment: "unsafe" }, "coordinator"))
      .rejects.toMatchObject({ code: "POLICY_DENIED" });
    await expect(service.run({ question: "aliases", agents: ["alpha", "alias"] }, "coordinator"))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(councils.list()).toHaveLength(0);
  });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "headless-council-service-"));
  roots.push(root);
  const project = join(root, "project");
  mkdirSync(project);
  const paths = ensureProjectStateDirectories(getProjectStatePaths(project, {
    env: { HEADLESS_STATE_HOME: join(root, "state") },
  }));
  return { paths };
}

function makeJob(input: {
  id: string;
  projectId: string;
  principal?: string;
  backend: string;
  mode?: "read-only" | "write";
  councilId: string;
  councilSlot: string;
  mergePolicy?: Job["mergePolicy"];
  output: string;
  patch?: string | null;
}) {
  const now = Date.now();
  return JobSchema.parse({
    id: input.id,
    projectId: input.projectId,
    principal: input.principal ?? "coordinator",
    sessionId: null,
    workflowId: null,
    councilId: input.councilId,
    councilSlot: input.councilSlot,
    backend: input.backend,
    mode: input.mode ?? "read-only",
    authMode: "native-login",
    approvalPolicy: "ask",
    mergePolicy: input.mergePolicy ?? "authorized",
    state: "succeeded",
    attempt: 1,
    maxAttempts: 2,
    retryNumber: 0,
    createdAt: now,
    updatedAt: now,
    leaseOwner: null,
    leaseExpiresAt: null,
    result: RunResultSchema.parse({
      status: "succeeded",
      error: null,
      backend: input.backend,
      output: input.output,
      stderr: "",
      diagnostics: { format: "fixture", malformedEvents: 0, ignoredEvents: 0, messages: [] },
      exitCode: 0,
      signal: null,
      usage: { input: null, output: null, reasoning: null, cached: null, providerTotal: null },
      cost: { amountUsd: null, source: "unknown", pricingId: null, observedRequests: 0 },
      containment: {
        requirement: "required",
        enforced: true,
        platform: "other",
        mechanism: "fixture",
        probe: null,
        isolatedHome: true,
        credentialsIsolated: true,
        network: "denied",
        credentialAccess: "none",
        unsafe: false,
      },
      durationMs: 1,
      sessionId: null,
      jobId: input.id,
      diff: input.patch === null || input.patch === undefined
        ? null
        : { patch: input.patch, status: "M result.txt", files: ["result.txt"], baseCommit: null, candidateCommit: null, resultingCommit: null },
      commit: null,
      truncation: { stdout: false, stderr: false, output: false, events: false, artifacts: false, diff: false },
    }),
  });
}
