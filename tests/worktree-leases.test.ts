import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { runGitStrict } from "../src/runtime/git";
import { WorktreeLeaseStore } from "../src/runtime/worktree-leases";
import { createWriteWorktree, planWriteWorktree, removeWriteWorktree } from "../src/runtime/worktree";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const gitTest = runGitStrict(["--version"], process.cwd()).ok ? test : test.skip;

describe("durable worktree leases", () => {
  test("can separate executable checkouts from durable manifests", () => {
    const root = mkdtempSync(join(tmpdir(), "headless-lease-roots-"));
    roots.push(root);
    const state = join(root, "state");
    const checkoutBase = join(root, "checkouts");
    const store = new WorktreeLeaseStore(state, "a".repeat(64), { checkoutBase });

    expect(store.checkoutRoot).toBe(checkoutBase);
    expect(store.manifestsRoot).toBe(join(state, "leases"));
  });

  gitTest("keeps a live lease active and records terminal release", () => {
    const { repo, state, projectId } = fixture();
    const store = new WorktreeLeaseStore(state, projectId);
    const hooks = store.createHooks("job-live");
    const planned = planWriteWorktree({ primaryRoot: repo, tempBase: hooks.tempBase });
    hooks.onPlanned(planned, "candidate");
    const plan = createWriteWorktree(planned);
    hooks.onCreated(plan, "candidate");

    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.state).toBe("active");
    expect(store.reconcile()).toEqual([]);
    expect(existsSync(plan.worktreePath)).toBe(true);

    removeWriteWorktree(plan, { force: true, pruneBranch: true });
    hooks.onTerminal(plan, "succeeded");
    expect(store.list()[0]).toMatchObject({ state: "released", terminalOutcome: "succeeded" });
  });

  gitTest("preserves a crashed owner's checkout and captures recovery evidence", () => {
    const { repo, state, projectId } = fixture();
    const crashed = new WorktreeLeaseStore(state, projectId, {
      owner: { pid: 999_999, processStart: "dead:start", host: hostname(), nonce: crypto.randomUUID() },
    });
    const hooks = crashed.createHooks("job-crashed");
    const planned = planWriteWorktree({ primaryRoot: repo, tempBase: hooks.tempBase });
    hooks.onPlanned(planned, "candidate");
    const plan = createWriteWorktree(planned);
    writeFileSync(join(plan.worktreePath, "candidate.txt"), "preserve me\n");
    // Simulate a kill after `git worktree add` but before activation. The
    // preparing manifest must still make the orphan discoverable.

    const restarted = new WorktreeLeaseStore(state, projectId);
    const [lease] = restarted.reconcile();
    expect(lease).toMatchObject({ state: "crashed", terminalOutcome: "daemon_owner_crashed" });
    expect(lease?.evidence.join("\n")).toContain("candidate.txt");
    expect(existsSync(plan.worktreePath)).toBe(true);
    expect(runGitStrict(["rev-parse", "--verify", `refs/heads/${plan.branch}`], repo).ok).toBe(true);

    removeWriteWorktree(plan, { force: true, pruneBranch: true });
  });

  gitTest("fails closed and leaves a foreign-host lease active", () => {
    const { repo, state, projectId } = fixture();
    const foreign = new WorktreeLeaseStore(state, projectId, {
      owner: { pid: process.pid, processStart: "foreign:start", host: `foreign-${hostname()}`, nonce: crypto.randomUUID() },
    });
    const hooks = foreign.createHooks("job-foreign");
    const planned = planWriteWorktree({ primaryRoot: repo, tempBase: hooks.tempBase });
    hooks.onPlanned(planned, "candidate");
    const plan = createWriteWorktree(planned);
    hooks.onCreated(plan, "candidate");

    const restarted = new WorktreeLeaseStore(state, projectId);
    expect(() => restarted.reconcile()).toThrow("refusing daemon takeover");
    expect(restarted.list()[0]).toMatchObject({ state: "active", terminalOutcome: null });
    expect(existsSync(plan.worktreePath)).toBe(true);

    removeWriteWorktree(plan, { force: true, pruneBranch: true });
  });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "headless-worktree-leases-"));
  roots.push(root);
  const repo = join(root, "repo");
  expect(runGitStrict(["init", repo], root).ok).toBe(true);
  writeFileSync(join(repo, "README.md"), "base\n");
  expect(runGitStrict(["add", "README.md"], repo).ok).toBe(true);
  expect(runGitStrict(["-c", "user.email=test@example.test", "-c", "user.name=Test", "commit", "-m", "init"], repo).ok).toBe(true);
  return {
    repo,
    state: join(root, "state", "worktrees"),
    projectId: createHash("sha256").update(repo).digest("hex"),
  };
}
