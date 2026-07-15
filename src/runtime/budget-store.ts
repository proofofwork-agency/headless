import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { BudgetSchema, type Budget } from "../contracts/durable";
import { BackendIdSchema, IdentifierSchema, MAX_RUN_PROMPT_BYTES, PrincipalIdSchema, ProjectIdSchema, TimestampSchema } from "../contracts/common";
import { LinkedHoldEnvelopeSchema, LinkedHoldRecordSchema, type LinkedHoldRecord } from "../contracts/linked-hold";
import { HeadlessError } from "./headless-error";
import { ensureProjectStateDirectories, type ProjectStatePaths } from "./project-state";
import { readOwnerOnlyJson, writeOwnerOnlyJson } from "./owner-json";

const nullableCount = z.number().int().nonnegative().nullable();
const nullableCost = z.number().nonnegative().nullable();
const DEFAULT_TRANSFER_REQUESTS = 8;
const DEFAULT_TRANSFER_INPUT_TOKENS = 200_000;
const DEFAULT_TRANSFER_OUTPUT_TOKENS = 32_000;

const BudgetScopeSchema = z.object({
  projectId: ProjectIdSchema,
  principal: PrincipalIdSchema,
  sessionId: IdentifierSchema.nullable().default(null),
  workflowId: IdentifierSchema.nullable().default(null),
  provider: z.string().max(128).nullable().default(null),
}).strict();

const ReservationRequestSchema = BudgetScopeSchema.extend({
  id: IdentifierSchema.optional(),
  inputTokens: nullableCount.default(null),
  outputTokens: nullableCount.default(null),
  costUsd: nullableCost.default(null),
  artifactBytes: z.number().int().nonnegative().default(0),
  retries: z.number().int().nonnegative().default(0),
}).strict();

const ReservationEnvelopeSchema = z.object({
  requests: z.number().int().nonnegative(),
  inputTokens: nullableCount,
  outputTokens: nullableCount,
  costUsd: nullableCost,
  artifactBytes: z.number().int().nonnegative(),
  retries: z.number().int().nonnegative(),
}).strict();

const LegacyBudgetReservationSchema = ReservationRequestSchema.omit({ id: true }).extend({
  id: IdentifierSchema,
  budgetIds: z.array(IdentifierSchema),
  active: z.boolean().default(false),
  createdAt: TimestampSchema,
}).strict();

const BudgetReservationSchema = LegacyBudgetReservationSchema.extend({
  parentReservationId: IdentifierSchema.nullable().default(null),
  delegationRequestId: z.string().uuid().nullable().default(null),
  budgetFraction: z.number().positive().max(0.5).nullable().default(null),
  envelope: ReservationEnvelopeSchema,
}).strict().superRefine((reservation, context) => {
  const linked = reservation.parentReservationId !== null;
  if (linked !== (reservation.delegationRequestId !== null) || linked !== (reservation.budgetFraction !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Delegated reservations require a complete parent/request/fraction link." });
  }
});

const CommitUsageSchema = z.object({
  inputTokens: nullableCount.optional(),
  outputTokens: nullableCount.optional(),
  reasoningTokens: nullableCount.optional(),
  cachedTokens: nullableCount.optional(),
  providerTotalTokens: nullableCount.optional(),
  costUsd: nullableCost.optional(),
  costSource: z.enum(["provider", "broker", "reconciled", "unknown"]).optional(),
  pricingId: z.string().max(256).nullable().optional(),
  observedRequests: z.number().int().nonnegative().optional(),
  artifactBytes: z.number().int().nonnegative().optional(),
}).strict();

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const providerId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);

const PrepareLinkedProviderHoldSchema = z.object({
  parentJobId: IdentifierSchema,
  parentReservationId: IdentifierSchema,
  childReservationId: IdentifierSchema,
  requestId: z.string().uuid(),
  parentBackend: BackendIdSchema,
  targetBackend: BackendIdSchema,
  parentProvider: providerId,
  targetProvider: providerId,
  budgetFraction: z.number().positive().max(0.5),
  parentDeadlineAt: TimestampSchema,
  childDeadlineAt: TimestampSchema,
  approvalPolicy: z.enum(["ask", "auto"]),
  parentAllocation: LinkedHoldEnvelopeSchema,
  targetReservation: LinkedHoldEnvelopeSchema,
  requestDigest: digest,
  promptDigest: digest,
  promptBytes: z.number().int().nonnegative().safe().max(MAX_RUN_PROMPT_BYTES),
}).strict().superRefine((input, context) => {
  if (input.parentProvider === input.targetProvider) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["targetProvider"], message: "Linked holds require different parent and target providers." });
  }
  if (input.parentBackend === input.targetBackend) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["targetBackend"], message: "Linked holds require different parent and target backends." });
  }
  if (input.childDeadlineAt > input.parentDeadlineAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["childDeadlineAt"], message: "The child deadline cannot exceed the parent deadline." });
  }
});

const LegacyBudgetStoreStateSchema = z.object({
  version: z.literal(2),
  projectId: ProjectIdSchema,
  budgets: z.array(BudgetSchema),
  reservations: z.array(LegacyBudgetReservationSchema),
  updatedAt: TimestampSchema,
}).strict();

const BudgetStoreStateV3Schema = z.object({
  version: z.literal(3),
  projectId: ProjectIdSchema,
  budgets: z.array(BudgetSchema),
  reservations: z.array(BudgetReservationSchema),
  updatedAt: TimestampSchema,
}).strict();

export const BudgetStoreStateSchema = z.object({
  version: z.literal(4),
  projectId: ProjectIdSchema,
  budgets: z.array(BudgetSchema),
  reservations: z.array(BudgetReservationSchema),
  linkedHolds: z.array(LinkedHoldRecordSchema).default([]),
  updatedAt: TimestampSchema,
}).strict();

const PersistedBudgetStoreStateSchema = z.union([LegacyBudgetStoreStateSchema, BudgetStoreStateV3Schema, BudgetStoreStateSchema]);

export type BudgetScope = z.input<typeof BudgetScopeSchema>;
export type BudgetReservationRequest = z.input<typeof ReservationRequestSchema>;
export type BudgetReservation = z.infer<typeof BudgetReservationSchema>;
export type CommitUsage = z.input<typeof CommitUsageSchema>;
export type BudgetStoreState = z.infer<typeof BudgetStoreStateSchema>;
export type PrepareLinkedProviderHoldInput = z.input<typeof PrepareLinkedProviderHoldSchema>;
export type BudgetCheck = {
  passed: boolean;
  budgetIds: string[];
  reasons: string[];
};

