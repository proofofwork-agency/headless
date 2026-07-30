#!/usr/bin/env bun
/**
 * Dual-backend native-login gate (plan workstream C).
 * Requires installed, logged-in Codex and OpenCode CLIs.
 * Uses the proven temp layout: $TMPDIR/headless-…/project + short /tmp runtime.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const cli = resolve(root, "dist/cli.js");
const work = mkdtempSync(join(tmpdir(), "headless-cli-panel-"));
const project = join(work, "project");
const stateHome = join(work, "state");
const runtimeHome = mkdtempSync(join("/tmp", "hdual-"));
mkdirSync(project, { recursive: true });
writeFileSync(join(project, "README.md"), "# dual native-login validation\n");

const env = {
  ...process.env,
  HEADLESS_STATE_HOME: stateHome,
  HEADLESS_RUNTIME_HOME: runtimeHome,
  XDG_RUNTIME_DIR: runtimeHome,
  OPENAI_API_KEY: "",
  ANTHROPIC_API_KEY: "",
  GEMINI_API_KEY: "",
  GOOGLE_API_KEY: "",
  XAI_API_KEY: "",
};

const backends = ["codex", "opencode"] as const;
const checks: Array<{ id: string; ok: boolean; detail: string }> = [];

function check(id: string, ok: boolean, detail: string) {
  checks.push({ id, ok, detail });
  console.error(`${ok ? "PASS" : "FAIL"} ${id}: ${detail}`);
}

async function run(args: string[], timeoutMs = 180_000) {
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

if (!(await Bun.file(cli).exists())) {
  console.error("dist/cli.js missing — run bun run build");
  process.exit(1);
}

const setup = await run(["setup", "--yes", "--allow-native-direct-unrestricted", "--cwd", project], 60_000);
check("setup", setup.exitCode === 0, `exit ${setup.exitCode}`);

for (const backend of backends) {
  const result = await run([
    "exec",
    "--backend", backend,
    "--auth-mode", "native-login",
    "--mode", "read-only",
    "--profile", "read-only-native",
    "--timeout-ms", "180000",
    "--json",
    "--cwd", project,
    "--",
    `Reply with exactly: DUAL_${backend.toUpperCase()}_OK`,
  ], 200_000);
  try {
    const body = JSON.parse(result.stdout) as {
      status?: string;
      containment?: { network?: string; credentialAccess?: string; enforced?: boolean };
      error?: { message?: string };
      output?: string;
    };
    check(`${backend}.status`, body.status === "succeeded", `status=${body.status} err=${body.error?.message ?? ""}`);
    check(
      `${backend}.native-login`,
      body.containment?.network === "native-direct-unrestricted"
        && body.containment?.credentialAccess === "backend-native"
        && body.containment?.enforced === true,
      `net=${body.containment?.network} cred=${body.containment?.credentialAccess} enforced=${body.containment?.enforced}`,
    );
  } catch (error) {
    check(`${backend}.json`, false, `${error}; ${result.stdout.slice(0, 200)} ${result.stderr.slice(0, 200)}`);
  }
}

const failed = checks.filter((entry) => !entry.ok);
console.log(JSON.stringify({
  ok: failed.length === 0,
  project,
  backends: [...backends],
  checks,
  failed: failed.map((entry) => entry.id),
}, null, 2));
process.exit(failed.length ? 1 : 0);
