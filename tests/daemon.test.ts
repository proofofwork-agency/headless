import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeadlessDaemon } from "../src/daemon/server";
import { HeadlessDaemonClient } from "../src/daemon/client";
import { connectLeadDaemon, connectOrStartDaemon } from "../src/daemon/connect";
import { BudgetSchema, type Job, type Task } from "../src/contracts/durable";
import type { DurableSession } from "../src/contracts/durable";
import type { RunEvent, RunResult } from "../src/contracts/run";
import { CouncilStore, type CouncilRecord } from "../src/runtime/council-store";
import { runGitStrict } from "../src/runtime/git";
import { createWriteWorktree, planWriteWorktree, removeWriteWorktree } from "../src/runtime/worktree";
import { IntegrationJournal } from "../src/runtime/integration-journal";
import { AuthorityStore } from "../src/runtime/authority-store";
import { BudgetStore } from "../src/runtime/budget-store";
import type { FinalityStore } from "../src/runtime/finality-store";
import { RunRequestSchema } from "../src/contracts/run";
import { ensureProjectStateDirectories, getProjectStatePaths } from "../src/runtime/project-state";
import { JobStore } from "../src/daemon/job-store";
import { LedgerV2 } from "../src/runtime/ledger-v2";
import { PersistentSessionStore } from "../src/runtime/persistent-sessions";
import { WorktreeLeaseStore } from "../src/runtime/worktree-leases";
import { registerBackendDefinition, unregisterBackendDefinition, type BackendDefinition } from "../src/backends/registry";
import { parseGrokJsonl } from "../src/backends/grok";
import { parseOpenCodeJsonl } from "../src/backends/opencode";
import { exec as headlessExec } from "../src/index";

setDefaultTimeout(20_000);

const FIXTURE_READ_BACKEND = "fixture-opencode";
const FIXTURE_REVIEW_BACKEND = "fixture-review";
const FIXTURE_WRITE_BACKEND = "fixture-grok";
const FIXTURE_WRITE_REVIEW_BACKEND = "fixture-grok-review";

registerBackendDefinition(fixtureAdapter(FIXTURE_READ_BACKEND, "opencode", false, parseOpenCodeJsonl));
registerBackendDefinition(fixtureAdapter(FIXTURE_REVIEW_BACKEND, "opencode", false, parseOpenCodeJsonl));
registerBackendDefinition(fixtureAdapter(FIXTURE_WRITE_BACKEND, "grok", true, parseGrokJsonl));
registerBackendDefinition(fixtureAdapter(FIXTURE_WRITE_REVIEW_BACKEND, "grok", true, parseGrokJsonl));
afterAll(() => {
  unregisterBackendDefinition(FIXTURE_READ_BACKEND);
  unregisterBackendDefinition(FIXTURE_REVIEW_BACKEND);
  unregisterBackendDefinition(FIXTURE_WRITE_BACKEND);
  unregisterBackendDefinition(FIXTURE_WRITE_REVIEW_BACKEND);
});

const roots: string[] = [];
const daemons: HeadlessDaemon[] = [];
const originalPath = process.env.PATH;
const originalStateHome = process.env.HEADLESS_STATE_HOME;

