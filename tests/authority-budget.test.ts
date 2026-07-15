import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetSchema, GrantSchema, type Budget, type Grant } from "../src/contracts/durable";
import { AuthorityStore } from "../src/runtime/authority-store";
import { BudgetStore } from "../src/runtime/budget-store";
import { FinalityStore } from "../src/runtime/finality-store";
import { ensureProjectStateDirectories, getProjectStatePaths, type ProjectStatePaths } from "../src/runtime/project-state";

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("persistent authority", () => {
  test("binds coordinator authority to one project and persists scoped grants", () => {
    const paths = fixturePaths();
    let now = 1_000;
    const store = new AuthorityStore(paths, { coordinator: "coordinator", now: () => now });

    expect(store.authorize(request(paths, "coordinator", { merge: true })).allowed).toBe(true);
    expect(store.authorize(request(paths, "worker")).allowed).toBe(false);
    expect(store.authorize({
      ...request(paths, "coordinator"),
      projectId: "b".repeat(64),
    }).allowed).toBe(false);
    expect(() => store.addGrant("worker", grant(paths))).toThrow("Only the root principal");

    const added = store.addGrant("coordinator", grant(paths));
    expect(added.id).toBe("grant-write");
    const allowed = store.authorize(request(paths, "worker", { estimatedCostUsd: 2, merge: true }));
    expect(allowed.allowed).toBe(true);
    expect(allowed.grantId).toBe("grant-write");
    expect(allowed.mergeAllowed).toBe(true);
    expect(allowed.maxCostUsd).toBe(3);
    expect(store.authorize(request(paths, "coordinator")).maxCostUsd).toBeNull();
    expect(store.authorize(request(paths, "worker", { backend: "codex", estimatedCostUsd: 2 })).allowed).toBe(false);
    expect(store.authorize(request(paths, "worker", { estimatedCostUsd: 4 })).allowed).toBe(false);
    expect(store.authorize(request(paths, "worker", { estimatedCostUsd: null })).allowed).toBe(false);

    store.addGrant("coordinator", grant(paths, {
      id: "grant-unknown-cost",
      principal: "worker-unbounded",
      operations: ["run"],
      maxCostUsd: null,
    }));
    expect(store.authorize(request(paths, "worker-unbounded", {
      operation: "run",
      estimatedCostUsd: null,
    })).allowed).toBe(true);

    expect(mode(paths.policyPath)).toBe(0o600);
    const reopened = new AuthorityStore(paths, { coordinator: "coordinator", now: () => now });
    expect(reopened.authorize(request(paths, "worker", { estimatedCostUsd: 2, merge: true })).allowed).toBe(true);
    expect(() => new AuthorityStore(paths, { coordinator: "replacement" })).toThrow("does not match persisted root");

    now = 1_500;
    reopened.revokeGrant("coordinator", "grant-write");
    expect(reopened.authorize(request(paths, "worker", { estimatedCostUsd: 2, merge: true })).allowed).toBe(false);
  });

  test("requires merge scope and ignores expired or cross-project grants", () => {
    const paths = fixturePaths();
    const store = new AuthorityStore(paths, { coordinator: "coordinator", now: () => 5_000 });
    store.addGrant("coordinator", grant(paths, {
      id: "write-only",
      operations: ["write"],
      expiresAt: 6_000,
    }));

    expect(store.authorize(request(paths, "worker", { estimatedCostUsd: 1 })).allowed).toBe(true);
    expect(store.authorize(request(paths, "worker", { estimatedCostUsd: 1, merge: true })).allowed).toBe(false);
    expect(store.authorize(request(paths, "worker", { estimatedCostUsd: 1, at: 6_000 })).allowed).toBe(false);
    expect(() => store.addGrant("coordinator", grant(paths, {
      id: "wrong-project",
      projectId: "c".repeat(64),
    }))).toThrow("Grant project mismatch");
  });
});

