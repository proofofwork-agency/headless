import { describe, expect, test } from "bun:test";
import type { ApprovalRequest, DirectedMessage, FleetProfile, Goal, Turn } from "../src/contracts/collaboration";
import type { DaemonMethod } from "../src/daemon/protocol";
import { emptyTaskState } from "../src/runtime/read-model";
import { tuiProjectRoot } from "../src/cli/commands/lifecycle";
import {
  TuiController,
  restoreControlRoom,
  runReconnectLoop,
  type ControlRoomClient,
} from "../src/tui/controller";
import {
  activityEntries,
  approvalRows,
  fleetAgentRows,
  formatEventLine,
  goalRows,
  initialControlRoomState,
  mergeRunEvents,
  recentActivityLines,
  shortPath,
  type TuiControlRoomState,
} from "../src/tui/model";
import {
  buildHitZones,
  buildTabLayout,
  hitTest,
  listWindowStart,
  nextView,
  parseMouseEvents,
} from "../src/tui/layout";
import { CONTENT_TOP, LIST_OFFSET, TAB_ROW } from "../src/tui/theme";

const ESC = String.fromCharCode(27);
const ANSI_RED = `${ESC}[31m`;
const ANSI_CLEAR = `${ESC}[2J`;

describe("Headless TUI control room", () => {
  test("routes free text to the active goal coordinator without blocking input", async () => {
    const pending = deferred<void>();
    const goal = goalFixture("goal-active", "active");
    const state = { ...initialControlRoomState("/project"), goals: [goal], activeGoalId: goal.id };
    const harness = controllerHarness(state, {
      "goal.send": () => pending.promise,
    });

    const returned = harness.controller.execute("review the latest candidate");
    expect(returned).toBeUndefined();
    expect(harness.client.calls).toEqual([{
      method: "goal.send",
      params: { goalId: goal.id, text: "review the latest candidate" },
      timeoutMs: undefined,
    }]);
    expect(harness.status()).toContain("Sending turn");

    pending.resolve();
    await harness.controller.drain();
    expect(harness.status()).toContain(`coordinator for ${goal.id}`);
    expect(harness.client.calls.some((call) => call.method === "ledger.event")).toBe(false);
  });

  test("starts a goal when none is active and records a diagnostic legacy fallback", async () => {
    const started = goalFixture("goal-started", "queued");
    const first = controllerHarness(initialControlRoomState("/project"), {
      "goal.start": () => ({ goal: started }),
      ...refreshResponses([started]),
    });
    first.controller.execute("ship the native session recovery fix");
    await first.controller.drain();
    expect(first.state().activeGoalId).toBe(started.id);
    expect(first.client.calls[0]).toMatchObject({
      method: "goal.start",
      params: { objective: "ship the native session recovery fix", detach: true },
    });

    const fallback = controllerHarness(initialControlRoomState("/project"), {
      "goal.start": () => Promise.reject(new Error("no active fleet profile")),
      "ledger.event": (_params) => ({ ok: true }),
    });
    fallback.controller.execute("preserve this coordinator turn");
    await fallback.controller.drain();
    const legacy = fallback.client.calls.find((call) => call.method === "ledger.event");
    expect(legacy?.params).toMatchObject({
      type: "message",
      payload: {
        content: "preserve this coordinator turn",
        meta: { compatibilityFallback: ["goal.start: no active fleet profile"] },
      },
    });
    expect(fallback.status()).toContain("legacy durable channel");
  });

  test("restores project trust, profile, autonomy, active goal, turns, queues, and approvals", async () => {
    const fleet = fleetFixture();
    const goal = goalFixture("goal-restored", "planning");
    const turn = turnFixture(goal.id);
    const message = messageFixture(goal.id, "message-restored", 1, "durable coordinator report");
    const approval = approvalFixture(goal.id);
    const client = new FakeClient({
      ...refreshResponses([goal]),
      "project.trust.status": () => ({ trusted: true, nativeLoginAllowed: true, bypassAllowed: false }),
      "orchestrator.status": () => ({ enabled: true, activeJobs: 2, queuedJobs: 5 }),
      "fleet.profile.list": () => ({ profiles: [fleet], activeProfileId: fleet.id }),
      "fleet.health": () => ({
        leaderCandidates: [{
          agent: { id: "codex-lead", backend: "codex" },
          authenticated: true,
          health: "healthy",
          activeTurns: 1,
          rateLimitedUntil: null,
        }],
      }),
      "approval.list": () => ({ approvals: [approval] }),
      "collaboration.turns": () => ({ turns: [turn] }),
      "collaboration.messages": () => ({ messages: [message] }),
    });

    const restored = await restoreControlRoom(client, initialControlRoomState("/requested"));
    expect(restored.unavailable).toEqual([]);
    expect(restored.patch).toMatchObject({
      projectRoot: "/canonical/project",
      projectId: "project-id",
      principal: "coordinator",
      activeFleetProfileId: fleet.id,
      activeGoalId: goal.id,
      orchestration: { enabled: true, activeJobs: 2, queuedJobs: 5 },
      projectTrust: { trusted: true, nativeLoginAllowed: true, bypassAllowed: false },
    });
    expect(restored.patch.turns).toEqual([turn]);
    expect(restored.patch.messages).toEqual([message]);
    expect(restored.patch.approvals).toEqual([approval]);
    expect(restored.patch.fleetHealth).toMatchObject([{ id: "codex-lead", authenticated: true, healthy: true }]);
  });

  test("keeps optional control-room views degradable while ping remains authoritative", async () => {
    const client = new FakeClient({
      ping: () => ({ projectId: "project-id", projectRoot: "/canonical", principal: "coordinator" }),
    });
    const result = await restoreControlRoom(client, initialControlRoomState("/requested"));
    expect(result.patch).toMatchObject({ projectRoot: "/canonical", connection: "connected" });
    expect(result.unavailable).toContain("fleet");
    expect(result.unavailable).toContain("goals");
    expect(result.patch.fleetProfiles).toEqual([]);
  });

  test("reconnects with bounded backoff after a dropped subscription", async () => {
    let stopped = false;
    let connects = 0;
    let consumes = 0;
    const delays: number[] = [];
    const retries: string[] = [];

    await runReconnectLoop({
      connect: async () => ({ generation: ++connects }),
      consume: async ({ generation }) => {
        consumes += 1;
        if (generation === 1) throw new Error("socket reset");
        stopped = true;
      },
      shouldStop: () => stopped,
      initialDelayMs: 10,
      maximumDelayMs: 40,
      sleep: async (delay) => { delays.push(delay); },
      onRetry: (error) => retries.push(error instanceof Error ? error.message : String(error)),
    });

    expect({ connects, consumes }).toEqual({ connects: 2, consumes: 2 });
    expect(delays).toEqual([10]);
    expect(retries).toEqual(["socket reset"]);
  });

  test("dispatches goal, leader, trust, fleet, approval, candidate, and policy actions", async () => {
    const fleet = fleetFixture();
    const alternateFleet = { ...fleetFixture(), id: "fleet-alternate", name: "Alternate fleet" };
    const goal = goalFixture("goal-actions", "active");
    const base: TuiControlRoomState = {
      ...initialControlRoomState("/project"),
      fleetProfiles: [fleet, alternateFleet],
      activeFleetProfileId: fleet.id,
      goals: [goal],
      activeGoalId: goal.id,
    };
    const handlers: Partial<Record<DaemonMethod, Handler>> = {
      ...refreshResponses([goal]),
      "collaboration.transferLeader": () => ({ ok: true }),
      "goal.cancel": () => ({ ok: true }),
      "approval.resolve": () => ({ ok: true }),
      "candidate.inspect": () => ({
        candidateId: "candidate-one",
        eligible: true,
        reasons: [],
        decision: { status: "available" },
        job: { result: { diff: { files: ["src/native.ts", "tests/native.test.ts"], patch: "diff --git a/src/native.ts b/src/native.ts\n+native" } } },
        finality: {
          requirements: { policy: true, tests: true, review: true, vote: false, budget: true },
          decision: { policyPassed: true, testsPassed: true, reviewPassed: true, votePassed: false, budgetPassed: true },
        },
      }),
      "fleet.profile.upsert": () => ({ ok: true }),
      "project.trust.grant": () => ({ trusted: true, nativeLoginAllowed: true, bypassAllowed: true }),
      "project.trust.revoke": () => ({ trusted: false }),
      "goal.start": () => ({ goal: { ...goalFixture("goal-write", "queued"), mode: "write" as const } }),
    };

    const writeGoal = controllerHarness(base, handlers);
    writeGoal.controller.execute("/goal-write implement the approved candidate");
    await writeGoal.controller.drain();
    expect(writeGoal.client.calls[0]).toMatchObject({
      method: "goal.start",
      params: { objective: "implement the approved candidate", mode: "write", detach: true },
    });

    const leader = controllerHarness(base, handlers);
    leader.controller.execute("/leader claude-reviewer");
    await leader.controller.drain();
    expect(leader.client.calls[0]).toMatchObject({ method: "collaboration.transferLeader", params: { goalId: goal.id, agentId: "claude-reviewer" } });

    const cancellation = controllerHarness(base, handlers);
    cancellation.controller.execute("/cancel-goal");
    await cancellation.controller.drain();
    expect(cancellation.client.calls[0]).toMatchObject({ method: "goal.cancel", params: { goalId: goal.id } });

    const approval = controllerHarness(base, handlers);
    approval.controller.execute("/approve approval-one reviewed diff");
    await approval.controller.drain();
    expect(approval.client.calls[0]).toMatchObject({
      method: "approval.resolve",
      params: { approvalId: "approval-one", decision: "approved", resolution: "reviewed diff" },
    });

    const candidate = controllerHarness(base, handlers);
    candidate.controller.execute("/candidate candidate-one");
    await candidate.controller.drain();
    expect(candidate.state().candidate).toMatchObject({
      id: "candidate-one",
      status: "available",
      summary: "2 changed files.",
      files: ["src/native.ts", "tests/native.test.ts"],
      patchPreview: "diff --git a/src/native.ts b/src/native.ts",
      gates: [
        { id: "policy", status: "passed" },
        { id: "tests", status: "passed" },
        { id: "review", status: "passed" },
        { id: "vote", status: "not_required" },
        { id: "budget", status: "passed" },
      ],
    });

    const policy = controllerHarness(base, handlers);
    policy.controller.execute("/policy auto");
    await policy.controller.drain();
    expect(policy.client.calls[0]).toMatchObject({
      method: "fleet.profile.upsert",
      params: { id: fleet.id, approvalPolicy: "auto", activate: true },
    });

    const trust = controllerHarness(base, handlers);
    trust.controller.execute("/trust grant bypass");
    await trust.controller.drain();
    expect(trust.client.calls[0]).toMatchObject({
      method: "project.trust.grant",
      params: { nativeLoginAllowed: true, bypassAllowed: true },
    });

    const activateFleet = controllerHarness(base, handlers);
    activateFleet.controller.execute(`/use-fleet ${alternateFleet.id}`);
    await activateFleet.controller.drain();
    expect(activateFleet.client.calls[0]).toMatchObject({
      method: "fleet.profile.upsert",
      params: { id: alternateFleet.id, name: alternateFleet.name, activate: true },
    });
  });

  test("acknowledges addressed messages with prune-by-default and optional retain", async () => {
    const goal = goalFixture("goal-mailbox", "active");
    const first = messageFixture(goal.id, "message-one", 1, "first report");
    const second = messageFixture(goal.id, "message-two", 2, "second report");
    const state = {
      ...initialControlRoomState("/project"),
      goals: [goal],
      activeGoalId: goal.id,
      messages: [first, second],
    };
    const pruned = controllerHarness(state, {
      ...refreshResponses([goal]),
      "collaboration.messages.acknowledge": () => ({
        goalId: goal.id,
        acknowledgedMessageIds: [first.id, second.id],
        pruned: 2,
      }),
    });
    expect(pruned.controller.execute(`/ack-message ${first.id} ${second.id}`)).toBeUndefined();
    await pruned.controller.drain();
    expect(pruned.client.calls[0]).toMatchObject({
      method: "collaboration.messages.acknowledge",
      params: { goalId: goal.id, messageIds: [first.id, second.id], prune: true },
    });
    expect(pruned.state().messages).toEqual([]);
    expect(pruned.status()).toContain("2 messages acknowledged; 2 pruned");

    const retained = controllerHarness(state, {
      ...refreshResponses([goal]),
      "collaboration.messages": () => ({ messages: [first, second] }),
      "collaboration.messages.acknowledge": () => ({
        goalId: goal.id,
        acknowledgedMessageIds: [second.id],
        pruned: 0,
      }),
    });
    retained.controller.execute(`/ack-message ${second.id} --retain`);
    await retained.controller.drain();
    expect(retained.client.calls[0]).toMatchObject({
      method: "collaboration.messages.acknowledge",
      params: { goalId: goal.id, messageIds: [second.id], prune: false },
    });
    expect(retained.state().messages.find((message) => message.id === second.id)?.acknowledgedAt).not.toBeNull();
    expect(retained.status()).toContain("1 message acknowledged and retained");

    const invalid = controllerHarness(state, {});
    invalid.controller.execute(`/ack-message ${first.id} ${first.id}`);
    expect(invalid.client.calls).toEqual([]);
    expect(invalid.status()).toContain("more unique ids");
    invalid.controller.execute("/help");
    expect(invalid.status()).toContain("/ack-message <id> [more ids] [--retain]");
  });

  test("sanitizes and redacts presentation rows built from live collaboration state", () => {
    const fleet = fleetFixture();
    const goal = { ...goalFixture("goal-narrow", "active"), objective: `x${ANSI_RED}${"x".repeat(500)}` };
    const state: TuiControlRoomState = {
      ...initialControlRoomState("/a/very/long/project/path/that/must/not/overflow"),
      connection: "connected",
      fleetProfiles: [fleet],
      activeFleetProfileId: fleet.id,
      fleetHealth: [{ id: "codex-lead", backend: "codex", authenticated: false, healthy: true, rateLimited: false, load: 2, detail: null }],
      goals: [goal],
      activeGoalId: goal.id,
      approvals: [approvalFixture(goal.id)],
      orchestration: { enabled: true, activeJobs: 2, queuedJobs: 9, mode: "autonomous" },
    };

    const goals = goalRows(state);
    expect(goals).toHaveLength(1);
    expect(goals[0]).toMatchObject({ id: goal.id, active: true, state: "active" });
    expect(goals[0]?.objective).not.toContain(ESC);

    const agents = fleetAgentRows(state);
    expect(agents).toMatchObject([{ id: "codex-lead", backend: "codex", auth: "login?", load: "2" }]);

    const approvals = approvalRows(state, 61_000);
    expect(approvals).toMatchObject([{ id: "approval-one", kind: "merge", requestedBy: "codex-lead", age: "1m" }]);

    const activityState = {
      ...state,
      turns: [{ ...turnFixture(goal.id), output: `turn result${ANSI_RED} ${"z".repeat(500)}`, state: "succeeded" as const, completedAt: 2 }],
      messages: [messageFixture(goal.id, "message-secret", 2, `report sk-abcdefghijklmnop${ANSI_CLEAR} ready`)],
    };
    const entries = activityEntries(activityState, 4);
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.text).join("\n")).not.toContain(ESC);
    const wideActivity = recentActivityLines(activityState, 4).join("\n");
    expect(wideActivity).toContain("[REDACTED_OPENAI_KEY]");
    expect(wideActivity).not.toContain("sk-abcdefghijklmnop");
    expect(wideActivity).toContain("message-secret");

    const earlier = eventFixture("event-2", 2_000, 2, "running");
    const later = eventFixture("event-3", 3_000, 3, "succeeded");
    const merged = mergeRunEvents([later], [earlier, later]);
    expect(merged.map((event) => event.eventId)).toEqual([earlier.eventId, later.eventId]);

    const stdoutEvent = { ...eventFixture("event-ansi", 4_000, 4, "running"), kind: "stdout" as const, text: `hello${ANSI_CLEAR}world sk-abcdefghijklmnop` };
    const line = formatEventLine(stdoutEvent as never);
    expect(line.text).not.toContain(ESC);
    expect(line.text).toContain("[REDACTED_OPENAI_KEY]");
    expect(line.tone).toBeTruthy();

    expect(shortPath("/a/b", 24)).toBe("/a/b");
    expect(shortPath(`/very/${"deep/".repeat(12)}path`, 24).length).toBeLessThanOrEqual(24);
  });

  test("resolves tabs, list rows, and wheel gestures from SGR mouse reports", () => {
    const tabs = buildTabLayout(120, { approvals: 2 });
    expect(tabs.map((segment) => segment.view)).toEqual(["overview", "fleet", "goals", "approvals", "events", "help"]);
    expect(tabs[0]).toMatchObject({ from: 3, to: 10 });
    const approvalsTab = tabs.find((segment) => segment.view === "approvals");
    expect(approvalsTab?.label).toBe("Approvals\u{b7}2");
    const help = tabs.find((segment) => segment.view === "help");
    expect(help?.to).toBe(118);

    const zones = buildHitZones({
      width: 120,
      height: 30,
      view: "goals",
      badges: { approvals: 2 },
      list: { rows: 6, start: 4, total: 40, paneWidth: 55 },
    });
    expect(hitTest(3, TAB_ROW, zones)).toEqual({ kind: "view", view: "overview" });
    expect(hitTest(118, TAB_ROW, zones)).toEqual({ kind: "view", view: "help" });
    expect(hitTest(2, TAB_ROW + 1, zones)).toBeUndefined();
    expect(hitTest(10, CONTENT_TOP + LIST_OFFSET, zones)).toEqual({ kind: "row", index: 4 });
    expect(hitTest(10, CONTENT_TOP + LIST_OFFSET + 5, zones)).toEqual({ kind: "row", index: 9 });
    expect(hitTest(56, CONTENT_TOP + LIST_OFFSET, zones)).toBeUndefined();

    expect(parseMouseEvents(`${ESC}[<0;12;3M`)).toEqual([{ x: 12, y: 3, kind: "press" }]);
    expect(parseMouseEvents(`${ESC}[<0;12;3m`)).toEqual([]);
    expect(parseMouseEvents(`${ESC}[<64;9;9M${ESC}[<65;9;9M`)).toEqual([
      { x: 9, y: 9, kind: "wheel-up" },
      { x: 9, y: 9, kind: "wheel-down" },
    ]);
    expect(parseMouseEvents(`${ESC}[<16;5;5M`)).toEqual([{ x: 5, y: 5, kind: "press" }]);
    expect(parseMouseEvents("plain typing")).toEqual([]);

    expect(listWindowStart(0, 5, 40)).toBe(0);
    expect(listWindowStart(12, 5, 40)).toBe(8);
    expect(listWindowStart(39, 5, 40)).toBe(35);
    expect(nextView("overview")).toBe("fleet");
    expect(nextView("overview", -1)).toBe("help");
  });

  test("passes --cwd from the CLI invocation to the TUI project boundary", () => {
    expect(tuiProjectRoot(["tui", "--cwd", "/chosen/project"], "/fallback")).toBe("/chosen/project");
    expect(tuiProjectRoot(["tui"], "/fallback")).toBe("/fallback");
  });
});

