import { lstatSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Walk ancestors of `path` (starting at its parent) and fail closed unless each
 * directory is a real directory owned by the current user or root, and not
 * group/other-writable — except the narrow sticky root-owned case used by /tmp.
 *
 * Single source of truth for path-trust ancestor checks (daemon extensions,
 * owner-only state dirs/files, etc.).
 */
export function assertTrustedAncestorChain(path: string, label: string) {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  let childPath = path;
  let current = dirname(path);
  while (true) {
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`${label} has a non-directory ancestor: ${current}`);
    }
    if (uid !== null && info.uid !== uid && info.uid !== 0) {
      throw new Error(`${label} ancestor must be owned by the daemon user or root: ${current}`);
    }
    if ((info.mode & 0o022) !== 0) {
      const child = lstatSync(childPath);
      // Sticky + root-owned (e.g. /tmp): other users may create entries, but
      // only when the immediate child is owned by the daemon user or root.
      const protectedStickyRoot = (info.mode & 0o1000) !== 0
        && info.uid === 0
        && (uid === null || child.uid === uid || child.uid === 0);
      if (!protectedStickyRoot) {
        throw new Error(`${label} ancestor must not be writable by group or other users: ${current}`);
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    childPath = current;
    current = parent;
  }
}
