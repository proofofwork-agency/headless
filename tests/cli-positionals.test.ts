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
    // Paired with the near-miss that must be rejected, so an accept-only list
    // cannot report coverage it does not have: every row here passes against a
    // no-op validator, and only the paired reject proves one ran.
    const pairs: Array<[string[], string[]]> = [
      [["daemon", "stop"], ["daemon", "stop", "EXTRA"]],
      [["lead", "use", "codex"], ["lead", "use", "codex", "EXTRA"]],
      [["project", "trust", "grant"], ["project", "trust", "grant", "EXTRA"]],
      [["fleet", "profile", "create"], ["fleet", "profile", "create", "EXTRA"]],
      [["receipt", "diff", "a", "b"], ["receipt", "diff", "a"]],
      [["receipt", "show", "run-1"], ["receipt", "show"]],
      [["budget", "linked-hold", "inspect"], ["budget", "linked-hold", "inspect", "EXTRA"]],
      [["skill", "use", "some-skill"], ["skill", "use"]],
      [["mcp", "install", "codex"], ["mcp", "install"]],
      [["exec", "a prompt"], ["exec"]],
      [["council", "a question"], ["council", "a", "question"]],
    ];
    for (const [legal, nearMiss] of pairs) {
      accepts(legal);
      rejects(nearMiss);
    }
    // Bare and defaulted forms have no near-miss to pair with; they are covered
    // by the surplus rows above.
    for (const argv of [["daemon"], ["lead"], ["project", "trust"], ["fleet"], ["mcp"], ["mcp", "status"], ["ledger", "verify"], ["council"]]) {
      accepts(argv);
    }
  });
});

describe("a declared required operand is actually demanded", () => {
  // TextOperand.required was set by requiredText() for exec, goal start/run/send,
  // session send/resume and loop start, and then never read: requiredText and
  // optionalText were behaviourally identical, so `headless exec` passed
  // validation and produced a differently worded error one layer down.
  test("free text declared required is rejected when absent", () => {
    rejects(["exec"], "exec requires prompt.");
    rejects(["goal", "start"], "goal start requires objective.");
    rejects(["goal", "run"], "goal run requires objective.");
    rejects(["goal", "send"], "goal send requires message.");
    rejects(["session", "send"], "session send requires prompt.");
    rejects(["session", "resume"], "session resume requires prompt.");
    rejects(["loop", "start"], "loop start requires objective or --file or --repair.");
    rejects(["approval", "resolve"], "approval resolve requires resolution or --resolution.");
  });

  test("free text declared optional is still allowed to be absent", () => {
    for (const argv of [["council"], ["ask"], ["autonomy", "ask"], ["autonomy", "more"], ["launch", "codex"]]) {
      accepts(argv);
    }
  });

  test("the opaque tail satisfies required text, but an empty tail does not", () => {
    // Free text may legally come from after `--`; a fixed field may not, and
    // `exec --` supplies no text at all — the same rule getPrompt applies.
    accepts(["exec", "--", "a", "long", "prompt"]);
    accepts(["goal", "start", "--", "ship", "it"]);
    rejects(["exec", "--"], "exec requires prompt.");
    rejects(["goal", "start", "--"], "goal start requires objective.");
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
    // Each accept is paired with the doubled form, which the test above proves
    // is rejected — so neither half can pass against a no-op validator.
    accepts(["approval", "resolve", "--resolution", "done"]);
    accepts(["approval", "resolve", "done"]);
    rejects(["approval", "resolve", "--resolution", "done", "done"], "ambiguous");
    accepts(["receipt", "verify", "--file", "export.json"]);
    accepts(["receipt", "verify", "run-1"]);
    rejects(["receipt", "verify", "--file", "export.json", "run-1"], "ambiguous");
    accepts(["loop", "start", "--file", "plan.json"]);
    accepts(["loop", "start", "an objective"]);
    rejects(["loop", "start", "--file", "plan.json", "an objective"], "ambiguous");
  });
});

describe("the separator contract is preserved", () => {
  test("nothing after -- is inspected", () => {
    // Paired with the same tokens moved BEFORE the separator, where the
    // one-token arity rejects them. Without the pair every line here passes
    // against a validator that inspects nothing at all.
    accepts(["exec", "--", "--json", "-x", "many", "tokens"]);
    rejects(["exec", "many", "tokens"], "unexpected extra argument");
    accepts(["council", "--", "a", "long", "question"]);
    rejects(["council", "a", "long", "question"], "unexpected extra argument");
    accepts(["skill", "use", "some-skill", "--", "any", "args"]);
    rejects(["skill", "use", "some-skill", "any", "args"], "unexpected extra argument");
    // init has no consumer for a tail, but the separator contract makes it
    // opaque; rejecting it would be a separate product decision.
    accepts(["init", "--", "anything"]);
    rejects(["init", "anything"], "unexpected extra argument");
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
    // Paired: once the action IS recognised, a surplus token is this layer's
    // business again, so the accepts above are a deliberate hand-off rather
    // than a validator that never fires.
    rejects(["daemon", "status", "not-a-real-action"], "unexpected extra argument");
    rejects(["receipt", "list", "not-a-real-action"], "unexpected extra argument");
  });
});
