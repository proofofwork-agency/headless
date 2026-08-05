import { lstatSync, readFileSync, statSync, type Stats } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteFile } from "./atomic-write";
import { assertOwnerOnlyFileUnrepaired, ensureOwnerOnlyDirectory, ensureOwnerOnlyFile } from "./project-state";

const MAX_STORE_BYTES = 32 * 1024 * 1024;

type RuntimeSchema<T> = {
  parse(value: unknown): T;
};

export function readOwnerOnlyJson<T>(
  path: string,
  schema: RuntimeSchema<T>,
  options: { repairPermissions?: boolean } = {},
) {
  // Absence is established with lstat, NOT existsSync. `existsSync` follows the
  // link, so a dangling symlink at this path reports "absent" — and the caller
  // then concludes the state was never configured. For a selected project that
  // laundered a security anomaly into CREDENTIAL_MISSING, which is precisely the
  // corrupt-state-looks-recoverable failure the strict reader exists to prevent.
  // Only a genuine ENOENT is absence; anything else is a fact to propagate.
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    assertGenuineAbsence(path);
    return null;
  }
  // `ensureOwnerOnlyFile` chmods, so it is a WRITE. Discovery probes must not
  // tighten permissions on every candidate they inspect — but they must still
  // VALIDATE. Skipping the checks would let a symlinked or group-writable file
  // be trusted, so the no-repair path asserts the same properties and refuses
  // instead of repairing.
  if (options.repairPermissions === false) assertOwnerOnlyFileUnrepaired(path);
  else ensureOwnerOnlyFile(path);

  const size = statSync(path).size;
  if (size > MAX_STORE_BYTES) {
    throw new Error(`Persistent state exceeds ${MAX_STORE_BYTES} bytes: ${path}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Invalid persistent JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return schema.parse(value);
}

/**
 * Separate genuine absence from a path that merely fails to RESOLVE.
 *
 * `lstat(fullPath)` raising ENOENT proves the full path has no referent — it does
 * not prove the leaf is missing. A dangling symlink anywhere in the chain raises
 * the same ENOENT, so accepting it as absence launders a structural anomaly into
 * "never configured" exactly one directory above the leaf case.
 *
 * Walk to the nearest ancestor that exists. A real directory there means the
 * state was simply never materialized, which is ordinary for a fresh project.
 * A symlink or non-directory there is a fact about the filesystem that the
 * caller must see.
 */
function assertGenuineAbsence(path: string) {
  let current = dirname(path);
  for (;;) {
    let ancestor: Stats;
    try {
      ancestor = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      // Nothing along the whole chain exists: genuinely unmaterialized state.
      if (parent === current) return;
      current = parent;
      continue;
    }
    if (ancestor.isSymbolicLink()) {
      // A RESOLVABLE directory alias is ordinary, not corruption. The rest of
      // this path system deliberately follows intermediate links and
      // canonicalizes before validating, and `getHeadlessStateHome` resolves
      // rather than realpaths — so rejecting every symlinked ancestor would make
      // FIRST RUN fatal for anyone whose state home sits under a symlinked home
      // directory. Only a dangling or cyclic alias is the anomaly.
      let target: Stats;
      try {
        target = statSync(current);
      } catch (error) {
        throw new Error(`Owner-only path resolves through an unusable symlinked ancestor: ${current}`, { cause: error });
      }
      if (!target.isDirectory()) {
        throw new Error(`Owner-only path has a non-directory ancestor: ${current}`);
      }
      return;
    }
    if (!ancestor.isDirectory()) {
      throw new Error(`Owner-only path has a non-directory ancestor: ${current}`);
    }
    return;
  }
}

export function writeOwnerOnlyJson(path: string, value: unknown) {
  ensureOwnerOnlyDirectory(dirname(path));
  atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  ensureOwnerOnlyFile(path);
}