export type DelegatedReservationRequest = {
  id: string;
  parentReservationId: string;
  requestId: string;
  budgetFraction?: number;
  provider: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  artifactBytes?: number;
  retries?: number;
};

export type BudgetStoreOptions = {
  now?: () => number;
  id?: () => string;
};

export class BudgetStore {
  readonly projectId: string;
  private readonly now: () => number;
  private readonly id: () => string;
  private state: BudgetStoreState;

  constructor(private readonly paths: ProjectStatePaths, options: BudgetStoreOptions = {}) {
    ensureProjectStateDirectories(paths);
    this.projectId = ProjectIdSchema.parse(paths.projectId);
    this.now = options.now ?? Date.now;
    this.id = options.id ?? (() => `reservation_${randomUUID()}`);

    const existing = readOwnerOnlyJson(paths.budgetsPath, PersistedBudgetStoreStateSchema);
    if (existing) {
      if (existing.projectId !== this.projectId) {
        throw new Error(`Budget project mismatch: expected ${this.projectId}, got ${existing.projectId}`);
      }
      this.state = existing.version === 4
        ? existing
        : migrateV3(existing.version === 3 ? existing : migrateV2(existing));
      if (existing.version !== 4) this.persist();
      return;
    }

    this.state = BudgetStoreStateSchema.parse({
      version: 4,
      projectId: this.projectId,
      budgets: [],
      reservations: [],
      linkedHolds: [],
      updatedAt: this.now(),
    });
    this.persist();
  }

  getState() {
    return BudgetStoreStateSchema.parse(this.state);
  }

  /** Persist a cross-provider delegation intent without moving any authority. */
  prepareLinkedProviderHold(value: PrepareLinkedProviderHoldInput) {
    const input = PrepareLinkedProviderHoldSchema.parse(value);
    const linkId = linkedHoldId(this.projectId, input.parentJobId, input.requestId);
    const existing = this.state.linkedHolds.find((hold) => hold.linkId === linkId);
    if (existing) {
      if (linkedPlanIdentity(existing) !== linkedPlanIdentity(input)) {
        throw new HeadlessError("CONFLICT", "Delegation request id already names a different linked provider hold.");
      }
      return { allowed: true as const, hold: LinkedHoldRecordSchema.parse(existing), existing: true, reasons: [] as string[] };
    }
    const parent = this.state.reservations.find((candidate) => candidate.id === input.parentReservationId);
    if (!parent || !parent.active || parent.parentReservationId !== null) {
      return linkedHoldDenied("Parent budget reservation is not active and transferable.");
    }
    if (parent.provider !== input.parentProvider) {
      return linkedHoldDenied("Parent provider does not match its active budget reservation.");
    }
    if (this.state.reservations.some((candidate) => candidate.parentReservationId === parent.id)) {
      return linkedHoldDenied("The parent already admitted its single delegated child.");
    }

    const targetRequest = linkedTargetRequest(this.projectId, parent, input);
    const targetBudgets = this.matchingBudgets(targetRequest);
    const parentBudgets = parent.budgetIds
      .map((budgetId) => this.state.budgets.find((candidate) => candidate.id === budgetId))
      .filter((budget): budget is Budget => Boolean(budget));
    const reasons = this.linkedHoldViolations(parent, parentBudgets, targetBudgets, targetRequest, input);
    if (reasons.length > 0) return linkedHoldDenied(reasons);

    const now = this.now();
    const candidate = LinkedHoldRecordSchema.parse({
      ...input,
      linkId,
      depth: 1,
      parentBudgetIds: [...parent.budgetIds],
      targetBudgetIds: targetBudgets.map((budget) => budget.id),
      parentCarveId: linkedOperationId("parent", linkId),
      targetQuotaId: linkedOperationId("target", linkId),
      state: "intent",
      transitionNumber: 0,
      createdAt: now,
      updatedAt: now,
      terminalAt: null,
      childJobId: null,
      brokerEvidence: emptyBrokerEvidence(),
      terminalSettlementDigest: null,
      usageProjection: null,
    });
    if (this.state.linkedHolds.some((hold) => hold.childReservationId === candidate.childReservationId)) {
      throw new HeadlessError("CONFLICT", "Linked child reservation id is already assigned to another delegation intent.");
    }

    const next = BudgetStoreStateSchema.parse(this.state);
    next.linkedHolds.push(candidate);
    next.updatedAt = now;
    this.persistReplacement(next);
    return { allowed: true as const, hold: LinkedHoldRecordSchema.parse(candidate), existing: false, reasons: [] as string[] };
  }

  /** Atomically carve the parent and create the target reservation for one prepared intent. */
  applyLinkedProviderHold(linkId: string) {
    const id = z.string().regex(/^[a-f0-9]{64}$/).parse(linkId);
    const current = this.state.linkedHolds.find((candidate) => candidate.linkId === id);
    if (!current) return linkedHoldDenied("Unknown linked provider hold.");
    if (current.state === "held") {
      const reservation = this.state.reservations.find((candidate) => candidate.id === current.childReservationId);
      if (!reservation) return linkedHoldDenied("Held linked provider reservation is missing.");
      return { allowed: true as const, hold: LinkedHoldRecordSchema.parse(current), reservation: BudgetReservationSchema.parse(reservation), existing: true, reasons: [] as string[] };
    }
    if (current.state !== "intent" || current.transitionNumber !== 0) {
      return linkedHoldDenied("Linked provider hold is not a prepared generation-zero intent.");
    }

    const parent = this.state.reservations.find((candidate) => candidate.id === current.parentReservationId);
    if (!parent || !parent.active || parent.parentReservationId !== null || parent.provider !== current.parentProvider) {
      return linkedHoldDenied("Parent budget reservation changed before the linked hold was applied.");
    }
    if (JSON.stringify(parent.budgetIds) !== JSON.stringify(current.parentBudgetIds)) {
      return linkedHoldDenied("Parent budget generation changed after linked-hold preparation.");
    }
    if (this.state.reservations.some((candidate) => candidate.id === current.childReservationId || candidate.parentReservationId === parent.id)) {
      return linkedHoldDenied("The parent or child reservation was consumed by another delegation.");
    }
    if (this.state.linkedHolds.some((candidate) => candidate.linkId !== id
      && candidate.parentReservationId === parent.id
      && linkedHoldConsumesCapacity(candidate))) {
      return linkedHoldDenied("Another linked provider hold already consumed this parent's child slot.");
    }

    const targetRequest = linkedTargetRequest(this.projectId, parent, current);
    const targetBudgets = this.matchingBudgets(targetRequest);
    if (JSON.stringify(targetBudgets.map((budget) => budget.id)) !== JSON.stringify(current.targetBudgetIds)) {
      return linkedHoldDenied("Target budget generation changed after linked-hold preparation.");
    }
    const parentBudgets = parent.budgetIds
      .map((budgetId) => this.state.budgets.find((candidate) => candidate.id === budgetId))
      .filter((budget): budget is Budget => Boolean(budget));
    const reasons = this.linkedHoldViolations(parent, parentBudgets, targetBudgets, targetRequest, current);
    if (reasons.length > 0) return linkedHoldDenied(reasons);

    const now = this.now();
    const next = BudgetStoreStateSchema.parse(this.state);
    const nextParent = next.reservations.find((candidate) => candidate.id === parent.id)!;
    subtractEnvelope(nextParent.envelope, current.parentAllocation);
    const child = BudgetReservationSchema.parse({
      id: current.childReservationId,
      projectId: nextParent.projectId,
      principal: nextParent.principal,
      sessionId: null,
      workflowId: null,
      provider: current.targetProvider,
      inputTokens: current.targetReservation.inputTokens,
      outputTokens: current.targetReservation.outputTokens,
      costUsd: current.targetReservation.costUsd,
      artifactBytes: current.targetReservation.artifactBytes,
      retries: current.targetReservation.retries,
      budgetIds: [...new Set(current.targetBudgetIds)],
      active: false,
      createdAt: now,
      parentReservationId: nextParent.id,
      delegationRequestId: current.requestId,
      budgetFraction: current.budgetFraction,
      envelope: current.targetReservation,
    });
    next.reservations.push(child);
    const nextHold = next.linkedHolds.find((candidate) => candidate.linkId === id)!;
    nextHold.state = "held";
    nextHold.transitionNumber = 1;
    nextHold.updatedAt = now;
    next.updatedAt = now;
    this.persistReplacement(next);
    return { allowed: true as const, hold: LinkedHoldRecordSchema.parse(nextHold), reservation: BudgetReservationSchema.parse(child), existing: false, reasons: [] as string[] };
  }

