import { createHash, randomUUID } from "node:crypto";
import { getProvider } from "../broker/providers";
import { BrokerLeaseScopeSchema, type ProviderBroker } from "../broker/server";
import { getBackendDefinition, resolveBackendId, type BackendDefinition } from "../backends/registry";
import type { DurableSession, FinalityDecision, Job } from "../contracts/durable";
import type { RunResult, SerializedRunRequest } from "../contracts/run";
import {
  defaultExecutionSupervisor,
  type ExecutionSupervisor,
} from "../runner/simple";
import type { ApprovalStore } from "../runtime/approval-store";
import type { AuthorityStore } from "../runtime/authority-store";
import type { BudgetStore } from "../runtime/budget-store";
import { cleanupWithDiagnostic, recordRuntimeDiagnostic } from "../runtime/diagnostics";
import type { FinalityStore } from "../runtime/finality-store";
import type { IntegrationJournal } from "../runtime/integration-journal";
import { recordArtifact } from "../runtime/ledger-api";
import { isAuditedNativeSessionDriverBackend, type NativeSessionManager } from "../runtime/native-session-manager";
import type { PersistentSessionStore } from "../runtime/persistent-sessions";
import { calculateModelPricedCost } from "../runtime/pricing";
import type { ProjectStateOptions, ProjectStatePaths } from "../runtime/project-state";
import { redactAndTruncate } from "../runtime/redaction";
import { runReleaseGate, type GateCheck } from "../runtime/release-gate";
import {
  assembleAndAnchorReceipt,
  receiptBrokerLeaseSnapshot,
  receiptGateManifest,
  type ReceiptAuthorizationSnapshot,
  type ReceiptBrokerLeaseSnapshot,
  type ReceiptGateManifestEntry,
  type ReceiptProvenanceContext,
} from "../runtime/receipt-service";
import type { ReceiptStore } from "../runtime/receipt-store";
import { appendEvent, getOrCreateSession, type HeadlessSession } from "../runtime/session";
import type { WorktreeLeaseStore } from "../runtime/worktree-leases";
import type { WriteGateContext, WriteGateDecision } from "../runtime/write-integration";
import {
  blockedResult,
  daemonFailureResult,
  jobDeadlineAt,
  providerForRequest,
  timedOutResult,
} from "./job-admission-service";
import type { JobStore } from "./job-store";
import type { RunEventStore } from "./run-event-store";
import { DELEGATED_RUN_TOOL_OPERATIONS, DEPTH_ZERO_RUN_TOOL_OPERATIONS, type RunToolEndpoint, type RunToolEndpointManager } from "./run-tool-endpoint";
import { reviewCandidateDiff } from "./candidate-service";
import type { TaskStore } from "./task-store";
import { experimentalExecResultToRunResult } from "../experimental/run-result-converter";

export type RunExecutionServiceOptions = {
  paths: ProjectStatePaths;
  stateOptions?: ProjectStateOptions;
  jobs: JobStore;
  tasks: TaskStore;
  runEvents: RunEventStore;
  sessions: PersistentSessionStore;
  nativeSessions: NativeSessionManager;
  approvals: ApprovalStore;
  authority: AuthorityStore;
  budgets: BudgetStore;
  finality: FinalityStore;
  broker: ProviderBroker;
  runTools: RunToolEndpointManager;
  worktreeLeases: WorktreeLeaseStore;
  integrationJournal: IntegrationJournal;
  receipts: ReceiptStore;
  receiptProvenance: ReceiptProvenanceContext;
  writeGateChecks: readonly GateCheck[];
  completed: (job: Job) => void;
  supervisor?: Pick<ExecutionSupervisor, "execute">;
};

export type RunExecutionControls = {
  /** A durable admin-resolved grant for mutating coder tools in this one turn. */
  coderToolApproved?: boolean;
  /** Mint-once cross-provider bearer, passed only on the synchronous admission call stack. */
  linkedBrokerLease?: {
    linkId: string;
    id: string;
    token: string;
    provider: string;
    expiresAt: number;
    baseUrl: string;
  };
};

const DEFAULT_BROKER_MAX_REQUESTS = 8;
const DEFAULT_BROKER_MAX_INPUT_TOKENS = 200_000;
const DEFAULT_BROKER_MAX_OUTPUT_TOKENS = 32_000;
const DEFAULT_BROKER_MAX_COST_USD = 5;

/**
 * Owns one-shot run execution after durable admission has selected a job.
 *
 * Admission and queue ordering remain separate. This boundary owns process
 * cancellation, provider/run-tool leases, usage reconciliation, write gates,
 * finality/audit persistence, and the single terminal job completion.
 */
export class RunExecutionService {
  private readonly controllers = new Map<string, AbortController>();
  private readonly supervisor;

  constructor(private readonly options: RunExecutionServiceOptions) {
    this.supervisor = options.supervisor ?? defaultExecutionSupervisor;
  }

  cancel(jobId: string, reason = "cancel requested") {
    const controller = this.controllers.get(jobId);
    if (!controller) return false;
    controller.abort(reason);
    return true;
  }

  cancelAll(reason = "daemon stopping") {
    const jobIds = [...this.controllers.keys()];
    for (const jobId of jobIds) this.cancel(jobId, reason);
    return jobIds;
  }

  activeJobIds() {
    return [...this.controllers.keys()];
  }

