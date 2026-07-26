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
  return targets.map((target) => target.pid);
}

/** Reclassifies a root the way `daemon reap` would, for fixture assertions. */
export function isDisposableRoot(projectRoot: string, temporaryRoot: string) {
  return classifyDaemonProcess(
    { pid: process.pid, projectRoot, entrypoint: "cli.ts" },
    { temporaryRoot },
  ).strayed;
}
