import { randomUUID } from "node:crypto";
import type { Job } from "../contracts/durable";
import type { ApprovalRequest } from "../contracts/collaboration";
import { IdentifierSchema, PrincipalIdSchema } from "../contracts/common";
import { JobStore } from "../daemon/job-store";
import { ApprovalStore } from "./approval-store";
import { AuthorityStore } from "./authority-store";
import {
  CandidateDecisionStore,
  type CandidateDecisionRecord,
  type CandidateIntegrationOutcome,
} from "./candidate-decision-store";
import {
  integratePreservedCandidateCommit,
  type PreservedCandidateIntegrationResult,
} from "./candidate-git-integration";
import { FinalityStore, type FinalityRecord } from "./finality-store";
import { getHeadSha, runGitStrict } from "./git";
import { HeadlessError } from "./headless-error";
import { IntegrationJournal, type IntegrationJournalRecord } from "./integration-journal";
import type { ProjectStatePaths } from "./project-state";
import type { WorktreeLeaseStore } from "./worktree-leases";
import type { WriteExecutionSummary, WriteGateContext, WriteGateDecision } from "./write-integration";

const GitObjectPattern = /^[a-f0-9]{40,64}$/;
const TERMINAL_JOB_STATES = new Set<Job["state"]>(["succeeded", "failed", "timed_out", "cancelled", "blocked"]);

export type CandidateAuthorizationContext = {
  actor: string;
  admin?: boolean;
  canRead?: (job: Job, actor: string) => boolean | Promise<boolean>;
};

export type CandidateInspection = {
  candidateId: string;
  job: Job;
  decision: CandidateDecisionRecord | null;
  baseCommit: string | null;
  candidateCommit: string | null;
  primaryHead: string | null;
  primaryClean: boolean;
  candidateExists: boolean;
  baseExists: boolean;
  baseIsCandidateAncestor: boolean;
  baseIsPrimaryAncestor: boolean;
  candidateAlreadyIntegrated: boolean;
  finality: FinalityRecord | null;
  approval: ApprovalRequest | null;
  journal: IntegrationJournalRecord | null;
  eligible: boolean;
  reasons: string[];
};

export type CandidateIntegrationServiceOptions = {
  paths: ProjectStatePaths;
  jobs: JobStore;
  finality: FinalityStore;
  approvals: ApprovalStore;
  authority: AuthorityStore;
  journal: IntegrationJournal;
  decisions?: CandidateDecisionStore;
  worktreeLeases?: WorktreeLeaseStore;
  evaluateIntegrationGates?: (context: WriteGateContext) => Promise<WriteGateDecision>;
  now?: () => number;
  attemptId?: () => string;
};

export class CandidateIntegrationService {
  readonly decisions: CandidateDecisionStore;
  private readonly inFlight = new Set<string>();
  private readonly now: () => number;
  private readonly attemptId: () => string;

  constructor(private readonly options: CandidateIntegrationServiceOptions) {
    this.decisions = options.decisions ?? new CandidateDecisionStore(options.paths, { now: options.now });
    this.now = options.now ?? Date.now;
    this.attemptId = options.attemptId ?? (() => `candidate_attempt_${randomUUID()}`);
  }

