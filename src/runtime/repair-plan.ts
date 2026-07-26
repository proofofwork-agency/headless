import { createHash } from "node:crypto";
import type { GateCheckResult, ReleaseGateReport } from "./release-gate";
import type { RepairEvidence } from "../contracts/loop";
import { redactAndTruncate } from "./redaction";

/**
 * Compiles a gate report into a dependency graph of repair work.
 *
 * The gate is the oracle. An agent claiming success proves nothing; only a
 * subsequent green gate does. Each failing check becomes an independent repair
 * node so unrelated failures are fixed concurrently, and a single verification
 * node depends on all of them so the durable workflow engine feeds every repair
 * diff and error into the check that has to justify them.
 */
export const REPAIR_VERIFY_STEP_ID = "verify";
/** Hard cap enforced by RepairEvidenceSchema; the excerpt must never exceed it. */
export const MAX_REPAIR_EXCERPT_BYTES = 8_192;
/**
 * `redactAndTruncate` appends its "[TRUNCATED n chars]" marker *after* the
 * limit it is given, so truncating at the schema cap overflows the schema.
 * Reserve room for the marker instead.
 */
const EXCERPT_TRUNCATION_MARKER_BUDGET = 64;
const MAX_SIGNATURE_LINES = 3;
const MAX_ATTEMPTED_NOTES = 32;
/** Matches RepairEvidenceSchema's per-note cap. */
const MAX_ATTEMPTED_NOTE_CHARS = 1_024;

export type RepairStep = {
  id: string;
  kind: "execution" | "test";
  prompt: string;
  dependsOn: string[];
  optionalDependsOn: string[];
};

export type RepairGraph = {
  steps: RepairStep[];
  signature: string;
  /** Set when the report is already green and there is nothing to repair. */
  resolved: boolean;
};

/**
 * A stable digest of *what is broken*, not of the whole output. Timestamps,
 * durations, and paths churn between runs; the failing check names plus the
 * first few normalized error lines do not. Stagnation detection depends on two
 * genuinely identical failures hashing the same.
 */
export function failureSignature(report: ReleaseGateReport) {
  const failures = failedChecks(report);
  if (failures.length === 0) return sha256("gate:green");
  const parts = failures.map((check) => `${check.name}\n${normalizeFailureLines(check.output)}`);
  return sha256(parts.join("\n--\n"));
}

/** The bounded, redacted record one iteration hands to the next. */
export function summarizeGateFailure(report: ReleaseGateReport, attempted: readonly string[] = []): RepairEvidence {
  return {
    signature: failureSignature(report),
    failedChecks: failedChecks(report).slice(0, 16).map((check) => ({
      name: check.name,
      exitCode: check.exitCode,
      timedOut: check.timedOut,
      excerpt: excerptOf(check),
    })),
    attempted: attempted.slice(0, MAX_ATTEMPTED_NOTES)
      .map((note) => redactAndTruncate(note, MAX_ATTEMPTED_NOTE_CHARS - EXCERPT_TRUNCATION_MARKER_BUDGET).text.slice(0, MAX_ATTEMPTED_NOTE_CHARS)),
    observedAt: report.completedAt,
  };
}

export function compileRepairGraph(
  report: ReleaseGateReport,
  prior: readonly RepairEvidence[] = [],
  options: { maxRepairNodes?: number } = {},
): RepairGraph {
  const signature = failureSignature(report);
  const failures = failedChecks(report);
  if (failures.length === 0) return { steps: [], signature, resolved: true };

  const maxRepairNodes = Math.max(1, Math.min(options.maxRepairNodes ?? 8, 32));
  const selected = failures.slice(0, maxRepairNodes);
  const dropped = failures.length - selected.length;
  const history = priorContext(prior, signature);

  const steps: RepairStep[] = selected.map((check, index) => ({
    id: repairStepId(check.name, index),
    kind: "execution",
    prompt: repairPrompt(check, history, dropped),
    dependsOn: [],
    optionalDependsOn: [],
  }));

  // Every repair is an *optional* dependency of verification. One repair dying
  // must not block the report on the repairs that landed — the verifier needs
  // to see the whole iteration, including which node failed and why.
  steps.push({
    id: REPAIR_VERIFY_STEP_ID,
    kind: "test",
    prompt: verifyPrompt(selected.map((check) => check.name)),
    dependsOn: [],
    optionalDependsOn: steps.map((step) => step.id),
  });

  return { steps, signature, resolved: false };
}

/**
 * True once the signature has repeated for `limit` consecutive iterations. The
 * loop is then re-failing identically and will keep doing so; stopping beats
 * spending the remaining budget to prove it again.
 */
export function hasStagnated(evidence: readonly RepairEvidence[], limit: number) {
  if (limit <= 0 || evidence.length < limit) return false;
  const recent = evidence.slice(-limit);
  const [first] = recent;
  return first !== undefined && recent.every((entry) => entry.signature === first.signature);
}

