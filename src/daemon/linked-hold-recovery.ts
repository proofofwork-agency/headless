import type { BrokerLinkedOperation, ProviderBroker } from "../broker/server";
import type { Job } from "../contracts/durable";
import type { LinkedHoldRecord, LinkedHoldSettlementObservation } from "../contracts/linked-hold";
import type { BudgetReservation, BudgetStore } from "../runtime/budget-store";
import { HeadlessError } from "../runtime/headless-error";
import { linkedProviderHoldId, linkedProviderOperationIds } from "../runtime/linked-provider-ids";
import type { JobStore } from "./job-store";

export type LinkedHoldRecoveryOptions = {
  budgets: BudgetStore;
  broker: ProviderBroker;
  jobs: JobStore;
};

/**
 * Reconcile every cross-provider journal before any ordinary job recovery or
 * broker listener starts. Any ambiguity is persisted and blocks readiness.
 */
export function recoverLinkedProviderHolds(options: LinkedHoldRecoveryOptions) {
  const failures: string[] = [];
  const initial = options.budgets.getState().linkedHolds;
  const consumingByParent = new Map<string, LinkedHoldRecord[]>();
  for (const hold of initial) {
    if (!consumesChildSlot(hold)) continue;
    const group = consumingByParent.get(hold.parentJobId) ?? [];
    group.push(hold);
    consumingByParent.set(hold.parentJobId, group);
  }
  for (const [parentJobId, holds] of consumingByParent) {
    if (holds.length < 2) continue;
    for (const hold of holds) recordFailure(options.budgets, hold, `Parent ${parentJobId} has more than one live linked child.`, failures);
  }

  for (const snapshot of initial) {
    const current = options.budgets.getLinkedProviderHold(snapshot.linkId);
    if (!current || current.state === "recovery_required") {
      if (current?.state === "recovery_required") failures.push(`${current.linkId}: ${current.recoveryReason}`);
      continue;
    }
    if (failures.some((failure) => failure.startsWith(`${current.linkId}:`))) continue;
    try {
      validateJournalIdentity(options, current);
      recoverOne(options, current);
    } catch (error) {
      const latest = options.budgets.getLinkedProviderHold(current.linkId);
      const reason = messageOf(error);
      if (latest && latest.state !== "recovery_required") {
        try {
          options.budgets.markLinkedRecoveryRequired(latest.linkId, reason);
        } catch (markError) {
          failures.push(`${latest.linkId}: ${reason}; failed to persist recovery marker: ${messageOf(markError)}`);
          continue;
        }
      }
      failures.push(`${current.linkId}: ${reason}`);
    }
  }

  if (failures.length > 0) {
    throw new HeadlessError(
      "CONFLICT",
      `Linked provider recovery requires operator action: ${failures.join(" ")}`,
      { details: { linkIds: failures.map((failure) => failure.slice(0, 64)) } },
    );
  }
  return options.budgets.getState().linkedHolds;
}