  async inspect(candidateId: string, authorization: CandidateAuthorizationContext): Promise<CandidateInspection> {
    const job = await this.loadVisibleJob(candidateId, authorization);
    const baseCommit = validGitObject(job.result?.commit?.base);
    const candidateCommit = validGitObject(job.result?.commit?.candidate);
    const primary = primaryState(this.options.paths.canonicalProjectRoot);
    const decision = this.decisions.get(job.id);
    const finality = this.allowedFinality(job.id);
    const approval = this.approvedMergeRequest(job.id);
    const candidateExists = candidateCommit ? commitExists(candidateCommit, this.options.paths.canonicalProjectRoot) : false;
    const baseExists = baseCommit ? commitExists(baseCommit, this.options.paths.canonicalProjectRoot) : false;
    const baseIsCandidateAncestor = !!baseCommit && !!candidateCommit && baseExists && candidateExists
      && gitIsAncestor(baseCommit, candidateCommit, this.options.paths.canonicalProjectRoot);
    const baseIsPrimaryAncestor = !!baseCommit && !!primary.head && baseExists
      && gitIsAncestor(baseCommit, primary.head, this.options.paths.canonicalProjectRoot);
    const candidateAlreadyIntegrated = !!candidateCommit && !!primary.head && candidateExists
      && gitIsAncestor(candidateCommit, primary.head, this.options.paths.canonicalProjectRoot);
    const reasons = eligibilityReasons({
      job,
      decision,
      baseCommit,
      candidateCommit,
      primary,
      candidateExists,
      baseExists,
      baseIsCandidateAncestor,
      baseIsPrimaryAncestor,
      candidateAlreadyIntegrated,
      finality,
      approval,
    });
    return {
      candidateId: job.id,
      job,
      decision,
      baseCommit,
      candidateCommit,
      primaryHead: primary.head,
      primaryClean: primary.ok && !primary.dirty,
      candidateExists,
      baseExists,
      baseIsCandidateAncestor,
      baseIsPrimaryAncestor,
      candidateAlreadyIntegrated,
      finality,
      approval,
      journal: this.options.journal.get(job.id),
      eligible: reasons.length === 0 || (reasons.length === 1 && candidateAlreadyIntegrated && reasons[0] === "Candidate is already contained in primary."),
      reasons,
    };
  }

  async reject(
    candidateId: string,
    authorization: CandidateAuthorizationContext,
    reason = "Candidate rejected by an authorized operator.",
  ) {
    const job = await this.loadVisibleJob(candidateId, authorization);
    this.requireAdmin(authorization);
    const inspection = await this.inspect(job.id, authorization);
    if (job.result?.commit?.merged || inspection.candidateAlreadyIntegrated) {
      throw new HeadlessError("CONFLICT", "An already merged candidate cannot be rejected.");
    }
    try {
      return this.decisions.reject(job.id, authorization.actor, reason);
    } catch (error) {
      throw new HeadlessError("CONFLICT", "Candidate rejection could not be recorded.", { cause: error });
    }
  }

