import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalPolicy, ProjectTrust } from "../src/contracts/native";
import { FleetProfileStore } from "../src/runtime/fleet-profile-store";
import { GoalStore } from "../src/runtime/goal-store";
import {
  IdleAutonomyService,
  type IdleAutonomyEvidence,
  type IdleAutonomyServiceOptions,
  type IdleSuggestionLane,
} from "../src/runtime/idle-autonomy-service";
import { DeterministicIdleOpportunityDetector } from "../src/runtime/idle-opportunity-detector";
import { ensureProjectStateDirectories, getProjectStatePaths } from "../src/runtime/project-state";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("durable idle autonomy service", () => {
  test("scans only active autonomous goals after the eight-second quiescence boundary", async () => {
    const fixture = setup({ idleAutonomy: "suggest", autonomous: true });
    const lanes: IdleSuggestionLane[] = [];
    let now = 8_999;
    const service = createService(fixture, {
      now: () => now,
      collectEvidence: () => ({ ...oneOpportunityEvidence(1_000), quiescentSince: 0 }),
      publishLane: durablePublisher(lanes),
    });

    expect((await service.scan()).opportunities).toBe(0);
    now = 9_000;
    expect((await service.scan()).actions).toHaveLength(1);
    expect(lanes).toHaveLength(1);

    const nonAutonomous = setup({ idleAutonomy: "suggest", autonomous: false });
    const ignored = createService(nonAutonomous, {
      now: () => 100_000,
      collectEvidence: () => oneOpportunityEvidence(1_000),
      publishLane: () => { throw new Error("must not publish"); },
    });
    expect(await ignored.scan()).toMatchObject({ eligibleGoals: 0, opportunities: 0, actions: [] });

    const queued = setup({ idleAutonomy: "suggest", autonomous: true, active: false });
    const queuedService = createService(queued, {
      now: () => 100_000,
      collectEvidence: () => oneOpportunityEvidence(1_000),
      publishLane: () => { throw new Error("queued goal must not publish"); },
    });
    expect(await queuedService.scan()).toMatchObject({ eligibleGoals: 0, opportunities: 0 });
  });

  test("derives and surfaces all five deterministic opportunity kinds from durable goal state", async () => {
    const fixture = setup({ idleAutonomy: "suggest", autonomous: true });
    populateGoalEvidence(fixture.goals, fixture.goalId);
    const lanes: IdleSuggestionLane[] = [];
    const service = createService(fixture, { now: () => 100_000, publishLane: durablePublisher(lanes) });
    const report = await service.scan();

    expect(new Set(report.actions.map((entry) => entry.opportunity.kind))).toEqual(new Set([
      "failed_gate_without_follow_up",
      "unverified_completion",
      "stalled_work",
      "unresolved_candidate",
      "idle_worker",
    ]));
    expect(report.actions.every((entry) => entry.outcome === "suggested")).toBe(true);
    expect(new Set(lanes.map((lane) => lane.id)).size).toBe(lanes.length);
    expect(lanes.every((lane) => lane.id === `idle_${lane.opportunity.fingerprint.slice(0, 48)}`)).toBe(true);
  });

  test("deduplicates across restart and safely retries the same deterministic lane after publication failure", async () => {
    const fixture = setup({ idleAutonomy: "suggest", autonomous: true });
    const detectorPath = join(fixture.paths.projectDir, "idle-detector.json");
    const evidence = oneOpportunityEvidence(1_000);
    const firstLanes: IdleSuggestionLane[] = [];
    const firstDetector = new DeterministicIdleOpportunityDetector({ statePath: detectorPath });
    const first = createService(fixture, {
      detector: firstDetector,
      now: () => 100_000,
      collectEvidence: () => evidence,
      publishLane: (lane) => {
        expect(firstDetector.snapshot().fingerprints).toHaveLength(0);
        firstLanes.push(lane);
        return { laneId: lane.id, durable: true };
      },
    });
    expect((await first.scan()).actions).toHaveLength(1);
    expect(firstDetector.snapshot().fingerprints).toHaveLength(1);

    const reopened = createService(fixture, {
      detector: new DeterministicIdleOpportunityDetector({ statePath: detectorPath }),
      now: () => 100_001,
      collectEvidence: () => evidence,
      publishLane: () => { throw new Error("dedupe failed"); },
    });
    expect((await reopened.scan()).opportunities).toBe(0);

    const retryFixture = setup({ idleAutonomy: "suggest", autonomous: true });
    const retryPath = join(retryFixture.paths.projectDir, "idle-detector.json");
    let failedLaneId = "";
    const failed = createService(retryFixture, {
      detector: new DeterministicIdleOpportunityDetector({ statePath: retryPath }),
      now: () => 100_000,
      collectEvidence: () => evidence,
      publishLane: (lane) => {
        failedLaneId = lane.id;
        throw new Error("durable task store unavailable");
      },
    });
    expect((await failed.scan()).actions[0]).toMatchObject({ outcome: "failed" });
    expect(new DeterministicIdleOpportunityDetector({ statePath: retryPath }).snapshot().fingerprints).toHaveLength(0);

    let retriedLaneId = "";
    const retried = createService(retryFixture, {
      detector: new DeterministicIdleOpportunityDetector({ statePath: retryPath }),
      now: () => 100_001,
      collectEvidence: () => evidence,
      publishLane: (lane) => {
        retriedLaneId = lane.id;
        return { laneId: lane.id, durable: true };
      },
    });
    expect((await retried.scan()).actions[0]).toMatchObject({ outcome: "suggested" });
    expect(retriedLaneId).toBe(failedLaneId);
  });

  test("shares one in-flight scan and bounds read-only verification to one request", async () => {
    const fixture = setup({ idleAutonomy: "read-only", autonomous: true });
    let publishResolve!: (value: { laneId: string; durable: true }) => void;
    let verificationCalls = 0;
    const service = createService(fixture, {
      now: () => 100_000,
      collectEvidence: () => oneOpportunityEvidence(1_000),
      publishLane: (lane) => new Promise((resolve) => {
        publishResolve = resolve;
        queueMicrotask(() => publishResolve({ laneId: lane.id, durable: true }));
      }),
      runReadOnlyVerification: ({ limits }) => {
        verificationCalls += 1;
        expect(limits).toMatchObject({ requestLimit: 1, tokenLimit: 20_000, timeoutMs: 30_000 });
        return { status: "verified", summary: "Verification passed.", tokensUsed: 10, artifactIds: [] };
      },
    });
    const first = service.scan();
    const second = service.scan();
    expect(second).toBe(first);
    expect((await first).actions[0]).toMatchObject({ outcome: "verified" });
    expect(verificationCalls).toBe(1);
  });

  test("caps automatic verification requests across an entire scan", async () => {
    const fixture = setup({ idleAutonomy: "read-only", autonomous: true });
    let verificationCalls = 0;
    const completions = Array.from({ length: 7 }, (_value, index) => ({
      id: `completion-${index}`,
      completedAt: 1_000 + index,
      verifiedAt: null,
    }));
    const service = createService(fixture, {
      now: () => 100_000,
      maxVerificationRequests: 4,
      collectEvidence: () => ({ ...oneOpportunityEvidence(1_000), completions }),
      publishLane: durablePublisher([]),
      runReadOnlyVerification: () => {
        verificationCalls += 1;
        return { status: "verified", summary: "checked", tokensUsed: 1, artifactIds: [] };
      },
    });
    const report = await service.scan();
    expect(verificationCalls).toBe(4);
    expect(report.actions.filter((entry) => entry.outcome === "verified")).toHaveLength(4);
    expect(report.actions.filter((entry) => entry.detail.includes("budget is exhausted"))).toHaveLength(3);
  });

  test("never escalates read-only mode into a write and rejects over-budget verification", async () => {
    const readOnly = setup({ idleAutonomy: "read-only", autonomous: true });
    let writes = 0;
    const readOnlyService = createService(readOnly, {
      now: () => 100_000,
      collectEvidence: () => oneOpportunityEvidence(1_000),
      publishLane: durablePublisher([]),
      runReadOnlyVerification: () => ({ status: "needs-write", summary: "A change is needed.", tokensUsed: 2, artifactIds: [] }),
      runWrite: () => { writes += 1; return { status: "applied", summary: "unexpected", tokensUsed: 1, artifactIds: [] }; },
    });
    expect((await readOnlyService.scan()).actions[0]).toMatchObject({ outcome: "blocked", detail: "A change is needed." });
    expect(writes).toBe(0);

    const overBudget = setup({ idleAutonomy: "write", approvalPolicy: "auto", autonomous: true });
    const overBudgetService = createService(overBudget, {
      now: () => 100_000,
      tokenLimit: 10,
      collectEvidence: () => oneOpportunityEvidence(1_000),
      publishLane: durablePublisher([]),
      runReadOnlyVerification: () => ({ status: "needs-write", summary: "change", tokensUsed: 11, artifactIds: [] }),
    });
    expect((await overBudgetService.scan()).actions[0]).toMatchObject({ outcome: "failed" });

    const timed = setup({ idleAutonomy: "read-only", autonomous: true });
    let aborted = false;
    const timedService = createService(timed, {
      now: () => 100_000,
      verificationTimeoutMs: 5,
      collectEvidence: () => oneOpportunityEvidence(1_000),
      publishLane: durablePublisher([]),
      runReadOnlyVerification: ({ signal }) => new Promise((_resolve) => {
        signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      }),
    });
    expect((await timedService.scan()).actions[0]).toMatchObject({ outcome: "failed" });
    expect(aborted).toBe(true);
  });

  test("blocks writes without auto policy, trust, passed gates, clean primary, and a lease", async () => {
    const ask = setup({ idleAutonomy: "write", approvalPolicy: "ask", autonomous: true });
    let setupCalls = 0;
    const askService = writeService(ask, { getProjectTrust: () => { setupCalls += 1; return trust(ask, true); } });
    expect((await askService.scan()).actions[0].detail).toContain("auto or bypass");
    expect(setupCalls).toBe(0);

    const untrusted = setup({ idleAutonomy: "write", approvalPolicy: "auto", autonomous: true });
    const untrustedService = writeService(untrusted, { getProjectTrust: () => trust(untrusted, false) });
    expect((await untrustedService.scan()).actions[0].detail).toContain("Project trust");

    const gated = setup({ idleAutonomy: "write", approvalPolicy: "auto", autonomous: true });
    let inspected = 0;
    const gatedService = writeService(gated, {
      authorizeWrite: () => ({ allowed: true, gatesPassed: false, reason: "Finality gate is pending." }),
      inspectPrimary: () => { inspected += 1; return { dirty: false, evidence: "clean" }; },
    });
    expect((await gatedService.scan()).actions[0].detail).toBe("Finality gate is pending.");
    expect(inspected).toBe(0);

    const dirty = setup({ idleAutonomy: "write", approvalPolicy: "auto", autonomous: true });
    let leases = 0;
    const dirtyService = writeService(dirty, {
      inspectPrimary: () => ({ dirty: true, evidence: "user changes present" }),
      acquireWorktreeLease: () => { leases += 1; return null; },
    });
    expect((await dirtyService.scan()).actions[0].detail).toContain("dirty");
    expect(leases).toBe(0);

    const noLease = setup({ idleAutonomy: "write", approvalPolicy: "auto", autonomous: true });
    const noLeaseService = writeService(noLease, { acquireWorktreeLease: () => null });
    expect((await noLeaseService.scan()).actions[0].detail).toContain("No isolated worktree lease");

    const inheritedAsk = setup({
      idleAutonomy: "write",
      fleetApprovalPolicy: "auto",
      goalApprovalPolicy: "ask",
      autonomous: true,
    });
    expect((await writeService(inheritedAsk).scan()).actions[0].detail).toContain("goal approval policy");

    const nativeDisabled = setup({ idleAutonomy: "write", approvalPolicy: "auto", autonomous: true });
    const disabledTrust = trust(nativeDisabled, true);
    disabledTrust.nativeLoginAllowed = false;
    expect((await writeService(nativeDisabled, { getProjectTrust: () => disabledTrust }).scan()).actions[0].detail)
      .toContain("does not allow native login");

    const invalidLease = setup({ idleAutonomy: "write", approvalPolicy: "auto", autonomous: true });
    expect((await writeService(invalidLease, { validateWorktreeLease: () => false }).scan()).actions[0].detail)
      .toContain("authority validation");
  });

  test("rechecks primary after leasing, always releases, and exposes only leased worktree authority", async () => {
    const changed = setup({ idleAutonomy: "write", approvalPolicy: "auto", autonomous: true });
    let inspections = 0;
    let changedWrites = 0;
    const changedReleases: unknown[] = [];
    const changedService = writeService(changed, {
      inspectPrimary: () => inspections++ === 0
        ? { dirty: false, evidence: "clean before lease" }
        : { dirty: true, evidence: "user edited primary" },
      acquireWorktreeLease: () => ({
        id: "lease-changed",
        token: "lease-token",
        worktreePath: "/tmp/leased-changed",
        release: (input) => { changedReleases.push(input); },
      }),
      runWrite: () => { changedWrites += 1; return { status: "applied", summary: "unexpected", tokensUsed: 1, artifactIds: [] }; },
    });
    expect((await changedService.scan()).actions[0]).toMatchObject({ outcome: "blocked" });
    expect(changedWrites).toBe(0);
    expect(changedReleases).toEqual([{ outcome: "skipped_dirty_primary", evidence: ["user edited primary"] }]);

    const happy = setup({ idleAutonomy: "write", approvalPolicy: "bypass", autonomous: true });
    const releases: unknown[] = [];
    let writeInput: Record<string, unknown> | null = null;
    const happyService = writeService(happy, {
      getProjectTrust: () => trust(happy, true, true),
      acquireWorktreeLease: () => ({
        id: "lease-happy",
        token: "scoped-token",
        worktreePath: "/tmp/leased-happy",
        release: (input) => { releases.push(input); },
      }),
      runWrite: (input) => {
        writeInput = input as unknown as Record<string, unknown>;
        return { status: "applied", summary: "Candidate updated in leased worktree.", tokensUsed: 12, artifactIds: ["artifact-one"] };
      },
    });
    expect((await happyService.scan()).actions[0]).toMatchObject({ outcome: "written" });
    expect(writeInput).not.toHaveProperty("projectRoot");
    expect(writeInput).not.toHaveProperty("primaryRoot");
    expect(writeInput?.lease).toEqual({ id: "lease-happy", token: "scoped-token", worktreePath: "/tmp/leased-happy" });
    expect(releases).toEqual([{
      outcome: "completed",
      evidence: ["Candidate updated in leased worktree.", "artifact-one"],
    }]);
  });

  test("delegates writes to the daemon-managed path without exposing filesystem or lease authority", async () => {
    const fixture = setup({ idleAutonomy: "write", approvalPolicy: "auto", autonomous: true });
    let managedInput: Record<string, unknown> | null = null;
    let manualAuthorizationCalls = 0;
    const service = createService(fixture, {
      now: () => 100_000,
      collectEvidence: () => oneOpportunityEvidence(1_000),
      publishLane: durablePublisher([]),
      runReadOnlyVerification: () => ({
        status: "needs-write",
        summary: "The candidate needs one contained change.",
        tokensUsed: 7,
        artifactIds: ["verification-artifact"],
      }),
      getProjectTrust: () => trust(fixture, true),
      inspectPrimary: () => ({ dirty: false, evidence: "Primary checkout is clean." }),
      authorizeWrite: () => {
        manualAuthorizationCalls += 1;
        throw new Error("manual write path must not be selected");
      },
      runManagedWrite: (input) => {
        managedInput = input as unknown as Record<string, unknown>;
        return { status: "applied", summary: "Managed candidate passed gates and integrated.", tokensUsed: 11, artifactIds: ["candidate-job"] };
      },
    });

    expect((await service.scan()).actions[0]).toMatchObject({
      outcome: "written",
      detail: "Managed candidate passed gates and integrated.",
    });
    expect(manualAuthorizationCalls).toBe(0);
    expect(managedInput).not.toHaveProperty("projectRoot");
    expect(managedInput).not.toHaveProperty("primaryRoot");
    expect(managedInput).not.toHaveProperty("worktreePath");
    expect(managedInput).not.toHaveProperty("lease");
    expect(managedInput?.verification).toMatchObject({ artifactIds: ["verification-artifact"] });
    expect(managedInput?.limits).toMatchObject({ requestLimit: 1, timeoutMs: 120_000, tokenLimit: 19_993 });
    expect(managedInput?.signal).toBeInstanceOf(AbortSignal);
  });

  test("fails closed before daemon-managed writes when trust, policy, primary, or durable goal eligibility changes", async () => {
    const ask = setup({ idleAutonomy: "write", approvalPolicy: "ask", autonomous: true });
    let managedCalls = 0;
    const managed = () => {
      managedCalls += 1;
      return { status: "applied" as const, summary: "unexpected", tokensUsed: 1, artifactIds: [] };
    };
    const askService = createManagedWriteService(ask, { runManagedWrite: managed });
    expect((await askService.scan()).actions[0].detail).toContain("auto or bypass");

    const untrusted = setup({ idleAutonomy: "write", approvalPolicy: "auto", autonomous: true });
    const untrustedService = createManagedWriteService(untrusted, {
      getProjectTrust: () => trust(untrusted, false),
      runManagedWrite: managed,
    });
    expect((await untrustedService.scan()).actions[0].detail).toContain("Project trust");

    const dirty = setup({ idleAutonomy: "write", approvalPolicy: "auto", autonomous: true });
    const dirtyService = createManagedWriteService(dirty, {
      inspectPrimary: () => ({ dirty: true, evidence: "user changes present" }),
      runManagedWrite: managed,
    });
    expect((await dirtyService.scan()).actions[0].detail).toContain("dirty");

    const nativeDisabled = setup({ idleAutonomy: "write", approvalPolicy: "auto", autonomous: true });
    const disabledTrust = trust(nativeDisabled, true);
    disabledTrust.nativeLoginAllowed = false;
    const nativeDisabledService = createManagedWriteService(nativeDisabled, {
      getProjectTrust: () => disabledTrust,
      runManagedWrite: managed,
    });
    expect((await nativeDisabledService.scan()).actions[0].detail).toContain("does not allow native login");

    const bypassDenied = setup({ idleAutonomy: "write", approvalPolicy: "bypass", autonomous: true });
    const bypassDeniedService = createManagedWriteService(bypassDenied, {
      getProjectTrust: () => trust(bypassDenied, true, false),
      runManagedWrite: managed,
    });
    expect((await bypassDeniedService.scan()).actions[0].detail).toContain("does not allow approval bypass");

    const cancelled = setup({ idleAutonomy: "write", approvalPolicy: "auto", autonomous: true });
    const cancelledService = createManagedWriteService(cancelled, {
      runReadOnlyVerification: () => {
        cancelled.goals.cancel(cancelled.goalId, "coordinator", "cancelled during verification");
        return { status: "needs-write", summary: "change", tokensUsed: 1, artifactIds: [] };
      },
      runManagedWrite: managed,
    });
    expect((await cancelledService.scan()).actions[0].detail).toContain("no longer active and autonomous");
    expect(managedCalls).toBe(0);
  });

  test("bounds daemon-managed writes by the durable goal deadline and aborts the submitted run", async () => {
    const fixture = setup({
      idleAutonomy: "write",
      approvalPolicy: "auto",
      autonomous: true,
      deadlineAt: 100_005,
    });
    let receivedTimeout = 0;
    let aborted = false;
    const service = createManagedWriteService(fixture, {
      now: () => 100_000,
      writeTimeoutMs: 60_000,
      runManagedWrite: ({ limits, signal }) => {
        receivedTimeout = limits.timeoutMs;
        return new Promise((_resolve) => {
          signal.addEventListener("abort", () => { aborted = true; }, { once: true });
        });
      },
    });

    expect((await service.scan()).actions[0]).toMatchObject({ outcome: "failed" });
    expect(receivedTimeout).toBe(5);
    expect(aborted).toBe(true);
  });

  test("requires common safety callbacks even when a managed write callback exists", async () => {
    const fixture = setup({ idleAutonomy: "write", approvalPolicy: "auto", autonomous: true });
    const service = createService(fixture, {
      now: () => 100_000,
      collectEvidence: () => oneOpportunityEvidence(1_000),
      publishLane: durablePublisher([]),
      runReadOnlyVerification: () => ({ status: "needs-write", summary: "change", tokensUsed: 1, artifactIds: [] }),
      runManagedWrite: () => ({ status: "applied", summary: "unexpected", tokensUsed: 1, artifactIds: [] }),
    });
    expect((await service.scan()).actions[0].detail).toContain("callbacks are not fully configured");
  });

  test("does not release a timed-out worktree lease until a non-cooperative writer settles", async () => {
    const fixture = setup({ idleAutonomy: "write", approvalPolicy: "auto", autonomous: true });
    let finish!: (value: { status: "applied"; summary: string; tokensUsed: number; artifactIds: string[] }) => void;
    const releases: unknown[] = [];
    const service = writeService(fixture, {
      writeTimeoutMs: 5,
      acquireWorktreeLease: () => ({
        id: "lease-noncooperative",
        token: "scoped-token",
        worktreePath: "/tmp/leased-noncooperative",
        release: (input) => { releases.push(input); },
      }),
      runWrite: () => new Promise((resolve) => { finish = resolve; }),
    });

    expect((await service.scan()).actions[0]).toMatchObject({ outcome: "failed" });
    expect(releases).toEqual([]);
    finish({ status: "applied", summary: "late result", tokensUsed: 1, artifactIds: [] });
    await Bun.sleep(0);
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({ outcome: "failed" });
  });

  test("does not scan an autonomous goal after its durable deadline", async () => {
    const fixture = setup({ idleAutonomy: "suggest", autonomous: true, deadlineAt: 2_000 });
    const service = createService(fixture, {
      now: () => 100_000,
      collectEvidence: () => oneOpportunityEvidence(1_000),
      publishLane: () => { throw new Error("expired goal must not publish"); },
    });
    expect(await service.scan()).toMatchObject({ eligibleGoals: 0, opportunities: 0, actions: [] });
  });
});

