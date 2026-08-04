import { canonicalPath, classifyDaemonProcess, listDaemonInventory } from "../../src/runtime/daemon-inventory";

/**
 * CLI invocations bootstrap a detached daemon for whatever project root they
 * are given, and that daemon outlives the process that started it. Fixtures
 * built on disposable roots therefore leak one resident daemon per root unless
 * the suite stops them, so every fixture registers its roots here and drains
 * them when the file finishes.
 */
const trackedRoots = new Set<string>();

/**
 * Roots are stored raw and canonicalized on use: a fixture usually registers
 * its project root before creating the directory, and an absent path cannot be
 * resolved through its symlinks yet.
 */
export function trackDaemonProjectRoot(projectRoot: string) {
  trackedRoots.add(projectRoot);
  return projectRoot;
}

export function countDaemonsForRoots(roots: readonly string[]) {
  const wanted = new Set(roots.map((root) => canonicalPath(root)));
  return listDaemonInventory().filter((entry) => entry.projectRoot && wanted.has(canonicalPath(entry.projectRoot))).length;
}

/**
 * Signals every daemon bootstrapped for a tracked root. Returns the pids that
 * were signalled so a caller can assert the fixture actually drained.
 */
export async function stopTrackedDaemons(timeoutMs = 10_000) {
  if (trackedRoots.size === 0) return [];
  const roots = [...trackedRoots];
  trackedRoots.clear();
  const wanted = new Set(roots.map((root) => canonicalPath(root)));
  const targets = listDaemonInventory().filter((entry) => entry.projectRoot && wanted.has(canonicalPath(entry.projectRoot)));
  for (const target of targets) {
    try {
      process.kill(target.pid, "SIGTERM");
    } catch {
      // Already gone: the fixture's own teardown or an idle shutdown won.
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && countDaemonsForRoots(roots) > 0) await Bun.sleep(50);

  // Returning the SIGNALLED pids says nothing about whether they died, and this
  // loop exits on the deadline just as happily as on a drained inventory. A
  // daemon that outlives the signal therefore left silently, and the caller's
  // next rmSync turned it into the `missing-root` stray that fails the daemon
  // hygiene gate — a leak reported far from the fixture that caused it, and
  // permanent for a `--no-idle-timeout` daemon that has no watchdog to reclaim
  // it. Fail here instead, where the fixture is still named.
  const survivors = listDaemonInventory()
    .filter((entry) => entry.projectRoot && wanted.has(canonicalPath(entry.projectRoot)));
  if (survivors.length > 0) {
    throw new Error(
      `${survivors.length} daemon(s) survived teardown after ${timeoutMs}ms: `
      + survivors.map((entry) => `pid=${entry.pid} root=${entry.projectRoot}`).join(", ")
      + ". A test that spawns a daemon must stop it on every path, including a failing assertion.",
    );
  }
  return targets.map((target) => target.pid);
}

/** Reclassifies a root the way `daemon reap` would, for fixture assertions. */
export function isDisposableRoot(projectRoot: string, temporaryRoot: string) {
  return classifyDaemonProcess(
    { pid: process.pid, projectRoot, entrypoint: "cli.ts" },
    { temporaryRoot },
  ).strayed;
}