function recoverOne(options: LinkedHoldRecoveryOptions, hold: LinkedHoldRecord) {
  const childReservation = options.budgets.getReservation(hold.childReservationId);
  const childJob = options.jobs.get(hold.childReservationId);
  const operations = options.broker.linkedOperationSnapshot(hold.linkId);

  switch (hold.state) {
    case "intent":
      if (childReservation || childJob || operations.parent || operations.target) {
        throw new Error("Intent has impossible reservation, job, or broker side effects.");
      }
      options.budgets.rollbackLinkedProviderHold(hold.linkId);
      return;
    case "held":
      requireChildReservation(hold, childReservation);
      if (childJob || operations.parent || operations.target) throw new Error("Held link has admission or broker evidence that cannot exist at this cut point.");
      options.budgets.rollbackLinkedProviderHold(hold.linkId);
      return;
    case "parent_carved":
      requireChildReservation(hold, childReservation);
      if (childJob || operations.target) throw new Error("Parent-carved link has a child job or target operation before admission.");
      requireParentOperation(hold, operations.parent);
      options.budgets.rollbackLinkedProviderHold(hold.linkId);
      options.broker.recoverLinkedParentSettlement(hold.linkId, fullUnused(hold));
      return;
    case "admitted":
      requireChildReservation(hold, childReservation);
      requireChildJob(hold, childJob);
      requireParentOperation(hold, operations.parent);
      if (operations.target && (operations.target.kind !== "target" || operations.target.phase !== "prepared" || !zeroObservation(operations.target.observation))) {
        throw new Error("Admitted link has ambiguous target-lease evidence.");
      }
      options.jobs.recoverLinkedChildBlocked(hold.childReservationId, "Daemon stopped before the cross-provider target lease was durably handed to the child.");
      options.budgets.rollbackLinkedProviderHold(hold.linkId);
      options.broker.recoverLinkedParentSettlement(hold.linkId, fullUnused(hold));
      return;
    case "leased":
      requireChildReservation(hold, childReservation);
      requireChildJob(hold, childJob);
      requireParentOperation(hold, operations.parent);
      options.jobs.recoverLinkedChildBlocked(hold.childReservationId, "Daemon stopped while the cross-provider delegated child held a target lease; the prompt will not be rerun.");
      recoverLeased(options, hold, operations.target);
      return;
    case "settling": {
      requireChildReservation(hold, childReservation);
      requireChildJob(hold, childJob);
      requireParentOperation(hold, operations.parent);
      if (!hold.terminalSettlementDigest || !hold.usageProjection || !hold.settlementDisposition || !hold.settlementObservation) {
        throw new Error("Settling link is missing its exact terminal digest preimage.");
      }
      validateTargetOperation(hold, operations.target, false);
      const finalized = options.budgets.finalizeLinkedProviderSettlement(
        hold.linkId,
        hold.terminalSettlementDigest,
        hold.settlementDisposition,
      );
      options.broker.recoverLinkedParentSettlement(hold.linkId, finalized.unused);
      return;
    }
    case "settled":
    case "exhausted":
      verifyChargedTerminal(options, hold, childReservation, operations);
      return;
    case "rolled_back":
      if (childReservation) throw new Error("Rolled-back link regained its child reservation.");
      if (operations.target && operations.target.kind === "target" && !zeroObservation(operations.target.observation)) {
        throw new Error("Rolled-back link has nonzero target counters.");
      }
      if (operations.parent?.kind === "parent") options.broker.recoverLinkedParentSettlement(hold.linkId, fullUnused(hold));
      return;
    case "recovery_required":
      throw new Error(hold.recoveryReason ?? "Linked hold already requires recovery.");
  }
}

function recoverLeased(options: LinkedHoldRecoveryOptions, hold: LinkedHoldRecord, operation: BrokerLinkedOperation | null) {
  if (!operation) {
    // The durable lease evidence proves a bearer was minted, but missing
    // counters cannot prove zero. Exhaust the whole bounded slice.
    const observation = observationFromHoldOrUnknown(hold);
    options.budgets.exhaustLinkedProviderHold(hold.linkId, observation);
    options.broker.recoverLinkedParentSettlement(hold.linkId, zeroUnused(hold));
    return;
  }
  validateTargetOperation(hold, operation, true);
  options.broker.revokeLinkedTarget(hold.linkId);
  const observation = options.broker.observeLinkedTarget(hold.linkId);
  if (!observation || observation.activeRequests !== 0) throw new Error("Target lease could not be revoked and drained during startup recovery.");
  if (zeroObservation(observation)) {
    options.budgets.rollbackLinkedProviderHold(hold.linkId);
    options.broker.recoverLinkedParentSettlement(hold.linkId, fullUnused(hold));
    return;
  }
  options.budgets.exhaustLinkedProviderHold(hold.linkId, observation);
  options.broker.recoverLinkedParentSettlement(hold.linkId, zeroUnused(hold));
}

function validateJournalIdentity(options: LinkedHoldRecoveryOptions, hold: LinkedHoldRecord) {
  const expectedLinkId = linkedProviderHoldId(options.budgets.projectId, hold.parentJobId, hold.requestId);
  const ids = linkedProviderOperationIds(hold.linkId);
  if (hold.linkId !== expectedLinkId
    || hold.parentCarveId !== ids.parentOperationId
    || hold.targetQuotaId !== ids.targetRunQuotaId) {
    throw new Error("Linked journal deterministic identifiers do not match their canonical derivation.");
  }
  if (hold.parentProvider === hold.targetProvider || hold.parentBackend === hold.targetBackend) {
    throw new Error("Linked journal no longer crosses distinct providers and backends.");
  }
  const parent = options.budgets.getReservation(hold.parentReservationId);
  if (!parent && !isTerminal(hold)) throw new Error("Linked journal parent reservation is missing.");
  if (parent && (parent.id !== hold.parentJobId || parent.parentReservationId !== null || parent.provider !== hold.parentProvider)) {
    throw new Error("Linked journal parent reservation relation changed.");
  }
}