  async execute(jobId: string, request: SerializedRunRequest, controls: RunExecutionControls = {}) {
    const startingJob = this.requireJob(jobId);
    const linkedHold = this.options.budgets.linkedProviderHoldForReservation(jobId);
    if (controls.linkedBrokerLease) {
      if (!linkedHold
        || linkedHold.linkId !== controls.linkedBrokerLease.linkId
        || linkedHold.state !== "leased"
        || linkedHold.childJobId !== jobId
        || linkedHold.targetProvider !== controls.linkedBrokerLease.provider) {
        throw new Error("Linked target bearer does not match the daemon-owned leased child.");
      }
    } else if (linkedHold) {
      throw new Error("Linked target bearer is unavailable and cannot be reproduced.");
    }
    const principal = startingJob.principal;
    const reservation = this.options.budgets.getReservation(jobId);
    if (!reservation) throw new Error(`Job ${jobId} has no durable budget reservation.`);
    // Reuse the exact admission estimate at every authorization checkpoint.
    // Repricing between queue admission and execution must not silently widen
    // a grant or change the authority under which a write reaches primary.
    const estimatedCostUsd = reservation.costUsd;
    const deadlineAt = jobDeadlineAt(startingJob, request);
    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    let deadlineExceeded = false;
    const deadlineTimer = setTimeout(() => {
      deadlineExceeded = true;
      controller.abort("total job lifecycle timeout exceeded");
    }, Math.max(1, deadlineAt - Date.now()));
    deadlineTimer.unref?.();
    let result: RunResult = daemonFailureResult(request, jobId, "Daemon execution did not produce a result.");
    let brokerLease: ReturnType<ProviderBroker["issueLease"]> | null = null;
    let runToolEndpoint: RunToolEndpoint | null = null;
    let budgetCommitted = false;
    let budgetPassed = true;
    let budgetReasons: string[] = [];
    let budgetCost: RunResult["cost"] | null = null;
    let budgetUsage: RunResult["usage"] | null = null;
    const writeGates: WriteGateDecision[] = [];
    let writeOutcome: string | null = null;
    let durableWriteFinality: FinalityDecision | null = null;
    let writeAuthorization: ReturnType<AuthorityStore["authorize"]> | null = null;
    let executionAuthorization: ReturnType<AuthorityStore["authorize"]> | null = null;
    let receiptStartedAt: number | null = null;
    let receiptAuthorization: ReceiptAuthorizationSnapshot | null = null;
    let receiptBrokerLease: ReceiptBrokerLeaseSnapshot | null = null;
    const receiptGates: ReceiptGateManifestEntry[] = [];
    let receiptCaptureFailure: unknown = null;
    const writeAuditSession = request.mode === "write" ? getOrCreateSession({
      cwd: this.options.paths.canonicalProjectRoot,
      state: this.options.stateOptions,
      authenticatedPrincipal: principal,
      sessionId: request.sessionId,
    }) : null;
    try {
      this.options.runEvents.append({ jobId, sessionId: request.sessionId }, { kind: "lifecycle", state: "preparing" });
      this.options.jobs.claim(jobId, `daemon:${process.pid}`, Math.max(1, deadlineAt - Date.now()) + 10_000);
      const task = this.taskForJob(jobId);
      if (task?.state === "pending") this.options.tasks.claim({
        taskId: task.id,
        principal,
        leaseMs: Math.min(86_400_000, request.timeoutMs + 300_000),
      });
      this.options.jobs.transition(jobId, "running");
      receiptStartedAt = Date.now();
      this.options.runEvents.append({ jobId, sessionId: request.sessionId }, { kind: "lifecycle", state: "running" });
      executionAuthorization = this.options.authority.authorize({
        projectId: this.options.paths.projectId,
        principal,
        operation: request.mode === "write" ? "write" : "run",
        backend: request.backend,
        estimatedCostUsd,
        merge: false,
      });
      if (executionAuthorization.allowed) {
        try {
          receiptAuthorization = authorizationReceiptSnapshot(executionAuthorization, this.options.authority);
        } catch (error) {
          receiptCaptureFailure ??= error;
          recordRuntimeDiagnostic("state", "receipt.authorization-snapshot", error);
        }
      }
      if (request.mode === "write") writeAuthorization = executionAuthorization;
      if (!executionAuthorization.allowed) {
        result = blockedResult(request, jobId, "POLICY_DENIED", executionAuthorization.reason || "Run authorization expired before execution.");
      } else {
        const durableSession = request.sessionId ? this.options.sessions.get(request.sessionId) : null;
        const remainingRunMs = deadlineAt - Date.now();
        if (remainingRunMs <= 0) {
          deadlineExceeded = true;
          result = timedOutResult(request, jobId, Math.max(0, Date.now() - startingJob.createdAt), "Job exceeded its total lifecycle timeout during preparation.");
        } else {
          const issuedBrokerLease = !controls.linkedBrokerLease && request.authMode === "broker"
            ? this.issueBrokerLease(jobId, request, deadlineAt, executionAuthorization.maxCostUsd)
            : null;
          brokerLease = controls.linkedBrokerLease
            ? { ...controls.linkedBrokerLease }
            : issuedBrokerLease?.lease ?? null;
          if (brokerLease) {
            try {
              const linkedTarget = controls.linkedBrokerLease
                ? this.options.broker.linkedOperationSnapshot(controls.linkedBrokerLease.linkId).target
                : null;
              const scope = controls.linkedBrokerLease
                ? linkedTarget?.kind === "target" ? linkedTarget.targetQuotaScope : null
                : issuedBrokerLease?.scope ?? null;
              if (!scope) throw new Error(`Broker lease scope is unavailable for receipt ${jobId}.`);
              receiptBrokerLease = receiptBrokerLeaseSnapshot(scope);
            } catch (error) {
              receiptCaptureFailure ??= error;
              recordRuntimeDiagnostic("state", "receipt.broker-scope-snapshot", error);
            }
          }
          const useNativePersistentSession = !!durableSession
            && request.authMode === "native-login"
            && request.mode === "read-only"
            && isAuditedNativeSessionDriverBackend(durableSession.backend);
          const adapter = getBackendDefinition(resolveBackendId(request.backend));
          if (request.containment === "required" && !useNativePersistentSession) {
            runToolEndpoint = await this.options.runTools.issue({
              projectId: this.options.paths.projectId,
              jobId,
              sessionId: request.sessionId ?? jobId,
              principal,
              expiresAt: deadlineAt + 10_000,
            }, startingJob.delegationOf === null ? DEPTH_ZERO_RUN_TOOL_OPERATIONS : DELEGATED_RUN_TOOL_OPERATIONS);
          }
          const legacy = useNativePersistentSession
            ? await this.options.nativeSessions.turn(durableSession, request.prompt, remainingRunMs, controller.signal)
            : await this.supervisor.execute({
                backend: resolveBackendId(request.backend),
                prompt: request.prompt,
                cwd: this.options.paths.canonicalProjectRoot,
                mode: request.mode,
                model: request.model,
                agent: request.agent,
                timeoutMs: remainingRunMs,
                containment: request.containment,
                signal: controller.signal,
                onStdoutChunk: (chunk) => {
                  this.options.runEvents.append({ jobId, sessionId: request.sessionId }, { kind: "stdout", text: chunk, truncated: false });
                },
                sessionId: request.sessionId,
                authMode: request.authMode,
                approvalPolicy: controls.coderToolApproved ? "auto" : request.approvalPolicy,
                jobId,
                resumeNativeSessionId: resumableNativeSessionId(request, durableSession, adapter),
                broker: brokerLease ? {
                  provider: brokerLease.provider,
                  baseUrl: brokerLease.baseUrl,
                  token: brokerLease.token,
                  unixSocket: this.options.broker.unixSocketPath ?? undefined,
                } : undefined,
                runTool: runToolEndpoint ? {
                  socketPath: runToolEndpoint.socketPath,
                  token: runToolEndpoint.token,
                  expiresAt: runToolEndpoint.scope.expiresAt,
                  jobId,
                  sessionId: runToolEndpoint.scope.sessionId,
                  operations: runToolEndpoint.operations,
                } : undefined,
                worktreeLease: request.mode === "write" ? this.options.worktreeLeases.createHooks(jobId) : undefined,
                writeIntegration: request.mode === "write" ? {
                  actor: principal,
                  grantId: writeAuthorization?.grantId ?? null,
                  autoMerge: request.approvalPolicy !== "ask"
                    && writeAuthorization?.mergeAllowed === true
                    && this.options.jobs.get(jobId)?.mergePolicy === "authorized",
                  signal: controller.signal,
                  reauthorize: async (checkpoint) => {
                    const current = this.options.authority.authorize({
                      projectId: this.options.paths.projectId,
                      principal,
                      operation: "write",
                      backend: request.backend,
                      estimatedCostUsd,
                      merge: checkpoint === "primary-mutation",
                    });
                    writeAuthorization = current;
                    return { allowed: current.allowed, reason: current.reason };
                  },
                  preparePrimaryUpdate: async (update) => {
                    this.options.integrationJournal.prepare({
                      ...update,
                      jobId,
                      sessionId: request.sessionId ?? null,
                      principal,
                      grantId: writeAuthorization?.grantId ?? null,
                    });
                  },
                  recordPrimaryUpdate: async (update) => {
                    this.options.integrationJournal.markApplied(jobId, update.resultingCommit);
                  },
                  evaluateGates: async (context) => {
                    if (!budgetCommitted) {
                      const brokerObservation = brokerLease ? this.options.broker.getLeaseObservation(brokerLease.id) : null;
                      budgetUsage = conservativeBudgetUsage(context.execution.usage, brokerObservation);
                      const executionCost = reconcileCost(
                        context.execution.costUsd === null
                          ? { amountUsd: null, source: "unknown", pricingId: null, observedRequests: 0 }
                          : { amountUsd: context.execution.costUsd, source: "provider", pricingId: null, observedRequests: 0 },
                        context.execution.usage,
                        request,
                        brokerObservation,
                      );
                      budgetCost = conservativeBudgetCost(executionCost, brokerObservation);
                      const committed = this.options.budgets.commit(jobId, {
                        inputTokens: budgetUsage.input,
                        outputTokens: budgetUsage.output,
                        reasoningTokens: budgetUsage.reasoning,
                        cachedTokens: budgetUsage.cached,
                        providerTotalTokens: budgetUsage.providerTotal,
                        ...budgetCostFields(budgetCost),
                        artifactBytes: Buffer.byteLength(context.diff.diff),
                      });
                      budgetCommitted = true;
                      budgetPassed = committed.passed;
                      budgetReasons = committed.reasons;
                    }
                    if (!budgetPassed) {
                      const denied = failedWriteGate(budgetReasons.join(" "), { policyPassed: true });
                      durableWriteFinality = persistWriteGateFinality(
                        this.options.finality,
                        this.options.paths.projectId,
                        jobId,
                        principal,
                        denied,
                      );
                      appendPreMergeDecision(writeAuditSession!, {
                        jobId,
                        principal,
                        authorization: writeAuthorization,
                        context,
                        gate: denied,
                        finality: durableWriteFinality,
                      });
                      writeGates.push(denied);
                      return denied;
                    }
                    const gate = await runReleaseGate({
                      checks: [...this.options.writeGateChecks],
                      cwd: context.cwd,
                      primaryRoot: this.options.paths.canonicalProjectRoot,
                      timeoutMs: Math.min(request.timeoutMs, 120_000),
                      signal: controller.signal,
                      recordArtifact: false,
                    });
                    try {
                      receiptGates.push(...receiptGateManifest(context.phase, gate.checks));
                    } catch (error) {
                      receiptCaptureFailure ??= error;
                      recordRuntimeDiagnostic("state", "receipt.gate-manifest", error);
                    }
                    const review = reviewCandidateDiff(context.diff);
                    const decision: WriteGateDecision = {
                      policyPassed: true,
                      testsPassed: gate.ok,
                      reviewPassed: review.passed,
                      votePassed: false,
                      budgetPassed,
                      reasons: [
                        ...(gate.ok ? [] : ["Configured candidate checks failed."]),
                        ...review.reasons,
                      ],
                      evidence: [
                        ...gate.checks.map((check) => `${context.phase}:${check.name}:${check.ok ? "PASS" : "FAIL"}`),
                        ...review.evidence,
                      ],
                    };
                    // This durable decision is the final precondition for either the
                    // candidate fast-forward or an advanced-head integration update.
                    // If persistence throws, integrateWriteCandidate treats the gate
                    // callback as failed and leaves primary untouched.
                    durableWriteFinality = persistWriteGateFinality(
                      this.options.finality,
                      this.options.paths.projectId,
                      jobId,
                      principal,
                      decision,
                    );
                    // The verified ledger is also a pre-merge requirement. A failed
                    // append throws through evaluateSafely, turning this into a failed
                    // gate before the primary checkout can be updated.
                    appendPreMergeDecision(writeAuditSession!, {
                      jobId,
                      principal,
                      authorization: writeAuthorization,
                      context,
                      gate: decision,
                      finality: durableWriteFinality,
                    });
                    writeGates.push(decision);
                    return decision;
                  },
                } : undefined,
              });
          if (useNativePersistentSession && legacy.output) {
            this.options.runEvents.append(
              { jobId, sessionId: request.sessionId },
              { kind: "stdout", text: legacy.output, truncated: !!legacy.truncated },
            );
          }
          result = experimentalExecResultToRunResult(legacy, request, jobId);
          writeOutcome = legacy.writeOutcome ?? null;
          if (brokerLease && typeof legacy.cost === "number" && legacy.cost >= 0) {
            this.options.broker.observeCost(brokerLease.id, legacy.cost);
          }
          result = {
            ...result,
            cost: reconcileCost(
              result.cost,
              result.usage,
              request,
              brokerLease ? this.options.broker.getLeaseObservation(brokerLease.id) : null,
            ),
          };
          budgetUsage = conservativeBudgetUsage(
            result.usage,
            brokerLease ? this.options.broker.getLeaseObservation(brokerLease.id) : null,
          );
          budgetCost = conservativeBudgetCost(
            result.cost,
            brokerLease ? this.options.broker.getLeaseObservation(brokerLease.id) : null,
          );
        }
      }
    } catch (error) {
      result = daemonFailureResult(request, jobId, error);
      budgetUsage = conservativeBudgetUsage(
        result.usage,
        brokerLease ? this.options.broker.getLeaseObservation(brokerLease.id) : null,
      );
      budgetCost = conservativeBudgetCost(
        result.cost,
        brokerLease ? this.options.broker.getLeaseObservation(brokerLease.id) : null,
      );
    } finally {
      clearTimeout(deadlineTimer);
      this.controllers.delete(jobId);
      if (runToolEndpoint) {
        await cleanupWithDiagnostic("run-execution.run-tool-revoke", async () => {
          await this.options.runTools.revoke(runToolEndpoint!.id);
        });
      }
      if (brokerLease) {
        budgetUsage ??= conservativeBudgetUsage(result.usage, this.options.broker.getLeaseObservation(brokerLease.id));
        if (controls.linkedBrokerLease) this.options.broker.revokeLinkedTarget(controls.linkedBrokerLease.linkId);
        else this.options.broker.revokeLease(brokerLease.id);
      }
    }
    const current = this.options.jobs.get(jobId);
    if (current?.state === "cancelling" && result.status !== "cancelled") {
      result = { ...result, status: "cancelled", error: { code: "CANCELLED", message: "Job cancelled.", retryable: false } };
    } else if (deadlineExceeded && result.status !== "timed_out") {
      result = {
        ...result,
        status: "timed_out",
        error: { code: "TIMED_OUT", message: "Job exceeded its total lifecycle timeout.", retryable: false },
        durationMs: Math.max(result.durationMs, Date.now() - startingJob.createdAt),
      };
    }
    if (!budgetCommitted && !linkedHold) {
      try {
        const committedUsage = budgetUsage ?? result.usage;
        const budget = this.options.budgets.commit(jobId, {
          inputTokens: committedUsage.input,
          outputTokens: committedUsage.output,
          reasoningTokens: committedUsage.reasoning,
          cachedTokens: committedUsage.cached,
          providerTotalTokens: committedUsage.providerTotal,
          ...budgetCostFields(budgetCost ?? result.cost),
          artifactBytes: result.diff ? Buffer.byteLength(result.diff.patch) : 0,
        });
        budgetPassed = budget.passed;
        budgetReasons = budget.reasons;
        budgetCommitted = true;
      } catch (error) {
        budgetPassed = false;
        const reason = redactAndTruncate(`Budget reconciliation failed: ${messageOf(error)}`, 2_048).text;
        budgetReasons = [reason];
        recordRuntimeDiagnostic("state", "budget-reconciliation", error);
        try {
          this.options.runEvents.append({ jobId, sessionId: request.sessionId }, {
            kind: "policy",
            decision: "denied",
            rule: "budget-reconciliation",
            reason,
          });
        } catch (diagnosticError) {
          recordRuntimeDiagnostic("state", "budget-reconciliation-event", diagnosticError);
        }
      }
    }
    const writeGateState = aggregateWriteGates(writeGates, budgetPassed);
    const awaitingMergeApproval = request.mode === "write"
      && request.approvalPolicy === "ask"
      && !result.commit?.merged
      && !!result.commit?.candidate
      && writeOutcome === "preserved_no_merge_authority";
    if (request.mode === "write" && !result.commit?.merged && !awaitingMergeApproval) writeGateState.policyPassed = false;
    let finality: FinalityDecision;
    try {
      const preMergeDecision = durableWriteFinality as FinalityDecision | null;
      finality = request.mode === "write" && (result.commit?.merged || awaitingMergeApproval) && preMergeDecision?.allowed
        ? preMergeDecision
        : this.options.finality.evaluate({
            projectId: this.options.paths.projectId,
            jobId,
            decidedBy: principal,
            requirements: request.mode === "write"
              ? { policy: true, tests: true, review: true, vote: false, budget: true }
              : { policy: true, tests: false, review: false, vote: false, budget: true },
            gates: request.mode === "write"
              ? writeGateState
              : { policyPassed: true, testsPassed: false, reviewPassed: false, votePassed: false, budgetPassed },
          });
    } catch (error) {
      const message = `Finality persistence failed: ${redactAndTruncate(messageOf(error), 4_096).text}`;
      finality = failedFinalityDecision(this.options.paths.projectId, jobId, principal, message, budgetPassed);
      result = {
        ...result,
        status: "blocked",
        error: { code: "GATE_FAILED", message, retryable: false },
      };
    }
    if (!finality.allowed && result.status === "succeeded") {
      result = {
        ...result,
        status: "blocked",
        error: { code: budgetPassed ? "GATE_FAILED" : "BUDGET_EXCEEDED", message: finality.reasons.join(" "), retryable: false },
      };
    }
    if (awaitingMergeApproval && finality.allowed) {
      const approval = this.ensureApprovalRequest(
        jobId,
        principal,
        "merge",
        "Approve integration of the gated candidate commit.",
        {
          candidateId: jobId,
          baseCommit: result.commit?.base ?? null,
          candidateCommit: result.commit?.candidate ?? null,
          resultingCommit: result.commit?.result ?? null,
        },
      );
      result = {
        ...result,
        status: "blocked",
        error: {
          code: "APPROVAL_REQUIRED",
          message: `Candidate ${jobId} passed gates and is awaiting merge approval ${approval.id}.`,
          retryable: false,
          details: { approvalId: approval.id, candidateId: jobId },
        },
      };
    }
    const auditErrors: string[] = [];
    if (request.mode === "write") {
      try {
        appendEvent(writeAuditSession!, {
          type: "finality_decision",
          source: principal,
          runId: jobId,
          content: finality.allowed ? "Write finality gates passed." : finality.reasons.join(" "),
          meta: {
            phase: "terminal",
            actor: principal,
            grantId: writeAuthorization?.grantId ?? null,
            rootAuthority: writeAuthorization?.root ?? false,
            outcome: writeOutcome,
            baseCommit: result.commit?.base ?? null,
            candidateCommit: result.commit?.candidate ?? null,
            resultingCommit: result.commit?.result ?? null,
            merged: result.commit?.merged ?? false,
            usage: result.usage,
            cost: result.cost,
            gates: writeGates,
            finality,
          },
        });
      } catch (error) {
        auditErrors.push(`Terminal write audit append failed: ${messageOf(error)}`);
      }
    }
    if (request.mode === "write" && result.commit) {
      try {
        recordArtifact({
          cwd: this.options.paths.canonicalProjectRoot,
          state: this.options.stateOptions,
          authenticatedPrincipal: principal,
          sessionId: request.sessionId,
          kind: "write_integration",
          title: result.commit.merged ? "Merged write candidate" : "Preserved write candidate",
          summary: result.commit.merged
            ? "Candidate passed finality and was integrated."
            : (result.error?.message ?? "Candidate was preserved without modifying primary."),
          status: result.commit.merged ? "passed" : "blocked",
          evidence: [
            `base:${result.commit.base ?? "unknown"}`,
            `candidate:${result.commit.candidate ?? "unknown"}`,
            `result:${result.commit.result ?? "unchanged"}`,
            `grant:${writeAuthorization?.grantId ?? (writeAuthorization?.root ? "root" : "none")}`,
            ...budgetReasons,
            ...writeGates.flatMap((gate, index) => [
              `gate-${index + 1}:policy:${gate.policyPassed ? "PASS" : "FAIL"}`,
              `gate-${index + 1}:tests:${gate.testsPassed ? "PASS" : "FAIL"}`,
              `gate-${index + 1}:review:${gate.reviewPassed ? "PASS" : "FAIL"}`,
              `gate-${index + 1}:budget:${gate.budgetPassed ? "PASS" : "FAIL"}`,
            ]),
          ],
        });
      } catch (error) {
        auditErrors.push(`Write artifact append failed: ${messageOf(error)}`);
      }
    }
    if (auditErrors.length > 0) {
      result = {
        ...result,
        diagnostics: {
          ...result.diagnostics,
          messages: [
            ...result.diagnostics.messages,
            ...auditErrors.map((message) => redactAndTruncate(message, 2_048).text),
          ].slice(0, 64),
        },
      };
    }
    const claimedTask = this.taskForJob(jobId);
    if (claimedTask && (claimedTask.state === "pending" || claimedTask.state === "claimed")) {
      this.options.tasks.resolveFromDaemon({
        taskId: claimedTask.id,
        principal,
        outcome: result.status === "succeeded" ? "completed" : "failed",
      });
    }
    const completed = this.options.jobs.complete(jobId, result);
    if (result.stderr) {
      try {
        this.options.runEvents.append(
          { jobId, sessionId: request.sessionId },
          { kind: "stderr", text: result.stderr, truncated: result.truncation.stderr },
        );
      } catch (error) {
        recordRuntimeDiagnostic("state", "terminal-stderr-event", error);
      }
    }
    try {
      this.options.runEvents.append({ jobId, sessionId: request.sessionId }, { kind: "usage", usage: result.usage, cost: result.cost });
    } catch (error) {
      recordRuntimeDiagnostic("state", "terminal-usage-event", error);
    }
    try {
      this.options.runEvents.reconcileTerminal(
        { jobId, sessionId: request.sessionId },
        completed.result!,
        completed.updatedAt,
      );
    } catch (error) {
      // The terminal job/result is authoritative. Startup reconciliation will
      // deterministically repair missing lifecycle/completion projections.
      recordRuntimeDiagnostic("state", "terminal-run-event-reconciliation", error);
    }
    if (process.env.HEADLESS_RECEIPTS !== "off" && executionAuthorization?.allowed === true) {
      try {
        if (receiptCaptureFailure) throw receiptCaptureFailure;
        if (receiptStartedAt === null) throw new Error(`Receipt start checkpoint is unavailable for run ${jobId}.`);
        if (receiptAuthorization === null) throw new Error(`Receipt authorization checkpoint is unavailable for run ${jobId}.`);
        assembleAndAnchorReceipt({
          paths: this.options.paths,
          stateOptions: this.options.stateOptions,
          receipts: this.options.receipts,
          provenance: this.options.receiptProvenance,
        }, {
          jobId,
          sessionId: request.sessionId ?? null,
          principal,
          request,
          result: completed.result!,
          policyEvents: this.options.runEvents.snapshot({ jobId, limit: 1_000 }).events,
          authorization: { ...receiptAuthorization, finality },
          brokerLease: receiptBrokerLease,
          gates: receiptGates,
          budget: {
            passed: budgetPassed,
            reasons: budgetReasons,
            usage: budgetUsage ?? result.usage,
            cost: budgetCost ?? result.cost,
            reservationId: reservation.id,
          },
          startedAt: receiptStartedAt,
          endedAt: completed.updatedAt,
        });
      } catch (error) {
        // Receipts are evidence about a completed run, never part of its
        // authority or terminal outcome. Evidence failure is diagnostic-only.
        recordRuntimeDiagnostic("state", "receipt.assemble-and-anchor", error);
      }
    }
    if (result.commit?.merged && result.commit.result) {
      try {
        this.options.integrationJournal.markCompleted(jobId, result.commit.result);
      } catch (error) {
        // The fsynced prepared/applied journal remains open and startup
        // reconciliation will finish this audit record deterministically.
        recordRuntimeDiagnostic("state", "integration-journal-completion", error);
        try {
          this.options.runEvents.append({ jobId, sessionId: request.sessionId }, {
            kind: "policy",
            decision: "deferred",
            rule: "integration-journal-recovery",
            reason: "Integration applied, but its completion marker requires deterministic startup recovery.",
          });
        } catch (diagnosticError) {
          recordRuntimeDiagnostic("state", "integration-journal-recovery-event", diagnosticError);
        }
      }
    }
    this.options.completed(completed);
  }

