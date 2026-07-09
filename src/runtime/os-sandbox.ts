import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const DARWIN_SANDBOX_EXEC = "/usr/bin/sandbox-exec";
export const DARWIN_WRITE_DENIAL_PROBE = "darwin-sandbox-write-denial-v1";

export interface SandboxProbeResult {
  ok: boolean;
  reason: string;
}

export interface DarwinSandboxProfileOptions {
  // The project directory to protect. Reads are allowed (a code agent must read
  // the codebase); writes are denied — this is the OS-enforced read-only floor.
  workdir: string;
  // Extra directories denied for writes (e.g. ~/.ssh, ~/.aws) so a bypassed
  // agent cannot tamper with credentials or shell config for persistence.
  denyWriteRoots?: string[];
  // Directories denied for reads (credential dirs). Kept outside the project so
  // ordinary source reads — including files literally named "secret" — still work.
  denyReadRoots?: string[];
}

export function probeDarwinSandboxWriteDenial(): SandboxProbeResult {
  if (process.platform !== "darwin") return { ok: false, reason: `unsupported platform: ${process.platform}` };
  if (!existsSync(DARWIN_SANDBOX_EXEC)) return { ok: false, reason: `${DARWIN_SANDBOX_EXEC} is missing` };

  const dir = mkdtempSync(join(tmpdir(), "headless-sandbox-probe-"));
  const profile = join(dir, "probe.sb");
  const denied = join(dir, "denied.txt");
  try {
    writeFileSync(profile, [
      "(version 1)",
      "(deny default)",
      "(allow process*)",
      "(allow file-read*)",
      "(deny file-write*)",
    ].join("\n"));
    const result = spawnSync(DARWIN_SANDBOX_EXEC, ["-f", profile, "/bin/sh", "-c", `printf blocked > ${shellQuote(denied)}`], {
      encoding: "utf-8",
      timeout: 5_000,
    });
    if (result.error) return { ok: false, reason: result.error.message };
    if (existsSync(denied)) return { ok: false, reason: "probe write unexpectedly succeeded" };
    if (result.status === 0) return { ok: false, reason: "probe command exited 0 despite denied write" };
    return { ok: true, reason: "sandbox-exec denied file write" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function writeDarwinSandboxProfile(options: DarwinSandboxProfileOptions): string {
  const dir = mkdtempSync(join(tmpdir(), "headless-sandbox-profile-"));
  const profile = join(dir, "profile.sb");
  writeFileSync(profile, buildDarwinReadOnlyProfile(options), { encoding: "utf-8", mode: 0o600 });
  return profile;
}

// Deny-list model: allow the backend to run normally (its SQLite DB, macOS
// Keychain auth, caches, and temp all work), then subtract the things a
// read-only run must never do — write the project, tamper with credentials, or
// spawn an interactive shell. This is deliberately NOT the allow-list model
// (deny default + enumerate every writable root): full CLIs like opencode
// (SQLite) and claude (Keychain) break under enumeration, and the property we
// actually need is "the project is not modified", which this enforces directly.
export function buildDarwinReadOnlyProfile(options: DarwinSandboxProfileOptions): string {
  const workdir = canonicalizeExistingPath(options.workdir);
  const denyWrite = uniquePaths([workdir, ...resolveOptionalPaths(options.denyWriteRoots ?? [])]);
  const denyRead = uniquePaths(resolveOptionalPaths(options.denyReadRoots ?? []));

  const lines = [
    "(version 1)",
    "(allow default)",
    ...denyWrite.map((path) => `(deny file-write* (subpath ${sbplString(path)}))`),
    ...denyRead.map((path) => `(deny file-read* (subpath ${sbplString(path)}))`),
    // Block interactive shells. /bin/sh is intentionally allowed: backends
    // legitimately shell out through it, and the app-level policy already denies
    // the agent's own bash/exec tool.
    "(deny process-exec (literal \"/bin/bash\"))",
    "(deny process-exec (literal \"/bin/zsh\"))",
  ];
  return `${lines.join("\n")}\n`;
}

export function cleanupSandboxProfile(profilePath: string): void {
  rmSync(dirname(profilePath), { recursive: true, force: true });
}

export function canonicalizeExistingPath(path: string): string {
  return realpathSync.native(path);
}

function resolveOptionalPaths(paths: string[]): string[] {
  const resolved: string[] = [];
  for (const path of paths) {
    if (!path || !existsSync(path)) continue;
    try {
      resolved.push(canonicalizeExistingPath(path));
    } catch {
      resolved.push(path);
    }
  }
  return resolved;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean))];
}

function sbplString(value: string): string {
  return JSON.stringify(value);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
