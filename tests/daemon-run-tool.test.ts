import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerBackendDefinition, unregisterBackendDefinition, type BackendDefinition } from "../src/backends/registry";
import type { Job } from "../src/contracts/durable";
import { HeadlessDaemonClient } from "../src/daemon/client";
import { HeadlessDaemon } from "../src/daemon/server";
import { DARWIN_SANDBOX_EXEC, probeLinuxBwrap } from "../src/runtime/os-sandbox";

const ADAPTER_ID = "run-tool-contained-fixture";
const roots: string[] = [];
const daemons: HeadlessDaemon[] = [];

afterEach(async () => {
  unregisterBackendDefinition(ADAPTER_ID);
  for (const daemon of daemons.splice(0)) await daemon.stop().catch(() => {});
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("daemon-owned worker cooperation", () => {
  test.skipIf(!strictContainmentAvailable())("injects the scoped helper into the contained worker and revokes it at terminal state", async () => {
    const root = mkdtempSync(join(tmpdir(), "headless-daemon-run-tool-"));
    roots.push(root);
    const project = join(root, "project");
    mkdirSync(project);
    const runtime = `/tmp/hdt-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    roots.push(runtime);
    const state = { env: { ...process.env, HEADLESS_STATE_HOME: join(root, "state"), HEADLESS_RUNTIME_HOME: runtime } };
    let preparedPrompt = "";
    registerBackendDefinition(fixtureAdapter((prompt) => { preparedPrompt = prompt; }));

    const token = "d".repeat(48);
    const daemon = new HeadlessDaemon({ projectRoot: project, state, token, principal: "coordinator" });
    daemons.push(daemon);
    await daemon.start();
    const client = new HeadlessDaemonClient({ projectRoot: project, state, token });
    const submitted = await client.call<Job>("run.submit", {
      backend: ADAPTER_ID,
      prompt: "Use authenticated cooperation.",
      containment: "required",
      timeoutMs: 10_000,
    });
    const completed = await client.call<Job>("run.wait", { jobId: submitted.id, timeoutMs: 10_000 }, 15_000);

    expect(completed.result?.status).toBe("succeeded");
    expect(completed.result?.containment.enforced).toBe(true);
    expect(completed.result?.output).toContain("verified from contained worker");
    expect(completed.result?.output).toContain(submitted.id);
    expect(completed.result?.output).toContain("[REDACTED_HEADLESS_RUN_TOOL_TOKEN]");
    expect(completed.result?.output).not.toMatch(/hlt_[A-Za-z0-9_-]{40,}/);
    expect(preparedPrompt).toContain("HEADLESS AUTHENTICATED RUN TOOLS");
    expect(preparedPrompt).toContain("headless-run-tool note");
    expect(readFileSync(daemon.state.ledgerPath, "utf8")).toContain("verified from contained worker");
    expect(readdirSync(daemon.state.daemonRuntimeDir).filter((name) => name.endsWith(".tool.sock"))).toEqual([]);

    const unsafe = await client.call<Job>("run.submit", {
      backend: ADAPTER_ID,
      prompt: "Unsafe local escape hatch does not receive daemon authority.",
      containment: "unsafe",
      timeoutMs: 5_000,
    });
    const unsafeCompleted = await client.call<Job>("run.wait", { jobId: unsafe.id, timeoutMs: 5_000 }, 10_000);
    expect(unsafeCompleted.result?.status).toBe("failed");
    expect(preparedPrompt).toBe("Unsafe local escape hatch does not receive daemon authority.");
    expect(readdirSync(daemon.state.daemonRuntimeDir).filter((name) => name.endsWith(".tool.sock"))).toEqual([]);
  });
});

function fixtureAdapter(capturePrompt: (prompt: string) => void): BackendDefinition {
  const script = String.raw`
const calls = [
  ["task_status", "{}"],
  ["note", JSON.stringify({ text: "verified from contained worker" })],
];
const results = [];
for (const args of calls) {
  const child = Bun.spawn(["headless-run-tool", ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) {
    console.error(stderr);
    process.exit(code || 1);
  }
  results.push(JSON.parse(stdout));
}
console.log(JSON.stringify({ task: results[0], note: results[1], leaked: process.env.HEADLESS_RUN_TOOL_TOKEN }));
`;
  return {
    id: ADAPTER_ID,
    metadata: { id: ADAPTER_ID, aliases: [], promptDelivery: "native", timeoutMs: 10_000, maxDepth: null, canRead: true, canWrite: false },
    capabilities: { write: false, streaming: false, structuredOutput: true, nativeResume: false, cancellation: true, tools: true, effort: false, brokerCompatible: false },
    security: { outerContainmentRequired: true, strictAuth: "credential-free", disablesProjectConfig: true, disablesHooks: true, disablesMcp: true, disablesSkills: true },
    probe: { versionCommand: ["bun", "--version"], helpCommand: ["bun", "--help"], requiredHelpFragments: ["Usage:"], timeoutMs: 2_000, maxOutputBytes: 262_144 },
    stdinPrompt: false,
    credentialPrefixes: [],
    prepareCommand: (options) => {
      capturePrompt(options.prompt);
      return ["bun", "-e", script];
    },
    decodeOutput: (stdout) => ({ output: stdout.trim(), cost: null, tokens: null, error: null }),
  };
}

function strictContainmentAvailable() {
  if (process.platform === "darwin") return existsSync(DARWIN_SANDBOX_EXEC);
  if (process.platform === "linux") return probeLinuxBwrap().ok;
  return false;
}
