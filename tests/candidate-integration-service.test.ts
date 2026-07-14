import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunRequestSchema, type RunResult } from "../src/contracts/run";
import { GrantSchema } from "../src/contracts/durable";
import { JobStore } from "../src/daemon/job-store";
import { ApprovalStore } from "../src/runtime/approval-store";
import { AuthorityStore } from "../src/runtime/authority-store";
import { CandidateDecisionStore } from "../src/runtime/candidate-decision-store";
import { CandidateIntegrationService } from "../src/runtime/candidate-integration-service";
import { FinalityStore } from "../src/runtime/finality-store";
import { getHeadSha, runGitStrict } from "../src/runtime/git";
import { IntegrationJournal } from "../src/runtime/integration-journal";
import { ensureProjectStateDirectories, getProjectStatePaths } from "../src/runtime/project-state";
import { WorktreeLeaseStore } from "../src/runtime/worktree-leases";
import { captureWriteDiff, createWriteWorktree, planWriteWorktree, removeWriteWorktree } from "../src/runtime/worktree";
import type { WriteGateContext, WriteGateDecision } from "../src/runtime/write-integration";

const roots: string[] = [];
const gitAvailable = runGitStrict(["--version"], process.cwd()).ok;
const gitTest = gitAvailable ? test : test.skip;

setDefaultTimeout(15_000);

