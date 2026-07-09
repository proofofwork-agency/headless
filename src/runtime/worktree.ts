import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { getHeadSha, runGitStrict } from "./git";

const WRITE_BRANCH_PREFIX = "headless/write/";
const WRITE_WORKTREE_DIR_PREFIX = "headless-write-";
const WRITE_LABEL_MAX_LENGTH = 40;

export interface WriteWorktreePlan {
  primaryRoot: string;
  branch: string;
  worktreePath: string;
  baseSha: string;
  ephemeral: true;
}

export interface PlanWriteWorktreeInput {
  primaryRoot?: string;
  tempBase?: string;
  label?: string;
}

export interface WriteDiff {
  diff: string;
  status: string;
  files: string[];
}

export interface RemoveWriteWorktreeOptions {
  force?: boolean;
  pruneBranch?: boolean;
}

export interface RemoveWriteWorktreeResult {
  worktreeRemoved: boolean;
  branchPruned: boolean;
  wasPresent: boolean;
  refused?: { reason: "uncaptured-changes" | "status-check-failed"; status: string };
}

export interface SweepOrphanWriteWorktreesResult {
  removedWorktrees: string[];
  prunedBranches: string[];
  errors: string[];
}

interface WorktreeStatus {
  ok: boolean;
  dirty: boolean;
  status: string;
  stderr: string;
}

interface WorktreeListEntry {
  path: string;
  head?: string;
  branch?: string;
}

export function planWriteWorktree(input: PlanWriteWorktreeInput = {}): WriteWorktreePlan {
  const primary = canonicalExistingWorktreePath(input.primaryRoot ?? process.cwd());
  if (!isGitWorktreeRoot(primary)) {
    throw new Error(`planWriteWorktree: primary path is not a git worktree root: ${primary}`);
  }
  const baseSha = getHeadSha(primary);
  if (!baseSha) {
    throw new Error(`planWriteWorktree: could not resolve HEAD for primary tree: ${primary}`);
  }

  const id = randomUUID().slice(0, 8);
  const slug = sanitizeLabel(input.label);
  const branch = `${WRITE_BRANCH_PREFIX}${slug ? `${slug}-` : ""}${id}`;
  const worktreePath = join(input.tempBase ?? tmpdir(), `${WRITE_WORKTREE_DIR_PREFIX}${id}`);

  const targetResolved = canonicalizeForContainment(worktreePath);
  if (isPathWithinOrEqual(targetResolved, primary) || isPathWithinOrEqual(primary, targetResolved)) {
    throw new Error(`planWriteWorktree: worktree target must not be inside the primary tree: ${targetResolved}`);
  }

  return { primaryRoot: primary, branch, worktreePath, baseSha, ephemeral: true };
}

export function createWriteWorktree(plan: WriteWorktreePlan): WriteWorktreePlan {
  const primary = canonicalExistingWorktreePath(plan.primaryRoot);
  if (!isGitWorktreeRoot(primary)) {
    throw new Error(`createWriteWorktree: primary path is not a git worktree root: ${primary}`);
  }

  const primaryStatus = readWorktreeStatusStrict(primary);
  if (!primaryStatus.ok) {
    throw new Error(`createWriteWorktree: cannot verify primary tree is clean: ${primaryStatus.stderr}`);
  }
  if (primaryStatus.dirty) {
    throw new Error(`createWriteWorktree: refusing to branch from a dirty primary tree: ${primary}`);
  }

  const target = canonicalizeForContainment(plan.worktreePath);
  if (isPathWithinOrEqual(target, primary) || isPathWithinOrEqual(primary, target)) {
    throw new Error(`createWriteWorktree: worktreePath must not be the primary tree or inside it: ${target}`);
  }

  if (existsSync(plan.worktreePath)) {
    throw new Error(`createWriteWorktree: worktreePath already exists: ${plan.worktreePath}`);
  }

  if (runGitStrict(["rev-parse", "--verify", "--quiet", `refs/heads/${plan.branch}`], primary).ok) {
    throw new Error(`createWriteWorktree: branch already exists: ${plan.branch}`);
  }

  const list = runGitStrict(["worktree", "list", "--porcelain"], primary);
  if (!list.ok) {
    throw new Error(`createWriteWorktree: could not list worktrees to check for collisions: ${list.stderr.trim()}`);
  }
  for (const line of list.stdout.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const registered = normalizeWorktreePath(line.slice("worktree ".length).trim());
    if (registered && registered === normalizeWorktreePath(target)) {
      throw new Error(`createWriteWorktree: worktree path already registered: ${target}`);
    }
  }

  const added = runGitStrict(["worktree", "add", "-b", plan.branch, plan.worktreePath, plan.baseSha], primary);
  if (!added.ok) {
    throw new Error(`createWriteWorktree: git worktree add failed: ${added.stderr.trim()}`);
  }

  if (getHeadSha(plan.worktreePath) !== plan.baseSha) {
    try {
      removeWriteWorktree(plan, { force: true });
    } catch {}
    throw new Error(`createWriteWorktree: HEAD mismatch after creation for ${plan.worktreePath}`);
  }

  return plan;
}