describe("persistent budgets", () => {
  test("reserves and reconciles every bounded resource without oversubscription", () => {
    const paths = fixturePaths();
    const store = new BudgetStore(paths, { now: () => 1_000 });
    store.upsertBudget(budget(paths, {
      maxRequests: 2,
      maxInputTokens: 100,
      maxOutputTokens: 50,
      maxCostUsd: 2,
      maxArtifactBytes: 1_000,
      maxConcurrency: 1,
      maxRetries: 1,
    }));

    const first = store.reserve(reservation(paths, {
      id: "reservation-one",
      inputTokens: 40,
      outputTokens: 20,
      costUsd: 0.5,
      artifactBytes: 100,
      retries: 1,
    }));
    expect(first.allowed).toBe(true);
    expect(store.activate("reservation-one").allowed).toBe(true);

    const concurrent = store.reserve(reservation(paths, {
      id: "reservation-concurrent",
      inputTokens: 50,
      outputTokens: 25,
      costUsd: 1.25,
      artifactBytes: 880,
      retries: 1,
    }));
    expect(concurrent.allowed).toBe(true);
    expect(concurrent.reservation?.active).toBe(false);
    const queued = store.activate("reservation-concurrent");
    expect(queued.allowed).toBe(false);
    expect(queued.reasons.join(" ")).toContain("concurrency limit");

    const reopenedWhileReserved = new BudgetStore(paths);
    expect(reopenedWhileReserved.getReservation("reservation-one")?.active).toBe(true);
    expect(reopenedWhileReserved.getReservation("reservation-concurrent")?.active).toBe(false);
    expect(reopenedWhileReserved.activate("reservation-concurrent").allowed).toBe(false);

    const committed = reopenedWhileReserved.commit("reservation-one", {
      inputTokens: 50,
      outputTokens: 25,
      costUsd: 0.75,
      costSource: "broker",
      observedRequests: 1,
      artifactBytes: 120,
    });
    expect(committed.passed).toBe(true);

    expect(reopenedWhileReserved.activate("reservation-concurrent").allowed).toBe(true);
    expect(reopenedWhileReserved.commit("reservation-concurrent", {
      inputTokens: 50,
      outputTokens: 25,
      costUsd: 1.25,
      costSource: "broker",
      observedRequests: 1,
      artifactBytes: 880,
    }).passed).toBe(true);

    const state = reopenedWhileReserved.getState();
    expect(state.budgets[0].usedRequests).toBe(2);
    expect(state.budgets[0].usedUsage.input).toBe(100);
    expect(state.budgets[0].usedUsage.output).toBe(50);
    expect(state.budgets[0].usedCost.amountUsd).toBe(2);
    expect(state.budgets[0].usedArtifactBytes).toBe(1_000);
    expect(reopenedWhileReserved.evaluate(scope(paths)).passed).toBe(true);

    const exhausted = reopenedWhileReserved.reserve(reservation(paths, {
      id: "reservation-three",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    }));
    expect(exhausted.allowed).toBe(false);
    expect(exhausted.reasons.join(" ")).toContain("request limit");
    expect(mode(paths.budgetsPath)).toBe(0o600);
  });

  test("fails closed for unknown capped usage while preserving cost null", () => {
    const paths = fixturePaths();
    const store = new BudgetStore(paths);
    store.upsertBudget(budget(paths, {
      maxCostUsd: 10,
      maxInputTokens: 100,
    }));

    const unknown = store.reserve(reservation(paths, {
      id: "unknown-capped",
      inputTokens: null,
      costUsd: null,
    }));
    expect(unknown.allowed).toBe(false);
    expect(unknown.reasons.join(" ")).toContain("input token usage is unknown");
    expect(unknown.reasons.join(" ")).toContain("cost usage is unknown");

    store.upsertBudget(budget(paths, { maxCostUsd: null, maxInputTokens: null }));
    const unpriced = store.reserve(reservation(paths, {
      id: "unknown-unbounded",
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    }));
    expect(unpriced.allowed).toBe(true);
    expect(store.commit("unknown-unbounded", { costUsd: null }).passed).toBe(true);
    expect(store.getState().budgets[0].usedCost.amountUsd).toBeNull();

    const prior = store.getState().budgets[0];
    store.upsertBudget(BudgetSchema.parse({ ...prior, maxCostUsd: 10 }));
    const status = store.evaluate(scope(paths));
    expect(status.passed).toBe(false);
    expect(status.reasons.join(" ")).toContain("cost usage is unknown");
  });

  test("enforces output, artifact, retry, and scoped budgets", () => {
    const paths = fixturePaths();
    const store = new BudgetStore(paths);
    store.upsertBudget(budget(paths, {
      maxOutputTokens: 10,
      maxArtifactBytes: 100,
      maxRetries: 2,
    }));
    store.upsertBudget(budget(paths, {
      id: "other-principal",
      principal: "someone-else",
      maxRequests: 1,
      usedRequests: 1,
    }));

    const result = store.reserve(reservation(paths, {
      id: "too-large",
      outputTokens: 11,
      artifactBytes: 101,
      retries: 3,
    }));
    expect(result.allowed).toBe(false);
    expect(result.budgetIds).toEqual(["budget-main"]);
    expect(result.reasons.join(" ")).toContain("output token limit");
    expect(result.reasons.join(" ")).toContain("artifact byte limit");
    expect(result.reasons.join(" ")).toContain("retry limit");

    expect(store.reserve(reservation(paths, {
      id: "retry-after-crash",
      outputTokens: 0,
      artifactBytes: 0,
      retries: 0,
    })).allowed).toBe(true);
    const retry = store.activate("retry-after-crash", 3);
    expect(retry.allowed).toBe(false);
    expect(retry.reasons.join(" ")).toContain("retry limit exceeded");
  });

  test("bounds broker leases across concurrent reservations and debits observed provider calls", () => {
    const paths = fixturePaths();
    const store = new BudgetStore(paths);
    store.upsertBudget(budget(paths, {
      maxRequests: 6,
      maxCostUsd: 6,
      maxConcurrency: 2,
    }));
    expect(store.reserve(reservation(paths, { id: "broker-one", costUsd: 1 })).allowed).toBe(true);
    expect(store.reserve(reservation(paths, { id: "broker-two", costUsd: 1 })).allowed).toBe(true);

    const firstLimits = store.brokerLeaseLimits("broker-one");
    const secondLimits = store.brokerLeaseLimits("broker-two");
    expect(firstLimits).toMatchObject({ maxRequests: 6, maxCostUsd: 1 });
    expect(secondLimits).toMatchObject({ maxRequests: 6, maxCostUsd: 1 });
    expect(firstLimits.budgetQuotas).toEqual([{
      id: "budget-main",
      maxRequests: 6,
      usedRequests: 0,
      maxInputTokens: null,
      usedInputTokens: 0,
      maxOutputTokens: null,
      usedOutputTokens: 0,
    }]);
    expect(secondLimits.budgetQuotas).toEqual(firstLimits.budgetQuotas);
    expect(store.commit("broker-one", { costUsd: 2, observedRequests: 3 }).passed).toBe(true);
    expect(store.commit("broker-two", { costUsd: 2, observedRequests: 3 }).passed).toBe(true);
    expect(store.getState().budgets[0].usedRequests).toBe(6);
    expect(store.getState().budgets[0].usedCost.observedRequests).toBe(6);
    expect(store.reserve(reservation(paths, { id: "broker-exhausted", costUsd: 1 })).allowed).toBe(false);
  });

  test("activates concurrency independently for workflow-scoped budgets", () => {
    const paths = fixturePaths();
    const store = new BudgetStore(paths);
    store.upsertBudget(budget(paths, { maxConcurrency: 1 }));

    expect(store.reserve(reservation(paths, { id: "workflow-one-active" })).allowed).toBe(true);
    expect(store.activate("workflow-one-active").allowed).toBe(true);
    expect(store.reserve(reservation(paths, { id: "workflow-one-queued" })).allowed).toBe(true);
    expect(store.activate("workflow-one-queued").allowed).toBe(false);

    expect(store.reserve({
      ...reservation(paths, { id: "workflow-two-active" }),
      workflowId: "workflow-two",
    }).allowed).toBe(true);
    expect(store.activate("workflow-two-active").allowed).toBe(true);
    expect(store.commit("workflow-two-active").passed).toBe(true);

    expect(store.commit("workflow-one-active").passed).toBe(true);
    expect(store.activate("workflow-one-queued").allowed).toBe(true);
    expect(store.commit("workflow-one-queued").passed).toBe(true);
  });

  test("atomically carves one capped child slice and returns only proven unused allocation", () => {
    const paths = fixturePaths();
    const store = new BudgetStore(paths);
    expect(store.reserve(reservation(paths, {
      id: "parent",
      inputTokens: 1_000,
      outputTokens: 1_000,
      costUsd: 4,
      artifactBytes: 400,
      retries: 4,
    })).allowed).toBe(true);
    expect(store.activate("parent").allowed).toBe(true);
    const requestId = crypto.randomUUID();
    const child = store.subreserveDelegation({
      id: "child",
      parentReservationId: "parent",
      requestId,
      budgetFraction: 0.25,
      provider: "openai",
      inputTokens: 40_000,
      outputTokens: 8_000,
      costUsd: 1,
      artifactBytes: 100,
      retries: 1,
    });
    expect(child.allowed).toBe(true);
    expect(child.reservation?.envelope).toEqual({ requests: 2, inputTokens: 40_000, outputTokens: 8_000, costUsd: 1, artifactBytes: 100, retries: 1 });
    expect(store.subreserveDelegation({
      id: "replay",
      parentReservationId: "parent",
      requestId,
      provider: "openai",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
    })).toMatchObject({ allowed: true, existing: true, reservation: { id: "child" } });
    expect(store.subreserveDelegation({
      id: "second",
      parentReservationId: "parent",
      requestId: crypto.randomUUID(),
      provider: "openai",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
    })).toMatchObject({ allowed: false, existing: false });
    expect(store.activate("child").allowed).toBe(true);
    store.commit("child", { inputTokens: 10_000, outputTokens: 1_000, costUsd: 0.25, observedRequests: 1, artifactBytes: 25 });
    expect(store.getReservation("parent")?.envelope).toEqual({
      requests: 7,
      inputTokens: 190_000,
      outputTokens: 31_000,
      costUsd: 3.75,
      artifactBytes: 375,
      retries: 3,
    });
  });

  test("exhausts a delegated slice after crash without returning it to the parent", () => {
    const paths = fixturePaths();
    const store = new BudgetStore(paths);
    expect(store.reserve(reservation(paths, { id: "parent-crash", costUsd: 4 })).allowed).toBe(true);
    store.activate("parent-crash");
    const child = store.subreserveDelegation({
      id: "child-crash",
      parentReservationId: "parent-crash",
      requestId: crypto.randomUUID(),
      budgetFraction: 0.5,
      provider: "openai",
      inputTokens: 100_000,
      outputTokens: 16_000,
      costUsd: 2,
    });
    expect(child.allowed).toBe(true);
    const remaining = store.getReservation("parent-crash")?.envelope;
    store.failClosedAfterInterruption("child-crash");
    expect(store.getReservation("parent-crash")?.envelope).toEqual(remaining);
    expect(store.getReservation("child-crash")).toBeNull();
  });

  test("upgrades version-two reservations into transferable envelopes", () => {
    const paths = fixturePaths();
    ensureProjectStateDirectories(paths);
    writeFileSync(paths.budgetsPath, `${JSON.stringify({
      version: 2,
      projectId: paths.projectId,
      budgets: [],
      reservations: [{
        id: "legacy-parent",
        projectId: paths.projectId,
        principal: "worker",
        sessionId: null,
        workflowId: null,
        provider: null,
        inputTokens: 100,
        outputTokens: 200,
        costUsd: null,
        artifactBytes: 0,
        retries: 0,
        budgetIds: [],
        active: true,
        createdAt: 1,
      }],
      updatedAt: 1,
    })}\n`, { mode: 0o600 });
    const upgraded = new BudgetStore(paths).getState();
    expect(upgraded.version).toBe(3);
    expect(upgraded.reservations[0]).toMatchObject({
      id: "legacy-parent",
      parentReservationId: null,
      delegationRequestId: null,
      envelope: { requests: 8, inputTokens: 200_000, outputTokens: 32_000, costUsd: null },
    });
  });
});