  async integrate(
    candidateId: string,
    authorization: CandidateAuthorizationContext,
    input: { signal?: AbortSignal } = {},
  ) {
    const job = await this.loadVisibleJob(candidateId, authorization);
    if (this.inFlight.has(job.id)) throw new HeadlessError("CONFLICT", "Candidate integration is already in progress.", { retryable: true });
    this.inFlight.add(job.id);
    try {
      await this.reconcile();
      const existing = this.decisions.get(job.id);
      if (existing?.status === "rejected") throw new HeadlessError("CONFLICT", "Rejected candidates cannot be integrated.");
      if (existing?.status === "integrated" && existing.resultingCommit) {
        return alreadyIntegratedResult(job, existing.resultingCommit);
      }
      const inspection = await this.inspect(job.id, authorization);
      const overflowRecovery = inspection.finality ? null : this.overflowRecoverySource(inspection);
      const deferredReasons = new Set([
        "Candidate is already contained in primary.",
        "Primary checkout is dirty or could not be verified.",
        "Ask-mode candidate has no approved merge request.",
      ]);
      const structuralReasons = inspection.reasons.filter((reason) => !deferredReasons.has(reason)
        && !(overflowRecovery && reason === "Candidate has no allowed durable write finality decision."));
      if (structuralReasons.length > 0) {
        throw new HeadlessError(
          inspection.finality ? "INVALID_REQUEST" : "GATE_FAILED",
          `Candidate is not eligible for integration: ${structuralReasons.join(" ")}`,
        );
      }
      const baseCommit = inspection.baseCommit!;
      const candidateCommit = inspection.candidateCommit!;
      const startedAt = this.now();
      const attemptId = this.attemptId();

      const initialAuthority = this.currentAuthority(job, authorization.actor);
      if (!initialAuthority.allowed || !initialAuthority.mergeAllowed) {
        throw new HeadlessError("POLICY_DENIED", initialAuthority.reason);
      }
      this.options.authority.consumeIteration(initialAuthority.grantId, `candidate:${job.id}`);
      const finality = inspection.finality ?? this.ensureOverflowRecoveryAdmission(job, authorization.actor, overflowRecovery!);

      if (input.signal?.aborted) {
        this.recordExpectedFailure(job, authorization.actor, {
          attemptId,
          startedAt,
          outcome: "cancelled",
          reason: "Candidate integration was cancelled before work began.",
          baseCommit,
          candidateCommit,
          expectedPrimaryHead: inspection.primaryHead,
          approval: inspection.approval,
          finality,
        });
        throw new HeadlessError("CANCELLED", "Candidate integration was cancelled.");
      }

      if (job.approvalPolicy === "ask" && !inspection.approval) {
        const approval = overflowRecovery ? this.ensureOverflowRecoveryApproval(job, authorization.actor, baseCommit, candidateCommit) : null;
        this.recordExpectedFailure(job, authorization.actor, {
          attemptId,
          startedAt,
          outcome: "approval_required",
          reason: "Ask-mode candidates require an approved merge request.",
          baseCommit,
          candidateCommit,
          expectedPrimaryHead: inspection.primaryHead,
          approval: null,
          finality,
          grantId: initialAuthority.grantId,
        });
        throw new HeadlessError(
          "APPROVAL_REQUIRED",
          approval
            ? `Output-overflow candidate requires approved merge request ${approval.id} before recovery gates run.`
            : "Ask-mode candidates require an approved merge request.",
          { details: approval ? { approvalId: approval.id, candidateId: job.id } : undefined },
        );
      }

      if (inspection.candidateAlreadyIntegrated && inspection.primaryHead) {
        this.decisions.markIntegrated(job.id, authorization.actor, inspection.primaryHead);
        this.recordAttempt(job, authorization.actor, {
          attemptId,
          startedAt,
          outcome: "recovered_applied",
          merged: true,
          reason: "Candidate was already contained in the current primary history.",
          baseCommit,
          candidateCommit,
          expectedPrimaryHead: inspection.primaryHead,
          targetCommit: inspection.primaryHead,
          resultingCommit: inspection.primaryHead,
          approval: inspection.approval,
          finality,
          grantId: initialAuthority.grantId,
        });
        return alreadyIntegratedResult(job, inspection.primaryHead);
      }

      let currentGrantId = initialAuthority.grantId;
      const integration = await integratePreservedCandidateCommit({
        primaryRoot: this.options.paths.canonicalProjectRoot,
        candidateId: job.id,
        sessionId: job.sessionId,
        actor: authorization.actor,
        grantId: currentGrantId,
        currentGrantId: () => currentGrantId,
        baseCommit,
        candidateCommit,
        execution: executionSummary(job),
        journal: this.options.journal,
        signal: input.signal,
        worktreeLease: this.options.worktreeLeases?.createHooks(job.id),
        requireIntegrationGates: Boolean(overflowRecovery),
        reauthorize: () => {
          const decision = this.currentAuthority(job, authorization.actor);
          currentGrantId = decision.grantId;
          return { allowed: decision.allowed && decision.mergeAllowed, reason: decision.reason };
        },
        evaluateIntegrationGates: async (context) => this.evaluateAdvancedGates(context, job, authorization.actor, finality),
      });
      if (integration.merged && integration.resultingCommit) {
        try {
          this.decisions.markIntegrated(job.id, authorization.actor, integration.resultingCommit);
        } catch (error) {
          throw new HeadlessError(
            "INTERNAL_ERROR",
            "Primary was updated and its journal remains recoverable, but candidate decision persistence failed.",
            { cause: error },
          );
        }
        let journalDiagnostic: string | null = null;
        try {
          this.options.journal.markCompleted(job.id, integration.resultingCommit);
        } catch (error) {
          journalDiagnostic = `Integration completion marker failed and will be reconciled after restart: ${messageOf(error)}`;
        }
        this.recordIntegrationResult(job, authorization.actor, attemptId, startedAt, integration, {
          approval: inspection.approval,
          finality,
          grantId: currentGrantId,
          extraEvidence: journalDiagnostic ? [journalDiagnostic] : [],
        });
        return integration;
      }

      this.recordIntegrationResult(job, authorization.actor, attemptId, startedAt, integration, {
        approval: inspection.approval,
        finality,
        grantId: currentGrantId,
      });
      if (integration.outcome === "cancelled") throw new HeadlessError("CANCELLED", integration.reason);
      if (integration.outcome === "unauthorized") throw new HeadlessError("POLICY_DENIED", integration.reason);
      return integration;
    } finally {
      this.inFlight.delete(job.id);
    }
  }

