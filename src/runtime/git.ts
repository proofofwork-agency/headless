import { execFileSync, spawnSync } from "node:child_process";

const GIT_COMMAND_TIMEOUT_MS = 2_000;
const GIT_STRICT_TIMEOUT_MS = 10_000;

function runGit(args: string[], cwd = process.cwd()): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      timeout: GIT_COMMAND_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

export interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

export function runGitStrict(args: string[], cwd: string, timeoutMs = GIT_STRICT_TIMEOUT_MS, input?: string): GitRunResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: timeoutMs,
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
