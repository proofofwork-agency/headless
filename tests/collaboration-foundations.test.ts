import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentProfileSchema,
  CandidateDecisionSchema,
  DirectedMessageSchema,
  FleetProfileSchema,
  GoalSchema,
  ReviewSchema,
  VoteSchema,
} from "../src/contracts/collaboration";
import {
  DelegationScheduler,
  DelegationSchedulerError,
  MAX_PERSISTED_DELEGATIONS,
  type DelegationSchedulerSnapshot,
} from "../src/runtime/delegation-scheduler";
import {
  DirectedMailbox,
  DirectedMailboxError,
  isNonDroppableMessageKind,
} from "../src/runtime/directed-mailbox";
import {
  DeterministicIdleOpportunityDetector,
  detectIdleOpportunities,
  type IdleOpportunityScanInput,
} from "../src/runtime/idle-opportunity-detector";
import { selectStickyLeader } from "../src/runtime/leader-selector";

const roots: string[] = [];
const projectId = "a".repeat(64);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("collaboration contracts", () => {
  test("defaults broker auth and fleet bounds while rejecting unknown or inconsistent data", () => {
    const agent = AgentProfileSchema.parse({
      id: "agent-one",
      backend: "codex",
      name: "Codex",
      createdAt: 10,
      updatedAt: 10,
    });
    expect(agent).toMatchObject({
      authMode: "broker",
      approvalPolicy: "ask",
      enabled: true,
      maxConcurrentTurns: 1,
    });
    expect(agent.model).toBeUndefined();
    expect(AgentProfileSchema.safeParse({ ...agent, credentialPath: "/host/secret" }).success).toBe(false);

    const fleet = FleetProfileSchema.parse({
      id: "fleet-one",
      projectId,
      name: "Default",
      agents: [agent],
      createdAt: 10,
      updatedAt: 10,
    });
    expect(fleet).toMatchObject({
      authMode: "broker",
      maxActiveWorkers: 4,
      maxQueuedDelegations: 64,
      maxDeliberationRounds: 8,
      maxAttemptsPerDelegation: 2,
      goalTimeoutMs: 3_600_000,
    });
    expect(FleetProfileSchema.safeParse({
      ...fleet,
      agents: [agent, agent],
    }).success).toBe(false);
    expect(FleetProfileSchema.safeParse({
      ...fleet,
      synthesizer: { kind: "agent", agentId: "missing" },
    }).success).toBe(false);
  });

  test("requires attributable evidence for reviews, votes, and integration decisions", () => {
    const baseReview = {
      id: "review-one",
      collaborationId: "goal-one",
      candidateId: "candidate-one",
      reviewerId: "reviewer-one",
      verdict: "approve",
      summary: "Reviewed the candidate output.",
      createdAt: 20,
    } as const;
    expect(ReviewSchema.safeParse(baseReview).success).toBe(false);
    expect(ReviewSchema.parse({ ...baseReview, citedArtifactIds: ["artifact-one"] }).citedArtifactIds).toEqual(["artifact-one"]);

    const baseVote = {
      id: "vote-one",
      collaborationId: "goal-one",
      candidateId: "candidate-one",
      voterId: "voter-one",
      choice: "approve",
      rationale: "The cited test result supports integration.",
      createdAt: 21,
    } as const;
    expect(VoteSchema.safeParse(baseVote).success).toBe(false);
    expect(VoteSchema.safeParse({ ...baseVote, citedTurnIds: ["turn-one"] }).success).toBe(true);

    const decision = {
      id: "decision-one",
      collaborationId: "goal-one",
      candidateId: "candidate-one",
      decision: "integrate",
      decidedBy: "coordinator",
      reasons: ["All gates passed."],
      gates: [{ id: "tests", status: "failed" }],
      createdAt: 22,
    } as const;
    expect(CandidateDecisionSchema.safeParse(decision).success).toBe(false);
    expect(CandidateDecisionSchema.safeParse({
      ...decision,
      gates: [{ id: "tests", status: "passed", evidenceArtifactIds: ["test-report"] }],
    }).success).toBe(true);
  });

  test("bounds goal and addressed message state with strict acknowledgement semantics", () => {
    const goal = GoalSchema.parse({
      id: "goal-one",
      projectId,
      principal: "owner",
      fleetProfileId: "fleet-one",
      objective: "Implement collaboration.",
      state: "active",
      synthesizer: { kind: "automatic" },
      deadlineAt: 20,
      createdAt: 10,
      updatedAt: 10,
    });
    expect(goal.mode).toBe("read-only");
    expect(GoalSchema.safeParse({ ...goal, mode: "write" }).success).toBe(true);
    expect(GoalSchema.safeParse({ ...goal, mode: "unsafe" }).success).toBe(false);
    expect(DirectedMessageSchema.safeParse({
      id: "message-one",
      collaborationId: "goal-one",
      senderId: "agent-one",
      recipientId: "agent-two",
      sequence: 1,
      kind: "completion",
      content: "done",
      redacted: true,
      acknowledgedAt: 9,
      createdAt: 10,
    }).success).toBe(false);
  });
});