  private requireJob(jobId: string) {
    const job = this.options.jobs.get(jobId);
    if (!job) throw new Error(`Unknown job: ${jobId}`);
    return job;
  }

  private taskForJob(jobId: string) {
    return this.options.tasks.list({ jobId })[0] ?? null;
  }

  private ensureApprovalRequest(
    collaborationId: string,
    principal: string,
    kind: "coder_tool" | "merge",
    summary: string,
    details: Record<string, unknown>,
  ) {
    const existing = this.options.approvals.list({ collaborationId, assignedTo: principal })
      .find((approval) => approval.kind === kind && approval.status === "pending");
    if (existing) return existing;
    return this.options.approvals.create({
      collaborationId,
      requestedBy: principal,
      assignedTo: principal,
      kind,
      summary,
      details,
      expiresAt: Date.now() + 86_400_000,
    });
  }

  private issueBrokerLease(
    jobId: string,
    request: SerializedRunRequest,
    deadlineAt: number,
    grantCostLimitUsd: number | null,
  ) {
    const providerId = providerForRequest(request);
    const provider = providerId ? getProvider(providerId) : null;
    if (!providerId || !provider || !process.env[provider.credentialEnv]) return null;
    const models = modelScope(request.model, providerId);
    const limits = this.options.budgets.brokerLeaseLimits(jobId);
    const trustedPrice = request.model
      ? calculateModelPricedCost({
          provider: providerId,
          model: request.model,
          usage: {
            input: DEFAULT_BROKER_MAX_INPUT_TOKENS,
            output: DEFAULT_BROKER_MAX_OUTPUT_TOKENS,
            reasoning: null,
            cached: 0,
            providerTotal: DEFAULT_BROKER_MAX_INPUT_TOKENS + DEFAULT_BROKER_MAX_OUTPUT_TOKENS,
          },
        }).amountUsd !== null
      : false;
    const maxCostUsd = trustedPrice
      ? minimumNullable(minimumNullable(limits.maxCostUsd, grantCostLimitUsd), DEFAULT_BROKER_MAX_COST_USD)
      : null;
    const leaseRemainingMs = Math.max(1, deadlineAt - Date.now());
    const scope = BrokerLeaseScopeSchema.parse({
      runId: jobId,
      provider: providerId,
      models,
      endpointClasses: providerId === "anthropic"
        ? ["messages", "models"]
        : providerId === "gemini"
          ? ["generate", "models"]
          : ["chat", "responses", "embeddings", "models"],
      expiresAt: Date.now() + leaseRemainingMs + 10_000,
      maxRequests: Math.min(DEFAULT_BROKER_MAX_REQUESTS, limits.maxRequests),
      maxBodyBytes: 4_000_000,
      maxStreamMs: Math.min(leaseRemainingMs, 3_600_000),
      maxCostUsd,
      budgetQuotas: [
        {
          id: `headless-run-${createHash("sha256").update(jobId).digest("hex")}`,
          maxRequests: Math.min(DEFAULT_BROKER_MAX_REQUESTS, limits.maxRequests),
          usedRequests: 0,
          maxInputTokens: limits.maxInputTokens ?? DEFAULT_BROKER_MAX_INPUT_TOKENS,
          usedInputTokens: 0,
          maxOutputTokens: limits.maxOutputTokens ?? DEFAULT_BROKER_MAX_OUTPUT_TOKENS,
          usedOutputTokens: 0,
          maxCostUsd,
          usedCostUsd: 0,
        },
        ...limits.budgetQuotas,
      ],
    });
    return { lease: this.options.broker.issueLease(scope), scope };
  }
}

