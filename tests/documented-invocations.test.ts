import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { validateCommandFlags, validateCommandPositionals } from "../src/cli/argv";
import { resolveCommandSpec } from "../src/cli/command-specs";

/**
 * Every `headless ...` invocation printed in the docs, README or website is run
 * through the real flag and positional validators.
 *
 * Unknown flags are rejected rather than ignored, which makes a documented
 * example with a removed or misspelled flag a copy-paste failure for the reader.
 * That surface was validated once when the rejection landed and then nothing
 * re-checked it, so the guarantee decayed to a sentence in the CHANGELOG. This
 * makes it a property the suite enforces.
 *
 * Deliberately conservative about what counts as an invocation: placeholder
 * syntax, pipes and shell continuations are skipped rather than guessed at. The
 * floor assertion below is what stops that conservatism from quietly emptying
 * the corpus.
 */
const ROOT = join(import.meta.dir, "..");
const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", ".poly", "coverage", ".claude", ".github"]);

function documentationFiles(directory: string, found: string[] = []) {
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) documentationFiles(full, found);
    else if (/\.(md|mdx)$/.test(entry)) found.push(full);
  }
  return found;
}

/**
 * Drops a trailing shell comment, but only when the `#` sits outside quotes.
 * Without this, four real invocations carrying an inline comment read as
 * failures — a defect in the extractor, not in the documentation.
 */
function stripComment(line: string) {
  let quote: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#" && (index === 0 || /\s/.test(line[index - 1]!))) return line.slice(0, index).trim();
  }
  return line;
}

function invocations(text: string) {
  const found: string[] = [];
  for (const raw of text.split("\n")) {
    const line = stripComment(raw.trim().replace(/^[$>]\s*/, "").replace(/^(?:[A-Z_][A-Z0-9_]*=\S+\s+)+/, ""));
    if (!/^headless\s/.test(line)) continue;
    // Not pure invocations: a pipeline, a placeholder the reader substitutes, or
    // a line continued onto the next one.
    if (/[|<>&]/.test(line) || line.includes("...") || line.includes("[") || line.endsWith("\\")) continue;
    found.push(line);
  }
  return found;
}

function tokens(line: string) {
  const matched: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line))) matched.push(match[1] ?? match[2] ?? match[3]!);
  return matched.slice(1);
}

test("every documented headless invocation passes the real CLI validators", () => {
  const failures: string[] = [];
  const unresolved: string[] = [];
  let validated = 0;
  for (const file of documentationFiles(ROOT)) {
    for (const line of invocations(readFileSync(file, "utf8"))) {
      const raw = tokens(line);
      if (raw.length === 0) continue;
      // `experimental` is a namespace, not a command, so the validators find no
      // spec for it and RETURN WITHOUT CHECKING ANYTHING. src/cli.ts:42 strips it
      // before validating; this must do the same or every documented
      // `headless experimental ...` line is counted and never checked. That was
      // 88 of 211 -- 42% of this corpus silently unvalidated -- when this test
      // first landed.
      const argv = raw[0] === "experimental" ? raw.slice(1) : raw;
      if (argv.length === 0) continue;
      if (!resolveCommandSpec(argv[0])) {
        // Only bare top-level switches legitimately resolve to no command.
        // Anything else reaching here would be silently skipped, so surface it.
        if (argv[0] === "--version" || argv[0] === "--help" || argv[0] === "-v" || argv[0] === "-h") continue;
        unresolved.push(`${relative(ROOT, file)}: ${line}`);
        continue;
      }
      validated += 1;
      try {
        validateCommandFlags(argv);
        validateCommandPositionals(argv);
      } catch (error) {
        failures.push(`${relative(ROOT, file)}: ${line}\n    ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // Counts only invocations the validators ACTUALLY inspected. Counting attempts
  // instead let a no-op inflate the floor, which is how this test shipped
  // claiming a corpus it was not checking -- the exact shape it exists to catch.
  expect(validated, "documented invocations were not validated — the extractor or the namespace normalization is broken, not the docs").toBeGreaterThan(150);
  expect(unresolved, `documented invocations naming no known command (silently unchecked):\n${unresolved.join("\n")}`).toEqual([]);
  expect(failures, `documented invocations rejected by the CLI validators:\n${failures.join("\n")}`).toEqual([]);
});