describe("persistent finality", () => {
  test("blocks completion until every configured gate passes and persists decisions", () => {
    const paths = fixturePaths();
    const store = new FinalityStore(paths, { now: () => 2_000, id: () => "decision-one" });
    const blocked = store.evaluate({
      projectId: paths.projectId,
      jobId: "job-one",
      decidedBy: "daemon",
      gates: {
        policyPassed: true,
        testsPassed: true,
        reviewPassed: true,
        votePassed: false,
        budgetPassed: true,
      },
    });

    expect(blocked.allowed).toBe(false);
    expect(blocked.reasons).toEqual(["Required vote gate has not passed."]);
    expect(mode(store.path)).toBe(0o600);

    const reopened = new FinalityStore(paths);
    expect(reopened.latest("job-one")?.id).toBe("decision-one");
    expect(reopened.list()).toHaveLength(1);
  });

  test("allows completion when all required gates pass and ignores disabled gates", () => {
    const paths = fixturePaths();
    const store = new FinalityStore(paths, { id: () => "decision-two" });
    const allowed = store.evaluate({
      projectId: paths.projectId,
      jobId: "job-two",
      decidedBy: "daemon",
      requirements: {
        policy: true,
        tests: false,
        review: false,
        vote: false,
        budget: true,
      },
      gates: {
        policyPassed: true,
        testsPassed: false,
        reviewPassed: false,
        votePassed: false,
        budgetPassed: true,
      },
    });

    expect(allowed.allowed).toBe(true);
    expect(allowed.reasons).toEqual([]);
    expect(() => store.evaluate({
      projectId: "d".repeat(64),
      jobId: "wrong-project-job",
      decidedBy: "daemon",
    })).toThrow("Finality project mismatch");
  });
});

