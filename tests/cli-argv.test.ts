import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CliUsageError,
  isFlagValue,
  isNegativeNumericLiteral,
  parseCommandArgv,
  resolveCommandAction,
  validateCommandFlags,
} from "../src/cli/argv";
import { COMMAND_SPECS, renderCommandUsage, resolveCommandSpec } from "../src/cli/command-specs";
import { parseCollaborationCommand } from "../src/cli/commands/collaboration";
import { getArg, getPrompt, getRepeatedArgs } from "../src/cli/shared";

describe("resolveCommandAction reads the grammar, not a physical index", () => {
  // The stable surface regressed because every handler did `args[1] || default`,
  // so the documented global flag became the subcommand.
  const stableRegressions: Array<[string[], string | undefined, string[]]> = [
    [["daemon", "--cwd", "/repo"], "status", []],
    [["daemon", "--cwd", "/repo", "stop"], "stop", []],
    [["lead", "--cwd", "/repo"], "status", []],
    [["lead", "--cwd", "/repo", "use", "codex"], "use", ["codex"]],
    [["mcp", "--cwd", "/repo"], "serve", []],
    [["mcp", "--cwd", "/repo", "install", "claude"], "install", ["claude"]],
    [["goal", "--cwd", "/repo"], "list", []],
    [["fleet", "--cwd", "/repo", "profile", "list"], "profile", ["list"]],
    [["exec", "--cwd", "/repo", "--extension-module", "/mod.js", "prompt"], "prompt", []],
  ];

  for (const [argv, action, operands] of stableRegressions) {
    test(`\`${argv.join(" ")}\` resolves to ${action ?? "(fallback)"}`, () => {
      const fallback = { daemon: "status", lead: "status", mcp: "serve", goal: "list", fleet: "health" }[argv[0]!];
      const resolved = resolveCommandAction(argv, fallback);
      expect(resolved.action).toBe(action);
      expect(resolved.operands).toEqual(operands);
      // `resolved.action?.startsWith("-")` silently passed whenever action was
      // undefined, which is exactly the regression the row is meant to catch.
      expect(resolved.action).toBeDefined();
      expect(resolved.action!.startsWith("-")).toBe(false);
    });
  }

  test("never mistakes a value flag's value for the action on any command that takes --cwd", () => {
    for (const spec of COMMAND_SPECS) {
      if (!("valueFlags" in spec) || !spec.valueFlags.includes("--cwd")) continue;
      const resolved = resolveCommandAction([spec.name, "--cwd", "/repo"], "fallback");
      expect({ command: spec.name, ...resolved }).toEqual({
        command: spec.name,
        action: "fallback",
        explicit: false,
        operands: [],
        argvWithoutAction: [spec.name, "--cwd", "/repo"],
      });
    }
  });

  test("distinguishes an explicit action from the fallback", () => {
    expect(resolveCommandAction(["daemon"], "status")).toEqual({
      action: "status", explicit: false, operands: [], argvWithoutAction: ["daemon"],
    });
    expect(resolveCommandAction(["daemon", "status"], "status")).toEqual({
      action: "status", explicit: true, operands: [], argvWithoutAction: ["daemon"],
    });
    expect(resolveCommandAction(["launch"]).action).toBeUndefined();
    expect(resolveCommandAction(["launch"]).explicit).toBe(false);
  });

  test("skips unknown and boolean switches without consuming an argument", () => {
    expect(resolveCommandAction(["goal", "--autonomous", "start"], "list").action).toBe("start");
    expect(resolveCommandAction(["daemon", "reap", "--all", "--confirm"], "status")).toEqual({
      action: "reap", explicit: true, operands: [], argvWithoutAction: ["daemon", "--all", "--confirm"],
    });
    // --limit is not a daemon flag; validateCommandFlags rejects it first, so the
    // scanner only has to avoid inventing an action from the leftover token.
    expect(resolveCommandAction(["daemon", "--no-idle-timeout"], "status").explicit).toBe(false);
  });

  test("treats a value flag with no usable value as unconsumed rather than swallowing the next token", () => {
    expect(resolveCommandAction(["daemon", "--cwd"], "status").action).toBe("status");
    expect(resolveCommandAction(["daemon", "--cwd", "--json", "stop"], "status").action).toBe("stop");
  });

  test("argvWithoutAction removes only the action and preserves flags, values, and the tail", () => {
    const resolved = resolveCommandAction(["goal", "--cwd", "/repo", "start", "--detach", "--", "--flag-like prompt"], "list");
    expect(resolved.action).toBe("start");
    expect(resolved.argvWithoutAction).toEqual(["goal", "--cwd", "/repo", "--detach", "--", "--flag-like prompt"]);
    expect(getPrompt(resolved.argvWithoutAction)).toBe("--flag-like prompt");
  });

  test("returns later positionals as operands for nested grammars", () => {
    expect(resolveCommandAction(["project", "trust", "grant", "--allow-bypass"], "trust").operands).toEqual(["grant"]);
    expect(resolveCommandAction(["receipt", "diff", "run-a", "run-b", "--json"]).operands).toEqual(["run-a", "run-b"]);
    expect(resolveCommandAction(["budget", "linked-hold", "quarantine", "--link-id", "abc"], "list").operands).toEqual(["quarantine"]);
  });

  test("resolves aliases through the canonical spec", () => {
    expect(resolveCommandAction(["logs", "--limit", "5"], "tail").action).toBe("tail");
    expect(resolveCommandAction(["skills", "--source", "/pkg", "import"], "list").action).toBe("import");
    expect(resolveCommandAction(["run", "--backend", "codex", "prompt"]).action).toBe("prompt");
  });
});

