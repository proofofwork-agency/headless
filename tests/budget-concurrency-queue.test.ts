import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOpenCodeJsonl } from "../src/backends/opencode";
import { registerAdapter, unregisterAdapter, type BackendAdapter } from "../src/backends/registry";
import type { Job } from "../src/contracts/durable";
import { HeadlessDaemonClient } from "../src/daemon/client";
import { HeadlessDaemon } from "../src/daemon/server";
import { BudgetStore } from "../src/runtime/budget-store";

const roots: string[] = [];
const daemons: HeadlessDaemon[] = [];
const adapters: string[] = [];

afterEach(async () => {
  while (daemons.length) await daemons.pop()!.stop();
  while (adapters.length) unregisterAdapter(adapters.pop()!);
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("budget concurrency scheduling", () => {
  test("queues a scoped excess, runs other scopes, and releases cancelled reservations", async () => {
    const root = mkdtempSync(join(tmpdir(), "headless-budget-queue-"));
    roots.push(root);
    const project = join(root, "project");
    const control = join(root, "control");
    const stateHome = join(root, "state");
    mkdirSync(project);
    mkdirSync(control);
    const executable = join(root, "fixture-backend");
    writeFileSync(executable, `#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join } from "node:path";
const [prompt, control] = process.argv.slice(2);
await Bun.write(join(control, prompt + ".started"), "started\\n");
if (prompt === "first") {
  const release = join(control, "release-first");
  while (!existsSync(release)) await Bun.sleep(10);
}
console.log(JSON.stringify({ type: "text", text: prompt }));
`, { mode: 0o700 });
    chmodSync(executable, 0o700);

    const adapterId = `budget-queue-${crypto.randomUUID()}`;
    registerAdapter(fixtureAdapter(adapterId, executable, control));
    adapters.push(adapterId);
    const state = { env: { ...process.env, HEADLESS_STATE_HOME: stateHome } };
    const token = "q".repeat(48);
    const daemon = new HeadlessDaemon({ projectRoot: project, state, token, principal: "coordinator", maxConcurrency: 2 });
    daemons.push(daemon);
    await daemon.start();
    const client = new HeadlessDaemonClient({ projectRoot: project, state, token });
    await client.call("budget.upsert", {
      id: "session-cap",
      principal: "coordinator",
      sessionId: "session-one",
      workflowId: null,
      provider: null,
      maxRequests: null,
      maxInputTokens: null,
      maxOutputTokens: null,
      maxCostUsd: null,
      maxArtifactBytes: null,
      maxConcurrency: 1,
      maxRetries: null,
    });

    const first = await client.call<Job>("run.submit", run(adapterId, "first", "session-one"));
    await waitForPath(join(control, "first.started"), async () => {
      const current = await client.call<Job>("run.status", { jobId: first.id });
      return current.result ? `${current.state}: ${current.result.error?.message ?? current.result.output}` : current.state;
    });
    const queued = await client.call<Job>("run.submit", run(adapterId, "queued", "session-one"));
    const cancelled = await client.call<Job>("run.submit", run(adapterId, "cancelled", "session-one"));

    expect((await client.call<Job>("run.status", { jobId: queued.id })).state).toBe("queued");
    expect(existsSync(join(control, "queued.started"))).toBe(false);
    expect((await client.call<Job>("run.cancel", { jobId: cancelled.id })).state).toBe("cancelled");
    expect(new BudgetStore(daemon.state).getReservation(cancelled.id)).toBeNull();

    const outsideScope = await client.call<Job>("run.submit", run(adapterId, "outside", undefined));
    const outsideCompleted = await client.call<Job>("run.wait", { jobId: outsideScope.id, timeoutMs: 5_000 });
    expect(outsideCompleted.state).toBe("succeeded");
    expect(existsSync(join(control, "outside.started"))).toBe(true);
    expect((await client.call<Job>("run.status", { jobId: queued.id })).state).toBe("queued");

    writeFileSync(join(control, "release-first"), "release\n");
    expect((await client.call<Job>("run.wait", { jobId: first.id, timeoutMs: 5_000 })).state).toBe("succeeded");
    expect((await client.call<Job>("run.wait", { jobId: queued.id, timeoutMs: 5_000 })).state).toBe("succeeded");
    expect(existsSync(join(control, "queued.started"))).toBe(true);
  }, 15_000);
});

function fixtureAdapter(id: string, executable: string, control: string): BackendAdapter {
  return {
    id,
    metadata: { id, aliases: [], promptDelivery: "argv", timeoutMs: 5_000, maxDepth: null, canRead: true, canWrite: false },
    capabilities: { write: false, streaming: true, structuredOutput: true, nativeResume: false, cancellation: true, tools: false, effort: false, brokerCompatible: false },
    security: { outerContainmentRequired: true, strictAuth: "credential-free", disablesProjectConfig: true, disablesHooks: true, disablesMcp: true, disablesSkills: true },
    probe: { versionCommand: ["/usr/bin/true"], helpCommand: ["/usr/bin/true"], requiredHelpFragments: [], timeoutMs: 1_000, maxOutputBytes: 1_024 },
    stdinPrompt: false,
    credentialPrefixes: [],
    buildCommand: (options) => [executable, options.prompt, control],
    parse: parseOpenCodeJsonl,
  };
}

function run(backend: string, prompt: string, sessionId: string | undefined) {
  return { backend, prompt, sessionId, containment: "unsafe", timeoutMs: 10_000 };
}

async function waitForPath(path: string, describe: () => Promise<string>) {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path} (${await describe()})`);
    await Bun.sleep(10);
  }
}
