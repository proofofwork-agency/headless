import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopService } from "../src/daemon/loop-service";
import { LoopStore } from "../src/runtime/loop-store";
import { ensureProjectStateDirectories, getProjectStatePaths } from "../src/runtime/project-state";
import { REPAIR_VERIFY_STEP_ID, type RepairStep } from "../src/runtime/repair-plan";
import type { GateCheckResult, ReleaseGateReport } from "../src/runtime/release-gate";
import { schedulingWindow } from "./support/timing";

const roots: string[] = [];
const runtimeRoots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
  while (runtimeRoots.length) rmSync(runtimeRoots.pop()!, { recursive: true, force: true });
});

/**
 * These exercise the loop's decision-making against a scripted gate. The gate
 * is the oracle, so the interesting cases are all about what the loop concludes
 * from it — never about what a workflow claimed.
 */
describe("gate-driven repair loop", () => {
  test("succeeds without spending an agent turn when the gate is already green", async () => {
    const harness = createHarness([green()]);
    const loop = harness.service.start(repairPolicy(), "operator");
    await harness.settle(loop.id, "succeeded");

    const completed = harness.service.store.get(loop.id)!;
    expect(completed.iterations).toHaveLength(1);
    expect(completed.iterations[0]?.state).toBe("succeeded");
    expect(harness.startedWorkflows).toEqual([]);
    expect(harness.gateCalls).toBe(1);
  });

  test("compiles a repair graph, runs it, and settles on the re-run gate", async () => {
    // fail -> (repair graph) -> green
    const harness = createHarness([red("check", "error TS2322"), green()]);
    const loop = harness.service.start(repairPolicy(), "operator");
    await harness.settle(loop.id, "succeeded");

    expect(harness.startedWorkflows).toHaveLength(1);
    const steps = harness.startedWorkflows[0]!;
    expect(steps.map((step) => step.id)).toEqual(["repair-check-1", REPAIR_VERIFY_STEP_ID]);
    // Verification never re-runs the gate itself; the loop does that.
    expect(harness.gateCalls).toBe(2);
    expect(harness.service.store.get(loop.id)!.iterations[0]?.state).toBe("succeeded");
  });

  /**
   * The whole point of the oracle. A repair graph that reports success while
   * the project is still broken must not settle the loop.
   */
  test("does not trust a succeeded repair graph when the gate is still red", async () => {
    const harness = createHarness([
      red("check", "error TS2322"),
      red("check", "error TS2551"),
      green(),
    ]);
    const loop = harness.service.start(repairPolicy(), "operator");
    await harness.settle(loop.id, "succeeded");

    const completed = harness.service.store.get(loop.id)!;
    expect(completed.iterations).toHaveLength(2);
    expect(completed.iterations[0]?.state).toBe("failed");
    expect(completed.iterations[1]?.state).toBe("succeeded");
  });

  test("carries the previous failure into the next iteration's prompts", async () => {
    const harness = createHarness([
      red("check", "error TS2322"),
      red("check", "error TS2551"),
      green(),
    ]);
    const loop = harness.service.start(repairPolicy(), "operator");
    await harness.settle(loop.id, "succeeded");

    expect(harness.startedWorkflows).toHaveLength(2);
    const second = harness.startedWorkflows[1]!.find((step) => step.id !== REPAIR_VERIFY_STEP_ID)!;
    expect(second.prompt).toContain("PRIOR REPAIR ITERATIONS");
    expect(second.prompt).toContain("signature changed");

    const evidence = harness.service.store.get(loop.id)!.iterations[0]?.evidence;
    expect(evidence?.failedChecks[0]?.name).toBe("check");
    expect(evidence?.failedChecks[0]?.excerpt).toContain("TS2322");
  });

  /**
   * Stagnation guard: an identical failure means the previous repair did
   * nothing, and the remaining budget would only reproduce it.
   */
  test("stops as no_progress instead of burning the remaining budget", async () => {
    const harness = createHarness(Array.from({ length: 8 }, () => red("check", "error TS2322")));
    const loop = harness.service.start(repairPolicy({ stagnationLimit: 2, maxIterations: 6 }), "operator");
    await harness.settle(loop.id, "no_progress");

    const completed = harness.service.store.get(loop.id)!;
    expect(completed.state).toBe("no_progress");
    expect(completed.iterations.length).toBeLessThan(6);
    expect(completed.iterations.at(-1)?.error).toContain("no progress");
    // It stopped early, so budget was left unspent.
    expect(completed.usedCostUsd).toBeLessThan(completed.policy.aggregate.maxCostUsd);
  });

  test("keeps iterating while the failure signature is still moving", async () => {
    const harness = createHarness([
      red("check", "error A"),
      red("check", "error B"),
      red("check", "error C"),
      green(),
    ]);
    const loop = harness.service.start(repairPolicy({ stagnationLimit: 2 }), "operator");
    await harness.settle(loop.id, "succeeded");
    expect(harness.service.store.get(loop.id)!.iterations).toHaveLength(3);
  });

  test("admits each iteration under a deterministic work id so restarts do not duplicate work", async () => {
    const harness = createHarness([red("check", "error A"), red("check", "error B"), green()]);
    const loop = harness.service.start(repairPolicy(), "operator");
    await harness.settle(loop.id, "succeeded");
    expect(harness.workIds).toEqual([
      `${loop.id}-iteration-1-repair`,
      `${loop.id}-iteration-2-repair`,
    ]);
  });

  /**
   * Write authority is the one setting where a wrong default is expensive:
   * it decides whether an agent's edits can reach the primary checkout.
   */
  test("keeps repairs in an isolated candidate unless the policy authorizes integration", async () => {
    for (const integrationPolicy of ["preserve", "request"] as const) {
      const harness = createHarness([red("check", "boom"), green()]);
      const loop = harness.service.start({ ...repairPolicy(), integrationPolicy }, "operator");
      await harness.settle(loop.id, "awaiting_integration");
      expect(harness.integrationPolicies).toEqual([integrationPolicy]);
    }
  });

  /**
   * Repairs land in a candidate; the loop's gate measures the primary. Without
   * integration authority the primary cannot move, so iterating again would
   * re-diagnose an unchanged project and blame the agent for it. Stopping with
   * an accurate reason beats spinning.
   */
  test("stops after one iteration instead of re-gating a checkout it cannot change", async () => {
    const harness = createHarness([red("check", "boom"), green()]);
    const loop = harness.service.start({ ...repairPolicy(), integrationPolicy: "preserve" }, "operator");
    await harness.settle(loop.id, "awaiting_integration");

    const completed = harness.service.store.get(loop.id)!;
    expect(completed.iterations).toHaveLength(1);
    // Only the opening observation. No pointless re-gate of an unchanged tree.
    expect(harness.gateCalls).toBe(1);
  });

  test("passes explicit authorization through and keeps converging on the gate", async () => {
    const harness = createHarness([red("check", "boom"), green()]);
    const loop = harness.service.start({ ...repairPolicy(), integrationPolicy: "authorized" }, "operator");
    await harness.settle(loop.id, "succeeded");
    expect(harness.integrationPolicies).toEqual(["authorized"]);
    expect(harness.gateCalls).toBe(2);
  });

  /**
   * Regression guard for a whole class of bug found only by running the loop
   * against real agents: the compiled graph is handed to the workflow engine as
   * a fresh definition, and every execution setting the loop was configured
   * with has to be threaded into it. Each one that was silently dropped cost a
   * full live run to diagnose — auth mode defaulted to broker and every repair
   * was rejected for lacking a model; approval policy defaulted to ask and
   * every candidate went terminal awaiting a merge nobody could grant in time.
   */
  test("hands the loop's full execution policy to the repair graph", async () => {
    const harness = createHarness([red("check", "boom"), green()]);
    const target = {
      ...repairPolicy().target,
      backend: "claude-code" as const,
      verifyBackend: "codex" as const,
      authMode: "native-login" as const,
      approvalPolicy: "auto" as const,
      model: "some-model",
    };
    const loop = harness.service.start({ ...repairPolicy(), target }, "operator");
    await harness.settle(loop.id, "succeeded");

    const observed = harness.targets[0]!;
    expect(observed.backend).toBe("claude-code");
    expect(observed.verifyBackend).toBe("codex");
    expect(observed.authMode).toBe("native-login");
    expect(observed.approvalPolicy).toBe("auto");
    expect(observed.model).toBe("some-model");
  });

  test("defaults verification to a different adapter than the repairs", () => {
    const target = repairPolicy().target;
    // Unset by default so the daemon can pick a contrasting adapter; a verifier
    // sharing the author's model tends to ratify the author's mistakes.
    expect(target.verifyBackend).toBeUndefined();
  });

  test("refuses a repair loop on a daemon that cannot run gates", async () => {
    const paths = fixture();
    const service = new LoopService({
      store: new LoopStore(paths),
      startGoal: (_target, _principal, workId) => ({ id: workId }),
      goalStatus: () => ({ state: "succeeded", terminal: true, succeeded: true }),
      startWorkflow: (_definition, _principal, workId) => ({ id: workId }),
      workflowStatus: () => ({ state: "succeeded", terminal: true, succeeded: true }),
      cancelGoal: () => undefined,
      cancelWorkflow: () => undefined,
    });
    const loop = service.start(repairPolicy(), "operator");
    await waitUntil(() => service.store.get(loop.id)?.state === "failed");
    expect(service.store.get(loop.id)!.iterations.at(-1)?.error).toContain("cannot run repair loops");
  });
});