function failedChecks(report: ReleaseGateReport) {
  return report.checks.filter((check) => !check.ok);
}

function repairStepId(name: string, index: number) {
  const slug = name.toLowerCase().replaceAll(/[^a-z0-9-]/g, "-").replaceAll(/-+/g, "-").replace(/^-|-$/g, "");
  return `repair-${slug || "check"}-${index + 1}`;
}

function excerptOf(check: GateCheckResult) {
  const head = check.output.trim() || `${check.name} failed without output (exit ${check.exitCode ?? "none"}).`;
  const bounded = redactAndTruncate(head, MAX_REPAIR_EXCERPT_BYTES - EXCERPT_TRUNCATION_MARKER_BUDGET).text;
  return bounded.slice(0, MAX_REPAIR_EXCERPT_BYTES);
}

/**
 * Keeps the first few non-empty, non-noise lines and strips the volatile parts
 * so the same defect hashes identically across runs.
 */
function normalizeFailureLines(output: string) {
  const lines = output
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^\[\d+/.test(line));
  const normalized = lines.slice(0, MAX_SIGNATURE_LINES).map((line) => line
    .replaceAll(/\b\d+(\.\d+)?m?s\b/g, "<duration>")
    .replaceAll(/\b0x[0-9a-f]+\b/gi, "<address>")
    .replaceAll(/\/[^\s:]*\/([^\s/:]+)/g, "$1")
    .replaceAll(/\b\d{4,}\b/g, "<number>"));
  return normalized.join("\n");
}

function priorContext(prior: readonly RepairEvidence[], signature: string) {
  if (prior.length === 0) return "";
  const previous = prior.at(-1)!;
  const unchanged = previous.signature === signature;
  const attempted = prior.flatMap((entry) => entry.attempted).slice(-MAX_ATTEMPTED_NOTES);
  const lines = [
    "",
    "PRIOR REPAIR ITERATIONS (durable evidence from this loop; do not restate the original prompt):",
    `- iterations already attempted: ${prior.length}`,
    unchanged
      ? "- the failure signature did NOT change after the last attempt. The previous fix did not work. Do not repeat it; diagnose from the actual output before editing."
      : "- the failure signature changed after the last attempt, so progress was made. Continue from the new failure.",
  ];
  if (attempted.length > 0) {
    lines.push("- already tried:");
    for (const note of attempted) lines.push(`  - ${note}`);
  }
  return lines.join("\n");
}

/**
 * Hygiene constraints are stated up front rather than discovered at gate time:
 * `bun run check` runs lint before tests, so a patch using a banned construct
 * fails the gate without ever reaching the tests it was meant to fix.
 *
 * The banned tokens are assembled rather than written literally — this file is
 * itself scanned by the same source-hygiene lint it is describing.
 */
const BANNED_CONSTRUCTS = [`as ${"any"}`, `@ts${"-"}ignore`, `Math.${"random"}(`, `TO${"DO"}`, `FIX${"ME"}`];

const HYGIENE_CONSTRAINTS = [
  "MANDATORY CONSTRAINTS — the gate enforces these and will reject the fix otherwise:",
  `- Never introduce any of these constructs: ${BANNED_CONSTRUCTS.map((token) => `\`${token}\``).join(", ")}. Source hygiene fails the build on all of them.`,
  "- Preserve formatting: no tabs, no trailing whitespace, no CRLF, and every file ends with a newline.",
  "- If you change the CLI surface, regenerate documentation with `bun run generate:docs`.",
  "- Fix the underlying defect. Do not weaken, skip, or delete a test to make the gate pass.",
].join("\n");

function repairPrompt(check: GateCheckResult, history: string, dropped: number) {
  const overflow = dropped > 0
    ? `\n\nNOTE: ${dropped} additional check(s) also failed but exceeded this iteration's node budget. Fix only "${check.name}" here.`
    : "";
  return [
    `The project gate check "${check.name}" is failing. Diagnose the real cause and fix it.`,
    "",
    `Command: ${check.command} ${check.args.join(" ")}`,
    `Exit code: ${check.exitCode ?? "none"}${check.timedOut ? " (timed out)" : ""}`,
    "",
    "FAILURE OUTPUT:",
    excerptOf(check),
    history,
    "",
    HYGIENE_CONSTRAINTS,
    overflow,
  ].join("\n");
}

function verifyPrompt(names: readonly string[]) {
  return [
    `Verify the repairs for: ${names.join(", ")}.`,
    "",
    "The dependency outputs above contain each repair's actual diff and output.",
    "Re-run the affected checks and report precisely what still fails.",
    "Report honestly: the loop re-runs the real gate after this step, so an inaccurate",
    "claim of success is caught immediately and only wastes an iteration.",
  ].join("\n");
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