type Fixture = ReturnType<typeof setup>;

function setup(options: {
  idleAutonomy: "off" | "suggest" | "read-only" | "write";
  approvalPolicy?: ApprovalPolicy;
  fleetApprovalPolicy?: ApprovalPolicy;
  goalApprovalPolicy?: ApprovalPolicy;
  goalAuthMode?: "native-login" | "broker";
  autonomous: boolean;
  active?: boolean;
  deadlineAt?: number;
}) {
  const project = directory("headless-idle-project-");
  const state = directory("headless-idle-state-");
  const paths = ensureProjectStateDirectories(getProjectStatePaths(project, {
    env: { HEADLESS_STATE_HOME: state, HEADLESS_RUNTIME_HOME: `/tmp/hia-${process.pid}` },
    homeDir: state,
    platform: "linux",
  }));
  const fixedNow = 1_000;
  const fleets = new FleetProfileStore(paths, { now: () => fixedNow, id: () => "fleet-main" });
  const profile = fleets.create({
    id: "fleet-main",
    name: "Idle fleet",
    authMode: "native-login",
    approvalPolicy: options.fleetApprovalPolicy ?? options.approvalPolicy ?? "auto",
    agents: [
      agent("leader", options.fleetApprovalPolicy ?? options.approvalPolicy ?? "auto"),
      agent("idle-agent", options.fleetApprovalPolicy ?? options.approvalPolicy ?? "auto"),
    ],
    maxActiveWorkers: 4,
    maxQueuedDelegations: 64,
    maxDeliberationRounds: 8,
    maxAttemptsPerDelegation: 2,
    goalTimeoutMs: 3_600_000,
    idleAutonomy: options.idleAutonomy,
  });
  fleets.setActive(profile.id);
  const goals = new GoalStore(paths, { now: () => fixedNow, id: () => "goal-main" });
  const record = goals.create({
    id: "goal-main",
    principal: "coordinator",
    fleetProfileId: profile.id,
    objective: "Complete the active autonomous goal.",
    authMode: options.goalAuthMode ?? "native-login",
    approvalPolicy: options.goalApprovalPolicy ?? options.approvalPolicy ?? "auto",
    synthesizer: { kind: "agent", agentId: "leader" },
    synthesizerAgentId: "leader",
    autonomous: options.autonomous,
    deadlineAt: options.deadlineAt ?? 1_000_000,
  });
  if (options.active !== false) goals.transition(record.goal.id, "active", "coordinator", "Begin autonomous execution.");
  return { paths, fleets, goals, profile, goalId: record.goal.id };
}