describe("separator safety", () => {
  test("never takes an action or an operand from after --", () => {
    expect(resolveCommandAction(["daemon", "--", "stop"], "status")).toEqual({
      action: "status", explicit: false, operands: [], argvWithoutAction: ["daemon", "--", "stop"],
    });
    expect(resolveCommandAction(["goal", "start", "--", "send", "extra"], "list").operands).toEqual([]);
  });

  test("splits the passthrough tail without interpreting it", () => {
    const parsed = parseCommandArgv(["exec", "--cwd", "/repo", "--", "--json", "-f", "text"]);
    expect(parsed.spec?.name).toBe("exec");
    expect(parsed.flagsBeforeSeparator).toEqual(["exec", "--cwd", "/repo"]);
    expect(parsed.positionalEntries).toEqual([]);
    expect(parsed.passthrough).toEqual(["--json", "-f", "text"]);
    expect(parseCommandArgv(["exec", "prompt"]).passthrough).toBeUndefined();
  });

  test("records the physical index of each positional", () => {
    expect(parseCommandArgv(["fleet", "--cwd", "/repo", "profile", "list"]).positionalEntries)
      .toEqual([{ value: "profile", index: 3 }, { value: "list", index: 4 }]);
  });
});

describe("getPrompt reads the same operands the validator counted", () => {
  // A private scanner using token.startsWith("-") and the GLOBAL value-flag
  // union disagreed with parseCommandArgv on a bare `-`, on negative numerics,
  // and on flags belonging to other commands. The costly case: `council -1`
  // passed validation with -1 as the question, then getPrompt returned
  // undefined and the handler ran its DEFAULT question — a different,
  // quota-spending council than the operator asked for.
  const operandCases: Array<[string[], string | undefined]> = [
    [["council", "-1"], "-1"],
    [["council", "-"], "-"],
    [["exec", "-1"], "-1"],
    [["exec", "-"], "-"],
    [["exec", "a prompt"], "a prompt"],
    [["council"], undefined],
    [["exec", "--session-id", "s1", "--timeout-ms", "2", "prompt"], "prompt"],
  ];

  for (const [argv, prompt] of operandCases) {
    test(`\`${argv.join(" ")}\` yields ${JSON.stringify(prompt)}`, () => {
      expect(getPrompt(argv)).toBe(prompt as string);
      // The grammar and the reader must agree on WHICH tokens are operands.
      expect(parseCommandArgv(argv).positionalEntries.map((entry) => entry.value))
        .toEqual(prompt === undefined ? [] : [prompt]);
    });
  }

  test("a command's own value flags decide what is consumed, not the global union", () => {
    // --limit belongs to events, not exec; the global union swallowed the token
    // behind it, so the operand the grammar saw was not the prompt exec ran.
    expect(parseCommandArgv(["exec", "--limit", "2", "prompt"]).positionalEntries.map((entry) => entry.value))
      .toEqual(["2", "prompt"]);
    expect(() => getPrompt(["exec", "--limit", "2", "prompt"])).toThrow("Unexpected extra prompt argument: prompt");
    expect(getPrompt(["events", "--limit", "2", "prompt"])).toBe("prompt");
  });

  test("the post-separator fast path is unchanged", () => {
    expect(getPrompt(["exec", "--", "--help"])).toBe("--help");
    expect(getPrompt(["exec", "--", "a", "long", "prompt"])).toBe("a long prompt");
    expect(getPrompt(["exec", "--"])).toBeUndefined();
    // One token before `--`; more than one is still an operator error.
    expect(getPrompt(["exec", "one two"])).toBe("one two");
    expect(() => getPrompt(["exec", "one", "two"])).toThrow(CliUsageError);
  });
});

