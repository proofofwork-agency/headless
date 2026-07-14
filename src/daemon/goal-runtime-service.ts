import { createHash } from "node:crypto";
import type { AgentProfile, ApprovalRequest, Goal } from "../contracts/collaboration";
import type { DurableSession, Job } from "../contracts/durable";
import type { ApprovalPolicy, AuthMode } from "../contracts/native";
import type { RunResult } from "../contracts/run";
import type { CandidateIntegrationService } from "../runtime/candidate-integration-service";
import { DelegationScheduler } from "../runtime/delegation-scheduler";
import type { DirectedMailbox } from "../runtime/directed-mailbox";
import type { FinalityStore } from "../runtime/finality-store";
import type { FleetProfileStore } from "../runtime/fleet-profile-store";
import {
  GoalCoordinatorService,
  type GoalAgentAvailability,
  type GoalSecurityControls,
  type GoalTurnRole,
} from "../runtime/goal-coordinator-service";
import type { GoalDelegationEvent } from "../runtime/goal-delegation-runtime";
import type { GoalRecord, GoalStore } from "../runtime/goal-store";
import { HeadlessError } from "../runtime/headless-error";
import { IdleAutonomyService, type IdleSuggestionLane } from "../runtime/idle-autonomy-service";
import { DeterministicIdleOpportunityDetector } from "../runtime/idle-opportunity-detector";
import type { OrchestrationStateStore } from "../runtime/orchestration-state";
import type { PersistentSessionStore } from "../runtime/persistent-sessions";
import type { ProjectStateOptions, ProjectStatePaths } from "../runtime/project-state";
import type { ProjectTrustStore } from "../runtime/project-trust-store";
import { redactAndTruncate } from "../runtime/redaction";
import { appendEvent, getOrCreateSession } from "../runtime/session";
import { runGitStrict } from "../runtime/git";
import { resolveBackendId } from "../backends/registry";
import type { AuthenticatedCredential } from "../runtime/credential-store";
import { GoalStartParamsSchema } from "./protocol";

export type GoalRuntimeSessionInput = {
  backend: string;
  model?: string;
  containment: "required";
  authMode: AuthMode;
  approvalPolicy: ApprovalPolicy;
};

export type GoalRuntimeSubmitOptions = {
  mergePolicy?: Job["mergePolicy"];
};

export type GoalRuntimeLoad = {
  activeJobs: number;
  queuedJobs: number;
};

export type GoalRuntimeServiceOptions = {
  paths: ProjectStatePaths;
  stateOptions?: ProjectStateOptions;
  coordinatorPrincipal: string;
  maxConcurrency: number;
  maxQueued: number;
  fleets: FleetProfileStore;
  goals: GoalStore;
  sessions: PersistentSessionStore;
  jobs: {
    get: (jobId: string) => Job | null;
  };
  finality: FinalityStore;
  candidates: CandidateIntegrationService;
  mailbox: DirectedMailbox;
  trust: ProjectTrustStore;
  orchestration: OrchestrationStateStore;
  availability: (agent: AgentProfile, security: GoalSecurityControls) => GoalAgentAvailability;
  activeLeadBackend?: () => string | null;
  createSession: (input: GoalRuntimeSessionInput, principal: string) => DurableSession;
  submitRun: (params: Record<string, unknown>, principal: string, options?: GoalRuntimeSubmitOptions) => Job;
  waitRun: (jobId: string, timeoutMs?: number) => Promise<Job>;
  cancelRun: (jobId: string) => unknown;
  isStopping: () => boolean;
  load: () => GoalRuntimeLoad;
  diagnostic?: (message: string, error?: unknown) => void;
  scanIntervalMs?: number;
};

/**
 * Daemon-owned goal and idle-autonomy control plane.
 *
 * Run admission, containment, worktree leasing, gates, and integration remain
 * authoritative in the injected daemon callbacks. This service owns only the
 * collaboration lifecycle, durable delegation scheduler, deterministic idle
 * scanner, and its bounded timer.
 */
