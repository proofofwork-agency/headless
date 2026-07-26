import { HeadlessError } from "../runtime/headless-error";
import { LoopPolicySchema, type LoopRecord, type RepairEvidence, type RepairTarget } from "../contracts/loop";
import { LoopStore } from "../runtime/loop-store";
import { compileRepairGraph, hasStagnated, summarizeGateFailure, type RepairStep } from "../runtime/repair-plan";
import type { ReleaseGateReport } from "../runtime/release-gate";
import { redactAndTruncate } from "../runtime/redaction";

/** States a loop never leaves. Kept in one place so the run guard and the
 * pause guard cannot drift apart as new outcomes are added. */
const TERMINAL_LOOP_STATES = new Set<LoopRecord["state"]>([
  "succeeded", "failed", "cancelled", "budget_exhausted", "deadline_exceeded", "no_progress", "awaiting_integration",
]);

type TargetStatus = { state: string; terminal: boolean; succeeded: boolean };
export type LoopServiceOptions = {
  store: LoopStore;
  startGoal: (target: Extract<LoopRecord["policy"]["target"], { kind: "goal" }>, principal: string, workId: string) => { id: string };
  goalStatus: (id: string) => TargetStatus;
  startWorkflow: (definition: Record<string, unknown>, principal: string, workId: string) => { id: string };
  workflowStatus: (id: string) => TargetStatus;
  cancelGoal: (id: string, principal: string) => unknown;
  cancelWorkflow: (id: string) => unknown;
  /** Runs the named gate checks. This report is the repair loop's only oracle. */
  runGate?: (target: RepairTarget) => Promise<ReleaseGateReport>;
  /**
   * Admits a compiled repair graph through the durable workflow engine.
   * `integrationPolicy` comes from the loop policy and decides whether repairs
   * may leave their isolated candidate.
   */
  startRepairWorkflow?: (
    steps: RepairStep[],
    target: RepairTarget,
    principal: string,
    workId: string,
    integrationPolicy: LoopRecord["policy"]["integrationPolicy"],
  ) => { id: string };
  track?: (task: Promise<void>) => void;
};

export class LoopService {
  readonly store;
  private active = new Map<string, Promise<void>>();
  /**
   * The gate a repair iteration ended on is the same gate the next iteration
   * would open with, and nothing changes in between. Carrying it forward saves
   * a full redundant gate run per iteration — on a real project that is minutes.
   * Losing it to a restart is safe: the next iteration just re-gates.
   */
  private readonly carriedGateReport = new Map<string, ReleaseGateReport>();
  private disposed = false;
  constructor(private readonly options: LoopServiceOptions) { this.store = options.store; }