describe("validateCommandFlags rejects flags the command does not accept", () => {
  test("rejects a flag that is only valid on another command", () => {
    // --limit is registered by events/collaboration/receipt. The global union
    // would have accepted it here, which is the defect this replaces.
    expect(() => validateCommandFlags(["exec", "--limit", "2", "prompt"])).toThrow("Unknown flag for exec: --limit.");
    expect(() => validateCommandFlags(["exec", "--limit", "2"])).toThrow(CliUsageError);
    expect(() => validateCommandFlags(["daemon", "serve", "--stream"])).toThrow("Unknown flag for daemon: --stream.");
    expect(() => validateCommandFlags(["verify", "--follow"])).toThrow("Unknown flag for verify: --follow.");
  });

  test("reports the canonical command name for an alias", () => {
    expect(() => validateCommandFlags(["logs", "--stream"])).toThrow("Unknown flag for events: --stream.");
  });

  test("accepts every flag each command declares, and nothing it does not", () => {
    for (const spec of COMMAND_SPECS) {
      for (const flag of "valueFlags" in spec ? spec.valueFlags : []) {
        expect(() => validateCommandFlags([spec.name, flag, "value"])).not.toThrow();
      }
      for (const flag of "booleanFlags" in spec ? spec.booleanFlags : []) {
        expect(() => validateCommandFlags([spec.name, flag])).not.toThrow();
      }
      // Paired reject per command: an accept-only loop passes against a
      // validator that checks nothing, which is the defect it exists to catch.
      expect(() => validateCommandFlags([spec.name, "--not-a-declared-flag"]))
        .toThrow(`Unknown flag for ${spec.name}: --not-a-declared-flag.`);
    }
  });

  test("accepts --json only where the command's own output is JSON", () => {
    // Accepting it everywhere made it a silent no-op: `headless init --json`
    // exited 0 with prose. A command whose success output is human text must
    // refuse the flag rather than ignore the operator's request.
    for (const name of ["lead", "daemon", "fleet", "goal", "status", "events", "council", "skill", "loop", "orchestrate"]) {
      expect(() => validateCommandFlags([name, "--json"])).not.toThrow();
    }
    for (const name of ["init", "setup", "mcp", "tui"]) {
      expect(() => validateCommandFlags([name, "--json"])).toThrow(`Unknown flag for ${name}: --json.`);
    }
  });

  test("a repeated flag still rejects an empty value", () => {
    // getArg tolerates "" so the top-level error renderer can read --cwd, but
    // unifying getRepeatedArgs under that let `--agent ""` through to the
    // daemon as a real agent id instead of failing in the parser.
    expect(() => getRepeatedArgs(["fleet", "--agent", ""], "--agent")).toThrow("Missing value for --agent.");
    expect(() => getRepeatedArgs(["fleet", "--agent", "a", "--agent", ""], "--agent")).toThrow("Missing value for --agent.");
    expect(getRepeatedArgs(["fleet", "--agent", "a", "--agent", "b"], "--agent")).toEqual(["a", "b"]);
  });

  test("never inspects tokens after the separator", () => {
    expect(() => validateCommandFlags(["exec", "--", "--limit", "--not-a-flag", "-x"])).not.toThrow();
    expect(() => validateCommandFlags(["exec", "--cwd", "/repo", "--", "--follow"])).not.toThrow();
    // Paired: the identical tokens BEFORE the separator are rejected, so these
    // accepts show the separator is honoured rather than that nothing is read.
    expect(() => validateCommandFlags(["exec", "--follow", "--", "--follow"])).toThrow("Unknown flag for exec: --follow.");
    expect(() => validateCommandFlags(["exec", "-x", "--", "-x"])).toThrow("Unknown flag for exec: -x.");
  });

  test("treats bare - and negative numbers as operands, not flags", () => {
    // `["experimental", "-1"]` used to stand in for this: "experimental" is not
    // a command, so resolveCommandSpec returned undefined and the function
    // exited before any check — a not.toThrow that could not fail.
    expect(() => validateCommandFlags(["exec", "-", "prompt"])).not.toThrow();
    expect(() => validateCommandFlags(["council", "-1"])).not.toThrow();
    expect(() => validateCommandFlags(["collaboration", "turns", "--after-sequence", "-1"])).not.toThrow();
    // Paired reject on the same commands, so a no-op validator fails here.
    expect(() => validateCommandFlags(["council", "-1x"])).toThrow("Unknown flag for council: -1x.");
    expect(() => validateCommandFlags(["exec", "--", "prompt"])).not.toThrow();
    expect(() => validateCommandFlags(["exec", "-x", "prompt"])).toThrow("Unknown flag for exec: -x.");
  });

  test("ignores argv whose command cannot be resolved, because dispatch rejects it first", () => {
    expect(() => validateCommandFlags(["definitely-not-a-command", "--nonsense"])).not.toThrow();
    expect(() => validateCommandFlags([])).not.toThrow();
  });

  test("catches a misspelled flag before it can be read as a subcommand", () => {
    expect(() => validateCommandFlags(["daemon", "--cdw", "/repo"])).toThrow("Unknown flag for daemon: --cdw.");
    expect(() => validateCommandFlags(["exec", "--cwd=/repo", "prompt"])).toThrow("Unknown flag for exec: --cwd=/repo.");
  });
});