const passed: WriteGateDecision = {
  policyPassed: true,
  testsPassed: true,
  reviewPassed: true,
  votePassed: false,
  budgetPassed: true,
  reasons: [],
  evidence: ["deterministic candidate gate passed"],
};

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("CandidateIntegrationService", () => {
  gitTest("recovers an output-overflow candidate only through advanced gates", async () => {
    let gateCalls = 0;
    const fixture = createFixture({
      outputOverflow: true,
      evaluateIntegrationGates: async () => { gateCalls += 1; return passed; },
    });

    expect((await fixture.service.inspect(fixture.jobId, admin())).eligible).toBe(false);
    const result = await fixture.service.integrate(fixture.jobId, admin());

    expect(gateCalls).toBe(1);
    expect(result.merged).toBe(true);
    expect(readFileSync(join(fixture.repo, "candidate.txt"), "utf8")).toBe("candidate\n");
    const decisions = fixture.finality.list().filter((record) => record.decision.jobId === fixture.jobId);
    expect(decisions.some((record) => record.decision.allowed && !record.requirements.tests && !record.requirements.review)).toBe(true);
    expect(decisions.at(-1)?.decision).toMatchObject({ allowed: true, testsPassed: true, reviewPassed: true });
  }, 15_000);

  gitTest("keeps an output-overflow candidate preserved when recovery gates fail", async () => {
    const fixture = createFixture({
      outputOverflow: true,
      evaluateIntegrationGates: async () => ({ ...passed, testsPassed: false, reasons: ["candidate tests failed"] }),
    });
    const primary = getHeadSha(fixture.repo);

    const result = await fixture.service.integrate(fixture.jobId, admin());

    expect(result.merged).toBe(false);
    expect(result.reason).toContain("candidate tests failed");
    expect(getHeadSha(fixture.repo)).toBe(primary);
    expect(existsSync(join(fixture.repo, "candidate.txt"))).toBe(false);
  });

  gitTest("requires explicit ask-mode approval before overflow recovery gates", async () => {
    let gateCalls = 0;
    const fixture = createFixture({
      outputOverflow: true,
      approvalPolicy: "ask",
      evaluateIntegrationGates: async () => { gateCalls += 1; return passed; },
    });

    await expect(fixture.service.integrate(fixture.jobId, admin())).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(gateCalls).toBe(0);
    const approval = fixture.approvals.list({ collaborationId: fixture.jobId, status: "pending" })[0]!;
    expect(approval).toMatchObject({ kind: "merge", details: { recovery: "output-overflow" } });
    fixture.approvals.resolveAsAdministrator(approval.id, "coordinator", "approved", "Reviewed recovery candidate.");

    const result = await fixture.service.integrate(fixture.jobId, admin());
    expect(gateCalls).toBe(1);
    expect(result.merged).toBe(true);
  });

  gitTest("fast-forwards an allowed auto candidate and persists the decision and journal", async () => {
    const fixture = createFixture();
    const originalHead = getHeadSha(fixture.repo);

    const result = await fixture.service.integrate(fixture.jobId, admin());

    expect(result.outcome).toBe("merged_fast_forward");
    expect(result.merged).toBe(true);
    expect(getHeadSha(fixture.repo)).toBe(fixture.candidateCommit);
    expect(getHeadSha(fixture.repo)).not.toBe(originalHead);
    expect(readFileSync(join(fixture.repo, "candidate.txt"), "utf8")).toBe("candidate\n");
    expect(fixture.service.decisions.get(fixture.jobId)).toMatchObject({
      status: "integrated",
      integratedBy: "coordinator",
      resultingCommit: fixture.candidateCommit,
    });
    expect(fixture.journal.get(fixture.jobId)).toMatchObject({ state: "completed", targetCommit: fixture.candidateCommit });
    expect(statSync(fixture.service.decisions.path).mode & 0o777).toBe(0o600);

    expect((await fixture.service.inspect(fixture.jobId, { actor: "worker" })).candidateAlreadyIntegrated).toBe(true);
    await expect(fixture.service.inspect(fixture.jobId, { actor: "stranger" })).rejects.toMatchObject({ code: "POLICY_DENIED" });
  });

  gitTest("merges an advanced primary only in an isolated worktree and re-runs gates", async () => {
    const observedCwds: string[] = [];
    const fixture = createFixture({
      evaluateIntegrationGates: async (context) => {
        observedCwds.push(context.cwd);
        expect(context.cwd).not.toBe(fixture.repo);
        expect(getHeadSha(fixture.repo)).toBe(fixture.advancedHead);
        expect(readFileSync(join(context.cwd, "candidate.txt"), "utf8")).toBe("candidate\n");
        expect(readFileSync(join(context.cwd, "primary.txt"), "utf8")).toBe("advanced\n");
        return passed;
      },
    });
    writeFileSync(join(fixture.repo, "primary.txt"), "advanced\n");
    commitAll(fixture.repo, "advance primary");
    fixture.advancedHead = getHeadSha(fixture.repo)!;

    const result = await fixture.service.integrate(fixture.jobId, admin());

    expect(result.outcome).toBe("merged_advanced");
    expect(result.merged).toBe(true);
    expect(observedCwds).toHaveLength(1);
    expect(readFileSync(join(fixture.repo, "candidate.txt"), "utf8")).toBe("candidate\n");
    expect(readFileSync(join(fixture.repo, "primary.txt"), "utf8")).toBe("advanced\n");
    expect(runGitStrict(["rev-list", "--parents", "-n", "1", getHeadSha(fixture.repo)!], fixture.repo).stdout.trim().split(/\s+/)).toHaveLength(3);
    expect(fixture.worktrees.list().every((lease) => lease.state === "released")).toBe(true);
  });

  gitTest("preserves a conflicting candidate and leaves advanced primary byte-for-byte unchanged", async () => {
    const fixture = createFixture({ candidatePath: "README.md", candidateText: "candidate line\n" });
    writeFileSync(join(fixture.repo, "README.md"), "primary line\n");
    commitAll(fixture.repo, "conflicting primary advance");
    const primaryHead = getHeadSha(fixture.repo);

    const result = await fixture.service.integrate(fixture.jobId, admin());

    expect(result.outcome).toBe("blocked_conflict");
    expect(result.merged).toBe(false);
    expect(getHeadSha(fixture.repo)).toBe(primaryHead);
    expect(readFileSync(join(fixture.repo, "README.md"), "utf8")).toBe("primary line\n");
    expect(runGitStrict(["cat-file", "-e", `${fixture.candidateCommit}^{commit}`], fixture.repo).ok).toBe(true);
    expect(fixture.service.decisions.get(fixture.jobId)).toMatchObject({ status: "available" });
    expect(fixture.service.decisions.get(fixture.jobId)?.attempts.at(-1)?.outcome).toBe("blocked_conflict");
    expect(runGitStrict(["status", "--porcelain=v1", "--untracked-files=all"], fixture.repo).stdout).toBe("");
  });

  gitTest("fails closed when advanced-head gates fail without modifying or discarding the candidate", async () => {
    const fixture = createFixture({
      evaluateIntegrationGates: async () => ({ ...passed, testsPassed: false, reasons: ["tests failed"] }),
    });
    writeFileSync(join(fixture.repo, "primary.txt"), "advanced\n");
    commitAll(fixture.repo, "advance primary");
    const primaryHead = getHeadSha(fixture.repo);

    const result = await fixture.service.integrate(fixture.jobId, admin());

    expect(result.outcome).toBe("blocked_integration_gates");
    expect(result.reason).toContain("tests failed");
    expect(getHeadSha(fixture.repo)).toBe(primaryHead);
    expect(runGitStrict(["cat-file", "-e", `${fixture.candidateCommit}^{commit}`], fixture.repo).ok).toBe(true);
    expect(fixture.journal.get(fixture.jobId)).toBeNull();
    expect(fixture.finality.latest(fixture.jobId)?.allowed).toBe(false);
  });

  gitTest("reports a dirty primary without changing or cleaning user files", async () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.repo, "user-dirty.txt"), "mine\n");

    const result = await fixture.service.integrate(fixture.jobId, admin());

    expect(result.outcome).toBe("blocked_dirty_primary");
    expect(getHeadSha(fixture.repo)).toBe(fixture.baseCommit);
    expect(readFileSync(join(fixture.repo, "user-dirty.txt"), "utf8")).toBe("mine\n");
    expect(runGitStrict(["cat-file", "-e", `${fixture.candidateCommit}^{commit}`], fixture.repo).ok).toBe(true);
    expect(fixture.service.decisions.get(fixture.jobId)?.attempts.at(-1)?.outcome).toBe("blocked_dirty_primary");
  });

  gitTest("rejects a candidate whose durable base is not an ancestor of its commit or primary", async () => {
    const fixture = createFixture();
    const tree = runGitStrict(["write-tree"], fixture.repo).stdout.trim();
    const unrelated = runGitStrict([
      "-c", "user.name=Test", "-c", "user.email=test@example.test",
      "commit-tree", tree, "-m", "unrelated root",
    ], fixture.repo).stdout.trim();
    const jobPath = join(fixture.paths.jobsDir, `${fixture.jobId}.job.json`);
    const persisted = JSON.parse(readFileSync(jobPath, "utf8")) as {
      result: { commit: { base: string }; diff: { baseCommit: string } };
    };
    persisted.result.commit.base = unrelated;
    persisted.result.diff.baseCommit = unrelated;
    writeFileSync(jobPath, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });

    const inspection = await fixture.service.inspect(fixture.jobId, admin());
    expect(inspection.baseIsCandidateAncestor).toBe(false);
    expect(inspection.baseIsPrimaryAncestor).toBe(false);
    expect(inspection.reasons.join(" ")).toContain("does not descend");
    await expect(fixture.service.integrate(fixture.jobId, admin())).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(getHeadSha(fixture.repo)).toBe(fixture.baseCommit);
  });

  gitTest("requires admin mutation, current merge authority, and ask-mode approval", async () => {
    const fixture = createFixture({ approvalPolicy: "ask" });
    await expect(fixture.service.integrate(fixture.jobId, { actor: "worker" })).rejects.toMatchObject({ code: "POLICY_DENIED" });
    await expect(fixture.service.integrate(fixture.jobId, { actor: "stranger", admin: true })).rejects.toMatchObject({ code: "POLICY_DENIED" });
    await expect(fixture.service.integrate(fixture.jobId, admin())).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    expect(getHeadSha(fixture.repo)).toBe(fixture.baseCommit);

    const approval = fixture.approvals.create({
      id: "merge-approval",
      collaborationId: fixture.jobId,
      requestedBy: "worker",
      assignedTo: "coordinator",
      kind: "merge",
      summary: "Integrate candidate after human review.",
      details: { candidateId: fixture.jobId },
      expiresAt: Date.now() + 60_000,
    });
    fixture.approvals.resolve(approval.id, "coordinator", "approved", "Reviewed and approved.");

    expect((await fixture.service.integrate(fixture.jobId, admin())).outcome).toBe("merged_fast_forward");
    expect(fixture.service.decisions.get(fixture.jobId)?.attempts.some((attempt) => attempt.outcome === "approval_required")).toBe(true);
  });

  gitTest("cancellation after isolated gates preserves the candidate and clean primary", async () => {
    const controller = new AbortController();
    const fixture = createFixture({
      evaluateIntegrationGates: async () => {
        controller.abort();
        return passed;
      },
    });
    writeFileSync(join(fixture.repo, "primary.txt"), "advanced\n");
    commitAll(fixture.repo, "advance primary");
    const primaryHead = getHeadSha(fixture.repo);

    await expect(fixture.service.integrate(fixture.jobId, admin(), { signal: controller.signal })).rejects.toMatchObject({ code: "CANCELLED" });
    expect(getHeadSha(fixture.repo)).toBe(primaryHead);
    expect(runGitStrict(["status", "--porcelain=v1", "--untracked-files=all"], fixture.repo).stdout).toBe("");
    expect(runGitStrict(["cat-file", "-e", `${fixture.candidateCommit}^{commit}`], fixture.repo).ok).toBe(true);
    expect(fixture.service.decisions.get(fixture.jobId)?.attempts.at(-1)?.outcome).toBe("cancelled");
  });

  gitTest("re-checks a grantee's current merge authority after advanced-head gates", async () => {
    const fixture = createFixture({
      evaluateIntegrationGates: async () => {
        fixture.authority.revokeGrant("coordinator", "candidate-merge-grant");
        return passed;
      },
    });
    fixture.authority.addGrant("coordinator", GrantSchema.parse({
      id: "candidate-merge-grant",
      projectId: fixture.paths.projectId,
      principal: "worker",
      operations: ["write", "merge"],
      backends: ["opencode"],
      expiresAt: Date.now() + 60_000,
      maxCostUsd: 1,
      issuedBy: "coordinator",
      createdAt: Date.now(),
      revokedAt: null,
    }));
    writeFileSync(join(fixture.repo, "primary.txt"), "advanced\n");
    commitAll(fixture.repo, "advance primary");
    const primaryHead = getHeadSha(fixture.repo);

    await expect(fixture.service.integrate(fixture.jobId, { actor: "worker", admin: true })).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(getHeadSha(fixture.repo)).toBe(primaryHead);
    expect(fixture.journal.get(fixture.jobId)).toBeNull();
    expect(fixture.service.decisions.get(fixture.jobId)?.attempts.at(-1)?.outcome).toBe("unauthorized");
  });

  gitTest("durably rejects a candidate across service restart without deleting its commit", async () => {
    const fixture = createFixture();
    await expect(fixture.service.reject(fixture.jobId, { actor: "worker" }, "no")).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(await fixture.service.reject(fixture.jobId, admin(), "Review rejected this change.")).toMatchObject({ status: "rejected" });

    const reopened = createService(fixture);
    expect((await reopened.inspect(fixture.jobId, { actor: "worker" })).decision).toMatchObject({
      status: "rejected",
      rejectionReason: "Review rejected this change.",
    });
    await expect(reopened.integrate(fixture.jobId, admin())).rejects.toMatchObject({ code: "CONFLICT" });
    expect(runGitStrict(["cat-file", "-e", `${fixture.candidateCommit}^{commit}`], fixture.repo).ok).toBe(true);
    expect(getHeadSha(fixture.repo)).toBe(fixture.baseCommit);
  });

  gitTest("reconciles a crash after primary update from the write-ahead journal", async () => {
    const fixture = createFixture();
    fixture.journal.prepare({
      jobId: fixture.jobId,
      sessionId: null,
      principal: "coordinator",
      grantId: null,
      phase: "candidate",
      outcome: "merged_fast_forward",
      baseCommit: fixture.baseCommit,
      candidateCommit: fixture.candidateCommit,
      expectedPrimaryHead: fixture.baseCommit,
      targetCommit: fixture.candidateCommit,
    });
    expect(runGitStrict(["merge", "--ff-only", fixture.candidateCommit], fixture.repo).ok).toBe(true);
    expect(fixture.journal.get(fixture.jobId)?.state).toBe("prepared");

    const reopened = createService(fixture);
    expect(await reopened.reconcile()).toEqual([{ candidateId: fixture.jobId, state: "applied" }]);
    expect(fixture.journal.get(fixture.jobId)?.state).toBe("completed");
    expect(reopened.decisions.get(fixture.jobId)).toMatchObject({
      status: "integrated",
      resultingCommit: fixture.candidateCommit,
    });
  });

  gitTest("surfaces an applied-marker fault and deterministically completes it after restart", async () => {
    const fixture = createFixture();
    const markApplied = fixture.journal.markApplied.bind(fixture.journal);
    fixture.journal.markApplied = () => { throw new Error("injected applied marker failure"); };

    const result = await fixture.service.integrate(fixture.jobId, admin());

    expect(result.merged).toBe(true);
    expect(result.evidence.join(" ")).toContain("restart recovery is required");
    expect(fixture.service.decisions.get(fixture.jobId)?.attempts.at(-1)?.evidence.join(" ")).toContain("completion marker failed");
    expect(fixture.journal.get(fixture.jobId)?.state).toBe("prepared");
    fixture.journal.markApplied = markApplied;

    const reopened = createService(fixture);
    expect(await reopened.reconcile()).toEqual([{ candidateId: fixture.jobId, state: "applied" }]);
    expect(fixture.journal.get(fixture.jobId)?.state).toBe("completed");
  });
});