function requireChildReservation(hold: LinkedHoldRecord, child: BudgetReservation | null) {
  if (!child
    || child.id !== hold.childReservationId
    || child.parentReservationId !== hold.parentReservationId
    || child.delegationRequestId !== hold.requestId
    || child.provider !== hold.targetProvider
    || JSON.stringify(child.budgetIds) !== JSON.stringify(hold.targetBudgetIds)
    || JSON.stringify(child.envelope) !== JSON.stringify(hold.targetReservation)) {
    throw new Error("Linked journal child reservation relation or allocation changed.");
  }
}

function requireChildJob(hold: LinkedHoldRecord, child: Job | null) {
  if (!child
    || hold.childJobId !== hold.childReservationId
    || child.id !== hold.childReservationId
    || child.delegationOf?.parentJobId !== hold.parentJobId
    || child.delegationOf.requestId !== hold.requestId
    || child.delegationOf.depth !== 1
    || child.delegationOf.budgetFraction !== hold.budgetFraction
    || child.backend !== hold.targetBackend) {
    throw new Error("Linked journal durable child job relation changed.");
  }
}

function requireParentOperation(hold: LinkedHoldRecord, operation: BrokerLinkedOperation | null) {
  if (!operation
    || operation.kind !== "parent"
    || operation.linkId !== hold.linkId
    || operation.operationId !== hold.parentCarveId
    || operation.parentRunId !== hold.parentJobId
    || JSON.stringify(operation.allocation) !== JSON.stringify(brokerAllocation(hold))) {
    throw new Error("Linked parent broker carve is missing or conflicts with the journal.");
  }
}

function validateTargetOperation(hold: LinkedHoldRecord, operation: BrokerLinkedOperation | null, requireIssued: boolean) {
  if (!operation || operation.kind !== "target") throw new Error("Linked target broker evidence is missing.");
  const ids = linkedProviderOperationIds(hold.linkId);
  if (operation.operationId !== ids.targetOperationId
    || operation.childRunId !== hold.childReservationId
    || operation.requestedScope.provider !== hold.targetProvider
    || operation.targetLeaseId !== hold.brokerEvidence.targetLeaseId
    || operation.targetTokenHash !== hold.brokerEvidence.targetTokenHash
    || operation.targetQuotaScope.runId !== hold.childReservationId
    || operation.targetQuotaScope.provider !== hold.targetProvider
    || operation.targetQuotaScope.budgetQuotas[0]?.id !== hold.targetQuotaId
    || (requireIssued && operation.phase === "prepared")) {
    throw new Error("Linked target broker operation conflicts with the journal.");
  }
  const recorded = hold.brokerEvidence;
  const observed = operation.observation;
  for (const [prior, next] of [
    [recorded.targetRequests, observed.requests],
    [recorded.targetForwardedRequests, observed.forwardedRequests],
    [recorded.targetInputTokens, observed.accountedInputTokens],
    [recorded.targetOutputTokens, observed.accountedOutputTokens],
    [recorded.targetCostUsd, Math.max(observed.observedCostUsd, observed.accountedCostUsd)],
  ] as const) {
    if (prior !== null && next < prior) throw new Error("Linked target broker counters regressed.");
  }
}

function verifyChargedTerminal(
  options: LinkedHoldRecoveryOptions,
  hold: LinkedHoldRecord,
  child: BudgetReservation | null,
  operations: ReturnType<ProviderBroker["linkedOperationSnapshot"]>,
) {
  if (child) throw new Error("Terminal linked hold regained its child reservation.");
  if (!hold.usageProjection || !hold.terminalSettlementDigest || !hold.settlementDisposition || !hold.settlementObservation) {
    throw new Error("Charged terminal link is missing settlement evidence.");
  }
  options.budgets.finalizeLinkedProviderSettlement(hold.linkId, hold.terminalSettlementDigest, hold.settlementDisposition);
  for (const budgetId of hold.targetBudgetIds) {
    const budget = options.budgets.getState().budgets.find((candidate) => candidate.id === budgetId);
    if (!budget || budget.usedRequests < hold.usageProjection.requests) throw new Error("Terminal linked target charge is missing.");
    requireCounterAtLeast(budget.usedUsage.input, hold.usageProjection.inputTokens, "input token");
    requireCounterAtLeast(budget.usedUsage.output, hold.usageProjection.outputTokens, "output token");
    requireCounterAtLeast(budget.usedCost.amountUsd, hold.usageProjection.costUsd, "cost");
  }
  requireParentOperation(hold, operations.parent);
  const expectedUnused = hold.state === "exhausted" ? zeroUnused(hold) : unusedFromUsage(hold);
  options.broker.recoverLinkedParentSettlement(hold.linkId, expectedUnused);
  validateTargetOperation(hold, operations.target, false);
}

