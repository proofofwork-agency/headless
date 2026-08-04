import { describe, expect, test } from "bun:test";
import { COMMAND_SPECS, validateCommandPositionals } from "../src/cli";
import { COMMANDS_MISSING_GRAMMAR, POSITIONAL_GRAMMAR } from "../src/cli/positional-grammar";

/**
 * Extra positionals used to be discarded in silence — `init wat` initialised,
 * `daemon status wat` ran, `lead use codex wat` succeeded, `receipt verify
 * --file x runId` dropped one of two conflicting sources. Same defect class as
 * ignored unknown flags, and just as likely to hide a typo for a subcommand the
 * operator believed existed.
 */
const accepts = (argv: string[]) => expect(() => validateCommandPositionals(argv)).not.toThrow();
const rejects = (argv: string[], detail?: string) =>
  expect(() => validateCommandPositionals(argv)).toThrow(detail ?? "");

describe("every command declares a positional grammar", () => {
  test("no command is left unvalidated", () => {
    expect(COMMANDS_MISSING_GRAMMAR).toEqual([]);
  });

  test("aliases resolve to the canonical grammar", () => {
    // run/logs/skills/release-gate are aliases; they must not need own entries.
    for (const alias of ["run", "logs", "skills", "release-gate"]) {
      expect(alias in POSITIONAL_GRAMMAR).toBe(false);
    }
    accepts(["run", "a prompt"]);
    accepts(["logs"]);
    rejects(["logs", "EXTRA"]);
  });

  test("the grammar covers exactly the declared command set", () => {
    expect(Object.keys(POSITIONAL_GRAMMAR).sort()).toEqual(COMMAND_SPECS.map((spec) => spec.name).sort());
  });
});

describe("surplus positionals are rejected rather than discarded", () => {
  test("flag-only commands take nothing", () => {
    for (const name of ["init", "setup", "status", "doctor", "verify", "tui", "events", "orchestrate", "gate"]) {
      rejects([name, "EXTRA"], "unexpected extra argument");
      accepts([name]);
      accepts([name, "--cwd", "/repo"]);
    }
  });

  test("action commands reject a token after the action", () => {
    rejects(["daemon", "status", "EXTRA"], "unexpected extra argument");
    rejects(["lead", "use", "codex", "EXTRA"], "unexpected extra argument");
    rejects(["receipt", "list", "EXTRA"], "unexpected extra argument");
    rejects(["budget", "list", "EXTRA"], "unexpected extra argument");
    rejects(["fleet", "profile", "list", "EXTRA"], "unexpected extra argument");
    rejects(["project", "trust", "grant", "EXTRA"], "unexpected extra argument");
    rejects(["receipt", "diff", "a", "b", "EXTRA"], "unexpected extra argument");
    rejects(["skill", "use", "some-skill", "EXTRA"], "unexpected extra argument");
  });

  test("legal invocations still pass", () => {
    for (const argv of [
      ["daemon"], ["daemon", "stop"], ["lead"], ["lead", "use", "codex"],
      ["project", "trust"], ["project", "trust", "grant"],
      ["fleet"], ["fleet", "profile", "create"],
      ["receipt", "diff", "a", "b"], ["receipt", "show", "run-1"],
      ["budget", "linked-hold", "inspect"], ["skill", "use", "some-skill"],
      ["mcp"], ["mcp", "status"], ["mcp", "install", "codex"],
      ["ledger", "verify"], ["exec", "a prompt"], ["council"], ["council", "a question"],
    ]) accepts(argv);
  });
});

describe("required fields are demanded, and never taken from the opaque tail", () => {
  test("a missing required field is named", () => {
    rejects(["mcp", "install"], "requires host");
    rejects(["receipt", "show"], "requires runId");
    rejects(["lead", "use"], "requires host");
    rejects(["launch"], "requires backend");
    rejects(["receipt", "diff", "only-one"], "requires runIdB");
  });

  test("a fixed field cannot be satisfied from after the separator", () => {
    // `--` is opaque by contract, so these stay missing rather than silently
    // consuming the tail as the value.
    rejects(["mcp", "install", "--", "codex"], "requires host");
    rejects(["receipt", "show", "--", "id"], "requires runId");
  });

  test("a command with no default subcommand demands one", () => {
    rejects(["ledger"], "requires a subcommand");
    rejects(["receipt"], "requires a subcommand");
  });
});

describe("a value supplied twice is rejected instead of silently dropped", () => {
  test("a flag that owns the value closes the positional slot", () => {
    rejects(["approval", "resolve", "--resolution", "done", "also done"], "ambiguous");
    rejects(["receipt", "verify", "--file", "export.json", "run-1"], "ambiguous");
    rejects(["loop", "start", "--file", "plan.json", "an objective"], "ambiguous");
    rejects(["loop", "start", "--repair", "an objective"], "ambiguous");
  });

  test("either source alone is accepted", () => {
    accepts(["approval", "resolve", "--resolution", "done"]);
    accepts(["approval", "resolve", "done"]);
    accepts(["receipt", "verify", "--file", "export.json"]);
    accepts(["receipt", "verify", "run-1"]);
    accepts(["loop", "start", "--file", "plan.json"]);
    accepts(["loop", "start", "an objective"]);
  });
});

describe("the separator contract is preserved", () => {
  test("nothing after -- is inspected", () => {
    accepts(["exec", "--", "--json", "-x", "many", "tokens"]);
    accepts(["council", "--", "a", "long", "question"]);
    accepts(["skill", "use", "some-skill", "--", "any", "args"]);
    // init has no consumer for a tail, but the separator contract makes it
    // opaque; rejecting it would be a separate product decision.
    accepts(["init", "--", "anything"]);
  });

  test("prompt text may not come from both sides", () => {
    rejects(["exec", "before", "--", "after"], "both before and after --");
    accepts(["exec", "just before"]);
    accepts(["exec", "--", "just after"]);
  });

  test("an unrecognised action is left to the handler's own usage error", () => {
    // More specific there than anything this layer could say.
    accepts(["daemon", "not-a-real-action"]);
    accepts(["receipt", "not-a-real-action"]);
  });
});