/**
 * A write turn has a fresh leased worktree and a self-contained prompt, so a
 * read-only native thread must never be resumed into it. Only adapters with an
 * explicit audited one-shot resume command may receive an id for read turns.
 */
export function resumableNativeSessionId(
  request: Pick<SerializedRunRequest, "mode">,
  session: DurableSession | null,
  adapter: BackendDefinition | undefined,
) {
  if (request.mode !== "read-only" || !session || session.replay || !adapter?.buildResumeCommand) return undefined;
  return session.nativeSessionId ?? undefined;
}

function authorizationReceiptSnapshot(
  decision: ReturnType<AuthorityStore["authorize"]>,
  authority: AuthorityStore,
): ReceiptAuthorizationSnapshot {
  const source = decision.root ? "root" : decision.grantId === null ? "foreground_lead" : "grant";
  const grant = decision.grantId === null
    ? null
    : authority.getState().grants.find((candidate) => candidate.id === decision.grantId) ?? null;
  if (decision.grantId !== null && !grant) {
    throw new Error(`Authorized grant ${decision.grantId} is unavailable at the receipt checkpoint.`);
  }
  return {
    source,
    mergeAllowed: decision.mergeAllowed,
    maxCostUsd: decision.maxCostUsd,
    grantId: decision.grantId,
    grantTerms: grant ? {
      operations: [...grant.operations],
      backends: [...grant.backends],
      expiresAt: grant.expiresAt,
      maxCostUsd: grant.maxCostUsd,
      maxIterations: grant.maxIterations,
    } : null,
    finality: null,
  };
}

