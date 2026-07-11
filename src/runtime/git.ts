import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const GIT_COMMAND_TIMEOUT_MS = 2_000;
const GIT_STRICT_TIMEOUT_MS = 10_000;
const GIT_POINTER_MAX_BYTES = 4_096;

// These options are appended after any caller-supplied `-c` options so an
// internal call site cannot accidentally re-enable repository hooks or other
// executable Git extensions. Repository-local config is still inspected and
// dangerous entries fail closed below: overriding a command is not enough for
// filters and custom merge drivers whose names are selected by attributes.
const DAEMON_GIT_CONFIG = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "core.untrackedCache=false",
  "core.preloadIndex=false",
  "core.attributesFile=/dev/null",
  "commit.gpgsign=false",
  "tag.gpgsign=false",
  "merge.verifySignatures=false",
  "credential.helper=",
  "credential.interactive=never",
  "protocol.allow=never",
  "protocol.file.allow=never",
  "protocol.ext.allow=never",
  "submodule.recurse=false",
  "fetch.recurseSubmodules=false",
] as const;

const DANGEROUS_CONFIG_KEYS = [
  /^include\.path$/i,
  /^includeif\..+\.path$/i,
  /^filter\..+\.(clean|smudge|process|required)$/i,
  /^merge\..+\.driver$/i,
  /^diff\..+\.(command|textconv)$/i,
  /^difftool\..+\.cmd$/i,
  /^mergetool\..+\.cmd$/i,
  /^core\.(hooksPath|fsmonitor|attributesFile|sshCommand|worktree|alternateRefsCommand|gitProxy)$/i,
  /^gpg(?:\..+)?\.program$/i,
  /^credential\..+/i,
  /^protocol\..+\.allow$/i,
  /^url\..+\.(insteadOf|pushInsteadOf)$/i,
] as const;

interface WorktreeGitIntegrity {
  root: string;
  pointerPath: string;
  pointerContent: string;
  pointerDevice: number;
  pointerInode: number;
  pointerUid: number;
  gitDirectory: string;
  gitDirectoryDevice: number;
  gitDirectoryInode: number;
  commonGitDirectory: string;
}

const registeredWorktrees = new Map<string, WorktreeGitIntegrity>();

export interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Register the exact linked-worktree `.git` pointer created by the daemon.
 * Every subsequent host Git call whose cwd is within this worktree validates
 * the pointer before invoking Git. This prevents a contained worker from
 * redirecting host-side add/commit/diff operations to attacker-chosen state.
 */
export function registerWorktreeGitIntegrity(worktreeRoot: string, primaryRoot: string) {
  const root = realpathSync.native(worktreeRoot);
  const pointerPath = join(root, ".git");
  const pointer = readGitPointer(pointerPath);
  const commonGitDirectory = resolveCommonGitDirectory(primaryRoot);
  const gitDirectory = realpathSync.native(pointer.gitDirectory);
  if (!isPathWithin(gitDirectory, join(commonGitDirectory, "worktrees"))) {
    throw new Error(`linked worktree Git directory escapes the primary repository: ${gitDirectory}`);
  }
  const gitDirectoryStat = statSync(gitDirectory);
  if (!gitDirectoryStat.isDirectory()) throw new Error(`linked worktree Git directory is not a directory: ${gitDirectory}`);
  const evidence: WorktreeGitIntegrity = {
    root,
    pointerPath,
    pointerContent: pointer.content,
    pointerDevice: pointer.stat.dev,
    pointerInode: pointer.stat.ino,
    pointerUid: pointer.stat.uid,
    gitDirectory,
    gitDirectoryDevice: gitDirectoryStat.dev,
    gitDirectoryInode: gitDirectoryStat.ino,
    commonGitDirectory,
  };
  registeredWorktrees.set(root, evidence);
  return { root, pointerPath, gitDirectory, commonGitDirectory };
}

export function unregisterWorktreeGitIntegrity(worktreeRoot: string) {
  registeredWorktrees.delete(canonicalPathIfPresent(worktreeRoot));
  registeredWorktrees.delete(resolve(worktreeRoot));
}

