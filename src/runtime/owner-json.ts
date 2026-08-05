import { lstatSync, readFileSync, statSync } from "node:fs";
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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
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

export function writeOwnerOnlyJson(path: string, value: unknown) {
  ensureOwnerOnlyDirectory(dirname(path));
  atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  ensureOwnerOnlyFile(path);
}