function fixturePaths() {
  const root = mkdtempSync(join(tmpdir(), "headless-authority-budget-"));
  temporaryPaths.push(root);
  const project = join(root, "project");
  mkdirSync(project);
  return getProjectStatePaths(project, { env: { HEADLESS_STATE_HOME: join(root, "state") } });
}

function request(
  paths: ProjectStatePaths,
  principal: string,
  overrides: Partial<{
    operation: "run" | "write" | "merge" | "council" | "workflow" | "admin";
    backend: string;
    estimatedCostUsd: number | null;
    merge: boolean;
    at: number;
  }> = {},
) {
  return {
    projectId: paths.projectId,
    principal,
    operation: overrides.operation ?? "write" as const,
    backend: overrides.backend ?? "opencode",
    estimatedCostUsd: overrides.estimatedCostUsd ?? null,
    merge: overrides.merge ?? false,
    ...(overrides.at === undefined ? {} : { at: overrides.at }),
  };
}

function grant(paths: ProjectStatePaths, overrides: Partial<Grant> = {}) {
  return GrantSchema.parse({
    id: "grant-write",
    projectId: paths.projectId,
    principal: "worker",
    operations: ["write", "merge"],
    backends: ["opencode"],
    expiresAt: 2_000,
    maxCostUsd: 3,
    issuedBy: "coordinator",
    createdAt: 500,
    revokedAt: null,
    ...overrides,
  });
}