export function assertWorktreeGitIntegrity(path: string) {
  const evidence = registeredIntegrityForPath(path);
  if (!evidence) return;
  const pointer = readGitPointer(evidence.pointerPath);
  if (
    pointer.content !== evidence.pointerContent
    || pointer.stat.dev !== evidence.pointerDevice
    || pointer.stat.ino !== evidence.pointerInode
    || pointer.stat.uid !== evidence.pointerUid
  ) {
    throw new Error(`linked worktree .git pointer changed after daemon creation: ${evidence.pointerPath}`);
  }
  const gitDirectory = realpathSync.native(pointer.gitDirectory);
  const gitDirectoryStat = statSync(gitDirectory);
  if (
    gitDirectory !== evidence.gitDirectory
    || gitDirectoryStat.dev !== evidence.gitDirectoryDevice
    || gitDirectoryStat.ino !== evidence.gitDirectoryInode
    || !gitDirectoryStat.isDirectory()
    || !isPathWithin(gitDirectory, join(evidence.commonGitDirectory, "worktrees"))
  ) {
    throw new Error(`linked worktree Git metadata changed after daemon creation: ${evidence.pointerPath}`);
  }
}

/** Return a minimal, non-interactive environment for all daemon-owned Git. */
export function daemonGitEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: source.PATH ?? "/usr/bin:/bin",
    HOME: existsSync("/var/empty") ? "/var/empty" : "/",
    LANG: source.LANG ?? "C",
    LC_ALL: source.LC_ALL ?? "C",
    TZ: source.TZ ?? "UTC",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
    SSH_ASKPASS: "/usr/bin/false",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
  };
  if (source.TMPDIR) env.TMPDIR = source.TMPDIR;
  return env;
}

