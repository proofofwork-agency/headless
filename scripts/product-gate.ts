#!/usr/bin/env bun
/**
 * Product Gate P — automated weak-point oracle.
 * See docs/product-gate.md. Manual dogfood checks are reported as `manual`.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { STABLE_COMMAND_NAMES, stableHelpCommandCount, renderHelp } from "../src/cli/command-specs";
import { PRODUCT_GATE_REMEDY_CODES, remedyForCode } from "../src/cli/remedy";
import { EXEC_PROFILES } from "../src/cli/profile";
import { printRunResult } from "../src/cli/shared";
import type { RunResult } from "../src/contracts/run";
import { ReleaseEvidenceProvenanceSchema } from "../src/runtime/release-evidence-anchor";
import { HEADLESS_VERSION } from "../src/version";

const root = resolve(import.meta.dir, "..");
const MAX_LIVE_TTFV_MS = 5 * 60_000;
const EXPECTED_LIVE_STEPS = ["setup", "doctor", "exec", "verify"] as const;
const TtfvEvidenceSchema = z.object({
  version: z.literal(1),
  gate: z.literal("product-P.TTFV"),
  mode: z.enum(["live", "ceremony"]),
  ok: z.boolean(),
  releaseGatePassed: z.boolean(),
  totalMs: z.number().int().nonnegative(),
  ceremonyMs: z.number().int().nonnegative(),
  budgetMs: z.number().int().positive(),
  project: z.string().min(1),
  recommendedBackend: z.string().nullable(),
  readyForNativeExec: z.boolean(),
  doctorNextActions: z.number().int().nonnegative(),
  modelOutputVerified: z.boolean(),
  containmentVerified: z.boolean(),
  expectedOutput: z.string().nullable(),
  failure: z.string().nullable(),
  steps: z.array(z.object({
    name: z.string(),
    durationMs: z.number().int().nonnegative(),
    exitCode: z.number().int(),
    timedOut: z.boolean(),
  }).strict()).max(8),
  completedAt: z.string().datetime(),
  provenance: ReleaseEvidenceProvenanceSchema,
}).strict();

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
  const originalOut = console.log;
  console.error = (...args: unknown[]) => { chunks.push(args.map(String).join(" ")); };
  console.log = () => {};
  try {
    const result = sampleSucceededResult();
    printRunResult(result, false, false, { cwd: "/tmp/demo" });
  } finally {
    console.error = originalErr;
    console.log = originalOut;
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

// P.TTFV — only current-commit live evidence with exact output can pass.
{
  const evidencePath = resolve(root, "docs/internal/release-evidence/ttfv-smoke.json");
  if (!existsSync(evidencePath)) {
    record("P.TTFV", "manual", "No live evidence — run bun run smoke:ttfv:live on an explicitly authorized host");
  } else {
    try {
      const raw = JSON.parse(readFileSync(evidencePath, "utf8")) as Record<string, unknown>;
      if (raw.version === undefined) {
        record("P.TTFV", "manual", "Legacy evidence lacks strict provenance/output fields; rerun bun run smoke:ttfv:live");
      } else {
        const parsed = TtfvEvidenceSchema.safeParse(raw);
        if (!parsed.success) {
          record("P.TTFV", "fail", `strict TTFV evidence is malformed: ${parsed.error.issues[0]?.message ?? "invalid"}`);
        } else {
          const evidence = parsed.data;
          const currentCommit = repositoryCommit();
          const stepNames = evidence.steps.map((step) => step.name);
          const stepsValid = stepNames.join("\0") === EXPECTED_LIVE_STEPS.join("\0")
            && evidence.steps.every((step) => step.exitCode === 0 && !step.timedOut);
          if (evidence.mode !== "live") {
            record("P.TTFV", "manual", "Ceremony evidence measures the warm path only; run bun run smoke:ttfv:live");
          } else if (!currentCommit || evidence.provenance.commit !== currentCommit) {
            record("P.TTFV", "manual", `Live evidence is stale for HEAD ${currentCommit ?? "unknown"}; rerun the live smoke`);
          } else if (
            !evidence.ok
            || !evidence.releaseGatePassed
            || evidence.failure !== null
            || evidence.totalMs > MAX_LIVE_TTFV_MS
            || evidence.budgetMs !== MAX_LIVE_TTFV_MS
            || evidence.expectedOutput !== "TTFV_OK"
            || !evidence.modelOutputVerified
            || !evidence.containmentVerified
            || !stepsValid
            || evidence.provenance.headlessVersion !== HEADLESS_VERSION
          ) {
            record("P.TTFV", "fail", "Live evidence failed its fixed budget, exact-output, containment, step, or provenance contract");
          } else {
            record("P.TTFV", "pass", `current live evidence totalMs=${evidence.totalMs} ≤ ${MAX_LIVE_TTFV_MS}`);
          }
        }
      }
    } catch (error) {
      record("P.TTFV", "fail", `invalid ttfv-smoke.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// P.KERNEL — only the outer aggregate check may assert that its prior stages passed.
{
  if (process.env.HEADLESS_PRODUCT_KERNEL_VERIFIED === "1") {
    record("P.KERNEL", "pass", "outer bun run check completed daemon hygiene, static checks, docs, and tests before Product Gate");
  } else {
    record("P.KERNEL", "manual", "This script cannot self-certify the aggregate kernel gate; run bun run check");
  }
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

function repositoryCommit() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 16_384,
  });
  const value = result.status === 0 ? result.stdout.trim().toLowerCase() : "";
  return /^[a-f0-9]{40,64}$/.test(value) ? value : null;
}
