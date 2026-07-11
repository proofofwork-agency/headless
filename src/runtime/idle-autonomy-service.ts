import { isAbsolute } from "node:path";
import { z } from "zod";
import type { FleetProfile, Goal } from "../contracts/collaboration";
import { ProjectTrustSchema, type ProjectTrust } from "../contracts/native";
import type { FleetProfileStore } from "./fleet-profile-store";
import type { GoalRecord, GoalStore } from "./goal-store";
import {
  DEFAULT_IDLE_WORKER_MS,
  DEFAULT_STALLED_WORK_MS,
  DeterministicIdleOpportunityDetector,
  type IdleOpportunity,
  type IdleOpportunityScanInput,
} from "./idle-opportunity-detector";
import { recordRuntimeDiagnostic } from "./diagnostics";
import { redactAndTruncate } from "./redaction";

export const DEFAULT_IDLE_VERIFICATION_TIMEOUT_MS = 30_000;
export const DEFAULT_IDLE_WRITE_TIMEOUT_MS = 120_000;
export const DEFAULT_IDLE_TOKEN_LIMIT = 20_000;
export const DEFAULT_IDLE_VERIFICATION_REQUEST_LIMIT = 4;
export const DEFAULT_IDLE_WRITE_REQUEST_LIMIT = 1;

const VerificationLimitsSchema = z.object({
  timeoutMs: z.number().int().positive().max(120_000),
  tokenLimit: z.number().int().positive().max(1_000_000),
  requestLimit: z.literal(1),
}).strict();

const VerificationResultSchema = z.object({
  status: z.enum(["verified", "needs-write", "failed"]),
  summary: z.string().min(1).max(16_384),
  tokensUsed: z.number().int().nonnegative().nullable().default(null),
  artifactIds: z.array(z.string().min(1).max(160)).max(64).default([]),
}).strict();

const WriteAuthorizationSchema = z.object({
  allowed: z.boolean(),
  gatesPassed: z.boolean(),
  reason: z.string().min(1).max(4_096),
}).strict();

const PrimaryInspectionSchema = z.object({
  dirty: z.boolean(),
  evidence: z.string().min(1).max(4_096),
}).strict();

const LanePublicationSchema = z.object({
  laneId: z.string().min(1).max(160),
  durable: z.literal(true),
}).strict();

const WriteResultSchema = z.object({
  status: z.enum(["applied", "blocked", "failed"]),
  summary: z.string().min(1).max(16_384),
  tokensUsed: z.number().int().nonnegative().nullable().default(null),
  artifactIds: z.array(z.string().min(1).max(160)).max(64).default([]),
}).strict();

export type IdleVerificationLimits = z.infer<typeof VerificationLimitsSchema>;
export type IdleVerificationResult = z.infer<typeof VerificationResultSchema>;
export type IdleWriteAuthorization = z.infer<typeof WriteAuthorizationSchema>;
export type IdlePrimaryInspection = z.infer<typeof PrimaryInspectionSchema>;
export type IdleWriteResult = z.infer<typeof WriteResultSchema>;

export type IdleAutonomyEvidence = Pick<
  IdleOpportunityScanInput,
  "failedGates" | "completions" | "workItems" | "candidates" | "workers"
> & {
  quiescentSince?: number;
  stalledWorkMs?: number;
  idleWorkerMs?: number;
};

export type IdleSuggestionLane = {
  id: string;
  kind: "suggest";
  goalId: string;
  fleetProfileId: string;
  recipientId: string;
  title: string;
  detail: string;
  opportunity: IdleOpportunity;
  createdAt: number;
};

export type IdleWorktreeLease = {
  id: string;
  token: string;
  worktreePath: string;
  release: (input: {
    outcome: "completed" | "blocked" | "failed" | "skipped_dirty_primary";
    evidence: string[];
  }) => void | Promise<void>;
};

export type IdleAutonomyAction = {
  goalId: string;
  profileId: string;
  laneId: string;
  opportunity: IdleOpportunity;
  outcome: "suggested" | "verified" | "written" | "blocked" | "failed";
  detail: string;
};

