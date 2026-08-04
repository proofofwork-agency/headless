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
const DELEGATE_PARENT_ID = "run-tool-delegate-parent";
const DELEGATE_CHILD_ID = "run-tool-delegate-child";
const DELEGATE_FAILURE_ID = "run-tool-delegate-failure";
const DELEGATE_TIMEOUT_ID = "run-tool-delegate-timeout";
// Linux's bwrap + seccomp + loopback-to-Unix relay starts several Bun
// processes. Under a loaded two-core runner, a cold round trip has exceeded
// the macOS/local fixture windows without violating any product deadline.
// Keep the child-timeout case itself at 1s; only capability fixtures get the
// larger bounded Linux lifecycle.
const SIMPLE_RUN_TIMEOUT_MS = process.platform === "linux" ? 60_000 : 10_000;
const DELEGATION_PARENT_TIMEOUT_MS = process.platform === "linux" ? 180_000 : 30_000;
const DELEGATION_CHILD_TIMEOUT_MS = process.platform === "linux" ? 120_000 : 10_000;
const COOPERATION_TEST_TIMEOUT_MS = process.platform === "linux" ? 240_000 : 45_000;
// GitHub-hosted Linux — privileged OR unprivileged — cannot terminalize the
// bwrap loopback->Unix relay child after its tool response, hanging these
// cooperation tests for 60-105s. Proven: the hosted privileged-container CI
// step failed these same four while a local privileged Docker passes them.
// The incompatibility is GitHub's hosted-runner kernel/virtualization itself,
// not the privilege level, so we skip on ALL GitHub Linux. Coverage remains on
// macOS CI, local dev, and the documented local privileged-Docker command in
// docs/internal/hosted-linux-relay-follow-up.md. This is a tracked CI
// incompatibility, not a containment waiver.
// The `!== "1"` clause mirrors tests/containment-v2.test.ts and is what lets a
// privileged/self-hosted runner opt IN to executing these. Without it the skip
// was unconditional on hosted Linux, so the diagnostic workflow written to
// reproduce this very failure set an environment variable the suite ignored and
// would have reported four skips as a clean run.
const HOSTED_LINUX_RELAY_INCOMPATIBLE = process.platform === "linux"
  && process.env.GITHUB_ACTIONS === "true"
  && process.env.HEADLESS_PRIVILEGED_CONTAINMENT_CI !== "1";
if (HOSTED_LINUX_RELAY_INCOMPATIBLE) {
  console.warn("Skipping daemon run-tool cooperation on GitHub-hosted Linux (privileged and unprivileged both hang relay child terminalization). Runs on macOS CI, local dev, and the documented local privileged-Docker command. Tracked in docs/internal/hosted-linux-relay-follow-up.md.");
}
const roots: string[] = [];
const daemons: HeadlessDaemon[] = [];