function createService(
  fixture: Fixture,
  overrides: Partial<IdleAutonomyServiceOptions>,
) {
  return new IdleAutonomyService({
    goals: fixture.goals,
    fleets: fixture.fleets,
    detector: overrides.detector ?? new DeterministicIdleOpportunityDetector(),
    publishLane: overrides.publishLane ?? durablePublisher([]),
    ...overrides,
  });
}

function writeService(fixture: Fixture, overrides: Partial<IdleAutonomyServiceOptions> = {}) {
  return createService(fixture, {
    now: () => 100_000,
    collectEvidence: () => oneOpportunityEvidence(1_000),
    publishLane: durablePublisher([]),
    runReadOnlyVerification: () => ({ status: "needs-write", summary: "A bounded write is recommended.", tokensUsed: 2, artifactIds: [] }),
    getProjectTrust: () => trust(fixture, true),
    authorizeWrite: () => ({ allowed: true, gatesPassed: true, reason: "All normal gates permit an isolated candidate write." }),
    inspectPrimary: () => ({ dirty: false, evidence: "Primary checkout is clean." }),
    acquireWorktreeLease: () => ({
      id: "lease-default",
      token: "lease-token",
      worktreePath: "/tmp/leased-default",
      release: () => undefined,
    }),
    validateWorktreeLease: () => true,
    runWrite: () => ({ status: "applied", summary: "Applied in worktree.", tokensUsed: 2, artifactIds: [] }),
    ...overrides,
  });
}