  /** Reconcile only preserved-candidate journals; normal run recovery stays daemon-owned. */
  async reconcile() {
    const reconciled: Array<{ candidateId: string; state: "applied" | "abandoned" }> = [];
    const primary = primaryState(this.options.paths.canonicalProjectRoot);
    if (!primary.head) {
      const candidates = this.candidateJournalRecords();
      if (candidates.length > 0) throw new Error("Cannot reconcile candidate integration journals without primary HEAD.");
      return reconciled;
    }
    for (const record of this.candidateJournalRecords()) {
      const job = this.options.jobs.get(record.jobId)!;
      const targetApplied = gitIsAncestor(record.targetCommit, primary.head, this.options.paths.canonicalProjectRoot);
      if (targetApplied) {
        if (!primary.ok || primary.dirty) {
          throw new Error(`Applied candidate journal ${record.jobId} cannot be reconciled while primary is dirty.`);
        }
        this.options.journal.markApplied(record.jobId, record.targetCommit);
        this.decisions.markIntegrated(record.jobId, record.principal, record.targetCommit);
        this.recordAttempt(job, record.principal, {
          attemptId: `candidate_recovery_${randomUUID()}`,
          startedAt: this.now(),
          outcome: "recovered_applied",
          merged: true,
          reason: "Recovered an applied candidate integration from the durable journal.",
          baseCommit: record.baseCommit,
          candidateCommit: record.candidateCommit,
          expectedPrimaryHead: record.expectedPrimaryHead,
          targetCommit: record.targetCommit,
          resultingCommit: record.targetCommit,
          approval: this.approvedMergeRequest(record.jobId),
          finality: this.allowedFinality(record.jobId),
          grantId: record.grantId,
        });
        this.options.journal.markCompleted(record.jobId, record.targetCommit);
        reconciled.push({ candidateId: record.jobId, state: "applied" });
        continue;
      }
      const expectedStillRelevant = gitIsAncestor(record.expectedPrimaryHead, primary.head, this.options.paths.canonicalProjectRoot);
      if (record.state === "applied" || !expectedStillRelevant) {
        throw new Error(`Candidate integration journal ${record.jobId} is ambiguous at primary ${primary.head}.`);
      }
      this.options.journal.markAbandoned(record.jobId, primary.head);
      this.recordAttempt(job, record.principal, {
        attemptId: `candidate_recovery_${randomUUID()}`,
        startedAt: this.now(),
        outcome: "recovered_abandoned",
        merged: false,
        reason: "Closed a prepared candidate integration intent that did not update primary.",
        baseCommit: record.baseCommit,
        candidateCommit: record.candidateCommit,
        expectedPrimaryHead: record.expectedPrimaryHead,
        targetCommit: record.targetCommit,
        resultingCommit: primary.head,
        approval: this.approvedMergeRequest(record.jobId),
        finality: this.allowedFinality(record.jobId),
        grantId: record.grantId,
      });
      reconciled.push({ candidateId: record.jobId, state: "abandoned" });
    }
    return reconciled;
  }

  private async loadVisibleJob(candidateId: string, authorization: CandidateAuthorizationContext) {
    const id = IdentifierSchema.parse(candidateId);
    const actor = PrincipalIdSchema.parse(authorization.actor);
    const job = this.options.jobs.get(id);
    if (!job) throw new HeadlessError("INVALID_REQUEST", `Unknown candidate: ${id}`);
    const visible = authorization.admin || job.principal === actor || await authorization.canRead?.(job, actor) === true;
    if (!visible) throw new HeadlessError("POLICY_DENIED", "Candidate is not owned by the authenticated principal.");
    return job;
  }