export type IdleAutonomyScanReport = {
  startedAt: number;
  completedAt: number;
  scannedGoals: number;
  eligibleGoals: number;
  opportunities: number;
  actions: IdleAutonomyAction[];
  errors: string[];
};

export type IdleAutonomyServiceOptions = {
  goals: GoalStore;
  fleets: FleetProfileStore;
  detector: DeterministicIdleOpportunityDetector;
  publishLane: (lane: IdleSuggestionLane) => Promise<{ laneId: string; durable: true }> | { laneId: string; durable: true };
  collectEvidence?: (input: { goal: Goal; record: GoalRecord; profile: FleetProfile; now: number }) => IdleAutonomyEvidence | Promise<IdleAutonomyEvidence>;
  runReadOnlyVerification?: (input: {
    goalId: string;
    profileId: string;
    opportunity: IdleOpportunity;
    limits: IdleVerificationLimits;
    signal: AbortSignal;
  }) => IdleVerificationResult | Promise<IdleVerificationResult>;
  getProjectTrust?: () => ProjectTrust | Promise<ProjectTrust>;
  authorizeWrite?: (input: {
    goalId: string;
    profileId: string;
    opportunity: IdleOpportunity;
    verification: IdleVerificationResult;
  }) => IdleWriteAuthorization | Promise<IdleWriteAuthorization>;
  inspectPrimary?: () => IdlePrimaryInspection | Promise<IdlePrimaryInspection>;
  acquireWorktreeLease?: (input: {
    goalId: string;
    profileId: string;
    opportunity: IdleOpportunity;
  }) => IdleWorktreeLease | null | Promise<IdleWorktreeLease | null>;
  validateWorktreeLease?: (lease: {
    id: string;
    token: string;
    worktreePath: string;
  }) => boolean | Promise<boolean>;
  runWrite?: (input: {
    goalId: string;
    profileId: string;
    opportunity: IdleOpportunity;
    lease: { id: string; token: string; worktreePath: string };
    limits: IdleVerificationLimits;
    signal: AbortSignal;
  }) => IdleWriteResult | Promise<IdleWriteResult>;
  /**
   * Submit an idle write through the daemon's ordinary contained write path.
   * The callback remains authoritative for worktree leasing, repeated trust
   * and clean-primary checks, budgets, gates, approval handling, and
   * integration. It intentionally receives no filesystem path or lease
   * capability from the idle policy engine.
   */
  runManagedWrite?: (input: {
    goalId: string;
    profileId: string;
    opportunity: IdleOpportunity;
    verification: IdleVerificationResult;
    limits: IdleVerificationLimits;
    signal: AbortSignal;
  }) => IdleWriteResult | Promise<IdleWriteResult>;
  now?: () => number;
  verificationTimeoutMs?: number;
  writeTimeoutMs?: number;
  tokenLimit?: number;
  maxVerificationRequests?: number;
  maxWriteRequests?: number;
};

type ScanBudget = {
  verificationRequests: number;
  writeRequests: number;
  tokensUsed: number;
};

/**
 * Deterministic, daemon-agnostic idle policy engine. It never receives a
 * primary checkout path or integration callback; write callbacks can touch
 * only the explicitly leased worktree supplied to them.
 */
export class IdleAutonomyService {
  private readonly goals: GoalStore;
  private readonly fleets: FleetProfileStore;
  private readonly detector: DeterministicIdleOpportunityDetector;
  private readonly now: () => number;
  private readonly verificationLimits: IdleVerificationLimits;
  private readonly writeLimits: IdleVerificationLimits;
  private readonly maxVerificationRequests: number;
  private readonly maxWriteRequests: number;
  private activeScan: Promise<IdleAutonomyScanReport> | null = null;