  upsertBudget(value: Budget) {
    const budget = BudgetSchema.parse(value);
    if (budget.projectId !== this.projectId) {
      throw new Error(`Budget project mismatch: expected ${this.projectId}, got ${budget.projectId}`);
    }

    const index = this.state.budgets.findIndex((candidate) => candidate.id === budget.id);
    if (index === -1) this.state.budgets.push(budget);
    else this.state.budgets[index] = budget;
    this.state.updatedAt = this.now();
    this.persist();
    return BudgetSchema.parse(budget);
  }

  reserve(value: BudgetReservationRequest) {
    const request = ReservationRequestSchema.parse(value);
    if (request.projectId !== this.projectId) {
      return {
        allowed: false as const,
        reservation: null,
        budgetIds: [],
        reasons: [`Budget store is bound to project ${this.projectId}, not ${request.projectId}.`],
      };
    }

    const budgets = this.matchingBudgets(request);
    const reasons = budgets.flatMap((budget) => this.reservationViolations(budget, request));
    if (reasons.length > 0) {
      return {
        allowed: false as const,
        reservation: null,
        budgetIds: budgets.map((budget) => budget.id),
        reasons,
      };
    }

    const reservation = BudgetReservationSchema.parse({
      ...request,
      id: request.id ?? this.id(),
      budgetIds: budgets.map((budget) => budget.id),
      active: false,
      createdAt: this.now(),
      parentReservationId: null,
      delegationRequestId: null,
      budgetFraction: null,
      envelope: initialEnvelope(request),
    });
    if (this.state.reservations.some((candidate) => candidate.id === reservation.id)) {
      throw new Error(`Budget reservation already exists: ${reservation.id}`);
    }

    this.state.reservations.push(reservation);
    this.state.updatedAt = this.now();
    this.persist();
    return {
      allowed: true as const,
      reservation: BudgetReservationSchema.parse(reservation),
      budgetIds: reservation.budgetIds,
      reasons: [],
    };
  }

  /** Atomically carve one child slice from an active parent reservation. */
  subreserveDelegation(value: DelegatedReservationRequest) {
    const fraction = value.budgetFraction ?? 0.25;
    if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 0.5) {
      throw new TypeError("Delegation budget fraction must be greater than zero and at most 0.5.");
    }
    const parent = this.state.reservations.find((candidate) => candidate.id === value.parentReservationId);
    if (!parent || parent.parentReservationId !== null || !parent.active) {
      return { allowed: false as const, reservation: null, existing: false, reasons: ["Parent budget reservation is not active and transferable."] };
    }
    if (parent.provider !== value.provider) {
      return { allowed: false as const, reservation: null, existing: false, reasons: ["Cross-provider delegation requires linked provider holds and is unavailable in v1."] };
    }
    const prior = this.state.reservations.find((candidate) => candidate.parentReservationId === parent.id);
    if (prior) {
      if (prior.delegationRequestId === value.requestId) {
        return { allowed: true as const, reservation: BudgetReservationSchema.parse(prior), existing: true, reasons: [] };
      }
      return { allowed: false as const, reservation: null, existing: false, reasons: ["The parent already admitted its single delegated child."] };
    }
    const requested = ReservationEnvelopeSchema.parse({
      requests: Math.max(1, Math.floor(parent.envelope.requests * fraction)),
      inputTokens: value.inputTokens,
      outputTokens: value.outputTokens,
      costUsd: value.costUsd,
      artifactBytes: value.artifactBytes ?? 0,
      retries: value.retries ?? 0,
    });
    const reasons = envelopeViolations(parent.envelope, requested, fraction);
    if (reasons.length > 0) return { allowed: false as const, reservation: null, existing: false, reasons };

