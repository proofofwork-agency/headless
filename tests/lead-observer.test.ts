import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeadlessDaemonClient } from "../src/daemon/client";
import { DaemonMethodSchema } from "../src/daemon/protocol";
import { HeadlessDaemon } from "../src/daemon/server";
import { AuthorityStore } from "../src/runtime/authority-store";
import { BudgetStore } from "../src/runtime/budget-store";
import { ensureProjectStateDirectories, getProjectStatePaths } from "../src/runtime/project-state";

const fixtures: Array<{ root: string; runtime: string; daemon?: HeadlessDaemon }> = [];

afterEach(async () => {
  while (fixtures.length) {
    const fixture = fixtures.pop()!;
    await fixture.daemon?.stop();
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.runtime, { recursive: true, force: true });
  }
});

describe("foreground lead and observer daemon boundaries", () => {
  test("requires attach, invalidates switched generations, and preserves durable state", async () => {
    const fixture = await daemonFixture();
    const root = fixture.rootClient;
    const configured = await root.call<{ binding: { generation: number } }>("lead.use", { host: "codex" });
    expect(configured.binding.generation).toBe(1);
    const codex = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.stateOptions, credential: { integration: "lead-codex-g1" } });
    await expect(codex.call("ledger.note", { text: "before attach" })).rejects.toMatchObject({ code: "POLICY_DENIED" });
    await codex.call("lead.attach", { generation: 1 });
    await codex.call("ledger.note", { text: "durable lead note", sessionId: "lead-switch" });
    await expect(codex.call("approval.resolve", { approvalId: "self", decision: "approved" })).rejects.toMatchObject({ code: "POLICY_DENIED" });
    await expect(codex.call("lead.use", { host: "opencode" })).rejects.toMatchObject({ code: "POLICY_DENIED" });

    const switched = await root.call<{ binding: { host: string; generation: number } }>("lead.use", { host: "opencode" });
    expect(switched.binding).toMatchObject({ host: "opencode", generation: 2 });
    await expect(codex.call("ping")).rejects.toMatchObject({ code: "DAEMON_AUTH_FAILED" });

    const opencode = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.stateOptions, credential: { integration: "lead-opencode-g2" } });
    await opencode.call("lead.attach", { generation: 2 });
    const context = await root.call<{ entries: Array<{ content?: string; source?: string }> }>("ledger.context", { view: "raw", limit: 20, sessionId: "lead-switch" });
    expect(context.entries).toContainEqual(expect.objectContaining({ content: "durable lead note", source: "integration:lead-codex-g1" }));
    await opencode.call("lead.disconnect", { generation: 2 });
    expect(await root.call("lead.status")).toMatchObject({ status: "disconnected", generation: 2 });
  });

  test("observer credentials can project state and events but cannot mutate any route", async () => {
    const fixture = await daemonFixture({ seedLinkedHold: true });
    const linkedDigestBefore = linkedHoldsDigest(fixture.state);
    await fixture.rootClient.call("budget.upsert", { id: "observer-budget", maxRequests: 2 });
    await fixture.rootClient.call("auth.provisionObserver");
    const observer = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.stateOptions, credential: { observer: true } });
    expect(await observer.call("ping")).toMatchObject({ principal: "observer", scopes: ["observe"] });
    expect(await observer.call("observer.snapshot")).toMatchObject({
      projectId: fixture.state.projectId,
      projectRoot: fixture.state.canonicalProjectRoot,
      budgets: [{ id: "observer-budget", maxRequests: 2 }],
    });
    expect(await observer.call("observer.events", { limit: 10 })).toMatchObject({ events: [] });
    await expect(observer.call("ledger.note", { text: "forbidden" })).rejects.toMatchObject({ code: "POLICY_DENIED" });
    await expect(observer.call("project.trust.grant", { nativeLoginAllowed: true })).rejects.toMatchObject({ code: "POLICY_DENIED" });
    for (const method of DaemonMethodSchema.options) {
      if (method === "ping" || method.startsWith("observer.")) continue;
      await expect(observer.call(method)).rejects.toMatchObject({ code: "POLICY_DENIED" });
    }
    for (const internalMutation of [
      "linkedHold.prepare",
      "linkedHold.apply",
      "linkedHold.settle",
      "linkedHold.recover",
      "linkedHold.quarantine",
    ]) {
      expect(DaemonMethodSchema.safeParse(internalMutation).success).toBe(false);
      await expect(observer.call(internalMutation)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(linkedHoldsDigest(fixture.state)).toBe(linkedDigestBefore);
    expect(readFileSync(fixture.state.observerTokenPath, "utf8").trim().length).toBeGreaterThan(40);
  });
});