  constructor(private readonly options: IdleAutonomyServiceOptions) {
    this.goals = options.goals;
    this.fleets = options.fleets;
    this.detector = options.detector;
    this.now = options.now ?? Date.now;
    this.verificationLimits = VerificationLimitsSchema.parse({
      timeoutMs: options.verificationTimeoutMs ?? DEFAULT_IDLE_VERIFICATION_TIMEOUT_MS,
      tokenLimit: options.tokenLimit ?? DEFAULT_IDLE_TOKEN_LIMIT,
      requestLimit: 1,
    });
    this.writeLimits = VerificationLimitsSchema.parse({
      timeoutMs: options.writeTimeoutMs ?? DEFAULT_IDLE_WRITE_TIMEOUT_MS,
      tokenLimit: options.tokenLimit ?? DEFAULT_IDLE_TOKEN_LIMIT,
      requestLimit: 1,
    });
    this.maxVerificationRequests = boundedRequestLimit(options.maxVerificationRequests ?? DEFAULT_IDLE_VERIFICATION_REQUEST_LIMIT, 64);
    this.maxWriteRequests = boundedRequestLimit(options.maxWriteRequests ?? DEFAULT_IDLE_WRITE_REQUEST_LIMIT, 8);
  }

  /** Concurrent callers share one scan so no opportunity is double-executed. */
  scan() {
    if (this.activeScan) return this.activeScan;
    const scan = this.performScan();
    this.activeScan = scan;
    const clear = () => { if (this.activeScan === scan) this.activeScan = null; };
    void scan.then(clear, clear);
    return scan;
  }

  private async performScan(): Promise<IdleAutonomyScanReport> {
    const startedAt = this.now();
    const records = this.goals.listRecords();
    const report: IdleAutonomyScanReport = {
      startedAt,
      completedAt: startedAt,
      scannedGoals: records.length,
      eligibleGoals: 0,
      opportunities: 0,
      actions: [],
      errors: [],
    };
    const budget: ScanBudget = { verificationRequests: 0, writeRequests: 0, tokensUsed: 0 };

    for (const record of records) {
      const goal = record.goal;
      if (goal.state !== "active" || !goal.autonomous) continue;
      const profile = this.fleets.get(goal.fleetProfileId);
      if (!profile) {
        this.error(report, `Active autonomous goal ${goal.id} references missing fleet profile ${goal.fleetProfileId}.`);
        continue;
      }
      if (profile.idleAutonomy === "off") continue;
      if (startedAt >= goal.deadlineAt) continue;
      report.eligibleGoals += 1;
      const now = this.now();
      let evidence = deriveIdleAutonomyEvidence(record, profile);
      if (this.options.collectEvidence) {
        try {
          evidence = mergeEvidence(evidence, await this.options.collectEvidence({ goal, record, profile, now }));
        } catch (error) {
          this.error(report, `Idle evidence collection failed for ${goal.id}: ${errorMessage(error)}`, error);
          continue;
        }
      }
      let opportunities: IdleOpportunity[];
      try {
        opportunities = this.detector.preview({
          now,
          quiescentSince: Math.max(goal.updatedAt, evidence.quiescentSince ?? goal.updatedAt),
          goal: { id: goal.id, state: "active", autonomous: true },
          failedGates: evidence.failedGates,
          completions: evidence.completions,
          workItems: evidence.workItems,
          candidates: evidence.candidates,
          workers: evidence.workers,
          stalledWorkMs: Math.max(DEFAULT_STALLED_WORK_MS, evidence.stalledWorkMs ?? DEFAULT_STALLED_WORK_MS),
          idleWorkerMs: Math.max(DEFAULT_IDLE_WORKER_MS, evidence.idleWorkerMs ?? DEFAULT_IDLE_WORKER_MS),
        });
      } catch (error) {
        this.error(report, `Idle opportunity detection failed for ${goal.id}: ${errorMessage(error)}`, error);
        continue;
      }
      report.opportunities += opportunities.length;
      for (const opportunity of opportunities) {
        await this.handleOpportunity(report, budget, goal, profile, opportunity);
      }
    }
    report.completedAt = this.now();
    return report;
  }