function createHarness(reports: ReleaseGateReport[]) {
  const paths = fixture();
  const startedWorkflows: RepairStep[][] = [];
  const workIds: string[] = [];
  const integrationPolicies: string[] = [];
  const targets: Array<Record<string, unknown>> = [];
  let gateCalls = 0;

  const service = new LoopService({
    store: new LoopStore(paths),
    startGoal: (_target, _principal, workId) => ({ id: workId }),
    goalStatus: () => ({ state: "succeeded", terminal: true, succeeded: true }),
    startWorkflow: (_definition, _principal, workId) => ({ id: workId }),
    // The repair graph always reports success; only the gate decides.
    workflowStatus: () => ({ state: "succeeded", terminal: true, succeeded: true }),
    cancelGoal: () => undefined,
    cancelWorkflow: () => undefined,
    runGate: async () => {
      const next = reports[Math.min(gateCalls, reports.length - 1)]!;
      gateCalls += 1;
      return next;
    },
    startRepairWorkflow: (steps, target, _principal, workId, integrationPolicy) => {
      startedWorkflows.push(steps);
      targets.push(target as unknown as Record<string, unknown>);
      workIds.push(workId);
      integrationPolicies.push(integrationPolicy);
      return { id: workId };
    },
  });

  return {
    service,
    startedWorkflows,
    workIds,
    integrationPolicies,
    targets,
    get gateCalls() { return gateCalls; },
    async settle(loopId: string, state: string) {
      await waitUntil(() => service.store.get(loopId)?.state === state);
    },
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "headless-repair-loop-"));
  roots.push(root);
  const project = join(root, "project");
  mkdirSync(project);
  const runtime = join("/tmp", `hrl-${process.pid}-${roots.length}`);
  runtimeRoots.push(runtime);
  return ensureProjectStateDirectories(getProjectStatePaths(project, {
    env: { HEADLESS_STATE_HOME: join(root, "state"), HEADLESS_RUNTIME_HOME: runtime },
    platform: "linux",
  }));
}

