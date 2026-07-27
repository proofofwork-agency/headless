import { randomUUID } from "node:crypto";
import type { Delegation, Goal } from "../contracts/collaboration";
import type { RunErrorCode } from "../contracts/common";
import { DelegationScheduler, DelegationSchedulerError } from "./delegation-scheduler";
import type { GoalStore } from "./goal-store";
import { HeadlessError } from "./headless-error";

export type GoalDelegationAttempt<T> =
  | { kind: "succeeded"; value: T; resultTurnId: string; artifactIds?: string[] }
  | { kind: "failed"; error: string; code?: RunErrorCode; retryable?: boolean }
  | { kind: "rate_limited"; error: string; retryAfterMs: number; evidence: string };

export type GoalDelegationEvent = {
  kind: "queued" | "active" | "requeued" | "succeeded" | "failed" | "cancelled" | "expired";
  delegation: Delegation;
  queuePosition: number | null;
};

export type GoalDelegationRunInput<T> = {
  goal: Goal;
  fromAgentId: string;
  toAgentId: string;
  nativeSessionId: string | null;
  task: string;
  maxActive: number;
  maxQueued: number;
  maxAttempts: number;
  execute: (
    delegation: Delegation,
    context: { bindNativeSession: (sessionId: string) => Delegation },
  ) => Promise<GoalDelegationAttempt<T>>;
  cancel?: () => void;
};

