import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  assertSafeDaemonGitRepository,
  assertWorktreeGitIntegrity,
  getHeadSha,
  registerWorktreeGitIntegrity,
  runGitStrict,
  unregisterWorktreeGitIntegrity,
} from "./git";

// Hoisted for use in plan/create (tsc name resolution in module)
function assertNoCrossHardlink(candidate: string, primary: string): void {
  try {
    if (!existsSync(candidate)) return;
    const pStat = statSync(primary);
    const cStat = statSync(candidate);
    if (pStat.dev === cStat.dev && pStat.ino === cStat.ino) {
      throw new Error(`worktree hardlink defeat: candidate ${candidate} is hard-linked to primary ${primary}`);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/hardlink defeat/i.test(msg)) throw e;
    throw new Error(`worktree hardlink integrity check failed: ${msg}`, { cause: e });
  }
}

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

/** Daemon-owned durability hooks; direct runner callers leave this undefined. */
export interface WorktreeLeaseHooks {
  tempBase: string;
  /** Persisted before `git worktree add` so a process kill cannot create an untracked orphan. */
  onPlanned: (plan: WriteWorktreePlan, kind: "candidate" | "integration") => void;
  onCreated: (plan: WriteWorktreePlan, kind: "candidate" | "integration") => void;
  onTerminal: (plan: WriteWorktreePlan, outcome: string, evidence?: string[]) => void;
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
  assertSafeDaemonGitRepository(primary);
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

  assertNoCrossHardlink(targetResolved, primary);

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

  assertNoCrossHardlink(target, primary);

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

  try {
    registerWorktreeGitIntegrity(plan.worktreePath, primary);
  } catch (error) {
    runGitStrict(["worktree", "remove", "--force", plan.worktreePath], primary);
    runGitStrict(["branch", "-D", plan.branch], primary);
    throw new Error(`createWriteWorktree: linked worktree integrity registration failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (getHeadSha(plan.worktreePath) !== plan.baseSha) {
    try {
      removeWriteWorktree(plan, { force: true });
    } catch (cleanupError) {
      throw new Error(
        `createWriteWorktree: HEAD mismatch and rollback failed for ${plan.worktreePath}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        { cause: cleanupError },
      );
    }
    throw new Error(`createWriteWorktree: HEAD mismatch after creation for ${plan.worktreePath}`);
  }

  return plan;
}

export function captureWriteDiff(plan: WriteWorktreePlan): WriteDiff {
  if (!existsSync(plan.worktreePath)) {
    throw new Error(`captureWriteDiff: worktree path missing: ${plan.worktreePath}`);
  }
  assertWorktreeGitIntegrity(plan.worktreePath);

  // Cheap same-inode check for a common tracked file. Any inspection failure
  // is state-critical: diff capture must fail closed rather than silently
  // weakening containment evidence.
  const wtReal = realpathSync(plan.worktreePath);
  const primaryReal = realpathSync(plan.primaryRoot);
  const candidateProbe = join(wtReal, "README.md");
  const primaryProbe = join(primaryReal, "README.md");
  if (existsSync(candidateProbe) && existsSync(primaryProbe)) {
    assertNoCrossHardlink(candidateProbe, primaryProbe);
  }


  return captureWorktreeDiff(plan.worktreePath, plan.baseSha);
}

