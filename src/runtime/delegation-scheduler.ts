import { z } from "zod";
import { DelegationSchema, type Delegation } from "../contracts/collaboration";
import { IdentifierSchema, TimestampSchema } from "../contracts/common";
import { readOwnerOnlyJson, writeOwnerOnlyJson } from "./owner-json";

export const DEFAULT_MAX_ACTIVE_DELEGATIONS = 4;
export const DEFAULT_MAX_QUEUED_DELEGATIONS = 64;
export const MAX_PERSISTED_DELEGATIONS = 1_088;

const SchedulerSnapshotSchema = z.object({
  version: z.literal(1),
  maxActive: z.number().int().positive().max(64),
  maxQueued: z.number().int().positive().max(1_024),
  nextSequence: z.number().int().positive(),
  delegations: z.array(DelegationSchema).max(MAX_PERSISTED_DELEGATIONS),
}).strict().superRefine((snapshot, context) => {
  const ids = snapshot.delegations.map((delegation) => delegation.id);
  const sequences = snapshot.delegations.map((delegation) => delegation.sequence);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Scheduler delegation ids must be unique.", path: ["delegations"] });
  }
  if (new Set(sequences).size !== sequences.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Scheduler delegation sequences must be unique.", path: ["delegations"] });
  }
  const queued = snapshot.delegations.filter((delegation) => delegation.state === "queued");
  const active = snapshot.delegations.filter((delegation) => delegation.state === "active");
  if (queued.length > snapshot.maxQueued) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Persisted scheduler queue exceeds its configured bound.", path: ["delegations"] });
  }
  if (active.length > snapshot.maxActive) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Persisted scheduler active set exceeds its configured bound.", path: ["delegations"] });
  }
  const activeSessions = active.flatMap((delegation) => delegation.nativeSessionId === null ? [] : [delegation.nativeSessionId]);
  if (new Set(activeSessions).size !== activeSessions.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A native session cannot have more than one active turn.", path: ["delegations"] });
  }
});

export type DelegationSchedulerSnapshot = z.infer<typeof SchedulerSnapshotSchema>;

export type DelegationDraft = Pick<Delegation,
  "id" | "goalId" | "fromAgentId" | "toAgentId" | "nativeSessionId" | "task" | "deadlineAt"
> & Partial<Pick<Delegation, "availableAt" | "maxAttempts" | "artifactIds">>;

export type SchedulerErrorCode =
  | "QUEUE_CAPACITY_EXCEEDED"
  | "DELEGATION_NOT_FOUND"
  | "INVALID_DELEGATION_STATE"
  | "DELEGATION_DEADLINE_EXCEEDED"
  | "DUPLICATE_DELEGATION";

export class DelegationSchedulerError extends Error {
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    readonly code: SchedulerErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "DelegationSchedulerError";
    this.retryable = options.retryable ?? false;
    this.details = Object.freeze({ ...(options.details ?? {}) });
  }
}

export type DelegationAdmission = {
  delegation: Delegation;
  queuePosition: number;
};

export type DelegationRequeueResult = {
  delegation: Delegation;
  requeued: boolean;
  reason: "requeued" | "retry_exhausted" | "deadline_exceeded" | "queue_capacity";
  queuePosition: number | null;
};

export class DelegationScheduler {
  readonly maxActive: number;
  readonly maxQueued: number;
  private state: DelegationSchedulerSnapshot;
  private readonly statePath?: string;
  private readonly clock: () => number;

  constructor(options: {
    statePath?: string;
    maxActive?: number;
    maxQueued?: number;
    clock?: () => number;
    snapshot?: DelegationSchedulerSnapshot;
  } = {}) {
    this.statePath = options.statePath;
    this.clock = options.clock ?? Date.now;
    const configured = z.object({
      maxActive: z.number().int().positive().max(64),
      maxQueued: z.number().int().positive().max(1_024),
    }).strict().parse({
      maxActive: options.maxActive ?? DEFAULT_MAX_ACTIVE_DELEGATIONS,
      maxQueued: options.maxQueued ?? DEFAULT_MAX_QUEUED_DELEGATIONS,
    });
    const persisted = options.snapshot
      ?? (this.statePath ? readOwnerOnlyJson(this.statePath, SchedulerSnapshotSchema) : null);
    if (persisted && options.snapshot && this.statePath) {
      throw new TypeError("Pass either a scheduler snapshot or statePath, not both.");
    }
    this.state = persisted ?? {
      version: 1,
      maxActive: configured.maxActive,
      maxQueued: configured.maxQueued,
      nextSequence: 1,
      delegations: [],
    };
    this.state = SchedulerSnapshotSchema.parse(this.state);
    this.maxActive = this.state.maxActive;
    this.maxQueued = this.state.maxQueued;
  }

