import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DurableSession, Job, Workflow } from "../src/contracts/durable";
import { RunRequestSchema, RunResultSchema, type RunEvent, type RunResult } from "../src/contracts/run";
import { HeadlessDaemonClient } from "../src/daemon/client";
import { JobStore } from "../src/daemon/job-store";
import { RunEventStore } from "../src/daemon/run-event-store";
import { HeadlessDaemon } from "../src/daemon/server";
import { decodePersistedRunResult } from "../src/runtime/persisted-run-result";
import { PersistentSessionStore } from "../src/runtime/persistent-sessions";
import { ensureProjectStateDirectories, getProjectStatePaths } from "../src/runtime/project-state";
import { WorkflowStore } from "../src/runtime/workflow-store";

const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;
const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("persisted RunResult compatibility", () => {
  test("keeps the live schema strict while decoding only the known persisted predecessor", () => {
    const current = completedResult("job", "session");
    const legacy = withNetwork(current, "provider-direct");

    expect(() => RunResultSchema.parse(legacy)).toThrow();
    expect(decodePersistedRunResult(legacy)).toEqual(current);
    expect(() => decodePersistedRunResult(withNetwork(current, "future-direct"))).toThrow();
  });

  test("starts and serves canonical results from a non-fresh legacy state without rewriting protected evidence", async () => {
    const fixture = createFixture();
    const paths = ensureProjectStateDirectories(getProjectStatePaths(fixture.project, fixture.state));
    const sessions = new PersistentSessionStore(paths);
    const session = sessions.create({
      principal: "coordinator",
      backend: "opencode",
      containment: "unsafe",
      authMode: "native-login",
    });
    const jobs = new JobStore(paths.jobsDir);
    const request = RunRequestSchema.parse({
      backend: "opencode",
      prompt: "legacy persisted result",
      projectRoot: fixture.project,
      containment: "unsafe",
      authMode: "native-login",
      sessionId: session.id,
    });
    const created = jobs.create({ projectId: paths.projectId, principal: "coordinator", request });
    jobs.claim(created.id, "fixture-daemon", 60_000);
    jobs.transition(created.id, "running");
    const result = completedResult(created.id, session.id);
    jobs.complete(created.id, result);
    sessions.start(session.id, created.id);
    sessions.complete(session.id, result);

    const events = new RunEventStore(paths.runEventsPath, { compactOnOpen: false });
    events.reconcileTerminal({ jobId: created.id, sessionId: session.id }, result, 123);

    const workflows = new WorkflowStore(paths, () => 123);
    const workflow = workflows.create({
      id: "legacy-workflow",
      principal: "coordinator",
      sessionId: session.id,
      authMode: "native-login",
      approvalPolicy: "ask",
      requirements: { policy: true, tests: false, review: false, vote: false, budget: true },
      steps: [{
        id: "legacy-step",
        kind: "execution",
        backend: "opencode",
        prompt: "already completed",
        mode: "read-only",
        authMode: "native-login",
        approvalPolicy: "ask",
        model: null,
        agent: null,
        timeoutMs: 1_000,
        dependsOn: [],
        maxAttempts: 1,
      }],
    });
    workflows.update(workflow.id, (current) => ({
      ...current,
      state: "succeeded",
      steps: current.steps.map((step) => ({
        ...step,
        attempt: 1,
        state: "succeeded",
        jobIds: [created.id],
        lastJobId: created.id,
        result,
      })),
    }));

    const jobPath = join(paths.jobsDir, `${created.id}.job.json`);
    const sessionPath = join(paths.sessionsDir, `${session.id}.json`);
    const workflowPath = join(paths.workflowsDir, `${workflow.id}.json`);
    rewriteJson(jobPath, (value) => setResultNetwork(value, "provider-direct"));
    rewriteJson(sessionPath, (value) => setResultNetwork(asRecord(value).session, "provider-direct"));
    rewriteJson(workflowPath, (value) => setResultNetwork(asArray(asRecord(value).steps)[0], "provider-direct"));
    rewriteJson(paths.runEventsPath, (value) => {
      for (const entry of asArray(asRecord(value).records)) {
        const record = asRecord(entry);
        const event = asRecord(record.event);
        if (event.kind === "completion") setResultNetwork(event, "provider-direct");
      }
    });
    const archivePath = rewriteProtectedArchive(`${paths.runEventsPath}.protected`);
    const protectedBytes = readFileSync(archivePath, "utf8");

    for (const path of [jobPath, sessionPath, workflowPath, paths.runEventsPath, archivePath]) {
      expect(readFileSync(path, "utf8")).toContain("provider-direct");
    }

    const daemon = new HeadlessDaemon({
      projectRoot: fixture.project,
      state: fixture.state,
      principal: "coordinator",
      enableExperimentalSessions: true,
    });
    await daemon.start();
    try {
      const client = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state });
      const storedJob = await client.call<Job>("run.status", { jobId: created.id });
      const storedSession = await client.call<DurableSession>("session.status", { sessionId: session.id });
      const storedWorkflow = await client.call<Workflow>("workflow.status", { workflowId: workflow.id });
      const snapshot = await client.call<{ events: RunEvent[] }>("events.snapshot", { jobId: created.id, limit: 10 });
      const completion = snapshot.events.find((event) => event.kind === "completion");
      const protectedCompletion = new RunEventStore(paths.runEventsPath, { compactOnOpen: false })
        .protectedSnapshot({ limit: 10 }).records.find((record) => record.event.kind === "completion")?.event;

      expect(storedJob.result?.containment.network).toBe("native-direct-unrestricted");
      expect(storedSession.result?.containment.network).toBe("native-direct-unrestricted");
      expect(storedWorkflow.steps[0]?.result?.containment.network).toBe("native-direct-unrestricted");
      expect(completion?.kind === "completion" && completion.result.containment.network).toBe("native-direct-unrestricted");
      expect(protectedCompletion?.kind === "completion" && protectedCompletion.result.containment.network).toBe("native-direct-unrestricted");

      const doctor = await runDoctor(fixture);
      expect(doctor.exitCode).toBe(0);
      expect(doctor.stdout).toContain("headless doctor — v0.2 daemon and runtime self-check");
      expect(doctor.stderr).toBe("");
      expect(readFileSync(archivePath, "utf8")).toBe(protectedBytes);
      for (const path of [jobPath, sessionPath, workflowPath, paths.runEventsPath]) {
        expect(readFileSync(path, "utf8")).toContain("provider-direct");
      }
    } finally {
      await daemon.stop();
    }

    rewriteJson(jobPath, (value) => setResultNetwork(value, "future-direct"));
    expect(() => new JobStore(paths.jobsDir).get(created.id)).toThrow();
  }, 20_000);
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "headless-persisted-result-"));
  const project = join(root, "project");
  const stateHome = join(root, "state");
  const runtimeHome = join("/tmp", `headless-pr-${process.pid}-${crypto.randomUUID().slice(0, 8)}`);
  mkdirSync(project);
  mkdirSync(runtimeHome, { recursive: true });
  roots.push(root, runtimeHome);
  return {
    project,
    state: {
      env: {
        ...process.env,
        HEADLESS_STATE_HOME: stateHome,
        HEADLESS_RUNTIME_HOME: runtimeHome,
        HEADLESS_EXTENSION_CONFIG: undefined,
      },
    },
  };
}

