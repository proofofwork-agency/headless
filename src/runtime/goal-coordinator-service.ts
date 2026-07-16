import { randomUUID } from "node:crypto";
import { normalizeBackend } from "../backends/ids";
import { backendMetadata } from "../backends/metadata";
import type { AgentProfile, ApprovalRequest, FleetProfile, Goal, Review, SynthesizerSelection, Turn, Vote } from "../contracts/collaboration";
import type { RunResult } from "../contracts/run";
import type { ApprovalPolicy, AuthMode } from "../contracts/native";
import type { DelegationScheduler } from "./delegation-scheduler";
import { GoalDelegationRuntime, type GoalDelegationEvent } from "./goal-delegation-runtime";
import { HeadlessError } from "./headless-error";
import { selectStickyLeader, type StickyLeaderDecision } from "./leader-selector";
import { runCouncilLeaderElection, type CouncilLeaderElectionDecision } from "./leader-election";
import type { DirectedMailbox } from "./directed-mailbox";
import type { FleetProfileStore } from "./fleet-profile-store";
import type { GoalRecord, GoalStore } from "./goal-store";
import { GOAL_PLAN_HEADER, parseGoalPlan, type GoalPlanDelegation, type ParsedGoalPlan } from "./goal-plan";
import { redactAndTruncate } from "./redaction";

const MAX_DURABLE_REVIEWS_PER_GOAL = 2_048;
const MAX_DURABLE_TURNS_PER_GOAL = 4_096;
const MAX_CANDIDATE_TURN_TIMEOUT_MS = 900_000;
const DEFAULT_EXTENSION_TURN_TIMEOUT_MS = 180_000;

export type GoalAgentAvailability = {
  authenticated: boolean;
  /** Safe, mode-specific explanation when authentication is unavailable. */
  authDetail?: string | null;
  /** Native-login was not probed because project trust is the only blocking gate. */
  trustRequired?: boolean;
  health: "healthy" | "degraded" | "unhealthy" | "offline";
  rateLimitedUntil: number | null;
  activeTurns: number;
  recentFailures: number;
};

export type GoalSecurityControls = {
  authMode: AuthMode;
  approvalPolicy: ApprovalPolicy;
  mode?: Goal["mode"];
};

export type GoalTurnExecution = {
  jobId: string;
  sessionId: string;
  /** Additional durable artifacts emitted by the daemon-owned job, when known at admission time. */
  artifactIds?: string[];
  completion: Promise<RunResult>;
};

export type GoalCandidateIntegrationResult = {
  merged: boolean;
  resultingCommit: string | null;
  summary: string;
  artifactIds?: string[];
};

type CompletedGoalTurn = {
  turn: Turn;
  result: RunResult;
  /** The daemon job is the candidate integration service's durable identifier. */
  candidateId: string;
  artifactIds: string[];
  evidence: string;
};

type GroundedReview = {
  verdict: Review["verdict"];
  summary: string;
};

type AssignedDelegation = {
  plan: GoalPlanDelegation;
  agent: AgentProfile;
};

type ReviewRound = {
  turns: CompletedGoalTurn[];
  reviews: Review[];
  votes: Vote[];
  outcome: "approve" | "revise" | "reject" | "blocked";
  reason: string | null;
};

export type GoalTurnRole = "planning" | "worker" | "candidate" | "review" | "revision";

export type GoalLeaderDecision = StickyLeaderDecision & { election?: CouncilLeaderElectionDecision };

export type GoalCoordinatorServiceOptions = {
  fleets: FleetProfileStore;
  goals: GoalStore;
  mailbox: DirectedMailbox;
  executeTurn: (input: {
    goal: Goal;
    agent: AgentProfile;
    role: GoalTurnRole;
    prompt: string;
    timeoutMs: number;
  }) => GoalTurnExecution;
  integrateCandidate?: (input: {
    goal: Goal;
    candidateId: string;
    decisionId: string;
    signal: AbortSignal;
  }) => Promise<GoalCandidateIntegrationResult>;
  cancelJob: (jobId: string) => void;
  availability: (agent: AgentProfile, security: GoalSecurityControls) => GoalAgentAvailability;
  /** Foreground providers are not selected for implicit worker/synthesis routing. */
  activeLeadBackend?: () => string | null;
  delegationScheduler?: DelegationScheduler;
  delegationEvent?: (event: GoalDelegationEvent) => void;
  diagnostic?: (message: string, error?: unknown) => void;
  now?: () => number;
  id?: () => string;
};

/** Durable adaptive goal lifecycle layered over daemon-owned run/session execution. */
export class GoalCoordinatorService {
  readonly delegations: GoalDelegationRuntime;
  private readonly active = new Map<string, Promise<void>>();
  private readonly activeJobs = new Map<string, Set<string>>();
  private readonly integrationControllers = new Map<string, AbortController>();
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly diagnostic: (message: string, error?: unknown) => void;

  constructor(private readonly options: GoalCoordinatorServiceOptions) {
    this.now = options.now ?? Date.now;
    this.id = options.id ?? randomUUID;
    this.diagnostic = options.diagnostic ?? ((message, error) => console.error(message, error));
    this.delegations = new GoalDelegationRuntime({
      goals: options.goals,
      scheduler: options.delegationScheduler,
      now: this.now,
      id: this.id,
      diagnostic: this.diagnostic,
      onEvent: (event) => {
        options.mailbox.send({
          collaborationId: event.delegation.goalId,
          senderId: event.delegation.fromAgentId,
          recipientId: event.delegation.toAgentId,
          kind: "lifecycle",
          content: delegationEventText(event),
        });
        options.delegationEvent?.(event);
      },
    });
  }

  start(input: {
    id?: string;
    principal: string;
    objective: string;
    fleetProfileId?: string;
    synthesizer?: SynthesizerSelection;
    authMode?: AuthMode;
    approvalPolicy?: ApprovalPolicy;
    mode?: Goal["mode"];
    autonomous?: boolean;
    timeoutMs?: number;
  }) {
    const profile = input.fleetProfileId
      ? this.options.fleets.get(input.fleetProfileId)
      : this.options.fleets.getActive();
    if (!profile) throw new HeadlessError("INVALID_REQUEST", "No matching fleet profile is configured for this project.");
    const synthesizer = input.synthesizer ?? { kind: "automatic" };
    const security = {
      authMode: input.authMode ?? profile.authMode,
      approvalPolicy: input.approvalPolicy ?? profile.approvalPolicy,
    };
    const mode = input.mode ?? "read-only";
    const decision = this.selectLeader(profile, synthesizer, null, { ...security, mode });
    if (!decision.leaderId) {
      if (decision.election) {
        throw new HeadlessError("GATE_FAILED", `Leader election failed: ${decision.election.evidence.join(" ")}`, {
          retryable: decision.election.status === "quorum_not_met" || decision.election.status === "insufficient_council",
          details: { electionId: decision.election.electionId, status: decision.election.status },
        });
      }
      throw new HeadlessError("NATIVE_AUTH_UNAVAILABLE", "No authenticated, healthy fleet agent is available to coordinate this goal.", { retryable: true });
    }
    const timeoutMs = Math.min(input.timeoutMs ?? profile.goalTimeoutMs, profile.goalTimeoutMs);
    const record = this.options.goals.create({
      id: input.id,
      principal: input.principal,
      fleetProfileId: profile.id,
      objective: input.objective,
      ...security,
      mode,
      synthesizer,
      synthesizerAgentId: decision.leaderId,
      autonomous: input.autonomous ?? false,
      deadlineAt: this.now() + timeoutMs,
    });
    if (decision.election) this.publishLeaderElection(record.goal, decision.election);
    this.options.goals.transition(record.goal.id, "planning", input.principal, "Coordinator accepted the goal for planning.");
    if (decision.leaderId) {
      this.options.mailbox.send({
        collaborationId: record.goal.id,
        senderId: input.principal,
        recipientId: decision.leaderId,
        kind: "delegation",
        content: input.objective,
      });
      this.enqueue(record.goal.id, input.objective);
    }
    const persisted = this.requireOwned(record.goal.id, input.principal);
    return { goal: persisted.goal, record: persisted, leaderDecision: decision };
  }