    subtractEnvelope(parent.envelope, requested);
    const reservation = BudgetReservationSchema.parse({
      id: value.id,
      projectId: parent.projectId,
      principal: parent.principal,
      sessionId: null,
      workflowId: null,
      provider: value.provider,
      inputTokens: value.inputTokens,
      outputTokens: value.outputTokens,
      costUsd: value.costUsd,
      artifactBytes: value.artifactBytes ?? 0,
      retries: value.retries ?? 0,
      budgetIds: [...parent.budgetIds],
      active: false,
      createdAt: this.now(),
      parentReservationId: parent.id,
      delegationRequestId: value.requestId,
      budgetFraction: fraction,
      envelope: requested,
    });
    this.state.reservations.push(reservation);
    this.state.updatedAt = this.now();
    this.persist();
    return { allowed: true as const, reservation: BudgetReservationSchema.parse(reservation), existing: false, reasons: [] };
  }

  /**
   * Acquire the concurrency slots for an already durable reservation. Resource
   * limits are reserved at admission; concurrency is activated only when the
   * daemon is ready to start the worker so excess jobs can remain queued.
   */
  activate(reservationId: string, retries = 0) {
    if (!Number.isSafeInteger(retries) || retries < 0) throw new TypeError("Budget retry count must be a non-negative safe integer.");
    const reservation = this.state.reservations.find((candidate) => candidate.id === reservationId);
    if (!reservation) throw new Error(`Unknown budget reservation: ${reservationId}`);
    const budgets = reservation.budgetIds
      .map((budgetId) => this.state.budgets.find((candidate) => candidate.id === budgetId))
      .filter((budget): budget is Budget => Boolean(budget));
    const retryReasons = budgets.flatMap((budget) => (
      budget.maxRetries !== null && retries > budget.maxRetries ? [`${budget.id}: retry limit exceeded.`] : []
    ));
    if (retryReasons.length > 0) {
      return { allowed: false as const, budgetIds: [...reservation.budgetIds], reasons: retryReasons };
    }
    if (reservation.active) {
      if (retries > reservation.retries) {
        reservation.retries = retries;
        this.state.updatedAt = this.now();
        this.persist();
      }
      return { allowed: true as const, budgetIds: [...reservation.budgetIds], reasons: [] };
    }

    const reasons = budgets.flatMap((budget) => {
      if (budget.maxConcurrency === null) return [];
      const held = this.reservationHoldsConcurrency(reservation.id);
      const active = this.concurrencyCount(budget.id);
      return active + (held ? 0 : 1) > budget.maxConcurrency ? [`${budget.id}: concurrency limit exceeded.`] : [];
    });
    if (reasons.length > 0) {
      return { allowed: false as const, budgetIds: [...reservation.budgetIds], reasons };
    }

    reservation.retries = Math.max(reservation.retries, retries);
    reservation.active = true;
    this.state.updatedAt = this.now();
    this.persist();
    return { allowed: true as const, budgetIds: [...reservation.budgetIds], reasons: [] };
  }

  /** Reset crash-recovered queued work without releasing its resource hold. */
  deactivate(reservationId: string) {
    const reservation = this.state.reservations.find((candidate) => candidate.id === reservationId);
    if (!reservation || !reservation.active) return false;
    reservation.active = false;
    this.state.updatedAt = this.now();
    this.persist();
    return true;
  }

  getReservation(reservationId: string) {
    const reservation = this.state.reservations.find((candidate) => candidate.id === reservationId);
    return reservation ? BudgetReservationSchema.parse(reservation) : null;
  }

  commit(reservationId: string, value: CommitUsage = {}) {
    const actual = CommitUsageSchema.parse(value);
    const index = this.state.reservations.findIndex((candidate) => candidate.id === reservationId);
    if (index === -1) throw new Error(`Unknown budget reservation: ${reservationId}`);
    const [reservation] = this.state.reservations.splice(index, 1);

    if (reservation.parentReservationId !== null) {
      const parent = this.state.reservations.find((candidate) => candidate.id === reservation.parentReservationId);
      if (parent) returnUnusedEnvelope(parent.envelope, reservation.envelope, actual);
    }

    const inputTokens = actual.inputTokens === undefined ? reservation.inputTokens : actual.inputTokens;
    const outputTokens = actual.outputTokens === undefined ? reservation.outputTokens : actual.outputTokens;
    const costUsd = actual.costUsd === undefined ? reservation.costUsd : actual.costUsd;
    const artifactBytes = actual.artifactBytes ?? reservation.artifactBytes;
    const observedRequests = Math.max(1, actual.observedRequests ?? 1);

    for (const budgetId of reservation.budgetIds) {
      const budget = this.state.budgets.find((candidate) => candidate.id === budgetId);
      if (!budget) continue;
      budget.usedRequests += observedRequests;
      budget.usedUsage.input = addNullable(budget.usedUsage.input, inputTokens);
      budget.usedUsage.output = addNullable(budget.usedUsage.output, outputTokens);
      budget.usedUsage.reasoning = addNullable(budget.usedUsage.reasoning, actual.reasoningTokens);
      budget.usedUsage.cached = addNullable(budget.usedUsage.cached, actual.cachedTokens);
      budget.usedUsage.providerTotal = addNullable(budget.usedUsage.providerTotal, actual.providerTotalTokens);
      budget.usedCost = addCost(budget.usedCost, {
        amountUsd: costUsd,
        source: costUsd === null ? "unknown" : (actual.costSource ?? "reconciled"),
        pricingId: actual.pricingId ?? null,
        observedRequests,
      });
      budget.usedArtifactBytes += artifactBytes;
      budget.updatedAt = this.now();
    }

    this.state.updatedAt = this.now();
    this.persist();
    const budgets = reservation.budgetIds
      .map((budgetId) => this.state.budgets.find((candidate) => candidate.id === budgetId))
      .filter((budget): budget is Budget => Boolean(budget));
    const reasons = budgets.flatMap((budget) => this.currentViolations(budget));
    return {
      passed: reasons.length === 0,
      budgetIds: reservation.budgetIds,
      reasons,
    } satisfies BudgetCheck;
  }

  /**
   * A daemon crash can destroy the broker's in-memory observation before a
   * run is reconciled. Preserve unknown attribution and exhaust every bounded
   * dimension rather than letting a restarted daemon reuse quota whose
   * provider-side consumption can no longer be proven.
   */
  failClosedAfterInterruption(reservationId: string) {
    const index = this.state.reservations.findIndex((candidate) => candidate.id === reservationId);
    if (index === -1) throw new Error(`Unknown budget reservation: ${reservationId}`);
    const [reservation] = this.state.reservations.splice(index, 1);

    if (reservation.parentReservationId !== null) {
      const usage: z.infer<typeof CommitUsageSchema> = {
        inputTokens: reservation.envelope.inputTokens,
        outputTokens: reservation.envelope.outputTokens,
        costUsd: reservation.envelope.costUsd,
        costSource: reservation.envelope.costUsd === null ? "unknown" : "reconciled",
        observedRequests: reservation.envelope.requests,
        artifactBytes: reservation.envelope.artifactBytes,
      };
      chargeBudgets(this.state.budgets, reservation, usage, this.now());
      this.state.updatedAt = this.now();
      this.persist();
      return { passed: false, budgetIds: reservation.budgetIds, reasons: ["Delegated child allocation was exhausted after interruption."] } satisfies BudgetCheck;
    }

    for (const budgetId of reservation.budgetIds) {
      const budget = this.state.budgets.find((candidate) => candidate.id === budgetId);
      if (!budget) continue;
      budget.usedRequests = budget.maxRequests ?? budget.usedRequests + 1;
      budget.usedUsage = {
        input: null,
        output: null,
        reasoning: null,
        cached: null,
        providerTotal: null,
      };
      budget.usedCost = {
        amountUsd: null,
        source: "unknown",
        pricingId: null,
        observedRequests: Math.max(budget.usedCost.observedRequests, budget.usedRequests),
      };
      if (budget.maxArtifactBytes !== null) budget.usedArtifactBytes = budget.maxArtifactBytes;
      budget.updatedAt = this.now();
    }

    this.state.updatedAt = this.now();
    this.persist();
    const budgets = reservation.budgetIds
      .map((budgetId) => this.state.budgets.find((candidate) => candidate.id === budgetId))
      .filter((budget): budget is Budget => Boolean(budget));
    return {
      passed: false,
      budgetIds: reservation.budgetIds,
      reasons: budgets.flatMap((budget) => this.currentViolations(budget)),
    } satisfies BudgetCheck;
  }

  /** Evaluate actual run usage before a write is allowed to mutate primary. */
  previewCommit(reservationId: string, value: CommitUsage = {}): BudgetCheck {
    const actual = CommitUsageSchema.parse(value);
    const reservation = this.state.reservations.find((candidate) => candidate.id === reservationId);
    if (!reservation) throw new Error(`Unknown budget reservation: ${reservationId}`);
    const inputTokens = actual.inputTokens === undefined ? reservation.inputTokens : actual.inputTokens;
    const outputTokens = actual.outputTokens === undefined ? reservation.outputTokens : actual.outputTokens;
    const costUsd = actual.costUsd === undefined ? reservation.costUsd : actual.costUsd;
    const artifactBytes = actual.artifactBytes ?? reservation.artifactBytes;
    const budgets = reservation.budgetIds
      .map((budgetId) => this.state.budgets.find((candidate) => candidate.id === budgetId))
      .filter((budget): budget is Budget => Boolean(budget));
    const reasons = budgets.flatMap((budget) => projectedCommitViolations(
      budget,
      inputTokens,
      outputTokens,
      costUsd,
      artifactBytes,
      Math.max(1, actual.observedRequests ?? 1),
    ));
    return { passed: reasons.length === 0, budgetIds: reservation.budgetIds, reasons };
  }

  /**
   * Produce the strictest remaining provider-call lease for one reservation.
   * Every run is bounded even when no user budget exists; matching budgets can
   * only reduce that bound.
   */
  brokerLeaseLimits(reservationId: string, defaultMaxRequests = 8) {
    if (!Number.isSafeInteger(defaultMaxRequests) || defaultMaxRequests <= 0) {
      throw new TypeError("Default broker request limit must be a positive safe integer.");
    }
    const reservation = this.state.reservations.find((candidate) => candidate.id === reservationId);
    if (!reservation) throw new Error(`Unknown budget reservation: ${reservationId}`);
    let maxRequests = reservation.parentReservationId === null
      ? defaultMaxRequests
      : Math.min(defaultMaxRequests, reservation.envelope.requests);
    let maxCostUsd: number | null = null;
    let maxInputTokens: number | null = reservation.parentReservationId === null ? null : reservation.envelope.inputTokens;
    let maxOutputTokens: number | null = reservation.parentReservationId === null ? null : reservation.envelope.outputTokens;
    const budgetQuotas: Array<{
      id: string;
      maxRequests: number | null;
      usedRequests: number;
      maxInputTokens: number | null;
      usedInputTokens: number;
      maxOutputTokens: number | null;
      usedOutputTokens: number;
    }> = [];
    for (const budgetId of reservation.budgetIds) {
      const budget = this.state.budgets.find((candidate) => candidate.id === budgetId);
      if (!budget) continue;
      if (budget.maxRequests !== null) {
        maxRequests = Math.min(maxRequests, budget.maxRequests - budget.usedRequests);
      }
      if (budget.maxCostUsd !== null) {
        if (budget.usedCost.amountUsd === null) {
          throw new Error(`${budget.id}: remaining broker cost is unknown under a configured limit.`);
        }
        if (reservation.costUsd === null) {
          throw new Error(`${budget.id}: broker cost reservation is unknown under a configured limit.`);
        }
        // The admission reservation is the immutable per-run allocation. A
        // later job cannot enlarge an already-issued broker lease, so sharing
        // the then-current remainder here would permit concurrent overspend.
        maxCostUsd = maxCostUsd === null ? reservation.costUsd : Math.min(maxCostUsd, reservation.costUsd);
      }
      if (budget.maxInputTokens !== null && budget.usedUsage.input === null) {
        throw new Error(`${budget.id}: remaining broker input token usage is unknown under a configured limit.`);
      }
      if (budget.maxOutputTokens !== null && budget.usedUsage.output === null) {
        throw new Error(`${budget.id}: remaining broker output token usage is unknown under a configured limit.`);
      }
      if (budget.maxRequests !== null || budget.maxInputTokens !== null || budget.maxOutputTokens !== null) {
        budgetQuotas.push({
          id: budget.id,
          maxRequests: budget.maxRequests,
          usedRequests: budget.usedRequests,
          maxInputTokens: budget.maxInputTokens,
          usedInputTokens: budget.usedUsage.input ?? 0,
          maxOutputTokens: budget.maxOutputTokens,
          usedOutputTokens: budget.usedUsage.output ?? 0,
        });
      }
    }
    if (reservation.parentReservationId !== null) {
      maxCostUsd = minimumNullable(maxCostUsd, reservation.envelope.costUsd);
    }
    if (maxRequests <= 0) throw new Error("Broker request budget is exhausted.");
    if (maxCostUsd !== null && maxCostUsd < 0) throw new Error("Broker cost budget is exhausted.");
    return { maxRequests, maxCostUsd, maxInputTokens, maxOutputTokens, budgetQuotas };
  }

  release(reservationId: string) {
    const index = this.state.reservations.findIndex((candidate) => candidate.id === reservationId);
    if (index === -1) return false;
    const [reservation] = this.state.reservations.splice(index, 1);
    if (reservation.parentReservationId !== null) {
      const parent = this.state.reservations.find((candidate) => candidate.id === reservation.parentReservationId);
      if (parent) addEnvelope(parent.envelope, reservation.envelope);
    }
    this.state.updatedAt = this.now();
    this.persist();
    return true;
  }

  evaluate(value: BudgetScope): BudgetCheck {
    const scope = BudgetScopeSchema.parse(value);
    if (scope.projectId !== this.projectId) {
      return {
        passed: false,
        budgetIds: [],
        reasons: [`Budget store is bound to project ${this.projectId}, not ${scope.projectId}.`],
      };
    }
    const budgets = this.matchingBudgets(scope);
    const reasons = budgets.flatMap((budget) => this.currentViolations(budget));
    return {
      passed: reasons.length === 0,
      budgetIds: budgets.map((budget) => budget.id),
      reasons,
    };
  }

  hasCostLimit(value: BudgetScope) {
    const scope = BudgetScopeSchema.parse(value);
    if (scope.projectId !== this.projectId) return false;
    return this.matchingBudgets(scope).some((budget) => budget.maxCostUsd !== null);
  }

  private matchingBudgets(scope: z.infer<typeof BudgetScopeSchema>) {
    return this.state.budgets.filter((budget) => {
      if (budget.expiresAt !== null && budget.expiresAt <= this.now()) return false;
      if (budget.projectId !== scope.projectId) return false;
      if (budget.principal !== null && budget.principal !== scope.principal) return false;
      if (budget.sessionId !== null && budget.sessionId !== scope.sessionId) return false;
      if (budget.workflowId !== null && budget.workflowId !== scope.workflowId) return false;
      if (budget.provider !== null && budget.provider !== scope.provider) return false;
      return true;
    });
  }

  private reservationViolations(
    budget: Budget,
    request: z.infer<typeof ReservationRequestSchema>,
    requestedProviderCalls = 1,
    state: BudgetStoreState = this.state,
  ) {
    const active = state.reservations.filter((reservation) => reservation.budgetIds.includes(budget.id));
    const reasons = this.currentViolations(budget, state);
    const reservedRequests = active.reduce((total, reservation) => total + reservationRequestHold(reservation, state), 0);

    if (budget.maxRequests !== null && budget.usedRequests + reservedRequests + requestedProviderCalls > budget.maxRequests) {
      reasons.push(`${budget.id}: request limit exceeded.`);
    }
    checkNullableLimit(
      reasons,
      budget.id,
      "input token",
      budget.maxInputTokens,
      projectedNullable(budget.usedUsage.input, active.map((item) => item.inputTokens), request.inputTokens),
    );
    checkNullableLimit(
      reasons,
      budget.id,
      "output token",
      budget.maxOutputTokens,
      projectedNullable(budget.usedUsage.output, active.map((item) => item.outputTokens), request.outputTokens),
    );
    checkNullableLimit(
      reasons,
      budget.id,
      "cost",
      budget.maxCostUsd,
      projectedNullable(budget.usedCost.amountUsd, active.map((item) => item.costUsd), request.costUsd),
    );
    const reservedArtifacts = active.reduce((total, item) => total + item.artifactBytes, 0);
    if (budget.maxArtifactBytes !== null && budget.usedArtifactBytes + reservedArtifacts + request.artifactBytes > budget.maxArtifactBytes) {
      reasons.push(`${budget.id}: artifact byte limit exceeded.`);
    }
    if (budget.maxRetries !== null && request.retries > budget.maxRetries) {
      reasons.push(`${budget.id}: retry limit exceeded.`);
    }
    return reasons;
  }

  private currentViolations(budget: Budget, state: BudgetStoreState = this.state) {
    const reasons: string[] = [];
    if (budget.maxRequests !== null && budget.usedRequests > budget.maxRequests) {
      reasons.push(`${budget.id}: request usage exceeds its limit.`);
    }
    checkNullableLimit(reasons, budget.id, "input token", budget.maxInputTokens, budget.usedUsage.input);
    checkNullableLimit(reasons, budget.id, "output token", budget.maxOutputTokens, budget.usedUsage.output);
    checkNullableLimit(reasons, budget.id, "cost", budget.maxCostUsd, budget.usedCost.amountUsd);
    if (budget.maxArtifactBytes !== null && budget.usedArtifactBytes > budget.maxArtifactBytes) {
      reasons.push(`${budget.id}: artifact usage exceeds its limit.`);
    }
    const active = this.concurrencyCount(budget.id, state);
    if (budget.maxConcurrency !== null && active > budget.maxConcurrency) {
      reasons.push(`${budget.id}: active concurrency exceeds its limit.`);
    }
    return reasons;
  }

  private linkedHoldViolations(
    parent: BudgetReservation,
    parentBudgets: Budget[],
    targetBudgets: Budget[],
    targetRequest: z.infer<typeof ReservationRequestSchema>,
    input: Pick<LinkedHoldRecord, "budgetFraction" | "parentAllocation" | "targetReservation">,
  ) {
    const reasons = [
      ...parentBudgets.flatMap((budget) => this.currentViolations(budget)),
      ...envelopeViolations(parent.envelope, input.parentAllocation, input.budgetFraction),
      ...envelopeCoverageViolations(input.parentAllocation, input.targetReservation),
      ...targetBudgets.flatMap((budget) => this.reservationViolations(budget, targetRequest, input.targetReservation.requests)),
    ];
    const finiteCostLimit = parent.envelope.costUsd !== null
      || parentBudgets.some((budget) => budget.maxCostUsd !== null)
      || targetBudgets.some((budget) => budget.maxCostUsd !== null);
    if (finiteCostLimit && (input.parentAllocation.costUsd === null || input.targetReservation.costUsd === null)) {
      reasons.push("Cross-provider delegation pricing is unknown under a finite parent or target cost limit.");
    }
    for (const budget of targetBudgets) {
      if (budget.maxConcurrency === null) continue;
      if (this.concurrencyCount(budget.id) + 1 > budget.maxConcurrency) {
        reasons.push(`${budget.id}: concurrency limit exceeded.`);
      }
    }
    return [...new Set(reasons)];
  }

  private reservationHoldsConcurrency(reservationId: string, state: BudgetStoreState = this.state) {
    return state.linkedHolds.some((hold) => hold.childReservationId === reservationId && linkedHoldConsumesCapacity(hold));
  }

  private concurrencyCount(budgetId: string, state: BudgetStoreState = this.state) {
    return state.reservations.filter((reservation) => reservation.budgetIds.includes(budgetId)
      && (reservation.active || this.reservationHoldsConcurrency(reservation.id, state))).length;
  }

  private persist() {
    this.state = BudgetStoreStateSchema.parse(this.state);
    writeOwnerOnlyJson(this.paths.budgetsPath, this.state);
  }

  private persistReplacement(value: BudgetStoreState) {
    const next = BudgetStoreStateSchema.parse(value);
    writeOwnerOnlyJson(this.paths.budgetsPath, next);
    this.state = next;
  }
}