function appendPreMergeDecision(session: HeadlessSession, input: {
  jobId: string;
  principal: string;
  authorization: ReturnType<AuthorityStore["authorize"]> | null;
  context: WriteGateContext;
  gate: WriteGateDecision;
  finality: FinalityDecision;
}) {
  const diffHash = createHash("sha256").update(input.context.diff.diff).digest("hex");
  appendEvent(session, {
    type: "finality_decision",
    source: input.principal,
    runId: input.jobId,
    content: input.finality.allowed
      ? `Pre-merge ${input.context.phase} gates passed.`
      : input.finality.reasons.join(" "),
    meta: {
      phase: input.context.phase,
      preMerge: true,
      actor: input.principal,
      grantId: input.authorization?.grantId ?? null,
      rootAuthority: input.authorization?.root ?? false,
      baseCommit: input.context.baseCommit,
      candidateCommit: input.context.candidateCommit,
      diffSha256: diffHash,
      diffBytes: Buffer.byteLength(input.context.diff.diff),
      files: input.context.diff.files.length,
      usage: input.context.execution.usage,
      costUsd: input.context.execution.costUsd,
      gate: input.gate,
      finality: input.finality,
    },
  });
}

function failedWriteGate(reason: string, overrides: Partial<WriteGateDecision> = {}): WriteGateDecision {
  return {
    policyPassed: false,
    testsPassed: false,
    reviewPassed: false,
    votePassed: false,
    budgetPassed: false,
    reasons: [reason || "Write gate failed."],
    evidence: [],
    ...overrides,
  };
}