  send(goalId: string, principal: string, text: string) {
    const record = this.requireOwned(goalId, principal);
    if (record.result) throw new HeadlessError("INVALID_REQUEST", `Goal ${goalId} is already ${record.goal.state}.`);
    const recipientId = record.goal.synthesizerAgentId ?? principal;
    const message = this.options.mailbox.send({
      collaborationId: goalId,
      senderId: principal,
      recipientId,
      kind: "chat",
      content: text,
    });
    if (record.goal.synthesizerAgentId) this.enqueue(goalId, text);
    return { goal: this.options.goals.status(goalId), message };
  }

  status(goalId: string, principal: string) {
    return this.requireOwned(goalId, principal);
  }

  list(principal: string, includeAll = false) {
    return this.options.goals.listRecords().filter((record) => includeAll || record.goal.principal === principal);
  }

  result(goalId: string, principal: string) {
    this.requireOwned(goalId, principal);
    return this.options.goals.result(goalId);
  }

  cancel(goalId: string, principal: string) {
    const record = this.requireOwned(goalId, principal);
    this.integrationControllers.get(goalId)?.abort("goal cancelled");
    const cancelledDelegations = this.delegations.cancelGoal(goalId);
    if (cancelledDelegations.length === 0) {
      for (const jobId of this.activeJobs.get(goalId) ?? []) this.options.cancelJob(jobId);
    }
    return record.result ? record.goal : this.options.goals.cancel(goalId, principal);
  }

  transferSynthesizer(goalId: string, agentId: string, actor: string) {
    const record = this.options.goals.get(goalId);
    if (!record) throw new HeadlessError("INVALID_REQUEST", `Unknown goal: ${goalId}`);
    const profile = this.requireProfile(record.goal.fleetProfileId);
    if (!profile.agents.some((agent) => agent.id === agentId && agent.enabled)) {
      throw new HeadlessError("INVALID_REQUEST", `Agent ${agentId} is not enabled in fleet profile ${profile.id}.`);
    }
    return this.options.goals.transferSynthesizer(goalId, agentId, actor, `Leadership transferred to ${agentId}.`);
  }

  recover() {
    this.delegations.recoverInterrupted();
    for (const record of this.options.goals.listRecords()) {
      if (record.result) continue;
      if (record.goal.deadlineAt <= this.now()) {
        this.options.goals.setResult(record.goal.id, record.goal.principal, {
          status: "timed_out",
          summary: "Goal deadline elapsed while the daemon was unavailable.",
        });
        continue;
      }
      for (const turn of record.turns.filter((candidate) => candidate.state === "queued" || candidate.state === "running" || candidate.state === "waiting")) {
        this.options.goals.putTurn(record.goal.id, {
          ...turn,
          state: "failed",
          output: "Turn was interrupted by daemon restart and superseded by deterministic recovery.",
          completedAt: this.now(),
          updatedAt: this.now(),
        });
      }
      if (record.goal.state === "waiting_approval" && record.candidateDecisions.some((decision) => decision.decision === "integrate")) {
        this.resumeIntegration(record.goal.id);
        continue;
      }
      if (record.goal.synthesizerAgentId) {
        this.enqueue(record.goal.id, `Resume the durable goal after daemon recovery.\n\nOBJECTIVE:\n${record.goal.objective}`);
      }
    }
  }

  wait(goalId: string) {
    return this.active.get(goalId) ?? Promise.resolve();
  }

  async waitForIdle() {
    await Promise.allSettled([...this.active.values()]);
  }

  pumpDelegations() {
    this.delegations.pump();
  }

  dispose() {
    for (const controller of this.integrationControllers.values()) controller.abort("goal coordinator disposed");
    this.integrationControllers.clear();
    this.delegations.dispose();
  }

  handleApprovalResolution(approval: ApprovalRequest) {
    if (approval.kind !== "merge") return null;
    const record = this.options.goals.listRecords().find((candidate) =>
      candidate.goal.state === "waiting_approval"
      && candidate.candidateDecisions.some((decision) =>
        decision.decision === "integrate"
        && (decision.candidateId === approval.collaborationId || approval.artifactIds.includes(decision.candidateId))));
    if (!record) return null;
    if (approval.status === "approved") {
      this.resumeIntegration(record.goal.id);
    } else if (approval.status === "rejected") {
      this.options.goals.setResult(record.goal.id, approval.resolvedBy ?? record.goal.principal, {
        status: "failed",
        summary: boundedSummary(approval.resolution ?? "Candidate integration approval was rejected."),
      });
    }
    return record.goal.id;
  }

  private enqueue(goalId: string, prompt: string) {
    const prior = this.active.get(goalId) ?? Promise.resolve();
    const execution = prior
      .catch((error) => this.diagnostic(`Prior goal execution failed for ${goalId}.`, error))
      .then(() => this.executePipeline(goalId, prompt))
      .catch((error) => this.failGoal(goalId, error))
      .finally(() => {
        if (this.active.get(goalId) === execution) this.active.delete(goalId);
        this.activeJobs.delete(goalId);
      });
    this.active.set(goalId, execution);
  }