export class GoalRuntimeService {
  readonly delegationScheduler: DelegationScheduler;
  readonly coordinator: GoalCoordinatorService;
  readonly idleAutonomy: IdleAutonomyService;
  private autonomyTimer: ReturnType<typeof setInterval> | null = null;
  private readonly scanIntervalMs: number;

  constructor(private readonly options: GoalRuntimeServiceOptions) {
    this.scanIntervalMs = Math.max(250, Math.min(options.scanIntervalMs ?? 1_000, 60_000));
    this.delegationScheduler = new DelegationScheduler({
      statePath: options.paths.delegationSchedulerPath,
      maxActive: options.maxConcurrency,
      maxQueued: options.maxQueued,
    });
    this.coordinator = new GoalCoordinatorService({
      fleets: options.fleets,
      goals: options.goals,
      mailbox: options.mailbox,
      availability: options.availability,
      activeLeadBackend: options.activeLeadBackend,
      executeTurn: ({ goal, agent, role, prompt, timeoutMs }) => this.executeGoalTurn(goal, agent, prompt, timeoutMs, role),
      integrateCandidate: (input) => this.integrateGoalCandidate(input),
      cancelJob: (jobId) => { options.cancelRun(jobId); },
      delegationScheduler: this.delegationScheduler,
      delegationEvent: (event) => this.recordDelegationEvent(event),
      diagnostic: (message, error) => this.diagnostic(message, error),
    });
    this.idleAutonomy = new IdleAutonomyService({
      goals: options.goals,
      fleets: options.fleets,
      detector: new DeterministicIdleOpportunityDetector({ statePath: options.paths.idleOpportunitiesPath }),
      publishLane: (lane) => this.publishIdleLane(lane),
      runReadOnlyVerification: (input) => this.runIdleReadOnlyVerification(input),
      getProjectTrust: () => options.trust.status(),
      inspectPrimary: () => this.inspectIdlePrimary(),
      runManagedWrite: (input) => this.runIdleManagedWrite(input),
    });
  }

  startGoal(raw: Record<string, unknown>, credential: AuthenticatedCredential) {
    if (this.options.isStopping()) {
      throw new HeadlessError("DAEMON_UNAVAILABLE", "Daemon is shutting down and cannot accept goals.", { retryable: true });
    }
    const params = GoalStartParamsSchema.parse(raw);
    return this.coordinator.start({
      principal: credential.principal,
      objective: params.objective,
      fleetProfileId: params.fleetProfileId,
      synthesizer: params.synthesizer,
      authMode: params.authMode,
      approvalPolicy: params.approvalPolicy,
      mode: params.mode,
      autonomous: params.autonomous,
      timeoutMs: params.timeoutMs,
    });
  }

  requireGoal(goalId: string): GoalRecord {
    const record = this.options.goals.get(goalId);
    if (!record) throw new HeadlessError("INVALID_REQUEST", `Unknown goal: ${goalId}`);
    return record;
  }

  cancelGoalAs(goalId: string, actor: string) {
    const record = this.requireGoal(goalId);
    return record.result ? record.goal : this.options.goals.cancel(goalId, actor);
  }

  handleApprovalResolution(approval: ApprovalRequest) {
    return this.coordinator.handleApprovalResolution(approval);
  }

  recover() {
    this.coordinator.recover();
    if (this.options.orchestration.get().enabled) this.startAutonomyTimer();
  }

  enableAutonomy() {
    this.options.orchestration.setEnabled(true);
    this.startAutonomyTimer();
    return this.autonomyStatus();
  }

  disableAutonomy() {
    this.options.orchestration.setEnabled(false);
    this.clearAutonomyTimer();
    return this.autonomyStatus();
  }

  autonomyStatus() {
    return { ...this.options.orchestration.get(), ...this.options.load() };
  }

  async scanAutonomy() {
    if (!this.options.orchestration.get().enabled) return null;
    return this.idleAutonomy.scan();
  }

  waitForIdle() {
    return this.coordinator.waitForIdle();
  }

