import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CandidateDecision, Delegation, Review, Turn, Vote } from "../src/contracts/collaboration";
import { ApprovalStore } from "../src/runtime/approval-store";
import { FleetProfileStore } from "../src/runtime/fleet-profile-store";
import { GoalStore } from "../src/runtime/goal-store";
import { ensureProjectStateDirectories, getProjectStatePaths, type ProjectStatePaths } from "../src/runtime/project-state";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable fleet profile store", () => {
  test("applies fleet defaults, persists CRUD, and owns active profile selection", () => {
    const paths = fixture();
    let now = 100;
    let nextId = 0;
    const store = new FleetProfileStore(paths, { now: () => now, id: () => `fleet-${++nextId}` });
    const first = store.create({
      name: "Primary fleet",
      agents: [{ id: "codex", backend: "codex", name: "Codex" }],
    });
    expect(first).toMatchObject({
      id: "fleet-1",
      projectId: paths.projectId,
      authMode: "native-login",
      approvalPolicy: "ask",
      maxActiveWorkers: 4,
      maxQueuedDelegations: 64,
      maxDeliberationRounds: 8,
      maxAttemptsPerDelegation: 2,
      goalTimeoutMs: 3_600_000,
    });
    expect(first.agents[0]).toMatchObject({ authMode: "native-login", createdAt: 100 });
    expect(first.agents[0]?.model).toBeUndefined();
    expect(store.getActive()?.id).toBe(first.id);

    now = 110;
    const second = store.create({
      name: "Review fleet",
      coordinator: { kind: "agent", agentId: "claude" },
      agents: [{ id: "claude", backend: "claude", name: "Claude", priority: 10 }],
    });
    expect(store.setActive(second.id)?.id).toBe(second.id);
    now = 120;
    expect(store.update(second.id, { name: "Reviewers" })).toMatchObject({ name: "Reviewers", updatedAt: 120 });
    expect(() => store.update(second.id, (profile) => ({ ...profile, id: "replacement" }))).toThrow("identity fields are immutable");
    expect(store.delete(second.id).id).toBe(second.id);
    expect(store.getActive()).toBeNull();
    expect(store.list().map((profile) => profile.id)).toEqual([first.id]);

    const reopened = new FleetProfileStore(paths);
    expect(reopened.get(first.id)?.name).toBe("Primary fleet");
    expect(statSync(paths.fleetProfilesPath).mode & 0o777).toBe(0o600);
  });

  test("fails closed when persisted fleet state belongs to another project", () => {
    const paths = fixture();
    const store = new FleetProfileStore(paths, { now: () => 100 });
    const state = store.snapshot();
    writeFileSync(paths.fleetProfilesPath, `${JSON.stringify({ ...state, projectId: "b".repeat(64) })}\n`, { mode: 0o600 });
    expect(() => new FleetProfileStore(paths)).toThrow("Fleet profile project mismatch");
  });
});

