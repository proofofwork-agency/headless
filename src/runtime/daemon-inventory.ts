import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve, sep } from "node:path";

/**
 * Bootstrapped daemons are spawned detached against whatever project root the
 * caller passed, and each one records its durable metadata inside its own state
 * home. A disposable state home therefore takes its metadata with it, so stray
 * daemons can only be found by inspecting the process table.
 */
const MAX_PROCESS_TABLE_BYTES = 4_000_000;
const PROCESS_TABLE_TIMEOUT_MS = 5_000;
/**
 * Matching is by basename, so this proves SHAPE, not PROVENANCE: an unrelated
 * same-user program genuinely launched as `bun /elsewhere/cli.ts daemon serve`
 * matches too. Combined with the argv[1] anchor below that is enough to reject
 * a process merely quoting a daemon command line, which is the false positive
 * that was actually observed — but it is not identity. Anything that acts on
 * this inventory destructively must stay behind explicit human confirmation
 * until an entrypoint can be verified rather than name-matched.
 */
const DAEMON_ENTRYPOINTS = new Set(["cli.js", "cli.ts"]);

export type DaemonReapReason = "missing-root" | "disposable-root" | "resident";

export type DaemonProcessEntry = {
  pid: number;
  projectRoot: string | null;
  entrypoint: string;
};

export type DaemonInventoryEntry = DaemonProcessEntry & {
  reason: DaemonReapReason;
  strayed: boolean;
};

/**
 * Parses `ps -eo pid=,uid=,command=` output into candidate daemons this user
 * owns.
 *
 * The argv[1]/argv[2] anchor rejects a process that merely QUOTES a daemon
 * command line — a shell echoing the string, or a message containing it, which
 * was observed producing a "project root" full of backticks and a newline. It
 * does NOT prove identity: matching is by basename, so an unrelated same-user
 * program genuinely launched as `bun /elsewhere/cli.ts daemon serve` matches
 * too. See the note on DAEMON_ENTRYPOINTS; anything acting on this list
 * destructively must stay behind explicit human confirmation.
 */
export function parseDaemonProcessTable(output: string, uid: number, selfPid: number): DaemonProcessEntry[] {
  const entries: DaemonProcessEntry[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const firstBreak = trimmed.indexOf(" ");
    if (firstBreak < 0) continue;
    const pid = Number(trimmed.slice(0, firstBreak));
    const remainder = trimmed.slice(firstBreak + 1).trim();
    const secondBreak = remainder.indexOf(" ");
    if (secondBreak < 0) continue;
    const owner = Number(remainder.slice(0, secondBreak));
    const command = remainder.slice(secondBreak + 1).trim();
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === selfPid) continue;
    if (!Number.isSafeInteger(owner) || owner !== uid) continue;
    const argv = command.split(/\s+/).filter(Boolean);
    const serve = argv.findIndex((value, index) => value === "daemon" && argv[index + 1] === "serve");
    // Anchored to argv[1], not merely "somewhere after an entrypoint". Every
    // daemon in this tree is spawned as `<runtime> <entrypoint> daemon serve`,
    // so the subcommand is always the third token. Accepting it anywhere let
    // any process whose command line CONTAINS that text be classified as a
    // daemon — a shell echoing the string, or a message quoting it — and
    // `daemon reap` SIGTERMs what this returns, so a false positive kills an
    // unrelated process. Observed: a stray reported with backticks and a
    // newline inside its "project root".
    if (serve !== 2) continue;
    const entrypoint = argv[serve - 1];
    if (!entrypoint || !DAEMON_ENTRYPOINTS.has(basename(entrypoint))) continue;
    const cwdFlag = argv.indexOf("--cwd", serve);
    const projectRoot = cwdFlag >= 0 ? argv[cwdFlag + 1] ?? null : null;
    entries.push({ pid, projectRoot, entrypoint });
  }
  return entries;
}

/**
 * A daemon is stray when its project root is gone, or when that root lives in
 * the disposable temp tree — the shape every test fixture produces. Anything
 * rooted in a real checkout is a resident control plane and is left alone.
 */
export function classifyDaemonProcess(
  entry: DaemonProcessEntry,
  options: { temporaryRoot: string; exists?: (path: string) => boolean; canonicalize?: (path: string) => string },
): DaemonInventoryEntry {
  const exists = options.exists ?? existsSync;
  if (!entry.projectRoot || !exists(entry.projectRoot)) {
    return { ...entry, reason: "missing-root", strayed: true };
  }
  // macOS hands out /var/folders temp paths that are symlinks into /private,
  // and the daemon records the canonical form. Compare both sides resolved or
  // a disposable fixture root reads as a resident checkout.
  const canonicalize = options.canonicalize ?? canonicalPath;
  const root = canonicalize(entry.projectRoot);
  const temporaryRoot = canonicalize(options.temporaryRoot);
  if (root === temporaryRoot || root.startsWith(`${temporaryRoot}${sep}`)) {
    return { ...entry, reason: "disposable-root", strayed: true };
  }
  return { ...entry, reason: "resident", strayed: false };
}

/** Resolves symlinked roots so recorded and observed paths compare equal. */
export function canonicalPath(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function canonicalTemporaryRoot() {
  return canonicalPath(tmpdir());
}

/** Enumerates every Headless daemon this user owns, classified for reaping. */
export function listDaemonInventory(): DaemonInventoryEntry[] {
  if (process.platform === "win32") return [];
  const result = spawnSync("ps", ["-eo", "pid=,uid=,command="], {
    encoding: "utf8",
    timeout: PROCESS_TABLE_TIMEOUT_MS,
    maxBuffer: MAX_PROCESS_TABLE_BYTES,
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return [];
  const uid = process.getuid?.() ?? -1;
  if (uid < 0) return [];
  const temporaryRoot = canonicalTemporaryRoot();
  return parseDaemonProcessTable(result.stdout, uid, process.pid)
    .map((entry) => classifyDaemonProcess(entry, { temporaryRoot }));
}