  dispose() {
    this.clearAutonomyTimer();
    this.coordinator.dispose();
  }

  private startAutonomyTimer() {
    if (!this.autonomyTimer) {
      this.autonomyTimer = setInterval(() => { this.startAutonomyScan(); }, this.scanIntervalMs);
      this.autonomyTimer.unref?.();
    }
    this.startAutonomyScan();
  }

  private clearAutonomyTimer() {
    if (this.autonomyTimer) clearInterval(this.autonomyTimer);
    this.autonomyTimer = null;
  }

  private startAutonomyScan() {
    void this.scanAutonomy().catch((error) => {
      this.diagnostic("Idle autonomy scan failed.", error);
    });
  }

  private executeGoalTurn(
    goal: Goal,
    agent: AgentProfile,
    prompt: string,
    timeoutMs: number,
    role: GoalTurnRole,
  ) {
    const mode = goal.mode === "write" && (role === "candidate" || role === "revision") ? "write" : "read-only";
    const session = this.compatibleGoalSession(goal, agent) ?? this.options.createSession({
      backend: agent.backend,
      model: agent.model,
      containment: "required",
      authMode: goal.authMode,
      approvalPolicy: goal.approvalPolicy,
    }, goal.principal);
    this.options.sessions.append(session.id, "user", prompt);
    const job = this.options.submitRun({
      backend: session.backend,
      prompt,
      mode,
      model: session.model ?? undefined,
      timeoutMs,
      // Candidate/revision writes are deliberately one-shot. Persistent
      // sessions are read-only and their immutable security tuple must never
      // be repurposed to authorize a mutating turn.
      sessionId: mode === "read-only" ? session.id : undefined,
      containment: session.containment,
      authMode: session.authMode,
      approvalPolicy: session.approvalPolicy,
    }, goal.principal, { mergePolicy: mode === "write" ? "preserve" : "authorized" });
    this.options.sessions.start(session.id, job.id);
    const completion = this.options.waitRun(job.id, timeoutMs).then((completed) => {
      if (!completed.result) {
        throw new HeadlessError("INTERNAL_ERROR", `Goal turn job ${job.id} completed without a durable result.`);
      }
      this.options.sessions.complete(session.id, completed.result);
      if (mode === "write" && this.isGatedPreservedCandidate(job.id, completed.result)) {
        return { ...completed.result, status: "succeeded" as const, error: null };
      }
      return completed.result;
    });
    return { jobId: job.id, sessionId: session.id, completion };
  }

  private isGatedPreservedCandidate(jobId: string, result: RunResult) {
    if (!result.commit?.candidate || result.commit.merged || this.options.jobs.get(jobId)?.mergePolicy !== "preserve") return false;
    return this.options.finality.list().some((record) => record.decision.jobId === jobId
      && record.decision.allowed
      && record.decision.policyPassed
      && record.decision.testsPassed
      && record.decision.reviewPassed
      && record.decision.budgetPassed);
  }