function completedResult(jobId: string, sessionId: string): RunResult {
  return RunResultSchema.parse({
    status: "succeeded",
    error: null,
    backend: "opencode",
    output: "legacy fixture completed",
    stderr: "",
    diagnostics: { format: "fixture", malformedEvents: 0, ignoredEvents: 0, messages: [] },
    exitCode: 0,
    signal: null,
    usage: { input: 1, output: 2, reasoning: null, cached: null, providerTotal: 3 },
    cost: { amountUsd: null, source: "unknown", pricingId: null, observedRequests: 0 },
    containment: {
      requirement: "required",
      enforced: false,
      platform: "other",
      mechanism: "native-login",
      probe: "legacy fixture",
      isolatedHome: false,
      credentialsIsolated: false,
      network: "native-direct-unrestricted",
      credentialAccess: "backend-native",
      unsafe: true,
    },
    durationMs: 1,
    sessionId,
    jobId,
    diff: null,
    commit: null,
    truncation: { stdout: false, stderr: false, output: false, events: false, artifacts: false, diff: false },
  });
}

function withNetwork(result: RunResult, network: string) {
  return { ...result, containment: { ...result.containment, network } };
}

function rewriteJson(path: string, mutate: (value: unknown) => void) {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  mutate(value);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function setResultNetwork(container: unknown, network: string) {
  const result = asRecord(asRecord(container).result);
  asRecord(result.containment).network = network;
}

function rewriteProtectedArchive(directory: string) {
  const segments = readdirSync(directory).filter((name) => name.endsWith(".jsonl")).sort();
  expect(segments).toHaveLength(1);
  let previousHash: string | null = null;
  for (const name of segments) {
    const path = join(directory, name);
    const records = readFileSync(path, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const record of records) {
      const event = asRecord(record.event);
      if (event.kind === "completion") setResultNetwork(event, "provider-direct");
      record.previousHash = previousHash;
      const { hash: _hash, ...withoutHash } = record;
      record.hash = createHash("sha256").update(JSON.stringify(withoutHash)).digest("hex");
      previousHash = String(record.hash);
    }
    writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, { mode: 0o600 });
  }
  return join(directory, segments[0]!);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected fixture record.");
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError("Expected fixture array.");
  return value;
}

async function runDoctor(fixture: ReturnType<typeof createFixture>) {
  const child = Bun.spawn(["bun", cliPath, "doctor", "--cwd", fixture.project], {
    env: fixture.state.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