type Handler = (params: Record<string, unknown>, timeoutMs?: number) => unknown | Promise<unknown>;

class FakeClient implements ControlRoomClient {
  readonly calls: Array<{ method: DaemonMethod; params: Record<string, unknown>; timeoutMs: number | undefined }> = [];

  constructor(private readonly handlers: Partial<Record<DaemonMethod, Handler>>) {}

  async call<T = unknown>(method: DaemonMethod, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    this.calls.push({ method, params, timeoutMs });
    const handler = this.handlers[method];
    if (!handler) throw new Error(`unsupported ${method}`);
    return await handler(params, timeoutMs) as T;
  }
}

function controllerHarness(initial: TuiControlRoomState, handlers: Partial<Record<DaemonMethod, Handler>>) {
  let state = initial;
  let status = initial.status;
  const client = new FakeClient(handlers);
  const controller = new TuiController(client, {
    getState: () => state,
    patchState: (patch) => { state = { ...state, ...patch }; },
    setStatus: (next) => { status = next; state = { ...state, status: next }; },
    exit: () => undefined,
  });
  return { client, controller, state: () => state, status: () => status };
}

function refreshResponses(goals: Goal[]): Partial<Record<DaemonMethod, Handler>> {
  return {
    ping: () => ({ projectId: "project-id", projectRoot: "/canonical/project", principal: "coordinator" }),
    "project.trust.status": () => ({ trusted: true, nativeLoginAllowed: true, bypassAllowed: false }),
    "orchestrator.status": () => ({ enabled: false, activeJobs: 0, queuedJobs: 0 }),
    "fleet.profile.list": () => ({ profiles: [], activeProfileId: null }),
    "fleet.health": () => ({ agents: [] }),
    "goal.list": () => ({ goals }),
    "approval.list": () => ({ approvals: [] }),
    "ledger.task": () => emptyTaskState(),
    "task.list": () => [],
    "collaboration.turns": () => ({ turns: [] }),
    "collaboration.messages": () => ({ messages: [] }),
  };
}