  private requireAdmin(authorization: CandidateAuthorizationContext) {
    if (!authorization.admin) throw new HeadlessError("POLICY_DENIED", "Candidate mutation requires administrator scope.");
  }

  private currentAuthority(job: Job, actor: string) {
    return this.options.authority.authorize({
      projectId: this.options.paths.projectId,
      principal: actor,
      operation: "write",
      backend: job.backend,
      estimatedCostUsd: job.result?.cost.amountUsd ?? null,
      merge: true,
    });
  }

  private allowedFinality(jobId: string) {
    const records = this.options.finality.list();
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index];
      const decision = record.decision;
      if (decision.jobId !== jobId || !decision.allowed) continue;
      if (!decision.policyPassed || !decision.testsPassed || !decision.reviewPassed || !decision.budgetPassed) continue;
      if (record.requirements.vote && !decision.votePassed) continue;
      return record;
    }
    return null;
  }

  private overflowRecoverySource(inspection: CandidateInspection) {
    if (inspection.job.mode !== "write" || inspection.job.result?.error?.code !== "OUTPUT_OVERFLOW") return null;
    if (!inspection.baseCommit || !inspection.candidateCommit || inspection.baseCommit === inspection.candidateCommit) return null;
    if (!inspection.baseExists || !inspection.candidateExists || !inspection.baseIsCandidateAncestor || !inspection.baseIsPrimaryAncestor) return null;
    if (!inspection.primaryClean || inspection.decision?.status === "rejected") return null;
    return [...this.options.finality.list()].reverse().find((record) =>
      record.decision.jobId === inspection.job.id && record.decision.budgetPassed) ?? null;
  }

  private ensureOverflowRecoveryAdmission(job: Job, actor: string, source: FinalityRecord) {
    const existing = [...this.options.finality.list()].reverse().find((record) =>
      record.decision.jobId === job.id
      && record.decision.allowed
      && record.requirements.tests === false
      && record.requirements.review === false);
    if (existing) return existing;
    const decision = this.options.finality.evaluate({
      projectId: this.options.paths.projectId,
      jobId: job.id,
      decidedBy: actor,
      requirements: { policy: true, tests: false, review: false, vote: false, budget: true },
      gates: { policyPassed: true, testsPassed: false, reviewPassed: false, votePassed: false, budgetPassed: source.decision.budgetPassed },
    });
    return this.options.finality.list().find((record) => record.decision.id === decision.id)!;
  }

  private ensureOverflowRecoveryApproval(job: Job, actor: string, baseCommit: string, candidateCommit: string) {
    const existing = this.options.approvals.list({ collaborationId: job.id, assignedTo: actor })
      .find((approval) => approval.kind === "merge" && approval.status === "pending");
    if (existing) return existing;
    return this.options.approvals.create({
      collaborationId: job.id,
      requestedBy: actor,
      assignedTo: actor,
      kind: "merge",
      summary: "Approve review and integration of the preserved output-overflow candidate.",
      details: { candidateId: job.id, baseCommit, candidateCommit, recovery: "output-overflow" },
      artifactIds: [job.id],
      expiresAt: this.now() + 86_400_000,
    });
  }

  private approvedMergeRequest(candidateId: string) {
    const approvals = this.options.approvals.list({ status: "approved" });
    for (let index = approvals.length - 1; index >= 0; index -= 1) {
      const approval = approvals[index];
      if (approval.kind !== "merge" || !approvalMatchesCandidate(approval, candidateId)) continue;
      return approval;
    }
    return null;
  }

  private async evaluateAdvancedGates(
    context: WriteGateContext,
    job: Job,
    actor: string,
    sourceFinality: FinalityRecord,
  ): Promise<WriteGateDecision> {
    const gate = this.options.evaluateIntegrationGates
      ? await this.options.evaluateIntegrationGates(context)
      : failedGate("No advanced-head integration gate runner is configured.");
    const decision = this.options.finality.evaluate({
      projectId: this.options.paths.projectId,
      jobId: job.id,
      decidedBy: actor,
      requirements: {
        policy: true,
        tests: true,
        review: true,
        vote: sourceFinality.requirements.vote,
        budget: true,
      },
      gates: {
        policyPassed: gate.policyPassed,
        testsPassed: gate.testsPassed,
        reviewPassed: gate.reviewPassed,
        votePassed: gate.votePassed,
        budgetPassed: gate.budgetPassed,
      },
    });
    return {
      ...gate,
      policyPassed: decision.allowed && decision.policyPassed,
      testsPassed: decision.testsPassed,
      reviewPassed: decision.reviewPassed,
      votePassed: decision.votePassed,
      budgetPassed: decision.budgetPassed,
      reasons: [...(gate.reasons ?? []), ...decision.reasons],
    };
  }

  private candidateJournalRecords() {
    return this.options.journal.listOpen().filter((record) => {
      const job = this.options.jobs.get(record.jobId);
      return !!job?.result?.commit
        && job.result.commit.merged === false
        && job.result.commit.candidate === record.candidateCommit;
    });
  }

  private recordIntegrationResult(
    job: Job,
    actor: string,
    attemptId: string,
    startedAt: number,
    integration: PreservedCandidateIntegrationResult,
    metadata: {
      approval: ApprovalRequest | null;
      finality: FinalityRecord;
      grantId: string | null;
      extraEvidence?: string[];
    },
  ) {
    this.recordAttempt(job, actor, {
      attemptId,
      startedAt,
      outcome: integration.outcome,
      merged: integration.merged,
      reason: integration.reason,
      evidence: [...integration.evidence, ...(metadata.extraEvidence ?? [])],
      baseCommit: integration.baseCommit,
      candidateCommit: integration.candidateCommit,
      expectedPrimaryHead: integration.expectedPrimaryHead,
      targetCommit: integration.targetCommit,
      resultingCommit: integration.resultingCommit,
      approval: metadata.approval,
      finality: metadata.finality,
      grantId: metadata.grantId,
    });
  }

  private recordExpectedFailure(
    job: Job,
    actor: string,
    input: {
      attemptId: string;
      startedAt: number;
      outcome: CandidateIntegrationOutcome;
      reason: string;
      baseCommit: string | null;
      candidateCommit: string | null;
      expectedPrimaryHead: string | null;
      approval: ApprovalRequest | null;
      finality: FinalityRecord | null;
      grantId?: string | null;
    },
  ) {
    this.recordAttempt(job, actor, {
      ...input,
      merged: false,
      evidence: [],
      targetCommit: null,
      resultingCommit: input.expectedPrimaryHead,
      grantId: input.grantId ?? null,
    });
  }

  private recordAttempt(
    job: Job,
    actor: string,
    input: {
      attemptId: string;
      startedAt: number;
      outcome: CandidateIntegrationOutcome;
      merged: boolean;
      reason: string;
      evidence?: string[];
      baseCommit: string | null;
      candidateCommit: string | null;
      expectedPrimaryHead: string | null;
      targetCommit: string | null;
      resultingCommit: string | null;
      approval: ApprovalRequest | null;
      finality: FinalityRecord | null;
      grantId: string | null;
    },
  ) {
    return this.decisions.recordAttempt({
      id: input.attemptId,
      candidateId: job.id,
      actor,
      outcome: input.outcome,
      merged: input.merged,
      baseCommit: input.baseCommit,
      candidateCommit: input.candidateCommit,
      expectedPrimaryHead: input.expectedPrimaryHead,
      targetCommit: input.targetCommit,
      resultingCommit: input.resultingCommit,
      grantId: input.grantId,
      approvalId: input.approval?.id ?? null,
      finalityId: input.finality?.decision.id ?? null,
      reason: input.reason,
      evidence: input.evidence ?? [],
      startedAt: input.startedAt,
      completedAt: this.now(),
    });
  }
}