function persistWriteGateFinality(
  store: FinalityStore,
  projectId: string,
  jobId: string,
  principal: string,
  gate: WriteGateDecision,
) {
  return store.evaluate({
    projectId,
    jobId,
    decidedBy: principal,
    requirements: { policy: true, tests: true, review: true, vote: false, budget: true },
    gates: {
      policyPassed: gate.policyPassed,
      testsPassed: gate.testsPassed,
      reviewPassed: gate.reviewPassed,
      votePassed: gate.votePassed,
      budgetPassed: gate.budgetPassed,
    },
  });
}

function failedFinalityDecision(
  projectId: string,
  jobId: string,
  principal: string,
  reason: string,
  budgetPassed: boolean,
): FinalityDecision {
  return {
    id: `finality_failure_${randomUUID()}`,
    projectId,
    jobId,
    allowed: false,
    policyPassed: false,
    budgetPassed,
    testsPassed: false,
    reviewPassed: false,
    votePassed: false,
    reasons: [reason],
    decidedBy: principal,
    createdAt: Date.now(),
  };
}

function aggregateWriteGates(gates: WriteGateDecision[], budgetPassed: boolean) {
  if (gates.length === 0) {
    return { policyPassed: false, testsPassed: false, reviewPassed: false, votePassed: false, budgetPassed };
  }
  return {
    policyPassed: gates.every((gate) => gate.policyPassed),
    testsPassed: gates.every((gate) => gate.testsPassed),
    reviewPassed: gates.every((gate) => gate.reviewPassed),
    votePassed: gates.every((gate) => gate.votePassed),
    budgetPassed: budgetPassed && gates.every((gate) => gate.budgetPassed),
  };
}

