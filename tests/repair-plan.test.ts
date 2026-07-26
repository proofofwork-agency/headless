import { describe, expect, test } from "bun:test";
import {
  MAX_REPAIR_EXCERPT_BYTES,
  REPAIR_VERIFY_STEP_ID,
  compileRepairGraph,
  failureSignature,
  hasStagnated,
  summarizeGateFailure,
} from "../src/runtime/repair-plan";
import type { GateCheckResult, ReleaseGateReport } from "../src/runtime/release-gate";
import { RepairEvidenceSchema } from "../src/contracts/loop";

function checkResult(name: string, overrides: Partial<GateCheckResult> = {}): GateCheckResult {
  return {
    name,
    command: "bun",
    args: ["run", name],
    ok: false,
    exitCode: 1,
    signal: null,
    durationMs: 10,
    output: `${name} failed`,
    timedOut: false,
    cancelled: false,
    truncated: false,
    containment: { enforced: true, mechanism: "darwin-seatbelt-read" },
    ...overrides,
  };
}

function report(checks: GateCheckResult[]): ReleaseGateReport {
  return {
    ok: checks.every((check) => check.ok),
    startedAt: 1_000,
    completedAt: 2_000,
    checks,
    timeoutMs: 120_000,
  };
}

describe("failure signature", () => {
  test("is stable across runs of the same defect", () => {
    const first = report([checkResult("check", { output: "src/a.ts(12,3): error TS2322: Type mismatch\nran in 431ms" })]);
    const second = report([checkResult("check", { output: "src/a.ts(12,3): error TS2322: Type mismatch\nran in 1902ms" })]);
    expect(failureSignature(first)).toBe(failureSignature(second));
  });

  test("changes when the underlying failure changes", () => {
    const before = report([checkResult("check", { output: "error TS2322: Type mismatch" })]);
    const after = report([checkResult("check", { output: "error TS2551: Property does not exist" })]);
    expect(failureSignature(before)).not.toBe(failureSignature(after));
  });

  test("distinguishes which check failed", () => {
    const one = report([checkResult("check", { output: "same text" })]);
    const other = report([checkResult("build", { output: "same text" })]);
    expect(failureSignature(one)).not.toBe(failureSignature(other));
  });

  test("collapses volatile paths, durations, and large numbers", () => {
    const first = report([checkResult("check", { output: "/Users/one/repo/src/a.ts: failed after 120ms at 0xdeadbeef (pid 48122)" })]);
    const second = report([checkResult("check", { output: "/home/two/checkout/src/a.ts: failed after 9s at 0xfeedface (pid 91733)" })]);
    expect(failureSignature(first)).toBe(failureSignature(second));
  });

  test("is a distinct constant for a green gate", () => {
    const green = report([checkResult("check", { ok: true, exitCode: 0 })]);
    expect(failureSignature(green)).toMatch(/^[a-f0-9]{64}$/);
    expect(failureSignature(green)).not.toBe(failureSignature(report([checkResult("check")])));
  });
});

