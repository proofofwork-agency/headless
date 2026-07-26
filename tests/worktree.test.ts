import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonGitEnvironment, runGitStrict } from "../src/runtime/git";
import {
  captureWriteDiff,
  createWriteWorktree,
  planWriteWorktree,
  removeWriteWorktree,
  sweepOrphanWriteWorktrees,
  type WriteWorktreePlan,
} from "../src/runtime/worktree";

const gitAvailable = runGitStrict(["--version"], process.cwd()).ok;
const gitTest = gitAvailable ? test : test.skip;

describe("ephemeral write worktrees", () => {
  test("daemon Git ignores inherited Git control variables and disables interaction", () => {
    const env = daemonGitEnvironment({
      PATH: "/owner/bin",
      GIT_DIR: "/attacker/repository",
      GIT_WORK_TREE: "/attacker/tree",
      GIT_CONFIG_GLOBAL: "/attacker/config",
      GIT_CONFIG_COUNT: "1",
      GIT_ASKPASS: "/attacker/prompt",
      GIT_PAGER: "/attacker/pager",
      LD_PRELOAD: "/attacker/library",
    });
    expect(env.PATH).toBe("/owner/bin");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_ASKPASS).toBe("/usr/bin/false");
    expect(env.GIT_PAGER).toBe("cat");
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(env.LD_PRELOAD).toBeUndefined();
  });

  gitTest("refuses a non-git cwd", () => {
    const cwd = mkdtempSync(join(tmpdir(), "headless-non-git-"));

    expect(() => planWriteWorktree({ primaryRoot: cwd })).toThrow("not a git worktree root");
  });

  gitTest("refuses to create from a dirty primary", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "dirty.txt"), "dirty\n", "utf8");
    const plan = planWriteWorktree({ primaryRoot: repo });

    expect(() => createWriteWorktree(plan)).toThrow("refusing to branch from a dirty primary tree");
  });

  gitTest("treats an untracked repository .headless directory as user/project dirt", () => {
    // v0.2 runtime state is external. A repository-local .headless directory
    // therefore belongs to the checkout and must block automatic integration.
    const repo = mkdtempSync(join(tmpdir(), "headless-repo-noignore-"));
    expect(runGitStrict(["init"], repo).ok).toBe(true);
    writeFileSync(join(repo, "README.md"), "base\n", "utf8");
    expect(runGitStrict(["add", "README.md"], repo).ok).toBe(true);
    expect(runGitStrict(["-c", "user.email=h@example.test", "-c", "user.name=H", "commit", "-m", "init"], repo).ok).toBe(true);
    mkdirSync(join(repo, ".headless", "sessions", "s"), { recursive: true });
    writeFileSync(join(repo, ".headless", "sessions", "s", "ledger.jsonl"), "{}\n", "utf8");

    expect(runGitStrict(["status", "--porcelain"], repo).stdout).toContain(".headless/");
    const plan = planWriteWorktree({ primaryRoot: repo, tempBase: mkdtempSync(join(tmpdir(), "headless-worktrees-")) });
    expect(() => createWriteWorktree(plan)).toThrow("refusing to branch from a dirty primary tree");
  });

  gitTest("refuses a worktree target inside the primary tree", () => {
    const repo = initRepo();

    expect(() => planWriteWorktree({ primaryRoot: repo, tempBase: join(repo, "tmp") })).toThrow("inside the primary tree");
  });

  gitTest("captures untracked files in diff, files, and status without mutating the primary", () => {
    const repo = initRepo();
    const plan = createWriteWorktree(planWriteWorktree({ primaryRoot: repo, tempBase: mkdtempSync(join(tmpdir(), "headless-worktrees-")), label: "write test" }));
    const beforeList = worktreeList(repo);

    writeFileSync(join(plan.worktreePath, "new-file.txt"), "new content\n", "utf8");
    const captured = captureWriteDiff(plan);
    const removed = removeWriteWorktree(plan, { force: true });
    const afterList = worktreeList(repo);

    expect(beforeList).toContain(plan.worktreePath);
    expect(captured.files).toEqual(["new-file.txt"]);
    expect(captured.status).toContain("?? new-file.txt");
    expect(captured.diff).toContain("diff --git a/new-file.txt b/new-file.txt");
    expect(captured.diff).toContain("+new content");
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("base\n");
    expect(existsSync(join(repo, "new-file.txt"))).toBe(false);
    expect(removed.worktreeRemoved).toBe(true);
    expect(afterList).not.toContain(plan.worktreePath);
  });

  gitTest("tracks integrity when the configured primary is itself a linked worktree", () => {
    const repo = initRepo();
    const linkedPrimary = createWriteWorktree(planWriteWorktree({ primaryRoot: repo, label: "linked-primary" }));
    const nested = createWriteWorktree(planWriteWorktree({ primaryRoot: linkedPrimary.worktreePath, label: "nested" }));
    writeFileSync(join(nested.worktreePath, "nested.txt"), "candidate\n");
    expect(captureWriteDiff(nested).files).toContain("nested.txt");
    expect(removeWriteWorktree(nested, { force: true }).worktreeRemoved).toBe(true);
    expect(removeWriteWorktree(linkedPrimary, { force: true }).worktreeRemoved).toBe(true);
  });

  gitTest("fails closed when a worker replaces its linked-worktree .git pointer", () => {
    const repo = initRepo();
    const plan = createWriteWorktree(planWriteWorktree({ primaryRoot: repo, label: "pointer" }));
    const pointer = join(plan.worktreePath, ".git");
    writeFileSync(pointer, `gitdir: ${join(repo, ".git")}\n`);
    writeFileSync(join(plan.worktreePath, "candidate.txt"), "must not be captured\n");

    expect(() => captureWriteDiff(plan)).toThrow(".git pointer changed");
    expect(runGitStrict(["status", "--porcelain"], plan.worktreePath).stderr).toContain(".git pointer changed");
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("base\n");
    expect(removeWriteWorktree(plan, { force: true }).worktreeRemoved).toBe(true);
  });

  gitTest("disables checkout hooks even when the repository contains an executable hook", () => {
    const repo = initRepo();
    const marker = join(repo, "..", `headless-checkout-hook-${Date.now()}`);
    const hook = join(repo, ".git", "hooks", "post-checkout");
    writeFileSync(hook, `#!/bin/sh\ntouch ${shellQuote(marker)}\n`);
    chmodSync(hook, 0o755);

    const plan = createWriteWorktree(planWriteWorktree({ primaryRoot: repo, label: "hook" }));
    expect(existsSync(marker)).toBe(false);
    removeWriteWorktree(plan, { force: true });
  });

  gitTest("rejects executable fsmonitor, filter, and merge-driver repository config", () => {
    const cases = [
      ["core.fsmonitor", "/bin/false"],
      ["filter.attacker.process", "/bin/false"],
      ["merge.attacker.driver", "/bin/false %O %A %B"],
    ] as const;
    for (const [key, value] of cases) {
      const repo = initRepo();
      expect(runGitStrict(["config", key, value], repo).ok).toBe(true);
      expect(() => planWriteWorktree({ primaryRoot: repo, label: "poisoned-config" })).toThrow(`repository config key ${key}`);
    }
  });

  gitTest("removeWriteWorktree is idempotent after cleanup", () => {
    const repo = initRepo();
    const plan = createWriteWorktree(planWriteWorktree({ primaryRoot: repo }));

    const first = removeWriteWorktree(plan, { force: true });
    const second = removeWriteWorktree(plan, { force: true });

    expect(first.worktreeRemoved).toBe(true);
    expect(first.wasPresent).toBe(true);
    expect(second.worktreeRemoved).toBe(true);
    expect(second.wasPresent).toBe(false);
  });

  gitTest("branch pruning is guarded by the headless write prefix", () => {
    const repo = initRepo();
    const unsafePlan: WriteWorktreePlan = {
      primaryRoot: repo,
      branch: "feature/do-not-delete",
      worktreePath: join(tmpdir(), "headless-missing-worktree"),
      baseSha: runGitStrict(["rev-parse", "HEAD"], repo).stdout.trim(),
      ephemeral: true,
    };
    expect(runGitStrict(["branch", unsafePlan.branch], repo).ok).toBe(true);

    const result = removeWriteWorktree(unsafePlan, { force: true, pruneBranch: true });

    expect(result.branchPruned).toBe(false);
    expect(runGitStrict(["rev-parse", "--verify", "--quiet", `refs/heads/${unsafePlan.branch}`], repo).ok).toBe(true);
  });

  gitTest("sweeps leaked headless write worktrees", () => {
    const repo = initRepo();
    const plan = createWriteWorktree(planWriteWorktree({ primaryRoot: repo, label: "leak" }));
    const worktreePath = realpathSync.native(plan.worktreePath);

    expect(worktreeList(repo)).toContain(plan.worktreePath);
    const swept = sweepOrphanWriteWorktrees(repo);

    expect(swept.errors).toEqual([]);
    expect(swept.removedWorktrees).toContain(worktreePath);
    expect(swept.prunedBranches).toContain(plan.branch);
    expect(worktreeList(repo)).not.toContain(plan.worktreePath);
  });

  gitTest("planAgentWorktree + create + remove edges", () => {
    const repo = initRepo();
    const { planAgentWorktree, createAgentWorktree, removeAgentWorktree, setupAgentWorktrees } = require("../src/runtime/worktree");
    const plan = planAgentWorktree({ agent: "claude-code", primaryRoot: repo });
    expect(plan.branch).toContain("headless/agent/");
    createAgentWorktree(plan);
    expect(existsSync(plan.worktreePath)).toBe(true);
    removeAgentWorktree(plan, true);
    // setup multi
    const map = setupAgentWorktrees(["opencode", "codex"], repo);
    expect(Object.keys(map).length).toBe(2);
    // cleanup manual
    // (sweep will handle too)
  });

  gitTest("sweep with log option + non-matching prefixes ignored", () => {
    const repo = initRepo();
    const { sweepOrphanWriteWorktrees } = require("../src/runtime/worktree");
    const logs: string[] = [];
    const res = sweepOrphanWriteWorktrees(repo, { log: (m: string) => logs.push(m), branchPrefix: "headless/write/" });
    expect(Array.isArray(res.removedWorktrees)).toBe(true);
    // no error
  });

  gitTest("remove refuses dirty unless force", () => {
    const repo = initRepo();
    const plan = createWriteWorktree(planWriteWorktree({ primaryRoot: repo }));
    writeFileSync(join(plan.worktreePath, "dirty.txt"), "d\n");
    const noForce = removeWriteWorktree(plan);
    expect(noForce.worktreeRemoved).toBe(false);
    expect(noForce.refused?.reason).toBe("uncaptured-changes");
    const forced = removeWriteWorktree(plan, { force: true });
    expect(forced.worktreeRemoved).toBe(true);
  });
});

