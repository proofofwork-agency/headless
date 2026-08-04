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
      expect(resolved.action?.startsWith("-")).not.toBe(true);
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

  test("accepts every flag each command declares", () => {
    for (const spec of COMMAND_SPECS) {
      for (const flag of "valueFlags" in spec ? spec.valueFlags : []) {
        expect(() => validateCommandFlags([spec.name, flag, "value"])).not.toThrow();
      }
      for (const flag of "booleanFlags" in spec ? spec.booleanFlags : []) {
        expect(() => validateCommandFlags([spec.name, flag])).not.toThrow();
      }
    }
  });

  test("accepts --json everywhere because src/cli.ts renders every failure as JSON", () => {
    for (const name of ["lead", "daemon", "mcp", "fleet", "goal", "status"]) {
      expect(() => validateCommandFlags([name, "--json"])).not.toThrow();
    }
  });

  test("never inspects tokens after the separator", () => {
    expect(() => validateCommandFlags(["exec", "--", "--limit", "--not-a-flag", "-x"])).not.toThrow();
    expect(() => validateCommandFlags(["exec", "--cwd", "/repo", "--", "--follow"])).not.toThrow();
  });

  test("treats bare - and negative numbers as operands, not flags", () => {
    expect(() => validateCommandFlags(["exec", "-", "prompt"])).not.toThrow();
    expect(() => validateCommandFlags(["experimental", "-1"])).not.toThrow();
    expect(() => validateCommandFlags(["collaboration", "turns", "--after-sequence", "-1"])).not.toThrow();
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