function budget(paths: ProjectStatePaths, overrides: Partial<Budget> = {}) {
  return BudgetSchema.parse({
    id: "budget-main",
    projectId: paths.projectId,
    principal: "worker",
    sessionId: "session-one",
    workflowId: "workflow-one",
    provider: "openai",
    maxRequests: null,
    maxInputTokens: null,
    maxOutputTokens: null,
    maxCostUsd: null,
    maxArtifactBytes: null,
    maxConcurrency: null,
    maxRetries: null,
    usedRequests: 0,
    usedUsage: { input: 0, output: 0, reasoning: 0, cached: 0, providerTotal: 0 },
    usedCost: { amountUsd: 0, source: "reconciled", pricingId: null, observedRequests: 0 },
    usedArtifactBytes: 0,
    updatedAt: 0,
    ...overrides,
  });
}

function scope(paths: ProjectStatePaths) {
  return {
    projectId: paths.projectId,
    principal: "worker",
    sessionId: "session-one",
    workflowId: "workflow-one",
    provider: "openai",
  };
}

function reservation(
  paths: ProjectStatePaths,
  overrides: Partial<{
    id: string;
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
    artifactBytes: number;
    retries: number;
  }> = {},
) {
  return {
    ...scope(paths),
    id: overrides.id,
    inputTokens: overrides.inputTokens === undefined ? 0 : overrides.inputTokens,
    outputTokens: overrides.outputTokens === undefined ? 0 : overrides.outputTokens,
    costUsd: overrides.costUsd === undefined ? 0 : overrides.costUsd,
    artifactBytes: overrides.artifactBytes ?? 0,
    retries: overrides.retries ?? 0,
  };
}

function mode(path: string) {
  return statSync(path).mode & 0o777;
}