function modelScope(model: string | undefined, provider: string) {
  if (!model) return ["default"];
  const values = new Set([model]);
  if (model.startsWith(`${provider}/`)) values.add(model.slice(provider.length + 1));
  if (provider === "gemini" && model.startsWith("google/")) values.add(model.slice("google/".length));
  return [...values];
}

function minimumNullable(left: number | null, right: number | null) {
  if (left === null) return right;
  if (right === null) return left;
  return Math.min(left, right);
}

function reconcileCost(
  reported: RunResult["cost"],
  usage: RunResult["usage"],
  request: SerializedRunRequest,
  observation: ReturnType<ProviderBroker["getLeaseObservation"]>,
): RunResult["cost"] {
  const observedRequests = observation?.requests ?? 0;
  if (reported.amountUsd !== null) {
    return {
      ...reported,
      source: observedRequests > 0 ? "reconciled" : reported.source,
      observedRequests,
    };
  }
  const provider = observation?.provider;
  if (!provider || !request.model) return { amountUsd: null, source: "unknown", pricingId: null, observedRequests };
  return calculateModelPricedCost({ provider, model: request.model, usage, observedRequests });
}

function budgetCostFields(cost: RunResult["cost"]) {
  return {
    costUsd: cost.amountUsd,
    costSource: cost.source,
    pricingId: cost.pricingId,
    observedRequests: cost.observedRequests,
  };
}

