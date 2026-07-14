import { HeadlessError } from "../runtime/headless-error";
import { LoopPolicySchema, type LoopRecord } from "../contracts/loop";
import { LoopStore } from "../runtime/loop-store";
import { redactAndTruncate } from "../runtime/redaction";

type TargetStatus = { state: string; terminal: boolean; succeeded: boolean };
export type LoopServiceOptions = {
  store: LoopStore;
  startGoal: (target: Extract<LoopRecord["policy"]["target"], { kind: "goal" }>, principal: string, workId: string) => { id: string };
  goalStatus: (id: string) => TargetStatus;
  startWorkflow: (definition: Record<string, unknown>, principal: string, workId: string) => { id: string };
  workflowStatus: (id: string) => TargetStatus;
  cancelGoal: (id: string, principal: string) => unknown;
  cancelWorkflow: (id: string) => unknown;
  track?: (task: Promise<void>) => void;
};

export class LoopService {
  readonly store;
  private active = new Map<string, Promise<void>>();
  private disposed = false;
  constructor(private readonly options: LoopServiceOptions) { this.store = options.store; }

  start(raw: unknown, principal: string) {
    const policy = LoopPolicySchema.parse(raw);
    if (policy.deadline <= Date.now()) throw new HeadlessError("INVALID_REQUEST", "Loop deadline must be in the future.");
    const loop = this.store.create(policy, principal);
    this.launch(loop.id);
    return loop;
  }
  recover() { this.disposed = false; for (const loop of this.store.list()) if (["queued", "running", "backoff"].includes(loop.state)) this.launch(loop.id); }
  dispose() { this.disposed = true; }
  pause(id: string, principal: string) { return this.mutateOwned(id, principal, (loop) => { if (!["succeeded", "failed", "cancelled", "budget_exhausted", "deadline_exceeded"].includes(loop.state)) loop.state = "paused"; }); }
  resume(id: string, principal: string) { const loop = this.mutateOwned(id, principal, (item) => { if (item.state !== "paused") throw new HeadlessError("INVALID_REQUEST", "Only a paused loop can resume."); item.state = "queued"; }); this.launch(id); return loop; }
  cancel(id: string, principal: string) {
    return this.mutateOwned(id, principal, (loop) => {
      loop.state = "cancelled"; loop.nextRunAt = null;
      const current = loop.iterations.at(-1);
      if (current?.state === "running" && current.workId) current.workKind === "goal" ? this.options.cancelGoal(current.workId, principal) : this.options.cancelWorkflow(current.workId);
    });
  }

  private launch(id: string) {
    if (this.active.has(id)) return;
    const task = this.run(id).catch((error) => {
      this.store.update(id, (loop) => { loop.state = "failed"; const iteration = loop.iterations.at(-1); if (iteration && !iteration.completedAt) { iteration.state = "failed"; iteration.error = redactAndTruncate(error instanceof Error ? error.message : String(error), 4_096).text; iteration.completedAt = Date.now(); } });
    }).finally(() => this.active.delete(id));
    this.active.set(id, task); this.options.track?.(task);
  }

  private async run(id: string) {
    while (true) {
      if (this.disposed) return;
      let loop = this.require(id);
      if (["paused", "succeeded", "failed", "cancelled", "budget_exhausted", "deadline_exceeded"].includes(loop.state)) return;
      const now = Math.max(Date.now(), loop.lastObservedAt);
      if (now >= loop.policy.deadline) { this.store.update(id, (item) => { item.state = "deadline_exceeded"; item.lastObservedAt = now; }); return; }
      const current = loop.iterations.at(-1);
      if (current && (current.state === "admitted" || current.state === "running")) {
        if (!current.workId) await this.admitWork(loop, current.number);
        loop = this.require(id);
        const running = loop.iterations.at(-1)!;
        const status = running.workKind === "goal" ? this.options.goalStatus(running.workId!) : this.options.workflowStatus(running.workId!);
        if (!status.terminal) { await Bun.sleep(250); continue; }
        this.store.update(id, (item) => {
          const iteration = item.iterations.at(-1)!; iteration.state = status.succeeded ? "succeeded" : normalizeFailure(status.state); iteration.completedAt = Date.now();
          item.lastObservedAt = Math.max(Date.now(), item.lastObservedAt);
          if (status.succeeded) item.state = "succeeded";
          else if (item.policy.terminalFailures.includes(iteration.state as never)) item.state = "failed";
          else { item.state = "backoff"; item.nextRunAt = item.lastObservedAt + backoff(item.policy.backoff, iteration.number); }
        });
        continue;
      }
      if (loop.state === "backoff" && loop.nextRunAt && now < loop.nextRunAt) { await Bun.sleep(Math.min(1_000, loop.nextRunAt - now)); continue; }
      if (loop.iterations.length >= loop.policy.maxIterations) { this.store.update(id, (item) => { item.state = "failed"; }); return; }
      if (loop.usedRequests + loop.policy.perIteration.maxRequests > loop.policy.aggregate.maxRequests || loop.usedCostUsd + loop.policy.perIteration.maxCostUsd > loop.policy.aggregate.maxCostUsd) {
        this.store.update(id, (item) => { item.state = "budget_exhausted"; }); return;
      }
      const number = loop.iterations.length + 1;
      this.store.update(id, (item) => {
        item.state = "running"; item.nextRunAt = null; item.lastObservedAt = now;
        item.usedRequests += item.policy.perIteration.maxRequests; item.usedCostUsd += item.policy.perIteration.maxCostUsd;
        item.iterations.push({ id: `${item.id}-iteration-${number}`, number, state: "admitted", workKind: item.policy.target.kind, workId: null, admittedAt: now, completedAt: null, reservedCostUsd: item.policy.perIteration.maxCostUsd, requests: item.policy.perIteration.maxRequests, error: null });
      });
      await this.admitWork(this.require(id), number);
    }
  }

  private async admitWork(loop: LoopRecord, number: number) {
    const iteration = loop.iterations.find((item) => item.number === number);
    if (!iteration || iteration.workId) return;
    const workId = `${loop.id}-iteration-${number}-${loop.policy.target.kind}`;
    const work = loop.policy.target.kind === "goal"
      ? this.options.startGoal(loop.policy.target, loop.principal, workId)
      : this.options.startWorkflow(loop.policy.target.definition, loop.principal, workId);
    this.store.update(loop.id, (item) => { const admitted = item.iterations.find((candidate) => candidate.number === number)!; if (admitted.workId === null) { admitted.workId = work.id; admitted.state = "running"; } });
  }
  private require(id: string) { const loop = this.store.get(id); if (!loop) throw new HeadlessError("INVALID_REQUEST", `Unknown loop: ${id}`); return loop; }
  private mutateOwned(id: string, principal: string, fn: (loop: LoopRecord) => void) { const loop = this.require(id); if (loop.principal !== principal) throw new HeadlessError("POLICY_DENIED", "Loop belongs to another principal."); return this.store.update(id, fn); }
}

function normalizeFailure(state: string): "failed" | "blocked" | "cancelled" | "timed_out" { return state === "blocked" || state === "cancelled" || state === "timed_out" ? state : "failed"; }
function backoff(policy: LoopRecord["policy"]["backoff"], iteration: number) { return policy.kind === "fixed" ? policy.initialMs : Math.min(policy.maxMs, policy.initialMs * 2 ** Math.max(0, iteration - 1)); }