function fleetFixture(): FleetProfile {
  return {
    id: "fleet-main",
    projectId: "project-id",
    name: "Native fleet",
    authMode: "native-login",
    approvalPolicy: "ask",
    coordinator: { kind: "automatic" },
    agents: [{
      id: "codex-lead",
      backend: "codex",
      name: "Codex Lead",
      authMode: "native-login",
      approvalPolicy: "ask",
      enabled: true,
      priority: 10,
      capabilities: ["code", "review"],
      maxConcurrentTurns: 1,
      createdAt: 1,
      updatedAt: 1,
    }],
    maxActiveWorkers: 4,
    maxQueuedDelegations: 64,
    maxDeliberationRounds: 8,
    maxAttemptsPerDelegation: 2,
    goalTimeoutMs: 3_600_000,
    idleAutonomy: "suggest",
    createdAt: 1,
    updatedAt: 1,
  };
}

function goalFixture(id: string, state: Goal["state"]): Goal {
  return {
    id,
    projectId: "project-id",
    principal: "coordinator",
    fleetProfileId: "fleet-main",
    objective: "Complete the v0.2 control room.",
    mode: "read-only",
    state,
    authMode: "native-login",
    approvalPolicy: "ask",
    coordinator: { kind: "automatic" },
    leaderAgentId: "codex-lead",
    autonomous: true,
    deadlineAt: 10_000,
    createdAt: 1,
    updatedAt: 2,
  };
}

