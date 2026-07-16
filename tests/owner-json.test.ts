import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { readOwnerOnlyJson, writeOwnerOnlyJson } from "../src/runtime/owner-json";

const roots: string[] = [];
const StateSchema = z.object({ count: z.number().int() }).strict();

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("owner-only JSON persistence", () => {
  test("writes owner-only JSON and reads it through its runtime schema", () => {
    const path = join(fixtureRoot(), "nested", "state.json");

    writeOwnerOnlyJson(path, { count: 3 });

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readOwnerOnlyJson(path, StateSchema)).toEqual({ count: 3 });
  });

  test("rejects schema-invalid content", () => {
    const path = join(fixtureRoot(), "state.json");
    writeFileSync(path, '{"count":"three"}', { mode: 0o600 });

    expect(() => readOwnerOnlyJson(path, StateSchema)).toThrow();
  });

  test("repairs overly broad file permissions before reading", () => {
    const path = join(fixtureRoot(), "state.json");
    writeFileSync(path, '{"count":4}', { mode: 0o600 });
    chmodSync(path, 0o666);

    expect(readOwnerOnlyJson(path, StateSchema)).toEqual({ count: 4 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "headless-owner-json-"));
  roots.push(root);
  return root;
}