export function captureWriteDiff(plan: WriteWorktreePlan): WriteDiff {
  if (!existsSync(plan.worktreePath)) {
    throw new Error(`captureWriteDiff: worktree path missing: ${plan.worktreePath}`);
  }

  const statusResult = runGitStrict(["status", "--porcelain"], plan.worktreePath);
  if (!statusResult.ok) {
    throw new Error(`captureWriteDiff: git status failed: ${statusResult.stderr.trim()}`);
  }

  const untrackedPaths = untrackedPorcelainPaths(statusResult.stdout);
  const addIntentResult = runGitStrict(["add", "-N", "."], plan.worktreePath);
  if (!addIntentResult.ok && untrackedPaths.length > 0) {
    const stderr = addIntentResult.stderr.trim() || "unknown error";
    throw new Error(`captureWriteDiff: git add -N failed; untracked files would be omitted: ${untrackedPaths.join(", ")} :: ${stderr}`);
  }

  const diffResult = runGitStrict(["diff", plan.baseSha], plan.worktreePath);
  if (!diffResult.ok) {
    throw new Error(`captureWriteDiff: git diff failed: ${diffResult.stderr.trim()}`);
  }
  const namesResult = runGitStrict(["diff", "--name-only", plan.baseSha], plan.worktreePath);
  if (!namesResult.ok) {
    throw new Error(`captureWriteDiff: git diff --name-only failed: ${namesResult.stderr.trim()}`);
  }

  return {
    diff: diffResult.stdout,
    status: statusResult.stdout,
    files: parseDiffNames(namesResult.stdout),
  };
}

export function removeWriteWorktree(plan: WriteWorktreePlan, opts: RemoveWriteWorktreeOptions = {}): RemoveWriteWorktreeResult {
  if (!existsSync(plan.worktreePath)) {
    runGitStrict(["worktree", "prune"], plan.primaryRoot);
    const branchPruned = pruneWriteBranch(plan, opts);
    return { worktreeRemoved: true, branchPruned, wasPresent: false };
  }

  if (!opts.force) {
    const status = readWorktreeStatusStrict(plan.worktreePath);
    if (!status.ok) {
      return { worktreeRemoved: false, branchPruned: false, wasPresent: true, refused: { reason: "status-check-failed", status: status.stderr } };
    }
    if (status.dirty) {
      return { worktreeRemoved: false, branchPruned: false, wasPresent: true, refused: { reason: "uncaptured-changes", status: status.status } };
    }
  }

  const args = ["worktree", "remove", plan.worktreePath];
  if (opts.force) args.push("--force");
  const removed = runGitStrict(args, plan.primaryRoot);
  if (!removed.ok && !isAlreadyRemovedStderr(removed.stderr)) {
    throw new Error(`removeWriteWorktree: git worktree remove failed: ${removed.stderr.trim()}`);
  }

  runGitStrict(["worktree", "prune"], plan.primaryRoot);
  const branchPruned = pruneWriteBranch(plan, opts);

  return { worktreeRemoved: true, branchPruned, wasPresent: true };
}

