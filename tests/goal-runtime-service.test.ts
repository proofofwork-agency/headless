import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CandidateIntegrationService } from "../src/runtime/candidate-integration-service";
import { DirectedMailbox } from "../src/runtime/directed-mailbox";
import { FinalityStore } from "../src/runtime/finality-store";
import { FleetProfileStore } from "../src/runtime/fleet-profile-store";
import { GoalStore } from "../src/runtime/goal-store";
import { OrchestrationStateStore } from "../src/runtime/orchestration-state";
import { PersistentSessionStore } from "../src/runtime/persistent-sessions";
import { ensureProjectStateDirectories, getProjectStatePaths } from "../src/runtime/project-state";
import { ProjectTrustStore } from "../src/runtime/project-trust-store";
import { GoalRuntimeService } from "../src/daemon/goal-runtime-service";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("daemon goal runtime service", () => {
  test("owns the durable delegation scheduler and restart-deduplicated idle scanner", async () => {
    const fixture = createFixture();
    const first = createRuntime(fixture, { activeJobs: 2, queuedJobs: 3 });

    expect(first.delegationScheduler.maxActive).toBe(4);
    expect(first.delegationScheduler.maxQueued).toBe(64);
    expect(first.enableAutonomy()).toMatchObject({ enabled: true, activeJobs: 2, queuedJobs: 3 });

    const scan = await first.scanAutonomy();
    expect(scan).not.toBeNull();
    expect(scan!.actions).toHaveLength(1);
    expect(scan!.actions[0]).toMatchObject({ outcome: "suggested", opportunity: { kind: "idle_worker" } });
    const messages = fixture.mailbox.snapshot().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      collaborationId: "goal-main",
      recipientId: "leader",
      kind: "lifecycle",
      artifactIds: [scan!.actions[0]!.laneId],
    });
    first.dispose();

    const restarted = createRuntime(fixture, { activeJobs: 0, queuedJobs: 0 });
    expect((await restarted.scanAutonomy())!.opportunities).toBe(0);
    expect(fixture.mailbox.snapshot().messages).toHaveLength(1);
    expect(restarted.disableAutonomy()).toMatchObject({ enabled: false, activeJobs: 0, queuedJobs: 0 });
    restarted.dispose();
  });

  test("rejects new goals while daemon shutdown is in progress", () => {
    const fixture = createFixture();
    const runtime = createRuntime(fixture, { activeJobs: 0, queuedJobs: 0 }, true);
    expect(() => runtime.startGoal({ objective: "Do not start." }, {
      id: "root",
      principal: "owner",
      kind: "root",
      scopes: ["admin"],
      createdAt: 1,
      expiresAt: null,
      revokedAt: null,
    })).toThrow("shutting down");
    runtime.dispose();
  });

  test("dispose drains an in-flight autonomy scan instead of diagnosing it afterwards", async () => {
    // startAutonomyScan is fire-and-forget: `void this.scanAutonomy().catch(...)`.
    // dispose() clears the interval and disposes the coordinator, but neither
    // awaits nor aborts a scan already running. The scan therefore resumes into
    // a torn-down runtime, fails, and its .catch LOGS that failure — errors
    // attributed to a runtime that no longer exists. That is the background
    // leakage recorded in docs/internal/hosted-linux-relay-follow-up.md as
    // crossing test/runtime ownership boundaries.
    //
    // Localised from source by Codex, after two of my own theories about this
    // fault were disproved by experiment.
    const fixture = createFixture();
    fixture.orchestration.setEnabled(true);
    const runtime = createRuntime(fixture, { activeJobs: 0, queuedJobs: 0 });
    const internals = runtime as unknown as {
      diagnostic: (message: string, error?: unknown) => void;
      idleAutonomy: { scan: () => Promise<unknown> };
      startAutonomyScan: () => void;
    };
    const diagnostics: string[] = [];
    internals.diagnostic = (message) => diagnostics.push(message);

    let failScan: (() => void) | undefined;
    // Held open so dispose() lands mid-scan, the only state that reproduces
    // this. A scan settling first proves nothing.
    internals.idleAutonomy = {
      scan: () => new Promise((_resolve, reject) => {
        failScan = () => reject(new Error("Unknown goal: goal_torn_down"));
      }),
    };

    internals.startAutonomyScan();
    await Bun.sleep(10);
    runtime.dispose();
    failScan?.();
    await Bun.sleep(80);

    expect(
      diagnostics.filter((message) => message.includes("Idle autonomy scan failed")),
      "a disposed runtime must not report failures for work it no longer owns",
    ).toEqual([]);
  });

});

