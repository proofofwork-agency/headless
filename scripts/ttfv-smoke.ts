#!/usr/bin/env bun
/**
 * Golden-path TTFV smoke: setup → trust → doctor --json → exec --profile → verify.
 *
 * Default: dry ceremony (no provider exec) measuring setup+doctor+trust.
 * Opt-in live turn: HEADLESS_TTFV_LIVE=1 runs a real read-only native exec.
 * Soft max wall clock for the full live path: 5 minutes (Product Gate P.TTFV).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const LIVE = process.env.HEADLESS_TTFV_LIVE === "1";
const MAX_LIVE_MS = 5 * 60_000;
const MAX_CEREMONY_MS = 90_000;
const root = resolve(import.meta.dir, "..");
const cli = resolve(root, "dist/cli.js");
const work = mkdtempSync(join(tmpdir(), "headless-ttfv-"));
const project = join(work, "project");
const stateHome = join(work, "state");
const runtimeHome = mkdtempSync(join("/tmp", "httfv-"));

mkdirSync(project, { recursive: true });
mkdirSync(stateHome, { recursive: true });
writeFileSync(join(project, "README.md"), "# TTFV disposable project\n");

const env = {
  ...process.env,
  HEADLESS_STATE_HOME: stateHome,
  HEADLESS_RUNTIME_HOME: runtimeHome,
  XDG_RUNTIME_DIR: runtimeHome,
  // Keep host logins for native; strip broker keys so profile is unambiguous.
  OPENAI_API_KEY: "",
  ANTHROPIC_API_KEY: "",
  GEMINI_API_KEY: "",
  GOOGLE_API_KEY: "",
  XAI_API_KEY: "",
};

type Step = { name: string; durationMs: number; exitCode: number; stdout: string; stderr: string };

const steps: Step[] = [];
const started = Date.now();

async function run(name: string, args: string[], timeoutMs: number) {
  const t0 = Date.now();
  const child = Bun.spawn(["bun", cli, ...args], {
    cwd: project,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  const step = { name, durationMs: Date.now() - t0, exitCode: exitCode ?? 1, stdout, stderr };
  steps.push(step);
  return step;
}

function fail(message: string): never {
  console.error(JSON.stringify({ ok: false, error: message, steps }, null, 2));
  process.exit(1);
}

if (!(await Bun.file(cli).exists())) {
  fail(`Missing ${cli}; run bun run build first.`);
}

const setup = await run("setup", ["setup", "--yes", "--allow-native-direct-unrestricted", "--cwd", project], 60_000);
if (setup.exitCode !== 0) fail(`setup failed: ${setup.stderr || setup.stdout}`);

const doctor = await run("doctor", ["doctor", "--json", "--cwd", project], 30_000);
if (doctor.exitCode !== 0) fail(`doctor --json failed: ${doctor.stderr || doctor.stdout}`);
let report: {
  readyForNativeExec?: boolean;
  recommendedBackend?: string | null;
  nextActions?: Array<{ command: string }>;
  trust?: { nativeReady?: boolean };
};
try {
  report = JSON.parse(doctor.stdout);
} catch {
  fail(`doctor --json did not emit JSON: ${doctor.stdout.slice(0, 400)}`);
}
if (!report.trust || typeof report.readyForNativeExec !== "boolean") {
  fail("doctor report missing readiness fields");
}
if (!Array.isArray(report.nextActions) || report.nextActions.length === 0) {
  fail("doctor report missing nextActions panel");
}

const backend = report.recommendedBackend || "codex";
let execStep: Step | null = null;
let verifyStep: Step | null = null;

if (LIVE) {
  if (!report.readyForNativeExec) {
    fail(`LIVE mode requires readyForNativeExec; doctor said no (backend=${backend})`);
  }
  execStep = await run("exec", [
    "exec",
    "--backend", String(backend),
    "--auth-mode", "native-login",
    "--mode", "read-only",
    "--profile", "read-only-native",
    "--timeout-ms", "120000",
    "--json",
    "--cwd", project,
    "--",
    "Reply with exactly: TTFV_OK",
  ], 180_000);
  if (execStep.exitCode !== 0) fail(`exec failed: ${execStep.stderr || execStep.stdout.slice(0, 800)}`);
  let result: {
    status?: string;
    next?: { verify?: string; receipt?: string };
    jobId?: string | null;
    containment?: { network?: string; credentialAccess?: string; enforced?: boolean };
  };
  try {
    result = JSON.parse(execStep.stdout);
  } catch {
    fail(`exec --json not parseable: ${execStep.stdout.slice(0, 400)}`);
  }
  if (result.status !== "succeeded") fail(`exec status ${result.status}`);
  if (!result.next?.verify || !result.next?.receipt) fail("exec JSON missing next.verify/next.receipt");
  if (result.containment?.network !== "native-direct-unrestricted") {
    fail(`expected native-direct-unrestricted network, got ${result.containment?.network}`);
  }
  if (result.containment?.credentialAccess !== "backend-native") {
    fail(`expected backend-native credentialAccess, got ${result.containment?.credentialAccess}`);
  }
  verifyStep = await run("verify", ["verify", "--json", "--cwd", project], 30_000);
  if (verifyStep.exitCode !== 0) fail(`verify failed: ${verifyStep.stderr || verifyStep.stdout}`);
}

const totalMs = Date.now() - started;
const ceremonyMs = steps.filter((s) => s.name === "setup" || s.name === "doctor").reduce((a, s) => a + s.durationMs, 0);
const budget = LIVE ? MAX_LIVE_MS : MAX_CEREMONY_MS;
const passed = totalMs <= budget;

const evidence = {
  gate: "product-P.TTFV",
  mode: LIVE ? "live" : "ceremony",
  ok: passed,
  totalMs,
  ceremonyMs,
  budgetMs: budget,
  project,
  recommendedBackend: backend,
  readyForNativeExec: report.readyForNativeExec,
  doctorNextActions: report.nextActions?.length ?? 0,
  steps: steps.map((s) => ({ name: s.name, durationMs: s.durationMs, exitCode: s.exitCode })),
  completedAt: new Date().toISOString(),
};

const outPath = resolve(root, "docs/internal/release-evidence/ttfv-smoke.json");
mkdirSync(resolve(root, "docs/internal/release-evidence"), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ ...evidence, evidencePath: outPath }, null, 2));

if (!passed) {
  console.error(`ttfv-smoke exceeded budget ${budget}ms (total ${totalMs}ms)`);
  process.exit(1);
}
console.error(`ttfv-smoke passed (${LIVE ? "live" : "ceremony"}) in ${totalMs}ms`);