  private async handleOpportunity(
    report: IdleAutonomyScanReport,
    budget: ScanBudget,
    goal: Goal,
    profile: FleetProfile,
    opportunity: IdleOpportunity,
  ) {
    const lane = suggestionLane(goal, profile, opportunity, this.now());
    try {
      const publication = LanePublicationSchema.parse(await this.options.publishLane(lane));
      if (publication.laneId !== lane.id) throw new Error(`Lane publisher returned ${publication.laneId}, expected ${lane.id}.`);
    } catch (error) {
      this.error(report, `Idle lane ${lane.id} was not durably published: ${errorMessage(error)}`, error);
      report.actions.push(action(goal, profile, lane, opportunity, "failed", "Visible lane publication failed; fingerprint remains retryable."));
      return;
    }

    // Publication is durable and idempotent before dedupe is committed. A
    // crash between these steps safely republishes the same deterministic id.
    this.detector.remember([opportunity.fingerprint], opportunity.detectedAt);
    if (profile.idleAutonomy === "suggest" || opportunity.kind === "idle_worker" || !this.options.runReadOnlyVerification) {
      report.actions.push(action(goal, profile, lane, opportunity, "suggested", opportunity.detail));
      return;
    }

    const remainingTokens = this.verificationLimits.tokenLimit - budget.tokensUsed;
    if (budget.verificationRequests >= this.maxVerificationRequests || remainingTokens <= 0) {
      report.actions.push(action(goal, profile, lane, opportunity, "suggested", "Visible lane created; automatic verification scan budget is exhausted."));
      return;
    }

    let verification: IdleVerificationResult;
    try {
      budget.verificationRequests += 1;
      const limits = { ...this.verificationLimits, tokenLimit: remainingTokens };
      verification = VerificationResultSchema.parse(await boundedCallback(
        limits.timeoutMs,
        (signal) => this.options.runReadOnlyVerification!({
          goalId: goal.id,
          profileId: profile.id,
          opportunity,
          limits,
          signal,
        }),
        "Idle read-only verification timed out.",
      ));
      if (verification.tokensUsed !== null && verification.tokensUsed > limits.tokenLimit) {
        throw new Error(`Idle verification exceeded its ${limits.tokenLimit}-token limit.`);
      }
      budget.tokensUsed += verification.tokensUsed ?? limits.tokenLimit;
    } catch (error) {
      this.error(report, `Idle verification failed for ${opportunity.fingerprint}: ${errorMessage(error)}`, error);
      report.actions.push(action(goal, profile, lane, opportunity, "failed", `Read-only verification failed: ${errorMessage(error)}`));
      return;
    }

    if (verification.status !== "needs-write" || profile.idleAutonomy !== "write") {
      const outcome = verification.status === "failed"
        ? "failed"
        : verification.status === "needs-write"
          ? "blocked"
          : "verified";
      report.actions.push(action(goal, profile, lane, opportunity, outcome, verification.summary));
      return;
    }

    const write = await this.maybeWrite(report, budget, goal, profile, opportunity, verification, lane);
    report.actions.push(write);
  }