function eligibilityReasons(input: {
  job: Job;
  decision: CandidateDecisionRecord | null;
  baseCommit: string | null;
  candidateCommit: string | null;
  primary: ReturnType<typeof primaryState>;
  candidateExists: boolean;
  baseExists: boolean;
  baseIsCandidateAncestor: boolean;
  baseIsPrimaryAncestor: boolean;
  candidateAlreadyIntegrated: boolean;
  finality: FinalityRecord | null;
  approval: ApprovalRequest | null;
}) {
  const reasons: string[] = [];
  if (input.job.mode !== "write") reasons.push("Only write jobs can produce integration candidates.");
  if (!TERMINAL_JOB_STATES.has(input.job.state) || !input.job.result) reasons.push("Candidate job is not terminal.");
  if (input.job.result?.commit?.merged) reasons.push("Candidate job is already marked merged.");
  if (!input.baseCommit || !input.candidateCommit) reasons.push("Candidate result is missing valid base or candidate commits.");
  if (!input.baseExists || !input.candidateExists) reasons.push("Candidate Git objects are unavailable.");
  if (input.baseCommit && input.candidateCommit && input.baseCommit === input.candidateCommit) reasons.push("Candidate commit contains no changes from its base.");
  if (input.baseCommit && input.candidateCommit && !input.baseIsCandidateAncestor) reasons.push("Candidate commit does not descend from its recorded base.");
  if (input.baseCommit && input.primary.head && !input.baseIsPrimaryAncestor) reasons.push("Primary no longer descends from the candidate base.");
  if (!input.primary.ok || input.primary.dirty) reasons.push("Primary checkout is dirty or could not be verified.");
  if (!input.finality) reasons.push("Candidate has no allowed durable write finality decision.");
  if (input.job.approvalPolicy === "ask" && !input.approval) reasons.push("Ask-mode candidate has no approved merge request.");
  if (input.decision?.status === "rejected") reasons.push("Candidate was durably rejected.");
  if (input.decision?.status === "integrated") reasons.push("Candidate was already durably integrated.");
  if (input.candidateAlreadyIntegrated) reasons.push("Candidate is already contained in primary.");
  return reasons;
}

