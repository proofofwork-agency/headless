import { describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { renderToString } from "ink";
import React from "react";
import type { FleetProfile, Goal } from "../src/contracts/collaboration";
import type { Budget } from "../src/contracts/durable";
import type { RunEvent } from "../src/contracts/run";
import {
  ApprovalsView,
  approvalsListMeta,
  ConfigView,
  EventsView,
  FleetView,
  fleetListMeta,
  GoalsView,
  goalsListMeta,
  HelpView,
  OverviewView,
} from "../src/tui/views";
import { TuiFrame } from "../src/tui/App";
import { footerLayout } from "../src/tui/components";
import {
  TuiController,
  restoreControlRoom,
  runReconnectLoop,
  type ControlRoomClient,
} from "../src/tui/controller";
import {
  controlSummary,
  configViewModel,
  filterEvents,
  fleetAgentRows,
  formatEventLine,
  groupRepeatedEvents,
  healthSummary,
  initialControlRoomState,
  mergeRunEvents,
  nextActions,
  providerReadiness,
  safeInline,
  type TuiControlRoomState,
} from "../src/tui/model";
import {
  buildHitZones,
  buildTabLayout,
  contentFrameRows,
  contentInsetRows,
  contentRows,
  contentStartRow,
  headerTabsMode,
  hitTest,
  listContentRows,
  listWindowStart,
  nextView,
  parseMouseEvents,
  tabRowFor,
  viewForDigit,
} from "../src/tui/layout";

describe("Headless read-only TUI", () => {
  test("restores the control room from only observer snapshot and event operations", async () => {
    const goal = goalFixture();
    const fleet = fleetFixture();
    const event = eventFixture("event-one", 10, 1);
    const client = new FakeClient({
      ping: { projectId: "project-id", projectRoot: "/canonical/project", principal: "observer" },
      "observer.snapshot": {
        observedAt: 50,
        projectId: "project-id",
        projectRoot: "/canonical/project",
        lead: { host: "codex", backendId: "codex", generation: 2, status: "connected" },
        projectTrust: { trusted: true, nativeLoginAllowed: true, nativeDirectUnrestrictedAcknowledged: true, bypassAllowed: false },
        fleetProfiles: [fleet],
        activeFleetProfileId: fleet.id,
        fleetHealth: { leaderCandidates: [{
          agent: { id: "worker", backend: "opencode" },
          authenticated: false,
          health: "unhealthy",
          rateLimitedUntil: null,
          activeTurns: 1,
          detail: "Project trust with native acknowledgement is not granted.",
          presentation: {
            code: "trust_required",
            reason: "Project trust with native acknowledgement is not granted.",
            recovery: 'headless project trust grant --allow-native-direct-unrestricted --cwd "/canonical/project"',
          },
        }] },
        goals: [goal],
        goalTurns: { [goal.id]: [] },
        goalMessages: { [goal.id]: [] },
        approvals: [],
        budgets: [budgetFixture()],
        jobs: [{ state: "running" }, { state: "queued" }],
        delegations: [{ parentJobId: "parent", childJobId: "child", requestId: crypto.randomUUID(), backend: "claude", state: "running", createdAt: 10, deadlineAt: 1000, budgetFraction: 0.25, usage: null, cost: null, error: null }],
        tasks: [],
        sessions: [],
        orchestration: { enabled: true, mode: "automatic" },
      },
      "observer.events": { events: [event], nextCursor: 1, cursorExpired: false },
    });

    const restored = await restoreControlRoom(client, initialControlRoomState("/requested"));
    expect(client.calls.map((call) => call.method).sort()).toEqual(["observer.events", "observer.snapshot", "ping"]);
    expect(restored.patch).toMatchObject({
      projectRoot: "/canonical/project",
      principal: "observer",
      connection: "connected",
      activeGoalId: goal.id,
      lead: { host: "codex", generation: 2, status: "connected" },
      budgets: [{ id: "project-limit" }],
      delegations: [{ childJobId: "child", parentJobId: "parent" }],
      orchestration: { enabled: true, activeJobs: 1, queuedJobs: 1, mode: "automatic" },
    });
    expect(restored.patch.events).toEqual([event]);
    expect(restored.patch.fleetHealth).toMatchObject([{
      id: "worker",
      backend: "opencode",
      healthy: false,
      presentation: {
        code: "trust_required",
        reason: "Project trust with native acknowledgement is not granted.",
        recovery: 'headless project trust grant --allow-native-direct-unrestricted --cwd "/canonical/project"',
      },
    }]);
  });

  test("renders config state and exact root-CLI commands from an observer snapshot", () => {
    const state: TuiControlRoomState = {
      ...initialControlRoomState("/canonical/project with space"),
      projectId: "project-id",
      connection: "connected",
      observedAt: 1_000,
      projectTrust: { trusted: true, nativeLoginAllowed: true, nativeDirectUnrestrictedAcknowledged: true, bypassAllowed: false },
      lead: { host: "codex", backendId: "codex", generation: 3, status: "connected" },
      budgets: [budgetFixture()],
      fleetHealth: [{ id: "worker", backend: "opencode", authenticated: true, healthy: true, rateLimited: false, load: 0, detail: "ready" }],
      orchestration: { enabled: true, activeJobs: 1, queuedJobs: 2, mode: "automatic" },
      delegations: [{ parentJobId: "parent", childJobId: "child", requestId: crypto.randomUUID(), backend: "claude", state: "running", createdAt: 900, deadlineAt: 5_000, budgetFraction: 0.25, usage: null, cost: null, error: null }],
    };

    const config = configViewModel(state);
    expect(config).toMatchObject({
      trust: "trusted · native allowed · egress acknowledged · bypass denied",
      lead: "codex · generation 3 · connected",
      backends: [{ id: "worker", backend: "opencode", readiness: "Ready" }],
      budgets: [{ id: "project-limit" }],
      delegations: [{ id: "child", summary: expect.stringContaining("↳ claude · running · parent parent · fraction 0.25") }],
    });
    expect(config.commands.map(({ command }) => command)).toEqual(expect.arrayContaining([
      "headless project trust grant --allow-native-direct-unrestricted --cwd '/canonical/project with space'",
      "headless project trust revoke --cwd '/canonical/project with space'",
      "headless lead use claude --cwd '/canonical/project with space'",
      "headless experimental budget list --cwd '/canonical/project with space'",
      "headless experimental budget upsert --id project-limit --max-requests 20 --max-input-tokens 50000 --max-cost-usd 10 --max-concurrency 2 --max-retries 1 --expires-at 10000 --cwd '/canonical/project with space'",
      "headless doctor --cwd '/canonical/project with space'",
      "headless daemon status --cwd '/canonical/project with space'",
    ]));
    const rendered = renderedText(ConfigView({ state, width: 140, height: 40 }));
    expect(rendered).toContain("headless project trust grant --allow-native-direct-unrestricted --cwd '/canonical/project with space'");
    expect(rendered).toContain("headless experimental budget upsert --id project-limit");
    expect(rendered).toContain("headless daemon status --cwd '/canonical/project with space'");
    expect(rendered).toContain("↳ claude · running · parent parent · fraction 0.25");
  });

  test("never turns prompt-like input into daemon mutations", async () => {
    let state = initialControlRoomState("/project");
    const statuses: string[] = [];
    const client = new FakeClient({});
    const controller = new TuiController(client, {
      getState: () => state,
      patchState: (patch) => { state = { ...state, ...patch }; },
      setStatus: (status) => { statuses.push(status); },
      exit: () => undefined,
    });

    controller.execute("/approve approval-one");
    controller.execute("ship this candidate");
    controller.execute("/logs verbose");
    expect(client.calls).toEqual([]);
    expect(state.logMode).toBe("verbose");
    expect(statuses).toContain("The TUI is read-only. Use tabs, arrows, event filters, or the Headless CLI.");
  });

  test("reconnects with bounded caller-provided delays", async () => {
    const failures: string[] = [];
    let attempts = 0;
    await runReconnectLoop({
      connect: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("socket reset");
        return "connected";
      },
      connected: async (value) => { expect(value).toBe("connected"); },
      failed: (error) => failures.push(error instanceof Error ? error.message : String(error)),
      signal: new AbortController().signal,
      delays: [0],
    });
    expect(attempts).toBe(2);
    expect(failures).toEqual(["socket reset"]);
  });

  test("keeps filtering, grouping, redaction, readiness, and observer guidance", () => {
    const first = eventFixture("one", 10, 1);
    const duplicate = eventFixture("two", 11, 2);
    const failure = completionFixture("failed", 12, 3);
    expect(mergeRunEvents([first], [first, duplicate, failure])).toHaveLength(3);
    expect(groupRepeatedEvents([first, duplicate])[0]?.count).toBe(2);
    expect(filterEvents([first, failure], "failures")).toEqual([failure]);
    expect(formatEventLine(failure).text).toContain("Provider disconnected");
    expect(safeInline("token sk-1234567890abcdefghijkl\u001b[31m")).not.toContain("sk-1234567890abcdefghijkl");
    expect(providerReadiness({ id: "worker", backend: "codex", authenticated: false, healthy: false, rateLimited: false, load: 0, detail: "login required" })).toBe("Login required");

    const state = { ...initialControlRoomState("/project"), connection: "connected" as const };
    expect(controlSummary(state)).toMatchObject({ interface: "observer", core: "external", lead: "not configured" });
    expect(healthSummary(state).daemon).toBe("Ready");
    expect(nextActions(state).map((action) => action.command)).toEqual(expect.arrayContaining(["headless lead use <host>", "headless project trust status"]));
  });

  test("keeps trust acknowledgement distinct from provider login failures", () => {
    const command = 'headless project trust grant --allow-native-direct-unrestricted --cwd "/project"';
    const profile = nativeFleetFixture();
    const trustHealth = {
      id: "native-worker",
      backend: "codex",
      authenticated: false,
      healthy: false,
      rateLimited: false,
      load: 0,
      detail: "Project trust with native acknowledgement is not granted.",
      presentation: {
        code: "trust_required",
        reason: "Project trust with native acknowledgement is not granted.",
        recovery: command,
      },
    };
    const state: TuiControlRoomState = {
      ...initialControlRoomState("/project"),
      connection: "connected",
      projectTrust: { trusted: true, nativeLoginAllowed: true, nativeDirectUnrestrictedAcknowledged: false, bypassAllowed: false },
      fleetProfiles: [profile],
      activeFleetProfileId: profile.id,
      fleetHealth: [trustHealth],
    };

    expect(providerReadiness(trustHealth)).toBe("Trust required");
    expect(healthSummary(state)).toMatchObject({ trust: "native consent required", ready: 0, loginRequired: 0, blocked: 1 });
    expect(fleetAgentRows(state)[0]).toMatchObject({
      readiness: "Trust required",
      auth: "trust required",
      recovery: {
        explanation: "Project trust with native acknowledgement is not granted.",
        nextAction: command,
      },
    });

    const rendered = plainText(renderToString(React.createElement(FleetView, { state, width: 160, height: 32, selected: 0 }), { columns: 160 }));
    expect(rendered).toContain("Trust required");
    expect(rendered).toContain(command);
    expect(rendered).not.toContain("codex login");

    for (const backend of ["codex", "opencode"]) {
      expect(providerReadiness({
        ...trustHealth,
        backend,
        presentation: { code: "login_required", reason: "Credential missing.", recovery: "Authenticate externally." },
      })).toBe("Login required");
    }
    const nativeLoginRows = fleetAgentRows({
      fleetProfiles: [profile],
      activeFleetProfileId: profile.id,
      fleetHealth: [{
        ...trustHealth,
        presentation: { code: "login_required", reason: "Native login missing.", recovery: "Run the native login flow." },
      }],
    });
    const brokerProfile = fleetFixture();
    const brokerLoginRows = fleetAgentRows({
      fleetProfiles: [brokerProfile],
      activeFleetProfileId: brokerProfile.id,
      fleetHealth: [{
        ...trustHealth,
        id: "worker",
        backend: "opencode",
        presentation: { code: "login_required", reason: "Broker credential missing.", recovery: "Seed the daemon credential." },
      }],
    });
    expect(nativeLoginRows[0]).toMatchObject({ readiness: "Login required", recovery: { nextAction: "Run the native login flow." } });
    expect(brokerLoginRows[0]).toMatchObject({ readiness: "Login required", recovery: { nextAction: "Seed the daemon credential." } });
  });

  test("uses one height-aware geometry for compact and wide headers", () => {
    const sourceProfile = fleetFixture();
    const profile = {
      ...sourceProfile,
      agents: Array.from({ length: 30 }, (_, index) => ({ ...sourceProfile.agents[0]!, id: `worker-${index}`, name: `Worker ${index}` })),
    };
    const state: TuiControlRoomState = {
      ...initialControlRoomState("/project"),
      fleetProfiles: [profile],
      activeFleetProfileId: profile.id,
      goals: Array.from({ length: 30 }, (_, index) => ({ ...goalFixture(), id: `goal-${index}`, createdAt: index + 1, updatedAt: index + 1 })),
      approvals: Array.from({ length: 30 }, (_, index) => approvalFixture(index)),
    };
    const cases = [
      { height: 20, frame: 14, inset: 0, content: 14, top: 4, list: 12, approvals: 7 },
      { height: 23, frame: 17, inset: 0, content: 17, top: 4, list: 15, approvals: 10 },
      { height: 24, frame: 18, inset: 1, content: 17, top: 5, list: 15, approvals: 10 },
      { height: 32, frame: 26, inset: 1, content: 25, top: 5, list: 23, approvals: 18 },
    ];
    for (const item of cases) {
      expect(contentFrameRows(item.height)).toBe(item.frame);
      expect(contentInsetRows(item.height)).toBe(item.inset);
      expect(contentRows(item.height)).toBe(item.content);
      expect(contentStartRow(item.height)).toBe(item.top);
      expect(listContentRows(item.height)).toBe(item.list);
      expect(listContentRows(item.height, 7)).toBe(item.approvals);
      expect(fleetListMeta(state, 120, item.height, 0).rows).toBe(item.list);
      expect(goalsListMeta(state, 120, item.height, 0, "all").rows).toBe(item.list);
      expect(approvalsListMeta(state, 120, item.height, 0).rows).toBe(item.approvals);
    }

    expect(headerTabsMode(120)).toBe(true);
    expect(tabRowFor(120)).toBe(2);
    expect(headerTabsMode(100)).toBe(false);
    expect(tabRowFor(100)).toBe(3);
    for (const width of [100, 120]) {
      const compact = buildHitZones({ width, height: 23, view: "fleet", list: { rows: 50, start: 4, total: 100, paneWidth: 44 } });
      const airy = buildHitZones({ width, height: 24, view: "fleet", list: { rows: 50, start: 4, total: 100, paneWidth: 44 } });
      expect(compact.list).toMatchObject({ fromY: 6, toY: 20, fromX: 3, toX: 46 });
      expect(airy.list).toMatchObject({ fromY: 7, toY: 21, fromX: 3, toX: 46 });
      expect(hitTest(3, compact.list!.fromY, compact)).toEqual({ kind: "row", index: 4 });
      expect(hitTest(3, airy.list!.fromY + 1, airy)).toEqual({ kind: "row", index: 5 });
      expect(hitTest(2, airy.list!.fromY, airy)).toBeUndefined();
    }
  });

  test("renders compact chrome within 60x20 and adds the roomy content inset", () => {
    const state = { ...initialControlRoomState("/project"), connection: "connected" as const, status: "Observer snapshot refreshed." };
    const compact = renderFrame(state, 60, 20);
    // A compact terminal spends every row on content: the first section starts
    // immediately under the tabs, with no inset and no gaps between groups.
    expect(compact).toHaveLength(20);
    expect(compact[3]).toContain("TOPOLOGY");
    expect(compact[5]).toContain("HEALTH");
    expect(compact.at(-2)).toContain("ready");
    expect(compact.at(-1)).toContain("views");

    // One row below the inset threshold: still no leading blank, but tall
    // enough to separate the groups.
    const preThreshold = renderFrame(state, 100, 23);
    expect(preThreshold[3]).toContain("TOPOLOGY");
    expect(preThreshold[5]).toBe("");
    expect(preThreshold[6]).toContain("HEALTH");

    // At the threshold the view spends its first row on breathing room.
    const threshold = renderFrame(state, 100, 24);
    expect(threshold).toHaveLength(24);
    expect(threshold[3]).toBe("");
    expect(threshold[4]).toContain("TOPOLOGY");
    expect(threshold[6]).toBe("");
    expect(threshold[9]).toBe("");

    const views = [
      React.createElement(OverviewView, { state, width: 120, height: 24 }),
      React.createElement(FleetView, { state, width: 120, height: 24, selected: 0 }),
      React.createElement(GoalsView, { state, width: 120, height: 24, selected: 0 }),
      React.createElement(ApprovalsView, { state, width: 120, height: 24, selected: 0 }),
      React.createElement(EventsView, { state, width: 120, height: 24, scrollBack: 0 }),
      React.createElement(ConfigView, { state, width: 120, height: 24 }),
      React.createElement(HelpView, { width: 120, height: 24 }),
    ];
    for (const component of views) {
      expect(plainText(renderToString(component, { columns: 120 })).startsWith("\n")).toBe(true);
    }
  });

  /**
   * The footer used to put two `space-between` children in a fixed-width row,
   * each truncating on its own. Once they stopped fitting they overlapped:
   * at 100 columns the hints were cut mid-word and the caption ran straight
   * into them ("q quv0.2.0-beta.4"). The hints are how the operator drives the
   * TUI, so they win; the caption is decoration and yields whole.
   */
  test("never lets the footer caption collide with the key hints", () => {
    const hints: Array<[string, string]> = [
      ["\u21e5", "views"], ["1-7", "jump"], ["\u2191\u2193", "select"], ["r", "refresh"], ["q", "quit"],
    ];
    const caption = "v0.2.0-beta.4 \u00b7 \u00a9 2026 proofofwork.agency \u00b7 MIT";

    for (const width of [60, 72, 80, 100, 120, 140, 200]) {
      const { visibleHints, right } = footerLayout(hints, caption, width);
      const hintsWidth = visibleHints.reduce(
        (total, [key, action], index) => total + key.length + 1 + action.length + (index > 0 ? 3 : 0),
        0,
      );
      const used = hintsWidth + (right ? 3 + right.length : 0);
      expect(used, `width ${width} must not overflow the row`).toBeLessThanOrEqual(width - 4);
      // Hints are dropped whole, never sliced into a partial key binding.
      expect(visibleHints).toEqual(hints.slice(0, visibleHints.length));
    }

    // Wide terminals keep everything; the reported-broken width keeps every hint.
    expect(footerLayout(hints, caption, 140).right).toBe(caption);
    expect(footerLayout(hints, caption, 100).visibleHints).toHaveLength(hints.length);
    expect(footerLayout(hints, caption, 100).right).toBe("");
  });

  test("retains compact keyboard and mouse navigation geometry", () => {
    const tabs = buildTabLayout(120);
    expect(tabs.length).toBeGreaterThan(3);
    expect(nextView("overview")).not.toBe("overview");
    expect(viewForDigit("6")).toBe("config");
    expect(viewForDigit("7")).toBe("help");
    const zones = buildHitZones({ width: 120, height: 32, view: "goals", list: { rows: 4, start: 2, total: 10 } });
    expect(hitTest(tabs[0]!.from, zones.tabY, zones)).toEqual({ kind: "view", view: tabs[0]!.view });
    expect(hitTest(3, zones.list!.fromY, zones)).toEqual({ kind: "row", index: 2 });
    expect(listWindowStart(9, 4, 10)).toBe(6);
    expect(parseMouseEvents("\u001b[<0;8;4M\u001b[<65;8;8M")).toEqual([
      { x: 8, y: 4, kind: "press" },
      { x: 8, y: 8, kind: "wheel-down" },
    ]);
  });
});

