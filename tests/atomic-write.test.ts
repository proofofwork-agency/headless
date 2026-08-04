import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicAppendFile, atomicWriteFile } from "../src/runtime/atomic-write";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("atomic file persistence", () => {
  test("writes complete content with the requested mode and no temporary residue", () => {
    const root = fixtureRoot();
    const path = join(root, "state.json");

    atomicWriteFile(path, Buffer.from("durable content"), { mode: 0o640 });

    expect(readFileSync(path, "utf8")).toBe("durable content");
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(readdirSync(root).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  test("removes the temporary file when the final descriptor close fails", () => {
    const root = fixtureRoot();
    const path = join(root, "state.json");
    const preload = join(import.meta.dir, "fixtures", "atomic-close-failure-preload.js");
    const modulePath = join(import.meta.dir, "..", "src", "runtime", "atomic-write.ts");
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        "--preload",
        preload,
        "-e",
        `import { atomicWriteFile } from ${JSON.stringify(modulePath)};
let failed = false;
try {
  atomicWriteFile(process.env.HEADLESS_ATOMIC_CLOSE_TARGET, "new content");
} catch (error) {
  if (!(error instanceof Error) || error.message !== "injected atomic close failure") throw error;
  failed = true;
}
if (!failed) throw new Error("atomicWriteFile unexpectedly succeeded");`,
      ],
      env: { ...process.env, HEADLESS_ATOMIC_CLOSE_TARGET: path },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(child.exitCode, child.stderr.toString()).toBe(0);
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(root).filter((name) => name.includes(".tmp-"))).toEqual([]);
    // close(2) releases the descriptor even when it reports an error, so a
    // retry can close a number another operation has since reused. Exactly one
    // attempt — cleanup must unlink the temp file without re-closing.
    expect(child.stderr.toString()).toContain("ATOMIC_CLOSE_ATTEMPTS=1");
  });

  test("appends content in order and applies owner-only mode", () => {
    const root = fixtureRoot();
    const path = join(root, "events.jsonl");

    atomicAppendFile(path, "first\n", { mode: 0o600 });
    atomicAppendFile(path, Buffer.from("second\n"), { mode: 0o600 });

    expect(readFileSync(path, "utf8")).toBe("first\nsecond\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "headless-atomic-write-"));
  roots.push(root);
  return root;
}