describe("durable goal store", () => {
  test("defaults pre-mode persisted goals to read-only when reopening the store", () => {
    const paths = fixture();
    const store = new GoalStore(paths, { now: () => 100, id: () => "legacy-goal" });
    store.create({
      principal: "owner",
      fleetProfileId: "fleet-one",
      objective: "Continue a goal persisted before write goals existed.",
      coordinator: { kind: "automatic" },
      deadlineAt: 10_000,
    });

    const path = join(paths.goalsDir, "legacy-goal.json");
    const persisted = JSON.parse(readFileSync(path, "utf8")) as { goal: { mode?: string } };
    delete persisted.goal.mode;
    writeFileSync(path, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });

    expect(new GoalStore(paths).get("legacy-goal")?.goal.mode).toBe("read-only");
  });

  test("persists goal state, subordinate evidence, decisions, and terminal result across restart", () => {
    const paths = fixture();
    let now = 100;
    const store = new GoalStore(paths, { now: () => now, id: () => "goal-one" });
    const created = store.create({
      principal: "owner",
      fleetProfileId: "fleet-one",
      objective: "Implement the collaborative fleet.",
      coordinator: { kind: "automatic" },
      autonomous: true,
      deadlineAt: 10_000,
    });
    expect(created.goal).toMatchObject({ id: "goal-one", projectId: paths.projectId, mode: "read-only", state: "queued", authMode: "native-login" });
    now = 110;
    expect(store.transition("goal-one", "planning", "owner", "Plan work.").state).toBe("planning");
    now = 120;
    expect(store.transition("goal-one", "active", "owner").state).toBe("active");

    store.putDelegation("goal-one", delegation());
    store.putTurn("goal-one", turn());
    const review = reviewEvidence();
    const vote = voteEvidence();
    const decision = candidateDecision();
    store.addReview("goal-one", review);
    store.addVote("goal-one", vote);
    store.addCandidateDecision("goal-one", decision);
    expect(() => store.putTurn("goal-one", { ...turn(), agentId: "impostor" })).toThrow("identity fields are immutable");

    now = 200;
    expect(store.setResult("goal-one", "owner", {
      status: "succeeded",
      summary: "Candidate passed review and vote.",
      artifactIds: ["candidate-artifact"],
      candidateDecisionId: decision.id,
    })).toMatchObject({ status: "succeeded", completedBy: "owner", completedAt: 200 });
    expect(store.status("goal-one").state).toBe("succeeded");
    expect(store.result("goal-one")?.candidateDecisionId).toBe(decision.id);

    const reopened = new GoalStore(paths);
    const record = reopened.get("goal-one")!;
    expect(record.turns.map((entry) => entry.id)).toEqual(["turn-one"]);
    expect(record.delegations.map((entry) => entry.id)).toEqual(["delegation-one"]);
    expect(record.reviews.map((entry) => entry.id)).toEqual([review.id]);
    expect(record.votes.map((entry) => entry.id)).toEqual([vote.id]);
    expect(record.candidateDecisions.map((entry) => entry.id)).toEqual([decision.id]);
    expect(reopened.list({ state: "succeeded" }).map((goal) => goal.id)).toEqual(["goal-one"]);
    expect(statSync(paths.goalsDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(paths.goalsDir, "goal-one.json")).mode & 0o777).toBe(0o600);
  });

  test("records attributable cancellation and refuses terminal reopening", () => {
    const paths = fixture();
    let now = 100;
    let id = 0;
    const store = new GoalStore(paths, { now: () => now, id: () => `goal-${++id}` });
    const goal = store.create({
      principal: "owner",
      fleetProfileId: "fleet-one",
      objective: "Cancelable work.",
      coordinator: { kind: "human" },
      deadlineAt: 1_000,
    }).goal;
    store.transition(goal.id, "active", "owner");
    now = 150;
    expect(store.cancel(goal.id, "operator", "Stopped by operator.")).toMatchObject({ state: "cancelled", updatedAt: 150 });
    expect(store.result(goal.id)).toMatchObject({ status: "cancelled", completedBy: "operator", summary: "Stopped by operator." });
    expect(store.cancel(goal.id, "operator").state).toBe("cancelled");
    expect(() => store.transition(goal.id, "active", "owner")).toThrow("Invalid goal transition");
  });

  test("enforces project and collaboration relationships on disk and append", () => {
    const paths = fixture();
    const store = new GoalStore(paths, { now: () => 100, id: () => "goal-one" });
    store.create({
      principal: "owner",
      fleetProfileId: "fleet-one",
      objective: "Bound work.",
      coordinator: { kind: "automatic" },
      deadlineAt: 1_000,
    });
    expect(() => store.addReview("goal-one", { ...reviewEvidence(), collaborationId: "other-goal" })).toThrow("different goal");

    const path = join(paths.goalsDir, "goal-one.json");
    const record = JSON.parse(readFileSync(path, "utf8"));
    record.goal.projectId = "b".repeat(64);
    writeFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    expect(() => new GoalStore(paths).get("goal-one")).toThrow("Goal project mismatch");
  });
});

