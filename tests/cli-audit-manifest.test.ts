import { describe, expect, test } from "bun:test";
import { CLI_AUDIT_MANIFEST, COMMAND_SPECS, resolveCommand } from "../src/cli";

describe("CLI audit manifest", () => {
  test("covers every canonical command and declared alias exactly once", () => {
    const canonical = new Set(COMMAND_SPECS.map((spec) => spec.name));
    expect(new Set(CLI_AUDIT_MANIFEST.map((row) => row.command))).toEqual(canonical);
    expect(new Set(CLI_AUDIT_MANIFEST.map((row) => row.id)).size).toBe(CLI_AUDIT_MANIFEST.length);
    for (const row of CLI_AUDIT_MANIFEST) expect(resolveCommand(row.argv[0])?.spec.name).toBe(row.command);
  });

  test("has deterministic classifications and isolated mutation metadata", () => {
    for (const row of CLI_AUDIT_MANIFEST) {
      expect(["PASS", "FAIL", "BLOCKED", "EXPECTED_REJECTION", "DEFERRED"]).toContain(row.expected);
      expect(row.id.length).toBeGreaterThan(0);
      expect(row.argv.length).toBeGreaterThan(0);
    }
    expect(CLI_AUDIT_MANIFEST.some((row) => row.risk === "destructive")).toBe(true);
    expect(CLI_AUDIT_MANIFEST.some((row) => row.risk === "safe")).toBe(true);
  });

  test("classifies cost and destructive rows conservatively", () => {
    const risk = (id: string) => CLI_AUDIT_MANIFEST.find((row) => row.id === id)?.risk;
    for (const id of ["exec", "run", "council", "goal:start", "goal:run", "session:send", "session:resume", "workflow:run", "autonomy:start"]) {
      expect(risk(id)).toBe("cost");
    }
    for (const id of [
      "project:trust grant", "project:trust revoke", "collaboration:acknowledge", "collaboration:ack", "approval:resolve", "candidate:integrate",
      "mcp:install codex", "mcp:install claude", "mcp:install grok", "mcp:install opencode",
      "mcp:remove codex", "mcp:remove claude", "mcp:remove grok", "mcp:remove opencode",
    ]) {
      expect(risk(id)).toBe("destructive");
    }
  });
});