function linkedHoldId(projectId: string, parentJobId: string, requestId: string) {
  return createHash("sha256").update(`${projectId}\0${parentJobId}\0${requestId}`).digest("hex");
}

function linkedOperationId(kind: "parent" | "target", linkId: string) {
  return `linked-${kind}-${linkId}`;
}

function linkedTargetRequest(
  projectId: string,
  parent: BudgetReservation,
  input: Pick<LinkedHoldRecord, "childReservationId" | "targetProvider" | "targetReservation">,
) {
  return ReservationRequestSchema.parse({
    id: input.childReservationId,
    projectId,
    principal: parent.principal,
    sessionId: null,
    workflowId: null,
    provider: input.targetProvider,
    inputTokens: input.targetReservation.inputTokens,
    outputTokens: input.targetReservation.outputTokens,
    costUsd: input.targetReservation.costUsd,
    artifactBytes: input.targetReservation.artifactBytes,
    retries: input.targetReservation.retries,
  });
}

function emptyBrokerEvidence() {
  return {
    parentCarveId: null,
    targetLeaseId: null,
    targetLeaseIssuedAt: null,
    targetRequests: null,
    targetForwardedRequests: null,
    targetInputTokens: null,
    targetOutputTokens: null,
    targetCostUsd: null,
    targetActiveRequests: null,
    targetRevoked: null,
    targetExpiresAt: null,
  };
}

