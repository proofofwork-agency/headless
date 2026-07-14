import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

// These files are metadata/compatibility boundaries, not stable execution
// policy. Keep the list exact so a new backend-specific branch requires an
// explicit architecture review.
const BACKEND_BRANCH_ALLOWLIST = new Set([
  "src/cli/commands/mcp.ts",
  "src/contracts/agent-name.ts",
  "src/runtime/native-auth-capsule.ts",
  "src/runtime/native-session-manager.ts",
  "src/runtime/session-drivers/base.ts",
  "src/runtime/session-drivers/bun-executor.ts",
  "src/runtime/session-drivers/event-decoder.ts",
  "src/runtime/session-drivers/factory.ts",
  "src/tui/model.ts",
]);

const backendBranch = /(?:===|!==|case)\s*["'](?:opencode|claude-code|codex|grok-build)["']/;

describe("backend architecture boundary", () => {
  test("keeps backend-id branching out of the stable execution kernel", () => {
    const violations = sourceFiles().filter((path) => {
      if (path.startsWith("src/backends/") || BACKEND_BRANCH_ALLOWLIST.has(path)) return false;
      return backendBranch.test(readFileSync(resolve(root, path), "utf8"));
    });
    expect(violations).toEqual([]);
  });

  test("has one backend definition contract", () => {
    const sources = sourceFiles().map((path) => readFileSync(resolve(root, path), "utf8")).join("\n");
    expect(sources).not.toMatch(/(?:interface\s+Adapter\b|type\s+BackendAdapter\b)/);
    expect(sources).toContain("export type BackendDefinition =");
  });
});

function sourceFiles() {
  return readdirSync(resolve(root, "src"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => relative(root, resolve(entry.parentPath, entry.name)))
    .sort();
}