describe("value tokens", () => {
  test("accepts negative numeric literals as values and leaves the range check to the parser", () => {
    for (const value of ["-1", "-1.5", "-1e3", "-0.5", "-.5"]) expect(isNegativeNumericLiteral(value)).toBe(true);
    for (const value of ["-", "--", "-j", "--json", "-1a", "1"]) expect(isNegativeNumericLiteral(value)).toBe(false);
    expect(getArg(["collaboration", "turns", "--after-sequence", "-1"], "--after-sequence")).toBe("-1");
    expect(getArg(["exec", "--timeout-ms", "-1e3"], "--timeout-ms")).toBe("-1e3");
    expect(getRepeatedArgs(["gate", "--check", "-1", "--check", "build"], "--check")).toEqual(["-1", "build"]);
  });

  test("reports a missing value when the next token is a flag, the separator, or absent", () => {
    expect(() => getArg(["verify", "--cwd", "--json"], "--cwd")).toThrow("Missing value for --cwd.");
    expect(() => getArg(["verify", "--cwd", "--"], "--cwd")).toThrow("Missing value for --cwd.");
    expect(() => getArg(["verify", "--cwd"], "--cwd")).toThrow("Missing value for --cwd.");
    expect(() => getRepeatedArgs(["fleet", "--agent"], "--agent")).toThrow("Missing value for --agent.");
    expect(() => getRepeatedArgs(["fleet", "--agent", "--json"], "--agent")).toThrow("Missing value for --agent.");
    expect(isFlagValue(undefined)).toBe(false);
    expect(isFlagValue("/repo")).toBe(true);
  });

  test("treats an empty string as a value, because the error renderer reads --cwd", () => {
    // Rejecting "" made `--cwd ""` throw inside src/cli.ts's top-level catch,
    // which reads --cwd to build the remedy — so the renderer faulted on the
    // error it was rendering and printed a raw stack trace instead. Callers
    // spell the default as `getArg(flags, "--cwd") || process.cwd()`.
    expect(isFlagValue("")).toBe(true);
    expect(getArg(["verify", "--cwd", ""], "--cwd")).toBe("");
  });

  test("lets the semantic parser own the range message for a negative value", () => {
    // `--after-sequence -1` used to report "Missing value", blaming the flag
    // instead of the number the operator actually got wrong.
    expect(() => parseCollaborationCommand(["collaboration", "turns", "--goal-id", "g1", "--after-sequence", "-1"]))
      .toThrow("Invalid value for --after-sequence: expected a nonnegative integer.");
  });

  test("never steals a registered flag as the previous flag's value", () => {
    expect(() => getArg(["exec", "--model", "--json", "prompt"], "--model")).toThrow("Missing value for --model.");
    // The scanner agrees with getArg: --json stays a switch, so the operand
    // behind it is still visible rather than absorbed into --model.
    expect(resolveCommandAction(["exec", "--model", "--json", "prompt"]).action).toBe("prompt");
  });
});

