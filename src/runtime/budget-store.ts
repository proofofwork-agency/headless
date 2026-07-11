import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BudgetSchema, type Budget } from "../contracts/durable";
import { IdentifierSchema, PrincipalIdSchema, ProjectIdSchema, TimestampSchema } from "../contracts/common";
import { ensureProjectStateDirectories, type ProjectStatePaths } from "./project-state";
import { readOwnerOnlyJson, writeOwnerOnlyJson } from "./owner-json";

const nullableCount = z.number().int().nonnegative().nullable();
const nullableCost = z.number().nonnegative().nullable();

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

const BudgetReservationSchema = ReservationRequestSchema.omit({ id: true }).extend({
  id: IdentifierSchema,
  budgetIds: z.array(IdentifierSchema),
  active: z.boolean().default(false),
  createdAt: TimestampSchema,
}).strict();

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

const BudgetStoreStateSchema = z.object({
  version: z.literal(2),
  projectId: ProjectIdSchema,
  budgets: z.array(BudgetSchema),
  reservations: z.array(BudgetReservationSchema),
  updatedAt: TimestampSchema,
}).strict();

export type BudgetScope = z.input<typeof BudgetScopeSchema>;
export type BudgetReservationRequest = z.input<typeof ReservationRequestSchema>;
export type BudgetReservation = z.infer<typeof BudgetReservationSchema>;
export type CommitUsage = z.input<typeof CommitUsageSchema>;
export type BudgetStoreState = z.infer<typeof BudgetStoreStateSchema>;
export type BudgetCheck = {
  passed: boolean;
  budgetIds: string[];
  reasons: string[];
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

    const existing = readOwnerOnlyJson(paths.budgetsPath, BudgetStoreStateSchema);
    if (existing) {
      if (existing.projectId !== this.projectId) {
        throw new Error(`Budget project mismatch: expected ${this.projectId}, got ${existing.projectId}`);
      }
      this.state = existing;
      return;
    }

    this.state = BudgetStoreStateSchema.parse({
      version: 2,
      projectId: this.projectId,
      budgets: [],
      reservations: [],
      updatedAt: this.now(),
    });
    this.persist();
  }

  getState() {
    return BudgetStoreStateSchema.parse(this.state);
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
      const active = this.state.reservations.filter((candidate) => candidate.active && candidate.budgetIds.includes(budget.id)).length;
      return active + 1 > budget.maxConcurrency ? [`${budget.id}: concurrency limit exceeded.`] : [];
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
  brokerLeaseLimits(reservationId: string, defaultMaxRequests = 64) {
    if (!Number.isSafeInteger(defaultMaxRequests) || defaultMaxRequests <= 0) {
      throw new TypeError("Default broker request limit must be a positive safe integer.");
    }
    const reservation = this.state.reservations.find((candidate) => candidate.id === reservationId);
    if (!reservation) throw new Error(`Unknown budget reservation: ${reservationId}`);
    let maxRequests = defaultMaxRequests;
    let maxCostUsd: number | null = null;
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
    if (maxRequests <= 0) throw new Error("Broker request budget is exhausted.");
    if (maxCostUsd !== null && maxCostUsd < 0) throw new Error("Broker cost budget is exhausted.");
    return { maxRequests, maxCostUsd, budgetQuotas };
  }

  release(reservationId: string) {
    const index = this.state.reservations.findIndex((candidate) => candidate.id === reservationId);
    if (index === -1) return false;
    this.state.reservations.splice(index, 1);
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

  private matchingBudgets(scope: z.infer<typeof BudgetScopeSchema>) {
    return this.state.budgets.filter((budget) => {
      if (budget.projectId !== scope.projectId) return false;
      if (budget.principal !== null && budget.principal !== scope.principal) return false;
      if (budget.sessionId !== null && budget.sessionId !== scope.sessionId) return false;
      if (budget.workflowId !== null && budget.workflowId !== scope.workflowId) return false;
      if (budget.provider !== null && budget.provider !== scope.provider) return false;
      return true;
    });
  }

  private reservationViolations(budget: Budget, request: z.infer<typeof ReservationRequestSchema>) {
    const active = this.state.reservations.filter((reservation) => reservation.budgetIds.includes(budget.id));
    const reasons = this.currentViolations(budget);

    if (budget.maxRequests !== null && budget.usedRequests + active.length + 1 > budget.maxRequests) {
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

  private currentViolations(budget: Budget) {
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
    const active = this.state.reservations.filter((reservation) => reservation.active && reservation.budgetIds.includes(budget.id)).length;
    if (budget.maxConcurrency !== null && active > budget.maxConcurrency) {
      reasons.push(`${budget.id}: active concurrency exceeds its limit.`);
    }
    return reasons;
  }

  private persist() {
    this.state = BudgetStoreStateSchema.parse(this.state);
    writeOwnerOnlyJson(this.paths.budgetsPath, this.state);
  }
}

function projectedNullable(current: number | null, reserved: Array<number | null>, next: number | null) {
  if (current === null || next === null || reserved.some((value) => value === null)) return null;
  return current + next + reserved.reduce<number>((total, value) => total + (value ?? 0), 0);
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