type FixtureOptions = {
  approvalPolicy?: "ask" | "auto" | "bypass";
  candidatePath?: string;
  candidateText?: string;
  evaluateIntegrationGates?: (context: WriteGateContext) => Promise<WriteGateDecision>;
  outputOverflow?: boolean;
};

type Fixture = ReturnType<typeof createFixture>;

function createFixture(options: FixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "headless-candidate-service-"));
  const runtime = mkdtempSync("/tmp/hcs-");
  roots.push(root);
  roots.push(runtime);
  const repo = join(root, "project");
  mkdirSync(repo);
  expect(runGitStrict(["init", "-b", "main"], repo).ok).toBe(true);
  writeFileSync(join(repo, ".gitignore"), ".headless/\n");
  writeFileSync(join(repo, "README.md"), "base line\n");
  commitAll(repo, "initial");
  const baseCommit = getHeadSha(repo)!;
  const plan = createWriteWorktree(planWriteWorktree({ primaryRoot: repo, label: "preserved-candidate" }));
  writeFileSync(join(plan.worktreePath, options.candidatePath ?? "candidate.txt"), options.candidateText ?? "candidate\n");
  const diff = captureWriteDiff(plan);
  commitAll(plan.worktreePath, "candidate change");
  const candidateCommit = getHeadSha(plan.worktreePath)!;
  removeWriteWorktree(plan, { force: true, pruneBranch: false });

  const paths = ensureProjectStateDirectories(getProjectStatePaths(repo, {
    env: {
      HEADLESS_STATE_HOME: join(root, "state"),
      HEADLESS_RUNTIME_HOME: runtime,
    },
  }));
  const jobId = "candidate-job";
  const jobs = new JobStore(paths.jobsDir);
  const request = RunRequestSchema.parse({
    backend: "opencode",
    prompt: "Create a candidate.",
    projectRoot: repo,
    mode: "write",
    authMode: "broker",
    approvalPolicy: options.approvalPolicy ?? "auto",
    containment: "required",
  });
  jobs.create({ id: jobId, projectId: paths.projectId, principal: "worker", request });
  jobs.claim(jobId, "test", 60_000);
  jobs.transition(jobId, "running");
  jobs.complete(jobId, preservedResult(jobId, baseCommit, candidateCommit, diff, options.outputOverflow));

  const authority = new AuthorityStore(paths, { coordinator: "coordinator" });
  const finality = new FinalityStore(paths);
  finality.evaluate({
    projectId: paths.projectId,
    jobId,
    decidedBy: "coordinator",
    requirements: { policy: true, tests: true, review: true, vote: false, budget: true },
    gates: options.outputOverflow
      ? { policyPassed: false, testsPassed: false, reviewPassed: false, votePassed: false, budgetPassed: true }
      : { policyPassed: true, testsPassed: true, reviewPassed: true, votePassed: false, budgetPassed: true },
  });
  const approvals = new ApprovalStore(paths);
  const journal = new IntegrationJournal(paths);
  const decisions = new CandidateDecisionStore(paths);
  const worktrees = new WorktreeLeaseStore(paths.worktreesDir, paths.projectId);
  const fixture = {
    root,
    repo,
    paths,
    jobId,
    baseCommit,
    candidateCommit,
    jobs,
    authority,
    finality,
    approvals,
    journal,
    decisions,
    worktrees,
    advancedHead: "",
    service: undefined as unknown as CandidateIntegrationService,
    evaluateIntegrationGates: options.evaluateIntegrationGates ?? (async () => passed),
  };
  fixture.service = createService(fixture);
  return fixture;
}

