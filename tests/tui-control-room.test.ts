import { describe, expect, test } from "bun:test";
import type { FleetProfile, Goal } from "../src/contracts/collaboration";
import type { RunEvent } from "../src/contracts/run";
import {
  TuiController,
  restoreControlRoom,
  runReconnectLoop,
  type ControlRoomClient,
} from "../src/tui/controller";
import {
  controlSummary,
  filterEvents,
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
  hitTest,
  listWindowStart,
  nextView,
  parseMouseEvents,
} from "../src/tui/layout";

describe("Headless read-only TUI", () => {
  test("restores the control room from only observer snapshot and event operations", async () => {
    const goal = goalFixture();
    const fleet = fleetFixture();
    const event = eventFixture("event-one", 10, 1);
    const client = new FakeClient({
      ping: { projectId: "project-id", projectRoot: "/canonical/project", principal: "observer" },
      "observer.snapshot": {
        projectId: "project-id",
        projectRoot: "/canonical/project",
        lead: { host: "codex", backendId: "codex", generation: 2, status: "connected" },
        projectTrust: { trusted: true, nativeLoginAllowed: true, bypassAllowed: false },
        fleetProfiles: [fleet],
        activeFleetProfileId: fleet.id,
        fleetHealth: { leaderCandidates: [{ agent: { id: "worker", backend: "opencode" }, authenticated: true, health: "healthy", rateLimitedUntil: null, activeTurns: 1, detail: "ready" }] },
        goals: [goal],
        goalTurns: { [goal.id]: [] },
        goalMessages: { [goal.id]: [] },
        approvals: [],
        jobs: [{ state: "running" }, { state: "queued" }],
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
      orchestration: { enabled: true, activeJobs: 1, queuedJobs: 1, mode: "automatic" },
    });
    expect(restored.patch.events).toEqual([event]);
    expect(restored.patch.fleetHealth).toMatchObject([{ id: "worker", backend: "opencode", healthy: true }]);
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

  test("retains compact keyboard and mouse navigation geometry", () => {
    const tabs = buildTabLayout(120);
    expect(tabs.length).toBeGreaterThan(3);
    expect(nextView("overview")).not.toBe("overview");
    const zones = buildHitZones({ width: 120, height: 32, view: "goals", list: { rows: 4, start: 2, total: 10 } });
    expect(hitTest(tabs[0]!.from, zones.tabY, zones)).toEqual({ kind: "view", view: tabs[0]!.view });
    expect(hitTest(2, zones.list!.fromY, zones)).toEqual({ kind: "row", index: 2 });
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

function goalFixture(): Goal {
  return {
    id: "goal-one", projectId: "project-id", principal: "lead", fleetProfileId: "fleet-main", objective: "Observe durable work.",
    mode: "read-only", state: "active", authMode: "broker", approvalPolicy: "ask", synthesizer: { kind: "automatic" },
    synthesizerAgentId: "worker", autonomous: true, deadlineAt: 10_000, createdAt: 1, updatedAt: 2,
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