function primaryState(primaryRoot: string) {
  const head = getHeadSha(primaryRoot);
  const status = runGitStrict(["status", "--porcelain=v1", "--untracked-files=all"], primaryRoot);
  return { ok: status.ok && !!head, dirty: !!status.stdout.trim(), head, evidence: status.ok ? status.stdout : status.stderr };
}

function commitExists(commit: string, cwd: string) {
  return GitObjectPattern.test(commit) && runGitStrict(["cat-file", "-e", `${commit}^{commit}`], cwd).ok;
}

function gitIsAncestor(commit: string, descendant: string, cwd: string) {
  const result = runGitStrict(["merge-base", "--is-ancestor", commit, descendant], cwd);
  if (result.ok) return true;
  if (result.code === 1) return false;
  throw new Error(`Cannot verify candidate ancestry: ${result.stderr.trim() || "git merge-base failed"}`);
}

function validGitObject(value: string | null | undefined) {
  return value && GitObjectPattern.test(value) ? value : null;
}

function approvalMatchesCandidate(approval: ApprovalRequest, candidateId: string) {
  if (approval.collaborationId === candidateId || approval.artifactIds.includes(candidateId)) return true;
  const details = approval.details;
  return details.candidateId === candidateId || details.jobId === candidateId;
}

function executionSummary(job: Job): WriteExecutionSummary {
  return {
    succeeded: true,
    status: "succeeded",
    failureCode: null,
    usage: job.result?.usage ?? { input: null, output: null, reasoning: null, cached: null, providerTotal: null },
    costUsd: job.result?.cost.amountUsd ?? null,
  };
}

function failedGate(reason: string): WriteGateDecision {
  return {
    policyPassed: false,
    testsPassed: false,
    reviewPassed: false,
    votePassed: false,
    budgetPassed: false,
    reasons: [reason],
    evidence: [],
  };
}

function alreadyIntegratedResult(job: Job, commit: string): PreservedCandidateIntegrationResult {
  return {
    outcome: "merged_fast_forward",
    merged: true,
    baseCommit: validGitObject(job.result?.commit?.base) ?? commit,
    candidateCommit: validGitObject(job.result?.commit?.candidate) ?? commit,
    expectedPrimaryHead: commit,
    targetCommit: commit,
    resultingCommit: commit,
    reason: "Candidate is already integrated.",
    evidence: [],
    gate: null,
    journalState: "none",
  };
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