type PendingTask<T = unknown> = {
  input: GoalDelegationRunInput<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

export class GoalDelegationRuntime {
  readonly scheduler: DelegationScheduler;
  private readonly tasks = new Map<string, PendingTask>();
  private readonly knownSessions = new Map<string, string>();
  private readonly lastQueuePositions = new Map<string, number>();
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly onEvent: (event: GoalDelegationEvent) => void;
  private readonly diagnostic: (message: string, error?: unknown) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pumping = false;

  constructor(private readonly options: {
    goals: GoalStore;
    scheduler?: DelegationScheduler;
    onEvent?: (event: GoalDelegationEvent) => void;
    diagnostic?: (message: string, error?: unknown) => void;
    now?: () => number;
    id?: () => string;
  }) {
    this.scheduler = options.scheduler ?? new DelegationScheduler({ clock: options.now });
    this.now = options.now ?? Date.now;
    this.id = options.id ?? randomUUID;
    this.onEvent = options.onEvent ?? (() => {});
    this.diagnostic = options.diagnostic ?? ((message, error) => console.error(message, error));
    this.restoreKnownSessions();
  }

  run<T>(input: GoalDelegationRunInput<T>): Promise<T> {
    // Reconcile elapsed work before evaluating capacity so expired items never
    // cause a false overflow rejection.
    this.pump();
    const profileQueuedLimit = Math.min(input.maxQueued, this.scheduler.maxQueued);
    if (this.scheduler.queuedCount() >= profileQueuedLimit) {
      throw new HeadlessError(
        "QUEUE_CAPACITY_EXCEEDED",
        `Delegation queue is at its ${profileQueuedLimit}-item project capacity.`,
        { retryable: true, details: { maxQueued: profileQueuedLimit } },
      );
    }
    const nativeSessionId = input.nativeSessionId ?? this.knownSessions.get(sessionKey(input.goal.id, input.toAgentId)) ?? null;
    const id = `delegation_${this.id()}`;
    let admission;
    try {
      admission = this.scheduler.enqueue({
        id,
        goalId: input.goal.id,
        fromAgentId: input.fromAgentId,
        toAgentId: input.toAgentId,
        nativeSessionId,
        task: input.task,
        deadlineAt: input.goal.deadlineAt,
        maxAttempts: input.maxAttempts,
      }, this.now());
      this.options.goals.addDelegation(input.goal.id, admission.delegation);
    } catch (error) {
      if (this.scheduler.get(id)?.state === "queued") {
        try { this.scheduler.cancel(id, this.now()); } catch (persistenceError) {
          this.diagnostic(`Unable to roll back delegation admission ${id}.`, persistenceError);
        }
      }
      if (error instanceof DelegationSchedulerError && error.code === "QUEUE_CAPACITY_EXCEEDED") {
        throw new HeadlessError("QUEUE_CAPACITY_EXCEEDED", error.message, {
          retryable: error.retryable,
          details: { ...error.details },
          cause: error,
        });
      }
      throw error;
    }

    const promise = new Promise<T>((resolve, reject) => {
      this.tasks.set(id, { input, resolve, reject } as PendingTask);
    });
    this.lastQueuePositions.set(id, admission.queuePosition);
    this.emit({ kind: "queued", delegation: admission.delegation, queuePosition: admission.queuePosition });
    this.refreshQueuePositions();
    this.pump();
    return promise;
  }

  pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      const now = this.now();
      for (const delegation of this.scheduler.expireDeadlines(now)) {
        this.persist(delegation);
        const task = this.tasks.get(delegation.id);
        task?.input.cancel?.();
        this.finishFailure(delegation, new HeadlessError("TIMED_OUT", "Delegation deadline elapsed."), "expired");
      }
      for (;;) {
        const claimed = this.scheduler.claimNext(now, (delegation) => {
          const task = this.tasks.get(delegation.id);
          if (!task) return false;
          return this.scheduler.activeCount() < Math.min(task.input.maxActive, this.scheduler.maxActive);
        });
        if (!claimed) break;
        this.persist(claimed);
        this.emit({ kind: "active", delegation: claimed, queuePosition: null });
        void this.execute(claimed);
      }
      this.refreshQueuePositions();
      this.scheduleWake();
    } finally {
      this.pumping = false;
    }
  }

  cancelGoal(goalId: string) {
    const cancelled: Delegation[] = [];
    for (const delegation of this.scheduler.list().filter((candidate) =>
      candidate.goalId === goalId && (candidate.state === "queued" || candidate.state === "active"))) {
      const task = this.tasks.get(delegation.id);
      task?.input.cancel?.();
      const next = this.scheduler.cancel(delegation.id, this.now());
      this.persist(next);
      cancelled.push(next);
      this.finishFailure(next, new HeadlessError("CANCELLED", "Delegation was cancelled."), "cancelled");
    }
    this.refreshQueuePositions();
    this.pump();
    return cancelled;
  }

  recoverInterrupted() {
    const recovered: Delegation[] = [];
    for (const delegation of this.scheduler.list()) {
      if (delegation.state === "active") {
        const next = this.scheduler.fail(delegation.id, "Delegation was interrupted by daemon restart.", this.now());
        this.persist(next);
        recovered.push(next);
      } else if (delegation.state === "queued") {
        const next = this.scheduler.cancel(
          delegation.id,
          this.now(),
          "Queued delegation was superseded by daemon restart recovery.",
        );
        this.persist(next);
        recovered.push(next);
      }
    }
    return recovered;
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // A graceful stop awaits idle before disposing, so anything still here is
    // mid-flight against a store that is going away. Dropping the entries makes
    // the late settlement a no-op rather than a write into a torn-down home.
    // They are not rejected: these promises may already be unobserved, and
    // rejecting them would recreate the escaping-rejection this guards against.
    this.tasks.clear();
  }

  private async execute(delegation: Delegation) {
    const task = this.tasks.get(delegation.id);
    if (!task) return;
    let attempt: GoalDelegationAttempt<unknown>;
    try {
      attempt = await task.input.execute(delegation, {
        bindNativeSession: (sessionId) => this.bindNativeSession(delegation.id, sessionId),
      });
    } catch (error) {
      attempt = { kind: "failed", error: error instanceof Error ? error.message : String(error) };
    }
    if (!this.tasks.has(delegation.id)) return;
    try {
      this.settle(delegation, attempt);
    } catch (error) {
      // Nothing awaits this call, so an escaping rejection lands on the process
      // rather than on a caller. The realistic cause is a store torn down while
      // the attempt was in flight, which must not take the process with it.
      this.abandon(delegation, error);
    }
  }

  private settle(delegation: Delegation, attempt: GoalDelegationAttempt<unknown>) {
    const task = this.tasks.get(delegation.id);
    if (!task) return;

    if (attempt.kind === "rate_limited") {
      const recovery = this.scheduler.requeueRateLimited(
        delegation.id,
        attempt.retryAfterMs,
        attempt.evidence,
        this.now(),
      );
      this.persist(recovery.delegation);
      if (recovery.requeued) {
        this.emit({ kind: "requeued", delegation: recovery.delegation, queuePosition: recovery.queuePosition });
        this.refreshQueuePositions();
        this.pump();
        return;
      }
      this.finishFailure(
        recovery.delegation,
        new HeadlessError("RATE_LIMITED", recovery.delegation.lastError ?? attempt.error, {
          retryable: false,
          details: {
            retryReason: recovery.reason,
            retryAfterMs: attempt.retryAfterMs,
            evidence: attempt.evidence,
          },
        }),
        recovery.delegation.state === "expired" ? "expired" : "failed",
      );
      this.pump();
      return;
    }

    if (attempt.kind === "failed") {
      const recovery = this.scheduler.requeueFailed(delegation.id, boundedError(attempt.error), this.now());
      this.persist(recovery.delegation);
      if (recovery.requeued) {
        this.emit({ kind: "requeued", delegation: recovery.delegation, queuePosition: recovery.queuePosition });
        this.refreshQueuePositions();
        this.pump();
        return;
      }
      this.finishFailure(recovery.delegation, new HeadlessError(
        attempt.code ?? "PROCESS_ERROR",
        recovery.delegation.lastError ?? "Delegation failed.",
        { retryable: attempt.retryable, details: { retryReason: recovery.reason } },
      ), recovery.delegation.state === "expired" ? "expired" : "failed");
      this.pump();
      return;
    }

    const completed = this.scheduler.complete(
      delegation.id,
      attempt.resultTurnId,
      attempt.artifactIds ?? [],
      this.now(),
    );
    this.persist(completed);
    this.emit({ kind: "succeeded", delegation: completed, queuePosition: null });
    this.tasks.delete(delegation.id);
    task.resolve(attempt.value);
    this.refreshQueuePositions();
    this.pump();
  }

  private bindNativeSession(delegationId: string, nativeSessionId: string) {
    const current = this.scheduler.get(delegationId);
    if (!current) throw new Error(`Unknown delegation: ${delegationId}`);
    const bound = this.scheduler.bindNativeSession(delegationId, nativeSessionId, this.now());
    this.persist(bound);
    const key = sessionKey(bound.goalId, bound.toAgentId);
    this.knownSessions.set(key, nativeSessionId);
    for (const queued of this.scheduler.list("queued")) {
      const task = this.tasks.get(queued.id);
      if (!task || sessionKey(queued.goalId, queued.toAgentId) !== key) continue;
      const next = this.scheduler.bindNativeSession(queued.id, nativeSessionId, this.now());
      this.persist(next);
    }
    return bound;
  }

  private finishFailure(
    delegation: Delegation,
    error: HeadlessError,
    kind: "failed" | "cancelled" | "expired",
  ) {
    const task = this.tasks.get(delegation.id);
    if (!task) return;
    this.tasks.delete(delegation.id);
    this.emit({ kind, delegation, queuePosition: null });
    task.reject(error);
  }

  /**
   * Fail a delegation whose outcome could not be recorded. The caller is still
   * awaiting `run`, so rejecting is what reaches a human; silently dropping the
   * task would hang it instead.
   */
  private abandon(delegation: Delegation, error: unknown) {
    this.diagnostic(`Unable to record the outcome of delegation ${delegation.id}.`, error);
    const task = this.tasks.get(delegation.id);
    if (!task) return;
    this.tasks.delete(delegation.id);
    task.reject(new HeadlessError(
      "PROCESS_ERROR",
      `Delegation ${delegation.id} finished but its outcome could not be recorded.`,
      { retryable: false, cause: error },
    ));
  }

  private persist(delegation: Delegation) {
    this.options.goals.putDelegation(delegation.goalId, delegation);
  }

  private refreshQueuePositions() {
    const queued = this.scheduler.list("queued");
    const present = new Set(queued.map((delegation) => delegation.id));
    for (const id of this.lastQueuePositions.keys()) if (!present.has(id)) this.lastQueuePositions.delete(id);
    for (const delegation of queued) {
      const position = this.scheduler.queuePosition(delegation.id);
      if (position === null || this.lastQueuePositions.get(delegation.id) === position) continue;
      this.lastQueuePositions.set(delegation.id, position);
      this.emit({ kind: "queued", delegation, queuePosition: position });
    }
  }

  private scheduleWake() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const now = this.now();
    const wakeAt = this.scheduler.list()
      .filter((delegation) => delegation.state === "queued" || delegation.state === "active")
      .flatMap((delegation) => delegation.state === "queued"
        ? [delegation.availableAt, delegation.deadlineAt]
        : [delegation.deadlineAt])
      .filter((value) => value > now)
      .sort((left, right) => left - right)[0];
    if (wakeAt === undefined) return;
    // A timer callback has no caller either, and `pump` persists as it drains
    // deadlines, so the same teardown race would throw straight to the process.
    this.timer = setTimeout(() => {
      try {
        this.pump();
      } catch (error) {
        this.diagnostic("Delegation deadline pump failed.", error);
      }
    }, Math.max(1, Math.min(wakeAt - now, 2_147_483_647)));
    this.timer.unref?.();
  }

  private emit(event: GoalDelegationEvent) {
    try {
      this.onEvent(event);
    } catch (error) {
      this.diagnostic(`Delegation event callback failed for ${event.delegation.id}.`, error);
    }
  }

  private restoreKnownSessions() {
    for (const record of this.options.goals.listRecords()) {
      for (const turn of record.turns) {
        if (turn.nativeSessionId) this.knownSessions.set(sessionKey(turn.goalId, turn.agentId), turn.nativeSessionId);
      }
    }
  }
}

function sessionKey(goalId: string, agentId: string) {
  return `${goalId}\0${agentId}`;
}

function boundedError(value: string) {
  return value.slice(0, 16_384) || "Delegation failed without an error message.";
}