/**
 * Defaults to "authorized" because most cases here exercise multi-iteration
 * convergence, which is only reachable when repairs may leave their candidate.
 * The product default is "preserve"; the write-authority tests set it back.
 */
function repairPolicy(overrides: { stagnationLimit?: number; maxIterations?: number } = {}) {
  return {
    target: {
      kind: "repair" as const,
      checks: ["check"],
      mode: "write" as const,
      maxRepairNodes: 8,
      stagnationLimit: overrides.stagnationLimit ?? 4,
      authMode: "broker" as const,
      approvalPolicy: "ask" as const,
      gateTimeoutMs: 60_000,
      stepTimeoutMs: 60_000,
    },
    maxIterations: overrides.maxIterations ?? 5,
    deadline: Date.now() + 120_000,
    perIteration: { maxCostUsd: 1, maxRequests: 1 },
    aggregate: { maxCostUsd: 20, maxRequests: 20 },
    backoff: { kind: "fixed" as const, initialMs: 0, maxMs: 0 },
    success: "target-succeeded" as const,
    terminalFailures: ["blocked" as const],
    approvalPolicy: "ask" as const,
    integrationPolicy: "authorized" as const,
  };
}

function green(): ReleaseGateReport {
  return { ok: true, startedAt: 1, completedAt: 2, checks: [gateCheck("check", { ok: true, exitCode: 0, output: "" })], timeoutMs: 60_000 };
}

function red(name: string, output: string): ReleaseGateReport {
  return { ok: false, startedAt: 1, completedAt: 2, checks: [gateCheck(name, { output })], timeoutMs: 60_000 };
}

function gateCheck(name: string, overrides: Partial<GateCheckResult>): GateCheckResult {
  return {
    name,
    command: "bun",
    args: ["run", name],
    ok: false,
    exitCode: 1,
    signal: null,
    durationMs: 5,
    output: "",
    timedOut: false,
    cancelled: false,
    truncated: false,
    containment: { enforced: true, mechanism: "test" },
    ...overrides,
  };
}

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + schedulingWindow(5_000);
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the loop to settle");
    await Bun.sleep(10);
  }
}