  private async integrateGoalCandidate(input: {
    goal: Goal;
    candidateId: string;
    decisionId: string;
    signal: AbortSignal;
  }) {
    const record = this.requireGoal(input.goal.id);
    const collaborationDecision = record.candidateDecisions.find((decision) =>
      decision.id === input.decisionId && decision.candidateId === input.candidateId);
    if (!collaborationDecision || collaborationDecision.decision !== "integrate") {
      throw new HeadlessError("GATE_FAILED", `Candidate ${input.candidateId} lacks an attributable goal integration decision.`);
    }
    if (collaborationDecision.gates.some((gate) => gate.status === "failed" || gate.status === "pending")) {
      throw new HeadlessError("GATE_FAILED", `Candidate ${input.candidateId} has an incomplete collaboration gate.`);
    }
    const source = [...this.options.finality.list()].reverse().find((candidate) =>
      candidate.decision.jobId === input.candidateId
      && candidate.decision.allowed
      && candidate.decision.policyPassed
      && candidate.decision.testsPassed
      && candidate.decision.reviewPassed
      && candidate.decision.budgetPassed);
    if (!source) {
      throw new HeadlessError("GATE_FAILED", `Candidate ${input.candidateId} has no allowed write finality evidence.`);
    }
    const reviewStatus = collaborationDecision.gates.find((gate) => gate.id === "review-evidence")?.status;
    const voteStatus = collaborationDecision.gates.find((gate) => gate.id === "vote-evidence")?.status;
    const reviewPassed = reviewStatus === "passed" || reviewStatus === "not_required";
    const votePassed = voteStatus === "passed" || voteStatus === "not_required";
    const existingGoalFinality = [...this.options.finality.list()].reverse().find((candidate) =>
      candidate.decision.jobId === input.candidateId
      && candidate.requirements.vote
      && candidate.decision.allowed);
    if (!existingGoalFinality) {
      const decision = this.options.finality.evaluate({
        projectId: this.options.paths.projectId,
        jobId: input.candidateId,
        decidedBy: input.goal.principal,
        requirements: { policy: true, tests: true, review: true, vote: true, budget: true },
        gates: {
          policyPassed: source.decision.policyPassed,
          testsPassed: source.decision.testsPassed,
          reviewPassed: source.decision.reviewPassed && reviewPassed,
          votePassed,
          budgetPassed: source.decision.budgetPassed,
        },
      });
      if (!decision.allowed) throw new HeadlessError("GATE_FAILED", decision.reasons.join(" "));
    }
    const integration = await this.options.candidates.integrate(
      input.candidateId,
      { actor: input.goal.principal, admin: true },
      { signal: input.signal },
    );
    return {
      merged: integration.merged,
      resultingCommit: integration.resultingCommit,
      summary: integration.reason,
      artifactIds: [input.candidateId],
    };
  }

  private compatibleGoalSession(goal: Goal, agent: AgentProfile) {
    const backend = resolveBackendId(agent.backend);
    const turns = [...(this.options.goals.get(goal.id)?.turns ?? [])]
      .filter((turn) => turn.agentId === agent.id && turn.nativeSessionId !== null)
      .sort((left, right) => right.sequence - left.sequence);
    const seen = new Set<string>();
    for (const turn of turns) {
      const id = turn.nativeSessionId!;
      if (seen.has(id)) continue;
      seen.add(id);
      const session = this.options.sessions.get(id);
      if (!session || session.state === "running" || session.state === "cancelling") continue;
      if (
        session.principal === goal.principal
        && session.backend === backend
        && session.model === (agent.model ?? null)
        && session.containment === "required"
        && session.authMode === goal.authMode
        && session.approvalPolicy === goal.approvalPolicy
      ) return session;
    }
    return null;
  }

  private publishIdleLane(lane: IdleSuggestionLane) {
    const existing = this.options.mailbox.snapshot().messages.find((message) =>
      message.collaborationId === lane.goalId && message.artifactIds.includes(lane.id));
    if (!existing) {
      this.options.mailbox.send({
        collaborationId: lane.goalId,
        senderId: this.options.coordinatorPrincipal,
        recipientId: lane.recipientId,
        kind: "lifecycle",
        content: `${lane.title}\n${lane.detail}`,
        artifactIds: [lane.id],
      }, lane.createdAt);
    }
    const session = getOrCreateSession({
      cwd: this.options.paths.canonicalProjectRoot,
      state: this.options.stateOptions,
      authenticatedPrincipal: this.options.coordinatorPrincipal,
      sessionId: lane.goalId,
    });
    appendEvent(session, {
      type: "idle_opportunity",
      source: this.options.coordinatorPrincipal,
      content: `${lane.title}\n${lane.detail}`,
      meta: {
        laneId: lane.id,
        fleetProfileId: lane.fleetProfileId,
        recipientId: lane.recipientId,
        opportunity: lane.opportunity,
      },
    }, deterministicEventId(`idle-lane\0${lane.id}`));
    return { laneId: lane.id, durable: true as const };
  }