afterEach(async () => {
  process.env.PATH = originalPath;
  if (originalStateHome === undefined) delete process.env.HEADLESS_STATE_HOME;
  else process.env.HEADLESS_STATE_HOME = originalStateHome;
  while (daemons.length) await daemons.pop()!.stop();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("authenticated project daemon", () => {
  test("does not open mutable project stores before winning the project socket", async () => {
    const fixture = createFixture();
    const daemon = new HeadlessDaemon({ projectRoot: fixture.project, state: fixture.state, principal: "coordinator" });

    for (const path of [
      daemon.state.tokenPath,
      daemon.state.credentialsPath,
      daemon.state.policyPath,
      daemon.state.budgetsPath,
      daemon.state.runEventsPath,
      daemon.state.daemonMetadataPath,
      join(daemon.state.projectDir, "message-queue.sqlite"),
    ]) expect(existsSync(path)).toBe(false);

    daemons.push(daemon);
    await daemon.start();
    expect(existsSync(daemon.state.tokenPath)).toBe(true);
    expect(existsSync(daemon.state.credentialsPath)).toBe(true);
    expect(existsSync(daemon.state.policyPath)).toBe(true);
  });

  test("concurrent startup elects one daemon without unlinking the winner socket", async () => {
    const fixture = createFixture();
    const first = new HeadlessDaemon({ projectRoot: fixture.project, state: fixture.state, principal: "coordinator" });
    const second = new HeadlessDaemon({ projectRoot: fixture.project, state: fixture.state, principal: "coordinator" });
    const starts = await Promise.allSettled([first.start(), second.start()]);
    expect(starts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(starts.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winner = starts[0]?.status === "fulfilled" ? first : second;
    daemons.push(winner);
    const client = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state });
    const ping = await client.call<{ projectId: string }>("ping");
    expect(ping.projectId).toBe(winner.state.projectId);
    expect(existsSync(winner.state.socketPath)).toBe(true);
  });

  test("binds one owner-only socket to one canonical project and derives the principal", async () => {
    const fixture = createFixture();
    const daemon = new HeadlessDaemon({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48), principal: "daemon-owner" });
    daemons.push(daemon);
    await daemon.start();
    const client = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48) });

    const ping = await client.call<{ projectId: string; projectRoot: string; principal: string }>("ping");

    expect(ping.projectRoot).toBe(daemon.state.canonicalProjectRoot);
    expect(ping.projectId).toBe(daemon.state.projectId);
    expect(ping.principal).toBe("daemon-owner");
    expect(statSync(daemon.state.socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(daemon.state.daemonMetadataPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(daemon.state.daemonMetadataPath, "utf8")).running).toBe(true);
    await expect(new HeadlessDaemon({ projectRoot: fixture.project, state: fixture.state, token: "b".repeat(48), principal: "daemon-owner" }).start()).rejects.toThrow(/already owns/i);
  });

  test("socket ownership recovers an unexpired crashed job and reconciles its budget reservation", async () => {
    const fixture = createFixture();
    const state = ensureProjectStateDirectories(getProjectStatePaths(fixture.project, fixture.state));
    const jobs = new JobStore(state.jobsDir);
    const request = RunRequestSchema.parse({
      backend: FIXTURE_READ_BACKEND,
      prompt: "interrupted",
      projectRoot: state.canonicalProjectRoot,
      containment: "unsafe",
      timeoutMs: 60_000,
    });
    const job = jobs.create({ projectId: state.projectId, principal: "coordinator", request });
    jobs.claim(job.id, "dead-daemon", 60_000);
    jobs.transition(job.id, "running");
    const budgets = new BudgetStore(state);
    budgets.upsertBudget(BudgetSchema.parse({
      id: "crash-budget",
      projectId: state.projectId,
      principal: "coordinator",
      sessionId: null,
      workflowId: null,
      provider: null,
      maxRequests: 5,
      maxInputTokens: 10,
      maxOutputTokens: null,
      maxCostUsd: 1,
      maxArtifactBytes: 100,
      maxConcurrency: null,
      maxRetries: null,
      usedRequests: 0,
      usedUsage: { input: 0, output: 0, reasoning: 0, cached: 0, providerTotal: 0 },
      usedCost: { amountUsd: 0, source: "reconciled", pricingId: null, observedRequests: 0 },
      usedArtifactBytes: 0,
      updatedAt: Date.now(),
    }));
    expect(budgets.reserve({
      id: job.id,
      projectId: state.projectId,
      principal: "coordinator",
      inputTokens: 3,
      outputTokens: 0,
      costUsd: 0,
      artifactBytes: 0,
    }).allowed).toBe(true);
    const daemon = new HeadlessDaemon({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48), principal: "coordinator" });

    daemons.push(daemon);
    await daemon.start();

    expect(daemon.jobs.get(job.id)?.state).toBe("failed");
    expect(daemon.jobs.get(job.id)?.result?.error?.retryable).toBe(true);
    const recoveredBudgets = new BudgetStore(daemon.state);
    expect(recoveredBudgets.getState().reservations).toHaveLength(0);
    expect(recoveredBudgets.getState().budgets[0]).toMatchObject({
      usedRequests: 5,
      usedUsage: { input: null, output: null },
      usedCost: { amountUsd: null, source: "unknown" },
      usedArtifactBytes: 100,
    });
    const reused = recoveredBudgets.reserve({
      id: "post-crash-reuse",
      projectId: state.projectId,
      principal: "coordinator",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
    expect(reused.allowed).toBe(false);
    expect(reused.reasons.join(" ")).toMatch(/request limit|unknown/);
  });

  test("a retryable crash cannot reuse broker quota lost with the prior attempt", async () => {
    const fixture = createFixture();
    const state = ensureProjectStateDirectories(getProjectStatePaths(fixture.project, fixture.state));
    const jobs = new JobStore(state.jobsDir);
    const request = RunRequestSchema.parse({
      backend: FIXTURE_READ_BACKEND,
      prompt: "interrupted retry",
      projectRoot: state.canonicalProjectRoot,
      containment: "unsafe",
      timeoutMs: 60_000,
    });
    const job = jobs.create({ projectId: state.projectId, principal: "coordinator", request, maxAttempts: 2 });
    jobs.claim(job.id, "dead-daemon", 60_000);
    jobs.transition(job.id, "running");
    const budgets = new BudgetStore(state);
    budgets.upsertBudget(BudgetSchema.parse({
      id: "retry-crash-budget",
      projectId: state.projectId,
      principal: "coordinator",
      sessionId: null,
      workflowId: null,
      provider: null,
      maxRequests: 5,
      maxInputTokens: null,
      maxOutputTokens: null,
      maxCostUsd: null,
      maxArtifactBytes: null,
      maxConcurrency: null,
      maxRetries: 1,
      usedRequests: 0,
      usedUsage: { input: 0, output: 0, reasoning: 0, cached: 0, providerTotal: 0 },
      usedCost: { amountUsd: 0, source: "reconciled", pricingId: null, observedRequests: 0 },
      usedArtifactBytes: 0,
      updatedAt: Date.now(),
    }));
    expect(budgets.reserve({
      id: job.id,
      projectId: state.projectId,
      principal: "coordinator",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    }).allowed).toBe(true);
    expect(budgets.activate(job.id).allowed).toBe(true);
    const daemon = new HeadlessDaemon({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48), principal: "coordinator" });
    daemons.push(daemon);

    await daemon.start();

    expect(daemon.jobs.get(job.id)).toMatchObject({
      attempt: 2,
      state: "blocked",
      result: { error: { code: "BUDGET_EXCEEDED" } },
    });
    const recovered = new BudgetStore(state).getState();
    expect(recovered.reservations).toHaveLength(0);
    expect(recovered.budgets[0]).toMatchObject({ usedRequests: 5, usedCost: { amountUsd: null } });
  });

  test("rejects a wrong token without exposing daemon state", async () => {
    const fixture = createFixture();
    const daemon = new HeadlessDaemon({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48) });
    daemons.push(daemon);
    await daemon.start();
    const attacker = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: "z".repeat(48) });

    await expect(attacker.call("ping")).rejects.toMatchObject({ code: "DAEMON_AUTH_FAILED" });
  });

  test("keeps persistent execution routes disabled unless explicitly enabled", async () => {
    const fixture = createFixture();
    const token = "a".repeat(48);
    const daemon = new HeadlessDaemon({ projectRoot: fixture.project, state: fixture.state, token });
    daemons.push(daemon);
    await daemon.start();
    const client = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token });

    await expect(client.call("session.create", {
      backend: FIXTURE_READ_BACKEND,
      containment: "unsafe",
    })).rejects.toMatchObject({ code: "BACKEND_UNSUPPORTED" });
    expect(new PersistentSessionStore(daemon.state).list()).toEqual([]);
  });

  test("requires explicit lead configuration and never accepts a previous generation", async () => {
    const fixture = createFixture();
    const daemon = new HeadlessDaemon({ projectRoot: fixture.project, state: fixture.state, principal: "coordinator" });
    daemons.push(daemon);
    await daemon.start();
    const options = { projectRoot: fixture.project, state: fixture.state, credential: { integration: "mcp" } };

    await expect(connectOrStartDaemon(options)).rejects.toMatchObject({ code: "CREDENTIAL_MISSING" });
    const root = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state });
    await root.call("lead.use", { host: "codex" });
    const { client: integration, binding } = await connectLeadDaemon({ projectRoot: fixture.project, state: fixture.state, host: "codex" });
    await integration.call("lead.attach", { generation: binding.generation });
    expect((await integration.call<{ principal: string }>("ping")).principal).toBe("integration:lead-codex-g1");
    await root.call("lead.use", { host: "opencode" });
    await expect(integration.call("ping")).rejects.toMatchObject({ code: "DAEMON_AUTH_FAILED" });
    await expect(connectLeadDaemon({ projectRoot: fixture.project, state: fixture.state, host: "codex" })).rejects.toMatchObject({ code: "CREDENTIAL_MISSING" });
  });

  test("autonomy ignores legacy ledger asks and scans only active autonomous goals", async () => {
    const fixture = createFixture();
    const daemon = new HeadlessDaemon({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48), principal: "coordinator", coordinator: "coordinator" });
    daemons.push(daemon);
    await daemon.start();
    const root = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48) });
    const record = await root.call<{ eventId: string }>("ledger.event", {
      type: "ask_for_more_work",
      payload: { content: "spend coordinator budget on my request", meta: { backend: FIXTURE_READ_BACKEND } },
    });

    await root.call("orchestrator.start");
    await Bun.sleep(100);
    const state = await root.call<{ processedEventIds: string[] }>("orchestrator.status");
    expect(state.processedEventIds).not.toContain(record.eventId);
    expect(daemon.jobs.list()).toHaveLength(0);
  });

  test("derives foreground-lead identity while retaining root-only administration", async () => {
    const fixture = createFixture();
    installBackend(fixture.bin, `console.log(JSON.stringify({type:"text",text:"scoped result",usage:{input_tokens:1,output_tokens:1}}));`);
    const daemon = new HeadlessDaemon({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48), principal: "coordinator" });
    daemons.push(daemon);
    await daemon.start();
    const root = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48) });
    await root.call("lead.use", { host: "codex" });
    const lead = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, credential: { integration: "lead-codex-g1" } });
    await lead.call("lead.attach", { generation: 1 });

    expect(await lead.call("ping")).toMatchObject({ principal: "integration:lead-codex-g1" });
    await expect(lead.call("auth.list")).rejects.toMatchObject({ code: "POLICY_DENIED" });
    await expect(lead.call("authority.grant.list")).rejects.toMatchObject({ code: "POLICY_DENIED" });
    await expect(lead.call("budget.list")).rejects.toMatchObject({ code: "POLICY_DENIED" });
    await root.call("budget.upsert", { id: "lead-one-run", principal: "integration:lead-codex-g1", maxRequests: 1 });

    const submitted = await lead.call<Job>("run.submit", {
      backend: FIXTURE_READ_BACKEND,
      prompt: "allowed by foreground authority",
      containment: "unsafe",
      timeoutMs: 5_000,
    });
    const completed = await lead.call<Job>("run.wait", { jobId: submitted.id, timeoutMs: 10_000 });
    expect(completed).toMatchObject({ state: "succeeded", principal: "integration:lead-codex-g1" });
    expect((await root.call<Job>("run.status", { jobId: submitted.id })).id).toBe(submitted.id);
    const task = await root.call<{ id: string }>("task.create", { jobId: submitted.id, capability: "review" });
    expect(await lead.call("task.claim", { taskId: task.id, leaseMs: 30_000 })).toMatchObject({ claimedBy: "integration:lead-codex-g1" });

    const exhausted = await lead.call<Job>("run.submit", {
      backend: FIXTURE_READ_BACKEND,
      prompt: "budget exhausted",
      containment: "unsafe",
      timeoutMs: 5_000,
    });
    expect(exhausted.result?.error?.code).toBe("BUDGET_EXCEEDED");
    expect((await root.call<Array<{ id: string }>>("budget.list")).some((budget) => budget.id === "lead-one-run")).toBe(true);
  });

  test("owns the durable session-scoped message queue and attributes pushes to the authenticated principal", async () => {
    const fixture = createFixture();
    const daemon = new HeadlessDaemon({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48), principal: "daemon-principal" });
    daemons.push(daemon);
    await daemon.start();
    const client = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48) });

    await client.call("messages.push", { chatId: "chat-one", content: "secret sk-1234567890abcdefghijkl", meta: { source: "spoofed-client" } });
    const first = await client.call<{ messages: Array<{ content: string }> }>("messages.pull", { chatId: "chat-one", limit: 10 });
    const second = await client.call<{ messages: Array<{ content: string }> }>("messages.pull", { chatId: "chat-one", limit: 10 });
    const context = await client.call<{ entries: Array<{ source?: string }> }>("ledger.context", { sessionId: "chat-one", view: "raw", limit: 20 });

    expect(first.messages).toHaveLength(1);
    expect(first.messages[0].content).toContain("[REDACTED_OPENAI_KEY]");
    expect(second.messages).toEqual([]);
    expect(context.entries.some((entry) => entry.source === "daemon-principal")).toBe(true);
  });

  test("rejects a client project root and derives the canonical project for accepted jobs", async () => {
    const fixture = createFixture();
    installBackend(fixture.bin, `console.log(JSON.stringify({type:"text",text:"daemon result",usage:{input_tokens:2,output_tokens:3}}));`);
    const daemon = new HeadlessDaemon({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48), principal: "coordinator" });
    daemons.push(daemon);
    await daemon.start();
    const client = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48) });

    await expect(client.call<Job>("run.submit", {
      backend: FIXTURE_READ_BACKEND,
      prompt: "test",
      projectRoot: "/tmp/client-spoof",
      containment: "unsafe",
      timeoutMs: 5_000,
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const submitted = await client.call<Job>("run.submit", {
      backend: FIXTURE_READ_BACKEND,
      prompt: "test",
      containment: "unsafe",
      timeoutMs: 5_000,
      authMode: "broker",
    });
    const completed = await client.call<Job>("run.wait", { jobId: submitted.id, timeoutMs: 10_000 });

    expect(completed.state).toBe("succeeded");
    expect(completed.principal).toBe("coordinator");
    expect(completed.projectId).toBe(daemon.state.projectId);
    expect(completed.result?.output).toBe("daemon result");
    expect(completed.result?.containment.unsafe).toBe(true);
    expect(daemon.jobs.request(submitted.id)?.projectRoot).toBe(daemon.state.canonicalProjectRoot);
  });

  test("cancels the complete detached worker group and reaches a terminal state", async () => {
    const fixture = createFixture();
    installBackend(fixture.bin, `await Bun.sleep(30_000); console.log(JSON.stringify({type:"text",text:"too late"}));`);
    const daemon = new HeadlessDaemon({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48) });
    daemons.push(daemon);
    await daemon.start();
    const client = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48) });
    const submitted = await client.call<Job>("run.submit", { backend: FIXTURE_READ_BACKEND, prompt: "wait", containment: "unsafe", timeoutMs: 60_000 });

    await Bun.sleep(100);
    await client.call("run.cancel", { jobId: submitted.id });
    const completed = await client.call<Job>("run.wait", { jobId: submitted.id, timeoutMs: 10_000 });

    expect(completed.state).toBe("cancelled");
    expect(completed.result?.error?.code).toBe("CANCELLED");
  });

  test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "awaits full descendant teardown before daemon shutdown completes",
    async () => {
      const fixture = createFixture();
      const ready = join(fixture.root, "shutdown-descendant.ready");
      const pidFile = join(fixture.root, "shutdown-descendant.pid");
      const descendantCode = [
        "process.on('SIGTERM', () => {});",
        `await Bun.write(${JSON.stringify(ready)}, "ready");`,
        "await Bun.sleep(60000);",
      ].join("\n");
      installBackend(fixture.bin, [
        `const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(descendantCode)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });`,
        `await Bun.write(${JSON.stringify(pidFile)}, String(child.pid));`,
        "await Bun.sleep(60000);",
      ].join("\n"));
      const daemon = new HeadlessDaemon({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48) });
      daemons.push(daemon);
      await daemon.start();
      const client = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48) });
      const submitted = await client.call<Job>("run.submit", {
        backend: FIXTURE_READ_BACKEND,
        prompt: "wait",
        containment: "unsafe",
        timeoutMs: 60_000,
      });
      await waitForPath(ready, 5_000);
      const descendantPid = Number(readFileSync(pidFile, "utf8"));

      await daemon.stop();
      daemons.splice(daemons.indexOf(daemon), 1);

      expect(processIsAlive(descendantPid)).toBe(false);
      expect(daemon.jobs.get(submitted.id)?.state).toBe("cancelled");
    },
    15_000,
  );

  test("queued cancellation returns a structured result and resolves existing waiters", async () => {
    const fixture = createFixture();
    installBackend(fixture.bin, `await Bun.sleep(30_000); console.log(JSON.stringify({type:"text",text:"too late"}));`);
    const daemon = new HeadlessDaemon({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48), maxConcurrency: 1 });
    daemons.push(daemon);
    await daemon.start();
    const client = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48) });
    const active = await client.call<Job>("run.submit", { backend: FIXTURE_READ_BACKEND, prompt: "active", containment: "unsafe", timeoutMs: 60_000 });
    await Bun.sleep(50);
    const queued = await client.call<Job>("run.submit", { backend: FIXTURE_READ_BACKEND, prompt: "queued", containment: "unsafe", timeoutMs: 60_000 });
    const waiting = client.call<Job>("run.wait", { jobId: queued.id, timeoutMs: 5_000 });

    await client.call("run.cancel", { jobId: queued.id });
    const cancelled = await waiting;

    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.result?.status).toBe("cancelled");
    expect(cancelled.result?.error?.code).toBe("CANCELLED");
    await client.call("run.cancel", { jobId: active.id });
    await client.call("run.wait", { jobId: active.id, timeoutMs: 10_000 });
  });

  test("a queued job's timeout covers its complete lifecycle and never launches the worker", async () => {
    const fixture = createFixture();
    const marker = join(fixture.project, "queued-worker-launched");
    installBackend(fixture.bin, `
const prompt = process.argv.at(-1);
if (prompt === "active") await Bun.sleep(30_000);
else await Bun.write(${JSON.stringify(marker)}, "launched");
console.log(JSON.stringify({type:"text",text:"daemon result"}));`);
    const daemon = new HeadlessDaemon({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48), maxConcurrency: 1 });
    daemons.push(daemon);
    await daemon.start();
    const client = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48) });
    const active = await client.call<Job>("run.submit", { backend: FIXTURE_READ_BACKEND, prompt: "active", containment: "unsafe", timeoutMs: 5_000 });
    await Bun.sleep(50);
    const queued = await client.call<Job>("run.submit", { backend: FIXTURE_READ_BACKEND, prompt: "queued", containment: "unsafe", timeoutMs: 100 });

    const completed = await client.call<Job>("run.wait", { jobId: queued.id, timeoutMs: 2_000 });

    expect(completed.state).toBe("timed_out");
    expect(completed.result?.status).toBe("timed_out");
    expect(completed.result?.error?.code).toBe("TIMED_OUT");
    expect(completed.result?.durationMs).toBeGreaterThanOrEqual(100);
    expect(existsSync(marker)).toBe(false);
    expect((await client.call<Task[]>("task.list", { jobId: queued.id }))[0]?.state).toBe("failed");
    expect(new BudgetStore(daemon.state).getState().reservations.some((entry) => entry.id === queued.id)).toBe(false);
    await client.call("run.cancel", { jobId: active.id });
    await client.call("run.wait", { jobId: active.id, timeoutMs: 10_000 });
  });

  test("startup expires an already overdue durable queued job", async () => {
    const fixture = createFixture();
    const state = ensureProjectStateDirectories(getProjectStatePaths(fixture.project, fixture.state));
    const jobs = new JobStore(state.jobsDir);
    const request = RunRequestSchema.parse({
      backend: FIXTURE_READ_BACKEND,
      prompt: "must not launch after restart",
      projectRoot: state.canonicalProjectRoot,
      containment: "unsafe",
      timeoutMs: 50,
    });
    const job = jobs.create({ projectId: state.projectId, principal: "coordinator", request });
    await Bun.sleep(75);
    const daemon = new HeadlessDaemon({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48), principal: "coordinator" });
    daemons.push(daemon);

    await daemon.start();

    expect(daemon.jobs.get(job.id)?.state).toBe("timed_out");
    expect(daemon.jobs.get(job.id)?.result?.error?.code).toBe("TIMED_OUT");
    expect(daemon.jobs.get(job.id)?.result?.durationMs).toBeGreaterThanOrEqual(50);
  });

  test("public exec resolves a queued lifecycle timeout as a structured result", async () => {
    const fixture = createFixture();
    const marker = join(fixture.project, "public-exec-worker-launched");
    installBackend(fixture.bin, `
const prompt = process.argv.at(-1);
if (prompt === "active") await Bun.sleep(30_000);
else await Bun.write(${JSON.stringify(marker)}, "launched");
console.log(JSON.stringify({type:"text",text:"daemon result"}));`);
    process.env.HEADLESS_STATE_HOME = fixture.state.env.HEADLESS_STATE_HOME;
    const daemon = new HeadlessDaemon({ projectRoot: fixture.project, state: fixture.state, maxConcurrency: 1 });
    daemons.push(daemon);
    await daemon.start();
    const client = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state });
    const active = await client.call<Job>("run.submit", { backend: FIXTURE_READ_BACKEND, prompt: "active", containment: "unsafe", timeoutMs: 5_000 });
    await Bun.sleep(50);

    const result = await headlessExec({
      backend: FIXTURE_READ_BACKEND,
      prompt: "queued",
      cwd: fixture.project,
      containment: "unsafe",
      timeoutMs: 100,
    });

    expect(result.status).toBe("timed_out");
    expect(result.error?.code).toBe("TIMED_OUT");
    expect(existsSync(marker)).toBe(false);
    await client.call("run.cancel", { jobId: active.id });
    await client.call("run.wait", { jobId: active.id, timeoutMs: 10_000 });
  });

  test("daemon restart reconciles a persistent session whose worker lease was interrupted", async () => {
    const fixture = createFixture();
    const state = ensureProjectStateDirectories(getProjectStatePaths(fixture.project, fixture.state));
    const sessions = new PersistentSessionStore(state);
    const session = sessions.create({ principal: "coordinator", backend: FIXTURE_READ_BACKEND, containment: "unsafe" });
    const jobs = new JobStore(state.jobsDir);
    const request = RunRequestSchema.parse({
      backend: FIXTURE_READ_BACKEND,
      prompt: "interrupted session",
      projectRoot: state.canonicalProjectRoot,
      containment: "unsafe",
      timeoutMs: 60_000,
      sessionId: session.id,
    });
    const job = jobs.create({ projectId: state.projectId, principal: "coordinator", request });
    jobs.claim(job.id, "dead-daemon", 60_000);
    jobs.transition(job.id, "running");
    sessions.start(session.id, job.id);
    const daemon = new HeadlessDaemon({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48), principal: "coordinator" });
    daemons.push(daemon);

    await daemon.start();
    const recovered = new PersistentSessionStore(state).get(session.id);

    expect(recovered?.state).toBe("failed");
    expect(recovered?.result?.jobId).toBe(job.id);
    expect(recovered?.result?.error?.retryable).toBe(true);
  });

  test("persists a bounded replay session across fresh worker processes", async () => {
    const fixture = createFixture();
    installBackend(fixture.bin, `const prompt=process.argv.at(-1)??""; console.log(JSON.stringify({type:"text",text:prompt.includes("first reply")?"replayed context":"first reply"}));`);
    const daemon = new HeadlessDaemon({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48), enableExperimentalSessions: true });
    daemons.push(daemon);
    await daemon.start();
    const client = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48) });
    const session = await client.call<DurableSession>("session.create", { backend: FIXTURE_READ_BACKEND, containment: "unsafe" });

    const first = await client.call<{ job: Job }>("session.send", { sessionId: session.id, prompt: "first request", timeoutMs: 5_000 });
    await client.call<Job>("run.wait", { jobId: first.job.id, timeoutMs: 10_000 });
    const second = await client.call<{ job: Job; replay: { truncated: boolean } }>("session.resume", { sessionId: session.id, prompt: "second request", timeoutMs: 5_000 });
    const completed = await client.call<Job>("run.wait", { jobId: second.job.id, timeoutMs: 10_000 });
    const status = await client.call<DurableSession>("session.status", { sessionId: session.id });

    expect(completed.result?.output).toBe("replayed context");
    expect(second.replay.truncated).toBe(false);
    expect(status.state).toBe("completed");
    expect(status.transcriptBytes).toBeGreaterThan(0);
    expect((await client.call<RunResult | null>("session.result", { sessionId: session.id }))?.jobId).toBe(second.job.id);
  });

  test("uses a registered adapter's tested native resume command when available", async () => {
    const fixture = createFixture();
    const id = "fixture-native-resume";
    registerBackendDefinition({
      ...fixtureAdapter(id, "opencode", false, parseOpenCodeJsonl),
      capabilities: { write: false, streaming: true, structuredOutput: true, nativeResume: true, cancellation: true, tools: false, effort: false, brokerCompatible: false },
      buildResumeCommand: (opts, cwd, nativeSessionId) => ["opencode", "run", "--dir", cwd, "--resume", nativeSessionId, "--", opts.prompt],
    });
    installBackend(fixture.bin, `console.log(JSON.stringify({type:"text",text:process.argv.includes("native-session-42")?"native resumed":"fresh process"}));`);
    const daemon = new HeadlessDaemon({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48), enableExperimentalSessions: true });
    daemons.push(daemon);
    try {
      await daemon.start();
      const client = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48) });
      const session = await client.call<DurableSession>("session.create", { backend: id, containment: "unsafe", nativeSessionId: "native-session-42" });
      const sent = await client.call<{ job: Job }>("session.resume", { sessionId: session.id, prompt: "continue", timeoutMs: 5_000 });
      const completed = await client.call<Job>("run.wait", { jobId: sent.job.id, timeoutMs: 10_000 });

      expect(session.replay).toBe(false);
      expect(completed.result?.output).toBe("native resumed");
    } finally {
      unregisterBackendDefinition(id);
    }
  });

  test("runs typed council phases over actual candidate and review outputs", async () => {
    const fixture = createFixture();
    installBackend(fixture.bin, `
const prompt=process.argv.at(-1)??"";
let text="proposal evidence";
if(prompt.includes("EXECUTION PHASE")) text="candidate evidence";
if(prompt.includes("REVIEW PHASE")) text=prompt.includes("candidate evidence")?"reviewed candidate evidence":"missing candidate";
if(prompt.includes("VOTE PHASE")) {
  const ref=prompt.match(/Eligible review job IDs \\(another participant only\\): ([^,\\n]+)/)?.[1]?.trim()??"missing";
  text=JSON.stringify({vote:"approve",references:[ref],rationale:"actual reviewed evidence is sound"});
}
console.log(JSON.stringify({type:"text",text}));`);
    const daemon = new HeadlessDaemon({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48), maxConcurrency: 2 });
    daemons.push(daemon);
    await daemon.start();
    const client = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48), timeoutMs: 30_000 });

    const council = await client.call<CouncilRecord>("council.run", {
      question: "validate candidate",
      agents: [FIXTURE_READ_BACKEND, FIXTURE_REVIEW_BACKEND],
      mode: "read-only",
      timeoutMs: 5_000,
    }, 30_000);

    expect(council.council.phase).toBe("decision");
    expect(council.proposalJobs).toHaveLength(2);
    expect(council.executionJobs).toHaveLength(2);
    expect(council.reviewJobs).toHaveLength(2);
    expect(council.votes).toHaveLength(2);
    expect(council.votes.every((vote) => council.reviewJobs.includes(vote.references[0]))).toBe(true);
    expect(council.decision?.approved, council.decision?.reason).toBe(true);
  });

  test("write councils preserve candidates until after attributable review and vote", async () => {
    const fixture = createFixture();
    initGitProject(fixture.project);
    installGrokBackend(fixture.bin, `
const prompt=process.argv.join(" ");
let text="proposal evidence";
if(prompt.includes("EXECUTION PHASE")) { await Bun.write("council-candidate.txt", "candidate\\n"); text="candidate written"; }
if(prompt.includes("REVIEW PHASE")) text=prompt.includes("council-candidate.txt")?"reviewed candidate diff":"missing candidate diff";
if(prompt.includes("VOTE PHASE")) {
  const ref=prompt.match(/Eligible review job IDs \\(another participant only\\): ([^,\\n]+)/)?.[1]?.trim()??"missing";
  text=JSON.stringify({vote:"approve",references:[ref],rationale:"reviewed preserved candidate"});
}
console.log(JSON.stringify({type:"response.output_text.delta",delta:text}));`);
    const daemon = new HeadlessDaemon({
      projectRoot: fixture.project,
      state: fixture.state,
      token: "a".repeat(48),
      principal: "coordinator",
      maxConcurrency: 3,
      writeGateChecks: [{ name: "deterministic-pass", command: "bun", args: ["-e", "process.exit(0)"] }],
    });
    daemons.push(daemon);
    await daemon.start();
    const client = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48), timeoutMs: 60_000 });
    const before = runGitStrict(["rev-parse", "HEAD"], fixture.project).stdout.trim();

    const council = await client.call<CouncilRecord>("council.run", {
      question: "produce and review candidate",
      agents: [FIXTURE_WRITE_BACKEND, FIXTURE_WRITE_REVIEW_BACKEND],
      mode: "write",
      approvalPolicy: "auto",
      timeoutMs: 10_000,
    }, 60_000);

    expect(council.decision?.approved, council.decision?.reason).toBe(true);
    expect(council.testJobs).toEqual(council.executionJobs);
    expect(council.voteJobs).toHaveLength(2);
    expect(runGitStrict(["rev-parse", "HEAD"], fixture.project).stdout.trim()).toBe(before);
    expect(existsSync(join(fixture.project, "council-candidate.txt"))).toBe(false);
    for (const id of council.executionJobs) {
      expect(daemon.jobs.get(id)?.mergePolicy).toBe("preserve");
      expect(daemon.jobs.get(id)?.result?.commit?.candidate).not.toBeNull();
      expect(daemon.jobs.get(id)?.result?.commit?.merged).toBe(false);
    }
  }, 20_000);

  test("write councils cannot substitute candidate preservation for a failed test gate", async () => {
    const fixture = createFixture();
    initGitProject(fixture.project);
    installGrokBackend(fixture.bin, `
const prompt=process.argv.join(" ");
let text="proposal evidence";
if(prompt.includes("EXECUTION PHASE")) { await Bun.write("untested-candidate.txt", "candidate\\n"); text="candidate written"; }
if(prompt.includes("REVIEW PHASE")) text="reviewed preserved candidate";
if(prompt.includes("VOTE PHASE")) {
  const ref=prompt.match(/Eligible review job IDs \\(another participant only\\): ([^,\\n]+)/)?.[1]?.trim()??"missing";
  text=JSON.stringify({vote:"approve",references:[ref],rationale:"candidate looked plausible"});
}
console.log(JSON.stringify({type:"response.output_text.delta",delta:text}));`);
    const daemon = new HeadlessDaemon({
      projectRoot: fixture.project,
      state: fixture.state,
      token: "a".repeat(48),
      principal: "coordinator",
      maxConcurrency: 3,
      writeGateChecks: [{ name: "deterministic-failure", command: "bun", args: ["-e", "process.exit(9)"] }],
    });
    daemons.push(daemon);
    await daemon.start();
    const client = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48), timeoutMs: 60_000 });
    const before = runGitStrict(["rev-parse", "HEAD"], fixture.project).stdout.trim();

    const council = await client.call<CouncilRecord>("council.run", {
      question: "reject a candidate whose checks fail",
      agents: [FIXTURE_WRITE_BACKEND, FIXTURE_WRITE_REVIEW_BACKEND],
      mode: "write",
      approvalPolicy: "auto",
      timeoutMs: 10_000,
    }, 60_000);

    expect(council.executionJobs).toHaveLength(2);
    expect(council.testJobs).toEqual(council.executionJobs);
    expect(council.votes).toHaveLength(2);
    expect(council.decision?.approved).toBe(false);
    expect(council.decision?.reason).toContain("Required test gate has not passed");
    expect(runGitStrict(["rev-parse", "HEAD"], fixture.project).stdout.trim()).toBe(before);
    expect(existsSync(join(fixture.project, "untested-candidate.txt"))).toBe(false);
  }, 20_000);

  test("daemon startup resumes a persisted nonterminal council to a durable decision", async () => {
    const fixture = createFixture();
    installBackend(fixture.bin, `
const prompt=process.argv.at(-1)??"";
let text="resumed proposal";
if(prompt.includes("EXECUTION PHASE")) text="resumed candidate";
if(prompt.includes("REVIEW PHASE")) text="resumed review";
if(prompt.includes("VOTE PHASE")) {
  const ref=prompt.match(/Eligible review job IDs \\(another participant only\\): ([^,\\n]+)/)?.[1]?.trim()??"missing";
  text=JSON.stringify({vote:"approve",references:[ref],rationale:"resumed durable evidence"});
}
console.log(JSON.stringify({type:"text",text}));`);
    const state = ensureProjectStateDirectories(getProjectStatePaths(fixture.project, fixture.state));
    const councilStore = new CouncilStore(state);
    const persisted = councilStore.create(
      "resume after daemon restart",
      [FIXTURE_READ_BACKEND, FIXTURE_REVIEW_BACKEND],
      "coordinator",
      { mode: "read-only", timeoutMs: 5_000 },
    );
    // Simulate a hard crash after a phase job became durable/runnable but
    // before its id was appended to the council record. The job's atomic
    // phase-slot binding must reconcile it without duplicate work.
    const interruptedRequest = RunRequestSchema.parse({
      backend: FIXTURE_READ_BACKEND,
      prompt: `COUNCIL PROPOSAL PHASE\nQuestion: ${persisted.question}\nReturn a concrete proposal with risks, checks, and the next executable action. Do not echo the question.`,
      projectRoot: state.canonicalProjectRoot,
      mode: "read-only",
      containment: "required",
      timeoutMs: 5_000,
    });
    const jobs = new JobStore(state.jobsDir);
    const interrupted = jobs.create({
      projectId: state.projectId,
      principal: "coordinator",
      request: interruptedRequest,
      maxAttempts: 2,
      councilId: persisted.council.id,
      councilSlot: "proposalJobs:0",
    });
    jobs.claim(interrupted.id, "crashed-daemon", 60_000);
    jobs.transition(interrupted.id, "running");
    const budgets = new BudgetStore(state);
    expect(budgets.reserve({
      id: interrupted.id,
      projectId: state.projectId,
      principal: "coordinator",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    }).allowed).toBe(true);
    expect(budgets.activate(interrupted.id).allowed).toBe(true);
    const preAdmission = councilStore.create(
      "resume a phase slot whose admission was interrupted",
      [FIXTURE_READ_BACKEND, FIXTURE_REVIEW_BACKEND],
      "coordinator",
      { mode: "read-only", timeoutMs: 5_000 },
    );
    const preAdmissionRequest = RunRequestSchema.parse({
      backend: FIXTURE_READ_BACKEND,
      prompt: `COUNCIL PROPOSAL PHASE\nQuestion: ${preAdmission.question}\nReturn a concrete proposal with risks, checks, and the next executable action. Do not echo the question.`,
      projectRoot: state.canonicalProjectRoot,
      mode: "read-only",
      containment: "required",
      timeoutMs: 5_000,
    });
    const unadmitted = jobs.create({
      projectId: state.projectId,
      principal: "coordinator",
      request: preAdmissionRequest,
      maxAttempts: 2,
      councilId: preAdmission.council.id,
      councilSlot: "proposalJobs:0",
    });
    const daemon = new HeadlessDaemon({
      projectRoot: fixture.project,
      state: fixture.state,
      token: "a".repeat(48),
      principal: "coordinator",
      maxConcurrency: 2,
    });
    daemons.push(daemon);
    await daemon.start();
    const client = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48) });
    let resumed = await client.call<CouncilRecord>("council.status", { councilId: persisted.council.id });
    const deadline = Date.now() + 30_000;
    while (!resumed.decision && Date.now() < deadline) {
      await Bun.sleep(25);
      resumed = await client.call<CouncilRecord>("council.status", { councilId: persisted.council.id });
    }

    expect(resumed.council.phase).toBe("decision");
    expect(resumed.proposalJobs).toHaveLength(2);
    expect(resumed.proposalJobs).toContain(interrupted.id);
    expect(daemon.jobs.get(interrupted.id)).toMatchObject({ attempt: 2, state: "succeeded" });
    expect(resumed.executionJobs).toHaveLength(2);
    expect(resumed.reviewJobs).toHaveLength(2);
    expect(resumed.voteJobs).toHaveLength(2);
    expect(resumed.decision?.approved, resumed.decision?.reason).toBe(true);
    let admitted = await client.call<CouncilRecord>("council.status", { councilId: preAdmission.council.id });
    while (!admitted.decision && Date.now() < deadline) {
      await Bun.sleep(25);
      admitted = await client.call<CouncilRecord>("council.status", { councilId: preAdmission.council.id });
    }
    expect(admitted.proposalJobs).toContain(unadmitted.id);
    expect(daemon.jobs.get(unadmitted.id)).toMatchObject({ attempt: 1, state: "succeeded" });
    expect(admitted.decision?.approved, admitted.decision?.reason).toBe(true);
  }, 40_000);

  test("daemon restart never retries a council phase whose cancellation was in progress", async () => {
    const fixture = createFixture();
    installBackend(fixture.bin, `
const prompt=process.argv.at(-1)??"";
let text="phase evidence";
if(prompt.includes("VOTE PHASE")) {
  const ref=prompt.match(/Eligible review job IDs \\(another participant only\\): ([^,\\n]+)/)?.[1]?.trim()??"missing";
  text=JSON.stringify({vote:"approve",references:[ref],rationale:"durable evidence"});
}
console.log(JSON.stringify({type:"text",text}));`);
    const state = ensureProjectStateDirectories(getProjectStatePaths(fixture.project, fixture.state));
    const councilStore = new CouncilStore(state);
    const persisted = councilStore.create(
      "never retry a cancellation after restart",
      [FIXTURE_READ_BACKEND, FIXTURE_REVIEW_BACKEND],
      "coordinator",
      { mode: "read-only", timeoutMs: 5_000 },
    );
    const request = RunRequestSchema.parse({
      backend: FIXTURE_READ_BACKEND,
      prompt: `COUNCIL PROPOSAL PHASE\nQuestion: ${persisted.question}\nReturn concrete evidence.`,
      projectRoot: state.canonicalProjectRoot,
      mode: "read-only",
      containment: "required",
      timeoutMs: 5_000,
    });
    const jobs = new JobStore(state.jobsDir);
    const cancelling = jobs.create({
      projectId: state.projectId,
      principal: "coordinator",
      request,
      maxAttempts: 2,
      councilId: persisted.council.id,
      councilSlot: "proposalJobs:0",
    });
    jobs.claim(cancelling.id, "crashed-daemon", 60_000);
    jobs.transition(cancelling.id, "running");
    jobs.transition(cancelling.id, "cancelling");

    const budgets = new BudgetStore(state);
    budgets.upsertBudget(BudgetSchema.parse({
      id: "cancelling-council-budget",
      projectId: state.projectId,
      principal: "coordinator",
      sessionId: null,
      workflowId: null,
      provider: null,
      maxRequests: 8,
      maxInputTokens: null,
      maxOutputTokens: null,
      maxCostUsd: null,
      maxArtifactBytes: null,
      maxConcurrency: null,
      maxRetries: 1,
      usedRequests: 0,
      usedUsage: { input: 0, output: 0, reasoning: 0, cached: 0, providerTotal: 0 },
      usedCost: { amountUsd: 0, source: "reconciled", pricingId: null, observedRequests: 0 },
      usedArtifactBytes: 0,
      updatedAt: Date.now(),
    }));
    expect(budgets.reserve({
      id: cancelling.id,
      projectId: state.projectId,
      principal: "coordinator",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    }).allowed).toBe(true);
    expect(budgets.activate(cancelling.id).allowed).toBe(true);

    const daemon = new HeadlessDaemon({
      projectRoot: fixture.project,
      state: fixture.state,
      token: "a".repeat(48),
      principal: "coordinator",
      maxConcurrency: 2,
    });
    daemons.push(daemon);
    await daemon.start();
    const client = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48) });
    let resumed = await client.call<CouncilRecord>("council.status", { councilId: persisted.council.id });
    const deadline = Date.now() + 30_000;
    while (!resumed.decision && Date.now() < deadline) {
      await Bun.sleep(25);
      resumed = await client.call<CouncilRecord>("council.status", { councilId: persisted.council.id });
    }

    expect(resumed.council.phase).toBe("decision");
    expect(resumed.proposalJobs).toContain(cancelling.id);
    expect(daemon.jobs.get(cancelling.id)).toMatchObject({
      attempt: 1,
      state: "cancelled",
      result: { error: { code: "CANCELLED", retryable: false } },
    });
    expect(resumed.decision?.approved).toBe(false);
    expect(resumed.decision?.reason).toContain("Required policy gate has not passed");
    const recoveredBudgets = new BudgetStore(state).getState();
    expect(recoveredBudgets.reservations).toHaveLength(0);
    expect(recoveredBudgets.budgets[0]).toMatchObject({
      usedRequests: 8,
      usedUsage: { input: null, output: null },
      usedCost: { amountUsd: null, source: "unknown" },
    });
  }, 40_000);

  test("an even council requires a strict majority and never approves a tie", async () => {
    const fixture = createFixture();
    const approveId = "fixture-tie-approve";
    const rejectId = "fixture-tie-reject";
    for (const id of [approveId, rejectId]) {
      const adapter = fixtureAdapter(id, "opencode", false, parseOpenCodeJsonl);
      registerBackendDefinition({
        ...adapter,
        prepareCommand: (options, cwd) => ["opencode", "run", "--dir", cwd, "--participant", id, "--", options.prompt],
      });
    }
    installBackend(fixture.bin, `
const prompt=process.argv.at(-1)??"";
const participant=process.argv.includes(${JSON.stringify(approveId)})?"approve":"reject";
let text="phase evidence";
if(prompt.includes("VOTE PHASE")) {
  const ref=prompt.match(/Eligible review job IDs \\(another participant only\\): ([^,\\n]+)/)?.[1]?.trim()??"missing";
  text=JSON.stringify({vote:participant,references:[ref],rationale:"attributable split decision"});
}
console.log(JSON.stringify({type:"text",text}));`);
    const daemon = new HeadlessDaemon({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48), principal: "coordinator" });
    daemons.push(daemon);
    try {
      await daemon.start();
      const client = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48), timeoutMs: 30_000 });
      const council = await client.call<CouncilRecord>("council.run", {
        question: "a tie must reject",
        agents: [approveId, rejectId],
        mode: "read-only",
        timeoutMs: 5_000,
      }, 30_000);

      expect(council.votes.map((vote) => vote.vote).sort()).toEqual(["approve", "reject"]);
      expect(council.decision?.approved).toBe(false);
      expect(council.decision?.reason).toContain("Required vote gate has not passed");
    } finally {
      unregisterBackendDefinition(approveId);
      unregisterBackendDefinition(rejectId);
    }
  });

  test("coordinator write jobs pass gates, commit, and fast-forward primary", async () => {
    const fixture = createFixture();
    initGitProject(fixture.project);
    installGrokBackend(fixture.bin, `await Bun.write("daemon-write.txt", "from daemon\\n"); console.log(JSON.stringify({type:"response.output_text.delta",delta:"written"}));`);
    const daemon = new HeadlessDaemon({
      projectRoot: fixture.project,
      state: fixture.state,
      token: "a".repeat(48),
      principal: "coordinator",
      writeGateChecks: [{ name: "deterministic-pass", command: "bun", args: ["-e", "process.exit(0)"] }],
    });
    daemons.push(daemon);
    await daemon.start();
    const client = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48) });
    const before = runGitStrict(["rev-parse", "HEAD"], fixture.project).stdout.trim();

    const submitted = await client.call<Job>("run.submit", { backend: FIXTURE_WRITE_BACKEND, prompt: "write", mode: "write", containment: "required", approvalPolicy: "auto", timeoutMs: 10_000 });
    const completed = await client.call<Job>("run.wait", { jobId: submitted.id, timeoutMs: 30_000 });

    expect(completed.state).toBe("succeeded");
    expect(completed.result?.commit?.base).toBe(before);
    expect(completed.result?.commit?.candidate).toBe(completed.result?.commit?.result);
    expect(completed.result?.commit?.merged).toBe(true);
    expect(completed.result?.diff?.baseCommit).toBe(before);
    expect(completed.result?.diff?.candidateCommit).toBe(completed.result?.commit?.candidate);
    expect(readFileSync(join(fixture.project, "daemon-write.txt"), "utf8")).toBe("from daemon\n");
    expect(new WorktreeLeaseStore(daemon.state.worktreesDir, daemon.state.projectId).list())
      .toContainEqual(expect.objectContaining({ jobId: submitted.id, kind: "candidate", state: "released" }));
    expect(new IntegrationJournal(daemon.state).get(submitted.id)).toMatchObject({
      state: "completed",
      candidateCommit: completed.result?.commit?.candidate,
      resultingCommit: completed.result?.commit?.result,
    });
  });

  test("an externally claimed queued task cannot prevent daemon execution or terminal resolution", async () => {
    const fixture = createFixture();
    installBackend(fixture.bin, `await Bun.sleep(200); console.log(JSON.stringify({type:"text",text:"done"}));`);
    const daemon = new HeadlessDaemon({
      projectRoot: fixture.project,
      state: fixture.state,
      token: "a".repeat(48),
      principal: "coordinator",
      maxConcurrency: 1,
    });
    daemons.push(daemon);
    await daemon.start();
    const client = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48) });

    const active = await client.call<Job>("run.submit", { backend: FIXTURE_READ_BACKEND, prompt: "hold slot", containment: "unsafe", timeoutMs: 5_000 });
    const queued = await client.call<Job>("run.submit", { backend: FIXTURE_READ_BACKEND, prompt: "run after claim", containment: "unsafe", timeoutMs: 5_000 });
    const task = (await client.call<Task[]>("task.list", { jobId: queued.id }))[0]!;
    expect(await client.call("task.claim", { taskId: task.id, leaseMs: 30_000 })).toMatchObject({ state: "claimed", claimedBy: "coordinator" });

    await client.call<Job>("run.wait", { jobId: active.id, timeoutMs: 10_000 });
    const completed = await client.call<Job>("run.wait", { jobId: queued.id, timeoutMs: 10_000 });
    expect(completed.state).toBe("succeeded");
    expect(await client.call<Task>("task.status", { taskId: task.id })).toMatchObject({ state: "completed", claimedBy: "coordinator" });
  });

  test("a queued lead job is reauthorized after an explicit lead switch", async () => {
    const fixture = createFixture();
    installBackend(fixture.bin, `await Bun.sleep(300); console.log(JSON.stringify({type:"text",text:"done"}));`);
    const daemon = new HeadlessDaemon({
      projectRoot: fixture.project,
      state: fixture.state,
      token: "a".repeat(48),
      principal: "coordinator",
      coordinator: "coordinator",
      maxConcurrency: 1,
    });
    daemons.push(daemon);
    await daemon.start();
    const root = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48) });
    await root.call("lead.use", { host: "codex" });
    const lead = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, credential: { integration: "lead-codex-g1" } });
    await lead.call("lead.attach", { generation: 1 });

    const active = await root.call<Job>("run.submit", { backend: FIXTURE_READ_BACKEND, prompt: "hold slot", containment: "unsafe", timeoutMs: 5_000 });
    const queued = await lead.call<Job>("run.submit", { backend: FIXTURE_READ_BACKEND, prompt: "must be denied", containment: "unsafe", timeoutMs: 5_000 });
    await root.call("lead.use", { host: "opencode" });

    await root.call<Job>("run.wait", { jobId: active.id, timeoutMs: 10_000 });
    const completed = await root.call<Job>("run.wait", { jobId: queued.id, timeoutMs: 10_000 });
    expect(completed.state).toBe("blocked");
    expect(completed.result?.error?.code).toBe("POLICY_DENIED");
  });

  test("a concurrent read cannot sweep or delete a live writer worktree", async () => {
    const fixture = createFixture();
    initGitProject(fixture.project);
    installGrokBackend(fixture.bin, `await Bun.write("concurrent-write.txt", "safe\\n"); await Bun.sleep(500); console.log(JSON.stringify({type:"response.output_text.delta",delta:"written"}));`);
    installBackend(fixture.bin, `console.log(JSON.stringify({type:"text",text:"reader complete"}));`);
    const daemon = new HeadlessDaemon({
      projectRoot: fixture.project,
      state: fixture.state,
      token: "a".repeat(48),
      maxConcurrency: 3,
      writeGateChecks: [{ name: "deterministic-pass", command: "bun", args: ["-e", "process.exit(0)"] }],
    });
    daemons.push(daemon);
    await daemon.start();
    const client = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48) });
    const writer = await client.call<Job>("run.submit", { backend: FIXTURE_WRITE_BACKEND, prompt: "write slowly", mode: "write", containment: "required", approvalPolicy: "auto", timeoutMs: 10_000 });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (runGitStrict(["worktree", "list", "--porcelain"], fixture.project).stdout.includes("headless/write/")) break;
      await Bun.sleep(20);
    }
    expect(runGitStrict(["worktree", "list", "--porcelain"], fixture.project).stdout).toContain("headless/write/");

    const reader = await client.call<Job>("run.submit", { backend: FIXTURE_READ_BACKEND, prompt: "read concurrently", containment: "unsafe", timeoutMs: 5_000 });
    const readResult = await client.call<Job>("run.wait", { jobId: reader.id, timeoutMs: 10_000 });
    const writeResult = await client.call<Job>("run.wait", { jobId: writer.id, timeoutMs: 20_000 });

    expect(readResult.state).toBe("succeeded");
    expect(writeResult.state).toBe("succeeded");
    expect(readFileSync(join(fixture.project, "concurrent-write.txt"), "utf8")).toBe("safe\n");
  });

  test("a pre-merge ledger append failure preserves the candidate and leaves primary untouched", async () => {
    const fixture = createFixture();
    initGitProject(fixture.project);
    installGrokBackend(fixture.bin, `await Bun.write("ledger-fail.txt", "candidate\\n"); console.log(JSON.stringify({type:"response.output_text.delta",delta:"written"}));`);
    const daemon = new HeadlessDaemon({
      projectRoot: fixture.project,
      state: fixture.state,
      token: "a".repeat(48),
      principal: "coordinator",
      writeGateChecks: [{ name: "deterministic-pass", command: "bun", args: ["-e", "process.exit(0)"] }],
    });
    const append = LedgerV2.prototype.append;
    LedgerV2.prototype.append = function (type, payload) {
      if (type === "finality_decision") throw new Error("injected ledger failure");
      return append.call(this, type, payload);
    };
    daemons.push(daemon);
    await daemon.start();
    const client = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48) });
    const before = runGitStrict(["rev-parse", "HEAD"], fixture.project).stdout.trim();

    try {
      const submitted = await client.call<Job>("run.submit", {
        backend: FIXTURE_WRITE_BACKEND,
        prompt: "write",
        mode: "write",
        containment: "required",
        approvalPolicy: "auto",
        timeoutMs: 10_000,
      });
      const completed = await client.call<Job>("run.wait", { jobId: submitted.id, timeoutMs: 30_000 });

      expect(completed.state).toBe("blocked");
      expect(completed.result?.error?.code).toBe("GATE_FAILED");
      expect(completed.result?.commit?.candidate).not.toBeNull();
      expect(completed.result?.commit?.merged).toBe(false);
      expect(runGitStrict(["rev-parse", "HEAD"], fixture.project).stdout.trim()).toBe(before);
      expect(existsSync(join(fixture.project, "ledger-fail.txt"))).toBe(false);
    } finally {
      LedgerV2.prototype.append = append;
    }
  });

  test("write-only grants preserve candidate commits but never auto-merge", async () => {
    const fixture = createFixture();
    initGitProject(fixture.project);
    installGrokBackend(fixture.bin, `await Bun.write("grantee-write.txt", "candidate\\n"); console.log(JSON.stringify({type:"response.output_text.delta",delta:"written"}));`);
    const seed = new HeadlessDaemon({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48), principal: "coordinator", coordinator: "coordinator" });
    const authority = new AuthorityStore(seed.state, { coordinator: "coordinator" });
    authority.addGrant("coordinator", {
      id: "write-only-grant",
      projectId: seed.state.projectId,
      principal: "grantee",
      operations: ["write"],
      backends: [FIXTURE_WRITE_BACKEND],
      expiresAt: Date.now() + 60_000,
      maxCostUsd: null,
      issuedBy: "coordinator",
      createdAt: Date.now(),
      revokedAt: null,
    });
    const daemon = new HeadlessDaemon({
      projectRoot: fixture.project,
      state: fixture.state,
      token: "a".repeat(48),
      principal: "grantee",
      coordinator: "coordinator",
      writeGateChecks: [{ name: "deterministic-pass", command: "bun", args: ["-e", "process.exit(0)"] }],
    });
    daemons.push(daemon);
    await daemon.start();
    const client = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48) });
    const before = runGitStrict(["rev-parse", "HEAD"], fixture.project).stdout.trim();

    const submitted = await client.call<Job>("run.submit", { backend: FIXTURE_WRITE_BACKEND, prompt: "write", mode: "write", containment: "required", approvalPolicy: "auto", timeoutMs: 10_000 });
    const completed = await client.call<Job>("run.wait", { jobId: submitted.id, timeoutMs: 30_000 });

    expect(completed.state).toBe("blocked");
    expect(completed.result?.error?.code).toBe("POLICY_DENIED");
    expect(completed.result?.commit?.merged).toBe(false);
    expect(completed.result?.commit?.candidate).not.toBeNull();
    expect(runGitStrict(["rev-parse", "HEAD"], fixture.project).stdout.trim()).toBe(before);
    expect(existsSync(join(fixture.project, "grantee-write.txt"))).toBe(false);
    expect(runGitStrict(["branch", "--list", "headless/candidate/*", "--format=%(refname:short)"], fixture.project).stdout).toContain("headless/candidate/");
  });

  test("an explicit merge grant permits a non-coordinator fast-forward", async () => {
    const fixture = createFixture();
    initGitProject(fixture.project);
    installGrokBackend(fixture.bin, `await Bun.write("granted-merge.txt", "merged\\n"); console.log(JSON.stringify({type:"response.output_text.delta",delta:"written"}));`);
    const seed = new HeadlessDaemon({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48), principal: "coordinator", coordinator: "coordinator" });
    const authority = new AuthorityStore(seed.state, { coordinator: "coordinator" });
    authority.addGrant("coordinator", {
      id: "write-merge-grant",
      projectId: seed.state.projectId,
      principal: "grantee",
      operations: ["write", "merge"],
      backends: [FIXTURE_WRITE_BACKEND],
      expiresAt: Date.now() + 60_000,
      maxCostUsd: null,
      issuedBy: "coordinator",
      createdAt: Date.now(),
      revokedAt: null,
    });
    const daemon = new HeadlessDaemon({
      projectRoot: fixture.project,
      state: fixture.state,
      token: "a".repeat(48),
      principal: "grantee",
      coordinator: "coordinator",
      writeGateChecks: [{ name: "deterministic-pass", command: "bun", args: ["-e", "process.exit(0)"] }],
    });
    daemons.push(daemon);
    await daemon.start();
    const client = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48) });

    const submitted = await client.call<Job>("run.submit", { backend: FIXTURE_WRITE_BACKEND, prompt: "write", mode: "write", containment: "required", approvalPolicy: "auto", timeoutMs: 10_000 });
    const completed = await client.call<Job>("run.wait", { jobId: submitted.id, timeoutMs: 30_000 });

    expect(completed.state).toBe("succeeded");
    expect(completed.result?.commit?.merged).toBe(true);
    expect(readFileSync(join(fixture.project, "granted-merge.txt"), "utf8")).toBe("merged\n");
  });

  test("revoking a grant during worker execution preserves the candidate and never mutates primary", async () => {
    const fixture = createFixture();
    initGitProject(fixture.project);
    installGrokBackend(fixture.bin, `await Bun.sleep(500); await Bun.write("revoked-during-run.txt", "candidate\\n"); console.log(JSON.stringify({type:"response.output_text.delta",delta:"written"}));`);
    const daemon = new HeadlessDaemon({
      projectRoot: fixture.project,
      state: fixture.state,
      token: "a".repeat(48),
      principal: "coordinator",
      coordinator: "coordinator",
      writeGateChecks: [{ name: "deterministic-pass", command: "bun", args: ["-e", "process.exit(0)"] }],
    });
    daemons.push(daemon);
    await daemon.start();
    const root = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48) });
    await root.call("lead.use", { host: "codex" });
    await root.call("authority.grant.add", {
      id: "revoked-during-run",
      principal: "integration:lead-codex-g1",
      operations: ["write", "merge"],
      backends: [FIXTURE_WRITE_BACKEND],
      expiresAt: Date.now() + 60_000,
      maxCostUsd: null,
    });
    const mcp = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, credential: { integration: "lead-codex-g1" } });
    await mcp.call("lead.attach", { generation: 1 });
    const before = getHead(fixture.project);

    const submitted = await mcp.call<Job>("run.submit", { backend: FIXTURE_WRITE_BACKEND, prompt: "write", mode: "write", containment: "required", approvalPolicy: "auto", timeoutMs: 10_000 });
    await root.call("authority.grant.revoke", { grantId: "revoked-during-run" });
    const completed = await mcp.call<Job>("run.wait", { jobId: submitted.id, timeoutMs: 30_000 });

    expect(completed.state).toBe("blocked");
    expect(completed.result?.commit?.merged).toBe(false);
    expect(completed.result?.commit?.candidate).not.toBeNull();
    expect(getHead(fixture.project)).toBe(before);
    expect(existsSync(join(fixture.project, "revoked-during-run.txt"))).toBe(false);
  });

  test("a grant expiring during worker execution cannot merge after gates", async () => {
    const fixture = createFixture();
    initGitProject(fixture.project);
    installGrokBackend(fixture.bin, `await Bun.sleep(2500); await Bun.write("expired-during-run.txt", "candidate\\n"); console.log(JSON.stringify({type:"response.output_text.delta",delta:"written"}));`);
    const daemon = new HeadlessDaemon({
      projectRoot: fixture.project,
      state: fixture.state,
      token: "a".repeat(48),
      principal: "coordinator",
      coordinator: "coordinator",
      writeGateChecks: [{ name: "deterministic-pass", command: "bun", args: ["-e", "process.exit(0)"] }],
    });
    daemons.push(daemon);
    await daemon.start();
    const root = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48) });
    await root.call("lead.use", { host: "codex" });
    await root.call("authority.grant.add", {
      id: "expires-during-run",
      principal: "integration:lead-codex-g1",
      operations: ["write", "merge"],
      backends: [FIXTURE_WRITE_BACKEND],
      expiresAt: Date.now() + 2_000,
      maxCostUsd: null,
    });
    const mcp = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, credential: { integration: "lead-codex-g1" } });
    await mcp.call("lead.attach", { generation: 1 });
    const before = getHead(fixture.project);

    const submitted = await mcp.call<Job>("run.submit", { backend: FIXTURE_WRITE_BACKEND, prompt: "write", mode: "write", containment: "required", approvalPolicy: "auto", timeoutMs: 10_000 });
    const completed = await mcp.call<Job>("run.wait", { jobId: submitted.id, timeoutMs: 30_000 });

    expect(completed.state).toBe("blocked");
    expect(completed.result?.commit?.merged).toBe(false);
    expect(completed.result?.commit?.candidate).not.toBeNull();
    expect(getHead(fixture.project)).toBe(before);
    expect(existsSync(join(fixture.project, "expired-during-run.txt"))).toBe(false);
  }, 20_000);

  test("a pre-merge finality persistence failure leaves primary untouched", async () => {
    const fixture = createFixture();
    initGitProject(fixture.project);
    installGrokBackend(fixture.bin, `await Bun.write("must-not-merge.txt", "candidate\\n"); console.log(JSON.stringify({type:"response.output_text.delta",delta:"written"}));`);
    const daemon = new HeadlessDaemon({
      projectRoot: fixture.project,
      state: fixture.state,
      token: "a".repeat(48),
      principal: "coordinator",
      writeGateChecks: [{ name: "deterministic-pass", command: "bun", args: ["-e", "process.exit(0)"] }],
    });
    daemons.push(daemon);
    await daemon.start();
    const finality = Reflect.get(daemon, "finality") as FinalityStore;
    const evaluate = finality.evaluate.bind(finality);
    let failNext = true;
    finality.evaluate = ((value) => {
      if (failNext) {
        failNext = false;
        throw new Error("injected finality disk failure");
      }
      return evaluate(value);
    }) as FinalityStore["evaluate"];
    const client = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48) });
    const before = runGitStrict(["rev-parse", "HEAD"], fixture.project).stdout.trim();

    const submitted = await client.call<Job>("run.submit", { backend: FIXTURE_WRITE_BACKEND, prompt: "write", mode: "write", containment: "required", approvalPolicy: "auto", timeoutMs: 10_000 });
    const completed = await client.call<Job>("run.wait", { jobId: submitted.id, timeoutMs: 30_000 });

    expect(completed.state).toBe("blocked");
    expect(completed.result?.commit?.merged).toBe(false);
    expect(completed.result?.commit?.candidate).not.toBeNull();
    expect(runGitStrict(["rev-parse", "HEAD"], fixture.project).stdout.trim()).toBe(before);
    expect(existsSync(join(fixture.project, "must-not-merge.txt"))).toBe(false);
  });

  test("restart journal recovery records and repairs a primary update interrupted after fast-forward", async () => {
    const fixture = createFixture();
    initGitProject(fixture.project);
    const daemon = new HeadlessDaemon({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48), principal: "coordinator" });
    daemons.push(daemon);
    await daemon.start();
    const request = RunRequestSchema.parse({
      backend: FIXTURE_WRITE_BACKEND,
      prompt: "journal recovery",
      projectRoot: fixture.project,
      mode: "write",
      containment: "required",
      timeoutMs: 10_000,
    });
    const job = daemon.jobs.create({ projectId: daemon.state.projectId, principal: "coordinator", request });
    daemon.jobs.claim(job.id, "daemon:interrupted", 60_000);
    daemon.jobs.transition(job.id, "running");
    const plan = createWriteWorktree(planWriteWorktree({ primaryRoot: fixture.project, tempBase: daemon.state.worktreesDir, label: "journal-recovery" }));
    writeFileSync(join(plan.worktreePath, "recovered.txt"), "recovered\n");
    expect(runGitStrict(["add", "--all"], plan.worktreePath).ok).toBe(true);
    expect(runGitStrict(["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--no-gpg-sign", "-m", "candidate"], plan.worktreePath).ok).toBe(true);
    const target = runGitStrict(["rev-parse", "HEAD"], plan.worktreePath).stdout.trim();
    removeWriteWorktree(plan, { force: true, pruneBranch: false });
    const journal = new IntegrationJournal(daemon.state);
    journal.prepare({
      jobId: job.id,
      sessionId: null,
      principal: "coordinator",
      grantId: null,
      phase: "candidate",
      outcome: "merged_fast_forward",
      baseCommit: plan.baseSha,
      candidateCommit: target,
      expectedPrimaryHead: plan.baseSha,
      targetCommit: target,
    });
    expect(runGitStrict(["merge", "--ff-only", target], fixture.project).ok).toBe(true);
    await daemon.stop();
    daemons.splice(daemons.indexOf(daemon), 1);

    const restarted = new HeadlessDaemon({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48), principal: "coordinator" });
    daemons.push(restarted);
    await restarted.start();

    expect(restarted.jobs.get(job.id)).toMatchObject({
      state: "succeeded",
      result: { status: "succeeded", commit: { candidate: target, result: target, merged: true } },
    });
    expect(new IntegrationJournal(restarted.state).get(job.id)).toMatchObject({ state: "completed", resultingCommit: target });
    expect(readFileSync(restarted.state.ledgerPath, "utf8")).toContain("startup-recovery");
    expect(readFileSync(join(fixture.project, "recovered.txt"), "utf8")).toBe("recovered\n");
  });

  test("persists redacted run events and task terminal state across a daemon restart", async () => {
    const fixture = createFixture();
    const secret = "sk-1234567890abcdefghijkl";
    installBackend(fixture.bin, `await Bun.sleep(150); console.log(JSON.stringify({type:"text",text:"event ${secret}"}));`);
    const daemon = new HeadlessDaemon({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48), principal: "coordinator" });
    daemons.push(daemon);
    await daemon.start();
    const client = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48) });
    const submitted = await client.call<Job>("run.submit", {
      backend: FIXTURE_READ_BACKEND,
      prompt: "emit",
      containment: "unsafe",
      timeoutMs: 5_000,
    });
    const first = await client.call<{ events: RunEvent[]; latestCursor: number }>("events.snapshot", { jobId: submitted.id });
    const task = (await client.call<Task[]>("task.list", { jobId: submitted.id }))[0];
    expect(task?.jobId).toBe(submitted.id);
    expect(first.events.some((event) => event.kind === "lifecycle" && event.state === "queued")).toBe(true);

    const waiting = client.call<{ events: RunEvent[] }>("events.wait", {
      jobId: submitted.id,
      afterCursor: first.latestCursor,
      timeoutMs: 5_000,
    }, 10_000);
    const [, updates] = await Promise.all([
      client.call<Job>("run.wait", { jobId: submitted.id, timeoutMs: 5_000 }),
      waiting,
    ]);
    expect(updates.events.length).toBeGreaterThan(0);
    const terminal = await client.call<Task>("task.status", { taskId: task.id });
    expect(terminal.state).toBe("completed");
    expect(readFileSync(daemon.state.runEventsPath, "utf8")).not.toContain(secret);

    await daemon.stop();
    daemons.splice(daemons.indexOf(daemon), 1);
    const restarted = new HeadlessDaemon({ projectRoot: fixture.project, state: fixture.state, token: "a".repeat(48), principal: "coordinator" });
    daemons.push(restarted);
    await restarted.start();
    const afterRestart = await client.call<{ events: RunEvent[] }>("events.snapshot", { jobId: submitted.id });
    expect(afterRestart.events.some((event) => event.kind === "completion")).toBe(true);
    expect((await client.call<Task>("task.status", { taskId: task.id })).state).toBe("completed");
  });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "headless-daemon-"));
  roots.push(root);
  const project = join(root, "project");
  const bin = join(root, "bin");
  const stateHome = join(root, "state");
  mkdirSync(project);
  mkdirSync(bin);
  process.env.PATH = `${bin}:${originalPath}`;
  return { root, project, bin, state: { env: { ...process.env, HEADLESS_STATE_HOME: stateHome } } };
}

