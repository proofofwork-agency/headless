import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Pins the specific numbers SECURITY.md and the public safety-model page state
 * to the constants that actually produce them.
 *
 * This exists because a documented figure went wrong in both directions in one
 * day. The "$5 cap when trusted pricing exists" was correct, an audit pass
 * concluded it was fictional, and the resulting "correction" — asserting there
 * is no flat USD default — was itself published to SECURITY.md and the website
 * before anyone read `DEFAULT_BROKER_MAX_COST_USD`. Reviewing prose against
 * memory is what failed; a claim with a number in it can simply be executed.
 *
 * Scope is deliberately narrow: only claims reducible to a constant. Prose about
 * behaviour belongs in the behavioural suites, not here. Reading the source text
 * rather than importing keeps this from adding test-only exports to production
 * modules, and means drift on EITHER side fails.
 */

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

/** Reads `const NAME = <number>` with underscore separators or a byte product. */
function sourceConstant(path: string, name: string): number {
  const source = read(path);
  const match = new RegExp(`\\b${name}\\b[^=]*=\\s*([^;]+);`).exec(source);
  if (!match) throw new Error(`${name} is no longer declared in ${path}`);
  const expression = match[1]!.trim().replace(/_/g, "");
  if (!/^[\d*+\s]+$/.test(expression)) {
    throw new Error(`${name} in ${path} is no longer a plain numeric literal: ${expression}`);
  }
  return expression.split("*").reduce((total, term) => total * Number(term.trim()), 1);
}

const SECURITY = read("SECURITY.md");
const SAFETY_MODEL = read("website/docs/concepts/safety-model.md");

/**
 * `expect(page).toContain(...)` prints the whole document on failure, which
 * buries the one phrase that drifted. Assert a boolean carrying the phrase.
 */
function states(page: string, name: string, phrase: string) {
  expect(page.includes(phrase), `${name} must state: ${phrase}`).toBe(true);
}

describe("documented numbers match the constants that produce them", () => {
  test("broker per-run ceilings", () => {
    const service = "src/daemon/run-execution-service.ts";
    const requests = sourceConstant(service, "DEFAULT_BROKER_MAX_REQUESTS");
    const input = sourceConstant(service, "DEFAULT_BROKER_MAX_INPUT_TOKENS");
    const output = sourceConstant(service, "DEFAULT_BROKER_MAX_OUTPUT_TOKENS");
    const cost = sourceConstant(service, "DEFAULT_BROKER_MAX_COST_USD");

    expect([requests, input, output, cost]).toEqual([8, 200_000, 32_000, 5]);
    for (const [name, page] of [["SECURITY.md", SECURITY], ["safety-model.md", SAFETY_MODEL]] as const) {
      states(page, name, `${requests} requests`);
      states(page, name, `${input.toLocaleString("en-US")} aggregate input tokens`);
      states(page, name, `${output.toLocaleString("en-US")} aggregate output tokens`);
      // The claim that was removed and restored. It is true only because the
      // lease applies the constant when trusted pricing exists.
      states(page, name, `$${cost} cap when trusted pricing exists`);
    }
  });

  test("native-login capsule bounds", () => {
    const capsule = "src/runtime/native-auth-capsule.ts";
    const perFile = sourceConstant(capsule, "MAX_AUTH_FILE_BYTES");
    const total = sourceConstant(capsule, "MAX_AUTH_CAPSULE_BYTES");
    const setupToken = sourceConstant(capsule, "MAX_CLAUDE_SETUP_TOKEN_BYTES");

    expect([perFile, total, setupToken]).toEqual([2 * 1024 * 1024, 4 * 1024 * 1024, 4 * 1024]);
    states(SECURITY, "SECURITY.md", `bounded to ${perFile / 1024 / 1024} MiB per ordinary file and ${total / 1024 / 1024} MiB total`);
    states(SECURITY, "SECURITY.md", `separately bounded to ${setupToken / 1024} KiB`);
  });
});

describe("documented refusals happen where the document says they do", () => {
  test("Windows is refused before any launch work", () => {
    const source = read("src/runner/simple.ts");
    const platformCheck = source.indexOf('process.platform === "win32"');
    expect(platformCheck).toBeGreaterThan(-1);
    // "returns UNSUPPORTED_PLATFORM before launch" is a claim about ORDER, so
    // assert the order: nothing that resolves or starts a backend may precede it.
    expect(source.indexOf("getBackendDefinition(")).toBeGreaterThan(platformCheck);
    states(SECURITY, "SECURITY.md", "Windows returns `UNSUPPORTED_PLATFORM` before launch");
  });

  test("the observer credential reaches only ping and observer routes", () => {
    const source = read("src/daemon/server.ts");
    expect(source).toContain('credential.kind === "observer" && request.method !== "ping" && !request.method.startsWith("observer.")');
    states(SECURITY, "SECURITY.md", "limited to `ping` and `observer.*`");
  });
});