class FakeClient {
  calls: Array<{ method: string; params: unknown }> = [];
  constructor(private readonly responses: Record<string, unknown>) {}
  async call<T>(method: string, params: unknown = {}): Promise<T> {
    this.calls.push({ method, params });
    if (!(method in this.responses)) throw new Error(`unexpected method ${method}`);
    return this.responses[method] as T;
  }
}

function fleetFixture(): FleetProfile {
  return {
    id: "fleet-main", projectId: "project-id", name: "Workers", authMode: "broker", approvalPolicy: "ask",
    agents: [{ id: "worker", backend: "opencode", name: "Worker", authMode: "broker", approvalPolicy: "ask", enabled: true, priority: 1, capabilities: [], maxConcurrentTurns: 1, createdAt: 1, updatedAt: 1 }],
    maxActiveWorkers: 4, maxQueuedDelegations: 64, maxDeliberationRounds: 8, maxAttemptsPerDelegation: 2,
    goalTimeoutMs: 3_600_000, idleAutonomy: "suggest", createdAt: 1, updatedAt: 1,
  };
}

function nativeFleetFixture(): FleetProfile {
  const profile = fleetFixture();
  return {
    ...profile,
    id: "fleet-native",
    authMode: "native-login",
    agents: [{ ...profile.agents[0]!, id: "native-worker", backend: "codex", name: "Native worker", authMode: "native-login" }],
  };
}

