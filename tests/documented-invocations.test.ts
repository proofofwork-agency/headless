import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { validateCommandFlags, validateCommandPositionals } from "../src/cli/argv";

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
  let checked = 0;
  for (const file of documentationFiles(ROOT)) {
    for (const line of invocations(readFileSync(file, "utf8"))) {
      const argv = tokens(line);
      if (argv.length === 0) continue;
      checked += 1;
      try {
        validateCommandFlags(argv);
        validateCommandPositionals(argv);
      } catch (error) {
        failures.push(`${relative(ROOT, file)}: ${line}\n    ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // A corpus that silently empties would make the assertion below unfailable,
  // which is the exact shape this repository keeps shipping. 210 were found when
  // this landed; the floor only has to be high enough that a broken extractor
  // cannot pass.
  expect(checked, "documented invocations were not found — the extractor is broken, not the docs").toBeGreaterThan(150);
  expect(failures, `documented invocations rejected by the CLI validators:\n${failures.join("\n")}`).toEqual([]);
});