  private async executePipeline(goalId: string, prompt: string) {
    let record = this.options.goals.get(goalId);
    if (!record || record.result) return;
    const profile = this.requireProfile(record.goal.fleetProfileId);
    let leader = this.resolveLeader(profile, record);
    this.preparePlanning(goalId, record.goal.principal);
    const planTurn = await this.runPlanningTurn(
      profile,
      record.goal,
      leader,
      planningPrompt(record.goal.objective, prompt, profile.maxActiveWorkers),
    );
    const plan = parseGoalPlan(planTurn.turn.output, `${record.goal.objective}\n\nCURRENT TURN:\n${prompt}`);
    const assignments = this.assignDelegations(profile, record.goal, plan, leader.id);
    this.publishPlan(record.goal, leader.id, planTurn, plan, assignments);
    this.advance(goalId, "delegating", record.goal.principal, `Admitted ${assignments.length} bounded worker delegation(s) from plan ${planTurn.candidateId}.`);
    for (const assignment of assignments) {
      this.options.mailbox.send({
        collaborationId: goalId,
        senderId: leader.id,
        recipientId: assignment.agent.id,
        kind: "delegation",
        content: bounded(`Plan ${planTurn.candidateId} assigned ${assignment.plan.id}: ${assignment.plan.task}`),
        artifactIds: planTurn.artifactIds,
      });
    }
    this.advance(goalId, "active", record.goal.principal, "Independent worker delegations started through the durable scheduler.");
    const workerGoal = record.goal;
    const workerResults = await Promise.all(
      assignments.map((assignment) => this.runDelegationWithFailover(workerGoal, planTurn, assignment, leader)),
    );
    const workerTurns = workerResults
      .filter((result): result is { turn: CompletedGoalTurn } => "turn" in result)
      .map((result) => result.turn);
    const delegationFailures = workerResults.filter((result): result is { failure: string } => "failure" in result);
    if (workerTurns.length === 0) {
      const current = this.options.goals.get(goalId);
      const halted = !current || current.result || ["cancelled", "failed", "succeeded", "timed_out"].includes(current.goal.state);
      if (halted) return;
      throw new HeadlessError(
        "PROCESS_ERROR",
        `All ${assignments.length} worker delegation(s) failed after healthy-backend failover: ${delegationFailures
          .map((entry) => entry.failure)
          .join("; ")}`,
      );
    }
    if (delegationFailures.length > 0) {
      this.options.mailbox.send({
        collaborationId: goalId,
        senderId: leader.id,
        recipientId: workerGoal.principal,
        kind: "lifecycle",
        content: boundedSummary(`${delegationFailures.length} delegation(s) unrecoverable after failover; synthesizing from ${workerTurns.length} completed worker turn(s).`),
      });
    }
    record = this.options.goals.get(goalId);
    if (!record || record.result) return;
    leader = this.resolveLeader(profile, record);
    const independentReviewExpected = this.availableReviewers(profile, record.goal, new Set([leader.id])).length > 0;
    const synthesis = await this.runCandidateWithFailover(
      profile,
      record.goal,
      leader,
      synthesisPrompt(record.goal.objective, planTurn, plan, workerTurns),
      "candidate",
    );
    const turns = [planTurn, ...workerTurns, synthesis];
    let finalTurn = synthesis;
    let finalReview: Review | null = null;
    let reviewFailure: string | null = null;
    let reviewFailureDecision: "blocked" | "revise" | null = null;
    const reviews: Review[] = [];
    const votes: Vote[] = [];
    let reviewers = this.availableReviewers(profile, record.goal, new Set([leader.id, synthesis.turn.agentId]));
    const reviewRequired = independentReviewExpected;
    if (reviewers.length > 0) {
      for (let round = 1; round <= profile.maxDeliberationRounds; round += 1) {
        this.advance(
          goalId,
          "critiquing",
          record.goal.principal,
          `${reviewers.length} reviewer(s) received candidate ${finalTurn.candidateId} output, diff, and artifact identity.`,
        );
        const reviewRound = await this.runReviewRound(record.goal, leader, reviewers, finalTurn);
        turns.push(...reviewRound.turns);
        reviews.push(...reviewRound.reviews);
        votes.push(...reviewRound.votes);
        finalReview = reviewRound.reviews.find((review) => review.verdict !== "approve")
          ?? reviewRound.reviews.at(-1)
          ?? null;
        if (reviewRound.outcome === "blocked") {
          reviewFailure = reviewRound.reason
            ?? `Reviewer evidence for ${finalTurn.candidateId} was malformed, cited another artifact, or merely echoed supplied candidate material.`;
          reviewFailureDecision = "blocked";
          break;
        }
        if (reviewRound.outcome === "approve" || reviewRound.outcome === "reject") break;
        if (round === profile.maxDeliberationRounds) {
          reviewFailure = `Reviewers requested changes after the ${profile.maxDeliberationRounds}-round deliberation limit.`;
          reviewFailureDecision = "revise";
          break;
        }
        this.advance(goalId, "active", record.goal.principal, "Leader revision started from cited reviewer evidence.");
        record = this.options.goals.get(goalId);
        if (!record || record.result) return;
        leader = this.resolveLeader(profile, record);
        const revision = await this.runCandidateWithFailover(
          profile,
          record.goal,
          leader,
          revisionPrompt(finalTurn, reviewRound.turns, reviewRound.reviews),
          "revision",
        );
        turns.push(revision);
        finalTurn = revision;
        reviewers = this.availableReviewers(profile, record.goal, new Set([leader.id, finalTurn.turn.agentId]));
        if (reviewers.length === 0) {
          reviewFailure = `No grounded reviewer remained available for revised candidate ${finalTurn.candidateId}.`;
          reviewFailureDecision = "blocked";
          break;
        }
      }
    }

    record = this.options.goals.get(goalId);
    if (!record || record.result) return;
    this.advance(goalId, "gating", record.goal.principal, "Candidate entered deterministic completion gates.");
    const completedTurns = turns.every((turn) => turn.turn.state === "succeeded");
    const citedTurnIds = uniqueIds(turns.map((turn) => turn.turn.id));
    const citedArtifactIds = uniqueIds(turns.flatMap((turn) => turn.artifactIds));
    const candidateGrounded = finalTurn.artifactIds.includes(finalTurn.candidateId);
    const finalCandidateReviews = reviews.filter((review) => review.candidateId === finalTurn.candidateId);
    const reviewPassed = !reviewRequired
      || reviewers.length > 0
        && finalCandidateReviews.length === reviewers.length
        && finalCandidateReviews.every((review) => review.verdict === "approve");
    const candidateReviewIds = reviews.filter((review) => review.candidateId === finalTurn.candidateId).map((review) => review.id);
    const candidateVoteIds = votes.filter((vote) => vote.candidateId === finalTurn.candidateId).map((vote) => vote.id);
    const finalCandidateVotes = votes.filter((vote) => vote.candidateId === finalTurn.candidateId);
    const votePassed = !reviewRequired
      || reviewers.length > 0
        && finalCandidateVotes.length === reviewers.length
        && finalCandidateVotes.every((vote) => vote.choice === "approve");
    const gatesPassed = completedTurns && candidateGrounded && reviewPassed && votePassed && reviewFailure === null;
    const decisionReason = gatesPassed
      ? `Candidate ${finalTurn.candidateId} is backed by completed turns and attributable review evidence.`
      : reviewFailure
        ?? (finalReview?.verdict === "reject"
          ? `A grounded reviewer rejected candidate ${finalTurn.candidateId}.`
          : `Candidate ${finalTurn.candidateId} did not pass every evidence gate.`);
    const decisionId = `decision_${this.id()}`;
    const candidate = this.options.goals.addCandidateDecision(goalId, {
      id: decisionId,
      collaborationId: goalId,
      candidateId: finalTurn.candidateId,
      decision: gatesPassed
        ? "integrate"
        : reviewFailureDecision ?? (finalReview?.verdict === "reject" ? "reject" : "blocked"),
      decidedBy: record.goal.principal,
      reviewIds: candidateReviewIds,
      voteIds: candidateVoteIds,
      citedTurnIds,
      citedArtifactIds,
      gates: [
        { id: "turn-completion", status: completedTurns ? "passed" : "failed", evidenceArtifactIds: citedArtifactIds },
        { id: "candidate-grounding", status: candidateGrounded ? "passed" : "failed", evidenceArtifactIds: finalTurn.artifactIds },
        {
          id: "review-evidence",
          status: !reviewRequired ? "not_required" : reviewPassed && reviewFailure === null ? "passed" : "failed",
          evidenceArtifactIds: finalReview
            ? uniqueIds([...finalReview.citedArtifactIds, ...turns
              .filter((turn) => finalCandidateReviews.some((review) => review.reviewerId === turn.turn.agentId))
              .flatMap((turn) => turn.artifactIds)])
            : [],
        },
        {
          id: "vote-evidence",
          status: !reviewRequired ? "not_required" : votePassed && reviewFailure === null ? "passed" : "failed",
          evidenceArtifactIds: uniqueIds(votes
            .filter((vote) => vote.candidateId === finalTurn.candidateId)
            .flatMap((vote) => vote.citedArtifactIds)),
        },
      ],
      reasons: [decisionReason],
      createdAt: this.now(),
    });
    if (candidate.decision !== "integrate") {
      throw new HeadlessError("GATE_FAILED", candidate.reasons.join(" "));
    }
    await this.completeCandidate({
      goal: record.goal,
      candidateId: finalTurn.candidateId,
      decisionId,
      senderId: leader.id,
      output: finalTurn.turn.output ?? "Goal completed.",
      artifactIds: finalTurn.artifactIds,
    });
  }

  private resolveLeader(profile: FleetProfile, record: GoalRecord) {
    const decision = this.selectLeader(profile, record.goal.synthesizer, record.goal.synthesizerAgentId, record.goal);
    if (!decision.leaderId) {
      throw new HeadlessError("NATIVE_SESSION_LOST", "No healthy leader is available for goal recovery.", { retryable: true });
    }
    if (decision.leaderId !== record.goal.synthesizerAgentId) {
      this.options.goals.transferSynthesizer(record.goal.id, decision.leaderId, record.goal.principal, `Health-based ${decision.reason}.`);
      if (decision.election) this.publishLeaderElection(this.options.goals.status(record.goal.id), decision.election);
      this.options.mailbox.send({
        collaborationId: record.goal.id,
        senderId: record.goal.principal,
        recipientId: decision.leaderId,
        kind: "lifecycle",
        content: boundedSummary(`Sticky leadership transferred to ${decision.leaderId} after health-based ${decision.reason}.`),
      });
    }
    return this.requireAgent(profile, decision.leaderId);
  }