function conservativeBudgetCost(
  attributed: RunResult["cost"],
  observation: ReturnType<ProviderBroker["getLeaseObservation"]>,
): RunResult["cost"] {
  const brokerBound = observation?.accountedCostUsd ?? 0;
  const observedRequests = Math.max(attributed.observedRequests, observation?.requests ?? 0);
  if (brokerBound <= 0) return { ...attributed, observedRequests };
  return {
    amountUsd: attributed.amountUsd === null ? brokerBound : Math.max(attributed.amountUsd, brokerBound),
    source: "broker",
    pricingId: attributed.pricingId,
    observedRequests,
  };
}

function conservativeBudgetUsage(
  attributed: RunResult["usage"],
  observation: ReturnType<ProviderBroker["getLeaseObservation"]>,
): RunResult["usage"] {
  const accountedInput = observation?.accountedInputTokens ?? 0;
  const accountedOutput = observation?.accountedOutputTokens ?? 0;
  return {
    ...attributed,
    input: accountedInput > 0
      ? attributed.input === null ? accountedInput : Math.max(attributed.input, accountedInput)
      : attributed.input,
    output: accountedOutput > 0
      ? attributed.output === null ? accountedOutput : Math.max(attributed.output, accountedOutput)
      : attributed.output,
  };
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