  private async maybeWrite(
    report: IdleAutonomyScanReport,
    budget: ScanBudget,
    goal: Goal,
    profile: FleetProfile,
    opportunity: IdleOpportunity,
    verification: IdleVerificationResult,
    lane: IdleSuggestionLane,
  ): Promise<IdleAutonomyAction> {
    const currentGoal = this.currentEligibleGoal(goal.id);
    if (!currentGoal) {
      return action(goal, profile, lane, opportunity, "blocked", "Idle write was skipped because the goal is no longer active and autonomous.");
    }
    if (this.now() >= currentGoal.deadlineAt) {
      return action(goal, profile, lane, opportunity, "blocked", "Idle write was skipped because the goal deadline elapsed.");
    }
    if (!["auto", "bypass"].includes(currentGoal.approvalPolicy)) {
      return action(goal, profile, lane, opportunity, "blocked", "Idle write requires an auto or bypass goal approval policy.");
    }
    const hasManagedWrite = this.options.runManagedWrite !== undefined;
    const hasManualWrite = this.options.authorizeWrite !== undefined
      && this.options.acquireWorktreeLease !== undefined
      && this.options.validateWorktreeLease !== undefined
      && this.options.runWrite !== undefined;
    if (!this.options.getProjectTrust || !this.options.inspectPrimary || (!hasManagedWrite && !hasManualWrite)) {
      return action(goal, profile, lane, opportunity, "blocked", "Idle write callbacks are not fully configured.");
    }
    if (budget.writeRequests >= this.maxWriteRequests || budget.tokensUsed >= this.writeLimits.tokenLimit) {
      return action(goal, profile, lane, opportunity, "blocked", "Idle write scan budget is exhausted.");
    }

    try {
      const trust = ProjectTrustSchema.parse(await this.options.getProjectTrust());
      if (!trust.trusted) return action(goal, profile, lane, opportunity, "blocked", "Project trust is required for idle writes.");
      if (currentGoal.authMode === "native-login" && !trust.nativeLoginAllowed) {
        return action(goal, profile, lane, opportunity, "blocked", "Project trust does not allow native login for this idle goal.");
      }
      if (currentGoal.approvalPolicy === "bypass" && !trust.bypassAllowed) {
        return action(goal, profile, lane, opportunity, "blocked", "Project trust does not allow approval bypass.");
      }

      if (hasManagedWrite) {
        const beforeRun = PrimaryInspectionSchema.parse(await this.options.inspectPrimary());
        if (beforeRun.dirty) {
          return action(goal, profile, lane, opportunity, "blocked", `Primary checkout is dirty; no write was started. ${beforeRun.evidence}`);
        }
        const recheckedGoal = this.currentEligibleGoal(goal.id);
        if (!recheckedGoal) {
          return action(goal, profile, lane, opportunity, "blocked", "Idle write was skipped because the goal is no longer active and autonomous.");
        }
        if (this.now() >= recheckedGoal.deadlineAt) {
          return action(goal, profile, lane, opportunity, "blocked", "Idle write was skipped because the goal deadline elapsed.");
        }
        budget.writeRequests += 1;
        return await this.runDaemonManagedWrite(report, budget, recheckedGoal, profile, opportunity, verification, lane);
      }

      const authorization = WriteAuthorizationSchema.parse(await this.options.authorizeWrite!({
        goalId: currentGoal.id,
        profileId: profile.id,
        opportunity,
        verification,
      }));
      if (!authorization.allowed || !authorization.gatesPassed) {
        return action(goal, profile, lane, opportunity, "blocked", authorization.reason);
      }
      const beforeLease = PrimaryInspectionSchema.parse(await this.options.inspectPrimary());
      if (beforeLease.dirty) {
        return action(goal, profile, lane, opportunity, "blocked", `Primary checkout is dirty; no write was started. ${beforeLease.evidence}`);
      }
      const lease = await this.options.acquireWorktreeLease!({ goalId: currentGoal.id, profileId: profile.id, opportunity });
      if (!lease) return action(goal, profile, lane, opportunity, "blocked", "No isolated worktree lease was available.");
      validateLease(lease);
      if (!await this.options.validateWorktreeLease!({ id: lease.id, token: lease.token, worktreePath: lease.worktreePath })) {
        throw new Error("Idle worktree lease failed daemon authority validation.");
      }
      budget.writeRequests += 1;
      return await this.runLeasedWrite(report, budget, currentGoal, profile, opportunity, lane, lease);
    } catch (error) {
      this.error(report, `Idle write setup failed for ${opportunity.fingerprint}: ${errorMessage(error)}`, error);
      return action(goal, profile, lane, opportunity, "failed", `Idle write setup failed: ${errorMessage(error)}`);
    }
  }

  private async runDaemonManagedWrite(
    report: IdleAutonomyScanReport,
    budget: ScanBudget,
    goal: Goal,
    profile: FleetProfile,
    opportunity: IdleOpportunity,
    verification: IdleVerificationResult,
    lane: IdleSuggestionLane,
  ): Promise<IdleAutonomyAction> {
    try {
      const limits = this.remainingWriteLimits(goal, budget);
      const result = WriteResultSchema.parse(await boundedCallback(
        limits.timeoutMs,
        (signal) => this.options.runManagedWrite!({
          goalId: goal.id,
          profileId: profile.id,
          opportunity,
          verification,
          limits,
          signal,
        }),
        limits.timeoutMs < this.writeLimits.timeoutMs
          ? "Idle daemon-managed write exceeded the goal deadline."
          : "Idle daemon-managed write timed out.",
      ));
      if (result.tokensUsed !== null && result.tokensUsed > limits.tokenLimit) {
        throw new Error(`Idle write exceeded its ${limits.tokenLimit}-token limit.`);
      }
      budget.tokensUsed += result.tokensUsed ?? limits.tokenLimit;
      return action(
        goal,
        profile,
        lane,
        opportunity,
        result.status === "applied" ? "written" : result.status === "blocked" ? "blocked" : "failed",
        result.summary,
      );
    } catch (error) {
      this.error(report, `Idle daemon-managed write failed for ${opportunity.fingerprint}: ${errorMessage(error)}`, error);
      return action(goal, profile, lane, opportunity, "failed", `Idle daemon-managed write failed: ${errorMessage(error)}`);
    }
  }

