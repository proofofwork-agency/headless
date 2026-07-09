#!/usr/bin/env bun
/**
 * headless (hless) — thin CLI for the first vertical slice.
 * Usage examples:
 *   bun src/cli.ts exec --backend opencode "What is the main package in this repo?"
 *   bun src/cli.ts exec --backend opencode --model provider/model "plan the auth changes"
 */

import { join } from "path";
import { backendChoices, exec, normalizeBackend } from "./index";

class CliUsageError extends Error {}

async function main() {
  const args = process.argv.slice(2);
  const sub = args[0];

  if (sub === "help" || args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }
  if (args.includes("--version") || args.includes("-V")) {
    console.log(await readVersion());
    process.exit(0);
  }

  if (sub === "exec" || sub === "run") {
    const backendInput = getArg(args, "--backend") || "opencode";
    let backend: ReturnType<typeof normalizeBackend>;
    try {
      backend = normalizeBackend(backendInput);
    } catch {
      throw new CliUsageError(`Unsupported --backend ${backendInput}. Expected one of: ${backendChoices().join(", ")}`);
    }
    const prompt = getPrompt(args);
    if (!prompt) {
      throw new CliUsageError(`Usage: headless exec --backend <${backendChoices().join("|")}> "your prompt"`);
    }
    const model = getArg(args, "--model");
    const agent = getArg(args, "--agent");
    const mode = getMode(args);
    const cwd = getArg(args, "--cwd");
    const timeoutMs = parseIntegerArg(args, "--timeout-ms");
    const asJson = args.includes("--json") || args.includes("-j");
    const res = await exec({
      backend,
      prompt,
      model: model || undefined,
      agent: agent || undefined,
      mode,
      cwd: cwd || undefined,
      timeoutMs,
    });

    if (asJson) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      // Nice default: print the actual answer text
      if (res.output) {
        console.log(res.output);
      } else {
        console.log("(no text output)");
      }
      if (res.cost != null || res.tokens != null) {
        console.error(`\n---\ncost: ${res.cost ?? 'n/a'}  tokens: ${res.tokens ?? 'n/a'}  time: ${res.durationMs}ms`);
      }
    }
    process.exit(res.ok ? 0 : 1);
  }

  if (sub === "launch") {
    const target = args[1];
    const cwd = getArg(args, "--cwd") || process.cwd();

    if (target === "grok" || target === "grok-build") {
      console.log("Running a Grok CLI single-turn smoke through Headless...");
      const res = await import("./index").then(m => m.exec({ backend: "grok-build", prompt: "Respond with ready.", cwd }));
      console.log(res.output);
      process.exit(res.ok ? 0 : 1);
    }

    if (target === "opencode" || target === "opencode-worker") {
      console.log(`Launching OpenCode as a pure one-shot worker...`);
      const proc = Bun.spawn(["opencode", "run", "--pure", "--format", "json", "--dir", cwd], {
        cwd,
        stdout: "inherit",
        stderr: "inherit",
        stdin: "inherit",
      });
      await proc.exited;
      process.exit(proc.exitCode || 0);
    }

    if (target === "opencode-serve") {
      console.log("Starting OpenCode server for attach / SDK experiments...");
      const proc = Bun.spawn(["opencode", "serve"], { cwd, stdout: "inherit", stderr: "inherit" });
      await proc.exited;
      process.exit(proc.exitCode || 0);
    }

    console.error(`Usage: headless launch <grok|grok-build|opencode|opencode-serve|opencode-worker> [--cwd dir]`);
    process.exit(1);
  }

  console.error(`Unknown command: ${sub ?? "(none)"}`);
  printHelp();
  process.exit(1);
}

function printHelp() {
  console.log(`headless (hless) — normalized headless runner for coding CLIs

Commands:
  exec | run   --backend <opencode|claude-code|codex|grok-build> [--agent plan|build|review] [--model m] [--cwd dir] [--json] "prompt"
               [--mode read-only|write]

  launch <backend>   Launch a backend helper such as opencode serve or a pure worker.

  --backend grok     Alias for the Grok CLI single-turn backend.
  --backend opencode Drive OpenCode headlessly with opencode run --pure.
  --agent            Pass an agent name through to backends that support it.
  --mode             Enforce Headless mode policy before spawning. Defaults to read-only.

  --json / -j        Structured result with output, cost, tokens, exit code, and timeout.
  --help / -h        Show this help.
  --version / -V     Print the Headless version.

Run bun run check before changing runner behavior.
`);
}

async function readVersion(): Promise<string> {
  try {
    return String(JSON.parse(await Bun.file(join(import.meta.dir, "..", "package.json")).text()).version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

function getArg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new CliUsageError(`Missing value for ${name}.`);
  }
  return value;
}

export const VALUE_FLAGS = new Set(["--backend", "--model", "--agent", "--cwd", "--mode", "--timeout-ms"]);

function getMode(argv: string[]): "read-only" | "write" | undefined {
  const value = getArg(argv, "--mode");
  if (!value) return undefined;
  if (value === "read-only" || value === "write") return value;
  console.error(`Invalid --mode ${value}. Expected read-only or write.`);
  process.exit(1);
}

export function parseIntegerArg(argv: string[], name: string): number | undefined {
  const value = getArg(argv, name);
  if (value === undefined) return undefined;
  if (!/^-?\d+$/.test(value.trim())) {
    console.error(`Invalid integer for ${name}: ${value}`);
    process.exit(1);
  }
  return Number.parseInt(value, 10);
}

export function getPrompt(argv: string[]): string | undefined {
  // Everything after a literal "--" is the prompt, verbatim.
  const dash = argv.indexOf("--");
  if (dash >= 0) return argv.slice(dash + 1).join(" ");

  // Otherwise collect positionals after the subcommand, skipping the value of
  // any known value-taking flag (so `--cwd ./x` is not mistaken for a prompt).
  const positionals: string[] = [];
  for (let i = 1; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok.startsWith("-")) {
      if (VALUE_FLAGS.has(tok)) i += 1;
      continue;
    }
    positionals.push(tok);
  }
  if (positionals.length > 1) {
    throw new CliUsageError(`Unexpected extra prompt argument${positionals.length === 2 ? "" : "s"}: ${positionals.slice(1).join(" ")}`);
  }
  return positionals[0];
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