function createManagedWriteService(fixture: Fixture, overrides: Partial<IdleAutonomyServiceOptions> = {}) {
  return createService(fixture, {
    now: () => 100_000,
    collectEvidence: () => oneOpportunityEvidence(1_000),
    publishLane: durablePublisher([]),
    runReadOnlyVerification: () => ({ status: "needs-write", summary: "A bounded write is recommended.", tokensUsed: 2, artifactIds: [] }),
    getProjectTrust: () => trust(fixture, true),
    inspectPrimary: () => ({ dirty: false, evidence: "Primary checkout is clean." }),
    runManagedWrite: () => ({ status: "applied", summary: "Managed write passed normal gates.", tokensUsed: 2, artifactIds: [] }),
    ...overrides,
  });
}

function oneOpportunityEvidence(observedAt: number): IdleAutonomyEvidence {
  return {
    quiescentSince: observedAt,
    idleWorkerMs: 86_400_000,
    failedGates: [],
    completions: [{ id: "completion-one", completedAt: observedAt, verifiedAt: null }],
    workItems: [],
    candidates: [],
    workers: [],
  };
}

function durablePublisher(output: IdleSuggestionLane[]) {
  const lanes = new Map<string, IdleSuggestionLane>();
  return (lane: IdleSuggestionLane) => {
    lanes.set(lane.id, lane);
    output.splice(0, output.length, ...lanes.values());
    return { laneId: lane.id, durable: true as const };
  };
}