  private async runLeasedWrite(
    report: IdleAutonomyScanReport,
    budget: ScanBudget,
    goal: Goal,
    profile: FleetProfile,
    opportunity: IdleOpportunity,
    lane: IdleSuggestionLane,
    lease: IdleWorktreeLease,
  ): Promise<IdleAutonomyAction> {
    let outcome: Parameters<IdleWorktreeLease["release"]>[0]["outcome"] = "failed";
    const evidence: string[] = [];
    let resultAction: IdleAutonomyAction;
    let releaseAfterSettlement: Promise<void> | null = null;
    try {
      const afterLease = PrimaryInspectionSchema.parse(await this.options.inspectPrimary!());
      if (afterLease.dirty) {
        outcome = "skipped_dirty_primary";
        evidence.push(afterLease.evidence);
        resultAction = action(goal, profile, lane, opportunity, "blocked", `Primary checkout became dirty; leased write was skipped. ${afterLease.evidence}`);
      } else {
        const limits = this.remainingWriteLimits(goal, budget);
        const result = WriteResultSchema.parse(await boundedCallback(
          limits.timeoutMs,
          (signal) => this.options.runWrite!({
            goalId: goal.id,
            profileId: profile.id,
            opportunity,
            lease: { id: lease.id, token: lease.token, worktreePath: lease.worktreePath },
            limits,
            signal,
          }),
          limits.timeoutMs < this.writeLimits.timeoutMs
            ? "Idle leased write exceeded the goal deadline."
            : "Idle leased write timed out.",
        ));
        if (result.tokensUsed !== null && result.tokensUsed > limits.tokenLimit) {
          throw new Error(`Idle write exceeded its ${limits.tokenLimit}-token limit.`);
        }
        budget.tokensUsed += result.tokensUsed ?? limits.tokenLimit;
        outcome = result.status === "applied" ? "completed" : result.status;
        evidence.push(result.summary, ...result.artifactIds);
        resultAction = action(
          goal,
          profile,
          lane,
          opportunity,
          result.status === "applied" ? "written" : result.status === "blocked" ? "blocked" : "failed",
          result.summary,
        );
      }
    } catch (error) {
      evidence.push(errorMessage(error));
      if (error instanceof BoundedCallbackTimeoutError) releaseAfterSettlement = error.settled;
      this.error(report, `Idle leased write failed for ${opportunity.fingerprint}: ${errorMessage(error)}`, error);
      resultAction = action(goal, profile, lane, opportunity, "failed", `Idle leased write failed: ${errorMessage(error)}`);
    } finally {
      const release = async () => lease.release({ outcome, evidence: evidence.slice(0, 64) });
      if (releaseAfterSettlement) {
        void releaseAfterSettlement.then(release).catch((error) => {
          recordRuntimeDiagnostic("state", "idle-autonomy.deferred-lease-release", error);
        });
      } else {
        try {
          await release();
        } catch (error) {
          this.error(report, `Idle worktree lease ${lease.id} release failed: ${errorMessage(error)}`, error);
          resultAction = action(goal, profile, lane, opportunity, "failed", `Worktree lease release failed: ${errorMessage(error)}`);
        }
      }
    }
    return resultAction!;
  }

  private currentEligibleGoal(goalId: string) {
    const current = this.goals.get(goalId)?.goal;
    return current?.state === "active" && current.autonomous ? current : null;
  }