describe("repair graph compilation", () => {
  test("resolves without steps when the gate is already green", () => {
    const graph = compileRepairGraph(report([checkResult("check", { ok: true, exitCode: 0 })]));
    expect(graph.resolved).toBe(true);
    expect(graph.steps).toEqual([]);
  });

  test("fans out one repair node per failing check and joins on a single verify node", () => {
    const graph = compileRepairGraph(report([
      checkResult("check", { output: "type error" }),
      checkResult("build", { output: "bundler error" }),
    ]));
    expect(graph.resolved).toBe(false);
    const repairs = graph.steps.filter((step) => step.id !== REPAIR_VERIFY_STEP_ID);
    expect(repairs).toHaveLength(2);
    // Independent failures must be able to run concurrently.
    expect(repairs.every((step) => step.dependsOn.length === 0)).toBe(true);
    const verify = graph.steps.find((step) => step.id === REPAIR_VERIFY_STEP_ID)!;
    expect(verify.kind).toBe("test");
    // Optional, not required: a dead repair must not block the verifier.
    expect(verify.dependsOn).toEqual([]);
    expect(verify.optionalDependsOn).toEqual(repairs.map((step) => step.id));
  });

  test("never marks a repair as a required dependency of verification", () => {
    const graph = compileRepairGraph(report([
      checkResult("check", { output: "a" }),
      checkResult("build", { output: "b" }),
      checkResult("test", { output: "c" }),
    ]));
    for (const step of graph.steps) expect(step.dependsOn).toEqual([]);
  });

  test("produces an acyclic graph with unique ids even for colliding check names", () => {
    const graph = compileRepairGraph(report([
      checkResult("check:docs", { output: "a" }),
      checkResult("check-docs", { output: "b" }),
    ]));
    const ids = graph.steps.map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const step of graph.steps) {
      const edges = [...step.dependsOn, ...step.optionalDependsOn];
      expect(edges).not.toContain(step.id);
      for (const dependency of edges) expect(ids).toContain(dependency);
      // A dependency may never be both required and optional.
      expect(step.dependsOn.filter((id) => step.optionalDependsOn.includes(id))).toEqual([]);
    }
  });

  test("respects the node budget and tells the agent what was dropped", () => {
    const failures = ["check", "build", "test", "pack"].map((name) => checkResult(name, { output: `${name} broke` }));
    const graph = compileRepairGraph(report(failures), [], { maxRepairNodes: 2 });
    const repairs = graph.steps.filter((step) => step.id !== REPAIR_VERIFY_STEP_ID);
    expect(repairs).toHaveLength(2);
    expect(repairs[0]!.prompt).toContain("2 additional check(s) also failed");
  });

  test("carries the banned-construct constraints into every repair prompt", () => {
    const graph = compileRepairGraph(report([checkResult("check")]));
    const repair = graph.steps.find((step) => step.id !== REPAIR_VERIFY_STEP_ID)!;
    expect(repair.prompt).toContain("MANDATORY CONSTRAINTS");
    // Assembled rather than literal: this test file is scanned by the same lint.
    for (const token of [`as ${"any"}`, `@ts${"-"}ignore`, `Math.${"random"}(`, `TO${"DO"}`]) {
      expect(repair.prompt).toContain(token);
    }
    expect(repair.prompt).toContain("Do not weaken, skip, or delete a test");
  });

  test("tells the next iteration when the previous fix changed nothing", () => {
    const failing = report([checkResult("check", { output: "error TS2322: Type mismatch" })]);
    const prior = summarizeGateFailure(failing, ["repair-check-1"]);
    const graph = compileRepairGraph(failing, [prior]);
    const repair = graph.steps.find((step) => step.id !== REPAIR_VERIFY_STEP_ID)!;
    expect(repair.prompt).toContain("did NOT change");
    expect(repair.prompt).toContain("repair-check-1");
  });

  test("tells the next iteration when the failure moved", () => {
    const first = summarizeGateFailure(report([checkResult("check", { output: "error TS2322" })]), []);
    const second = report([checkResult("check", { output: "error TS2551" })]);
    const repair = compileRepairGraph(second, [first]).steps.find((step) => step.id !== REPAIR_VERIFY_STEP_ID)!;
    expect(repair.prompt).toContain("signature changed");
  });
});

describe("gate failure evidence", () => {
  test("bounds the excerpt it carries forward", () => {
    const huge = "x".repeat(MAX_REPAIR_EXCERPT_BYTES * 3);
    const evidence = summarizeGateFailure(report([checkResult("check", { output: huge })]));
    expect(evidence.failedChecks[0]!.excerpt.length).toBeLessThanOrEqual(MAX_REPAIR_EXCERPT_BYTES);
  });

  /**
   * The real invariant: evidence is persisted inside the durable loop record,
   * so anything the planner emits has to survive its own schema. Truncation
   * that overshoots the cap would only surface as a write failure mid-loop.
   */
  test("always produces evidence that satisfies its durable schema", () => {
    const oversized = summarizeGateFailure(
      report([
        checkResult("check", { output: "y".repeat(MAX_REPAIR_EXCERPT_BYTES * 4) }),
        checkResult("build", { output: "z".repeat(MAX_REPAIR_EXCERPT_BYTES * 4) }),
      ]),
      Array.from({ length: 64 }, (_, index) => `note-${index}-${"w".repeat(4_096)}`),
    );
    expect(() => RepairEvidenceSchema.parse(oversized)).not.toThrow();
    expect(oversized.attempted.length).toBeLessThanOrEqual(32);
  });

  test("records a useful excerpt when a check fails silently", () => {
    const evidence = summarizeGateFailure(report([checkResult("check", { output: "   ", exitCode: 137 })]));
    expect(evidence.failedChecks[0]!.excerpt).toContain("failed without output");
    expect(evidence.failedChecks[0]!.exitCode).toBe(137);
  });

  test("only reports checks that actually failed", () => {
    const evidence = summarizeGateFailure(report([
      checkResult("check", { ok: true, exitCode: 0 }),
      checkResult("build", { output: "bundler error" }),
    ]));
    expect(evidence.failedChecks.map((check) => check.name)).toEqual(["build"]);
  });
});

describe("stagnation detection", () => {
  const evidence = (signature: string) => ({
    signature: signature.padEnd(64, "0"),
    failedChecks: [],
    attempted: [],
    observedAt: 1,
  });

  test("does not fire before the limit is reached", () => {
    expect(hasStagnated([evidence("a")], 2)).toBe(false);
  });

  test("fires once the signature repeats for the whole window", () => {
    expect(hasStagnated([evidence("a"), evidence("a")], 2)).toBe(true);
  });

  test("resets when the most recent iteration made progress", () => {
    expect(hasStagnated([evidence("a"), evidence("a"), evidence("b")], 2)).toBe(false);
  });

  test("only considers the most recent window, not the whole history", () => {
    expect(hasStagnated([evidence("a"), evidence("b"), evidence("c"), evidence("c")], 2)).toBe(true);
  });
});