  enqueue(input: DelegationDraft, at = this.clock()): DelegationAdmission {
    const now = TimestampSchema.parse(at);
    this.expireDeadlinesInternal(now);
    if (this.state.delegations.some((delegation) => delegation.id === input.id)) {
      throw new DelegationSchedulerError("DUPLICATE_DELEGATION", `Delegation already exists: ${input.id}`);
    }
    if (this.queuedCount() >= this.maxQueued) {
      this.persist();
      throw new DelegationSchedulerError(
        "QUEUE_CAPACITY_EXCEEDED",
        `Delegation queue is at its ${this.maxQueued}-item capacity.`,
        { retryable: true, details: { maxQueued: this.maxQueued } },
      );
    }
    if (input.deadlineAt <= now) {
      throw new DelegationSchedulerError(
        "DELEGATION_DEADLINE_EXCEEDED",
        `Delegation deadline has already elapsed: ${input.id}`,
      );
    }
    const delegation = DelegationSchema.parse({
      ...input,
      sequence: this.takeSequence(),
      state: "queued",
      attempt: 0,
      maxAttempts: input.maxAttempts ?? 2,
      availableAt: input.availableAt ?? now,
      rateLimit: null,
      resultTurnId: null,
      artifactIds: input.artifactIds ?? [],
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });
    this.pruneTerminalHistoryForAdmission();
    this.state.delegations.push(delegation);
    this.persist();
    return { delegation: cloneDelegation(delegation), queuePosition: this.queuePosition(delegation.id)! };
  }

  claimNext(
    at = this.clock(),
    eligible: (delegation: Delegation) => boolean = () => true,
  ): Delegation | null {
    const now = TimestampSchema.parse(at);
    let changed = this.expireDeadlinesInternal(now);
    if (this.activeCount() >= this.maxActive) {
      if (changed) this.persist();
      return null;
    }
    const lockedSessions = new Set(this.state.delegations.flatMap((delegation) =>
      delegation.state === "active" && delegation.nativeSessionId !== null ? [delegation.nativeSessionId] : []));
    const next = this.orderedQueued().find((delegation) =>
      delegation.availableAt <= now
      && delegation.attempt < delegation.maxAttempts
      && eligible(cloneDelegation(delegation))
      && (delegation.nativeSessionId === null || !lockedSessions.has(delegation.nativeSessionId)));
    if (!next) {
      if (changed) this.persist();
      return null;
    }
    next.state = "active";
    next.attempt += 1;
    next.updatedAt = now;
    DelegationSchema.parse(next);
    changed = true;
    if (changed) this.persist();
    return cloneDelegation(next);
  }

  bindNativeSession(id: string, nativeSessionId: string, at = this.clock()): Delegation {
    const delegation = this.require(id);
    if (delegation.state !== "queued" && delegation.state !== "active") {
      throw new DelegationSchedulerError(
        "INVALID_DELEGATION_STATE",
        `Delegation ${id} is ${delegation.state}; native sessions can only bind queued or active delegations.`,
      );
    }
    const sessionId = z.string().trim().min(1).max(512).parse(nativeSessionId);
    if (delegation.state === "active") {
      const conflict = this.state.delegations.find((candidate) =>
        candidate.id !== delegation.id
        && candidate.state === "active"
        && candidate.nativeSessionId === sessionId);
      if (conflict) {
        throw new DelegationSchedulerError(
          "INVALID_DELEGATION_STATE",
          `Native session ${sessionId} is already active for delegation ${conflict.id}.`,
          { details: { conflictingDelegationId: conflict.id } },
        );
      }
    }
    delegation.nativeSessionId = sessionId;
    delegation.updatedAt = TimestampSchema.parse(at);
    DelegationSchema.parse(delegation);
    this.persist();
    return cloneDelegation(delegation);
  }

  claimReady(at = this.clock()): Delegation[] {
    const claimed: Delegation[] = [];
    for (;;) {
      const next = this.claimNext(at);
      if (!next) return claimed;
      claimed.push(next);
    }
  }

