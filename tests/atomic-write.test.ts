import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
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