/** Capture tracked and untracked changes without touching the candidate index. */
export function captureWorktreeDiff(worktreePath: string, baseSha: string): WriteDiff {
  if (!existsSync(worktreePath)) {
    throw new Error(`captureWorktreeDiff: worktree path missing: ${worktreePath}`);
  }
  const statusResult = runGitStrict(["status", "--porcelain", "--untracked-files=all"], worktreePath);
  if (!statusResult.ok) {
    throw new Error(`captureWriteDiff: git status failed: ${statusResult.stderr.trim()}`);
  }

  const untrackedPaths = untrackedPorcelainPaths(statusResult.stdout);
  const namesResult = runGitStrict(["diff", "--no-ext-diff", "--no-textconv", "--name-only", baseSha, "--"], worktreePath);
  if (!namesResult.ok) {
    throw new Error(`captureWriteDiff: git diff --name-only failed: ${namesResult.stderr.trim()}`);
  }
  const trackedPaths = parseDiffNames(namesResult.stdout);
  assertNoExecutableGitAttributes(worktreePath, [...trackedPaths, ...untrackedPaths]);
  const diffResult = runGitStrict(["diff", "--no-ext-diff", "--no-textconv", "--binary", "--full-index", baseSha, "--"], worktreePath);
  if (!diffResult.ok) {
    throw new Error(`captureWriteDiff: git diff failed: ${diffResult.stderr.trim()}`);
  }

  const untrackedDiffs: string[] = [];
  for (const path of untrackedPaths) {
    const untracked = runGitStrict(["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--binary", "--full-index", "--", "/dev/null", path], worktreePath);
    // `git diff --no-index` returns 1 when it successfully found differences.
    if (untracked.code !== 1 && !untracked.ok) {
      throw new Error(`captureWriteDiff: could not capture untracked path ${path}: ${untracked.stderr.trim()}`);
    }
    if (untracked.stdout) untrackedDiffs.push(untracked.stdout);
  }

  return {
    diff: [diffResult.stdout, ...untrackedDiffs].filter(Boolean).join("\n"),
    status: statusResult.stdout,
    files: [...new Set([...trackedPaths, ...untrackedPaths])],
  };
}

function assertNoExecutableGitAttributes(cwd: string, files: string[]) {
  if (files.length === 0) return;
  const attributes = runGitStrict(["-c", "core.fsmonitor=false", "check-attr", "-z", "--stdin", "-a"], cwd, 30_000, `${files.join("\0")}\0`);
  if (!attributes.ok) throw new Error("captureWriteDiff: Git attributes could not be inspected safely");
  const fields = attributes.stdout.split("\0");
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const name = fields[index + 1];
    const value = fields[index + 2];
    if (name === "filter" && value !== "unspecified" && value !== "unset") {
      throw new Error("captureWriteDiff: executable Git clean filters are prohibited for candidate files");
    }
  }
}

export function removeWriteWorktree(plan: WriteWorktreePlan, opts: RemoveWriteWorktreeOptions = {}): RemoveWriteWorktreeResult {
  if (!existsSync(plan.worktreePath)) {
    unregisterWorktreeGitIntegrity(plan.worktreePath);
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
    if (opts.force && isDaemonEphemeralWorktree(plan)) {
      // A worker that replaced `.git` makes `git worktree remove` correctly
      // refuse the path. This directory was created under a daemon-only name
      // and force means its candidate contents may be discarded, so remove it
      // without asking Git to follow the corrupted pointer, then prune only the
      // primary repository's own metadata.
      rmSync(plan.worktreePath, { recursive: true, force: true });
    } else {
      throw new Error(`removeWriteWorktree: git worktree remove failed: ${removed.stderr.trim()}`);
    }
  }
  unregisterWorktreeGitIntegrity(plan.worktreePath);

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

// P1 hardlink defeat fix for worktree: refuse targets that are hardlinked to primary (same dev+ino at root).
// Full tree scan for cross hardlinks post-write is expensive; this catches root-level and documents the limit.
// (Seatbelt subpath defeats via hardlink from code-exec are mitigated at app+git layer for write mode.)


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
  return {
    ok: status.ok,
    dirty: status.ok && status.stdout.trim().length > 0,
    status: status.stdout,
    stderr: status.stderr.trim(),
  };
}

function isAlreadyRemovedStderr(stderr: string): boolean {
  return stderr.toLowerCase().includes("not a working tree");
}

