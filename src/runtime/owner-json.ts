import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteFile } from "./atomic-write";
import { ensureOwnerOnlyDirectory, ensureOwnerOnlyFile } from "./project-state";

const MAX_STORE_BYTES = 32 * 1024 * 1024;

type RuntimeSchema<T> = {
  parse(value: unknown): T;
};

export function readOwnerOnlyJson<T>(path: string, schema: RuntimeSchema<T>) {
  if (!existsSync(path)) return null;
  ensureOwnerOnlyFile(path);

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