describe("durable approval store", () => {
  test("attributes approval decisions, filters lists, and survives restart", () => {
    const paths = fixture();
    let now = 100;
    const store = new ApprovalStore(paths, { now: () => now, id: () => "approval-one" });
    const request = store.create({
      collaborationId: "goal-one",
      requestedBy: "worker",
      assignedTo: "owner",
      kind: "merge",
      summary: "Approve candidate integration.",
      details: { candidateId: "candidate-one" },
      artifactIds: ["candidate-artifact"],
      expiresAt: 500,
    });
    expect(request).toMatchObject({ status: "pending", requestedBy: "worker", resolvedBy: null });
    expect(() => store.resolve(request.id, "intruder", "approved")).toThrow("Only assigned principal");
    now = 120;
    expect(store.resolve(request.id, "owner", { status: "approved", resolution: "Gates verified." })).toMatchObject({
      status: "approved",
      resolvedBy: "owner",
      resolution: "Gates verified.",
      resolvedAt: 120,
    });
    expect(store.list({ status: "approved", assignedTo: "owner" })).toHaveLength(1);
    expect(new ApprovalStore(paths).get(request.id)?.status).toBe("approved");
    expect(statSync(paths.approvalsPath).mode & 0o777).toBe(0o600);
  });

  test("expires unresolved requests durably with daemon attribution", () => {
    const paths = fixture();
    let now = 100;
    const store = new ApprovalStore(paths, {
      now: () => now,
      id: () => "approval-expiring",
      expiryActor: "daemon-owner",
    });
    store.create({
      collaborationId: "goal-one",
      requestedBy: "worker",
      assignedTo: "owner",
      kind: "coder_tool",
      summary: "Allow tool invocation.",
      expiresAt: 150,
    });
    now = 150;
    expect(store.list({ status: "expired" })).toEqual([
      expect.objectContaining({ status: "expired", resolvedBy: "daemon-owner", resolvedAt: 150 }),
    ]);
    expect(() => store.resolve("approval-expiring", "owner", "approved")).toThrow("already expired");
    expect(new ApprovalStore(paths).get("approval-expiring")?.status).toBe("expired");
  });

  test("lets an already-authorized administrator resolve an integration-assigned request", () => {
    const paths = fixture();
    const store = new ApprovalStore(paths, { now: () => 100, id: () => "approval-integration" });
    store.create({
      collaborationId: "job-integration",
      requestedBy: "integration:mcp",
      assignedTo: "integration:mcp",
      kind: "merge",
      summary: "Approve an unattended integration candidate.",
      expiresAt: 500,
    });

    expect(() => store.resolve("approval-integration", "owner", "approved")).toThrow("Only assigned principal");
    expect(store.resolveAsAdministrator("approval-integration", "owner", "approved", "Owner verified the gates."))
      .toMatchObject({
        status: "approved",
        assignedTo: "integration:mcp",
        resolvedBy: "owner",
        resolution: "Owner verified the gates.",
      });
  });

  test("lets only the requester cancel a pending approval", () => {
    const paths = fixture();
    const store = new ApprovalStore(paths, { now: () => 100, id: () => "approval-cancel" });
    store.create({
      collaborationId: "goal-one",
      requestedBy: "worker",
      assignedTo: "owner",
      kind: "merge",
      summary: "Cancel this request.",
      expiresAt: 500,
    });
    expect(() => store.cancel("approval-cancel", "owner")).toThrow("Only requester");
    expect(store.cancel("approval-cancel", "worker")).toMatchObject({ status: "cancelled", resolvedBy: "worker" });
  });
});

function fixture(): ProjectStatePaths {
  const root = mkdtempSync(join(tmpdir(), "headless-collaboration-store-"));
  const runtime = join("/tmp", `hcs-${process.pid}-${randomUUID().slice(0, 8)}`);
  roots.push(root);
  roots.push(runtime);
  const project = join(root, "project");
  mkdirSync(project);
  return ensureProjectStateDirectories(getProjectStatePaths(project, {
    env: {
      ...process.env,
      HEADLESS_STATE_HOME: join(root, "state"),
      HEADLESS_RUNTIME_HOME: runtime,
    },
  }));
}

function delegation(): Delegation {
  return {
    id: "delegation-one",
    goalId: "goal-one",
    fromAgentId: "leader",
    toAgentId: "worker",
    nativeSessionId: "native-one",
    sequence: 1,
    task: "Implement the candidate.",
    state: "queued",
    attempt: 0,
    maxAttempts: 2,
    availableAt: 100,
    deadlineAt: 1_000,
    rateLimit: null,
    resultTurnId: null,
    artifactIds: [],
    lastError: null,
    createdAt: 100,
    updatedAt: 100,
  };
}

function turn(): Turn {
  return {
    id: "turn-one",
    goalId: "goal-one",
    delegationId: "delegation-one",
    agentId: "worker",
    nativeSessionId: "native-one",
    authMode: "native-login",
    sequence: 1,
    state: "queued",
    input: "Implement the candidate.",
    output: null,
    artifactIds: [],
    startedAt: null,
    completedAt: null,
    createdAt: 100,
    updatedAt: 100,
  };
}

function reviewEvidence(): Review {
  return {
    id: "review-one",
    collaborationId: "goal-one",
    candidateId: "candidate-one",
    reviewerId: "reviewer",
    verdict: "approve",
    summary: "Candidate matches the requested behavior.",
    findings: [],
    citedTurnIds: ["turn-one"],
    citedArtifactIds: [],
    createdAt: 140,
  };
}

function voteEvidence(): Vote {
  return {
    id: "vote-one",
    collaborationId: "goal-one",
    candidateId: "candidate-one",
    voterId: "voter",
    choice: "approve",
    rationale: "The cited turn and review support approval.",
    citedTurnIds: ["turn-one"],
    citedArtifactIds: [],
    createdAt: 150,
  };
}

function candidateDecision(): CandidateDecision {
  return {
    id: "decision-one",
    collaborationId: "goal-one",
    candidateId: "candidate-one",
    decision: "integrate",
    decidedBy: "owner",
    reviewIds: ["review-one"],
    voteIds: ["vote-one"],
    citedTurnIds: ["turn-one"],
    citedArtifactIds: ["candidate-artifact"],
    gates: [{ id: "tests", status: "passed", evidenceArtifactIds: ["test-report"] }],
    reasons: ["Review, vote, and tests passed."],
    createdAt: 160,
  };
}