export function sweepOrphanWriteWorktrees(primaryRoot: string, options: { branchPrefix?: string; log?: (message: string) => void } = {}): SweepOrphanWriteWorktreesResult {
  const branchPrefix = options.branchPrefix ?? WRITE_BRANCH_PREFIX;
  const result: SweepOrphanWriteWorktreesResult = { removedWorktrees: [], prunedBranches: [], errors: [] };

  const list = runGitStrict(["worktree", "list", "--porcelain"], primaryRoot);
  if (!list.ok) {
    result.errors.push(`worktree list failed: ${list.stderr.trim()}`);
    return result;
  }

  for (const entry of parseWorktreeListPorcelain(list.stdout)) {
    if (!entry.branch || !entry.branch.startsWith(branchPrefix)) continue;
    if (!basename(entry.path).startsWith(WRITE_WORKTREE_DIR_PREFIX)) continue;
    const plan: WriteWorktreePlan = {
      primaryRoot,
      branch: entry.branch,
      worktreePath: entry.path,
      baseSha: entry.head ?? "",
      ephemeral: true,
    };
    try {
      const removed = removeWriteWorktree(plan, { force: true, pruneBranch: true });
      if (removed.worktreeRemoved && removed.wasPresent) result.removedWorktrees.push(entry.path);
      if (removed.branchPruned) result.prunedBranches.push(entry.branch);
      options.log?.(`Swept orphaned write worktree: ${entry.path} (branch ${entry.branch})`);
    } catch (err) {
      result.errors.push(`remove ${entry.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const branches = runGitStrict(["branch", "--list", `${branchPrefix}*`, "--format=%(refname:short)"], primaryRoot);
  if (!branches.ok) {
    result.errors.push(`branch list failed: ${branches.stderr.trim()}`);
  } else {
    for (const branch of branches.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
      if (result.prunedBranches.includes(branch)) continue;
      const deleted = runGitStrict(["branch", "-D", branch], primaryRoot);
      if (deleted.ok) {
        result.prunedBranches.push(branch);
        options.log?.(`Pruned orphaned write branch: ${branch}`);
      } else if (!/checked out|used by worktree/i.test(deleted.stderr)) {
        result.errors.push(`branch -D ${branch}: ${deleted.stderr.trim()}`);
      }
    }
  }

  runGitStrict(["worktree", "prune"], primaryRoot);
  return result;
}

function canonicalExistingWorktreePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) throw new Error("worktreePath must not be empty.");
  const resolved = resolve(trimmed);
  if (!existsSync(resolved)) {
    throw new Error(`Worktree path does not exist: ${resolved}`);
  }
  return realpathSync.native(resolved);
}

function isGitWorktreeRoot(path: string): boolean {
  return existsSync(join(path, ".git"));
}

function isPathWithinOrEqual(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function sanitizeLabel(label: string | undefined): string {
  if (!label) return "";
  return label
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, WRITE_LABEL_MAX_LENGTH)
    .replace(/-+$/g, "");
}

function canonicalizeForContainment(path: string): string {
  let current = resolve(path);
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return resolve(path);
    tail.unshift(current.slice(parent.length + 1));
    current = parent;
  }
  try {
    return tail.length ? join(realpathSync.native(current), ...tail) : realpathSync.native(current);
  } catch {
    return resolve(path);
  }
}

function unquotePorcelainPath(token: string): string {
  if (!(token.startsWith('"') && token.endsWith('"') && token.length >= 2)) return token;
  const body = token.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== "\\") {
      for (const b of Buffer.from(ch, "utf8")) bytes.push(b);
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) {
      bytes.push(0x5c);
      continue;
    }
    if (next >= "0" && next <= "7") {
      let octal = "";
      let j = i + 1;
      while (j < body.length && octal.length < 3 && body[j] >= "0" && body[j] <= "7") {
        octal += body[j];
        j += 1;
      }
      bytes.push(parseInt(octal, 8) & 0xff);
      i = j - 1;
      continue;
    }
    switch (next) {
      case "\\":
        bytes.push(0x5c);
        break;
      case '"':
        bytes.push(0x22);
        break;
      case "t":
        bytes.push(0x09);
        break;
      case "n":
        bytes.push(0x0a);
        break;
      default:
        bytes.push(0x5c);
        for (const b of Buffer.from(next, "utf8")) bytes.push(b);
        break;
    }
    i += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

function parseDiffNames(names: string): string[] {
  const files: string[] = [];
  for (const line of names.split("\n")) {
    if (!line.trim()) continue;
    files.push(unquotePorcelainPath(line.trim()));
  }
  return files;
}

function untrackedPorcelainPaths(status: string): string[] {
  const paths: string[] = [];
  for (const line of status.split(/\r?\n/)) {
    if (!line.startsWith("?? ")) continue;
    paths.push(unquotePorcelainPath(line.slice(3).trim()));
  }
  return paths;
}

function readWorktreeStatusStrict(cwd: string): WorktreeStatus {
  const status = runGitStrict(["status", "--porcelain"], cwd);
  // Headless writes its own session ledger under `.headless/` in the run cwd.
  // That is our runtime state, not the caller's uncommitted work, so it must
  // not count as a dirty primary — otherwise contained write mode would refuse
  // in any repo that has not pre-ignored `.headless/`.
  const meaningful = filterHeadlessStatePaths(status.stdout);
  return {
    ok: status.ok,
    dirty: status.ok && meaningful.trim().length > 0,
    status: meaningful,
    stderr: status.stderr.trim(),
  };
}

function filterHeadlessStatePaths(porcelain: string): string {
  return porcelain
    .split("\n")
    .filter((line) => {
      if (!line.trim()) return false;
      const path = unquotePorcelainPath(line.slice(3).trim());
      return path !== ".headless" && !path.startsWith(".headless/");
    })
    .join("\n");
}

function isAlreadyRemovedStderr(stderr: string): boolean {
  return stderr.toLowerCase().includes("not a working tree");
}

function pruneWriteBranch(plan: WriteWorktreePlan, opts: RemoveWriteWorktreeOptions): boolean {
  if (opts.pruneBranch === false) return false;
  if (plan.ephemeral !== true) return false;
  if (!plan.branch.startsWith(WRITE_BRANCH_PREFIX)) return false;

  const deleted = runGitStrict(["branch", "-D", plan.branch], plan.primaryRoot);
  if (deleted.ok) return true;
  return /not found|isn't a valid|does not exist|no branch named/i.test(deleted.stderr);
}

function parseWorktreeListPorcelain(stdout: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let current: WorktreeListEntry | null = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (current) entries.push(current);
      current = null;
      continue;
    }
    if (trimmed.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: trimmed.slice("worktree ".length).trim() };
    } else if (current && trimmed.startsWith("HEAD ")) {
      current.head = trimmed.slice("HEAD ".length).trim();
    } else if (current && trimmed.startsWith("branch ")) {
      current.branch = trimmed.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    }
  }
  if (current) entries.push(current);
  return entries;
}

function normalizeWorktreePath(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const resolved = resolve(trimmed);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}