function isDaemonEphemeralWorktree(plan: WriteWorktreePlan) {
  return plan.ephemeral === true
    && plan.branch.startsWith(WRITE_BRANCH_PREFIX)
    && basename(plan.worktreePath).startsWith(WRITE_WORKTREE_DIR_PREFIX)
    && !isPathWithinOrEqual(plan.worktreePath, plan.primaryRoot)
    && !isPathWithinOrEqual(plan.primaryRoot, plan.worktreePath);
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

// === Per-agent / Council-style isolated worktrees (inspired by claw-orchestrator + CR) ===
// Allows spinning up dedicated worktrees per AI coder/agent for safe parallel work.
// Branch convention: headless/agent/<agent> or council/<agent>
// Use these from orchestrator / councilDeliberate for multi-coder fleets.

const AGENT_WORKTREE_PREFIX = "headless/agent/";
const AGENT_WORKTREE_DIR_PREFIX = "headless-agent-";

export interface AgentWorktreePlan {
  agent: string;
  primaryRoot: string;
  branch: string;
  worktreePath: string;
  baseSha: string;
}

export interface PlanAgentWorktreeInput {
  agent: string;
  primaryRoot?: string;
  tempBase?: string;
}

export function planAgentWorktree(input: PlanAgentWorktreeInput): AgentWorktreePlan {
  const primary = canonicalExistingWorktreePath(input.primaryRoot ?? process.cwd());
  if (!isGitWorktreeRoot(primary)) {
    throw new Error(`planAgentWorktree: primary is not a git worktree root: ${primary}`);
  }
  assertSafeDaemonGitRepository(primary);
  const baseSha = getHeadSha(primary);
  if (!baseSha) throw new Error("planAgentWorktree: could not resolve HEAD");

  const agentSlug = sanitizeLabel(input.agent);
  if (!agentSlug) throw new Error("planAgentWorktree: agent name required");

  const id = randomUUID().slice(0, 8);
  const branch = `${AGENT_WORKTREE_PREFIX}${agentSlug}-${id}`;
  const worktreePath = join(input.tempBase ?? tmpdir(), `${AGENT_WORKTREE_DIR_PREFIX}${agentSlug}-${id}`);

  return {
    agent: input.agent,
    primaryRoot: primary,
    branch,
    worktreePath,
    baseSha,
  };
}

export function createAgentWorktree(plan: AgentWorktreePlan): AgentWorktreePlan {
  const primary = canonicalExistingWorktreePath(plan.primaryRoot);
  if (!isGitWorktreeRoot(primary)) {
    throw new Error(`createAgentWorktree: primary not git root: ${primary}`);
  }

  const status = readWorktreeStatusStrict(primary);
  if (!status.ok || status.dirty) {
    throw new Error(`createAgentWorktree: primary must be clean`);
  }

  if (existsSync(plan.worktreePath)) {
    throw new Error(`createAgentWorktree: path exists ${plan.worktreePath}`);
  }

  const added = runGitStrict(["worktree", "add", "-b", plan.branch, plan.worktreePath, plan.baseSha], primary);
  if (!added.ok) {
    throw new Error(`createAgentWorktree: git worktree add failed: ${added.stderr.trim()}`);
  }

  try {
    registerWorktreeGitIntegrity(plan.worktreePath, primary);
  } catch (error) {
    runGitStrict(["worktree", "remove", "--force", plan.worktreePath], primary);
    runGitStrict(["branch", "-D", plan.branch], primary);
    throw new Error(`createAgentWorktree: linked worktree integrity registration failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return plan;
}

export function removeAgentWorktree(plan: AgentWorktreePlan, force = false): void {
  if (existsSync(plan.worktreePath)) {
    const args = ["worktree", "remove", plan.worktreePath];
    if (force) args.push("--force");
    runGitStrict(args, plan.primaryRoot);
  }
  unregisterWorktreeGitIntegrity(plan.worktreePath);
  runGitStrict(["worktree", "prune"], plan.primaryRoot);
  if (plan.branch.startsWith(AGENT_WORKTREE_PREFIX)) {
    runGitStrict(["branch", "-D", plan.branch], plan.primaryRoot).ok; // best effort
  }
}

/**
 * Convenience: set up isolated worktrees for a list of agents (e.g. for council-style runs).
 * Returns map of agent -> worktreePath
 */
export function setupAgentWorktrees(agents: string[], primaryRoot?: string): Record<string, string> {
  const plans = agents.map(a => planAgentWorktree({ agent: a, primaryRoot }));
  const result: Record<string, string> = {};
  for (const p of plans) {
    createAgentWorktree(p);
    result[p.agent] = p.worktreePath;
  }
  return result;
}