  private remainingWriteLimits(goal: Goal, budget: ScanBudget): IdleVerificationLimits {
    const remainingMs = goal.deadlineAt - this.now();
    if (remainingMs <= 0) throw new Error("Idle write was skipped because the goal deadline elapsed.");
    const tokenLimit = this.writeLimits.tokenLimit - budget.tokensUsed;
    if (tokenLimit <= 0) throw new Error("Idle write scan token budget is exhausted.");
    return {
      ...this.writeLimits,
      timeoutMs: Math.min(this.writeLimits.timeoutMs, remainingMs),
      tokenLimit,
    };
  }

  private error(report: IdleAutonomyScanReport, message: string, error: unknown = message) {
    report.errors.push(safeText(message, 4_096));
    recordRuntimeDiagnostic("state", "idle-autonomy", error);
  }
}

export function deriveIdleAutonomyEvidence(record: GoalRecord, profile: FleetProfile): IdleAutonomyEvidence {
  const decisions = [...record.candidateDecisions].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  const failedGates = decisions.flatMap((decision, decisionIndex) => decision.gates
    .filter((gate) => gate.status === "failed")
    .map((gate) => ({
      id: gate.id,
      failedAt: decision.createdAt,
      followedUpAt: decisions.slice(decisionIndex + 1)
        .find((later) => later.gates.some((candidate) => candidate.id === gate.id))?.createdAt ?? null,
    })));

  const verificationTimes = new Map<string, number>();
  for (const item of [...record.reviews, ...record.votes, ...record.candidateDecisions]) {
    for (const turnId of item.citedTurnIds) {
      verificationTimes.set(turnId, Math.max(verificationTimes.get(turnId) ?? 0, item.createdAt));
    }
  }
  const completions = record.turns
    .filter((turn) => turn.state === "succeeded" && turn.completedAt !== null)
    .map((turn) => ({ id: turn.id, completedAt: turn.completedAt!, verifiedAt: verificationTimes.get(turn.id) ?? null }));

  const workItems = record.delegations.map((delegation) => ({
    id: delegation.id,
    state: delegation.state === "queued"
      ? "queued" as const
      : delegation.state === "active"
        ? "active" as const
        : "terminal" as const,
    lastProgressAt: delegation.updatedAt,
  }));

  const candidateUpdates = new Map<string, number>();
  for (const entry of [...record.reviews, ...record.votes]) {
    candidateUpdates.set(entry.candidateId, Math.max(candidateUpdates.get(entry.candidateId) ?? 0, entry.createdAt));
  }
  for (const decision of decisions) {
    candidateUpdates.set(decision.candidateId, Math.max(candidateUpdates.get(decision.candidateId) ?? 0, decision.createdAt));
  }
  const candidates = [...candidateUpdates].map(([id, updatedAt]) => {
    const decision = [...decisions].reverse().find((entry) => entry.candidateId === id);
    const reviewed = record.reviews.some((review) => review.candidateId === id);
    return {
      id,
      state: decision ? decision.decision === "integrate" ? "integrated" as const : "rejected" as const : reviewed ? "reviewing" as const : "pending" as const,
      updatedAt,
      decisionAt: decision?.createdAt ?? null,
    };
  });

  const workers = profile.agents.map((agent) => {
    const turns = record.turns.filter((turn) => turn.agentId === agent.id);
    const delegations = record.delegations.filter((delegation) => delegation.toAgentId === agent.id);
    const busy = turns.some((turn) => ["queued", "running", "waiting"].includes(turn.state))
      || delegations.some((delegation) => ["queued", "active"].includes(delegation.state));
    const lastActiveAt = Math.max(
      record.goal.createdAt,
      ...turns.map((turn) => turn.updatedAt),
      ...delegations.map((delegation) => delegation.updatedAt),
    );
    return { id: agent.id, state: !agent.enabled ? "offline" as const : busy ? "busy" as const : "idle" as const, lastActiveAt };
  });

  return {
    failedGates,
    completions,
    workItems,
    candidates,
    workers,
    quiescentSince: record.goal.updatedAt,
  };
}

