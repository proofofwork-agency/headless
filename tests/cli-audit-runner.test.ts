import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CLI_AUDIT_MANIFEST } from "../src/cli";

const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;

type AuditResult = {
  id: string;
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
  const project = join(root, "project");
  const state = join(root, "state");
  const home = join(root, "home");
  const runtime = `/tmp/hr-${process.pid}-${Date.now().toString(36).slice(-4)}`;
  const bin = join(root, "bin");
  for (const dir of [project, state, home, bin]) mkdirSync(dir, { recursive: true });
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(project, "marker.txt"), "audit\n");
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
  const cases: Array<{ id: string; args: string[]; expected: AuditResult["status"]; expectedError?: string }> = [
    { id: "help", args: ["--help"], expected: "PASS" },
    { id: "version", args: ["--version"], expected: "PASS" },
    { id: "unknown", args: ["definitely-not-a-command"], expected: "EXPECTED_REJECTION" },
    { id: "exec:conflicting-containment", args: ["exec", "--require-sandbox", "--unsafe-no-sandbox", "prompt"], expected: "EXPECTED_REJECTION", expectedError: "Choose either --require-sandbox or --unsafe-no-sandbox" },
    { id: "autonomy:unsafe", args: ["experimental", "autonomy", "start", "--unsafe-no-sandbox"], expected: "EXPECTED_REJECTION" },
    { id: "launch:legacy", args: ["experimental", "launch", "opencode-serve"], expected: "EXPECTED_REJECTION" },
    { id: "init", args: ["init", "--cwd", project], expected: "PASS" },
    { id: "daemon:status", args: ["daemon", "status", "--cwd", project], expected: "PASS" },
    { id: "doctor", args: ["doctor", "--cwd", project], expected: "PASS" },
    { id: "status", args: ["status", "--cwd", project], expected: "PASS" },
    { id: "events", args: ["experimental", "events", "--cwd", project], expected: "PASS" },
    { id: "project:trust-status", args: ["project", "trust", "status", "--cwd", project], expected: "PASS" },
    { id: "project:trust-grant", args: ["project", "trust", "grant", "--allow-bypass", "--cwd", project], expected: "PASS" },
    { id: "fleet:profile-list", args: ["experimental", "fleet", "profile", "list", "--cwd", project], expected: "PASS" },
    { id: "goal:list", args: ["experimental", "goal", "list", "--cwd", project], expected: "PASS" },
    { id: "approval:list", args: ["experimental", "approval", "list", "--cwd", project], expected: "PASS" },
    { id: "workflow:list", args: ["experimental", "workflow", "list", "--cwd", project], expected: "PASS" },
    { id: "autonomy:status", args: ["experimental", "autonomy", "status", "--cwd", project], expected: "PASS" },
    { id: "pair", args: ["experimental", "pair", "--cwd", project], expected: "PASS" },
    { id: "ask", args: ["experimental", "ask", "--cwd", project], expected: "PASS" },
    { id: "coop-proof", args: ["experimental", "coop-proof", "--cwd", project], expected: "PASS" },
    { id: "mcp:install-claude", args: ["mcp", "install", "claude"], expected: "PASS" },
    { id: "mcp:status-grok", args: ["mcp", "status", "grok"], expected: "PASS" },
    { id: "candidate:missing-id", args: ["experimental", "candidate", "inspect", "--cwd", project], expected: "EXPECTED_REJECTION" },
    { id: "session:missing-id", args: ["experimental", "session", "status", "--cwd", project], expected: "EXPECTED_REJECTION" },
    { id: "collaboration:missing-goal", args: ["experimental", "collaboration", "turns", "--cwd", project], expected: "EXPECTED_REJECTION" },
    { id: "exec:opencode", args: ["exec", "--backend", "opencode", "--model", "openai/test-model", "--unsafe-no-sandbox", "--cwd", project, "ready"], expected: "EXPECTED_REJECTION" },
  ];
  const results: AuditResult[] = [];
  for (const row of cases) {
    const result = await runCli(row.args, env);
    const errorMatches = !row.expectedError || result.stderr.includes(row.expectedError) || result.stdout.includes(row.expectedError);
    const status: AuditResult["status"] = result.exitCode === (row.expected === "PASS" ? 0 : 1) && errorMatches ? row.expected : "FAIL";
    results.push({ id: row.id, status, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
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

describe("isolated CLI audit runner", () => {
  test("runs deterministic lifecycle and parser rows without external state", async () => {
    const results = await runIsolatedCliAudit();
    expect(results.filter((result) => result.id !== "init").every((result) => result.status !== "FAIL")).toBe(true);
    expect(results.find((result) => result.id === "help")?.stdout).toContain("Commands:");
    expect(results.find((result) => result.id === "unknown")?.stderr).toContain("Unknown command");
    expect(results.find((result) => result.id === "init")?.stdout).toContain("external state");
  }, 45_000);

  test("does not modify the disposable checkout during init", async () => {
    const root = mkdtempSync(join(tmpdir(), "headless-cli-audit-checkout-"));
    const project = join(root, "project");
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