  complete(id: string, resultTurnId: string, artifactIds: string[] = [], at = this.clock()): Delegation {
    const delegation = this.requireState(id, "active");
    delegation.state = "succeeded";
    delegation.resultTurnId = IdentifierSchema.parse(resultTurnId);
    delegation.artifactIds = z.array(IdentifierSchema).max(256).parse(artifactIds);
    delegation.lastError = null;
    delegation.updatedAt = TimestampSchema.parse(at);
    DelegationSchema.parse(delegation);
    this.persist();
    return cloneDelegation(delegation);
  }

  fail(id: string, error: string, at = this.clock()): Delegation {
    const delegation = this.requireState(id, "active");
    delegation.state = "failed";
    delegation.lastError = z.string().min(1).max(16_384).parse(error);
    delegation.updatedAt = TimestampSchema.parse(at);
    DelegationSchema.parse(delegation);
    this.persist();
    return cloneDelegation(delegation);
  }

  cancel(id: string, at = this.clock(), reason = "Cancelled."): Delegation {
    const delegation = this.require(id);
    if (["succeeded", "failed", "cancelled", "expired"].includes(delegation.state)) return cloneDelegation(delegation);
    delegation.state = "cancelled";
    delegation.lastError = z.string().min(1).max(16_384).parse(reason);
    delegation.updatedAt = TimestampSchema.parse(at);
    DelegationSchema.parse(delegation);
    this.persist();
    return cloneDelegation(delegation);
  }

  requeueRateLimited(
    id: string,
    retryAfterMs: number,
    evidence: string,
    at = this.clock(),
  ): DelegationRequeueResult {
    const now = TimestampSchema.parse(at);
    const delay = z.number().int().positive().max(86_400_000).parse(retryAfterMs);
    const safeEvidence = z.string().max(4_096).parse(evidence);
    const delegation = this.requireState(id, "active");
    const availableAt = now + delay;
    if (delegation.attempt >= delegation.maxAttempts) {
      return this.closeRequeue(delegation, "retry_exhausted", "Rate-limit retry budget exhausted.", now);
    }
    if (availableAt >= delegation.deadlineAt) {
      return this.closeRequeue(delegation, "deadline_exceeded", "Rate-limit recovery would exceed the goal deadline.", now);
    }
    if (this.queuedCount() >= this.maxQueued) {
      return this.closeRequeue(delegation, "queue_capacity", "Rate-limited delegation could not requeue because the queue is full.", now);
    }
    delegation.state = "queued";
    delegation.sequence = this.takeSequence();
    delegation.availableAt = availableAt;
    delegation.rateLimit = { observedAt: now, retryAfterMs: delay, evidence: safeEvidence };
    delegation.lastError = "Rate limited; waiting for retry availability.";
    delegation.updatedAt = now;
    DelegationSchema.parse(delegation);
    this.persist();
    return {
      delegation: cloneDelegation(delegation),
      requeued: true,
      reason: "requeued",
      queuePosition: this.queuePosition(id),
    };
  }

  requeueFailed(id: string, error: string, at = this.clock()): DelegationRequeueResult {
    const now = TimestampSchema.parse(at);
    const safeError = z.string().min(1).max(16_384).parse(error);
    const delegation = this.requireState(id, "active");
    if (delegation.attempt >= delegation.maxAttempts) {
      return this.closeRequeue(delegation, "retry_exhausted", `${safeError} Retry budget exhausted.`, now);
    }
    if (now >= delegation.deadlineAt) {
      return this.closeRequeue(delegation, "deadline_exceeded", `${safeError} Goal deadline elapsed.`, now);
    }
    if (this.queuedCount() >= this.maxQueued) {
      return this.closeRequeue(delegation, "queue_capacity", `${safeError} Delegation could not requeue because the queue is full.`, now);
    }
    delegation.state = "queued";
    delegation.sequence = this.takeSequence();
    delegation.availableAt = now;
    delegation.rateLimit = null;
    delegation.lastError = safeError;
    delegation.updatedAt = now;
    DelegationSchema.parse(delegation);
    this.persist();
    return {
      delegation: cloneDelegation(delegation),
      requeued: true,
      reason: "requeued",
      queuePosition: this.queuePosition(id),
    };
  }

  expireDeadlines(at = this.clock()): Delegation[] {
    const now = TimestampSchema.parse(at);
    const before = new Set(this.state.delegations.filter((delegation) => delegation.state === "expired").map((delegation) => delegation.id));
    const changed = this.expireDeadlinesInternal(now);
    if (changed) this.persist();
    return this.state.delegations
      .filter((delegation) => delegation.state === "expired" && !before.has(delegation.id))
      .map(cloneDelegation);
  }

