import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHeadSha, runGitStrict } from "../src/runtime/git";
import { captureWriteDiff, createWriteWorktree, planWriteWorktree } from "../src/runtime/worktree";
import {
  candidateBranchExists,
  integrateWriteCandidate,
  type WriteGateContext,
  type WriteGateDecision,
} from "../src/runtime/write-integration";

setDefaultTimeout(15_000);

const gitAvailable = runGitStrict(["--version"], process.cwd()).ok;
const gitTest = gitAvailable ? test : test.skip;

const passed: WriteGateDecision = {
  policyPassed: true,
  testsPassed: true,
  reviewPassed: true,
  votePassed: false,
  budgetPassed: true,
  evidence: ["deterministic gates passed"],
};

describe("coordinator write integration", () => {
  gitTest("commits with daemon identity and fast-forwards a clean unchanged primary", async () => {
    const repo = initRepo();
    const plan = createWriteWorktree(planWriteWorktree({ primaryRoot: repo, label: "fast-forward" }));
    writeFileSync(join(plan.worktreePath, "candidate.txt"), "candidate\n");
    const diff = captureWriteDiff(plan);

    const result = await integrateWriteCandidate({
      plan,
      diff,
      execution: succeededExecution(),
      policy: policy(async () => passed),
    });

    expect(result.outcome).toBe("merged_fast_forward");
    expect(result.merged).toBe(true);
    expect(result.baseCommit).not.toBe(result.candidateCommit);
    expect(result.candidateCommit).toBe(result.resultingCommit);
    expect(getHeadSha(repo)).toBe(result.resultingCommit);
    expect(readFileSync(join(repo, "candidate.txt"), "utf8")).toBe("candidate\n");
    expect(runGitStrict(["show", "-s", "--format=%an <%ae>", result.candidateCommit!], repo).stdout.trim()).toBe("Headless Daemon <headless@localhost>");
    expect(candidateBranchExists(repo, plan.branch)).toBe(false);
    expect(existsSync(plan.worktreePath)).toBe(false);
  });

  gitTest("failed gates leave primary untouched and preserve the candidate commit", async () => {
    const repo = initRepo();
    const base = getHeadSha(repo)!;
    const plan = createWriteWorktree(planWriteWorktree({ primaryRoot: repo, label: "gate-fail" }));
    writeFileSync(join(plan.worktreePath, "blocked.txt"), "blocked\n");
    const diff = captureWriteDiff(plan);

    const result = await integrateWriteCandidate({
      plan,
      diff,
      execution: succeededExecution(),
      policy: policy(async () => ({ ...passed, testsPassed: false, reasons: ["tests failed"] })),
    });

    expect(result.outcome).toBe("blocked_candidate_gates");
    expect(result.reason).toContain("tests failed");
    expect(getHeadSha(repo)).toBe(base);
    expect(existsSync(join(repo, "blocked.txt"))).toBe(false);
    expect(result.candidateCommit).not.toBeNull();
    expect(result.branch).toStartWith("headless/candidate/");
    expect(candidateBranchExists(repo, result.branch)).toBe(true);
    expect(existsSync(plan.worktreePath)).toBe(false);
  });

  gitTest("gates and preserves an output-overflow candidate without auto-integrating it", async () => {
    const repo = initRepo();
    const base = getHeadSha(repo)!;
    const plan = createWriteWorktree(planWriteWorktree({ primaryRoot: repo, label: "overflow-recovery" }));
    writeFileSync(join(plan.worktreePath, "game.ts"), "export const playable = true;\n");
    const diff = captureWriteDiff(plan);
    let gateCalls = 0;

    const result = await integrateWriteCandidate({
      plan,
      diff,
      execution: { ...succeededExecution(), succeeded: false, status: "failed", failureCode: "OUTPUT_OVERFLOW" },
      policy: policy(async () => { gateCalls += 1; return passed; }),
    });

    expect(gateCalls).toBe(1);
    expect(result.outcome).toBe("preserved_no_merge_authority");
    expect(result.reason).toContain("explicit review");
    expect(result.candidateCommit).not.toBeNull();
    expect(result.gates[0]?.decision.testsPassed).toBe(true);
    expect(getHeadSha(repo)).toBe(base);
    expect(existsSync(join(repo, "game.ts"))).toBe(false);
    expect(candidateBranchExists(repo, result.branch)).toBe(true);
  });

  gitTest("does not gate or integrate an ordinary failed execution", async () => {
    const repo = initRepo();
    const base = getHeadSha(repo)!;
    const plan = createWriteWorktree(planWriteWorktree({ primaryRoot: repo, label: "ordinary-failure" }));
    writeFileSync(join(plan.worktreePath, "partial.ts"), "export const partial = true;\n");
    const diff = captureWriteDiff(plan);
    let gateCalls = 0;

    const result = await integrateWriteCandidate({
      plan,
      diff,
      execution: { ...succeededExecution(), succeeded: false, status: "failed", failureCode: "PROCESS_ERROR" },
      policy: policy(async () => { gateCalls += 1; return passed; }),
    });

    expect(gateCalls).toBe(0);
    expect(result.outcome).toBe("preserved_execution_failure");
    expect(result.candidateCommit).not.toBeNull();
    expect(getHeadSha(repo)).toBe(base);
  });

  gitTest("a principal without merge authority receives a preserved candidate", async () => {
    const repo = initRepo();
    const base = getHeadSha(repo)!;
    const plan = createWriteWorktree(planWriteWorktree({ primaryRoot: repo, label: "grant" }));
    writeFileSync(join(plan.worktreePath, "grant.txt"), "candidate\n");
    const diff = captureWriteDiff(plan);

    const result = await integrateWriteCandidate({
      plan,
      diff,
      execution: succeededExecution(),
      policy: { ...policy(async () => passed), autoMerge: false, actor: "grantee", grantId: "write-only" },
    });

    expect(result.outcome).toBe("preserved_no_merge_authority");
    expect(getHeadSha(repo)).toBe(base);
    expect(result.branch).toStartWith("headless/candidate/");
    expect(candidateBranchExists(repo, result.branch)).toBe(true);
    expect(result.grantId).toBe("write-only");
  });

  gitTest("revocation after candidate gates is rechecked before primary mutation", async () => {
    const repo = initRepo();
    const base = getHeadSha(repo)!;
    const plan = createWriteWorktree(planWriteWorktree({ primaryRoot: repo, label: "revoked-before-merge" }));
    writeFileSync(join(plan.worktreePath, "revoked.txt"), "candidate\n");
    const diff = captureWriteDiff(plan);
    const checkpoints: string[] = [];

    const result = await integrateWriteCandidate({
      plan,
      diff,
      execution: succeededExecution(),
      policy: {
        ...policy(async () => passed),
        reauthorize: async (checkpoint) => {
          checkpoints.push(checkpoint);
          return checkpoint === "primary-mutation"
            ? { allowed: false, reason: "Grant was revoked during execution." }
            : { allowed: true, reason: "Grant remains active." };
        },
      },
    });

    expect(checkpoints).toEqual(["candidate-gates", "primary-mutation"]);
    expect(result.outcome).toBe("preserved_no_merge_authority");
    expect(result.reason).toContain("revoked");
    expect(result.merged).toBe(false);
    expect(result.candidateCommit).not.toBeNull();
    expect(getHeadSha(repo)).toBe(base);
    expect(existsSync(join(repo, "revoked.txt"))).toBe(false);
  });

  gitTest("revocation while the primary journal is prepared is checked again at mutation time", async () => {
    const repo = initRepo();
    const base = getHeadSha(repo)!;
    const plan = createWriteWorktree(planWriteWorktree({ primaryRoot: repo, label: "revoked-during-journal" }));
    writeFileSync(join(plan.worktreePath, "journal-race.txt"), "candidate\n");
    const diff = captureWriteDiff(plan);
    let authorityActive = true;

    const result = await integrateWriteCandidate({
      plan,
      diff,
      execution: succeededExecution(),
      policy: {
        ...policy(async () => passed),
        preparePrimaryUpdate: async () => {
          authorityActive = false;
        },
        reauthorize: async () => ({
          allowed: authorityActive,
          reason: authorityActive ? "Grant remains active." : "Grant was revoked while the journal was persisted.",
        }),
      },
    });

    expect(result.outcome).toBe("preserved_no_merge_authority");
    expect(result.reason).toContain("revoked");
    expect(result.merged).toBe(false);
    expect(getHeadSha(repo)).toBe(base);
    expect(existsSync(join(repo, "journal-race.txt"))).toBe(false);
  });

  gitTest("advanced primary is integrated in a separate worktree and gates run again", async () => {
    const repo = initRepo();
    const plan = createWriteWorktree(planWriteWorktree({ primaryRoot: repo, label: "advanced" }));
    writeFileSync(join(plan.worktreePath, "candidate.txt"), "candidate\n");
    const diff = captureWriteDiff(plan);
    writeFileSync(join(repo, "primary.txt"), "primary advance\n");
    commitAll(repo, "primary advance");
    const advanced = getHeadSha(repo)!;
    const phases: string[] = [];

    const result = await integrateWriteCandidate({
      plan,
      diff,
      execution: succeededExecution(),
      policy: policy(async (context) => {
        phases.push(context.phase);
        expect(readFileSync(join(context.cwd, "candidate.txt"), "utf8")).toBe("candidate\n");
        if (context.phase === "integration") expect(readFileSync(join(context.cwd, "primary.txt"), "utf8")).toBe("primary advance\n");
        return passed;
      }),
    });

    expect(result.outcome).toBe("merged_advanced");
    expect(result.merged).toBe(true);
    expect(result.resultingCommit).not.toBe(advanced);
    expect(phases).toEqual(["candidate", "integration"]);
    expect(readFileSync(join(repo, "candidate.txt"), "utf8")).toBe("candidate\n");
    expect(readFileSync(join(repo, "primary.txt"), "utf8")).toBe("primary advance\n");
    expect(runGitStrict(["rev-list", "--parents", "-n", "1", result.resultingCommit!], repo).stdout.trim().split(/\s+/)).toHaveLength(3);
    expect(candidateBranchExists(repo, plan.branch)).toBe(false);
  });

  gitTest("expired authority blocks advanced-head integration gates", async () => {
    const repo = initRepo();
    const plan = createWriteWorktree(planWriteWorktree({ primaryRoot: repo, label: "expired-integration" }));
    writeFileSync(join(plan.worktreePath, "expired.txt"), "candidate\n");
    const diff = captureWriteDiff(plan);
    writeFileSync(join(repo, "primary.txt"), "primary advance\n");
    commitAll(repo, "primary advance");
    const advanced = getHeadSha(repo)!;
    const checkpoints: string[] = [];

    const result = await integrateWriteCandidate({
      plan,
      diff,
      execution: succeededExecution(),
      policy: {
        ...policy(async () => passed),
        reauthorize: async (checkpoint) => {
          checkpoints.push(checkpoint);
          return checkpoint === "integration-gates"
            ? { allowed: false, reason: "Grant expired before integration gates." }
            : { allowed: true, reason: "Grant remains active." };
        },
      },
    });

    expect(checkpoints).toEqual(["candidate-gates", "integration-gates"]);
    expect(result.outcome).toBe("blocked_integration_gates");
    expect(result.reason).toContain("expired");
    expect(result.merged).toBe(false);
    expect(getHeadSha(repo)).toBe(advanced);
    expect(existsSync(join(repo, "expired.txt"))).toBe(false);
  });

  gitTest("merge conflicts leave advanced primary exactly untouched and preserve evidence", async () => {
    const repo = initRepo();
    const plan = createWriteWorktree(planWriteWorktree({ primaryRoot: repo, label: "conflict" }));
    writeFileSync(join(plan.worktreePath, "README.md"), "candidate line\n");
    const diff = captureWriteDiff(plan);
    writeFileSync(join(repo, "README.md"), "primary line\n");
    commitAll(repo, "primary conflict");
    const advanced = getHeadSha(repo)!;

    const result = await integrateWriteCandidate({
      plan,
      diff,
      execution: succeededExecution(),
      policy: policy(async () => passed),
    });

    expect(result.outcome).toBe("blocked_conflict");
    expect(getHeadSha(repo)).toBe(advanced);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("primary line\n");
    expect(result.evidence.join("\n")).toMatch(/conflict|README/i);
    expect(result.branch).toStartWith("headless/candidate/");
    expect(candidateBranchExists(repo, result.branch)).toBe(true);
  });

  gitTest("a dirty primary is never touched after candidate execution", async () => {
    const repo = initRepo();
    const base = getHeadSha(repo)!;
    const plan = createWriteWorktree(planWriteWorktree({ primaryRoot: repo, label: "dirty" }));
    writeFileSync(join(plan.worktreePath, "candidate.txt"), "candidate\n");
    const diff = captureWriteDiff(plan);
    writeFileSync(join(repo, "user-dirty.txt"), "mine\n");

    const result = await integrateWriteCandidate({
      plan,
      diff,
      execution: succeededExecution(),
      policy: policy(async () => passed),
    });

    expect(result.outcome).toBe("blocked_dirty_primary");
    expect(getHeadSha(repo)).toBe(base);
    expect(readFileSync(join(repo, "user-dirty.txt"), "utf8")).toBe("mine\n");
    expect(existsSync(join(repo, "candidate.txt"))).toBe(false);
    expect(result.branch).toStartWith("headless/candidate/");
    expect(candidateBranchExists(repo, result.branch)).toBe(true);
  });

  gitTest("repository-local .headless state is dirt and blocks auto-merge", async () => {
    const repo = initRepo();
    // This fixture normally ignores .headless; remove that rule so the path is
    // visible as repository dirt after the worker lease begins.
    writeFileSync(join(repo, ".gitignore"), "");
    commitAll(repo, "stop ignoring repository-local state");
    const base = getHeadSha(repo)!;
    const plan = createWriteWorktree(planWriteWorktree({ primaryRoot: repo, label: "local-state" }));
    writeFileSync(join(plan.worktreePath, "candidate.txt"), "candidate\n");
    const diff = captureWriteDiff(plan);
    mkdirSync(join(repo, ".headless"));
    writeFileSync(join(repo, ".headless", "ledger.jsonl"), "user data\n");

    const result = await integrateWriteCandidate({ plan, diff, execution: succeededExecution(), policy: policy(async () => passed) });

    expect(result.outcome).toBe("blocked_dirty_primary");
    expect(getHeadSha(repo)).toBe(base);
    expect(readFileSync(join(repo, ".headless", "ledger.jsonl"), "utf8")).toBe("user data\n");
    expect(existsSync(join(repo, "candidate.txt"))).toBe(false);
  });

  gitTest("secret-like raw diffs are rejected before staging or creating candidate objects", async () => {
    const repo = initRepo();
    const base = getHeadSha(repo)!;
    const reachableBefore = runGitStrict(["rev-list", "--objects", "--all"], repo).stdout;
    const secret = "OPENAI_API_KEY=sk-thisIsAPlantedApiKey123456789\n";
    const secretBlob = runGitStrict(["hash-object", "--stdin"], repo, 10_000, secret).stdout.trim();
    const plan = createWriteWorktree(planWriteWorktree({ primaryRoot: repo, label: "secret" }));
    writeFileSync(join(plan.worktreePath, "credentials.txt"), secret);
    const diff = captureWriteDiff(plan);

    const result = await integrateWriteCandidate({
      plan,
      diff,
      execution: succeededExecution(),
      policy: policy(async () => passed),
    });

    expect(result.outcome).toBe("blocked_candidate_gates");
    expect(result.reason).toContain("rejected before staging or commit");
    expect(result.candidateCommit).toBeNull();
    expect(getHeadSha(repo)).toBe(base);
    expect(runGitStrict(["rev-list", "--objects", "--all"], repo).stdout).toBe(reachableBefore);
    expect(runGitStrict(["cat-file", "-e", secretBlob], repo).ok).toBe(false);
    expect(runGitStrict(["branch", "--list", "headless/candidate/*"], repo).stdout.trim()).toBe("");
    expect(existsSync(join(repo, "credentials.txt"))).toBe(false);
  });

  gitTest("gate commands cannot smuggle side effects into a candidate commit", async () => {
    const repo = initRepo();
    const base = getHeadSha(repo)!;
    const plan = createWriteWorktree(planWriteWorktree({ primaryRoot: repo, label: "gate-side-effect" }));
    writeFileSync(join(plan.worktreePath, "candidate.txt"), "candidate\n");
    const diff = captureWriteDiff(plan);

    const result = await integrateWriteCandidate({
      plan,
      diff,
      execution: succeededExecution(),
      policy: policy(async (context) => {
        writeFileSync(join(context.cwd, "gate-side-effect.txt"), "must not commit\n");
        return passed;
      }),
    });

    expect(result.outcome).toBe("blocked_candidate_gates");
    expect(result.reason).toContain("state changed during gate execution");
    expect(result.candidateCommit).toBeNull();
    expect(getHeadSha(repo)).toBe(base);
    expect(existsSync(join(repo, "candidate.txt"))).toBe(false);
    expect(existsSync(join(repo, "gate-side-effect.txt"))).toBe(false);
    expect(runGitStrict(["branch", "--list", "headless/candidate/*"], repo).stdout.trim()).toBe("");
  });

  gitTest("oversized raw diffs fail closed before commit", async () => {
    const repo = initRepo();
    const base = getHeadSha(repo)!;
    const plan = createWriteWorktree(planWriteWorktree({ primaryRoot: repo, label: "oversized" }));
    writeFileSync(join(plan.worktreePath, "candidate.txt"), "candidate\n");

    const result = await integrateWriteCandidate({
      plan,
      diff: { diff: "x".repeat(8_000_001), status: "?? candidate.txt\n", files: ["candidate.txt"] },
      execution: succeededExecution(),
      policy: policy(async () => passed),
    });

    expect(result.outcome).toBe("blocked_candidate_gates");
    expect(result.candidateCommit).toBeNull();
    expect(result.evidence).toContain("raw-diff-limit-exceeded");
    expect(getHeadSha(repo)).toBe(base);
    expect(runGitStrict(["branch", "--list", "headless/candidate/*"], repo).stdout.trim()).toBe("");
  });

  gitTest("project Git clean filters cannot execute during checkout, capture, or commit", async () => {
    const poisonedRepo = initRepo();
    const marker = join(poisonedRepo, "..", `filter-executed-${Date.now()}`);
    writeFileSync(join(poisonedRepo, ".gitattributes"), "filtered.txt filter=evil\n");
    writeFileSync(join(poisonedRepo, "filtered.txt"), "base content\n");
    commitAll(poisonedRepo, "add filtered fixture before driver config");
    expect(runGitStrict(["config", "filter.evil.clean", `sh -c 'touch ${marker}; cat'`], poisonedRepo).ok).toBe(true);
    expect(() => planWriteWorktree({ primaryRoot: poisonedRepo, label: "poisoned-filter" })).toThrow("filter.evil.clean");
    expect(existsSync(marker)).toBe(false);

    const repo = initRepo();
    const plan = createWriteWorktree(planWriteWorktree({ primaryRoot: repo, label: "filter-attribute" }));
    writeFileSync(join(plan.worktreePath, ".gitattributes"), "filtered.txt filter=evil\n");
    writeFileSync(join(plan.worktreePath, "filtered.txt"), "safe content\n");
    expect(() => captureWriteDiff(plan)).toThrow("clean filters are prohibited");
    expect(existsSync(marker)).toBe(false);

    const result = await integrateWriteCandidate({
      plan,
      diff: {
        diff: "diff --git a/filtered.txt b/filtered.txt\nnew file mode 100644\n+safe content\n",
        status: "?? .gitattributes\n?? filtered.txt\n",
        files: [".gitattributes", "filtered.txt"],
      },
      execution: succeededExecution(),
      policy: policy(async () => passed),
    });

    expect(result.outcome).toBe("blocked_candidate_gates");
    expect(result.candidateCommit).toBeNull();
    expect(result.evidence).toContain("git-clean-filter-rejected");
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(repo, "filtered.txt"))).toBe(false);
  });
});

function initRepo() {
  const repo = mkdtempSync(join(tmpdir(), "headless-write-integration-"));
  expect(runGitStrict(["init", "-b", "main"], repo).ok).toBe(true);
  writeFileSync(join(repo, ".gitignore"), ".headless/\n");
  writeFileSync(join(repo, "README.md"), "base line\n");
  commitAll(repo, "initial");
  return repo;
}

function commitAll(repo: string, message: string) {
  expect(runGitStrict(["add", "--all"], repo).ok).toBe(true);
  expect(runGitStrict(["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--no-gpg-sign", "-m", message], repo).ok).toBe(true);
}

function policy(evaluateGates: (context: WriteGateContext) => Promise<WriteGateDecision>) {
  return {
    actor: "coordinator",
    grantId: null,
    autoMerge: true,
    reauthorize: async () => ({ allowed: true, reason: "fixture authority" }),
    evaluateGates,
  };
}

function succeededExecution() {
  return {
    succeeded: true,
    status: "succeeded" as const,
    usage: { input: 1, output: 1, reasoning: null, cached: null, providerTotal: 2 },
    costUsd: 0.01,
  };
}