function runGit(args: string[], cwd = process.cwd()): string | null {
  try {
    assertGitInvocationSafe(cwd, args);
    return execFileSync("git", sanitizedGitArgs(args), {
      cwd,
      env: daemonGitEnvironment(),
      encoding: "utf-8",
      timeout: GIT_COMMAND_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

export function runGitStrict(args: string[], cwd: string, timeoutMs = GIT_STRICT_TIMEOUT_MS, input?: string): GitRunResult {
  try {
    assertGitInvocationSafe(cwd, args);
  } catch (error) {
    return {
      ok: false,
      code: null,
      stdout: "",
      stderr: `Git safety validation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const result = spawnSync("git", sanitizedGitArgs(args), {
    cwd,
    env: daemonGitEnvironment(),
    encoding: "utf-8",
    timeout: timeoutMs,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    ...(input === undefined ? {} : { input }),
  });
  if (result.error) {
    const errno = (result.error as NodeJS.ErrnoException).code;
    const fallback = errno === "ENOENT" ? "git not found" : `git timed out after ${timeoutMs}ms`;
    return { ok: false, code: null, stdout: result.stdout ?? "", stderr: result.stderr || fallback };
  }
  return {
    ok: result.status === 0,
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Fail with the precise prohibited config/integrity reason before planning. */
export function assertSafeDaemonGitRepository(cwd: string) {
  assertGitInvocationSafe(cwd, ["status", "--porcelain"]);
}

export function getCurrentBranch(cwd?: string): string | null {
  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  return branch && branch.length > 0 ? branch : null;
}

export function getHeadSha(cwd?: string): string | null {
  const sha = runGit(["rev-parse", "HEAD"], cwd);
  return sha && sha.length > 0 ? sha : null;
}

export function isWorkingTreeDirty(cwd?: string): boolean {
  const status = runGit(["status", "--porcelain"], cwd);
  return status !== null && status.length > 0;
}

function assertGitInvocationSafe(cwd: string, args: string[]) {
  assertWorktreeGitIntegrity(cwd);
  if (isLocalConfigInspection(args)) return;
  const config = readRepositoryConfig(cwd);
  for (const [key, value] of config) {
    if (DANGEROUS_CONFIG_KEYS.some((pattern) => pattern.test(key))) {
      throw new Error(`repository config key ${key} is prohibited for daemon-owned Git`);
    }
    if (/^submodule\..+\.update$/i.test(key) && value.trim().startsWith("!")) {
      throw new Error(`repository config key ${key} contains an executable submodule update command`);
    }
  }
}

function readRepositoryConfig(cwd: string) {
  if (!existsSync(cwd)) return [] as Array<[string, string]>;
  const entries: Array<[string, string]> = [];
  for (const scope of ["--local", "--worktree"]) {
    const result = spawnSync("git", sanitizedGitArgs(["config", scope, "--no-includes", "--null", "--list"]), {
      cwd,
      env: daemonGitEnvironment(),
      encoding: "utf-8",
      timeout: GIT_COMMAND_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Not being in a repository is normal for `git init`/`git --version`, and
    // --worktree is unavailable until extensions.worktreeConfig is enabled.
    if (result.status !== 0) continue;
    for (const record of (result.stdout ?? "").split("\0")) {
      if (!record) continue;
      const separator = record.indexOf("\n");
      const key = (separator === -1 ? record : record.slice(0, separator)).trim();
      const value = separator === -1 ? "" : record.slice(separator + 1);
      if (key) entries.push([key, value]);
    }
  }
  return entries;
}

function isLocalConfigInspection(args: string[]) {
  const command = commandName(args);
  return command === "config";
}

function commandName(args: string[]) {
  let index = 0;
  while (index < args.length) {
    if (args[index] === "-c") {
      index += 2;
      continue;
    }
    return args[index];
  }
  return undefined;
}

function sanitizedGitArgs(args: string[]) {
  let index = 0;
  const leading: string[] = [];
  while (args[index] === "-c" && typeof args[index + 1] === "string") {
    leading.push(args[index], args[index + 1]);
    index += 2;
  }
  return [
    ...leading,
    ...DAEMON_GIT_CONFIG.flatMap((value) => ["-c", value]),
    ...args.slice(index),
  ];
}

function readGitPointer(pointerPath: string) {
  const stat = lstatSync(pointerPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`linked worktree .git must be an ordinary file: ${pointerPath}`);
  if (stat.size <= 0 || stat.size > GIT_POINTER_MAX_BYTES) throw new Error(`linked worktree .git pointer has an invalid size: ${pointerPath}`);
  const content = readFileSync(pointerPath, "utf8");
  const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(content);
  if (!match) throw new Error(`linked worktree .git pointer is malformed: ${pointerPath}`);
  const gitDirectory = isAbsolute(match[1]) ? resolve(match[1]) : resolve(join(pointerPath, ".."), match[1]);
  return { content, gitDirectory, stat };
}

function resolveCommonGitDirectory(worktreeRoot: string) {
  const dotGit = join(realpathSync.native(worktreeRoot), ".git");
  const stat = lstatSync(dotGit);
  if (stat.isDirectory() && !stat.isSymbolicLink()) return realpathSync.native(dotGit);
  const pointer = readGitPointer(dotGit);
  const gitDirectory = realpathSync.native(pointer.gitDirectory);
  const commonPointer = join(gitDirectory, "commondir");
  if (!existsSync(commonPointer)) return gitDirectory;
  const common = readFileSync(commonPointer, "utf8").trim();
  if (!common || common.includes("\0")) throw new Error(`linked worktree commondir is malformed: ${commonPointer}`);
  return realpathSync.native(isAbsolute(common) ? common : resolve(gitDirectory, common));
}

function registeredIntegrityForPath(path: string) {
  const candidate = canonicalPathIfPresent(path);
  let winner: WorktreeGitIntegrity | undefined;
  for (const evidence of registeredWorktrees.values()) {
    if (!isPathWithin(candidate, evidence.root)) continue;
    if (!winner || evidence.root.length > winner.root.length) winner = evidence;
  }
  return winner;
}

function canonicalPathIfPresent(path: string) {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function isPathWithin(path: string, root: string) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