describe("bounded durable delegation scheduler", () => {
  test("preserves eligible FIFO order, active bounds, queue positions, and one turn per native session", () => {
    const scheduler = new DelegationScheduler({ maxActive: 2, maxQueued: 3, clock: () => 100 });
    scheduler.enqueue(delegation("first", "session-a", 1_000));
    scheduler.enqueue(delegation("same-session", "session-a", 1_000));
    scheduler.enqueue(delegation("other-session", "session-b", 1_000));

    expect(scheduler.claimReady(100).map((entry) => entry.id)).toEqual(["first", "other-session"]);
    expect(scheduler.activeCount()).toBe(2);
    expect(scheduler.queuePosition("same-session")).toBe(1);
    expect(scheduler.claimNext(100)).toBeNull();

    scheduler.cancel("first", 110);
    expect(scheduler.claimNext(110)?.id).toBe("same-session");
    expect(scheduler.get("same-session")?.attempt).toBe(1);
  });

  test("rejects queue overflow without dropping work and supports queued cancellation", () => {
    const scheduler = new DelegationScheduler({ maxActive: 1, maxQueued: 2, clock: () => 100 });
    scheduler.enqueue(delegation("first", null, 1_000));
    scheduler.enqueue(delegation("second", null, 1_000));
    expect(() => scheduler.enqueue(delegation("overflow", null, 1_000))).toThrow(DelegationSchedulerError);
    try {
      scheduler.enqueue(delegation("overflow", null, 1_000));
    } catch (error) {
      expect(error).toBeInstanceOf(DelegationSchedulerError);
      expect((error as DelegationSchedulerError).code).toBe("QUEUE_CAPACITY_EXCEEDED");
      expect((error as DelegationSchedulerError).retryable).toBe(true);
    }
    expect(scheduler.list("queued").map((entry) => entry.id)).toEqual(["first", "second"]);
    expect(scheduler.cancel("first", 101).state).toBe("cancelled");
    expect(scheduler.queuePosition("second")).toBe(1);
  });

  test("requeues rate limits only inside the retry budget and goal deadline", () => {
    const scheduler = new DelegationScheduler({ maxActive: 1, maxQueued: 4, clock: () => 100 });
    scheduler.enqueue({ ...delegation("retry", "session-a", 1_000), maxAttempts: 2 });
    expect(scheduler.claimNext(100)?.attempt).toBe(1);
    const requeued = scheduler.requeueRateLimited("retry", 100, "HTTP 429 retry-after=100", 110);
    expect(requeued).toMatchObject({ requeued: true, reason: "requeued", queuePosition: 1 });
    expect(scheduler.claimNext(209)).toBeNull();
    expect(scheduler.claimNext(210)?.attempt).toBe(2);
    expect(scheduler.requeueRateLimited("retry", 100, "second limit", 220)).toMatchObject({
      requeued: false,
      reason: "retry_exhausted",
      delegation: { state: "failed" },
    });

    scheduler.enqueue({ ...delegation("deadline", null, 300), maxAttempts: 2 }, 230);
    scheduler.claimNext(230);
    expect(scheduler.requeueRateLimited("deadline", 70, "too late", 240)).toMatchObject({
      requeued: false,
      reason: "deadline_exceeded",
      delegation: { state: "expired" },
    });
  });

  test("persists queue order and active native-session locks across restart", () => {
    const root = temporaryRoot();
    const path = join(root, "scheduler.json");
    const scheduler = new DelegationScheduler({ statePath: path, maxActive: 2, maxQueued: 4, clock: () => 100 });
    scheduler.enqueue(delegation("active", "shared", 1_000));
    scheduler.enqueue(delegation("blocked", "shared", 1_000));
    scheduler.enqueue(delegation("eligible", "other", 1_000));
    expect(scheduler.claimNext(100)?.id).toBe("active");

    const reopened = new DelegationScheduler({ statePath: path, clock: () => 100 });
    expect(reopened.claimNext(100)?.id).toBe("eligible");
    expect(reopened.queuePosition("blocked")).toBe(1);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("compacts oldest terminal scheduler history across more than 1,088 lifecycle items and restart", () => {
    const total = MAX_PERSISTED_DELEGATIONS + 112;
    const initial: DelegationSchedulerSnapshot = {
      version: 1,
      maxActive: 1,
      maxQueued: 1,
      nextSequence: MAX_PERSISTED_DELEGATIONS + 1,
      delegations: Array.from(
        { length: MAX_PERSISTED_DELEGATIONS },
        (_, index) => completedDelegation(index + 1, total * 4),
      ),
    };
    const scheduler = new DelegationScheduler({ snapshot: initial });

    for (let index = MAX_PERSISTED_DELEGATIONS + 1; index <= total; index += 1) {
      const at = index * 3;
      scheduler.enqueue(delegation(`lifetime-${index}`, null, total * 4), at);
      expect(scheduler.claimNext(at)?.id).toBe(`lifetime-${index}`);
      scheduler.complete(`lifetime-${index}`, `turn-${index}`, [], at + 1);
    }

    expect(scheduler.snapshot().delegations).toHaveLength(MAX_PERSISTED_DELEGATIONS);
    expect(scheduler.get("lifetime-112")).toBeNull();
    expect(scheduler.get("lifetime-113")?.state).toBe("succeeded");
    expect(scheduler.get(`lifetime-${total}`)?.state).toBe("succeeded");

    const durableSnapshot = JSON.parse(JSON.stringify(scheduler.snapshot())) as DelegationSchedulerSnapshot;
    const reopened = new DelegationScheduler({ snapshot: durableSnapshot });
    reopened.enqueue(delegation("after-restart", null, total * 4), total * 3 + 2);
    expect(reopened.claimNext(total * 3 + 2)?.id).toBe("after-restart");
    reopened.complete("after-restart", "turn-after-restart", [], total * 3 + 3);
    expect(reopened.snapshot().delegations).toHaveLength(MAX_PERSISTED_DELEGATIONS);
    expect(reopened.get("lifetime-113")).toBeNull();
    expect(reopened.get("after-restart")?.state).toBe("succeeded");
  });
});

describe("addressed acknowledged mailbox", () => {
  test("isolates recipients, redacts before persistence, and retains sequence after acknowledgement pruning", () => {
    const root = temporaryRoot();
    const path = join(root, "mailbox.json");
    let id = 0;
    const mailbox = new DirectedMailbox({
      statePath: path,
      maxMessagesPerAddress: 3,
      clock: () => 100,
      idFactory: () => `message-${++id}`,
    });
    const sent = mailbox.send({
      collaborationId: "goal-one",
      senderId: "leader",
      recipientId: "worker",
      kind: "policy",
      content: "secret sk-1234567890abcdefghijkl",
    });
    mailbox.send({
      collaborationId: "goal-one",
      senderId: "leader",
      recipientId: "other",
      kind: "chat",
      content: "separate",
    });
    expect(sent.content).toContain("REDACTED");
    expect(sent.content).not.toContain("sk-1234567890abcdefghijkl");
    expect(mailbox.listInbox("goal-one", "worker").map((message) => message.id)).toEqual(["message-1"]);
    expect(mailbox.listInbox("goal-one", "other").map((message) => message.id)).toEqual(["message-2"]);
    mailbox.acknowledge("goal-one", "worker", [sent.id], 110);
    expect(mailbox.listInbox("goal-one", "worker")).toEqual([]);
    expect(mailbox.pruneAcknowledged("goal-one", "worker")).toBe(1);

    const next = mailbox.send({
      collaborationId: "goal-one",
      senderId: "leader",
      recipientId: "worker",
      kind: "completion",
      content: "complete",
    }, 120);
    expect(next.sequence).toBe(2);
    const persisted = readFileSync(path, "utf8");
    expect(persisted).not.toContain("sk-1234567890abcdefghijkl");
    expect(new DirectedMailbox({ statePath: path }).listInbox("goal-one", "worker")[0]?.sequence).toBe(2);
  });

  test("rejects overflow atomically and never discards protected event kinds", () => {
    let id = 0;
    const mailbox = new DirectedMailbox({ maxMessagesPerAddress: 2, idFactory: () => `message-${++id}` });
    mailbox.send(message("lifecycle", "queued"), 10);
    mailbox.send(message("policy", "allowed"), 11);
    try {
      mailbox.send(message("approval", "merge approval"), 12);
      throw new Error("Expected mailbox overflow.");
    } catch (error) {
      expect(error).toBeInstanceOf(DirectedMailboxError);
      expect((error as DirectedMailboxError).code).toBe("MAILBOX_CAPACITY_EXCEEDED");
      expect((error as DirectedMailboxError).details.protectedKind).toBe(true);
    }
    expect(mailbox.listInbox("goal-one", "worker").map((entry) => entry.kind)).toEqual(["lifecycle", "policy"]);
    expect(["lifecycle", "policy", "approval", "completion"].every((kind) =>
      isNonDroppableMessageKind(kind as "lifecycle"))).toBe(true);
  });

  test("only the addressed recipient can acknowledge a message", () => {
    const mailbox = new DirectedMailbox({ idFactory: () => "message-one" });
    const sent = mailbox.send(message("chat", "hello"), 10);
    expect(() => mailbox.acknowledge("goal-one", "other", [sent.id], 11)).toThrow(DirectedMailboxError);
    expect(mailbox.pendingCount("goal-one", "worker")).toBe(1);
  });

  test("atomically acknowledges and prunes a bounded cross-recipient batch across restart", () => {
    const root = temporaryRoot();
    const path = join(root, "mailbox-batch.json");
    let id = 0;
    const mailbox = new DirectedMailbox({ statePath: path, idFactory: () => `batch-${++id}` });
    const worker = mailbox.send(message("lifecycle", "worker lifecycle"), 10);
    const coordinator = mailbox.send({
      ...message("approval", "coordinator approval"),
      recipientId: "coordinator",
    }, 11);

    const result = mailbox.acknowledgeBatch("goal-one", [worker.id, coordinator.id], { prune: true, at: 12 });
    expect(result).toMatchObject({ pruned: 2 });
    expect(result.messages.map((entry) => entry.acknowledgedAt)).toEqual([12, 12]);
    expect(mailbox.snapshot().messages).toEqual([]);
    expect(new DirectedMailbox({ statePath: path }).snapshot().messages).toEqual([]);
  });
});

describe("deterministic idle opportunity detection", () => {
  test("waits for eight seconds, finds every planned opportunity, and deduplicates fingerprints", () => {
    const input = idleInput();
    expect(detectIdleOpportunities({ ...input, now: 17_999 })).toEqual([]);
    const opportunities = detectIdleOpportunities(input);
    expect(opportunities.map((opportunity) => opportunity.kind)).toEqual([
      "failed_gate_without_follow_up",
      "unverified_completion",
      "stalled_work",
      "unresolved_candidate",
      "idle_worker",
    ]);
    expect(detectIdleOpportunities({
      ...input,
      persistedFingerprints: opportunities.map((opportunity) => opportunity.fingerprint),
    })).toEqual([]);
    expect(detectIdleOpportunities({ ...input, goal: { ...input.goal, autonomous: false } })).toEqual([]);
  });

  test("persists fingerprints so daemon restarts do not create duplicate lanes", () => {
    const root = temporaryRoot();
    const path = join(root, "idle.json");
    const first = new DeterministicIdleOpportunityDetector({ statePath: path });
    expect(first.scan(idleInput())).toHaveLength(5);
    const reopened = new DeterministicIdleOpportunityDetector({ statePath: path });
    expect(reopened.scan({ ...idleInput(), now: 20_000 })).toEqual([]);
  });
});

describe("sticky leader selection", () => {
  test("keeps an eligible leader sticky even when a higher-priority agent is available", () => {
    const decision = selectStickyLeader({
      now: 100,
      currentLeaderId: "current",
      requiredCapabilities: ["write"],
      candidates: [
        leader("current", { priority: 0 }),
        leader("challenger", { priority: 100 }),
      ],
    });
    expect(decision).toMatchObject({ leaderId: "current", keptCurrent: true, reason: "sticky" });
  });

  test("fails over deterministically when health, authentication, rate limit, or capacity makes the leader unavailable", () => {
    const decision = selectStickyLeader({
      now: 100,
      currentLeaderId: "current",
      requiredCapabilities: ["write"],
      candidates: [
        leader("current", { health: "unhealthy", priority: 100 }),
        leader("rate-limited", { rateLimitedUntil: 200, priority: 100 }),
        leader("unauthenticated", { authenticated: false, priority: 100 }),
        leader("z-eligible"),
        leader("a-eligible"),
      ],
    });
    expect(decision).toMatchObject({ leaderId: "a-eligible", keptCurrent: false, reason: "failover" });
    expect(decision.scores.find((score) => score.agentId === "current")?.eligible).toBe(false);
  });
});

function delegation(id: string, nativeSessionId: string | null, deadlineAt: number) {
  return {
    id,
    goalId: "goal-one",
    fromAgentId: "leader",
    toAgentId: `worker-${id}`,
    nativeSessionId,
    task: `Handle ${id}`,
    deadlineAt,
  };
}

function completedDelegation(index: number, deadlineAt: number) {
  return {
    ...delegation(`lifetime-${index}`, null, deadlineAt),
    sequence: index,
    state: "succeeded" as const,
    attempt: 1,
    maxAttempts: 2,
    availableAt: index,
    rateLimit: null,
    resultTurnId: `turn-${index}`,
    artifactIds: [],
    lastError: null,
    createdAt: index,
    updatedAt: index + 1,
  };
}

function message(kind: "chat" | "lifecycle" | "policy" | "approval", content: string) {
  return {
    collaborationId: "goal-one",
    senderId: "leader",
    recipientId: "worker",
    kind,
    content,
  };
}

function idleInput(): IdleOpportunityScanInput {
  return {
    now: 18_000,
    quiescentSince: 10_000,
    goal: { id: "goal-one", state: "active", autonomous: true },
    failedGates: [{ id: "gate-one", failedAt: 9_000, followedUpAt: null }],
    completions: [{ id: "completion-one", completedAt: 9_100, verifiedAt: null }],
    workItems: [{ id: "work-one", state: "active", lastProgressAt: 1_000 }],
    candidates: [{ id: "candidate-one", state: "ready", updatedAt: 9_200, decisionAt: null }],
    workers: [{ id: "worker-one", state: "idle", lastActiveAt: 9_000 }],
    stalledWorkMs: 10_000,
    idleWorkerMs: 8_000,
    persistedFingerprints: [],
  };
}

function leader(agentId: string, overrides: Partial<{
  enabled: boolean;
  authenticated: boolean;
  health: "healthy" | "degraded" | "unhealthy" | "offline";
  capabilities: string[];
  rateLimitedUntil: number | null;
  priority: number;
  activeTurns: number;
  maxConcurrentTurns: number;
  recentFailures: number;
}> = {}) {
  return {
    agentId,
    enabled: true,
    authenticated: true,
    health: "healthy" as const,
    capabilities: ["write"],
    rateLimitedUntil: null,
    priority: 0,
    activeTurns: 0,
    maxConcurrentTurns: 1,
    recentFailures: 0,
    ...overrides,
  };
}

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "headless-collaboration-"));
  roots.push(root);
  return root;
}
