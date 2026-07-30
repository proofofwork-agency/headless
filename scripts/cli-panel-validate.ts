#!/usr/bin/env bun
/**
 * Validate golden-path CLI surface (help, setup, doctor panel, exec next, verify)
 * using the same disposable roots as ttfv-smoke. Prefer this over ad-hoc /tmp paths
 * that some host Codex configs reject.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const cli = resolve(root, "dist/cli.js");
const work = mkdtempSync(join(tmpdir(), "headless-cli-panel-"));
const project = join(work, "project");
const stateHome = join(work, "state");
const runtimeHome = mkdtempSync(join("/tmp", "hpanel-"));
mkdirSync(project, { recursive: true });
writeFileSync(join(project, "README.md"), "# CLI panel validation\n");

const env = {
  ...process.env,
  HEADLESS_STATE_HOME: stateHome,
  HEADLESS_RUNTIME_HOME: runtimeHome,
  XDG_RUNTIME_DIR: runtimeHome,
  // Force native-login path: no broker API keys available to the child.
  OPENAI_API_KEY: "",
  ANTHROPIC_API_KEY: "",
  GEMINI_API_KEY: "",
  GOOGLE_API_KEY: "",
  XAI_API_KEY: "",
};

const checks: Array<{ id: string; ok: boolean; detail: string }> = [];

async function run(args: string[], timeoutMs = 120_000) {
  const child = Bun.spawn(["bun", cli, ...args], { cwd: project, env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  return { stdout, stderr, exitCode: exitCode ?? 1 };
}

function check(id: string, ok: boolean, detail: string) {
  checks.push({ id, ok, detail });
  console.error(`${ok ? "PASS" : "FAIL"} ${id}: ${detail}`);
}

if (!(await Bun.file(cli).exists())) {
  console.error("dist/cli.js missing — run bun run build");
  process.exit(1);
}

const help = await run(["--help"], 10_000);
check("help.golden", help.stdout.includes("Golden path:") && help.stdout.includes("setup"), "banner + setup in default help");

const setup = await run(["setup", "--yes", "--allow-native-direct-unrestricted", "--cwd", project], 60_000);
check("setup.exit", setup.exitCode === 0, `exit ${setup.exitCode}`);
check("setup.inventory", /capsule ok|capsule missing/.test(setup.stdout), "backend capsule inventory lines");
check("setup.doctor_hint", setup.stdout.includes("doctor --json"), "points at doctor panel");

const doctorHuman = await run(["doctor", "--cwd", project], 30_000);
check("doctor.banner", doctorHuman.stdout.includes("headless doctor — v0.2"), "human panel banner");
check("doctor.trust", doctorHuman.stdout.includes("Trust:"), "trust ladder line");
check("doctor.next", doctorHuman.stdout.includes("Next actions:"), "next actions section");

const doctorJson = await run(["doctor", "--json", "--cwd", project], 30_000);
let report: {
  version?: string;
  readyForNativeExec?: boolean;
  recommendedBackend?: string | null;
  nextActions?: Array<{ id: string; command: string }>;
  backends?: unknown[];
};
try {
  report = JSON.parse(doctorJson.stdout);
  check("doctor.json", doctorJson.exitCode === 0 && report.version === "product-readiness-1", "schema version");
  check("doctor.ready", report.readyForNativeExec === true, `readyForNativeExec=${report.readyForNativeExec}`);
  check("doctor.nextActions", Array.isArray(report.nextActions) && (report.nextActions?.length ?? 0) > 0, `count=${report.nextActions?.length}`);
} catch (error) {
  check("doctor.json", false, String(error));
  report = {};
}

const backend = report.recommendedBackend || "codex";
// Explicit native-login (subscription capsules), not broker API keys.
const exec = await run([
  "exec",
  "--backend", String(backend),
  "--auth-mode", "native-login",
  "--mode", "read-only",
  "--profile", "read-only-native",
  "--timeout-ms", "120000",
  "--json",
  "--cwd", project,
  "--",
  "Reply with exactly: PANEL_OK",
], 180_000);

let execBody: {
  status?: string;
  next?: { verify?: string; receipt?: string };
  jobId?: string | null;
  containment?: { network?: string; credentialAccess?: string; enforced?: boolean };
} = {};
try {
  execBody = JSON.parse(exec.stdout);
  check("exec.json", Boolean(exec.stdout.trim()), "json body");
  check("exec.next", Boolean(execBody.next?.verify && execBody.next?.receipt), `next=${JSON.stringify(execBody.next)}`);
  check("exec.jobId", Boolean(execBody.jobId), `jobId=${execBody.jobId}`);
  check("exec.succeeded", execBody.status === "succeeded", `status=${execBody.status}`);
  check(
    "exec.native-login",
    execBody.containment?.network === "native-direct-unrestricted"
      && execBody.containment?.credentialAccess === "backend-native"
      && execBody.containment?.enforced === true,
    `network=${execBody.containment?.network} creds=${execBody.containment?.credentialAccess} enforced=${execBody.containment?.enforced}`,
  );
} catch (error) {
  check("exec.json", false, `${error}; stderr=${exec.stderr.slice(0, 200)}`);
}

const verify = await run(["verify", "--cwd", project], 30_000);
check("verify.exit", verify.exitCode === 0 || verify.stdout.includes("intact") || verify.stderr.includes("intact") || verify.stdout.length > 0, `exit ${verify.exitCode}`);

const failed = checks.filter((c) => !c.ok);
const summary = {
  ok: failed.length === 0,
  project,
  backend,
  checks,
  failed: failed.map((c) => c.id),
};
console.log(JSON.stringify(summary, null, 2));
process.exit(failed.length ? 1 : 0);