function recordFailure(budgets: BudgetStore, hold: LinkedHoldRecord, reason: string, failures: string[]) {
  try {
    budgets.markLinkedRecoveryRequired(hold.linkId, reason);
  } catch (error) {
    failures.push(`${hold.linkId}: ${reason}; failed to persist recovery marker: ${messageOf(error)}`);
    return;
  }
  failures.push(`${hold.linkId}: ${reason}`);
}

function consumesChildSlot(hold: LinkedHoldRecord) {
  return !["intent", "settled", "rolled_back", "exhausted"].includes(hold.state);
}

function isTerminal(hold: LinkedHoldRecord) {
  return ["settled", "rolled_back", "exhausted"].includes(hold.state);
}

function brokerAllocation(hold: LinkedHoldRecord) {
  return {
    requests: hold.parentAllocation.requests,
    inputTokens: hold.parentAllocation.inputTokens,
    outputTokens: hold.parentAllocation.outputTokens,
    costUsd: hold.parentAllocation.costUsd,
  };
}

function fullUnused(hold: LinkedHoldRecord) {
  return brokerAllocation(hold);
}

function zeroUnused(hold: LinkedHoldRecord) {
  return {
    requests: 0,
    inputTokens: hold.parentAllocation.inputTokens === null ? null : 0,
    outputTokens: hold.parentAllocation.outputTokens === null ? null : 0,
    costUsd: hold.parentAllocation.costUsd === null ? null : 0,
  };
}

function unusedFromUsage(hold: LinkedHoldRecord) {
  const usage = hold.usageProjection!;
  return {
    requests: Math.max(0, hold.parentAllocation.requests - usage.requests),
    inputTokens: unusedNullable(hold.parentAllocation.inputTokens, usage.inputTokens),
    outputTokens: unusedNullable(hold.parentAllocation.outputTokens, usage.outputTokens),
    costUsd: unusedNullable(hold.parentAllocation.costUsd, usage.costUsd),
  };
}

function unusedNullable(allocation: number | null, used: number | null) {
  if (allocation === null || used === null) return null;
  return Math.max(0, allocation - used);
}

function zeroObservation(observation: LinkedHoldSettlementObservation) {
  return observation.requests === 0
    && observation.forwardedRequests === 0
    && observation.observedCostUsd === 0
    && observation.accountedCostUsd === 0
    && observation.accountedInputTokens === 0
    && observation.accountedOutputTokens === 0
    && observation.activeRequests === 0;
}

function observationFromHoldOrUnknown(hold: LinkedHoldRecord): LinkedHoldSettlementObservation {
  return {
    leaseId: hold.brokerEvidence.targetLeaseId!,
    requests: hold.brokerEvidence.targetRequests ?? hold.targetReservation.requests,
    forwardedRequests: hold.brokerEvidence.targetForwardedRequests ?? hold.targetReservation.requests,
    observedCostUsd: hold.brokerEvidence.targetCostUsd ?? hold.targetReservation.costUsd ?? 0,
    accountedCostUsd: hold.brokerEvidence.targetCostUsd ?? hold.targetReservation.costUsd ?? 0,
    accountedInputTokens: hold.brokerEvidence.targetInputTokens ?? hold.targetReservation.inputTokens ?? 0,
    accountedOutputTokens: hold.brokerEvidence.targetOutputTokens ?? hold.targetReservation.outputTokens ?? 0,
    activeRequests: 0,
    revoked: true,
    expiresAt: hold.brokerEvidence.targetExpiresAt ?? hold.childDeadlineAt,
  };
}

function requireCounterAtLeast(actual: number | null, expected: number | null, label: string) {
  // A null aggregate is the BudgetStore's fail-closed representation for an
  // interrupted run: the dimension is exhausted and cannot authorize more
  // spend. It is therefore at least as restrictive as each numeric linked
  // charge; only a known numeric under-charge contradicts the journal.
  if (expected !== null && actual !== null && actual < expected) throw new Error(`Terminal linked ${label} charge is missing.`);
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