function createService(fixture: Omit<Fixture, "service"> | Fixture) {
  return new CandidateIntegrationService({
    paths: fixture.paths,
    jobs: fixture.jobs,
    authority: fixture.authority,
    finality: fixture.finality,
    approvals: fixture.approvals,
    journal: fixture.journal,
    worktreeLeases: fixture.worktrees,
    evaluateIntegrationGates: fixture.evaluateIntegrationGates,
  });
}

function preservedResult(
  jobId: string,
  baseCommit: string,
  candidateCommit: string,
  diff: { diff: string; status: string; files: string[] },
  outputOverflow = false,
): RunResult {
  return {
    status: outputOverflow ? "failed" : "blocked",
    error: outputOverflow
      ? { code: "OUTPUT_OVERFLOW", message: "Provider output exceeded the bounded stream limit.", retryable: false }
      : { code: "POLICY_DENIED", message: "Candidate preserved for later integration.", retryable: false },
    backend: "opencode",
    output: "candidate complete",
    stderr: "",
    diagnostics: { format: "test", malformedEvents: 0, ignoredEvents: 0, messages: [] },
    exitCode: 0,
    signal: null,
    usage: { input: 1, output: 1, reasoning: null, cached: null, providerTotal: 2 },
    cost: { amountUsd: 0.01, source: "provider", pricingId: null, observedRequests: 1 },
    containment: {
      requirement: "required",
      enforced: true,
      platform: process.platform === "darwin" || process.platform === "linux" || process.platform === "win32" ? process.platform : "other",
      mechanism: "test",
      probe: "test",
      isolatedHome: true,
      credentialsIsolated: true,
      network: "broker-only",
      credentialAccess: "broker-lease",
      unsafe: false,
    },
    durationMs: 1,
    sessionId: null,
    jobId,
    diff: {
      patch: diff.diff,
      status: diff.status,
      files: diff.files,
      baseCommit,
      candidateCommit,
      resultingCommit: baseCommit,
    },
    commit: { base: baseCommit, candidate: candidateCommit, result: baseCommit, merged: false },
    truncation: { stdout: false, stderr: false, output: false, events: false, artifacts: false, diff: false },
  };
}

function admin() {
  return { actor: "coordinator", admin: true } as const;
}

function commitAll(repo: string, message: string) {
  expect(runGitStrict(["add", "--all"], repo).ok).toBe(true);
  expect(runGitStrict(["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--no-gpg-sign", "-m", message], repo).ok).toBe(true);
}
