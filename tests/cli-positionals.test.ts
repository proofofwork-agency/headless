import { describe, expect, test } from "bun:test";
import { COMMAND_SPECS, validateCommandPositionals } from "../src/cli";

/**
 * `headless init not-a-subcommand` used to initialise successfully and discard
 * the stray token — the same silent-ignore defect as unknown flags, and just as
 * likely to hide a typo for a subcommand the operator believed existed.
 *
 * Rejection is opt-in per command rather than a blanket arity rule, because
 * most commands legitimately take positionals and several take unbounded
 * trailing text. These tests pin both halves: the flag-only commands reject,
 * and everything that carries a prompt, id, host or operand is untouched.
 */
describe("commands whose grammar is flags only reject a stray positional", () => {
  const flagOnly = ["init", "setup", "status", "doctor", "verify", "tui"];

  for (const name of flagOnly) {
    test(`${name} names the stray token instead of discarding it`, () => {
      expect(() => validateCommandPositionals([name, "not-a-subcommand"]))
        .toThrow(`${name} takes no subcommand or argument, but received "not-a-subcommand".`);
      // The refusal carries the command's own usage, so the operator can see
      // what it does accept.
      expect(() => validateCommandPositionals([name, "junk"])).toThrow(`Usage: headless ${name}`);
    });

    test(`${name} still accepts its flags, including a value that is not a flag`, () => {
      expect(() => validateCommandPositionals([name, "--cwd", "/repo"])).not.toThrow();
      expect(() => validateCommandPositionals([name])).not.toThrow();
    });
  }

  test("a value flag's value is never mistaken for a positional", () => {
    // The decisive case: --lead's value is a bare word, and consuming the flag
    // without its value would read "codex" as a stray subcommand.
    expect(() => validateCommandPositionals(["init", "--lead", "codex", "--cwd", "/repo"])).not.toThrow();
    expect(() => validateCommandPositionals(["setup", "--lead", "opencode"])).not.toThrow();
  });

  test("everything after the separator stays opaque", () => {
    expect(() => validateCommandPositionals(["status", "--cwd", "/repo", "--", "anything", "at", "all"])).not.toThrow();
  });
});

describe("commands that legitimately take positionals are untouched", () => {
  test("prompts, ids, hosts and operands still pass", () => {
    for (const argv of [
      ["exec", "explain this repository"],
      ["exec", "--backend", "codex", "a prompt"],
      ["council", "should we ship?"],
      ["receipt", "show", "run-1"],
      ["mcp", "install", "codex"],
      ["lead", "use", "codex"],
      ["daemon", "stop"],
      ["project", "trust", "grant"],
      ["skill", "inspect", "some-skill"],
      ["launch", "opencode"],
      ["approval", "resolve", "--approval-id", "a1", "--decision", "approved", "Gates passed."],
    ]) {
      expect(() => validateCommandPositionals(argv)).not.toThrow();
    }
  });

  test("only the opted-in commands declare the restriction", () => {
    // Guards against someone marking a prompt-bearing command by mistake: a
    // command with unbounded trailing text must never carry positionals:"none".
    const declared = COMMAND_SPECS
      .filter((spec) => "positionals" in spec && spec.positionals === "none")
      .map((spec) => spec.name)
      .sort();
    expect(declared).toEqual(["doctor", "init", "setup", "status", "tui", "verify"]);
  });
});