  private assignDelegations(
    profile: FleetProfile,
    goal: Goal,
    plan: ParsedGoalPlan,
    leaderId: string,
  ): AssignedDelegation[] {
    const candidates = this.automaticAgents(profile)
      .map((agent) => ({ agent, availability: this.options.availability(agent, readOnlySecurity(goal)) }))
      .filter(({ agent, availability }) => agent.enabled
        && isAvailableNow(availability, this.now())
        && availability.activeTurns < agent.maxConcurrentTurns)
      .map(({ agent }) => agent)
      .sort((left, right) => Number(left.id === leaderId) - Number(right.id === leaderId)
        || right.priority - left.priority
        || left.id.localeCompare(right.id));
    const used = new Set<string>();
    const assigned: AssignedDelegation[] = [];
    for (const delegation of plan.delegations) {
      if (assigned.length >= profile.maxActiveWorkers) break;
      const agent = candidates.find((candidate) => !used.has(candidate.id)
        && delegation.capabilities.every((capability) => candidate.capabilities.includes(capability)));
      if (!agent) continue;
      used.add(agent.id);
      assigned.push({ plan: delegation, agent });
    }
    if (assigned.length > 0) return assigned;
    const fallbackAgent = candidates.find((agent) => agent.id === leaderId) ?? candidates[0];
    if (!fallbackAgent) {
      throw new HeadlessError("NATIVE_AUTH_UNAVAILABLE", "No authenticated, healthy worker is available for the planned goal.", { retryable: true });
    }
    return [{
      plan: {
        id: "fallback-worker-1",
        task: boundedPart(`${goal.objective}\n\nExecute one safe, concrete unit of analysis for task synthesis.`, 8_192),
        capabilities: [],
      },
      agent: fallbackAgent,
    }];
  }