type Fixture = ReturnType<typeof createFixture>;

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "headless-goal-runtime-"));
  const runtime = join("/tmp", `hgr-${process.pid}-${roots.length}`);
  const project = join(root, "project");
  mkdirSync(project);
  roots.push(root);
  roots.push(runtime);
  const stateOptions = {
    env: { ...process.env, HEADLESS_STATE_HOME: join(root, "state"), HEADLESS_RUNTIME_HOME: runtime },
    homeDir: root,
    platform: "linux" as const,
  };
  const paths = ensureProjectStateDirectories(getProjectStatePaths(project, stateOptions));
  const staleNow = Date.now() - 10_000;
  const fleets = new FleetProfileStore(paths, { now: () => staleNow, id: () => "fleet-main" });
  const profile = fleets.create({
    id: "fleet-main",
    name: "Autonomous fleet",
    agents: [{ id: "leader", backend: "codex", name: "Leader" }],
    idleAutonomy: "suggest",
  });
  fleets.setActive(profile.id);
  const goals = new GoalStore(paths, { now: () => staleNow, id: () => "goal-main" });
  goals.create({
    id: "goal-main",
    principal: "owner",
    fleetProfileId: profile.id,
    objective: "Keep autonomous work moving.",
    authMode: "native-login",
    approvalPolicy: "auto",
    synthesizer: { kind: "agent", agentId: "leader" },
    synthesizerAgentId: "leader",
    autonomous: true,
    deadlineAt: Date.now() + 60_000,
  });
  goals.transition("goal-main", "active", "owner", "Begin autonomous work.");
  const mailbox = new DirectedMailbox({ statePath: join(paths.projectDir, "directed-mailbox.json") });
  return {
    paths,
    stateOptions,
    fleets,
    goals,
    mailbox,
    sessions: new PersistentSessionStore(paths),
    finality: new FinalityStore(paths),
    trust: new ProjectTrustStore(paths),
    orchestration: new OrchestrationStateStore(paths),
  };
}

function createRuntime(fixture: Fixture, load: { activeJobs: number; queuedJobs: number }, stopping = false) {
  return new GoalRuntimeService({
    paths: fixture.paths,
    stateOptions: fixture.stateOptions,
    coordinatorPrincipal: "owner",
    maxConcurrency: 4,
    maxQueued: 64,
    fleets: fixture.fleets,
    goals: fixture.goals,
    sessions: fixture.sessions,
    jobs: { get: () => null },
    finality: fixture.finality,
    candidates: {} as CandidateIntegrationService,
    mailbox: fixture.mailbox,
    trust: fixture.trust,
    orchestration: fixture.orchestration,
    availability: () => ({
      authenticated: true,
      health: "healthy",
      rateLimitedUntil: null,
      activeTurns: 0,
      recentFailures: 0,
    }),
    createSession: () => { throw new Error("goal execution is outside this focused test"); },
    submitRun: () => { throw new Error("run admission is outside this focused test"); },
    waitRun: () => { throw new Error("run completion is outside this focused test"); },
    cancelRun: () => undefined,
    isStopping: () => stopping,
    load: () => load,
    scanIntervalMs: 60_000,
  });
}