afterEach(async () => {
  unregisterBackendDefinition(ADAPTER_ID);
  unregisterBackendDefinition(DELEGATE_PARENT_ID);
  unregisterBackendDefinition(DELEGATE_CHILD_ID);
  unregisterBackendDefinition(DELEGATE_FAILURE_ID);
  unregisterBackendDefinition(DELEGATE_TIMEOUT_ID);
  for (const daemon of daemons.splice(0)) await daemon.stop().catch(() => {});
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("daemon-owned worker cooperation", () => {
  // The internal submit/wait budgets alone exceed bun's 5s default test
  // timeout; the Linux relay path needs the full window on slower CI hosts.
  test.skipIf(HOSTED_LINUX_RELAY_INCOMPATIBLE || !strictContainmentAvailable())("injects the scoped helper into the contained worker and revokes it at terminal state", async () => {
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
      timeoutMs: SIMPLE_RUN_TIMEOUT_MS,
    });
    const completed = await client.call<Job>("run.wait", { jobId: submitted.id, timeoutMs: SIMPLE_RUN_TIMEOUT_MS }, SIMPLE_RUN_TIMEOUT_MS + 10_000);

    // Include the full structured result so a hosted-CI-only failure is
    // diagnosable from the log (fixture run; bounded and already redacted).
    expect(completed.result?.status, JSON.stringify(completed.result, null, 2)).toBe("succeeded");
    expect(completed.result?.containment.enforced).toBe(true);
    expect(completed.result?.output).toContain("verified from contained worker");
    expect(completed.result?.output).toContain(submitted.id);
    expect(completed.result?.output).toContain("[REDACTED_HEADLESS_RUN_TOOL_TOKEN]");
    expect(completed.result?.output).not.toMatch(/hlt_[A-Za-z0-9_-]{40,}/);
    expect(preparedPrompt).toContain("HEADLESS AUTHENTICATED RUN TOOLS");
    expect(preparedPrompt).toContain("headless-run-tool note");
    expect(preparedPrompt).toContain("helper fails loudly");
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
  }, COOPERATION_TEST_TIMEOUT_MS);

  test.skipIf(HOSTED_LINUX_RELAY_INCOMPATIBLE || !strictContainmentAvailable())("runs one depth-one child and omits delegation from the child credential", async () => {
    const root = mkdtempSync(join(tmpdir(), "headless-run-delegate-"));
    roots.push(root);
    const project = join(root, "project");
    mkdirSync(project);
    const runtime = `/tmp/hdd-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    roots.push(runtime);
    const state = { env: { ...process.env, HEADLESS_STATE_HOME: join(root, "state"), HEADLESS_RUNTIME_HOME: runtime } };
    registerBackendDefinition(delegatingParentAdapter());
    registerBackendDefinition(delegatedChildAdapter());

    const token = "e".repeat(48);
    const daemon = new HeadlessDaemon({ projectRoot: project, state, token, principal: "coordinator", maxConcurrency: 2 });
    daemons.push(daemon);
    await daemon.start();
    const client = new HeadlessDaemonClient({ projectRoot: project, state, token });
    const parent = await client.call<Job>("run.submit", {
      backend: DELEGATE_PARENT_ID,
      prompt: "Delegate one bounded read.",
      containment: "required",
      timeoutMs: DELEGATION_PARENT_TIMEOUT_MS,
    });
    const completed = await client.call<Job>("run.wait", { jobId: parent.id, timeoutMs: DELEGATION_PARENT_TIMEOUT_MS }, DELEGATION_PARENT_TIMEOUT_MS + 10_000);

    expect(completed.result?.status, JSON.stringify(completed.result, null, 2)).toBe("succeeded");
    const reply = JSON.parse(completed.result?.output ?? "null") as { ok: boolean; childJobId: string; result: { output: string } };
    expect(reply.ok, JSON.stringify(reply, null, 2)).toBe(true);
    expect(reply.result.output).toContain("child completed");
    expect(reply.result.output).toContain("delegate-hidden");
    const child = daemon.jobs.get(reply.childJobId);
    expect(child?.delegationOf).toMatchObject({ parentJobId: parent.id, depth: 1, budgetFraction: 0.25 });
    expect(daemon.jobs.list().filter((job) => job.delegationOf?.parentJobId === parent.id)).toHaveLength(1);
    const parentEvents = await client.call<{ events: Array<{ kind: string; rule?: string; reason?: string }> }>("events.snapshot", { jobId: parent.id });
    expect(parentEvents.events.some((event) => event.kind === "policy" && event.rule === "run-delegation-completed")).toBe(true);
    expect(parentEvents.events.map((event) => event.reason ?? "").join(" ")).not.toContain("Child must inspect");
    const ledger = readFileSync(daemon.state.ledgerPath, "utf8");
    expect(ledger).toContain("worker_spawned");
    expect(ledger).toContain(reply.childJobId);
    expect(ledger).not.toContain("Child must inspect");
  }, COOPERATION_TEST_TIMEOUT_MS);

  test.skipIf(HOSTED_LINUX_RELAY_INCOMPATIBLE || !strictContainmentAvailable())("returns child failure as tool data and lets the parent finish", async () => {
    const root = mkdtempSync(join(tmpdir(), "headless-run-delegate-failure-"));
    roots.push(root);
    const project = join(root, "project");
    mkdirSync(project);
    const runtime = `/tmp/hdf-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    roots.push(runtime);
    const state = { env: { ...process.env, HEADLESS_STATE_HOME: join(root, "state"), HEADLESS_RUNTIME_HOME: runtime } };
    registerBackendDefinition(delegatingParentAdapter(DELEGATE_FAILURE_ID));
    registerBackendDefinition(delegationFixture(DELEGATE_FAILURE_ID, `console.error("expected child failure"); process.exit(7);`));
    const token = "f".repeat(48);
    const daemon = new HeadlessDaemon({ projectRoot: project, state, token, principal: "coordinator", maxConcurrency: 2 });
    daemons.push(daemon);
    await daemon.start();
    const client = new HeadlessDaemonClient({ projectRoot: project, state, token });
    const parent = await client.call<Job>("run.submit", { backend: DELEGATE_PARENT_ID, prompt: "Handle child failure.", containment: "required", timeoutMs: DELEGATION_PARENT_TIMEOUT_MS });
    const completed = await client.call<Job>("run.wait", { jobId: parent.id, timeoutMs: DELEGATION_PARENT_TIMEOUT_MS }, DELEGATION_PARENT_TIMEOUT_MS + 10_000);
    expect(completed.result?.status, JSON.stringify(completed.result, null, 2)).toBe("succeeded");
    const reply = JSON.parse(completed.result?.output ?? "null") as { ok: boolean; childJobId: string; result: { status: string }; error: { code: string } };
    expect(reply).toMatchObject({ ok: false, result: { status: "failed" }, error: { code: "PROCESS_ERROR" } });
    expect(daemon.jobs.get(reply.childJobId)?.state).toBe("failed");
  }, COOPERATION_TEST_TIMEOUT_MS);

  test.skipIf(HOSTED_LINUX_RELAY_INCOMPATIBLE || !strictContainmentAvailable())("returns child timeout as tool data inside the parent deadline", async () => {
    const root = mkdtempSync(join(tmpdir(), "headless-run-delegate-timeout-"));
    roots.push(root);
    const project = join(root, "project");
    mkdirSync(project);
    const runtime = `/tmp/hdtm-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    roots.push(runtime);
    const state = { env: { ...process.env, HEADLESS_STATE_HOME: join(root, "state"), HEADLESS_RUNTIME_HOME: runtime } };
    registerBackendDefinition(delegatingParentAdapter(DELEGATE_TIMEOUT_ID, 1_000));
    registerBackendDefinition(delegationFixture(DELEGATE_TIMEOUT_ID, `await Bun.sleep(5000); console.log("too late");`));
    const token = "a".repeat(48);
    const daemon = new HeadlessDaemon({ projectRoot: project, state, token, principal: "coordinator", maxConcurrency: 2 });
    daemons.push(daemon);
    await daemon.start();
    const client = new HeadlessDaemonClient({ projectRoot: project, state, token });
    const parent = await client.call<Job>("run.submit", { backend: DELEGATE_PARENT_ID, prompt: "Handle child timeout.", containment: "required", timeoutMs: DELEGATION_PARENT_TIMEOUT_MS });
    const completed = await client.call<Job>("run.wait", { jobId: parent.id, timeoutMs: DELEGATION_PARENT_TIMEOUT_MS }, DELEGATION_PARENT_TIMEOUT_MS + 10_000);
    expect(completed.result?.status, JSON.stringify(completed.result, null, 2)).toBe("succeeded");
    const reply = JSON.parse(completed.result?.output ?? "null") as { ok: boolean; result: { status: string }; error: { code: string } };
    expect(reply).toMatchObject({ ok: false, result: { status: "timed_out" }, error: { code: "TIMED_OUT" } });
  }, COOPERATION_TEST_TIMEOUT_MS);
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

function delegatingParentAdapter(target = DELEGATE_CHILD_ID, timeoutMs = DELEGATION_CHILD_TIMEOUT_MS): BackendDefinition {
  const script = String.raw`
const child = Bun.spawn(["headless-run-tool", "run.delegate", JSON.stringify({ backend: "${target}", prompt: "Child must inspect the project without mutation.", timeoutMs: ${timeoutMs} })], { stdout: "pipe", stderr: "pipe" });
const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
if (code !== 0) { console.error(stderr); process.exit(code || 1); }
console.log(stdout.trim());
`;
  return delegationFixture(DELEGATE_PARENT_ID, script);
}

function delegatedChildAdapter(): BackendDefinition {
  const script = String.raw`
const advertised = (process.env.HEADLESS_RUN_TOOL_OPERATIONS || "").split(",");
if (advertised.includes("run.delegate")) { console.error("delegate advertised to child"); process.exit(9); }
const forged = Bun.spawn(["headless-run-tool", "run.delegate", JSON.stringify({ backend: "${DELEGATE_PARENT_ID}", prompt: "forged" })], { stdout: "pipe", stderr: "pipe" });
const [code] = await Promise.all([forged.exited, new Response(forged.stdout).text(), new Response(forged.stderr).text()]);
if (code === 0) { console.error("forged delegation unexpectedly succeeded"); process.exit(10); }
console.log("child completed; delegate-hidden");
`;
  return delegationFixture(DELEGATE_CHILD_ID, script);
}

function delegationFixture(id: string, script: string): BackendDefinition {
  return {
    id,
    metadata: { id, aliases: [], promptDelivery: "native", timeoutMs: 30_000, maxDepth: null, canRead: true, canWrite: false },
    capabilities: { write: false, streaming: false, structuredOutput: true, nativeResume: false, cancellation: true, tools: true, effort: false, brokerCompatible: false },
    security: { outerContainmentRequired: true, strictAuth: "credential-free", disablesProjectConfig: true, disablesHooks: true, disablesMcp: true, disablesSkills: true },
    probe: { versionCommand: ["bun", "--version"], helpCommand: ["bun", "--help"], requiredHelpFragments: ["Usage:"], timeoutMs: 2_000, maxOutputBytes: 262_144 },
    stdinPrompt: false,
    credentialPrefixes: [],
    prepareCommand: () => ["bun", "-e", script],
    decodeOutput: (stdout) => ({ output: stdout.trim(), cost: null, tokens: null, error: null }),
  };
}

function strictContainmentAvailable() {
  if (process.platform === "darwin") return existsSync(DARWIN_SANDBOX_EXEC);
  // The real cooperation tests below are the transport proof. Re-running the
  // diagnostic relay probe once per test both duplicates that proof and made
  // test registration consume four independent 15s windows under CI load.
  if (process.platform === "linux") return probeLinuxBwrap().ok;
  return false;
}