  private async runCandidateWithFailover(
    profile: FleetProfile,
    goal: Goal,
    leader: AgentProfile,
    prompt: string,
    role: "candidate" | "revision",
  ) {
    const triedAgentIds = new Set<string>();
    const triedBackends = new Set<string>();
    let agent: AgentProfile | null = leader;
    let lastError: unknown = new HeadlessError("PROCESS_ERROR", "No healthy candidate executor was available.");
    while (agent) {
      triedAgentIds.add(agent.id);
      triedBackends.add(agent.backend);
      try {
        const turn = await this.runTurn(goal, agent, prompt, leader.id, role, goal.principal);
        if (agent.id !== leader.id) {
          this.options.mailbox.send({
            collaborationId: goal.id,
            senderId: agent.id,
            recipientId: goal.principal,
            kind: "lifecycle",
            content: boundedSummary(`${role === "candidate" ? "Candidate execution" : "Revision"} recovered on ${agent.id} (${agent.backend}); ${leader.id} remains the sticky goal leader.`),
            artifactIds: turn.artifactIds,
          });
        }
        return turn;
      } catch (error) {
        lastError = error;
        if (!isOperationalCandidateFailure(error)) throw error;
        const current = this.options.goals.get(goal.id);
        if (!current || current.result || this.now() >= goal.deadlineAt || current.turns.length >= MAX_DURABLE_TURNS_PER_GOAL) throw error;
        const failedAgent = agent;
        agent = this.automaticAgents(profile)
          .map((candidate) => ({ candidate, availability: this.options.availability(candidate, goalSecurity(goal)) }))
          .filter(({ candidate, availability }) => candidate.enabled
            && !triedAgentIds.has(candidate.id)
            && !triedBackends.has(candidate.backend)
            && (goal.mode !== "write" || backendMetadata[normalizeBackend(candidate.backend)].canWrite)
            && isAvailableNow(availability, this.now())
            && availability.activeTurns < candidate.maxConcurrentTurns)
          .map(({ candidate }) => candidate)
          .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))
          .at(0) ?? null;
        if (agent) {
          this.options.mailbox.send({
            collaborationId: goal.id,
            senderId: leader.id,
            recipientId: goal.principal,
            kind: "lifecycle",
            content: boundedSummary(`${role === "candidate" ? "Candidate executor" : "Revision executor"} ${failedAgent.id} failed after its bounded retry budget. Retrying on ${agent.id} (${agent.backend}) without changing goal leadership.`),
          });
        }
      }
    }
    throw lastError;
  }

  private async runPlanningTurn(profile: FleetProfile, goal: Goal, leader: AgentProfile, prompt: string) {
    const triedAgentIds = new Set<string>();
    const triedBackends = new Set<string>();
    let planner: AgentProfile | null = leader;
    let lastError: unknown = new HeadlessError("PROCESS_ERROR", "No healthy planner was available.");
    while (planner) {
      triedAgentIds.add(planner.id);
      triedBackends.add(planner.backend);
      try {
        const turn = await this.runTurn(goal, planner, prompt, goal.principal, "planning", goal.principal);
        if (planner.id !== leader.id) {
          this.options.mailbox.send({
            collaborationId: goal.id,
            senderId: planner.id,
            recipientId: goal.principal,
            kind: "lifecycle",
            content: boundedSummary(`Planning recovered on ${planner.id} (${planner.backend}); ${leader.id} remains the sticky goal leader.`),
            artifactIds: turn.artifactIds,
          });
        }
        return turn;
      } catch (error) {
        lastError = error;
        planner = this.automaticAgents(profile)
          .map((candidate) => ({ candidate, availability: this.options.availability(candidate, readOnlySecurity(goal)) }))
          .filter(({ candidate, availability }) => candidate.enabled
            && !triedAgentIds.has(candidate.id)
            && !triedBackends.has(candidate.backend)
            && isAvailableNow(availability, this.now())
            && availability.activeTurns < candidate.maxConcurrentTurns)
          .map(({ candidate }) => candidate)
          .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))
          .at(0) ?? null;
        if (planner) {
          this.options.mailbox.send({
            collaborationId: goal.id,
            senderId: leader.id,
            recipientId: goal.principal,
            kind: "lifecycle",
            content: boundedSummary(`Planner ${[...triedAgentIds].at(-1)} failed after its bounded retry budget. Retrying the read-only plan on ${planner.id} (${planner.backend}) without changing goal leadership.`),
          });
        }
      }
    }
    throw lastError;
  }

  // Run a single delegation, reassigning it to a distinct healthy backend on
  // worker failure (e.g. a provider stream disconnect). Each distinct backend
  // is attempted at most once; failed attempts keep their durable turn evidence.
  // The goal only fails a delegation after every eligible healthy agent is
  // exhausted or the durable-turn cap / deadline is reached.
  private async runDelegationWithFailover(
    goal: Goal,
    planTurn: CompletedGoalTurn,
    assignment: AssignedDelegation,
    leader: AgentProfile,
  ): Promise<{ turn: CompletedGoalTurn } | { failure: string }> {
    const triedAgentIds = new Set<string>();
    const triedBackends = new Set<string>();
    let lastError = `No eligible healthy worker was available for delegation ${assignment.plan.id}.`;
    let agent: AgentProfile | null = assignment.agent;
    let attempt = 0;
    while (agent) {
      const current = this.options.goals.get(goal.id);
      const halted = !current || current.result || ["cancelled", "failed", "succeeded", "timed_out"].includes(current.goal.state);
      if (halted) return { failure: lastError };
      if (current.turns.length >= MAX_DURABLE_TURNS_PER_GOAL) {
        lastError = `Durable turn cap reached before delegation ${assignment.plan.id} could recover.`;
        break;
      }
      if (this.now() >= goal.deadlineAt) {
        lastError = `Deadline reached before delegation ${assignment.plan.id} could recover.`;
        break;
      }
      triedAgentIds.add(agent.id);
      triedBackends.add(agent.backend);
      try {
        const completed = await this.runTurn(
          goal,
          agent,
          workerPrompt(goal.objective, assignment.plan, planTurn),
          leader.id,
          "worker",
          leader.id,
        );
        this.publishWorkerQuestions(goal, agent.id, leader.id, completed);
        if (attempt > 0) {
          this.options.mailbox.send({
            collaborationId: goal.id,
            senderId: leader.id,
            recipientId: goal.principal,
            kind: "lifecycle",
            content: boundedSummary(`Delegation ${assignment.plan.id} recovered on ${agent.id} (${agent.backend}) after ${attempt} failed worker attempt(s).`),
            artifactIds: completed.artifactIds,
          });
        }
        return { turn: completed };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        const latest = this.options.goals.get(goal.id);
        const halted = !latest || latest.result || ["cancelled", "failed", "succeeded", "timed_out"].includes(latest.goal.state);
        if (halted) {
          return { failure: lastError };
        }
        this.options.mailbox.send({
          collaborationId: goal.id,
          senderId: leader.id,
          recipientId: goal.principal,
          kind: "lifecycle",
          content: boundedSummary(`Worker ${agent.id} (${agent.backend}) failed delegation ${assignment.plan.id}: ${lastError}. Reassigning to a distinct healthy backend.`),
        });
      }
      attempt += 1;
      agent = this.selectFailoverAgent(goal, assignment, leader, triedAgentIds, triedBackends);
    }
    return { failure: lastError };
  }

  private selectFailoverAgent(
    goal: Goal,
    assignment: AssignedDelegation,
    leader: AgentProfile,
    triedAgentIds: Set<string>,
    triedBackends: Set<string>,
  ): AgentProfile | null {
    const profile = this.requireProfile(goal.fleetProfileId);
    return this.automaticAgents(profile)
      .map((candidate) => ({ candidate, availability: this.options.availability(candidate, readOnlySecurity(goal)) }))
      .filter(({ candidate, availability }) => candidate.enabled
        && !triedAgentIds.has(candidate.id)
        && !triedBackends.has(candidate.backend)
        && assignment.plan.capabilities.every((capability) => candidate.capabilities.includes(capability))
        && isAvailableNow(availability, this.now()))
      .map(({ candidate }) => candidate)
      .sort((left, right) => Number(left.id === leader.id) - Number(right.id === leader.id)
        || right.priority - left.priority
        || left.id.localeCompare(right.id))
      .at(0) ?? null;
  }

  private availableReviewers(profile: FleetProfile, goal: Goal, excludedAgentIds: Set<string>) {
    const attemptTurnCapacity = Math.floor(MAX_DURABLE_TURNS_PER_GOAL / profile.maxAttemptsPerDelegation);
    const fixedTurnCapacity = profile.maxActiveWorkers + profile.maxDeliberationRounds + 1;
    const reviewerTurnCapacity = Math.max(1, Math.floor(
      (attemptTurnCapacity - fixedTurnCapacity) / profile.maxDeliberationRounds,
    ));
    return this.automaticAgents(profile)
      .map((agent) => ({ agent, availability: this.options.availability(agent, readOnlySecurity(goal)) }))
      .filter(({ agent, availability }) => agent.enabled
        && !excludedAgentIds.has(agent.id)
        && isAvailableNow(availability, this.now())
        && availability.activeTurns < agent.maxConcurrentTurns)
      .map(({ agent }) => agent)
      .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))
      .slice(0, Math.min(
        profile.maxActiveWorkers,
        Math.max(1, Math.floor(MAX_DURABLE_REVIEWS_PER_GOAL / profile.maxDeliberationRounds)),
        reviewerTurnCapacity,
      ));
  }

  private publishPlan(
    goal: Goal,
    leaderId: string,
    planTurn: CompletedGoalTurn,
    plan: ParsedGoalPlan,
    assignments: AssignedDelegation[],
  ) {
    this.options.mailbox.send({
      collaborationId: goal.id,
      senderId: leaderId,
      recipientId: goal.principal,
      kind: "lifecycle",
      content: boundedSummary([
        `Planning artifact ${planTurn.candidateId} parsed via ${plan.source}.`,
        `Admitted ${assignments.length}/${plan.delegations.length} bounded delegation(s).`,
        plan.reason ? `Fallback reason: ${plan.reason}` : "Strict plan schema accepted.",
      ].join(" ")),
      artifactIds: planTurn.artifactIds,
    });
  }

  private publishWorkerQuestions(goal: Goal, workerId: string, leaderId: string, completed: CompletedGoalTurn) {
    const questions = (completed.turn.output ?? "").replaceAll("\r\n", "\n").split("\n")
      .map((line) => /^QUESTION:\s*(.{1,4096})$/i.exec(line.trim())?.[1]?.trim() ?? null)
      .filter((question): question is string => question !== null)
      .slice(0, 8);
    for (const question of questions) {
      this.options.mailbox.send({
        collaborationId: goal.id,
        senderId: workerId,
        recipientId: leaderId,
        kind: "question",
        content: boundedSummary(question),
        artifactIds: completed.artifactIds,
      });
    }
  }

  private async runReviewRound(
    goal: Goal,
    leader: AgentProfile,
    reviewers: AgentProfile[],
    candidate: CompletedGoalTurn,
  ): Promise<ReviewRound> {
    const settled = await Promise.allSettled(reviewers.map(async (reviewer) => ({
      reviewer,
      turn: await this.runTurn(goal, reviewer, reviewPrompt(goal.objective, candidate), leader.id, "review", leader.id),
    })));
    const turns: CompletedGoalTurn[] = [];
    const reviews: Review[] = [];
    const votes: Vote[] = [];
    const failures: string[] = [];
    for (const item of settled) {
      if (item.status === "rejected") {
        failures.push(item.reason instanceof Error ? item.reason.message : String(item.reason));
        continue;
      }
      const { reviewer, turn } = item.value;
      turns.push(turn);
      const grounded = parseGroundedReview(turn.turn.output, candidate);
      if (!grounded) {
        failures.push(`Reviewer ${reviewer.id} evidence was malformed, cited another artifact, or merely echoed supplied candidate material.`);
        continue;
      }
      const review = this.options.goals.addReview(goal.id, {
        id: `review_${this.id()}`,
        collaborationId: goal.id,
        candidateId: candidate.candidateId,
        reviewerId: reviewer.id,
        verdict: grounded.verdict,
        summary: grounded.summary,
        findings: [grounded.summary],
        citedTurnIds: [candidate.turn.id],
        citedArtifactIds: candidate.artifactIds,
        createdAt: this.now(),
      });
      reviews.push(review);
      const vote = this.options.goals.addVote(goal.id, {
        id: `vote_${this.id()}`,
        collaborationId: goal.id,
        candidateId: candidate.candidateId,
        voterId: reviewer.id,
        choice: review.verdict === "approve" ? "approve" : review.verdict === "reject" ? "reject" : "revise",
        rationale: grounded.summary,
        citedTurnIds: [candidate.turn.id],
        citedArtifactIds: candidate.artifactIds,
        createdAt: this.now(),
      });
      votes.push(vote);
      this.options.mailbox.send({
        collaborationId: goal.id,
        senderId: reviewer.id,
        recipientId: leader.id,
        kind: "review",
        content: grounded.summary,
        artifactIds: uniqueIds([...candidate.artifactIds, ...turn.artifactIds]),
      });
      this.options.mailbox.send({
        collaborationId: goal.id,
        senderId: reviewer.id,
        recipientId: goal.principal,
        kind: "vote",
        content: grounded.summary,
        artifactIds: candidate.artifactIds,
      });
    }
    if (failures.length > 0) return { turns, reviews, votes, outcome: "blocked", reason: boundedSummary(failures.join(" ")) };
    if (reviews.some((review) => review.verdict === "reject")) {
      return { turns, reviews, votes, outcome: "reject", reason: "At least one grounded reviewer rejected the candidate." };
    }
    if (reviews.some((review) => review.verdict === "request_changes")) {
      return { turns, reviews, votes, outcome: "revise", reason: null };
    }
    return { turns, reviews, votes, outcome: "approve", reason: null };
  }

  private resumeIntegration(goalId: string) {
    const prior = this.active.get(goalId) ?? Promise.resolve();
    const execution = prior
      .catch((error) => this.diagnostic(`Prior goal execution failed for ${goalId}.`, error))
      .then(async () => {
        const record = this.options.goals.get(goalId);
        if (!record || record.result || record.goal.state !== "waiting_approval") return;
        const decision = [...record.candidateDecisions].reverse().find((candidate) => candidate.decision === "integrate");
        if (!decision) throw new HeadlessError("GATE_FAILED", `Goal ${goalId} has no approved candidate decision to resume.`);
        const turn = [...record.turns].reverse().find((candidate) => candidate.artifactIds.includes(decision.candidateId));
        if (!turn) throw new HeadlessError("GATE_FAILED", `Candidate ${decision.candidateId} has no durable originating turn.`);
        await this.completeCandidate({
          goal: record.goal,
          candidateId: decision.candidateId,
          decisionId: decision.id,
          senderId: record.goal.synthesizerAgentId ?? record.goal.principal,
          output: turn.output ?? "Goal candidate integrated.",
          artifactIds: turn.artifactIds,
        });
      })
      .catch((error) => this.failGoal(goalId, error))
      .finally(() => {
        if (this.active.get(goalId) === execution) this.active.delete(goalId);
      });
    this.active.set(goalId, execution);
  }

  private async completeCandidate(input: {
    goal: Goal;
    candidateId: string;
    decisionId: string;
    senderId: string;
    output: string;
    artifactIds: string[];
  }) {
    let artifactIds = input.artifactIds;
    if (input.goal.mode === "write") {
      if (!this.options.integrateCandidate) {
        throw new HeadlessError("INTERNAL_ERROR", "Write-goal candidate integration is not configured.");
      }
      this.advance(input.goal.id, "integrating", input.goal.principal, `Integrating gated candidate ${input.candidateId}.`);
      const controller = new AbortController();
      this.integrationControllers.set(input.goal.id, controller);
      try {
        const integration = await this.options.integrateCandidate({
          goal: input.goal,
          candidateId: input.candidateId,
          decisionId: input.decisionId,
          signal: controller.signal,
        });
        if (!integration.merged || !integration.resultingCommit) {
          throw new HeadlessError("GATE_FAILED", integration.summary || `Candidate ${input.candidateId} was not integrated.`);
        }
        artifactIds = uniqueIds([...artifactIds, ...(integration.artifactIds ?? [])]);
      } catch (error) {
        if (error instanceof HeadlessError && error.code === "APPROVAL_REQUIRED") {
          this.advance(input.goal.id, "waiting_approval", input.goal.principal, error.message);
          this.options.mailbox.send({
            collaborationId: input.goal.id,
            senderId: input.senderId,
            recipientId: input.goal.principal,
            kind: "approval",
            content: error.message,
            artifactIds: input.artifactIds,
          });
          return;
        }
        throw error;
      } finally {
        if (this.integrationControllers.get(input.goal.id) === controller) this.integrationControllers.delete(input.goal.id);
      }
    }
    const record = this.options.goals.get(input.goal.id);
    if (!record || record.result) return;
    this.options.mailbox.send({
      collaborationId: input.goal.id,
      senderId: input.senderId,
      recipientId: input.goal.principal,
      kind: "completion",
      content: input.output,
      artifactIds,
    });
    this.options.goals.setResult(input.goal.id, input.goal.principal, {
      status: "succeeded",
      summary: boundedSummary(input.output),
      artifactIds,
      candidateDecisionId: input.decisionId,
    });
  }

  private runTurn(
    goal: Goal,
    agent: AgentProfile,
    prompt: string,
    fromAgentId: string,
    role: GoalTurnRole,
    reportTo = goal.principal,
  ): Promise<CompletedGoalTurn> {
    const profile = this.requireProfile(goal.fleetProfileId);
    let currentJobId: string | null = null;
    return this.delegations.run({
      goal,
      fromAgentId,
      toAgentId: agent.id,
      nativeSessionId: latestNativeSession(this.options.goals.get(goal.id), agent.id),
      task: bounded(prompt),
      maxActive: profile.maxActiveWorkers,
      maxQueued: profile.maxQueuedDelegations,
      maxAttempts: profile.maxAttemptsPerDelegation,
      cancel: () => {
        if (currentJobId) this.options.cancelJob(currentJobId);
      },
      execute: async (delegation, context) => {
        const at = this.now();
        const existing = this.options.goals.get(goal.id);
        let artifactIds: string[] = [];
        const turn = this.options.goals.addTurn(goal.id, {
          id: `turn_${this.id()}`,
          goalId: goal.id,
          delegationId: delegation.id,
          agentId: agent.id,
          nativeSessionId: delegation.nativeSessionId,
          authMode: goal.authMode,
          sequence: (existing?.turns.reduce((max, candidate) => Math.max(max, candidate.sequence), 0) ?? 0) + 1,
          state: "queued",
          input: bounded(prompt),
          output: null,
          artifactIds: [],
          startedAt: null,
          completedAt: null,
          createdAt: at,
          updatedAt: at,
        });
        this.options.goals.putTurn(goal.id, { ...turn, state: "running", startedAt: this.now(), updatedAt: this.now() });
        let execution: GoalTurnExecution;
        let turnTimeoutMs = 1;
        try {
          turnTimeoutMs = Math.max(1, Math.min(
            goal.deadlineAt - this.now(),
            role === "candidate" || role === "revision"
              ? MAX_CANDIDATE_TURN_TIMEOUT_MS
              : providerTurnTimeoutMs(agent.backend),
          ));
          execution = this.options.executeTurn({ goal, agent, role, prompt: turn.input, timeoutMs: turnTimeoutMs });
          currentJobId = execution.jobId;
          artifactIds = uniqueIds([execution.jobId, ...(execution.artifactIds ?? [])]);
          const activeJobs = this.activeJobs.get(goal.id) ?? new Set<string>();
          activeJobs.add(execution.jobId);
          this.activeJobs.set(goal.id, activeJobs);
          const bound = context.bindNativeSession(execution.sessionId);
          this.options.goals.putTurn(goal.id, {
            ...turn,
            state: "running",
            nativeSessionId: bound.nativeSessionId,
            artifactIds,
            startedAt: this.now(),
            updatedAt: this.now(),
          });
        } catch (error) {
          if (currentJobId) this.options.cancelJob(currentJobId);
          const output = bounded(error instanceof Error ? error.message : String(error));
          this.options.goals.putTurn(goal.id, {
            ...turn,
            state: "failed",
            output,
            artifactIds,
            startedAt: at,
            completedAt: this.now(),
            updatedAt: this.now(),
          });
          const failure = error instanceof HeadlessError ? error : new HeadlessError("PROCESS_ERROR", output);
          return { kind: "failed" as const, error: output, code: failure.code, retryable: failure.retryable };
        }

        let result: RunResult;
        try {
          result = await withTurnTimeout(execution.completion, turnTimeoutMs, () => this.options.cancelJob(execution.jobId));
        } catch (error) {
          const output = bounded(error instanceof Error ? error.message : String(error));
          this.options.goals.putTurn(goal.id, {
            ...turn,
            state: "failed",
            nativeSessionId: execution.sessionId,
            output,
            artifactIds,
            startedAt: at,
            completedAt: this.now(),
            updatedAt: this.now(),
          });
          const failure = error instanceof HeadlessError ? error : new HeadlessError("PROCESS_ERROR", output);
          return { kind: "failed" as const, error: output, code: failure.code, retryable: failure.retryable };
        } finally {
          const activeJobs = this.activeJobs.get(goal.id);
          activeJobs?.delete(execution.jobId);
          if (activeJobs?.size === 0) this.activeJobs.delete(goal.id);
          currentJobId = null;
        }
        const rateLimit = rateLimitRecovery(result);
        if (rateLimit) {
          const output = bounded(result.error?.message || "Turn was rate limited.");
          this.options.goals.putTurn(goal.id, {
            ...turn,
            state: "failed",
            nativeSessionId: execution.sessionId,
            output,
            artifactIds,
            startedAt: at,
            completedAt: this.now(),
            updatedAt: this.now(),
          });
          return { kind: "rate_limited" as const, error: output, ...rateLimit };
        }
        const plannerEnvelopeRecovered = role === "planning"
          && parseGoalPlan(result.output, "").source === "planner";
        const prematureWorkerCompletion = role === "worker" && isPrematureWorkerCompletion(result);
        const usableTimedOutWorker = role === "worker" && isSubstantiveTimedOutWorker(result);
        const state: Turn["state"] = (result.status === "succeeded" && !prematureWorkerCompletion) || plannerEnvelopeRecovered || usableTimedOutWorker
          ? "succeeded"
          : result.status === "cancelled" ? "cancelled" : result.status === "timed_out" ? "timed_out" : "failed";
        const output = bounded(prematureWorkerCompletion
          ? `Provider exited after a planning preamble without concrete findings: ${result.output}`
          : usableTimedOutWorker
            ? `Provider reached its turn limit after producing substantive read-only evidence; preserving the bounded report for synthesis.\n\n${result.output}`
          : result.output || result.error?.message || "Turn completed without output.");
        const completed = this.options.goals.putTurn(goal.id, {
          ...turn,
          state,
          nativeSessionId: execution.sessionId,
          output,
          artifactIds,
          startedAt: at,
          completedAt: this.now(),
          updatedAt: this.now(),
        });
        this.options.mailbox.send({
          collaborationId: goal.id,
          senderId: agent.id,
          recipientId: reportTo,
          kind: state === "succeeded" ? "report" : "policy",
          content: output,
          artifactIds,
        });
        const value: CompletedGoalTurn = {
          turn: completed,
          result,
          candidateId: execution.jobId,
          artifactIds,
          evidence: candidateEvidence(execution.jobId, result, output),
        };
        return state === "succeeded"
          ? { kind: "succeeded" as const, value, resultTurnId: completed.id, artifactIds: completed.artifactIds }
          : {
            kind: "failed" as const,
            error: output,
            code: result.error?.code ?? (state === "cancelled" ? "CANCELLED" : state === "timed_out" ? "TIMED_OUT" : "PROCESS_ERROR"),
            retryable: result.error?.retryable,
          };
      },
    });
  }

  private failGoal(goalId: string, error: unknown) {
    const record = this.options.goals.get(goalId);
    if (!record || record.result) return;
    const message = boundedSummary(error instanceof Error ? error.message : String(error));
    try {
      this.options.goals.setResult(goalId, record.goal.principal, { status: "failed", summary: message });
      this.options.mailbox.send({
        collaborationId: goalId,
        senderId: record.goal.synthesizerAgentId ?? record.goal.principal,
        recipientId: record.goal.principal,
        kind: "completion",
        content: message,
      });
    } catch (persistenceError) {
      this.diagnostic(`Unable to persist terminal failure for goal ${goalId}.`, persistenceError);
    }
  }

  private advance(goalId: string, state: Goal["state"], actor: string, reason: string) {
    const current = this.options.goals.get(goalId);
    if (!current || current.result || current.goal.state === state) return;
    this.options.goals.transition(goalId, state, actor, reason);
  }

  private preparePlanning(goalId: string, actor: string) {
    const state = this.options.goals.status(goalId).state;
    if (state === "queued") {
      this.advance(goalId, "planning", actor, "Recovered goal returned to planning.");
    }
  }

  private selectLeader(
    profile: FleetProfile,
    synthesizer: SynthesizerSelection,
    currentLeaderId: string | null,
    security: GoalSecurityControls,
  ): GoalLeaderDecision {
    if (synthesizer.kind === "agent") {
      const agent = this.requireAgent(profile, synthesizer.agentId);
      const availability = this.options.availability(agent, security);
      if (!agent.enabled || !availability.authenticated || availability.health === "offline" || availability.health === "unhealthy") {
        return { leaderId: null, keptCurrent: false, reason: "no_eligible_candidate", scores: [] };
      }
      return { leaderId: agent.id, keptCurrent: currentLeaderId === agent.id, reason: currentLeaderId === agent.id ? "sticky" : "selected", scores: [] };
    }
    const candidates = this.automaticAgents(profile).map((agent) => {
      const availability = this.options.availability(agent, security);
      return {
        agentId: agent.id,
        enabled: agent.enabled,
        authenticated: availability.authenticated,
        health: availability.health,
        capabilities: agent.capabilities,
        rateLimitedUntil: availability.rateLimitedUntil,
        priority: agent.priority,
        activeTurns: availability.activeTurns,
        maxConcurrentTurns: agent.maxConcurrentTurns,
        recentFailures: availability.recentFailures,
      };
    });
    if (synthesizer.kind === "election") {
      const sticky = selectStickyLeader({ now: this.now(), currentLeaderId, requiredCapabilities: [], candidates });
      if (sticky.keptCurrent) return sticky;
      const election = runCouncilLeaderElection({
        electionId: `election_${this.id()}`,
        now: this.now(),
        requiredCapabilities: [],
        candidates,
      });
      return {
        leaderId: election.leaderId,
        keptCurrent: false,
        reason: election.leaderId ? currentLeaderId ? "failover" : "selected" : "no_eligible_candidate",
        scores: election.candidateScores,
        election,
      };
    }
    return selectStickyLeader({
      now: this.now(),
      currentLeaderId,
      requiredCapabilities: [],
      candidates,
    });
  }

  private publishLeaderElection(goal: Goal, election: CouncilLeaderElectionDecision) {
    for (const ballot of election.ballots) {
      this.options.mailbox.send({
        collaborationId: goal.id,
        senderId: ballot.voterId,
        recipientId: goal.principal,
        kind: "vote",
        content: boundedSummary([
          `Leader election ${election.electionId} policy ballot.`,
          ballot.rationale,
          ...ballot.rankings.map((ranking, index) => `${index + 1}. ${ranking.candidateId} score=${ranking.score}`),
        ].join("\n")),
        artifactIds: [election.electionId, ballot.id],
      });
    }
    this.options.mailbox.send({
      collaborationId: goal.id,
      senderId: goal.principal,
      recipientId: election.leaderId ?? goal.principal,
      kind: "lifecycle",
      content: boundedSummary([
        `Leader election ${election.status}: ${election.leaderId ?? "no leader"}.`,
        ...election.evidence,
      ].join("\n")),
      artifactIds: [election.electionId],
    });
  }

  private requireOwned(goalId: string, principal: string): GoalRecord {
    const record = this.options.goals.get(goalId);
    if (!record) throw new HeadlessError("INVALID_REQUEST", `Unknown goal: ${goalId}`);
    if (record.goal.principal !== principal) throw new HeadlessError("POLICY_DENIED", "Goal belongs to another authenticated principal.");
    return record;
  }

  private requireProfile(profileId: string) {
    const profile = this.options.fleets.get(profileId);
    if (!profile) throw new HeadlessError("INVALID_REQUEST", `Unknown fleet profile: ${profileId}`);
    return profile;
  }

  private requireAgent(profile: FleetProfile, agentId: string) {
    const agent = profile.agents.find((candidate) => candidate.id === agentId);
    if (!agent) throw new HeadlessError("INVALID_REQUEST", `Unknown fleet agent ${agentId} in profile ${profile.id}.`);
    return agent;
  }

  private automaticAgents(profile: FleetProfile) {
    const activeLeadBackend = this.options.activeLeadBackend?.();
    if (!activeLeadBackend) return profile.agents;
    return profile.agents.filter((agent) => normalizeBackend(agent.backend) !== normalizeBackend(activeLeadBackend));
  }
}

