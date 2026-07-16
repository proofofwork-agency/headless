import { createHash, randomUUID } from "node:crypto";
import { getProvider } from "../broker/providers";
import type { BrokerLeaseCarve, BrokerLeaseScope, BrokerLinkedTargetScope, ProviderBroker } from "../broker/server";
import { getBackendDefinition, resolveBackendId } from "../backends/registry";
import type { ApprovalRequest } from "../contracts/collaboration";
import { SubmissionIdempotencyKeySchema } from "../contracts/common";
import type { Job } from "../contracts/durable";
import type { LinkedHoldRecord, LinkedHoldUsageProjection } from "../contracts/linked-hold";
import { RunRequestSchema, type RunResult, type SerializedRunRequest } from "../contracts/run";
import type { ApprovalStore } from "../runtime/approval-store";
import type { AuthorityStore } from "../runtime/authority-store";
import type { BudgetReservation, BudgetStore } from "../runtime/budget-store";
import { HeadlessError } from "../runtime/headless-error";
import { estimateRunCost } from "../runtime/pricing";
import type { ProjectTrustStore } from "../runtime/project-trust-store";
import type { PersistentSessionStore } from "../runtime/persistent-sessions";
import { redactAndTruncate } from "../runtime/redaction";
import { safeAgentName } from "../runtime/validation";
import type { JobStore } from "./job-store";
import type { RunEventStore } from "./run-event-store";
import type { TaskStore } from "./task-store";
import type { RunExecutionControls } from "./run-execution-service";

export type JobAdmissionSubmitOptions = {
  mergePolicy?: Job["mergePolicy"];
  workflowId?: string | null;
  retryNumber?: number;
  maxAttempts?: number;
  councilId?: string | null;
  councilSlot?: string | null;
};

export type JobAdmissionServiceOptions = {
  projectId: string;
  projectRoot: string;
  maxConcurrency?: number;
  maxQueued?: number;
  jobs: JobStore;
  tasks: TaskStore;
  runEvents: RunEventStore;
  approvals: ApprovalStore;
  sessions: Pick<PersistentSessionStore, "get">;
  trust: ProjectTrustStore;
  authority: AuthorityStore;
  budgets: BudgetStore;
  broker: ProviderBroker;
  env: Readonly<NodeJS.ProcessEnv>;
  activeLeadBackend: () => string | null;
  isStopping: () => boolean;
  execute: (jobId: string, request: SerializedRunRequest, controls: RunExecutionControls) => Promise<void>;
  abort: (jobId: string) => void;
  completed: (job: Job) => void;
  trackExecution?: (execution: Promise<void>) => void;
  diagnostic?: (message: string, error?: unknown) => void;
  auditDelegation?: (type: "worker_spawned" | "headless_result", parent: Job, child: Job, metadata: Record<string, unknown>) => void;
};

type PendingJob = { id: string; request: SerializedRunRequest; coderToolApproved: boolean };

/**
 * Durable run admission plus bounded FIFO scheduling.
 *
 * Job/request persistence remains the queue commit point. This service owns
 * the in-memory runnable index, queue deadlines, budget activation, write
 * serialization, cancellation, and worker capacity. Actual worker execution
 * is deliberately injected so containment and integration stay isolated from
 * admission policy.
 */
export class JobAdmissionService {
  readonly maxConcurrency: number;
  readonly maxQueued: number;
  private readonly queueDeadlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingJobs: PendingJob[] = [];
  private readonly waitingApprovalJobs = new Set<string>();
  private readonly executions = new Set<Promise<void>>();
  private activeJobs = 0;
  private activeWrites = 0;
  private delegationMutationActive = false;
  private readonly delegationCarves = new Map<string, BrokerLeaseCarve>();
  private readonly linkedSettlements = new Map<string, Promise<boolean>>();

  constructor(private readonly options: JobAdmissionServiceOptions) {
    this.maxConcurrency = Math.max(1, Math.min(options.maxConcurrency ?? 4, 64));
    this.maxQueued = Math.max(1, Math.min(options.maxQueued ?? 64, 1_024));
  }

  load() {
    return { activeJobs: this.activeJobs, queuedJobs: this.pendingJobs.length + this.waitingApprovalJobs.size };
  }

