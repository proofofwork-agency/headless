import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunRequestSchema, type RunResult } from "../src/contracts/run";
import { HeadlessDaemonClient } from "../src/daemon/client";
import { JobStore } from "../src/daemon/job-store";
import { HeadlessDaemon } from "../src/daemon/server";
import { FinalityStore } from "../src/runtime/finality-store";
import { getHeadSha, runGitStrict } from "../src/runtime/git";
import { ensureProjectStateDirectories, getProjectStatePaths } from "../src/runtime/project-state";
import { captureWriteDiff, createWriteWorktree, planWriteWorktree, removeWriteWorktree } from "../src/runtime/worktree";

const roots: string[] = [];
const daemons: HeadlessDaemon[] = [];
const gitTest = runGitStrict(["--version"], process.cwd()).ok ? test : test.skip;

afterEach(async () => {
  while (daemons.length) await daemons.pop()!.stop();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("daemon candidate routes", () => {
  gitTest("inspects, integrates, and rejects preserved candidates through the authenticated service", async () => {
    const root = mkdtempSync(join(tmpdir(), "headless-daemon-candidate-"));
    const runtime = mkdtempSync("/tmp/hdc-");
    const project = join(root, "project");
    mkdirSync(project);
    roots.push(root, runtime);
    expect(runGitStrict(["init", "-b", "main"], project).ok).toBe(true);
    writeFileSync(join(project, ".gitignore"), ".headless/\n");
    writeFileSync(join(project, "README.md"), "base\n");
    commitAll(project, "base");
    const baseCommit = getHeadSha(project)!;

    const state = {
      env: { ...process.env, HEADLESS_STATE_HOME: join(root, "state"), HEADLESS_RUNTIME_HOME: runtime },
      homeDir: root,
    };
    const paths = ensureProjectStateDirectories(getProjectStatePaths(project, state));
    const jobs = new JobStore(paths.jobsDir);
    const finality = new FinalityStore(paths);
    const first = seedCandidate(project, paths.projectId, jobs, finality, "candidate-integrate", baseCommit, "integrated.txt");
    const second = seedCandidate(project, paths.projectId, jobs, finality, "candidate-reject", baseCommit, "rejected.txt");

    const daemon = new HeadlessDaemon({ projectRoot: project, state, token: "c".repeat(48), principal: "owner" });
    daemons.push(daemon);
    await daemon.start();
    const client = new HeadlessDaemonClient({ projectRoot: project, state, token: "c".repeat(48) });

    const inspection = await client.call<{ candidateId: string; candidateCommit: string; eligible: boolean }>("candidate.inspect", {
      candidateId: first.jobId,
    });
    expect(inspection).toMatchObject({ candidateId: first.jobId, candidateCommit: first.candidateCommit, eligible: true });
    const integrated = await client.call<{ outcome: string; merged: boolean }>("candidate.integrate", { candidateId: first.jobId });
    expect(integrated).toMatchObject({ outcome: "merged_fast_forward", merged: true });
    expect(readFileSync(join(project, "integrated.txt"), "utf8")).toBe("candidate\n");

    expect(await client.call("candidate.reject", { candidateId: second.jobId })).toMatchObject({
      candidateId: second.jobId,
      status: "rejected",
      rejectedBy: "owner",
    });
    const rejected = await client.call<{ decision: { status: string }; candidateExists: boolean }>("candidate.inspect", {
      candidateId: second.jobId,
    });
    expect(rejected).toMatchObject({ decision: { status: "rejected" }, candidateExists: true });
    expect(runGitStrict(["cat-file", "-e", `${second.candidateCommit}^{commit}`], project).ok).toBe(true);
  });
});

function seedCandidate(
  project: string,
  projectId: string,
  jobs: JobStore,
  finality: FinalityStore,
  jobId: string,
  baseCommit: string,
  file: string,
) {
  const plan = createWriteWorktree(planWriteWorktree({ primaryRoot: project, label: jobId }));
  writeFileSync(join(plan.worktreePath, file), "candidate\n");
  const diff = captureWriteDiff(plan);
  commitAll(plan.worktreePath, jobId);
  const candidateCommit = getHeadSha(plan.worktreePath)!;
  removeWriteWorktree(plan, { force: true, pruneBranch: false });
  const request = RunRequestSchema.parse({
    backend: "opencode",
    prompt: "Create a preserved candidate.",
    projectRoot: project,
    mode: "write",
    authMode: "broker",
    approvalPolicy: "auto",
    containment: "required",
  });
  jobs.create({ id: jobId, projectId, principal: "owner", request });
  jobs.claim(jobId, "seed", 60_000);
  jobs.transition(jobId, "running");
  jobs.complete(jobId, preservedResult(jobId, baseCommit, candidateCommit, diff));
  finality.evaluate({
    projectId,
    jobId,
    decidedBy: "owner",
    requirements: { policy: true, tests: true, review: true, vote: false, budget: true },
    gates: { policyPassed: true, testsPassed: true, reviewPassed: true, votePassed: false, budgetPassed: true },
  });
  return { jobId, candidateCommit };
}

function preservedResult(
  jobId: string,
  baseCommit: string,
  candidateCommit: string,
  diff: { diff: string; status: string; files: string[] },
): RunResult {
  return {
    status: "blocked",
    error: { code: "POLICY_DENIED", message: "Candidate preserved for integration.", retryable: false },
    backend: "opencode",
    output: "candidate complete",
    stderr: "",
    diagnostics: { format: "test", malformedEvents: 0, ignoredEvents: 0, messages: [] },
    exitCode: 0,
    signal: null,
    usage: { input: 1, output: 1, reasoning: null, cached: null, providerTotal: 2 },
    cost: { amountUsd: 0, source: "reconciled", pricingId: null, observedRequests: 0 },
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
    diff: { patch: diff.diff, status: diff.status, files: diff.files, baseCommit, candidateCommit, resultingCommit: baseCommit },
    commit: { base: baseCommit, candidate: candidateCommit, result: baseCommit, merged: false },
    truncation: { stdout: false, stderr: false, output: false, events: false, artifacts: false, diff: false },
  };
}

function commitAll(project: string, message: string) {
  expect(runGitStrict(["add", "--all"], project).ok).toBe(true);
  expect(runGitStrict(["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--no-gpg-sign", "-m", message], project).ok).toBe(true);
}