function goalFixture(): Goal {
  return {
    id: "goal-one", projectId: "project-id", principal: "lead", fleetProfileId: "fleet-main", objective: "Observe durable work.",
    mode: "read-only", state: "active", authMode: "broker", approvalPolicy: "ask", synthesizer: { kind: "automatic" },
    synthesizerAgentId: "worker", autonomous: true, deadlineAt: 10_000, createdAt: 1, updatedAt: 2,
  };
}

function budgetFixture(): Budget {
  return {
    id: "project-limit", projectId: "project-id", principal: null, sessionId: null, workflowId: null, provider: null,
    maxRequests: 20, maxInputTokens: 50_000, maxOutputTokens: null, maxCostUsd: 10, maxArtifactBytes: null,
    maxConcurrency: 2, maxRetries: 1, expiresAt: 10_000, usedRequests: 2,
    usedUsage: { input: 1_000, output: 200, reasoning: 0, cached: 0, providerTotal: 1_200 },
    usedCost: { amountUsd: 1.25, source: "reconciled", pricingId: null, observedRequests: 2 },
    usedArtifactBytes: 0, updatedAt: 1,
  };
}

function approvalFixture(index: number): TuiControlRoomState["approvals"][number] {
  return {
    id: `approval-${index}`,
    collaborationId: "collaboration",
    requestedBy: "worker",
    assignedTo: "operator",
    kind: "merge",
    status: "pending",
    summary: `Approve candidate ${index}.`,
    details: {},
    artifactIds: [],
    resolvedBy: null,
    resolution: null,
    expiresAt: 100_000,
    resolvedAt: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function eventFixture(id: string, timestamp: number, sequence: number): RunEvent {
  return { version: 2, eventId: id, jobId: "job-one", sessionId: null, sequence, timestamp, redacted: true, kind: "lifecycle", state: "running" };
}

function completionFixture(id: string, timestamp: number, sequence: number): RunEvent {
  return {
    version: 2, eventId: id, jobId: "job-one", sessionId: null, sequence, timestamp, redacted: true, kind: "completion",
    result: { status: "failed", backend: "codex", output: "provider endpoint disconnected", error: null } as never,
  };
}

function renderedText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(renderedText).join("");
  if (!React.isValidElement<{ children?: React.ReactNode }>(value)) return "";
  return renderedText(React.Children.toArray(value.props.children));
}

function renderFrame(state: TuiControlRoomState, width: number, height: number) {
  const view = "overview" as const;
  const frame = React.createElement(
    TuiFrame,
    { state, width, height, view, tabs: buildTabLayout(width), working: false },
    React.createElement(OverviewView, { state, width, height }),
  );
  return plainText(renderToString(frame, { columns: width })).split("\n");
}

function plainText(value: string) {
  return stripVTControlCharacters(value);
}