  get(id: string): Delegation | null {
    const delegation = this.state.delegations.find((candidate) => candidate.id === id);
    return delegation ? cloneDelegation(delegation) : null;
  }

  list(state?: Delegation["state"]): Delegation[] {
    return this.state.delegations
      .filter((delegation) => state === undefined || delegation.state === state)
      .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id))
      .map(cloneDelegation);
  }

  queuePosition(id: string): number | null {
    const index = this.orderedQueued().findIndex((delegation) => delegation.id === id);
    return index < 0 ? null : index + 1;
  }

  activeCount() {
    return this.state.delegations.filter((delegation) => delegation.state === "active").length;
  }

  queuedCount() {
    return this.state.delegations.filter((delegation) => delegation.state === "queued").length;
  }

  snapshot(): DelegationSchedulerSnapshot {
    return structuredClone(SchedulerSnapshotSchema.parse(this.state));
  }

  private orderedQueued() {
    return this.state.delegations
      .filter((delegation) => delegation.state === "queued")
      .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
  }

  private require(id: string) {
    const parsedId = IdentifierSchema.parse(id);
    const delegation = this.state.delegations.find((candidate) => candidate.id === parsedId);
    if (!delegation) throw new DelegationSchedulerError("DELEGATION_NOT_FOUND", `Unknown delegation: ${parsedId}`);
    return delegation;
  }

  private requireState(id: string, state: Delegation["state"]) {
    const delegation = this.require(id);
    if (delegation.state !== state) {
      throw new DelegationSchedulerError(
        "INVALID_DELEGATION_STATE",
        `Delegation ${id} is ${delegation.state}; expected ${state}.`,
        { details: { actual: delegation.state, expected: state } },
      );
    }
    return delegation;
  }

  private closeRequeue(
    delegation: Delegation,
    reason: Exclude<DelegationRequeueResult["reason"], "requeued">,
    error: string,
    at: number,
  ): DelegationRequeueResult {
    delegation.state = reason === "deadline_exceeded" ? "expired" : "failed";
    delegation.lastError = error;
    delegation.updatedAt = at;
    DelegationSchema.parse(delegation);
    this.persist();
    return { delegation: cloneDelegation(delegation), requeued: false, reason, queuePosition: null };
  }

  private expireDeadlinesInternal(at: number) {
    let changed = false;
    for (const delegation of this.state.delegations) {
      if (!["queued", "active"].includes(delegation.state) || delegation.deadlineAt > at) continue;
      delegation.state = "expired";
      delegation.lastError = "Delegation deadline elapsed.";
      delegation.updatedAt = at;
      DelegationSchema.parse(delegation);
      changed = true;
    }
    return changed;
  }

  private takeSequence() {
    const sequence = this.state.nextSequence;
    this.state.nextSequence += 1;
    return sequence;
  }

  /**
   * Goal records retain the complete terminal delegation evidence. The
   * scheduler only needs bounded recent terminal history alongside every live
   * item, otherwise a long-lived project eventually becomes impossible to
   * admit after enough completed work.
   */
  private pruneTerminalHistoryForAdmission() {
    const overflow = this.state.delegations.length + 1 - MAX_PERSISTED_DELEGATIONS;
    if (overflow <= 0) return;
    const terminal = this.state.delegations
      .filter((delegation) => !["queued", "active"].includes(delegation.state))
      .sort((left, right) => left.updatedAt - right.updatedAt
        || left.sequence - right.sequence
        || left.id.localeCompare(right.id));
    if (terminal.length < overflow) {
      throw new DelegationSchedulerError(
        "QUEUE_CAPACITY_EXCEEDED",
        "Delegation scheduler has no terminal history available to compact for admission.",
        { retryable: true, details: { maxPersisted: MAX_PERSISTED_DELEGATIONS } },
      );
    }
    const removed = new Set(terminal.slice(0, overflow).map((delegation) => delegation.id));
    this.state.delegations = this.state.delegations.filter((delegation) => !removed.has(delegation.id));
  }

  private persist() {
    // Each mutation validates its changed delegation and preserves the
    // scheduler-wide bounds explicitly. Avoid reparsing the entire bounded
    // history for an in-memory scheduler on every lifecycle transition;
    // snapshot() and durable writes still validate the complete state.
    if (!this.statePath) return;
    this.state = SchedulerSnapshotSchema.parse(this.state);
    writeOwnerOnlyJson(this.statePath, this.state);
  }
}

function cloneDelegation(delegation: Delegation) {
  return structuredClone(delegation);
}
