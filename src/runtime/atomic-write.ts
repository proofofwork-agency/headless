import { chmodSync, closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from "fs";
import { basename, dirname, join } from "path";
import { randomBytes } from "crypto";

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
    try { closeSync(fd); } catch {}
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
  closeSync(fd);

  try {
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }

  try { chmodSync(path, mode); } catch {}
}