  admitDelegation(input: {
    parentJobId: string;
    requestId: string;
    backend: string;
    prompt: string;
    model?: string;
    agent?: string;
    timeoutMs?: number;
    budgetFraction: number;
  }) {
    if (this.options.isStopping()) throw new HeadlessError("DAEMON_UNAVAILABLE", "Daemon is shutting down and cannot delegate.");
    const parent = this.requireJob(input.parentJobId);
    const parentRequest = this.options.jobs.request(parent.id);
    if (!parentRequest || parent.state !== "running") throw new HeadlessError("POLICY_DENIED", "Delegation requires a running durable parent job.");
    const audit = {
      parentJobId: parent.id,
      requestId: input.requestId,
      targetBackend: input.backend,
      depth: 1,
      promptSha256: createHash("sha256").update(input.prompt).digest("hex"),
      promptBytes: Buffer.byteLength(input.prompt),
      budgetFraction: input.budgetFraction,
    };
    this.delegationPolicyEvent(parent, "deferred", "run-delegation-request", audit);

    const existing = this.options.jobs.findDelegation(parent.id, input.requestId);
    if (existing) {
      this.delegationPolicyEvent(parent, "allowed", "run-delegation-idempotent-replay", { ...audit, childJobId: existing.id });
      return { job: existing, existing: true };
    }
    if (this.options.jobs.delegatedChild(parent.id)) throw this.delegationDenied(parent, audit, "The parent already admitted its single delegated child.");
    if (parent.delegationOf !== null) throw this.delegationDenied(parent, audit, "A delegated worker cannot delegate again.");
    if (parent.mode !== "read-only" || parentRequest.mode !== "read-only" || parentRequest.containment !== "required") {
      throw this.delegationDenied(parent, audit, "Delegation is available only to read-only parents under required containment.");
    }
    if (parentRequest.authMode !== "broker") throw this.delegationDenied(parent, audit, "Native-login delegation is prohibited.");
    let backend: string;
    try {
      backend = resolveBackendId(input.backend);
    } catch {
      throw this.delegationDenied(parent, audit, `Unknown delegation backend: ${input.backend}.`);
    }
    if (backend === resolveBackendId(parent.backend)) throw this.delegationDenied(parent, audit, "Delegation must target a different backend.");
    const lead = this.options.activeLeadBackend();
    if (lead && backend === resolveBackendId(lead)) throw this.delegationDenied(parent, audit, "Delegation cannot target the active foreground-lead backend.");
    if (this.activeJobs >= this.maxConcurrency || this.maxConcurrency === 1) {
      const error = new HeadlessError("DELEGATION_CAPACITY_UNAVAILABLE", "No ordinary worker slot is immediately available for delegation.", { retryable: true });
      this.delegationPolicyEvent(parent, "denied", "run-delegation-capacity", { ...audit, error: error.message });
      throw error;
    }

    const parentDeadlineAt = jobDeadlineAt(parent, parentRequest);
    const replyMarginMs = 10_000;
    const requestedMs = input.timeoutMs ?? 60_000;
    const deadlineAt = Math.min(Date.now() + requestedMs, parentDeadlineAt - replyMarginMs);
    const timeoutMs = deadlineAt - Date.now();
    if (timeoutMs < 1_000) throw this.delegationDenied(parent, audit, "Too little parent deadline remains for a bounded child and reply margin.");
    const approvalPolicy = delegatedApprovalPolicy(parent.approvalPolicy);
    const request = RunRequestSchema.parse({
      backend,
      prompt: input.prompt,
      projectRoot: this.options.projectRoot,
      mode: "read-only",
      model: input.model,
      agent: input.agent,
      timeoutMs,
      containment: "required",
      authMode: "broker",
      approvalPolicy,
    });
    const adapter = getBackendDefinition(backend);
    if (!adapter) throw this.delegationDenied(parent, audit, `Unknown delegation backend: ${backend}.`);
    if (request.agent && !adapter.supportsNamedAgent) throw this.delegationDenied(parent, audit, `Backend ${backend} does not support named agents.`);
    if (request.agent) safeAgentName(request.agent, backend);
    const parentProvider = providerForRequest(parentRequest, this.options.env);
    const childProvider = providerForRequest(request, this.options.env);
    if (adapter.security.strictAuth === "broker-api-key") {
      if (!request.model) throw this.delegationDenied(parent, audit, `Backend ${backend} requires an explicit broker-scoped model.`);
      const provider = childProvider ? getProvider(childProvider) : null;
      if (!provider || !this.options.env[provider.credentialEnv]) throw this.delegationDenied(parent, audit, `Backend ${backend} has no daemon-broker credential.`);
    }
    const estimate = estimateRequestResources(request, this.options.env);
    const unpriced = request.authMode === "broker"
      && adapter.security.strictAuth === "broker-api-key"
      && estimate.cost.amountUsd === null
      && !this.options.budgets.hasCostLimit({
        projectId: this.options.projectId,
        principal: parent.principal,
        sessionId: null,
        workflowId: null,
        provider: childProvider,
      });
    if (unpriced) {
      const error = new HeadlessError("APPROVAL_REQUIRED", "Delegated broker pricing is unknown and cannot create a worker-resolvable approval.");
      this.delegationPolicyEvent(parent, "denied", "run-delegation-approval", { ...audit, approvalPolicy, error: error.message });
      throw error;
    }
    const authorization = this.options.authority.authorize({
      projectId: this.options.projectId,
      principal: parent.principal,
      operation: "run",
      backend,
      estimatedCostUsd: estimate.cost.amountUsd,
      merge: false,
    });
    if (!authorization.allowed) throw this.delegationDenied(parent, audit, authorization.reason || "Delegated target authorization was denied.");

    if (parentProvider !== null && childProvider !== null && parentProvider !== childProvider) {
      if (this.delegationMutationActive) {
        throw new HeadlessError("DELEGATION_CAPACITY_UNAVAILABLE", "Another delegation admission is mutating linked quota state.", { retryable: true });
      }
      this.delegationMutationActive = true;
      try {
        return this.admitCrossProviderDelegation({
          input,
          parent,
          parentRequest,
          request,
          parentProvider,
          childProvider,
          deadlineAt,
          parentDeadlineAt,
          replyMarginMs,
          approvalPolicy,
          estimate,
          authorization,
          audit,
        });
      } finally {
        this.delegationMutationActive = false;
      }
    }

    const childId = randomUUID();
    const carved = this.options.budgets.subreserveDelegation({
      id: childId,
      parentReservationId: parent.id,
      requestId: input.requestId,
      budgetFraction: input.budgetFraction,
      provider: childProvider,
      inputTokens: estimate.inputTokens,
      outputTokens: estimate.outputTokens,
      costUsd: estimate.cost.amountUsd,
    });
    if (!carved.allowed || !carved.reservation) throw this.delegationDenied(parent, audit, carved.reasons.join(" "));
    const activation = this.options.budgets.activate(childId);
    if (!activation.allowed) {
      this.options.budgets.release(childId);
      const error = new HeadlessError("DELEGATION_CAPACITY_UNAVAILABLE", activation.reasons.join(" "), { retryable: true });
      this.delegationPolicyEvent(parent, "denied", "run-delegation-budget-capacity", { ...audit, error: error.message });
      throw error;
    }
    let leaseCarve: BrokerLeaseCarve | null = null;
    let createdJob: Job | null = null;
    try {
      if (childProvider !== null) {
        leaseCarve = this.options.broker.carveRunLease(parent.id, {
          requests: carved.reservation.envelope.requests,
          inputTokens: carved.reservation.envelope.inputTokens,
          outputTokens: carved.reservation.envelope.outputTokens,
          costUsd: carved.reservation.envelope.costUsd,
        });
      }
      this.options.authority.consumeIteration(authorization.grantId, childId);
      const job = this.options.jobs.create({
        id: childId,
        projectId: this.options.projectId,
        principal: parent.principal,
        request,
        maxAttempts: 1,
        mergePolicy: "preserve",
        delegationOf: { parentJobId: parent.id, requestId: input.requestId, depth: 1, budgetFraction: input.budgetFraction },
      });
      createdJob = job;
      this.options.tasks.create({ jobId: childId, projectId: this.options.projectId, capability: `read-only:${backend}` });
      if (leaseCarve) this.delegationCarves.set(childId, leaseCarve);
      this.options.runEvents.append({ jobId: childId, sessionId: null }, { kind: "lifecycle", state: "queued", detail: `delegated child of ${parent.id}` });
      this.delegationPolicyEvent(parent, "allowed", "run-delegation-admitted", { ...audit, childJobId: childId, deadlineAt, approvalPolicy, allocation: carved.reservation.envelope });
      this.options.auditDelegation?.("worker_spawned", parent, job, { ...audit, childJobId: childId, deadlineAt, approvalPolicy, allocation: carved.reservation.envelope });
      this.activeJobs += 1;
      const execution = this.options.execute(childId, request, { coderToolApproved: false })
        .catch((error) => this.completeUnexpectedFailure(childId, request, error))
        .finally(() => {
          this.activeJobs -= 1;
          this.executions.delete(execution);
          this.pump();
        });
      this.executions.add(execution);
      this.options.trackExecution?.(execution);
      return { job, existing: false };
    } catch (error) {
      if (leaseCarve) this.options.broker.settleRunLeaseCarve(leaseCarve, { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
      this.options.budgets.release(childId);
      if (createdJob && this.options.jobs.get(createdJob.id)?.state === "queued") {
        this.completeAdmission(createdJob, blockedResult(request, childId, "POLICY_DENIED", "Delegated child launch failed before execution."), "run-delegation-launch");
      }
      throw error;
    }
  }

  private admitCrossProviderDelegation(context: {
    input: {
      parentJobId: string;
      requestId: string;
      backend: string;
      prompt: string;
      model?: string;
      agent?: string;
      timeoutMs?: number;
      budgetFraction: number;
    };
    parent: Job;
    parentRequest: SerializedRunRequest;
    request: SerializedRunRequest;
    parentProvider: string;
    childProvider: string;
    deadlineAt: number;
    parentDeadlineAt: number;
    replyMarginMs: number;
    approvalPolicy: "ask" | "auto";
    estimate: ReturnType<typeof estimateRequestResources>;
    authorization: ReturnType<AuthorityStore["authorize"]>;
    audit: Record<string, unknown>;
  }) {
    const { input, parent, parentRequest, request, parentProvider, childProvider, deadlineAt, parentDeadlineAt, replyMarginMs, approvalPolicy, estimate, authorization, audit } = context;
    const currentParent = this.requireJob(parent.id);
    const currentRequest = this.options.jobs.request(parent.id);
    if (!currentRequest || currentParent.state !== "running" || currentParent.delegationOf !== null) {
      throw this.delegationDenied(parent, audit, "Cross-provider delegation requires a live depth-zero parent.");
    }
    if (currentParent.mode !== "read-only" || currentRequest.mode !== "read-only" || currentRequest.containment !== "required" || currentRequest.authMode !== "broker") {
      throw this.delegationDenied(parent, audit, "Cross-provider delegation requires broker-authenticated read-only containment.");
    }
    if (this.options.jobs.delegatedChild(parent.id)) throw this.delegationDenied(parent, audit, "The parent already admitted its single delegated child.");
    if (this.activeJobs >= this.maxConcurrency || this.maxConcurrency === 1) {
      throw new HeadlessError("DELEGATION_CAPACITY_UNAVAILABLE", "No ordinary worker slot is immediately available for delegation.", { retryable: true });
    }
    if (providerForRequest(currentRequest, this.options.env) !== parentProvider
      || providerForRequest(request, this.options.env) !== childProvider
      || parentProvider === childProvider) {
      throw this.delegationDenied(parent, audit, "Linked delegation provider identity changed during admission.");
    }
    if (resolveBackendId(currentParent.backend) === resolveBackendId(request.backend)) {
      throw this.delegationDenied(parent, audit, "Delegation must target a different backend.");
    }
    const adapter = getBackendDefinition(resolveBackendId(request.backend));
    if (!adapter || adapter.security.strictAuth !== "broker-api-key") {
      throw this.delegationDenied(parent, audit, "Cross-provider delegation requires a broker-compatible target backend.");
    }
    if (request.agent && !adapter.supportsNamedAgent) throw this.delegationDenied(parent, audit, `Backend ${request.backend} does not support named agents.`);
    if (request.agent) safeAgentName(request.agent, request.backend);
    if (delegatedApprovalPolicy(currentParent.approvalPolicy) !== approvalPolicy) {
      throw this.delegationDenied(parent, audit, "Delegated approval policy changed during admission.");
    }
    const currentParentDeadlineAt = jobDeadlineAt(currentParent, currentRequest);
    if (currentParentDeadlineAt !== parentDeadlineAt
      || deadlineAt > currentParentDeadlineAt - replyMarginMs
      || deadlineAt - Date.now() < 1_000) {
      throw this.delegationDenied(parent, audit, "Too little parent deadline remains for a bounded child and reply margin.");
    }
    const lead = this.options.activeLeadBackend();
    if (lead && resolveBackendId(lead) === resolveBackendId(request.backend)) {
      throw this.delegationDenied(parent, audit, "Delegation cannot target the active foreground-lead backend.");
    }
    for (const providerId of [parentProvider, childProvider]) {
      const provider = getProvider(providerId);
      if (!provider || !this.options.env[provider.credentialEnv]) {
        throw this.delegationDenied(parent, audit, `Provider ${providerId} has no daemon-broker credential.`);
      }
    }
    if (estimate.cost.amountUsd === null && !this.options.budgets.hasCostLimit({
      projectId: this.options.projectId,
      principal: parent.principal,
      sessionId: null,
      workflowId: null,
      provider: childProvider,
    })) {
      throw new HeadlessError("APPROVAL_REQUIRED", "Delegated broker pricing is unknown and cannot create a worker-resolvable approval.");
    }
    const currentAuthorization = this.options.authority.authorize({
      projectId: this.options.projectId,
      principal: parent.principal,
      operation: "run",
      backend: request.backend,
      estimatedCostUsd: estimate.cost.amountUsd,
      merge: false,
    });
    if (!currentAuthorization.allowed || currentAuthorization.grantId !== authorization.grantId) {
      throw this.delegationDenied(parent, audit, currentAuthorization.reason || "Delegated target authorization changed during admission.");
    }

    const parentReservation = this.options.budgets.getReservation(parent.id);
    if (!parentReservation || !parentReservation.active || parentReservation.provider !== parentProvider) {
      throw this.delegationDenied(parent, audit, "Parent linked-budget authority is no longer active.");
    }
    const parentAllocation = fractionAllocation(parentReservation.envelope, input.budgetFraction);
    const targetReservation = {
      requests: parentAllocation.requests,
      inputTokens: estimate.inputTokens,
      outputTokens: estimate.outputTokens,
      costUsd: estimate.cost.amountUsd,
      artifactBytes: 0,
      retries: 0,
    };
    const childId = randomUUID();
    const prepared = this.options.budgets.prepareLinkedProviderHold({
      parentJobId: parent.id,
      parentReservationId: parent.id,
      childReservationId: childId,
      requestId: input.requestId,
      parentBackend: resolveBackendId(parent.backend),
      targetBackend: resolveBackendId(request.backend),
      parentProvider,
      targetProvider: childProvider,
      budgetFraction: input.budgetFraction,
      parentDeadlineAt,
      childDeadlineAt: deadlineAt,
      approvalPolicy,
      parentAllocation,
      targetReservation,
      requestDigest: delegationRequestDigest(request),
      promptDigest: createHash("sha256").update(request.prompt).digest("hex"),
      promptBytes: Buffer.byteLength(request.prompt),
    });
    if (!prepared.allowed || !prepared.hold) throw this.delegationDenied(parent, audit, prepared.reasons.join(" "));
    const held = this.options.budgets.applyLinkedProviderHold(prepared.hold.linkId);
    if (!held.allowed || !held.hold || !held.reservation) throw this.delegationDenied(parent, audit, held.reasons.join(" "));

    const parentCarve = this.options.broker.carveLinkedParent(held.hold.linkId, parent.id, brokerAllocation(held.hold.parentAllocation));
    this.options.budgets.markLinkedParentCarved(held.hold.linkId, parentCarve.id);
    const activation = this.options.budgets.activate(childId);
    if (!activation.allowed) {
      throw new HeadlessError("DELEGATION_CAPACITY_UNAVAILABLE", activation.reasons.join(" "), { retryable: true });
    }

    this.options.authority.consumeIteration(currentAuthorization.grantId, childId);
    const job = this.options.jobs.create({
      id: childId,
      projectId: this.options.projectId,
      principal: parent.principal,
      request,
      maxAttempts: 1,
      mergePolicy: "preserve",
      delegationOf: { parentJobId: parent.id, requestId: input.requestId, depth: 1, budgetFraction: input.budgetFraction },
    });
    this.options.tasks.create({ jobId: childId, projectId: this.options.projectId, capability: `read-only:${request.backend}` });
    this.options.budgets.markLinkedAdmitted(held.hold.linkId, childId);

    const issued = this.options.broker.issueLinkedTarget(
      held.hold.linkId,
      childId,
      this.linkedTargetScope(childId, request, deadlineAt, replyMarginMs),
    );
    if (issued.status !== "issued") {
      throw new HeadlessError("CONFLICT", "Linked target bearer was already minted and cannot be reproduced.");
    }
    const targetQuotaScope = linkedTargetQuotaEvidence(issued.evidence.targetQuotaScope);
    this.options.budgets.markLinkedLeased(held.hold.linkId, {
      targetLeaseId: issued.evidence.targetLeaseId,
      targetTokenHash: issued.evidence.targetTokenHash,
      targetIssuedAt: issued.evidence.targetIssuedAt,
      targetQuotaScope,
      targetExpiresAt: issued.evidence.targetExpiresAt,
    });

    this.options.runEvents.append({ jobId: childId, sessionId: null }, { kind: "lifecycle", state: "queued", detail: `cross-provider delegated child of ${parent.id}` });
    this.delegationPolicyEvent(parent, "allowed", "run-delegation-admitted", { ...audit, childJobId: childId, linkId: held.hold.linkId, deadlineAt, approvalPolicy, allocation: held.reservation.envelope });
    this.options.auditDelegation?.("worker_spawned", parent, job, { ...audit, childJobId: childId, linkId: held.hold.linkId, deadlineAt, approvalPolicy, allocation: held.reservation.envelope });
    this.activeJobs += 1;
    const execution = this.options.execute(childId, request, {
      coderToolApproved: false,
      linkedBrokerLease: {
        linkId: held.hold.linkId,
        id: issued.lease.id,
        token: issued.lease.token,
        provider: issued.lease.provider,
        expiresAt: issued.lease.expiresAt,
        baseUrl: issued.lease.baseUrl,
      },
    }).catch((error) => this.completeUnexpectedFailure(childId, request, error)).finally(async () => {
      const completed = this.options.jobs.get(childId);
      if (completed && isTerminal(completed)) {
        try {
          await this.settleDelegation(completed);
        } catch (error) {
          this.diagnostic(`Live linked settlement for ${childId} was deferred to startup recovery.`, error);
        }
      }
      this.activeJobs -= 1;
      this.executions.delete(execution);
      this.pump();
    });
    this.executions.add(execution);
    this.options.trackExecution?.(execution);
    return { job, existing: false };
  }

  private linkedTargetScope(
    childId: string,
    request: SerializedRunRequest,
    deadlineAt: number,
    replyMarginMs: number,
  ): BrokerLinkedTargetScope {
    const providerId = providerForRequest(request, this.options.env);
    const provider = providerId ? getProvider(providerId) : null;
    if (!providerId || !provider) throw new HeadlessError("AUTH_UNAVAILABLE", "Linked target provider is unavailable.");
    const limits = this.options.budgets.brokerLeaseLimits(childId);
    const remainingMs = Math.max(1, deadlineAt - Date.now());
    return {
      provider: providerId,
      models: delegatedModelScope(request.model, providerId),
      endpointClasses: providerId === "anthropic"
        ? ["messages", "models"]
        : providerId === "gemini"
          ? ["generate", "models"]
          : ["chat", "responses", "embeddings", "models"],
      expiresAt: deadlineAt + replyMarginMs,
      childDeadlineAt: deadlineAt,
      replyMarginMs,
      maxRequests: limits.maxRequests,
      maxInputTokens: limits.maxInputTokens,
      maxOutputTokens: limits.maxOutputTokens,
      maxBodyBytes: 4_000_000,
      maxConcurrentRequests: 4,
      maxInFlightBodyBytes: 16_000_000,
      maxStreamMs: Math.min(remainingMs, 3_600_000),
      maxCostUsd: limits.maxCostUsd,
      budgetQuotas: limits.budgetQuotas,
    };
  }

  async settleDelegation(child: Job) {
    const linkedHold = this.options.budgets.linkedProviderHoldForReservation(child.id);
    if (linkedHold) {
      const pending = this.linkedSettlements.get(child.id);
      if (pending) return pending;
      const settlement = this.settleLinkedDelegation(child, linkedHold);
      this.linkedSettlements.set(child.id, settlement);
      try {
        return await settlement;
      } finally {
        if (this.linkedSettlements.get(child.id) === settlement) this.linkedSettlements.delete(child.id);
      }
    }

    const carve = this.delegationCarves.get(child.id);
    const result = child.result;
    let settled = false;
    if (carve) {
      this.delegationCarves.delete(child.id);
      settled = result ? this.options.broker.settleRunLeaseCarve(carve, {
        requests: result.cost.observedRequests,
        inputTokens: result.usage.input,
        outputTokens: result.usage.output,
        costUsd: result.cost.amountUsd,
      }) : this.options.broker.settleRunLeaseCarve(carve);
    }
    const parent = child.delegationOf ? this.options.jobs.get(child.delegationOf.parentJobId) : null;
    this.auditDelegationCompletion(parent, child);
    return settled;
  }

  private async settleLinkedDelegation(child: Job, initialHold: LinkedHoldRecord) {
    if (!child.result || !isTerminal(child)) {
      throw new HeadlessError("CONFLICT", "Linked delegation settlement requires a terminal durable child result.");
    }
    this.options.broker.revokeLinkedTarget(initialHold.linkId);
    const observation = await this.drainLinkedTarget(initialHold.linkId);
    if (!observation) {
      throw new HeadlessError("CONFLICT", "Linked target settlement evidence is unavailable; startup recovery must fail closed.");
    }
    const decision = linkedSettlementDecision(initialHold, child.result, observation);
    const begun = this.options.budgets.beginLinkedProviderSettlement(initialHold.linkId, decision);
    const finalized = this.options.budgets.finalizeLinkedProviderSettlement(
      initialHold.linkId,
      begun.digest,
      decision.disposition,
    );
    this.options.broker.settleLinkedParent(initialHold.linkId, finalized.unused);
    if (!finalized.existing) {
      const parent = child.delegationOf ? this.options.jobs.get(child.delegationOf.parentJobId) : null;
      this.auditDelegationCompletion(parent, child, {
        linkId: initialHold.linkId,
        settlementState: finalized.hold.state,
        settlementDigest: finalized.hold.terminalSettlementDigest,
      });
    }
    return !finalized.existing;
  }

  private async drainLinkedTarget(linkId: string) {
    const deadline = Date.now() + 1_000;
    let observation = this.options.broker.observeLinkedTarget(linkId);
    while (observation && observation.activeRequests > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      observation = this.options.broker.observeLinkedTarget(linkId);
    }
    return observation;
  }

  private auditDelegationCompletion(parent: Job | null, child: Job, extra: Record<string, unknown> = {}) {
    const result = child.result;
    if (parent) this.delegationPolicyEvent(parent, "allowed", "run-delegation-completed", {
      parentJobId: parent.id,
      childJobId: child.id,
      requestId: child.delegationOf!.requestId,
      status: child.state,
      usage: result?.usage ?? null,
      cost: result?.cost ?? null,
      ...extra,
    });
    if (parent) this.options.auditDelegation?.("headless_result", parent, child, {
      parentJobId: parent.id,
      childJobId: child.id,
      requestId: child.delegationOf!.requestId,
      status: child.state,
      usage: result?.usage ?? null,
      cost: result?.cost ?? null,
      ...extra,
    });
  }

  submit(params: Record<string, unknown>, principal: string, options: JobAdmissionSubmitOptions = {}) {
    if (this.options.isStopping()) {
      throw new HeadlessError("DAEMON_UNAVAILABLE", "Daemon is shutting down and cannot accept new jobs.");
    }
    const bound = this.bindPersistedSession(params, principal);
    const request = RunRequestSchema.parse({
      backend: bound.backend,
      prompt: bound.prompt,
      projectRoot: this.options.projectRoot,
      mode: bound.mode,
      model: bound.model,
      agent: bound.agent,
      timeoutMs: bound.timeoutMs,
      sessionId: bound.sessionId,
      containment: bound.containment,
      authMode: bound.authMode,
      approvalPolicy: bound.approvalPolicy,
    });
    const idempotencyKey = SubmissionIdempotencyKeySchema.nullable().parse(bound.idempotencyKey ?? null);
    const adapter = getBackendDefinition(resolveBackendId(request.backend));
    if (request.agent && !adapter?.supportsNamedAgent) {
      throw new HeadlessError("BACKEND_UNSUPPORTED", `Backend ${request.backend} does not support named agents in contained Headless runs.`);
    }
    if (request.agent) safeAgentName(request.agent, request.backend);
    if (idempotencyKey) {
      const existing = this.options.jobs.findSubmission(principal, idempotencyKey);
      if (existing) {
        const existingRequest = this.options.jobs.request(existing.id);
        if (!existingRequest || JSON.stringify(existingRequest) !== JSON.stringify(request)) {
          throw new HeadlessError("CONFLICT", "The run submission idempotency key is already bound to a different normalized request.");
        }
        this.options.runEvents.append({ jobId: existing.id, sessionId: existing.sessionId }, {
          kind: "policy",
          decision: "allowed",
          rule: "run-submit-idempotent-replay",
          reason: "Returned the durable job already bound to this principal-scoped submission key.",
        });
        return existing;
      }
    }
    if (this.pendingJobs.length + this.waitingApprovalJobs.size >= this.maxQueued) {
      throw new HeadlessError(
        "QUEUE_CAPACITY_EXCEEDED",
        `Project delegation queue is full (${this.maxQueued}).`,
        { retryable: true, details: { maxQueued: this.maxQueued } },
      );
    }
    const job = this.options.jobs.create({
      projectId: this.options.projectId,
      principal,
      request,
      mergePolicy: options.mergePolicy ?? "authorized",
      workflowId: options.workflowId ?? null,
      maxAttempts: options.maxAttempts,
      retryNumber: options.retryNumber ?? 0,
      councilId: options.councilId ?? null,
      councilSlot: options.councilSlot ?? null,
      idempotencyKey,
    });
    return this.admitDurableJob(job, request, true);
  }

  private bindPersistedSession(params: Record<string, unknown>, principal: string) {
    if (typeof params.sessionId !== "string") return params;
    const session = this.options.sessions.get(params.sessionId);
    if (!session) throw new HeadlessError("INVALID_REQUEST", `Unknown session: ${params.sessionId}`);
    if (session.principal !== principal) {
      throw new HeadlessError("POLICY_DENIED", "Session-backed execution cannot cross authenticated principals.");
    }
    const requestedBackend = typeof params.backend === "string" ? resolveBackendId(params.backend) : session.backend;
    if (requestedBackend !== resolveBackendId(session.backend)) {
      throw new HeadlessError("CONFLICT", "Session-backed execution backend conflicts with the persisted session.");
    }
    const conflicts = [
      ["model", session.model],
      ["agent", session.agent],
      ["containment", session.containment],
      ["authMode", session.authMode],
      ["approvalPolicy", session.approvalPolicy],
    ] as const;
    for (const [field, expected] of conflicts) {
      if (params[field] !== undefined && params[field] !== expected) {
        throw new HeadlessError("CONFLICT", `Session-backed execution ${field} conflicts with the persisted session.`);
      }
    }
    if (params.mode !== undefined && params.mode !== "read-only") {
      throw new HeadlessError("CONFLICT", "Persistent sessions support read-only turns only.");
    }
    return {
      ...params,
      backend: session.backend,
      model: session.model ?? undefined,
      agent: session.agent ?? undefined,
      mode: "read-only",
      containment: session.containment,
      authMode: session.authMode,
      approvalPolicy: session.approvalPolicy,
    };
  }

  recoverBudgetReservations() {
    const jobs = new Map(this.options.jobs.list().map((job) => [job.id, job]));
    const reservations = [...this.options.budgets.getState().reservations]
      .sort((left, right) => Number(left.parentReservationId === null) - Number(right.parentReservationId === null));
    for (const reservation of reservations) {
      const job = jobs.get(reservation.id);
      if (!job) {
        this.options.budgets.release(reservation.id);
        continue;
      }
      if (job.state === "queued") {
        if (job.delegationOf !== null) {
          this.options.budgets.failClosedAfterInterruption(reservation.id);
          const request = this.options.jobs.request(job.id);
          if (!request) throw new Error(`Recovered delegated job ${job.id} request is missing.`);
          const completed = this.options.jobs.complete(job.id, {
            ...daemonFailureResult(request, job.id, "Daemon stopped before the delegated child was claimed."),
            status: "blocked",
          });
          this.reconcileTerminalEvents(completed);
          this.options.completed(completed);
          continue;
        }
        if (job.attempt > 1) {
          const request = this.options.jobs.request(job.id);
          this.options.budgets.failClosedAfterInterruption(reservation.id);
          if (!request) throw new Error(`Recovered job ${job.id} request is missing.`);
          this.admitDurableJob(job, request, false);
          continue;
        }
        // A crash can occur after scheduler activation but before the durable
        // claim. The replacement daemon reacquires the slot before execution.
        this.options.budgets.deactivate(reservation.id);
        continue;
      }
      if (job.state === "preparing" || job.state === "running" || job.state === "cancelling") continue;
      if (!job.result) {
        this.options.budgets.release(reservation.id);
        continue;
      }
      if (
        job.result.error?.message === "Daemon stopped while the job lease was active."
        || job.result.error?.message === "Daemon stopped while cancellation was in progress; the job will not be retried."
      ) {
        this.options.budgets.failClosedAfterInterruption(reservation.id);
        continue;
      }
      this.options.budgets.commit(reservation.id, {
        inputTokens: job.result.usage.input,
        outputTokens: job.result.usage.output,
        reasoningTokens: job.result.usage.reasoning,
        cachedTokens: job.result.usage.cached,
        providerTotalTokens: job.result.usage.providerTotal,
        costUsd: job.result.cost.amountUsd,
        costSource: job.result.cost.source,
        pricingId: job.result.cost.pricingId,
        observedRequests: job.result.cost.observedRequests,
        artifactBytes: job.result.diff ? Buffer.byteLength(job.result.diff.patch) : 0,
      });
    }

    // A crash between durable job creation and reservation is reconciled from
    // the immutable request before the job is made runnable again.
    for (const job of this.options.jobs.list()) {
      if (job.state !== "queued" || this.options.budgets.getReservation(job.id)) continue;
      const request = this.options.jobs.request(job.id);
      if (!request) throw new Error(`Queued job ${job.id} request is missing during admission recovery.`);
      this.admitDurableJob(job, request, false);
    }
  }

  recoverQueuedJobs() {
    this.resetQueue();
    for (const job of this.options.jobs.list()) {
      if (job.state !== "queued") continue;
      const request = this.options.jobs.request(job.id);
      if (!request) continue;
      if (!this.options.budgets.getReservation(job.id)) {
        this.admitDurableJob(job, request, false);
        const recovered = this.options.jobs.get(job.id);
        if (!recovered || recovered.state !== "queued" || !this.options.budgets.getReservation(job.id)) continue;
      }
      if (!this.taskForJob(job.id)) {
        this.options.tasks.create({
          jobId: job.id,
          projectId: this.options.projectId,
          capability: `${request.mode}:${request.backend}`,
        });
      }
      const approval = this.coderToolApproval(job, request, true);
      if (approval === "denied") {
        this.completeApprovalDenial(job, request, "Coder-tool approval was not granted before recovery.");
        continue;
      }
      if (approval === "waiting") {
        this.waitForCoderToolApproval(job, request);
        continue;
      }
      this.enqueue(job, request, approval === "approved");
    }
    this.pump();
    return this.load();
  }

  handleApprovalResolution(approval: ApprovalRequest) {
    if (approval.kind === "unpriced_broker_run") return this.handleUnpricedBrokerApproval(approval);
    if (approval.kind !== "coder_tool") return null;
    const job = this.options.jobs.get(approval.collaborationId);
    if (!job || isTerminal(job) || job.state !== "queued") return null;
    const request = this.options.jobs.request(job.id);
    if (!request || !requiresCoderToolApproval(request)) return null;
    const matched = this.options.approvals.list({ collaborationId: job.id })
      .find((candidate) => candidate.id === approval.id
        && candidate.kind === "coder_tool"
        && coderToolApprovalAttempt(candidate) === job.attempt);
    if (!matched) return null;
    this.waitingApprovalJobs.delete(job.id);
    if (approval.status === "approved") {
      if (!this.pendingJobs.some((pending) => pending.id === job.id)) this.enqueue(job, request, true);
      this.emitQueuePositions();
      this.pump();
      return job.id;
    }
    this.completeApprovalDenial(
      job,
      request,
      approval.resolution ?? `Coder-tool approval ${approval.id} was ${approval.status}.`,
    );
    return job.id;
  }

  cancel(jobId: string) {
    const job = this.requireJob(jobId);
    if (isTerminal(job)) return job;
    const child = this.options.jobs.delegatedChild(jobId);
    if (child && !isTerminal(child)) this.cancel(child.id);
    if (job.state === "queued") {
      this.clearQueueDeadline(jobId);
      const index = this.pendingJobs.findIndex((pending) => pending.id === jobId);
      if (index >= 0) this.pendingJobs.splice(index, 1);
      this.waitingApprovalJobs.delete(jobId);
      this.cancelPendingCoderApproval(job, "Job cancelled before coder-tool approval.");
      this.emitQueuePositions();
      if (!this.options.budgets.linkedProviderHoldForReservation(jobId)) this.options.budgets.release(jobId);
      const task = this.taskForJob(jobId);
      if (task && task.state !== "cancelled") {
        this.options.tasks.cancel({ taskId: task.id, principal: job.principal });
      }
      const request = this.options.jobs.request(jobId);
      if (!request) throw new HeadlessError("INTERNAL_ERROR", "Queued job request is missing.");
      const completed = this.options.jobs.complete(jobId, cancelledResult(request, jobId));
      this.reconcileTerminalEvents(completed);
      this.options.completed(completed);
      return completed;
    }
    if (job.state !== "cancelling") this.options.jobs.transition(jobId, "cancelling");
    this.options.runEvents.append({ jobId, sessionId: job.sessionId }, { kind: "lifecycle", state: "cancelling" });
    this.options.abort(jobId);
    return this.requireJob(jobId);
  }

  dispose() {
    this.clearQueueDeadlineTimers();
  }

  async waitForIdle() {
    while (this.executions.size > 0) {
      await Promise.allSettled([...this.executions]);
    }
  }

  private admitDurableJob(job: Job, request: SerializedRunRequest, enqueue: boolean) {
    this.options.runEvents.append({ jobId: job.id, sessionId: request.sessionId }, { kind: "lifecycle", state: "queued" });
    if (request.mode === "write" && request.containment === "unsafe") {
      return this.completeAdmission(job, blockedResult(
        request,
        job.id,
        "POLICY_DENIED",
        "Daemon-owned writes require strict containment; unsafe write execution is prohibited.",
      ), "containment");
    }
    if (request.approvalPolicy === "bypass" && request.containment !== "required") {
      return this.completeAdmission(job, blockedResult(
        request,
        job.id,
        "POLICY_DENIED",
        "Approval bypass is permitted only inside required outer containment.",
      ), "bypass-containment");
    }
    const adapter = getBackendDefinition(resolveBackendId(request.backend));
    if (request.authMode === "native-login" && adapter?.security.strictAuth !== "credential-free") {
      const trust = this.options.trust.status();
      if (!trust.trusted || !trust.nativeLoginAllowed || !trust.nativeDirectUnrestrictedAcknowledged || (request.approvalPolicy === "bypass" && !trust.bypassAllowed)) {
        const reason = request.approvalPolicy === "bypass" && trust.trusted
          ? "Approval bypass has not been granted for this trusted project."
          : "Native login requires project trust and explicit acknowledgement of unrestricted provider egress.";
        return this.completeAdmission(job, blockedResult(request, job.id, "NATIVE_AUTH_UNAVAILABLE", reason), "project-trust");
      }
    }
    if (request.authMode === "broker" && adapter?.security.strictAuth === "broker-api-key") {
      if (!request.model) {
        return this.completeAdmission(job, blockedResult(
          request,
          job.id,
          "AUTH_UNAVAILABLE",
          `Backend ${request.backend} requires an explicit model so its broker lease can be model-scoped.`,
        ), "broker-auth");
      }
      const providerId = providerForRequest(request, this.options.env);
      const provider = providerId ? getProvider(providerId) : null;
      if (!provider || !this.options.env[provider.credentialEnv]) {
        return this.completeAdmission(job, blockedResult(
          request,
          job.id,
          "AUTH_UNAVAILABLE",
          `Backend ${request.backend} requires an API-key provider available through the daemon broker. OAuth and keychain sessions are not imported.`,
        ), "broker-auth");
      }
    }
    const estimate = estimateRequestResources(request, this.options.env);
    const unpricedBrokerNeedsApproval = request.authMode === "broker"
      && adapter?.security.strictAuth === "broker-api-key"
      && estimate.cost.amountUsd === null
      && !this.options.budgets.hasCostLimit({
        projectId: this.options.projectId,
        principal: job.principal,
        sessionId: request.sessionId ?? null,
        workflowId: job.workflowId,
        provider: providerForRequest(request, this.options.env),
      });
    if (unpricedBrokerNeedsApproval) {
      const approval = this.unpricedBrokerApproval(job, request);
      if (approval === "waiting") {
        this.waitForUnpricedBrokerApproval(job, request);
        return job;
      }
      if (approval === "denied") {
        return this.completeAdmission(
          job,
          blockedResult(request, job.id, "APPROVAL_REQUIRED", "Unknown broker pricing was not explicitly approved for this run."),
          "unpriced-broker-run",
        );
      }
    }
    const authorization = this.options.authority.authorize({
      projectId: this.options.projectId,
      principal: job.principal,
      operation: request.mode === "write" ? "write" : "run",
      backend: request.backend,
      estimatedCostUsd: estimate.cost.amountUsd,
      merge: false,
    });
    if (!authorization.allowed) {
      return this.completeAdmission(job, blockedResult(request, job.id, "POLICY_DENIED", authorization.reason), "authority");
    }
    try {
      this.options.authority.consumeIteration(authorization.grantId, job.id);
    } catch (error) {
      return this.completeAdmission(job, blockedResult(request, job.id, "POLICY_DENIED", error instanceof Error ? error.message : String(error)), "authority-iteration");
    }
    const reservation = this.options.budgets.reserve({
      id: job.id,
      projectId: this.options.projectId,
      principal: job.principal,
      sessionId: request.sessionId ?? null,
      workflowId: job.workflowId,
      provider: providerForRequest(request, this.options.env),
      inputTokens: estimate.inputTokens,
      outputTokens: estimate.outputTokens,
      costUsd: estimate.cost.amountUsd,
      artifactBytes: 0,
      retries: job.retryNumber + Math.max(0, job.attempt - 1),
    });
    if (!reservation.allowed) {
      return this.completeAdmission(
        job,
        blockedResult(request, job.id, "BUDGET_EXCEEDED", reservation.reasons.join(" ")),
        "budget",
      );
    }
    if (!this.taskForJob(job.id)) {
      this.options.tasks.create({
        jobId: job.id,
        projectId: this.options.projectId,
        capability: `${request.mode}:${request.backend}`,
      });
    }
    if (enqueue) {
      const approval = this.coderToolApproval(job, request, true);
      if (approval === "waiting") {
        this.waitForCoderToolApproval(job, request);
      } else if (approval === "denied") {
        return this.completeApprovalDenial(job, request, "Coder-tool approval was not granted.");
      } else {
        this.enqueue(job, request, approval === "approved");
        this.emitQueuePositions();
        this.pump();
      }
    }
    return job;
  }

  private pump() {
    if (this.options.isStopping()) return;
    while (this.activeJobs < this.maxConcurrency && this.pendingJobs.length > 0) {
      // Writes remain serialized while read-only work may use other slots.
      // Budget concurrency is activated only when a worker can actually start.
      let index = -1;
      for (let candidate = 0; candidate < this.pendingJobs.length; candidate += 1) {
        const pending = this.pendingJobs[candidate];
        const job = this.options.jobs.get(pending.id);
        if (!job || job.state !== "queued") {
          this.pendingJobs.splice(candidate, 1);
          candidate -= 1;
          continue;
        }
        if (pending.request.mode === "write" && this.activeWrites > 0) continue;
        try {
          const activation = this.options.budgets.activate(
            pending.id,
            job.retryNumber + Math.max(0, job.attempt - 1),
          );
          if (!activation.allowed) {
            if (activation.reasons.some((reason) => reason.includes("retry limit exceeded"))) {
              this.pendingJobs.splice(candidate, 1);
              candidate -= 1;
              this.options.budgets.release(pending.id);
              const task = this.taskForJob(pending.id);
              if (task && (task.state === "pending" || task.state === "claimed")) {
                this.options.tasks.resolveFromDaemon({ taskId: task.id, principal: job.principal, outcome: "failed" });
              }
              this.completeAdmission(
                job,
                blockedResult(pending.request, pending.id, "BUDGET_EXCEEDED", activation.reasons.join(" ")),
                "budget-retry",
              );
            }
            continue;
          }
        } catch (error) {
          this.pendingJobs.splice(candidate, 1);
          candidate -= 1;
          this.completeUnexpectedFailure(pending.id, pending.request, error);
          continue;
        }
        index = candidate;
        break;
      }
      if (index < 0) return;
      const [next] = this.pendingJobs.splice(index, 1);
      this.emitQueuePositions();
      const job = this.options.jobs.get(next.id);
      if (!job || job.state !== "queued") continue;
      if (jobDeadlineAt(job, next.request) <= Date.now()) {
        this.expireQueuedJob(next.id, next.request);
        continue;
      }
      this.clearQueueDeadline(next.id);
      this.activeJobs += 1;
      if (next.request.mode === "write") this.activeWrites += 1;
      const execution = this.options.execute(next.id, next.request, { coderToolApproved: next.coderToolApproved })
        .catch((error) => this.completeUnexpectedFailure(next.id, next.request, error))
        .finally(() => {
          this.activeJobs -= 1;
          if (next.request.mode === "write") this.activeWrites -= 1;
          this.executions.delete(execution);
          this.pump();
        });
      this.executions.add(execution);
      this.options.trackExecution?.(execution);
    }
  }

  private emitQueuePositions() {
    for (const [index, pending] of this.pendingJobs.entries()) {
      const job = this.options.jobs.get(pending.id);
      if (!job || job.state !== "queued") continue;
      this.options.runEvents.append({ jobId: job.id, sessionId: job.sessionId }, {
        kind: "lifecycle",
        state: "queued",
        detail: `queue position ${index + 1} of ${this.pendingJobs.length}`,
      });
    }
  }

  private scheduleQueueDeadline(jobId: string, request: SerializedRunRequest) {
    this.clearQueueDeadline(jobId);
    const job = this.options.jobs.get(jobId);
    if (!job || job.state !== "queued") return;
    const remainingMs = jobDeadlineAt(job, request) - Date.now();
    if (remainingMs <= 0) {
      this.expireQueuedJob(jobId, request);
      return;
    }
    const timer = setTimeout(() => {
      this.queueDeadlineTimers.delete(jobId);
      this.expireQueuedJob(jobId, request);
      this.pump();
    }, remainingMs);
    timer.unref?.();
    this.queueDeadlineTimers.set(jobId, timer);
  }

  private clearQueueDeadline(jobId: string) {
    const timer = this.queueDeadlineTimers.get(jobId);
    if (timer) clearTimeout(timer);
    this.queueDeadlineTimers.delete(jobId);
  }

  private clearQueueDeadlineTimers() {
    for (const timer of this.queueDeadlineTimers.values()) clearTimeout(timer);
    this.queueDeadlineTimers.clear();
  }

  private resetQueue() {
    this.clearQueueDeadlineTimers();
    this.pendingJobs.length = 0;
    this.waitingApprovalJobs.clear();
  }

  private expireQueuedJob(jobId: string, request: SerializedRunRequest) {
    this.clearQueueDeadline(jobId);
    const job = this.options.jobs.get(jobId);
    if (!job || job.state !== "queued") return job;
    const index = this.pendingJobs.findIndex((pending) => pending.id === jobId);
    if (index >= 0) this.pendingJobs.splice(index, 1);
    this.waitingApprovalJobs.delete(jobId);
    this.cancelPendingCoderApproval(job, "Job timed out before coder-tool approval.");
    if (!this.options.budgets.linkedProviderHoldForReservation(jobId)) this.options.budgets.release(jobId);
    const task = this.taskForJob(jobId);
    if (task && (task.state === "pending" || task.state === "claimed")) {
      this.options.tasks.resolveFromDaemon({ taskId: task.id, principal: job.principal, outcome: "failed" });
    }
    const completed = this.options.jobs.complete(jobId, timedOutResult(
      request,
      jobId,
      Math.max(0, Date.now() - job.createdAt),
      "Job exceeded its total lifecycle timeout while queued.",
    ));
    this.reconcileTerminalEvents(completed);
    this.options.completed(completed);
    return completed;
  }

  private coderToolApproval(
    job: Job,
    request: SerializedRunRequest,
    create: boolean,
  ): "not-required" | "waiting" | "approved" | "denied" {
    if (!requiresCoderToolApproval(request)) return "not-required";
    const approvals = this.options.approvals.list({ collaborationId: job.id });
    const existing = [...approvals]
      .reverse()
      .find((approval) => approval.kind === "coder_tool" && coderToolApprovalAttempt(approval) === job.attempt);
    if (existing) {
      if (existing.status === "pending") return "waiting";
      return existing.status === "approved" ? "approved" : "denied";
    }
    if (!create || jobDeadlineAt(job, request) <= Date.now()) return "denied";
    for (const stale of approvals) {
      if (stale.kind !== "coder_tool" || stale.status !== "pending") continue;
      this.options.approvals.cancel(
        stale.id,
        job.principal,
        `Coder-tool approval superseded by durable job attempt ${job.attempt}.`,
      );
    }
    this.options.approvals.create({
      collaborationId: job.id,
      requestedBy: job.principal,
      assignedTo: job.principal,
      kind: "coder_tool",
      summary: "Approve mutating coder tools for this contained write turn.",
      details: {
        jobId: job.id,
        backend: request.backend,
        sessionId: request.sessionId ?? null,
        mode: request.mode,
        attempt: job.attempt,
        scope: "single-write-turn",
      },
      artifactIds: [job.id],
      expiresAt: jobDeadlineAt(job, request),
    });
    return "waiting";
  }

  private unpricedBrokerApproval(job: Job, request: SerializedRunRequest) {
    const approvals = this.options.approvals.list({ collaborationId: job.id });
    const existing = [...approvals].reverse().find((approval) => approval.kind === "unpriced_broker_run");
    if (existing) {
      if (existing.status === "pending") return "waiting" as const;
      return existing.status === "approved" ? "approved" as const : "denied" as const;
    }
    if (jobDeadlineAt(job, request) <= Date.now()) return "denied" as const;
    this.options.approvals.create({
      collaborationId: job.id,
      requestedBy: job.principal,
      assignedTo: job.principal,
      kind: "unpriced_broker_run",
      summary: "Approve one broker run whose USD price cannot be determined from trusted pricing data.",
      details: {
        jobId: job.id,
        backend: request.backend,
        model: request.model ?? null,
        scope: "single-broker-run",
        maxRequests: 8,
        maxInputTokens: 200_000,
        maxOutputTokens: 32_000,
        cost: "unknown",
      },
      artifactIds: [job.id],
      expiresAt: jobDeadlineAt(job, request),
    });
    return "waiting" as const;
  }

  private waitForUnpricedBrokerApproval(job: Job, request: SerializedRunRequest) {
    this.waitingApprovalJobs.add(job.id);
    this.scheduleQueueDeadline(job.id, request);
    this.options.runEvents.append({ jobId: job.id, sessionId: request.sessionId }, {
      kind: "policy",
      decision: "deferred",
      rule: "unpriced-broker-run",
      reason: "Broker execution is waiting for explicit approval because trusted model pricing is unavailable.",
    });
  }

  private handleUnpricedBrokerApproval(approval: ApprovalRequest) {
    const job = this.options.jobs.get(approval.collaborationId);
    if (!job || isTerminal(job) || job.state !== "queued") return null;
    const request = this.options.jobs.request(job.id);
    if (!request || request.authMode !== "broker") return null;
    this.waitingApprovalJobs.delete(job.id);
    if (approval.status === "approved") return this.admitDurableJob(job, request, true).id;
    this.completeAdmission(
      job,
      blockedResult(request, job.id, "APPROVAL_REQUIRED", approval.resolution ?? "Unknown broker pricing was not approved."),
      "unpriced-broker-run",
    );
    return job.id;
  }

  private waitForCoderToolApproval(job: Job, request: SerializedRunRequest) {
    this.waitingApprovalJobs.add(job.id);
    this.scheduleQueueDeadline(job.id, request);
    this.options.runEvents.append({ jobId: job.id, sessionId: request.sessionId }, {
      kind: "policy",
      decision: "deferred",
      rule: "coder-tool-approval",
      reason: "Contained write execution is waiting for one-turn coder-tool approval.",
    });
    this.options.runEvents.append({ jobId: job.id, sessionId: request.sessionId }, {
      kind: "lifecycle",
      state: "queued",
      detail: "waiting for coder-tool approval",
    });
  }

  private enqueue(job: Job, request: SerializedRunRequest, coderToolApproved: boolean) {
    this.waitingApprovalJobs.delete(job.id);
    if (!this.pendingJobs.some((pending) => pending.id === job.id)) {
      this.pendingJobs.push({ id: job.id, request, coderToolApproved });
    }
    this.scheduleQueueDeadline(job.id, request);
  }

  private completeApprovalDenial(job: Job, request: SerializedRunRequest, reason: string) {
    this.clearQueueDeadline(job.id);
    this.waitingApprovalJobs.delete(job.id);
    const index = this.pendingJobs.findIndex((pending) => pending.id === job.id);
    if (index >= 0) this.pendingJobs.splice(index, 1);
    this.options.budgets.release(job.id);
    const task = this.taskForJob(job.id);
    if (task && (task.state === "pending" || task.state === "claimed")) {
      this.options.tasks.resolveFromDaemon({ taskId: task.id, principal: job.principal, outcome: "failed" });
    }
    return this.completeAdmission(
      job,
      blockedResult(request, job.id, "POLICY_DENIED", reason),
      "coder-tool-approval",
    );
  }

  private cancelPendingCoderApproval(job: Job, reason: string) {
    const pending = this.options.approvals.list({ collaborationId: job.id, status: "pending" })
      .find((approval) => approval.kind === "coder_tool" && coderToolApprovalAttempt(approval) === job.attempt);
    if (pending) this.options.approvals.cancel(pending.id, job.principal, reason);
  }

  private completeAdmission(job: Job, result: RunResult, rule: string) {
    const completed = this.options.jobs.complete(job.id, result);
    try {
      this.options.runEvents.append({ jobId: job.id, sessionId: job.sessionId }, {
        kind: "policy",
        decision: "denied",
        rule,
        reason: result.error?.message ?? "Admission denied.",
      });
    } catch (error) {
      this.diagnostic(`Admission policy event for ${job.id} was not persisted.`, error);
    }
    this.reconcileTerminalEvents(completed);
    this.options.completed(completed);
    return completed;
  }

  private completeUnexpectedFailure(jobId: string, request: SerializedRunRequest, error: unknown) {
    this.clearQueueDeadline(jobId);
    let job = this.options.jobs.get(jobId);
    if (!job || isTerminal(job)) return;
    if (job.state === "queued") {
      try {
        job = this.options.jobs.claim(jobId, `daemon:${process.pid}`, 1_000);
      } catch (claimError) {
        this.diagnostic(
          `Unexpected-failure recovery could not claim queued job ${jobId}: ${messageOf(claimError)}`,
        );
      }
    }
    if (!this.options.budgets.linkedProviderHoldForReservation(jobId)) this.options.budgets.release(jobId);
    const result = job.state === "queued"
      ? { ...daemonFailureResult(request, jobId, error), status: "blocked" as const }
      : daemonFailureResult(request, jobId, error);
    const task = this.taskForJob(jobId);
    if (task && (task.state === "pending" || task.state === "claimed")) {
      this.options.tasks.resolveFromDaemon({ taskId: task.id, principal: job.principal, outcome: "failed" });
    }
    const completed = this.options.jobs.complete(jobId, result);
    this.reconcileTerminalEvents(completed);
    this.options.completed(completed);
  }

  private reconcileTerminalEvents(job: Job) {
    if (!job.result) return;
    try {
      this.options.runEvents.reconcileTerminal(
        { jobId: job.id, sessionId: job.sessionId },
        job.result,
        job.updatedAt,
      );
    } catch (error) {
      this.diagnostic(`Terminal event reconciliation for ${job.id} was deferred to daemon recovery.`, error);
    }
  }

  private taskForJob(jobId: string) {
    return this.options.tasks.list({ jobId })[0] ?? null;
  }

  private requireJob(jobId: string) {
    const job = this.options.jobs.get(jobId);
    if (!job) throw new HeadlessError("INVALID_REQUEST", `Unknown job: ${jobId}`);
    return job;
  }

  private delegationPolicyEvent(
    parent: Job,
    decision: "allowed" | "denied" | "deferred",
    rule: string,
    details: Record<string, unknown>,
  ) {
    this.options.runEvents.append({ jobId: parent.id, sessionId: parent.sessionId }, {
      kind: "policy",
      decision,
      rule,
      reason: JSON.stringify(details),
    });
  }

  private delegationDenied(parent: Job, audit: Record<string, unknown>, message: string) {
    this.delegationPolicyEvent(parent, "denied", "run-delegation-policy", { ...audit, error: message });
    return new HeadlessError("POLICY_DENIED", message);
  }

  private diagnostic(message: string, error?: unknown) {
    if (this.options.diagnostic) {
      this.options.diagnostic(message, error);
      return;
    }
    const suffix = error === undefined ? "" : ` ${messageOf(error)}`;
    console.error(redactAndTruncate(`${message}${suffix}`, 2_048).text);
  }
}

export function daemonFailureResult(request: SerializedRunRequest, jobId: string, error: unknown): RunResult {
  const message = messageOf(error);
  return {
    status: "failed",
    error: { code: "INTERNAL_ERROR", message: redactAndTruncate(message, 16_384).text, retryable: false },
    backend: request.backend,
    output: redactAndTruncate(message).text,
    stderr: "",
    diagnostics: { format: "daemon", malformedEvents: 0, ignoredEvents: 0, messages: [] },
    exitCode: null,
    signal: null,
    usage: { input: null, output: null, reasoning: null, cached: null, providerTotal: null },
    cost: { amountUsd: null, source: "unknown", pricingId: null, observedRequests: 0 },
    containment: {
      requirement: request.containment,
      enforced: false,
      platform: platform(),
      mechanism: null,
      probe: null,
      isolatedHome: false,
      credentialsIsolated: false,
      network: request.containment === "unsafe" ? "unrestricted" : "denied",
      credentialAccess: "none",
      unsafe: request.containment === "unsafe",
    },
    durationMs: 0,
    sessionId: request.sessionId ?? null,
    jobId,
    diff: null,
    commit: null,
    truncation: { stdout: false, stderr: false, output: false, events: false, artifacts: false, diff: false },
  };
}

export function blockedResult(
  request: SerializedRunRequest,
  jobId: string,
  code: "POLICY_DENIED" | "BUDGET_EXCEEDED" | "AUTH_UNAVAILABLE" | "NATIVE_AUTH_UNAVAILABLE" | "APPROVAL_REQUIRED" | "QUEUE_CAPACITY_EXCEEDED",
  message: string,
): RunResult {
  return {
    ...daemonFailureResult(request, jobId, message),
    status: "blocked",
    error: { code, message: redactAndTruncate(message, 16_384).text, retryable: false },
  };
}

export function timedOutResult(
  request: SerializedRunRequest,
  jobId: string,
  durationMs: number,
  message = "Job exceeded its total lifecycle timeout.",
): RunResult {
  const safe = redactAndTruncate(message, 16_384).text;
  return {
    ...daemonFailureResult(request, jobId, safe),
    status: "timed_out",
    error: { code: "TIMED_OUT", message: safe, retryable: false },
    output: safe,
    durationMs: Math.max(0, Math.trunc(durationMs)),
  };
}

export function jobDeadlineAt(job: Job, request: SerializedRunRequest) {
  return Math.min(Number.MAX_SAFE_INTEGER, job.createdAt + request.timeoutMs);
}

export function providerForRequest(request: SerializedRunRequest, env: Readonly<NodeJS.ProcessEnv> = process.env) {
  if (request.authMode === "native-login") return null;
  const adapter = getBackendDefinition(request.backend);
  if (adapter?.security.strictAuth === "credential-free") return null;
  if (adapter?.provider) return adapter.provider;
  const prefix = request.model?.split("/", 1)[0]?.toLowerCase();
  if (prefix && getProvider(prefix)) return prefix;
  if (prefix === "anthropic") return "anthropic";
  if (prefix === "google" || prefix === "gemini") return "gemini";
  if (prefix === "xai") return "xai";
  if (prefix === "openai") return "openai";
  for (const id of ["openai", "anthropic", "gemini", "xai"] as const) {
    const definition = getProvider(id);
    if (definition && env[definition.credentialEnv]) return id;
  }
  return null;
}

export function estimateRequestResources(request: SerializedRunRequest, env: Readonly<NodeJS.ProcessEnv> = process.env) {
  return estimateRunCost({
    provider: providerForRequest(request, env),
    model: request.model,
    prompt: request.prompt,
  });
}

export function delegatedApprovalPolicy(parent: Job["approvalPolicy"]): "ask" | "auto" {
  return parent === "ask" ? "ask" : "auto";
}

function fractionAllocation(envelope: BudgetReservation["envelope"], fraction: number) {
  return {
    requests: Math.max(1, Math.floor(envelope.requests * fraction)),
    inputTokens: fractionCountNullable(envelope.inputTokens, fraction),
    outputTokens: fractionCountNullable(envelope.outputTokens, fraction),
    costUsd: fractionNullable(envelope.costUsd, fraction),
    artifactBytes: Math.floor(envelope.artifactBytes * fraction),
    retries: Math.floor(envelope.retries * fraction),
  };
}

function fractionNullable(value: number | null, fraction: number) {
  return value === null ? null : value * fraction;
}

function fractionCountNullable(value: number | null, fraction: number) {
  return value === null ? null : Math.floor(value * fraction);
}

function brokerAllocation(envelope: BudgetReservation["envelope"]) {
  return {
    requests: envelope.requests,
    inputTokens: envelope.inputTokens,
    outputTokens: envelope.outputTokens,
    costUsd: envelope.costUsd,
  };
}

function delegationRequestDigest(request: SerializedRunRequest) {
  return createHash("sha256").update(JSON.stringify({
    backend: request.backend,
    model: request.model,
    agent: request.agent,
    projectRoot: request.projectRoot,
    mode: request.mode,
    timeoutMs: request.timeoutMs,
    containment: request.containment,
    authMode: request.authMode,
    approvalPolicy: request.approvalPolicy,
  })).digest("hex");
}

function delegatedModelScope(model: string | undefined, provider: string) {
  if (!model) return ["default"];
  const values = new Set([model]);
  if (model.startsWith(`${provider}/`)) values.add(model.slice(provider.length + 1));
  if (provider === "gemini" && model.startsWith("google/")) values.add(model.slice("google/".length));
  return [...values];
}

function linkedTargetQuotaEvidence(scope: BrokerLeaseScope) {
  const [runQuota] = scope.budgetQuotas;
  if (!runQuota) throw new Error("Linked target lease is missing its deterministic run quota.");
  return {
    provider: scope.provider,
    runQuotaId: runQuota.id,
    budgetQuotaIds: scope.budgetQuotas.map((quota) => quota.id),
    maxRequests: scope.maxRequests,
    maxInputTokens: runQuota.maxInputTokens,
    maxOutputTokens: runQuota.maxOutputTokens,
    maxCostUsd: scope.maxCostUsd,
  };
}

function linkedSettlementDecision(
  hold: LinkedHoldRecord,
  result: RunResult,
  observation: NonNullable<ReturnType<ProviderBroker["observeLinkedTarget"]>>,
): {
  disposition: "settled" | "exhausted";
  usage: LinkedHoldUsageProjection;
  observation: NonNullable<ReturnType<ProviderBroker["observeLinkedTarget"]>>;
} {
  if (!observation.revoked || observation.activeRequests !== 0) {
    return { disposition: "exhausted", usage: exhaustedLinkedUsage(hold), observation };
  }
  if (result.status !== "succeeded") {
    return zeroEgress(observation)
      ? { disposition: "settled", usage: zeroLinkedUsage(), observation }
      : { disposition: "exhausted", usage: exhaustedLinkedUsage(hold), observation };
  }
  if (zeroEgress(observation) && result.cost.observedRequests === 0) {
    return { disposition: "settled", usage: zeroLinkedUsage(), observation };
  }

  const requests = Math.max(result.cost.observedRequests, observation.requests, observation.forwardedRequests);
  const inputTokens = conservativeLinkedAmount(result.usage.input, observation.accountedInputTokens, requests);
  const outputTokens = conservativeLinkedAmount(result.usage.output, observation.accountedOutputTokens, requests);
  const brokerCost = Math.max(observation.observedCostUsd, observation.accountedCostUsd);
  const costUsd = result.cost.amountUsd === null
    ? brokerCost > 0 ? brokerCost : requests > 0 ? null : 0
    : Math.max(result.cost.amountUsd, brokerCost);
  const artifactBytes = result.diff ? Buffer.byteLength(result.diff.patch) : 0;
  const usage: LinkedHoldUsageProjection = {
    requests,
    inputTokens,
    outputTokens,
    reasoningTokens: result.usage.reasoning,
    cachedTokens: result.usage.cached,
    providerTotalTokens: result.usage.providerTotal,
    costUsd,
    costSource: brokerCost > (result.cost.amountUsd ?? 0) ? "broker" : result.cost.source,
    pricingId: result.cost.pricingId,
    artifactBytes,
  };
  return linkedUsageFits(hold, usage)
    ? { disposition: "settled", usage, observation }
    : { disposition: "exhausted", usage: exhaustedLinkedUsage(hold), observation };
}

function zeroEgress(observation: NonNullable<ReturnType<ProviderBroker["observeLinkedTarget"]>>) {
  return observation.requests === 0
    && observation.forwardedRequests === 0
    && observation.observedCostUsd === 0
    && observation.accountedCostUsd === 0
    && observation.accountedInputTokens === 0
    && observation.accountedOutputTokens === 0
    && observation.activeRequests === 0
    && observation.revoked;
}

function conservativeLinkedAmount(reported: number | null, brokerBound: number, requests: number) {
  if (reported === null) return brokerBound > 0 ? brokerBound : requests > 0 ? null : 0;
  return Math.max(reported, brokerBound);
}

function linkedUsageFits(hold: LinkedHoldRecord, usage: LinkedHoldUsageProjection) {
  return usage.requests <= hold.targetReservation.requests
    && nullableUsageFits(usage.inputTokens, hold.targetReservation.inputTokens)
    && nullableUsageFits(usage.outputTokens, hold.targetReservation.outputTokens)
    && nullableUsageFits(usage.costUsd, hold.targetReservation.costUsd)
    && usage.artifactBytes <= hold.targetReservation.artifactBytes;
}

function nullableUsageFits(actual: number | null, allocation: number | null) {
  if (allocation === null) return true;
  return actual !== null && actual <= allocation;
}

function zeroLinkedUsage(): LinkedHoldUsageProjection {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    providerTotalTokens: 0,
    costUsd: 0,
    costSource: "broker",
    pricingId: null,
    artifactBytes: 0,
  };
}

function exhaustedLinkedUsage(hold: LinkedHoldRecord): LinkedHoldUsageProjection {
  return {
    requests: hold.targetReservation.requests,
    inputTokens: hold.targetReservation.inputTokens,
    outputTokens: hold.targetReservation.outputTokens,
    reasoningTokens: null,
    cachedTokens: null,
    providerTotalTokens: null,
    costUsd: hold.targetReservation.costUsd,
    costSource: "unknown",
    pricingId: null,
    artifactBytes: hold.targetReservation.artifactBytes,
  };
}

function cancelledResult(request: SerializedRunRequest, jobId: string): RunResult {
  return {
    ...daemonFailureResult(request, jobId, "Job cancelled before execution."),
    status: "cancelled",
    error: { code: "CANCELLED", message: "Job cancelled before execution.", retryable: false },
  };
}

function requiresCoderToolApproval(request: SerializedRunRequest) {
  return request.mode === "write" && request.approvalPolicy === "ask";
}

function coderToolApprovalAttempt(approval: ApprovalRequest) {
  const attempt = approval.details.attempt;
  return typeof attempt === "number" && Number.isSafeInteger(attempt) && attempt > 0 ? attempt : null;
}

function isTerminal(job: Job) {
  return ["succeeded", "failed", "timed_out", "cancelled", "blocked"].includes(job.state);
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function platform(): RunResult["containment"]["platform"] {
  if (process.platform === "darwin" || process.platform === "linux" || process.platform === "win32") return process.platform;
  return "other";
}