function linkedPlanIdentity(value: PrepareLinkedProviderHoldInput | LinkedHoldRecord) {
  return JSON.stringify({
    parentJobId: value.parentJobId,
    parentReservationId: value.parentReservationId,
    childReservationId: value.childReservationId,
    requestId: value.requestId,
    parentBackend: value.parentBackend,
    targetBackend: value.targetBackend,
    parentProvider: value.parentProvider,
    targetProvider: value.targetProvider,
    budgetFraction: value.budgetFraction,
    parentDeadlineAt: value.parentDeadlineAt,
    childDeadlineAt: value.childDeadlineAt,
    approvalPolicy: value.approvalPolicy,
    parentAllocation: value.parentAllocation,
    targetReservation: value.targetReservation,
    requestDigest: value.requestDigest,
    promptDigest: value.promptDigest,
    promptBytes: value.promptBytes,
  });
}

function linkedHoldDenied(reason: string | string[]) {
  return {
    allowed: false as const,
    hold: null,
    reservation: null,
    existing: false,
    reasons: Array.isArray(reason) ? reason : [reason],
  };
}

function linkedHoldConsumesCapacity(hold: LinkedHoldRecord) {
  return hold.state !== "intent"
    && hold.state !== "settled"
    && hold.state !== "rolled_back"
    && hold.state !== "exhausted";
}