describe("finite lead authority", () => {
  test("keeps merge human-controlled unless every finite grant bound matches", () => {
    const fixture = stateFixture();
    let now = 100;
    const authority = new AuthorityStore(fixture.state, {
      rootPrincipal: "root",
      foregroundLead: () => "integration:lead-codex-g1",
      now: () => now,
    });
    const request = { projectId: fixture.state.projectId, principal: "integration:lead-codex-g1", backend: "codex", estimatedCostUsd: 1 };
    expect(authority.authorize({ ...request, operation: "run" })).toMatchObject({ allowed: true, root: false, mergeAllowed: false, grantId: null });
    expect(authority.authorize({ ...request, operation: "merge", merge: true }).allowed).toBe(false);
    expect(authority.authorize({ ...request, principal: "worker", operation: "run" }).allowed).toBe(false);

    authority.addGrant("root", {
      id: "one-merge",
      projectId: fixture.state.projectId,
      principal: "integration:lead-codex-g1",
      operations: ["merge"],
      backends: ["codex"],
      expiresAt: 200,
      maxCostUsd: 2,
      maxIterations: 1,
      usedIterations: 0,
      issuedBy: "root",
      createdAt: 100,
      revokedAt: null,
    });
    const granted = authority.authorize({ ...request, operation: "merge", merge: true });
    expect(granted).toMatchObject({ allowed: true, mergeAllowed: true, grantId: "one-merge" });
    expect(authority.authorize({ ...request, backend: "opencode", operation: "merge", merge: true }).allowed).toBe(false);
    expect(authority.authorize({ ...request, estimatedCostUsd: 3, operation: "merge", merge: true }).allowed).toBe(false);
    authority.consumeIteration(granted.grantId, "candidate-one");
    expect(authority.authorize({ ...request, operation: "merge", merge: true }).allowed).toBe(false);
    now = 201;
    expect(authority.authorize({ ...request, operation: "merge", merge: true }).allowed).toBe(false);
  });
});

async function daemonFixture(options: { seedLinkedHold?: boolean } = {}) {
  const fixture = stateFixture();
  if (options.seedLinkedHold) seedTerminalLinkedHold(fixture.state);
  const daemon = new HeadlessDaemon({ projectRoot: fixture.project, state: fixture.stateOptions, token: "a".repeat(48), principal: "root" });
  fixture.record.daemon = daemon;
  await daemon.start();
  return {
    ...fixture,
    daemon,
    rootClient: new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.stateOptions, token: "a".repeat(48) }),
  };
}

function seedTerminalLinkedHold(state: ReturnType<typeof ensureProjectStateDirectories>) {
  const budgets = new BudgetStore(state);
  expect(budgets.reserve({
    id: "observer-linked-parent",
    projectId: state.projectId,
    principal: "root",
    sessionId: null,
    workflowId: null,
    provider: "anthropic",
    inputTokens: 1_000,
    outputTokens: 100,
    costUsd: 1,
    artifactBytes: 0,
    retries: 0,
  }).allowed).toBe(true);
  expect(budgets.activate("observer-linked-parent").allowed).toBe(true);
  const prepared = budgets.prepareLinkedProviderHold({
    parentJobId: "observer-linked-parent",
    parentReservationId: "observer-linked-parent",
    childReservationId: "observer-linked-child",
    requestId: "123e4567-e89b-42d3-a456-426614174099",
    parentBackend: "claude-code",
    targetBackend: "codex",
    parentProvider: "anthropic",
    targetProvider: "openai",
    budgetFraction: 0.25,
    parentDeadlineAt: Date.now() + 60_000,
    childDeadlineAt: Date.now() + 40_000,
    approvalPolicy: "auto",
    parentAllocation: { requests: 1, inputTokens: 250, outputTokens: 25, costUsd: 0.25, artifactBytes: 0, retries: 0 },
    targetReservation: { requests: 1, inputTokens: 100, outputTokens: 25, costUsd: 0.1, artifactBytes: 0, retries: 0 },
    requestDigest: "a".repeat(64),
    promptDigest: "b".repeat(64),
    promptBytes: 16,
  });
  budgets.rollbackLinkedProviderHold(prepared.hold!.linkId);
}

function linkedHoldsDigest(state: ReturnType<typeof ensureProjectStateDirectories>) {
  return createHash("sha256").update(JSON.stringify(new BudgetStore(state).getState().linkedHolds)).digest("hex");
}

function stateFixture() {
  const root = mkdtempSync(join(tmpdir(), "headless-lead-observer-"));
  const runtime = mkdtempSync("/tmp/hlo-");
  const project = join(root, "project");
  mkdirSync(project);
  const record = { root, runtime } as { root: string; runtime: string; daemon?: HeadlessDaemon };
  fixtures.push(record);
  const stateOptions = { env: { HEADLESS_STATE_HOME: join(root, "state"), HEADLESS_RUNTIME_HOME: runtime }, platform: "linux" as const };
  const state = ensureProjectStateDirectories(getProjectStatePaths(project, stateOptions));
  return { root, runtime, project, state, stateOptions, record };
}