function populateGoalEvidence(goals: GoalStore, goalId: string) {
  goals.putTurn(goalId, {
    id: "turn-verified",
    goalId,
    delegationId: null,
    agentId: "leader",
    nativeSessionId: null,
    authMode: "native-login",
    sequence: 1,
    state: "succeeded",
    input: "Complete verified work.",
    output: "done",
    artifactIds: [],
    startedAt: 800,
    completedAt: 900,
    createdAt: 700,
    updatedAt: 900,
  });
  goals.putTurn(goalId, {
    id: "turn-unverified",
    goalId,
    delegationId: null,
    agentId: "leader",
    nativeSessionId: null,
    authMode: "native-login",
    sequence: 2,
    state: "succeeded",
    input: "Complete unverified work.",
    output: "claimed done",
    artifactIds: [],
    startedAt: 850,
    completedAt: 950,
    createdAt: 750,
    updatedAt: 950,
  });
  goals.putTurn(goalId, {
    id: "turn-running",
    goalId,
    delegationId: null,
    agentId: "leader",
    nativeSessionId: null,
    authMode: "native-login",
    sequence: 3,
    state: "running",
    input: "Remain busy.",
    output: null,
    artifactIds: [],
    startedAt: 900,
    completedAt: null,
    createdAt: 800,
    updatedAt: 1_000,
  });
  goals.putDelegation(goalId, {
    id: "delegation-stalled",
    goalId,
    fromAgentId: "leader",
    toAgentId: "leader",
    nativeSessionId: null,
    sequence: 1,
    task: "Stalled delegated work.",
    state: "active",
    attempt: 1,
    maxAttempts: 2,
    availableAt: 500,
    deadlineAt: 500_000,
    rateLimit: null,
    resultTurnId: null,
    artifactIds: [],
    lastError: null,
    createdAt: 500,
    updatedAt: 1_000,
  });
  goals.addReview(goalId, {
    id: "review-open",
    collaborationId: goalId,
    candidateId: "candidate-open",
    reviewerId: "leader",
    verdict: "request_changes",
    summary: "Candidate still needs a decision.",
    findings: [],
    citedTurnIds: ["turn-verified"],
    citedArtifactIds: [],
    createdAt: 1_000,
  });
  goals.addCandidateDecision(goalId, {
    id: "decision-blocked",
    collaborationId: goalId,
    candidateId: "candidate-blocked",
    decision: "blocked",
    decidedBy: "coordinator",
    reviewIds: [],
    voteIds: [],
    citedTurnIds: [],
    citedArtifactIds: [],
    gates: [{ id: "gate-failed", status: "failed", evidenceArtifactIds: [] }],
    reasons: ["Gate failed."],
    createdAt: 1_000,
  });
}

function agent(id: string, approvalPolicy: ApprovalPolicy) {
  return {
    id,
    backend: id === "leader" ? "codex" : "claude-code",
    name: id,
    authMode: "native-login" as const,
    approvalPolicy,
    enabled: true,
    priority: 0,
    capabilities: ["verification"],
    maxConcurrentTurns: 1,
  };
}

function trust(fixture: Fixture, trusted: boolean, bypassAllowed = false): ProjectTrust {
  return {
    version: 1,
    projectId: fixture.paths.projectId,
    trusted,
    nativeLoginAllowed: trusted,
    bypassAllowed: trusted && bypassAllowed,
    trustedBy: trusted ? "coordinator" : null,
    trustedAt: trusted ? 1_000 : null,
    revokedAt: null,
  };
}

function directory(prefix: string) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}