function reservationRequestHold(reservation: BudgetReservation, state: BudgetStoreState) {
  const linked = state.linkedHolds.some((hold) => hold.childReservationId === reservation.id && linkedHoldConsumesCapacity(hold));
  return linked ? reservation.envelope.requests : 1;
}

function envelopeCoverageViolations(
  parent: z.infer<typeof LinkedHoldEnvelopeSchema>,
  target: z.infer<typeof LinkedHoldEnvelopeSchema>,
) {
  const reasons: string[] = [];
  if (target.requests <= 0 || target.requests > parent.requests) reasons.push("Target request hold exceeds the linked parent allocation.");
  checkLinkedNullableCoverage(reasons, "input token", parent.inputTokens, target.inputTokens);
  checkLinkedNullableCoverage(reasons, "output token", parent.outputTokens, target.outputTokens);
  checkLinkedNullableCoverage(reasons, "cost", parent.costUsd, target.costUsd);
  if (target.artifactBytes > parent.artifactBytes) reasons.push("Target artifact hold exceeds the linked parent allocation.");
  if (target.retries > parent.retries) reasons.push("Target retry hold exceeds the linked parent allocation.");
  return reasons;
}

function checkLinkedNullableCoverage(reasons: string[], label: string, parent: number | null, target: number | null) {
  if (parent === null || target === null) {
    if (parent !== target) reasons.push(`Target ${label} hold cannot be linked across known and unknown allocations.`);
    return;
  }
  if (target > parent) reasons.push(`Target ${label} hold exceeds the linked parent allocation.`);
}