async function waitForPath(path: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await Bun.sleep(10);
  }
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function installBackend(bin: string, body: string) {
  const path = join(bin, "opencode");
  writeFileSync(path, `#!/usr/bin/env bun\n${body}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function installGrokBackend(bin: string, body: string) {
  const path = join(bin, "grok");
  writeFileSync(path, `#!/usr/bin/env bun\n${body}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function fixtureAdapter(
  id: string,
  executable: string,
  write: boolean,
  decodeOutput: BackendDefinition["decodeOutput"],
): BackendDefinition {
  return {
    id,
    metadata: { id, aliases: [], promptDelivery: "argv", timeoutMs: 10_000, maxDepth: null, canRead: true, canWrite: write },
    capabilities: { write, streaming: true, structuredOutput: true, nativeResume: false, cancellation: true, tools: false, effort: false, brokerCompatible: false },
    security: { outerContainmentRequired: true, strictAuth: "credential-free", disablesProjectConfig: true, disablesHooks: true, disablesMcp: true, disablesSkills: true },
    probe: { versionCommand: ["/usr/bin/true"], helpCommand: ["/usr/bin/true"], requiredHelpFragments: [], timeoutMs: 1_000, maxOutputBytes: 1_024 },
    stdinPrompt: false,
    credentialPrefixes: [],
    provider: null,
    fleetPriority: 0,
    prepareCommand: (opts, cwd) => executable === "opencode"
      ? [executable, "run", "--dir", cwd, "--", opts.prompt]
      : [executable, "--single", opts.prompt, "--cwd", cwd],
    decodeOutput,
  };
}

function initGitProject(project: string) {
  expect(runGitStrict(["init", "-b", "main"], project).ok).toBe(true);
  writeFileSync(join(project, ".gitignore"), ".headless/\n");
  writeFileSync(join(project, "README.md"), "base\n");
  expect(runGitStrict(["add", "--all"], project).ok).toBe(true);
  expect(runGitStrict(["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--no-gpg-sign", "-m", "initial"], project).ok).toBe(true);
}

function getHead(project: string) {
  return runGitStrict(["rev-parse", "HEAD"], project).stdout.trim();
}