function planningPrompt(objective: string, prompt: string, maxDelegations: number) {
  return bounded(`You are the sticky task synthesizer planning a durable Headless goal. This planning turn is read-only. Return only the strict plan envelope below, with between 1 and ${maxDelegations} independent delegations. Do not use markdown fences or add prose. Each capability is an optional bounded identifier; use an empty list unless the task truly requires a declared fleet capability.

${GOAL_PLAN_HEADER}
{"delegations":[{"id":"work-1","task":"one concrete independent read-only task","capabilities":[]}]}

GOAL:
${boundedPart(objective, 8_000)}

CURRENT TURN:
${boundedPart(prompt, 8_000)}`);
}

function workerPrompt(objective: string, plan: GoalPlanDelegation, planning: CompletedGoalTurn) {
  return bounded(`Execute the assigned independent delegation for a durable Headless goal. This worker turn is read-only. Report concrete findings, verification evidence, and artifact references for task synthesis. If clarification is essential, put each bounded question on its own line starting with "QUESTION:"; still provide all progress possible.

GOAL:
${boundedPart(objective, 6_000)}

PLANNING ARTIFACT: ${planning.candidateId}
DELEGATION: ${plan.id}
REQUIRED CAPABILITIES: ${plan.capabilities.join(", ") || "none"}
TASK:
${boundedPart(plan.task, 12_000)}`);
}

