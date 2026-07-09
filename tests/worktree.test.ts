import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGitStrict } from "../src/runtime/git";
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

  gitTest("does not treat headless's own .headless/ state as a dirty primary", () => {
    // A repo that has NOT pre-ignored .headless/. Headless writes its session
    // ledger there before creating the worktree; that must not trip the
    // dirty-primary guard, or contained write mode would refuse everywhere.
    const repo = mkdtempSync(join(tmpdir(), "headless-repo-noignore-"));
    expect(runGitStrict(["init"], repo).ok).toBe(true);
    writeFileSync(join(repo, "README.md"), "base\n", "utf8");
    expect(runGitStrict(["add", "README.md"], repo).ok).toBe(true);
    expect(runGitStrict(["-c", "user.email=h@example.test", "-c", "user.name=H", "commit", "-m", "init"], repo).ok).toBe(true);
    mkdirSync(join(repo, ".headless", "sessions", "s"), { recursive: true });
    writeFileSync(join(repo, ".headless", "sessions", "s", "ledger.jsonl"), "{}\n", "utf8");

    // git sees `?? .headless/`, but the worktree guard must ignore it.
    expect(runGitStrict(["status", "--porcelain"], repo).stdout).toContain(".headless/");
    const plan = createWriteWorktree(planWriteWorktree({ primaryRoot: repo, tempBase: mkdtempSync(join(tmpdir(), "headless-worktrees-")) }));
    removeWriteWorktree(plan, { force: true });

    expect(plan.branch).toStartWith("headless/write/");
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