function turnFixture(goalId: string): Turn {
  return {
    id: "turn-one",
    goalId,
    delegationId: null,
    agentId: "codex-lead",
    nativeSessionId: "native-one",
    authMode: "native-login",
    sequence: 1,
    state: "running",
    input: "Plan the work.",
    output: null,
    artifactIds: [],
    startedAt: 2,
    completedAt: null,
    createdAt: 1,
    updatedAt: 2,
  };
}

function approvalFixture(collaborationId: string): ApprovalRequest {
  return {
    id: "approval-one",
    collaborationId,
    requestedBy: "codex-lead",
    assignedTo: "coordinator",
    kind: "merge",
    status: "pending",
    summary: "Approve candidate integration.",
    details: {},
    artifactIds: [],
    resolvedBy: null,
    resolution: null,
    expiresAt: 10_000,
    resolvedAt: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function messageFixture(
  collaborationId: string,
  id: string,
  sequence: number,
  content: string,
): DirectedMessage {
  return {
    id,
    collaborationId,
    senderId: "codex-lead",
    recipientId: "coordinator",
    sequence,
    kind: "report",
    content,
    redacted: true,
    truncated: false,
    artifactIds: [],
    acknowledgedAt: null,
    createdAt: sequence + 1,
  };
}

function eventFixture(id: string, timestamp: number, sequence: number, state: "running" | "succeeded") {
  return {
    version: 2 as const,
    eventId: id,
    jobId: "job-one",
    sessionId: null,
    sequence,
    timestamp,
    redacted: true as const,
    kind: "lifecycle" as const,
    state,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