  start(raw: unknown, principal: string) {
    const policy = LoopPolicySchema.parse(raw);
    if (policy.deadline <= Date.now()) throw new HeadlessError("INVALID_REQUEST", "Loop deadline must be in the future.");
    const loop = this.store.create(policy, principal);
    this.launch(loop.id);
    return loop;
  }
  /** Loops parked in backoff stay resident here, so this also covers sleeping iterations. */
  get activeCount() { return this.active.size; }
  recover() { this.disposed = false; for (const loop of this.store.list()) if (["queued", "running", "backoff"].includes(loop.state)) this.launch(loop.id); }
  dispose() { this.disposed = true; this.carriedGateReport.clear(); }
  pause(id: string, principal: string) { return this.mutateOwned(id, principal, (loop) => { if (!TERMINAL_LOOP_STATES.has(loop.state)) loop.state = "paused"; }); }
  resume(id: string, principal: string) { const loop = this.mutateOwned(id, principal, (item) => { if (item.state !== "paused") throw new HeadlessError("INVALID_REQUEST", "Only a paused loop can resume."); item.state = "queued"; }); this.launch(id); return loop; }
  cancel(id: string, principal: string) {
    this.carriedGateReport.delete(id);
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
      if (TERMINAL_LOOP_STATES.has(loop.state)) { this.carriedGateReport.delete(id); return; }
      if (loop.state === "paused") return;
      const now = Math.max(Date.now(), loop.lastObservedAt);
      if (now >= loop.policy.deadline) { this.store.update(id, (item) => { item.state = "deadline_exceeded"; item.lastObservedAt = now; }); return; }
      const current = loop.iterations.at(-1);
      if (current && (current.state === "admitted" || current.state === "running")) {
        if (!current.workId) await this.admitWork(loop, current.number);
        loop = this.require(id);
        const running = loop.iterations.at(-1)!;
        // A repair iteration that resolved during admission has already settled.
        if (["succeeded", "failed", "blocked", "cancelled", "timed_out"].includes(running.state)) continue;
        const status = running.workKind === "goal" ? this.options.goalStatus(running.workId!) : this.options.workflowStatus(running.workId!);
        if (!status.terminal) { await Bun.sleep(250); continue; }
        if (running.workKind === "repair") { await this.settleRepairIteration(id, running.number); continue; }
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
        item.iterations.push({ id: `${item.id}-iteration-${number}`, number, state: "admitted", workKind: item.policy.target.kind, workId: null, admittedAt: now, completedAt: null, reservedCostUsd: item.policy.perIteration.maxCostUsd, requests: item.policy.perIteration.maxRequests, error: null, evidence: null });
      });
      await this.admitWork(this.require(id), number);
    }
  }

  private async admitWork(loop: LoopRecord, number: number) {
    const iteration = loop.iterations.find((item) => item.number === number);
    if (!iteration || iteration.workId) return;
    const workId = `${loop.id}-iteration-${number}-${loop.policy.target.kind}`;
    if (loop.policy.target.kind === "repair") return this.admitRepairWork(loop, loop.policy.target, number, workId);
    const work = loop.policy.target.kind === "goal"
      ? this.options.startGoal(loop.policy.target, loop.principal, workId)
      : this.options.startWorkflow(loop.policy.target.definition, loop.principal, workId);
    this.store.update(loop.id, (item) => { const admitted = item.iterations.find((candidate) => candidate.number === number)!; if (admitted.workId === null) { admitted.workId = work.id; admitted.state = "running"; } });
  }

  /**
   * Observe, then act. The gate runs first so the graph is compiled from the
   * project's actual failures rather than from a stale prompt, and a green gate
   * settles the loop without spending an agent turn at all.
   */
  private async admitRepairWork(loop: LoopRecord, target: RepairTarget, number: number, workId: string) {
    const runGate = this.options.runGate;
    const startRepairWorkflow = this.options.startRepairWorkflow;
    if (!runGate || !startRepairWorkflow) throw new HeadlessError("INVALID_REQUEST", "This daemon cannot run repair loops.");

    const carried = this.carriedGateReport.get(loop.id);
    this.carriedGateReport.delete(loop.id);
    const report = carried ?? await runGate(target);
    const prior = priorEvidence(loop);
    const graph = compileRepairGraph(report, prior, { maxRepairNodes: target.maxRepairNodes });

    if (graph.resolved) {
      this.store.update(loop.id, (item) => {
        const iteration = item.iterations.find((candidate) => candidate.number === number)!;
        iteration.state = "succeeded";
        iteration.completedAt = Date.now();
        item.state = "succeeded";
        item.lastObservedAt = Math.max(Date.now(), item.lastObservedAt);
      });
      return;
    }

    const evidence = summarizeGateFailure(report, graph.steps.map((step) => step.id));
    // Stagnation is checked before spending the iteration: an unchanged
    // signature means the previous repair did nothing, and the remaining
    // budget would only reproduce the same failure.
    if (hasStagnated([...prior, evidence], target.stagnationLimit)) {
      this.store.update(loop.id, (item) => {
        const iteration = item.iterations.find((candidate) => candidate.number === number)!;
        iteration.state = "failed";
        iteration.completedAt = Date.now();
        iteration.evidence = evidence;
        iteration.error = `Repair made no progress across ${target.stagnationLimit} iterations; failure signature ${evidence.signature.slice(0, 12)} is unchanged.`;
        item.state = "no_progress";
        item.lastObservedAt = Math.max(Date.now(), item.lastObservedAt);
      });
      return;
    }

    const work = startRepairWorkflow(graph.steps, target, loop.principal, workId, loop.policy.integrationPolicy);
    this.store.update(loop.id, (item) => {
      const admitted = item.iterations.find((candidate) => candidate.number === number)!;
      admitted.evidence = evidence;
      if (admitted.workId === null) { admitted.workId = work.id; admitted.state = "running"; }
    });
  }

  /**
   * The repair graph finishing is not success. Only the re-run gate decides, so
   * a workflow that "succeeded" while the project still fails goes to backoff
   * carrying its evidence into the next iteration.
   */
  private async settleRepairIteration(id: string, number: number) {
    const loop = this.require(id);
    const target = loop.policy.target;
    if (target.kind !== "repair" || !this.options.runGate) return;

    // Repairs run as write jobs, which land in an isolated candidate and are
    // gated there. The loop's own gate measures the primary checkout, so under
    // any policy short of "authorized" the repair can never move it. Iterating
    // would re-diagnose an unchanged project until the stagnation guard fired
    // and report it as agent failure, which would be untrue. Stop and say what
    // is actually blocking: a human has to integrate the candidate.
    if (loop.policy.integrationPolicy !== "authorized") {
      this.store.update(id, (item) => {
        const iteration = item.iterations.find((candidate) => candidate.number === number)!;
        iteration.state = "succeeded";
        iteration.completedAt = Date.now();
        item.state = "awaiting_integration";
        item.nextRunAt = null;
        item.lastObservedAt = Math.max(Date.now(), item.lastObservedAt);
      });
      return;
    }

    const report = await this.options.runGate(target);
    const green = report.ok;
    // Hand this observation to the next iteration instead of re-gating an
    // unchanged project.
    //
    // It is deliberately NOT written onto this iteration. An iteration's
    // evidence is what it *started from*; overwriting it with the post-repair
    // observation would make the next iteration compare a signature against
    // itself, so every attempt would read as "changed nothing" and stagnation
    // would fire immediately.
    if (!green) this.carriedGateReport.set(id, report);
    this.store.update(id, (item) => {
      const iteration = item.iterations.find((candidate) => candidate.number === number)!;
      iteration.state = green ? "succeeded" : "failed";
      iteration.completedAt = Date.now();
      item.lastObservedAt = Math.max(Date.now(), item.lastObservedAt);
      if (green) { item.state = "succeeded"; return; }
      iteration.error = `Gate still failing after the repair graph completed: ${report.checks.filter((check) => !check.ok).map((check) => check.name).join(", ")}.`;
      item.state = "backoff";
      item.nextRunAt = item.lastObservedAt + backoff(item.policy.backoff, number);
    });
  }
  private require(id: string) { const loop = this.store.get(id); if (!loop) throw new HeadlessError("INVALID_REQUEST", `Unknown loop: ${id}`); return loop; }
  private mutateOwned(id: string, principal: string, fn: (loop: LoopRecord) => void) { const loop = this.require(id); if (loop.principal !== principal) throw new HeadlessError("POLICY_DENIED", "Loop belongs to another principal."); return this.store.update(id, fn); }
}

/** Every iteration's observation, oldest first — the loop's memory. */
function priorEvidence(loop: LoopRecord): RepairEvidence[] {
  return loop.iterations.flatMap((iteration) => iteration.evidence ? [iteration.evidence] : []);
}

function normalizeFailure(state: string): "failed" | "blocked" | "cancelled" | "timed_out" { return state === "blocked" || state === "cancelled" || state === "timed_out" ? state : "failed"; }
function backoff(policy: LoopRecord["policy"]["backoff"], iteration: number) { return policy.kind === "fixed" ? policy.initialMs : Math.min(policy.maxMs, policy.initialMs * 2 ** Math.max(0, iteration - 1)); }