function synthesisPrompt(
  objective: string,
  planning: CompletedGoalTurn,
  plan: ParsedGoalPlan,
  workers: CompletedGoalTurn[],
) {
  return bounded(`Act as the sticky task synthesizer and produce one complete candidate from the actual bounded worker outputs, diffs, and artifacts below. Resolve reported questions from the available evidence. Do not claim evidence that is not present. For a write goal, make only the contained changes needed for the candidate; for a read-only goal, return the concrete final result with verification evidence.

GOAL:
${boundedPart(objective, 4_000)}

PLAN SOURCE: ${plan.source}
PLANNING ARTIFACT: ${planning.candidateId}
${workerEvidenceBundle(workers)}`);
}

function reviewPrompt(objective: string, candidate: CompletedGoalTurn) {
  return bounded(`Review the actual candidate output and diff below against the stated goal. Do not merely echo this prompt or the supplied candidate material.

The write candidate is isolated from the primary checkout until every review and daemon gate passes. Your read-only workspace therefore remains unchanged by design: do not inspect the primary checkout as evidence that the candidate is absent. A base/resulting commit match is also expected before integration. Judge the supplied bounded diff and output. Headless runs configured project gates after approval, so missing raw terminal logs alone is not a reason to reject otherwise concrete candidate evidence.

Your first line must be exactly one of "VERDICT: APPROVE", "VERDICT: REQUEST_CHANGES", or "VERDICT: REJECT".
Your second line must be exactly "EVIDENCE: ${candidate.candidateId}".
After those two lines, give an independent concrete rationale. A missing or different artifact id fails the evidence gate.

GOAL:
${boundedPart(objective, 4_096)}

CANDIDATE EVIDENCE:
${candidate.evidence}`);
}

