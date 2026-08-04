import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerBackendDefinition, unregisterBackendDefinition, type BackendDefinition } from "../src/backends/registry";
import { parseOpenCodeJsonl } from "../src/backends/opencode";
import type { Job, Workflow } from "../src/contracts/durable";
import { HeadlessDaemonClient } from "../src/daemon/client";
import { HeadlessDaemon } from "../src/daemon/server";
import { ensureProjectStateDirectories, getProjectStatePaths } from "../src/runtime/project-state";
import { WorkflowStore } from "../src/runtime/workflow-store";
import { schedulingWindow, setTestTimeout } from "./support/timing";

setTestTimeout(5_000);

const BACKEND = "fixture-workflow";
const originalPath = process.env.PATH;
const roots: string[] = [];
const daemons: HeadlessDaemon[] = [];

registerBackendDefinition(fixtureAdapter());
afterAll(() => unregisterBackendDefinition(BACKEND));
afterEach(async () => {
  process.env.PATH = originalPath;
  while (daemons.length) await daemons.pop()!.stop();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("durable workflows", () => {
  test("passes actual dependency results through a durable DAG and enforces finality", async () => {
    const fixture = createFixture();
    installBackend(fixture.bin, `
const prompt=process.argv.at(-1)??"";
const text=prompt.includes("review the seed")
  ? (prompt.includes("seed-output") ? "review-saw-actual-seed" : "review-missed-seed")
  : "seed-output";
console.log(JSON.stringify({type:"text",text}));`);
    const { daemon, client } = await start(fixture);

    const created = await client.call<Workflow>("workflow.run", {
      id: "actual-output-workflow",
      requirements: { policy: true, tests: false, review: true, vote: false, budget: true },
      steps: [
        { id: "seed", backend: BACKEND, prompt: "produce seed", timeoutMs: 5_000 },
        { id: "review", kind: "review", backend: BACKEND, prompt: "review the seed", dependsOn: ["seed"], timeoutMs: 5_000 },
      ],
    });
    const completed = await client.call<Workflow>("workflow.wait", { workflowId: created.id, timeoutMs: 20_000 }, 25_000);

    expect(completed.state).toBe("succeeded");
    expect(completed.finality?.allowed).toBe(true);
    expect(completed.steps.find((step) => step.id === "review")?.result?.output).toBe("review-saw-actual-seed");
    for (const step of completed.steps) {
      const job = daemon.jobs.get(step.lastJobId!);
      expect(job?.workflowId).toBe(completed.id);
      expect(job?.state).toBe("succeeded");
    }
  });

  test("blocks terminal completion when a required typed gate is absent", async () => {
    const fixture = createFixture();
    installBackend(fixture.bin, `console.log(JSON.stringify({type:"text",text:"execution-only"}));`);
    const { client } = await start(fixture);
    const created = await client.call<Workflow>("workflow.run", {
      id: "missing-test-workflow",
      requirements: { policy: true, tests: true, review: false, vote: false, budget: true },
      steps: [{ id: "execute", backend: BACKEND, prompt: "execute", timeoutMs: 5_000 }],
    });

    const completed = await client.call<Workflow>("workflow.wait", { workflowId: created.id, timeoutMs: 20_000 }, 25_000);
    expect(completed.state).toBe("blocked");
    expect(completed.finality?.allowed).toBe(false);
    expect(completed.finality?.reasons.join(" ")).toContain("test gate");
    expect(completed.error?.code).toBe("GATE_FAILED");
  });

  test("resumes a queued workflow from external state after daemon startup", async () => {
    const fixture = createFixture();
    installBackend(fixture.bin, `console.log(JSON.stringify({type:"text",text:"recovered-workflow"}));`);
    const state = ensureProjectStateDirectories(getProjectStatePaths(fixture.project, fixture.state));
    const stored = new WorkflowStore(state).create({
      id: "restart-workflow",
      principal: "coordinator",
      sessionId: null,
      requirements: { policy: true, tests: false, review: false, vote: false, budget: true },
      steps: [{
        id: "resume",
        kind: "execution",
        backend: BACKEND,
        prompt: "resume after restart",
        mode: "read-only",
        model: null,
        agent: null,
        timeoutMs: 5_000,
        dependsOn: [],
        maxAttempts: 1,
      }],
    });
    const { client } = await start(fixture);

    const completed = await client.call<Workflow>("workflow.wait", { workflowId: stored.id, timeoutMs: 20_000 }, 25_000);
    expect(completed.state).toBe("succeeded");
    expect(completed.steps[0]?.result?.output).toBe("recovered-workflow");
    expect((await client.call<Workflow[]>("workflow.list")).map((workflow) => workflow.id)).toContain(stored.id);
  });

  test("cancels the active job and resolves every unstarted step", async () => {
    const fixture = createFixture();
    installBackend(fixture.bin, `await Bun.sleep(30_000); console.log(JSON.stringify({type:"text",text:"late"}));`);
    const { client } = await start(fixture);
    const created = await client.call<Workflow>("workflow.run", {
      id: "cancel-workflow",
      steps: [
        { id: "slow", backend: BACKEND, prompt: "slow", timeoutMs: 60_000 },
        { id: "never", backend: BACKEND, prompt: "never", dependsOn: ["slow"], timeoutMs: 5_000 },
      ],
    });
    await waitFor(async () => (await client.call<Workflow>("workflow.status", { workflowId: created.id })).steps[0]?.state === "running");
    await client.call("workflow.cancel", { workflowId: created.id });

    const completed = await client.call<Workflow>("workflow.wait", { workflowId: created.id, timeoutMs: 20_000 }, 25_000);
    expect(completed.state).toBe("cancelled");
    expect(completed.error?.code).toBe("CANCELLED");
    expect(completed.steps.every((step) => step.state === "cancelled")).toBe(true);
  });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "headless-workflow-"));
  roots.push(root);
  const project = join(root, "project");
  const bin = join(root, "bin");
  const stateHome = join(root, "state");
  mkdirSync(project);
  mkdirSync(bin);
  process.env.PATH = `${bin}:${originalPath}`;
  return { project, bin, state: { env: { ...process.env, HEADLESS_STATE_HOME: stateHome } } };
}

function installBackend(bin: string, body: string) {
  const path = join(bin, "opencode");
  writeFileSync(path, `#!/usr/bin/env bun\n${body}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
}

async function start(fixture: ReturnType<typeof createFixture>) {
  const daemon = new HeadlessDaemon({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48), principal: "coordinator" });
  daemons.push(daemon);
  await daemon.start();
  const client = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48), timeoutMs: 25_000 });
  return { daemon, client };
}

function fixtureAdapter(): BackendDefinition {
  return {
    id: BACKEND,
    metadata: { id: BACKEND, aliases: [], promptDelivery: "argv", timeoutMs: 10_000, maxDepth: null, canRead: true, canWrite: false },
    capabilities: { write: false, streaming: true, structuredOutput: true, nativeResume: false, cancellation: true, tools: false, effort: false, brokerCompatible: false },
    security: { outerContainmentRequired: true, strictAuth: "credential-free", disablesProjectConfig: true, disablesHooks: true, disablesMcp: true, disablesSkills: true },
    probe: { versionCommand: ["/usr/bin/true"], helpCommand: ["/usr/bin/true"], requiredHelpFragments: [], timeoutMs: 1_000, maxOutputBytes: 1_024 },
    stdinPrompt: false,
    credentialPrefixes: [],
    prepareCommand: (options, cwd) => ["opencode", "run", "--dir", cwd, "--", options.prompt],
    decodeOutput: parseOpenCodeJsonl,
  };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + schedulingWindow(timeoutMs);
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error("Timed out waiting for workflow state.");
}
