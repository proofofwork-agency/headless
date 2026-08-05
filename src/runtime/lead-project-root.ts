import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readLeadBinding } from "./lead-binding";
import { getProjectStatePaths, type ProjectStateOptions } from "./project-state";

export type LeadProjectRootOptions = {
  cwd?: string;
  env?: Readonly<NodeJS.ProcessEnv>;
  state?: ProjectStateOptions;
};

/**
 * Resolve the project root a foreground lead should bind to.
 *
 * An MCP host launches `headless-mcp` with whatever working directory it
 * happens to have — frequently the user's home directory, or a subdirectory of
 * the project the operator meant. Blindly taking `cwd` is not a cosmetic
 * inaccuracy: `canonicalizeProjectRoot` only realpaths, and the project id is a
 * hash of that canonical path (`project-state.ts:107-110`), so a subdirectory
 * hashes to a DIFFERENT project. The lead then attaches to an empty project
 * that shares nothing with the operator's, and every promise about inherited
 * context silently refers to the wrong tree.
 *
 * Order: explicit env, then the nearest configured lead AT OR BELOW the nearest
 * project boundary, then that boundary, then cwd.
 *
 * The boundary matters. Ranking "any configured ancestor" above "nearest project"
 * lets a stale lead in a shared parent — a home directory that was once used as a
 * project — outrank the repository the operator is actually standing in, which is
 * precisely the silent wrong-project bind this function exists to prevent. Nothing
 * above the enclosing project or git root is ever considered.
 */
export function resolveLeadProjectRoot(options: LeadProjectRootOptions = {}): string {
  const env = options.env ?? process.env;
  const explicit = env.HEADLESS_PROJECT_ROOT?.trim();
  if (explicit) return resolve(explicit);

  const start = resolve(options.cwd ?? process.cwd());
  const candidates = ancestorDirectories(start).map((directory) => ({
    directory,
    paths: statePathsFor(directory, options),
  }));

  const boundary = candidates.findIndex(({ directory, paths }) =>
    (paths !== null && existsSync(paths.projectDir)) || existsSync(join(directory, ".git")));
  if (boundary === -1) return start;

  // Probe read-only: deciding which project this is must not tighten permissions
  // on binding files belonging to every directory on the way up.
  const configured = candidates
    .slice(0, boundary + 1)
    .find(({ paths }) => paths !== null && readLeadBinding(paths, { repairPermissions: false }) !== null);

  return configured?.directory ?? candidates[boundary]!.directory;
}

/** `start` first, then each parent up to the filesystem root. */
function ancestorDirectories(start: string) {
  const directories: string[] = [];
  let current = start;
  // `dirname` strictly shortens a lexical path and fixpoints at the root, so this
  // terminates on its own. No arbitrary depth cap — one would silently drop a
  // real project root out of range on a deeply nested path.
  for (;;) {
    directories.push(current);
    const parent = dirname(current);
    if (parent === current) return directories;
    current = parent;
  }
}

/**
 * Path derivation alone can reject a candidate (unreadable, not a directory, or
 * a socket path over the sockaddr_un limit). A candidate that cannot be
 * described is simply not a match; it must never abort the search.
 */
function statePathsFor(projectRoot: string, options: LeadProjectRootOptions) {
  try {
    return getProjectStatePaths(projectRoot, options.state);
  } catch {
    return null;
  }
}
