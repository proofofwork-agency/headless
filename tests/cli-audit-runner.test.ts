import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { COMMAND_SPECS } from "../src/cli";
import { runGitStrict } from "../src/runtime/git";
import { stopTrackedDaemons, trackDaemonProjectRoot } from "./support/daemon-teardown";

// Every audit row runs the real CLI, and each one bootstraps a detached daemon
// for the disposable checkout. Drain them or the suite leaks one per run.
afterAll(async () => { await stopTrackedDaemons(); });

const cliPath = process.env.HEADLESS_AUDIT_CLI
  ? resolve(process.env.HEADLESS_AUDIT_CLI)
  : new URL("../src/cli.ts", import.meta.url).pathname;

type AuditResult = {
  id: string;
  command: string;
  status: "PASS" | "FAIL" | "EXPECTED_REJECTION";
  exitCode: number;
  stdout: string;
  stderr: string;
};

/**
 * Black-box smoke rows which are safe to run in CI. Every invocation receives
 * isolated HOME/state/runtime roots; no existing daemon or provider config is
 * consulted. Stateful/provider rows remain in the manifest for a later lane.
 */
export async function runIsolatedCliAudit(): Promise<AuditResult[]> {
  const root = mkdtempSync(join(tmpdir(), "headless-cli-audit-"));
  const project = trackDaemonProjectRoot(join(root, "project"));
  const state = join(root, "state");
  const home = join(root, "home");
  const runtime = `/tmp/hr-${process.pid}-${Date.now().toString(36).slice(-4)}`;
  const bin = join(root, "bin");
  for (const dir of [project, state, home, bin]) mkdirSync(dir, { recursive: true });
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(project, "marker.txt"), "audit\n");
  writeFileSync(join(project, "package.json"), JSON.stringify({
    scripts: {
      check: "bun -e 'process.exit(0)'",
      build: "bun -e 'process.exit(0)'",
    },
  }));
  requireGitSuccess(runGitStrict(["init", "-b", "main"], project), "initialize audit repository");
  requireGitSuccess(runGitStrict(["add", "--all"], project), "stage audit fixture");
  requireGitSuccess(runGitStrict([
    "-c", "user.name=Headless CLI Audit", "-c", "user.email=audit@example.test",
    "commit", "--no-gpg-sign", "-m", "audit fixture",
  ], project), "commit audit fixture");
  const fleetFile = join(root, "fleet.json");
  writeFileSync(fleetFile, JSON.stringify({
    id: "audit-fleet",
    name: "Audit fleet",
    agents: [{ id: "audit-worker", backend: "codex", name: "Audit worker" }],
  }));
  const fleetRoundTripFile = join(root, "fleet-roundtrip.json");
  writeFileSync(fleetRoundTripFile, JSON.stringify({
    id: "audit-fleet",
    projectId: "server-owned-project",
    name: "Audit fleet",
    authMode: "broker",
    approvalPolicy: "ask",
    agents: [{
      id: "audit-worker", backend: "codex", name: "Audit worker",
      authMode: "broker", approvalPolicy: "ask", createdAt: 10, updatedAt: 20,
    }],
    active: true,
    createdAt: 10,
    updatedAt: 20,
  }));
  const invalidFleetFile = join(root, "fleet-invalid.json");
  writeFileSync(invalidFleetFile, JSON.stringify({
    id: "audit-invalid",
    name: "Invalid fleet",
    agents: [{ id: "audit-worker", backend: "codex", name: "Audit worker" }],
    unexpected: true,
  }));
  const fakeMcp = join(bin, "mcp-host");
  writeFileSync(fakeMcp, "#!/usr/bin/env bun\nconsole.log(JSON.stringify({ok:true}));\n");
  chmodSync(fakeMcp, 0o700);
  installFakeBackends(bin);
  const inherited = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  for (const credential of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "XAI_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ]) delete inherited[credential];
  const env = {
    ...inherited,
    HOME: home,
    HEADLESS_STATE_HOME: state,
    XDG_RUNTIME_DIR: runtime,
    HEADLESS_RUNTIME_HOME: runtime,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HEADLESS_AUDIT_CWD: project,
  };
  const cases: Array<{ id: string; command: string; args: string[]; expected: AuditResult["status"]; expectedError?: string }> = [
    { id: "help", command: "help", args: ["--help"], expected: "PASS" },
    { id: "version", command: "version", args: ["--version"], expected: "PASS" },
    { id: "unknown", command: "unknown", args: ["definitely-not-a-command"], expected: "EXPECTED_REJECTION" },
    { id: "exec:conflicting-containment", command: "exec", args: ["exec", "--require-sandbox", "--unsafe-no-sandbox", "prompt"], expected: "EXPECTED_REJECTION", expectedError: "Choose either --require-sandbox or --unsafe-no-sandbox" },
    { id: "launch:legacy", command: "launch", args: ["experimental", "launch", "opencode-serve"], expected: "EXPECTED_REJECTION" },
    { id: "init", command: "init", args: ["init", "--cwd", project], expected: "PASS" },
    { id: "daemon:status", command: "daemon", args: ["daemon", "status", "--cwd", project], expected: "PASS" },
    { id: "lead:status", command: "lead", args: ["lead", "status", "--cwd", project], expected: "PASS" },
    { id: "doctor", command: "doctor", args: ["doctor", "--cwd", project], expected: "PASS" },
    { id: "status", command: "status", args: ["status", "--cwd", project], expected: "PASS" },
    { id: "tui:help", command: "tui", args: ["tui", "--help"], expected: "PASS" },
    { id: "events", command: "events", args: ["experimental", "events", "--cwd", project], expected: "PASS" },
    { id: "project:trust-status", command: "project", args: ["project", "trust", "status", "--cwd", project], expected: "PASS" },
    { id: "project:trust-grant", command: "project", args: ["project", "trust", "grant", "--allow-bypass", "--cwd", project], expected: "PASS" },
    { id: "fleet:profile-upsert", command: "fleet", args: ["experimental", "fleet", "profile", "upsert", "--file", fleetFile, "--cwd", project], expected: "PASS" },
    { id: "fleet:profile-roundtrip", command: "fleet", args: ["experimental", "fleet", "profile", "upsert", "--file", fleetRoundTripFile, "--cwd", project], expected: "PASS" },
    { id: "fleet:profile-partial", command: "fleet", args: ["experimental", "fleet", "profile", "upsert", "--auth-mode", "native-login", "--approval-policy", "auto", "--cwd", project], expected: "PASS" },
    { id: "fleet:invalid-structured", command: "fleet", args: ["experimental", "fleet", "profile", "upsert", "--file", invalidFleetFile, "--cwd", project, "--json"], expected: "EXPECTED_REJECTION", expectedError: "Invalid request:" },
    { id: "fleet:profile-list", command: "fleet", args: ["experimental", "fleet", "profile", "list", "--cwd", project], expected: "PASS" },
    { id: "goal:list", command: "goal", args: ["experimental", "goal", "list", "--cwd", project], expected: "PASS" },
    { id: "collaboration:missing-goal", command: "collaboration", args: ["experimental", "collaboration", "turns", "--cwd", project], expected: "EXPECTED_REJECTION" },
    { id: "approval:list", command: "approval", args: ["experimental", "approval", "list", "--cwd", project], expected: "PASS" },
    { id: "candidate:missing-id", command: "candidate", args: ["experimental", "candidate", "inspect", "--cwd", project], expected: "EXPECTED_REJECTION" },
    { id: "session:missing-id", command: "session", args: ["experimental", "session", "status", "--cwd", project], expected: "EXPECTED_REJECTION" },
    { id: "workflow:list", command: "workflow", args: ["experimental", "workflow", "list", "--cwd", project], expected: "PASS" },
    { id: "autonomy:status", command: "autonomy", args: ["experimental", "autonomy", "status", "--cwd", project], expected: "PASS" },
    { id: "orchestrate:unsafe", command: "orchestrate", args: ["experimental", "orchestrate", "--unsafe-no-sandbox"], expected: "EXPECTED_REJECTION" },
    { id: "council:unsafe", command: "council", args: ["experimental", "council", "--unsafe-no-sandbox"], expected: "EXPECTED_REJECTION" },
    { id: "gate", command: "gate", args: ["experimental", "gate", "--cwd", project], expected: "PASS" },
    { id: "mcp:install-claude", command: "mcp", args: ["mcp", "install", "claude"], expected: "PASS" },
    { id: "mcp:status-grok", command: "mcp", args: ["mcp", "status", "grok"], expected: "PASS" },
    { id: "skill:list", command: "skill", args: ["experimental", "skill", "list", "--cwd", project], expected: "PASS" },
    { id: "loop:list", command: "loop", args: ["experimental", "loop", "list", "--cwd", project], expected: "PASS" },
    { id: "verify", command: "verify", args: ["verify", "--json", "--cwd", project], expected: "PASS" },
    { id: "ledger:verify", command: "ledger", args: ["experimental", "ledger", "verify", "--json", "--cwd", project], expected: "PASS" },
    { id: "ledger:confirmation", command: "ledger", args: ["experimental", "ledger", "repair-tail", "--cwd", project], expected: "EXPECTED_REJECTION", expectedError: "--confirm" },
    { id: "receipt:list", command: "receipt", args: ["experimental", "receipt", "list", "--cwd", project], expected: "PASS" },
    { id: "budget:upsert", command: "budget", args: ["experimental", "budget", "upsert", "--id", "audit-budget", "--max-requests", "8", "--max-cost-usd", "5", "--cwd", project], expected: "PASS" },
    { id: "budget:list", command: "budget", args: ["experimental", "budget", "list", "--cwd", project], expected: "PASS" },
    { id: "budget:missing-id", command: "budget", args: ["experimental", "budget", "upsert", "--cwd", project], expected: "EXPECTED_REJECTION" },
    { id: "daemon:stop", command: "daemon", args: ["daemon", "stop", "--cwd", project], expected: "PASS" },
  ];
  const results: AuditResult[] = [];
  for (const row of cases) {
    const result = await runCli(row.args, env);
    const errorMatches = !row.expectedError || result.stderr.includes(row.expectedError) || result.stdout.includes(row.expectedError);
    const status: AuditResult["status"] = result.exitCode === (row.expected === "PASS" ? 0 : 1) && errorMatches ? row.expected : "FAIL";
    results.push({ id: row.id, command: row.command, status, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
  }
  return results;
}

function installFakeBackends(bin: string) {
  writeExecutable(join(bin, "opencode"), `
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("opencode 1.17.17"); process.exit(0); }
if (args.includes("--help")) { console.log("--pure --format --dir --model --agent"); process.exit(0); }
console.log(JSON.stringify({ type: "text", text: "ready", usage: { input_tokens: 1, output_tokens: 1 } }));`);
  writeExecutable(join(bin, "claude"), `
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("claude 2.1.206"); process.exit(0); }
if (args.includes("--help")) { console.log("--bare --safe-mode --allowedTools --disallowedTools"); process.exit(0); }
console.log(JSON.stringify({ type: "result", result: "ready", usage: { input_tokens: 1, output_tokens: 1 } }));`);
  writeExecutable(join(bin, "codex"), `
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("codex-cli 0.144.1"); process.exit(0); }
if (args.includes("--help")) { console.log("--ignore-user-config --ignore-rules --ephemeral --strict-config"); process.exit(0); }
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ready" }, usage: { input_tokens: 1, output_tokens: 1 } }));`);
  writeExecutable(join(bin, "grok"), `
if (process.argv.includes("--version")) console.log("grok 0.2.99");
else if (process.argv.includes("--help")) console.log("--json --resume");
else console.log(JSON.stringify({ text: "ready", usage: { input_tokens: 1, output_tokens: 1 } }));`);
}

function writeExecutable(path: string, body: string) {
  writeFileSync(path, `#!/usr/bin/env bun\n${body}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function requireGitSuccess(result: ReturnType<typeof runGitStrict>, action: string) {
  if (result.ok) return;
  throw new Error(`Unable to ${action}: ${result.stderr || result.stdout}`);
}

describe("isolated CLI audit runner", () => {
  test("runs deterministic lifecycle and parser rows without external state", async () => {
    const results = await runIsolatedCliAudit();
    expect(results.filter((result) => result.id !== "init").every((result) => result.status !== "FAIL")).toBe(true);
    expect(results.find((result) => result.id === "help")?.stdout).toContain("Commands:");
    expect(results.find((result) => result.id === "unknown")?.stderr).toContain("Unknown command");
    expect(results.find((result) => result.id === "init")?.stdout).toContain("external state");
    const covered = new Set(results.map((result) => result.command));
    const publicCommands = COMMAND_SPECS.filter((spec) => !("internal" in spec)).map((spec) => spec.name);
    expect(publicCommands.filter((command) => !covered.has(command))).toEqual([]);
    const validation = results.find((result) => result.id === "fleet:invalid-structured")!;
    expect(validation.stdout).not.toContain('"message": "[');
    expect(JSON.parse(validation.stdout)).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  }, 45_000);

  test("does not modify the disposable checkout during init", async () => {
    const root = mkdtempSync(join(tmpdir(), "headless-cli-audit-checkout-"));
    const project = trackDaemonProjectRoot(join(root, "project"));
    mkdirSync(project);
    writeFileSync(join(project, "keep.txt"), "keep\n");
    const before = readdirSync(project);
    const state = join(root, "state");
    const result = await runCli(["init", "--cwd", project], {
      HEADLESS_STATE_HOME: state,
      HOME: join(root, "home"),
      XDG_RUNTIME_DIR: join(root, "runtime"),
      HEADLESS_RUNTIME_HOME: `/tmp/hr-${process.pid}-${Date.now().toString(36).slice(-4)}`,
      HEADLESS_AUDIT_CWD: project,
    });
    expect(result.exitCode).toBe(0);
    expect(readdirSync(project)).toEqual(before);
  });
});

async function runCli(args: string[], env: Record<string, string>) {
  const cwd = env.HEADLESS_AUDIT_CWD ?? env.HEADLESS_PROJECT_ROOT;
  const commandIndex = args[0] === "experimental" ? 1 : 0;
  const commandArgs = args.includes("--cwd") || args[commandIndex] === "mcp" || args[0] === "--help" || args[0] === "--version"
    ? args
    : [...args.slice(0, commandIndex + 1), "--cwd", cwd ?? process.cwd(), ...args.slice(commandIndex + 1)];
  const child = Bun.spawn(["bun", cliPath, ...commandArgs], { stdout: "pipe", stderr: "pipe", cwd, env: { ...process.env, ...env } });
  const [stdout, stderr, exitCode] = await Promise.all([Bun.readableStreamToText(child.stdout), Bun.readableStreamToText(child.stderr), child.exited]);
  return { stdout, stderr, exitCode };
}
