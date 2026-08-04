import { describe, expect, test } from "bun:test";
import { CLI_AUDIT_MANIFEST, COMMAND_SPECS, resolveCommand } from "../src/cli";
import { POSITIONAL_GRAMMAR, type PositionalGrammar } from "../src/cli/positional-grammar";

/** The grammar's action paths, read independently of how the manifest builds them. */
function declaredActionPaths(grammar: PositionalGrammar, prefix: string[] = []): string[] {
  if (grammar.kind !== "actions") return prefix.length ? [prefix.join(" ")] : [];
  return Object.entries(grammar.actions).flatMap(([action, child]) => declaredActionPaths(child, [...prefix, action]));
}

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

  test("covers every subcommand the positional grammar declares", () => {
    // The manifest used to be a second, hand-maintained action catalog, and the
    // coverage test above only compared COMMAND names — so `lead` and `receipt`
    // had no subcommand rows at all, `daemon` was missing reap, and `mcp` was
    // missing the server alias, all four of them green.
    const rowsFor = (command: string) => CLI_AUDIT_MANIFEST
      .filter((row) => row.command === command && row.id.startsWith(`${command}:`))
      .map((row) => row.argv.slice(1).join(" "));
    for (const spec of COMMAND_SPECS) {
      const declared = declaredActionPaths(POSITIONAL_GRAMMAR[spec.name]!);
      // mcp rows carry an audited host operand, so compare on the action prefix.
      const covered = new Set(rowsFor(spec.name).map((row) => declared.find((path) => row === path || row.startsWith(`${path} `)) ?? row));
      expect({ command: spec.name, missing: declared.filter((path) => !covered.has(path)) })
        .toEqual({ command: spec.name, missing: [] });
    }
  });

  test("names the four subcommands the hand-maintained catalog had lost", () => {
    const ids = new Set(CLI_AUDIT_MANIFEST.map((row) => row.id));
    for (const id of ["lead:use", "lead:status", "lead:release", "receipt:show", "receipt:diff", "daemon:reap", "mcp:server"]) {
      expect({ id, present: ids.has(id) }).toEqual({ id, present: true });
    }
    // And the host expansions that were already there are not lost in the swap.
    for (const id of ["mcp:serve", "mcp:install codex", "mcp:status opencode"]) {
      expect({ id, present: ids.has(id) }).toEqual({ id, present: true });
    }
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
      "budget:upsert",
      // Newly reachable rows: reap kills resident daemons, and lead use/release
      // rewrite the configured foreground lead.
      "daemon:reap", "lead:use", "lead:release",
    ]) {
      expect(risk(id)).toBe("destructive");
    }
    for (const id of ["lead:status", "receipt:list", "receipt:show", "mcp:server"]) expect(risk(id)).toBe("safe");
  });

  test("mutating subcommands are never classified as reads", () => {
    // The risk taxonomy used to be destructive-arms over `return "safe"`, so a
    // subcommand nobody remembered to name inherited "safe" by omission. Every
    // id below did exactly that. The allowlist inversion makes the fallback
    // conservative instead: unknown means destructive until someone lists it as
    // a read.
    const mutators = [
      "daemon:stop",
      "collaboration:transfer-synthesizer",
      "workflow:draft-create",
      "goal:cancel",
      "session:cancel",
      "workflow:pause",
      "loop:resume",
      "skill:revoke",
      "autonomy:off",
    ];
    for (const id of mutators) {
      const row = CLI_AUDIT_MANIFEST.find((entry) => entry.id === id);
      expect(row, `${id} missing from the manifest`).toBeDefined();
      expect(row!.risk, `${id} must not be classified as a read`).not.toBe("safe");
    }

    // The other direction, so the conservative fallback cannot be "fixed" by
    // simply calling everything destructive.
    for (const id of ["daemon:status", "lead:status", "receipt:list", "goal:list"]) {
      const row = CLI_AUDIT_MANIFEST.find((entry) => entry.id === id);
      if (row) expect(row.risk, `${id} is a read`).toBe("safe");
    }
  });

});
