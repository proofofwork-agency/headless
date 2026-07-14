import { chmodSync, closeSync, existsSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from "fs";
import { basename, dirname, join } from "path";
import { randomBytes } from "crypto";
import { recordRuntimeDiagnostic } from "./diagnostics";

/**
 * Atomically write file contents using the tmp -> fsync -> rename pattern.
 *
 * Ported from ContextRelay's src/atomic-write.ts so the Headless ledger stays
 * compatible with that reference runtime. Guarantees:
 * - Readers never see a half-written file (rename is atomic on POSIX).
 * - On successful return, contents are fsynced to disk.
 * - On process death mid-write, the original file is unchanged.
 *
 * The tmp file lives in the same directory as the target so the rename is an
 * intra-filesystem atomic operation.
 */
export function atomicWriteFile(path: string, content: string | Buffer, opts: { mode?: number } = {}): void {
  const mode = opts.mode ?? 0o600;
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.tmp-${randomBytes(6).toString("hex")}`);
  const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;

  const fd = openSync(tmp, "w", mode);
  try {
    let written = 0;
    while (written < data.length) {
      written += writeSync(fd, data, written, data.length - written, null);
    }
    fsyncSync(fd);
  } catch (err) {
    cleanupSync("atomic-write.close-after-write-failure", () => closeSync(fd));
    cleanupSync("atomic-write.unlink-temp-after-write-failure", () => unlinkSync(tmp));
    throw err;
  }
  closeSync(fd);

  try {
    renameSync(tmp, path);
  } catch (err) {
    cleanupSync("atomic-write.unlink-temp-after-rename-failure", () => unlinkSync(tmp));
    throw err;
  }

  // The file fsync above does not make the directory entry durable. Persist
  // the rename itself before reporting success.
  fsyncDirectory(dir);

  // Owner-only mode is part of the persistence contract, not best-effort
  // cleanup. Never report a successful write with permissions we could not
  // verify or repair.
  chmodSync(path, mode);
}

/**
 * Append content to file (creating if needed) and fsync for durability.
 *
 * Uses OS append mode + explicit fsync. Not replace-atomic like atomicWriteFile
 * (a mid-append crash can leave a truncated last line), but:
 * - Our callers (ledger) hold a mkdir-based lock serializing all writers.
 * - Readers never see half a *previous* replace because we only append.
 *
 * This makes appendEvent O(1) instead of full-file rewrite.
 */
export function atomicAppendFile(path: string, content: string | Buffer, opts: { mode?: number } = {}): void {
  const mode = opts.mode ?? 0o600;
  const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;

  const created = !existsSync(path);
  // 'a' opens for append (create if absent); all writes go to current end.
  const fd = openSync(path, "a", mode);
  try {
    let written = 0;
    while (written < data.length) {
      written += writeSync(fd, data, written, data.length - written, null);
    }
    fsyncSync(fd);
  } catch (err) {
    cleanupSync("atomic-append.close-after-write-failure", () => closeSync(fd));
    throw err;
  }
  closeSync(fd);

  // Creation adds a new directory entry; appending to an existing inode does
  // not. Persist only the former to keep ordinary ledger appends O(1).
  if (created) fsyncDirectory(dirname(path));

  chmodSync(path, mode);
}

function cleanupSync(scope: string, cleanup: () => void) {
  try {
    cleanup();
  } catch (error) {
    recordRuntimeDiagnostic("cleanup", scope, error);
  }
}

function fsyncDirectory(path: string) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