  private async runIdleReadOnlyVerification(
    input: Parameters<NonNullable<ConstructorParameters<typeof IdleAutonomyService>[0]["runReadOnlyVerification"]>>[0],
  ) {
    const record = this.requireGoal(input.goalId);
    const agent = this.idleAgent(record);
    if (!agent) {
      return { status: "failed" as const, summary: "No enabled fleet worker is available for idle verification.", tokensUsed: null, artifactIds: [] };
    }
    const remainingMs = record.goal.deadlineAt - Date.now();
    if (remainingMs <= 0) {
      return { status: "failed" as const, summary: "Goal deadline elapsed before idle verification.", tokensUsed: null, artifactIds: [] };
    }
    const timeoutMs = Math.min(input.limits.timeoutMs, remainingMs);
    const job = this.options.submitRun({
      backend: agent.backend,
      model: agent.model ?? undefined,
      prompt: [
        "Perform one read-only verification pass for this durable autonomous goal.",
        `Goal: ${record.goal.objective}`,
        `Opportunity: ${input.opportunity.kind} / ${input.opportunity.subjectId}`,
        input.opportunity.detail,
        "Return evidence and begin with exactly one marker: HEADLESS_IDLE_STATUS: verified, HEADLESS_IDLE_STATUS: needs-write, or HEADLESS_IDLE_STATUS: failed.",
      ].join("\n"),
      mode: "read-only",
      containment: "required",
      authMode: record.goal.authMode,
      approvalPolicy: record.goal.approvalPolicy,
      timeoutMs,
    }, record.goal.principal);
    const cancel = () => { this.options.cancelRun(job.id); };
    if (input.signal.aborted) cancel();
    else input.signal.addEventListener("abort", cancel, { once: true });
    try {
      const completed = await this.options.waitRun(job.id, timeoutMs);
      const result = completed.result;
      if (!result) {
        return { status: "failed" as const, summary: "Idle verification completed without a durable result.", tokensUsed: null, artifactIds: [] };
      }
      const marker = /HEADLESS_IDLE_STATUS:\s*(verified|needs-write|failed)/i.exec(result.output)?.[1]?.toLowerCase();
      const status = result.status !== "succeeded" ? "failed" as const
        : marker === "needs-write" ? "needs-write" as const
          : marker === "failed" ? "failed" as const : "verified" as const;
      return {
        status,
        summary: redactAndTruncate(result.output || result.error?.message || "Idle verification produced no output.", 16_384).text,
        tokensUsed: result.usage.providerTotal ?? sumKnownUsage(result.usage),
        artifactIds: [],
      };
    } finally {
      input.signal.removeEventListener("abort", cancel);
    }
  }

  private inspectIdlePrimary() {
    const status = runGitStrict(["status", "--porcelain=v1", "--untracked-files=all"], this.options.paths.canonicalProjectRoot);
    if (!status.ok) {
      throw new HeadlessError(
        "GATE_FAILED",
        `Primary checkout state could not be verified: ${redactAndTruncate(status.stderr || status.stdout || "git status failed", 2_048).text}`,
      );
    }
    const detail = status.stdout.trim();
    return {
      dirty: detail.length > 0,
      evidence: detail
        ? `Primary checkout has user changes: ${redactAndTruncate(detail, 2_048).text}`
        : "Primary checkout is clean and verified by git status.",
    };
  }