describe("renderCommandUsage names the namespace the operator must type", () => {
  test("prefixes experimental commands and leaves stable ones bare", () => {
    expect(renderCommandUsage("daemon")).toBe("Usage: headless daemon <serve|status|stop|reap> [--cwd dir] [--extension-config /absolute/trusted.json] [--idle-timeout-ms ms | --no-idle-timeout] [reap: --confirm] [reap: --all]");
    expect(renderCommandUsage("goal")).toStartWith("Usage: headless experimental goal <start|run|send|");
    expect(renderCommandUsage("logs")).toStartWith("Usage: headless experimental events | logs ");
    expect(renderCommandUsage("pair")).toBe("Usage: headless experimental pair");
    expect(renderCommandUsage("nope")).toBe("Usage: headless --help");
  });

  test("stays consistent with the help catalog", () => {
    for (const spec of COMMAND_SPECS) {
      const usage = renderCommandUsage(spec.name);
      expect(usage).toStartWith("Usage: headless ");
      if ("help" in spec) expect(usage).toEndWith(spec.help);
    }
  });
});

describe("the declared flag catalog matches the handlers", () => {
  // Rejection is only safe while every consumed switch is declared: an omission
  // turns a targeted command error into a bogus "Unknown flag".
  const commandsByFile: Record<string, string[]> = {
    "approval.ts": ["approval"],
    "autonomy.ts": ["autonomy", "orchestrate", "ask", "coop-proof", "pair"],
    "budget.ts": ["budget"],
    "candidate.ts": ["candidate"],
    "collaboration.ts": ["collaboration"],
    "daemon.ts": ["daemon"],
    "events.ts": ["events"],
    "exec.ts": ["exec"],
    "fleet.ts": ["fleet"],
    "goal.ts": ["goal"],
    "launch.ts": ["launch"],
    "lead.ts": ["lead"],
    "ledger.ts": ["ledger", "verify"],
    "lifecycle.ts": ["init", "setup", "status", "doctor", "tui"],
    "loop.ts": ["loop"],
    "mcp.ts": ["mcp"],
    "project.ts": ["project"],
    "quality.ts": ["council", "gate"],
    "receipt.ts": ["receipt"],
    "session.ts": ["session"],
    "skill.ts": ["skill"],
    "workflow.ts": ["workflow"],
  };

  test("covers every handler file", () => {
    const files = [...new Bun.Glob("*.ts").scanSync({ cwd: new URL("../src/cli/commands", import.meta.url).pathname })];
    expect(files.sort()).toEqual(Object.keys(commandsByFile).sort());
  });

  for (const [file, commands] of Object.entries(commandsByFile)) {
    test(`${file} consumes no undeclared switch`, () => {
      const source = readFileSync(new URL(`../src/cli/commands/${file}`, import.meta.url), "utf8");
      const accepted = new Set(commands.flatMap((name) => {
        const spec = resolveCommandSpec(name)!;
        return [...("valueFlags" in spec ? spec.valueFlags : []), ...("booleanFlags" in spec ? spec.booleanFlags : [])];
      }));
      for (const match of source.matchAll(/\.includes\("(-{1,2}[A-Za-z][\w-]*)"\)/g)) {
        expect({ file, flag: match[1], declared: accepted.has(match[1]!) }).toEqual({ file, flag: match[1], declared: true });
      }
    });
  }

  test("keeps value flags and boolean flags disjoint per command", () => {
    for (const spec of COMMAND_SPECS) {
      const valueFlags = "valueFlags" in spec ? spec.valueFlags : [];
      const booleanFlags = "booleanFlags" in spec ? spec.booleanFlags : [];
      for (const flag of booleanFlags) {
        expect({ command: spec.name, flag, isValueFlag: valueFlags.includes(flag) }).toEqual({ command: spec.name, flag, isValueFlag: false });
        expect(flag).toStartWith("-");
      }
      expect(new Set(booleanFlags).size).toBe(booleanFlags.length);
    }
  });
});