function projectedNullable(current: number | null, reserved: Array<number | null>, next: number | null) {
  if (current === null || next === null || reserved.some((value) => value === null)) return null;
  return current + next + reserved.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function migrateV2(state: z.infer<typeof LegacyBudgetStoreStateSchema>): z.infer<typeof BudgetStoreStateV3Schema> {
  return BudgetStoreStateV3Schema.parse({
    version: 3,
    projectId: state.projectId,
    budgets: state.budgets,
    reservations: state.reservations.map((reservation) => ({
      ...reservation,
      parentReservationId: null,
      delegationRequestId: null,
      budgetFraction: null,
      envelope: initialEnvelope(reservation),
    })),
    updatedAt: state.updatedAt,
  });
}

function migrateV3(state: z.infer<typeof BudgetStoreStateV3Schema>): BudgetStoreState {
  return BudgetStoreStateSchema.parse({
    ...state,
    version: 4,
    linkedHolds: [],
  });
}

function initialEnvelope(request: z.infer<typeof ReservationRequestSchema> | z.infer<typeof LegacyBudgetReservationSchema>) {
  return ReservationEnvelopeSchema.parse({
    requests: DEFAULT_TRANSFER_REQUESTS,
    inputTokens: Math.max(request.inputTokens ?? 0, DEFAULT_TRANSFER_INPUT_TOKENS),
    outputTokens: Math.max(request.outputTokens ?? 0, DEFAULT_TRANSFER_OUTPUT_TOKENS),
    costUsd: request.costUsd,
    artifactBytes: request.artifactBytes,
    retries: request.retries,
  });
}

function envelopeViolations(
  remaining: z.infer<typeof ReservationEnvelopeSchema>,
  requested: z.infer<typeof ReservationEnvelopeSchema>,
  fraction: number,
) {
  const reasons: string[] = [];
  const requestCap = Math.floor(remaining.requests * fraction);
  if (requested.requests <= 0 || requested.requests > requestCap) reasons.push("Delegated provider-call allocation exceeds the parent fraction cap.");
  checkEnvelopeNullable(reasons, "input token", remaining.inputTokens, requested.inputTokens, fraction);
  checkEnvelopeNullable(reasons, "output token", remaining.outputTokens, requested.outputTokens, fraction);
  checkEnvelopeNullable(reasons, "cost", remaining.costUsd, requested.costUsd, fraction);
  if (requested.artifactBytes > Math.floor(remaining.artifactBytes * fraction)) reasons.push("Delegated artifact allocation exceeds the parent fraction cap.");
  if (requested.retries > Math.floor(remaining.retries * fraction)) reasons.push("Delegated retry allocation exceeds the parent fraction cap.");
  return reasons;
}

function checkEnvelopeNullable(reasons: string[], label: string, remaining: number | null, requested: number | null, fraction: number) {
  if (remaining === null) {
    if (requested !== null) reasons.push(`Delegated ${label} allocation cannot be linked to an unknown parent remainder.`);
    return;
  }
  if (requested === null) {
    reasons.push(`Delegated ${label} allocation is unknown under a finite parent remainder.`);
    return;
  }
  if (requested > remaining * fraction) reasons.push(`Delegated ${label} allocation exceeds the parent fraction cap.`);
}

function subtractEnvelope(target: z.infer<typeof ReservationEnvelopeSchema>, allocation: z.infer<typeof ReservationEnvelopeSchema>) {
  target.requests -= allocation.requests;
  target.inputTokens = subtractNullable(target.inputTokens, allocation.inputTokens);
  target.outputTokens = subtractNullable(target.outputTokens, allocation.outputTokens);
  target.costUsd = subtractNullable(target.costUsd, allocation.costUsd);
  target.artifactBytes -= allocation.artifactBytes;
  target.retries -= allocation.retries;
}

function addEnvelope(target: z.infer<typeof ReservationEnvelopeSchema>, allocation: z.infer<typeof ReservationEnvelopeSchema>) {
  target.requests += allocation.requests;
  target.inputTokens = addNullable(target.inputTokens, allocation.inputTokens);
  target.outputTokens = addNullable(target.outputTokens, allocation.outputTokens);
  target.costUsd = addNullable(target.costUsd, allocation.costUsd);
  target.artifactBytes += allocation.artifactBytes;
  target.retries += allocation.retries;
}

function subtractNullable(current: number | null, allocation: number | null) {
  if (current === null || allocation === null) return null;
  return Math.max(0, current - allocation);
}

function returnUnusedEnvelope(
  parent: z.infer<typeof ReservationEnvelopeSchema>,
  allocated: z.infer<typeof ReservationEnvelopeSchema>,
  actual: z.infer<typeof CommitUsageSchema>,
) {
  const observed = actual.observedRequests === undefined ? allocated.requests : Math.min(allocated.requests, actual.observedRequests);
  parent.requests += Math.max(0, allocated.requests - observed);
  parent.inputTokens = returnUnusedNullable(parent.inputTokens, allocated.inputTokens, actual.inputTokens);
  parent.outputTokens = returnUnusedNullable(parent.outputTokens, allocated.outputTokens, actual.outputTokens);
  parent.costUsd = returnUnusedNullable(parent.costUsd, allocated.costUsd, actual.costUsd);
  parent.artifactBytes += Math.max(0, allocated.artifactBytes - (actual.artifactBytes ?? allocated.artifactBytes));
  // Retried child work consumes its entire retry slice; unused retries are not
  // provable from provider output and therefore remain exhausted.
}

function returnUnusedNullable(parent: number | null, allocated: number | null, actual: number | null | undefined) {
  if (parent === null || allocated === null || actual === null || actual === undefined) return parent;
  return parent + Math.max(0, allocated - actual);
}

function chargeBudgets(
  budgets: Budget[],
  reservation: BudgetReservation,
  actual: z.infer<typeof CommitUsageSchema>,
  now: number,
) {
  const observedRequests = Math.max(1, actual.observedRequests ?? 1);
  for (const budgetId of reservation.budgetIds) {
    const budget = budgets.find((candidate) => candidate.id === budgetId);
    if (!budget) continue;
    budget.usedRequests += observedRequests;
    budget.usedUsage.input = addNullable(budget.usedUsage.input, actual.inputTokens);
    budget.usedUsage.output = addNullable(budget.usedUsage.output, actual.outputTokens);
    budget.usedUsage.reasoning = addNullable(budget.usedUsage.reasoning, actual.reasoningTokens);
    budget.usedUsage.cached = addNullable(budget.usedUsage.cached, actual.cachedTokens);
    budget.usedUsage.providerTotal = addNullable(budget.usedUsage.providerTotal, actual.providerTotalTokens);
    budget.usedCost = addCost(budget.usedCost, {
      amountUsd: actual.costUsd ?? null,
      source: actual.costUsd === null ? "unknown" : (actual.costSource ?? "reconciled"),
      pricingId: actual.pricingId ?? null,
      observedRequests,
    });
    budget.usedArtifactBytes += actual.artifactBytes ?? 0;
    budget.updatedAt = now;
  }
}

function minimumNullable(left: number | null, right: number | null) {
  if (left === null) return right;
  if (right === null) return left;
  return Math.min(left, right);
}

function checkNullableLimit(
  reasons: string[],
  budgetId: string,
  label: string,
  maximum: number | null,
  projected: number | null,
) {
  if (maximum === null) return;
  if (projected === null) reasons.push(`${budgetId}: ${label} usage is unknown under a configured limit.`);
  else if (projected > maximum) reasons.push(`${budgetId}: ${label} limit exceeded.`);
}

function addNullable(current: number | null, next: number | null | undefined) {
  if (next === undefined) return current;
  if (current === null || next === null) return null;
  return current + next;
}

function addCost(current: Budget["usedCost"], next: Budget["usedCost"]): Budget["usedCost"] {
  const amountUsd = addNullable(current.amountUsd, next.amountUsd);
  return {
    amountUsd,
    source: amountUsd === null ? "unknown" : next.source,
    pricingId: next.pricingId ?? current.pricingId,
    observedRequests: current.observedRequests + next.observedRequests,
  };
}

function projectedCommitViolations(
  budget: Budget,
  inputTokens: number | null,
  outputTokens: number | null,
  costUsd: number | null,
  artifactBytes: number,
  observedRequests = 1,
) {
  const reasons: string[] = [];
  if (budget.maxRequests !== null && budget.usedRequests + Math.max(1, observedRequests) > budget.maxRequests) reasons.push(`${budget.id}: request limit exceeded.`);
  checkNullableLimit(reasons, budget.id, "input token", budget.maxInputTokens, addNullable(budget.usedUsage.input, inputTokens));
  checkNullableLimit(reasons, budget.id, "output token", budget.maxOutputTokens, addNullable(budget.usedUsage.output, outputTokens));
  checkNullableLimit(reasons, budget.id, "cost", budget.maxCostUsd, addNullable(budget.usedCost.amountUsd, costUsd));
  if (budget.maxArtifactBytes !== null && budget.usedArtifactBytes + artifactBytes > budget.maxArtifactBytes) {
    reasons.push(`${budget.id}: artifact byte limit exceeded.`);
  }
  return reasons;
}