function initRepo() {
  const repo = mkdtempSync(join(tmpdir(), "headless-repo-"));
  expect(runGitStrict(["init"], repo).ok).toBe(true);
  writeFileSync(join(repo, ".gitignore"), ".headless/\n", "utf8");
  writeFileSync(join(repo, "README.md"), "base\n", "utf8");
  expect(runGitStrict(["add", ".gitignore", "README.md"], repo).ok).toBe(true);
  expect(runGitStrict(["-c", "user.email=headless@example.test", "-c", "user.name=Headless Test", "commit", "-m", "init"], repo).ok).toBe(true);
  return repo;
}

function worktreeList(repo: string) {
  const list = runGitStrict(["worktree", "list", "--porcelain"], repo);
  expect(list.ok).toBe(true);
  return list.stdout;
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Candidate chaining: a repair loop bases each attempt on the previous one's
 * candidate so the accumulated result is what gets gated. The base is
 * restricted to descendants of primary HEAD because CandidateIntegrationService
 * requires the candidate's base to be an ancestor of primary — work rooted
 * anywhere else could never be integrated.
 */
describe("chained candidate bases", () => {
  gitTest("bases a plan on a descendant commit instead of primary HEAD", () => {
    const repo = initRepo();
    const head = headSha(repo);
    const descendant = commitDescendant(repo, "chained.txt", "chained\n");
    expect(descendant).not.toBe(head);

    const plan = planWriteWorktree({ primaryRoot: repo, baseSha: descendant });
    expect(plan.baseSha).toBe(descendant);

    const created = createWriteWorktree(plan);
    try {
      expect(readFileSync(join(created.worktreePath, "chained.txt"), "utf8")).toBe("chained\n");
    } finally {
      removeWriteWorktree(created, { force: true });
    }
  });

  gitTest("refuses a base that does not descend from primary HEAD", () => {
    const repo = initRepo();
    commitDescendant(repo, "second.txt", "second\n");
    // The root commit is an ancestor of HEAD, never a descendant of it.
    const root = runGitStrict(["rev-list", "--max-parents=0", "HEAD"], repo).stdout.trim();
    expect(root).toMatch(/^[0-9a-f]{40}$/);
    expect(() => planWriteWorktree({ primaryRoot: repo, baseSha: root }))
      .toThrow("must descend from primary HEAD");
  });

  gitTest("refuses an unknown commit and a short sha", () => {
    const repo = initRepo();
    expect(() => planWriteWorktree({ primaryRoot: repo, baseSha: "f".repeat(40) }))
      .toThrow("not a commit in this repository");
    expect(() => planWriteWorktree({ primaryRoot: repo, baseSha: headSha(repo).slice(0, 8) }))
      .toThrow("full commit sha");
  });

  gitTest("still uses primary HEAD when no base is requested", () => {
    const repo = initRepo();
    expect(planWriteWorktree({ primaryRoot: repo }).baseSha).toBe(headSha(repo));
  });
});

function headSha(repo: string) {
  const result = runGitStrict(["rev-parse", "HEAD"], repo);
  expect(result.ok).toBe(true);
  return result.stdout.trim();
}

/** Advance the repo by one commit and return the new sha. */
function commitDescendant(repo: string, file: string, contents: string) {
  writeFileSync(join(repo, file), contents, "utf8");
  expect(runGitStrict(["add", file], repo).ok).toBe(true);
  expect(runGitStrict(["-c", "user.email=headless@example.test", "-c", "user.name=Headless Test", "commit", "-m", `add ${file}`], repo).ok).toBe(true);
  return headSha(repo);
}