function mergeEvidence(base: IdleAutonomyEvidence, extra: IdleAutonomyEvidence): IdleAutonomyEvidence {
  return {
    failedGates: mergeById(base.failedGates, extra.failedGates),
    completions: mergeById(base.completions, extra.completions),
    workItems: mergeById(base.workItems, extra.workItems),
    candidates: mergeById(base.candidates, extra.candidates),
    workers: mergeById(base.workers, extra.workers),
    quiescentSince: extra.quiescentSince ?? base.quiescentSince,
    stalledWorkMs: extra.stalledWorkMs ?? base.stalledWorkMs,
    idleWorkerMs: extra.idleWorkerMs ?? base.idleWorkerMs,
  };
}

function mergeById<T extends { id: string }>(base: T[], extra: T[]) {
  const values = new Map(base.map((entry) => [entry.id, entry]));
  for (const entry of extra) values.set(entry.id, entry);
  return [...values.values()];
}

function suggestionLane(goal: Goal, profile: FleetProfile, opportunity: IdleOpportunity, now: number): IdleSuggestionLane {
  return {
    id: `idle_${opportunity.fingerprint.slice(0, 48)}`,
    kind: "suggest",
    goalId: goal.id,
    fleetProfileId: profile.id,
    recipientId: goal.leaderAgentId ?? "coordinator",
    title: idleTitle(opportunity),
    detail: opportunity.detail,
    opportunity,
    createdAt: now,
  };
}

function idleTitle(opportunity: IdleOpportunity) {
  const titles: Record<IdleOpportunity["kind"], string> = {
    failed_gate_without_follow_up: "Follow up failed gate",
    unverified_completion: "Verify reported completion",
    stalled_work: "Inspect stalled work",
    unresolved_candidate: "Resolve candidate decision",
    idle_worker: "Assign available worker",
  };
  return `${titles[opportunity.kind]}: ${opportunity.subjectId}`;
}

function action(
  goal: Goal,
  profile: FleetProfile,
  lane: IdleSuggestionLane,
  opportunity: IdleOpportunity,
  outcome: IdleAutonomyAction["outcome"],
  detail: string,
): IdleAutonomyAction {
  return { goalId: goal.id, profileId: profile.id, laneId: lane.id, opportunity, outcome, detail: safeText(detail, 16_384) };
}

function validateLease(lease: IdleWorktreeLease) {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(lease.id)) throw new Error("Idle worktree lease id is invalid.");
  if (!lease.token || lease.token.length > 1_024) throw new Error("Idle worktree lease token is invalid.");
  if (!isAbsolute(lease.worktreePath)) throw new Error("Idle worktree lease path must be absolute.");
  if (typeof lease.release !== "function") throw new Error("Idle worktree lease requires a release callback.");
}

async function boundedCallback<T>(
  timeoutMs: number,
  callback: (signal: AbortSignal) => T | Promise<T>,
  timeoutMessage: string,
) {
  const controller = new AbortController();
  let settledResolve!: () => void;
  const settled = new Promise<void>((resolve) => { settledResolve = resolve; });
  const operation = Promise.resolve()
    .then(() => callback(controller.signal))
    .finally(settledResolve);
  let timeout: ReturnType<typeof setTimeout>;
  const boundary = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort(timeoutMessage);
      reject(new BoundedCallbackTimeoutError(timeoutMessage, settled));
    }, timeoutMs);
    timeout.unref?.();
  });
  try {
    return await Promise.race([operation, boundary]);
  } finally {
    clearTimeout(timeout!);
  }
}

class BoundedCallbackTimeoutError extends Error {
  constructor(message: string, readonly settled: Promise<void>) {
    super(message);
    this.name = "BoundedCallbackTimeoutError";
  }
}

function errorMessage(error: unknown) {
  return safeText(error instanceof Error ? error.message : String(error), 4_096);
}

function safeText(value: string, limit: number) {
  try {
    return redactAndTruncate(value, limit).text.slice(0, limit);
  } catch {
    return "[SUPPRESSED: REDACTION FAILURE]";
  }
}

function boundedRequestLimit(value: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new TypeError(`Idle request limit must be an integer between 1 and ${maximum}.`);
  return value;
}