  private async runIdleManagedWrite(
    input: Parameters<NonNullable<ConstructorParameters<typeof IdleAutonomyService>[0]["runManagedWrite"]>>[0],
  ) {
    const record = this.requireGoal(input.goalId);
    const agent = this.idleAgent(record);
    if (!agent) {
      return { status: "blocked" as const, summary: "No enabled fleet worker is available for the idle write.", tokensUsed: null, artifactIds: [] };
    }
    const remainingMs = record.goal.deadlineAt - Date.now();
    if (record.goal.state !== "active" || !record.goal.autonomous || remainingMs <= 0) {
      return { status: "blocked" as const, summary: "The autonomous goal is no longer active within its deadline.", tokensUsed: null, artifactIds: [] };
    }
    const timeoutMs = Math.min(input.limits.timeoutMs, remainingMs);
    const job = this.options.submitRun({
      backend: agent.backend,
      model: agent.model ?? undefined,
      prompt: [
        "Apply the smallest contained write that resolves this verified idle opportunity for the durable autonomous goal.",
        `Goal: ${record.goal.objective}`,
        `Opportunity: ${input.opportunity.kind} / ${input.opportunity.subjectId}`,
        input.opportunity.detail,
        `Read-only verification: ${input.verification.summary}`,
        "Work only in the daemon-provided candidate worktree. Run relevant checks and return concrete evidence.",
      ].join("\n"),
      mode: "write",
      containment: "required",
      authMode: record.goal.authMode,
      approvalPolicy: record.goal.approvalPolicy,
      timeoutMs,
    }, record.goal.principal, { mergePolicy: "authorized" });
    const cancel = () => { this.options.cancelRun(job.id); };
    if (input.signal.aborted) cancel();
    else input.signal.addEventListener("abort", cancel, { once: true });
    try {
      const completed = await this.options.waitRun(job.id, timeoutMs);
      const result = completed.result;
      if (!result) {
        return { status: "failed" as const, summary: "Idle write completed without a durable result.", tokensUsed: null, artifactIds: [job.id] };
      }
      const applied = result.status === "succeeded" && result.commit?.merged === true;
      const blocked = result.status === "blocked" || (result.status === "succeeded" && !applied);
      return {
        status: applied ? "applied" as const : blocked ? "blocked" as const : "failed" as const,
        summary: redactAndTruncate(
          result.output || result.error?.message || (applied ? "Idle write passed all gates and was integrated." : "Idle write did not integrate."),
          16_384,
        ).text,
        tokensUsed: result.usage.providerTotal ?? sumKnownUsage(result.usage),
        artifactIds: [job.id],
      };
    } finally {
      input.signal.removeEventListener("abort", cancel);
    }
  }

  private idleAgent(record: GoalRecord) {
    const profile = this.options.fleets.get(record.goal.fleetProfileId);
    return profile?.agents.find((candidate) => candidate.id === record.goal.synthesizerAgentId && candidate.enabled)
      ?? profile?.agents.find((candidate) => candidate.enabled)
      ?? null;
  }

  private recordDelegationEvent(event: GoalDelegationEvent) {
    const session = getOrCreateSession({
      cwd: this.options.paths.canonicalProjectRoot,
      state: this.options.stateOptions,
      authenticatedPrincipal: this.options.coordinatorPrincipal,
      sessionId: event.delegation.goalId,
    });
    appendEvent(session, {
      type: "coordination_checkpoint",
      source: event.delegation.fromAgentId,
      content: `Delegation ${event.delegation.id} is ${event.kind}.`,
      checkpoint: { summary: `queuePosition=${event.queuePosition ?? "none"}; attempt=${event.delegation.attempt}` },
      meta: { kind: event.kind, delegation: event.delegation, queuePosition: event.queuePosition },
    }, deterministicEventId([
      "delegation",
      event.delegation.id,
      event.kind,
      event.delegation.state,
      String(event.delegation.attempt),
      String(event.queuePosition ?? "none"),
    ].join("\0")));
  }

  private diagnostic(message: string, error?: unknown) {
    if (this.options.diagnostic) {
      this.options.diagnostic(message, error);
      return;
    }
    const detail = error === undefined ? message : `${message} ${messageOf(error)}`;
    console.error(redactAndTruncate(detail, 2_048).text);
  }
}

function deterministicEventId(seed: string) {
  const bytes = Buffer.from(createHash("sha256").update(`headless-daemon-event\0${seed}`).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sumKnownUsage(usage: RunResult["usage"]) {
  const values = [usage.input, usage.output, usage.reasoning].filter((value): value is number => value !== null);
  return values.length === 0 ? null : values.reduce((total, value) => total + value, 0);
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