function revisionPrompt(candidate: CompletedGoalTurn, critiques: CompletedGoalTurn[], reviews: Review[]) {
  return bounded(`Revise candidate ${candidate.candidateId} using the attributable reviewer evidence. Return the complete improved result and explicitly address the findings.

REVIEW SUMMARIES:
${boundedPart(reviews.map((review) => `${review.reviewerId}: ${review.summary}`).join("\n"), 7_000)}

REVIEW RUN EVIDENCE:
${workerEvidenceBundle(critiques, 8_000)}

CANDIDATE EVIDENCE:
${boundedPart(candidate.evidence, 16_000)}`);
}

function workerEvidenceBundle(turns: CompletedGoalTurn[], totalBudget = 22_000) {
  if (turns.length === 0) return "WORKER EVIDENCE: none.";
  const perTurn = Math.max(256, Math.floor(totalBudget / turns.length));
  return turns.map((turn, index) => boundedPart([
    `WORKER ${index + 1}`,
    `TURN ID: ${turn.turn.id}`,
    `AGENT ID: ${turn.turn.agentId}`,
    `ARTIFACT IDS: ${turn.artifactIds.join(", ") || "none"}`,
    turn.evidence,
  ].join("\n"), perTurn)).join("\n\n");
}

function bounded(value: string) {
  return boundedUtf8(value, 32_768, 65_536);
}

function boundedSummary(value: string) {
  return boundedUtf8(value, 16_384, 32_768);
}

function boundedPart(value: string, maxLength: number) {
  return boundedUtf8(value, maxLength, maxLength * 2);
}

function candidateEvidence(candidateId: string, result: RunResult, output: string) {
  const diff = result.diff;
  return bounded([
    `CANDIDATE ARTIFACT ID: ${candidateId}`,
    `OUTPUT:\n${boundedPart(output, 2_000)}`,
    diff
      ? `DIFF STATUS:\n${boundedPart(diff.status, 1_000)}\n\nDIFF FILES:\n${boundedPart(diff.files.join("\n"), 1_500)}\n\nDIFF PATCH:\n${boundedPart(diff.patch, 22_000)}`
      : "DIFF: none reported by the daemon-owned run.",
    `COMMITS: base=${result.diff?.baseCommit ?? result.commit?.base ?? "none"}; candidate=${result.diff?.candidateCommit ?? result.commit?.candidate ?? "none"}; resulting=${result.diff?.resultingCommit ?? result.commit?.result ?? "none"}`,
  ].join("\n\n"));
}

function parseGroundedReview(output: string | null, candidate: CompletedGoalTurn): GroundedReview | null {
  if (!output) return null;
  const [verdictLine, evidenceLine, ...bodyLines] = output.replaceAll("\r\n", "\n").split("\n");
  const verdict = /^VERDICT: (APPROVE|REQUEST_CHANGES|REJECT)$/.exec(verdictLine?.trim() ?? "")?.[1];
  if (!verdict || evidenceLine?.trim() !== `EVIDENCE: ${candidate.candidateId}`) return null;
  const body = bodyLines.join("\n").trim().replace(/^SUMMARY:\s*/i, "").trim();
  if (body.length < 8 || /^(?:\.{3}|tbd|none|n\/a)$/i.test(body)) return null;
  const normalized = normalizeEvidence(body);
  if (!normalized) return null;
  if (normalized === normalizeEvidence(candidate.turn.output ?? "") || normalized === normalizeEvidence(candidate.evidence)) return null;
  return {
    verdict: verdict === "APPROVE" ? "approve" : verdict === "REJECT" ? "reject" : "request_changes",
    summary: boundedSummary(body),
  };
}

function normalizeEvidence(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function uniqueIds(values: string[]) {
  return [...new Set(values)].slice(0, 256);
}

function providerTurnTimeoutMs(backend: string) {
  try {
    return backendMetadata[normalizeBackend(backend)].timeoutMs;
  } catch {
    return DEFAULT_EXTENSION_TURN_TIMEOUT_MS;
  }
}

async function withTurnTimeout<T>(promise: Promise<T>, timeoutMs: number, cancel: () => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try { cancel(); } catch { /* best-effort cancellation; timeout remains authoritative */ }
      reject(new HeadlessError("TIMED_OUT", `Provider turn exceeded its bounded ${timeoutMs}ms timeout.`, { retryable: true }));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function boundedUtf8(value: string, maxLength: number, maxBytes: number) {
  const redacted = redactAndTruncate(value, maxLength).text;
  let text = redacted.length <= maxLength ? redacted : redacted.slice(0, maxLength);
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  text = text.slice(0, low);
  while (text.length > 0 && Buffer.byteLength(text) > maxBytes) text = text.slice(0, -1);
  return text;
}

function latestNativeSession(record: GoalRecord | null, agentId: string) {
  if (!record) return null;
  for (let index = record.turns.length - 1; index >= 0; index -= 1) {
    const turn = record.turns[index];
    if (turn.agentId === agentId && turn.nativeSessionId) return turn.nativeSessionId;
  }
  return null;
}

function readOnlySecurity(goal: Goal): GoalSecurityControls {
  return { authMode: goal.authMode, approvalPolicy: goal.approvalPolicy, mode: "read-only" };
}

function goalSecurity(goal: Goal): GoalSecurityControls {
  return { authMode: goal.authMode, approvalPolicy: goal.approvalPolicy, mode: goal.mode };
}

function isOperationalCandidateFailure(error: unknown) {
  if (!(error instanceof HeadlessError)) return false;
  return new Set([
    "BACKEND_UNAVAILABLE",
    "NATIVE_SESSION_LOST",
    "DAEMON_UNAVAILABLE",
    "RATE_LIMITED",
    "PROCESS_ERROR",
    "TIMED_OUT",
  ]).has(error.code);
}

function isPrematureWorkerCompletion(result: RunResult) {
  if (result.status !== "succeeded" || result.output.length > 512) return false;
  return /^(?:i(?:'ll| will|'m going to| am going to)|let me)\b/i.test(result.output.trim());
}

function isSubstantiveTimedOutWorker(result: RunResult) {
  return result.status === "timed_out"
    && result.output.trim().length >= 512
    && result.diagnostics.malformedEvents === 0;
}

function isAvailableNow(availability: GoalAgentAvailability, now: number) {
  return availability.authenticated
    && (availability.health === "healthy" || availability.health === "degraded")
    && (availability.rateLimitedUntil === null || availability.rateLimitedUntil <= now);
}

function rateLimitRecovery(result: RunResult) {
  if (result.error?.code !== "RATE_LIMITED") return null;
  const details = result.error.details ?? {};
  const rawDelay = typeof details.retryAfterMs === "number"
    ? details.retryAfterMs
    : typeof details.retryAfterSeconds === "number"
      ? details.retryAfterSeconds * 1_000
      : null;
  if (rawDelay === null || !Number.isSafeInteger(rawDelay) || rawDelay <= 0 || rawDelay > 86_400_000) return null;
  const evidence = typeof details.evidence === "string" && details.evidence.trim()
    ? details.evidence
    : result.error.message;
  return { retryAfterMs: rawDelay, evidence: bounded(evidence) };
}

function delegationEventText(event: GoalDelegationEvent) {
  const position = event.queuePosition === null ? "" : ` at queue position ${event.queuePosition}`;
  return bounded(`Delegation ${event.delegation.id} ${event.kind}${position}; attempt ${event.delegation.attempt}/${event.delegation.maxAttempts}.`);
}
