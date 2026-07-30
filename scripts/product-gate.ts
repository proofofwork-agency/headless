#!/usr/bin/env bun
/**
 * Product Gate P — automated weak-point oracle.
 * See docs/product-gate.md. Manual dogfood checks are reported as `manual`.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { STABLE_COMMAND_NAMES, stableHelpCommandCount, renderHelp } from "../src/cli/command-specs";
import { PRODUCT_GATE_REMEDY_CODES, remedyForCode } from "../src/cli/remedy";
import { EXEC_PROFILES } from "../src/cli/profile";
import { printRunResult } from "../src/cli/shared";
import type { RunResult } from "../src/contracts/run";

const root = resolve(import.meta.dir, "..");

type CheckStatus = "pass" | "fail" | "manual";
type Check = { id: string; status: CheckStatus; detail: string };

const checks: Check[] = [];

function record(id: string, status: CheckStatus, detail: string) {
  checks.push({ id, status, detail });
}

// P.HELP
{
  const count = stableHelpCommandCount();
  const help = renderHelp(false);
  const experimentalLeak = /experimental (?:fleet|goal|workflow|council|session)/i.test(help)
    && !help.includes("Run `headless experimental --help`");
  if (count > 12) record("P.HELP", "fail", `stable help has ${count} commands (max 12)`);
  else if (experimentalLeak) record("P.HELP", "fail", "default help appears to list experimental command bodies");
  else if (!help.includes("Golden path:")) record("P.HELP", "fail", "default help missing golden path banner");
  else record("P.HELP", "pass", `${count} stable commands (≤ 12)`);
}

// P.SCOPE
{
  const required = ["exec", "setup", "doctor", "verify", "tui", "project", "init", "lead", "daemon", "mcp", "status"];
  const missing = required.filter((name) => !STABLE_COMMAND_NAMES.has(name));
  if (missing.length) record("P.SCOPE", "fail", `missing stable commands: ${missing.join(", ")}`);
  else record("P.SCOPE", "pass", `stable set size ${STABLE_COMMAND_NAMES.size}`);
}

// P.REMEDY
{
  const missing = PRODUCT_GATE_REMEDY_CODES.filter((code) => !remedyForCode(code, "/tmp/project")?.command);
  if (missing.length) record("P.REMEDY", "fail", `missing remedies: ${missing.join(", ")}`);
  else record("P.REMEDY", "pass", `${PRODUCT_GATE_REMEDY_CODES.length} codes covered`);
}

// P.AHA — printRunResult emits verify/receipt lines when jobId present
{
  const chunks: string[] = [];
  const originalErr = console.error;
  console.error = (...args: unknown[]) => { chunks.push(args.map(String).join(" ")); };
  try {
    const result = sampleSucceededResult();
    printRunResult(result, false, false, { cwd: "/tmp/demo" });
  } finally {
    console.error = originalErr;
  }
  const text = chunks.join("\n");
  if (!text.includes("headless verify") || !text.includes("receipt show")) {
    record("P.AHA", "fail", "printRunResult missing verify/receipt aha lines");
  } else record("P.AHA", "pass", "verify + receipt lines present for jobId results");
}

// P.GOLDEN — profile + setup contract files exist
{
  if (!EXEC_PROFILES["read-only-native"] || !EXEC_PROFILES["broker-readonly"]) {
    record("P.GOLDEN", "fail", "expected exec profiles missing");
  } else if (!existsSync(resolve(root, "src/cli/commands/lifecycle.ts"))) {
    record("P.GOLDEN", "fail", "lifecycle/setup source missing");
  } else {
    const lifecycle = readFileSync(resolve(root, "src/cli/commands/lifecycle.ts"), "utf8");
    if (!lifecycle.includes("runSetupCommand")) record("P.GOLDEN", "fail", "runSetupCommand missing");
    else record("P.GOLDEN", "pass", "setup + profiles present");
  }
}

// P.DOCS
{
  const readme = readFileSync(resolve(root, "README.md"), "utf8");
  const quickstart = existsSync(resolve(root, "website/docs/getting-started/quickstart.md"))
    ? readFileSync(resolve(root, "website/docs/getting-started/quickstart.md"), "utf8")
    : "";
  const hasGolden = /headless setup|--profile read-only-native|Golden path/i.test(readme)
    && /setup|--profile read-only-native/i.test(quickstart);
  if (!hasGolden) record("P.DOCS", "fail", "README/quickstart missing one-path golden flow");
  else record("P.DOCS", "pass", "README + quickstart mention setup/profile path");
}

// P.TUI
{
  const model = readFileSync(resolve(root, "src/tui/model.ts"), "utf8");
  if (!model.includes("authorityLadder") || !model.includes("native-consent") || !model.includes("first-exec")) {
    record("P.TUI", "fail", "nextActions/authority ladder incomplete");
  } else record("P.TUI", "pass", "authority ladder + native consent + first-exec guidance present");
}

// P.STEPS — ceremony contract is encoded in setup output (≤ 4 decisions)
{
  const lifecycle = readFileSync(resolve(root, "src/cli/commands/lifecycle.ts"), "utf8");
  if (!lifecycle.includes("≤ 4 decisions") || !lifecycle.includes("--auth-mode native-login") || !lifecycle.includes("--profile read-only-native")) {
    record("P.STEPS", "fail", "setup wizard does not encode ≤ 4 decision native-login golden path");
  } else record("P.STEPS", "pass", "setup wizard prints ≤ 4 decision native-login golden path");
}

// P.TTFV — ceremony evidence from scripts/ttfv-smoke.ts; live optional
{
  const evidencePath = resolve(root, "docs/internal/release-evidence/ttfv-smoke.json");
  if (!existsSync(evidencePath)) {
    record("P.TTFV", "manual", "No ttfv-smoke.json yet — run bun scripts/ttfv-smoke.ts (or HEADLESS_TTFV_LIVE=1)");
  } else {
    try {
      const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as {
        ok?: boolean;
        mode?: string;
        totalMs?: number;
        budgetMs?: number;
      };
      if (evidence.ok && typeof evidence.totalMs === "number" && evidence.totalMs <= (evidence.budgetMs ?? 300_000)) {
        record("P.TTFV", "pass", `${evidence.mode ?? "smoke"} evidence totalMs=${evidence.totalMs} ≤ ${evidence.budgetMs}`);
      } else {
        record("P.TTFV", "fail", `ttfv-smoke evidence not ok: ${JSON.stringify(evidence)}`);
      }
    } catch (error) {
      record("P.TTFV", "fail", `invalid ttfv-smoke.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// P.KERNEL — existence of check script; full suite is CI's job
{
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  if (!pkg.scripts?.check) record("P.KERNEL", "fail", "package.json missing check script");
  else record("P.KERNEL", "pass", "check script present (run bun run check for full kernel gate)");
}

const failed = checks.filter((check) => check.status === "fail");
const passed = checks.filter((check) => check.status === "pass");
const manual = checks.filter((check) => check.status === "manual");

const report = {
  gate: "product-P",
  passed: failed.length === 0,
  summary: { pass: passed.length, fail: failed.length, manual: manual.length },
  checks,
};

console.log(JSON.stringify(report, null, 2));
if (failed.length) {
  console.error(`product-gate: ${failed.length} failing check(s): ${failed.map((c) => c.id).join(", ")}`);
  process.exit(1);
}
console.error(`product-gate: ${passed.length} pass, ${manual.length} manual, 0 fail`);

function sampleSucceededResult(): RunResult {
  return {
    status: "succeeded",
    error: null,
    backend: "opencode",
    output: "ok",
    stderr: "",
    diagnostics: { format: "test", malformedEvents: 0, ignoredEvents: 0, messages: [] },
    exitCode: 0,
    signal: null,
    usage: { input: 1, output: 1, reasoning: null, cached: null, providerTotal: 2 },
    cost: { amountUsd: null, source: "unknown", pricingId: null, observedRequests: 0 },
    containment: {
      requirement: "required",
      enforced: true,
      platform: "darwin",
      mechanism: "seatbelt",
      probe: "ok",
      isolatedHome: true,
      credentialsIsolated: true,
      network: "native-direct-unrestricted",
      credentialAccess: "backend-native",
      unsafe: false,
    },
    durationMs: 10,
    sessionId: null,
    jobId: "job_demo_1",
    diff: null,
    commit: null,
  } as RunResult;
}
