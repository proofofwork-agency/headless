import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetSchema, type Budget } from "../src/contracts/durable";
import {
  LinkedHoldRecordSchema,
  LinkedHoldStateSchema,
  type LinkedHoldRecord,
} from "../src/contracts/linked-hold";
import {
  BudgetStore,
  BudgetStoreStateSchema,
  type PrepareLinkedProviderHoldInput,
} from "../src/runtime/budget-store";
import { getProjectStatePaths, type ProjectStatePaths } from "../src/runtime/project-state";

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("cross-provider linked-hold persistence contracts", () => {
  test("defines the exact states and rejects unknown fields, same-provider links, and unbounded usage", () => {
    expect(LinkedHoldStateSchema.options).toEqual([
      "intent",
      "held",
      "parent_carved",
      "admitted",
      "leased",
      "settling",
      "settled",
      "rolled_back",
      "exhausted",
      "recovery_required",
    ]);
    expect(LinkedHoldRecordSchema.parse(linkedHold())).toEqual(linkedHold());
    expect(() => LinkedHoldRecordSchema.parse({ ...linkedHold(), state: "future" })).toThrow();
    expect(() => LinkedHoldRecordSchema.parse({ ...linkedHold(), bearerToken: "must-not-persist" })).toThrow();
    expect(() => LinkedHoldRecordSchema.parse({ ...linkedHold(), targetProvider: "anthropic" })).toThrow("different parent and target providers");
    expect(() => LinkedHoldRecordSchema.parse({
      ...linkedHold(),
      usageProjection: usageProjection({ requests: 3 }),
    })).toThrow("exceeds its target reservation");
  });

  test("chains version-two migration through version three without changing its established reservation shape", () => {
    const paths = fixturePaths();
    const legacy = legacyV2Reservation(paths);
    writeState(paths, {
      version: 2,
      projectId: paths.projectId,
      budgets: [],
      reservations: [legacy],
      updatedAt: 123,
    });

    const upgraded = new BudgetStore(paths).getState();
    const expectedReservation = {
      ...legacy,
      parentReservationId: null,
      delegationRequestId: null,
      budgetFraction: null,
      envelope: {
        requests: 8,
        inputTokens: 200_000,
        outputTokens: 32_000,
        costUsd: 2,
        artifactBytes: 64,
        retries: 1,
      },
    };
    expect(upgraded.version).toBe(4);
    expect(upgraded.linkedHolds).toEqual([]);
    expect(JSON.stringify(upgraded.reservations)).toBe(JSON.stringify([expectedReservation]));
    expect(JSON.parse(readFileSync(paths.budgetsPath, "utf8"))).toEqual(upgraded);
  });

  test("migrates version three by adding only an empty linked-hold collection", () => {
    const paths = fixturePaths();
    const reservations = [v3Reservation(paths)];
    const reservationBytes = JSON.stringify(reservations);
    writeState(paths, {
      version: 3,
      projectId: paths.projectId,
      budgets: [],
      reservations,
      updatedAt: 456,
    });

    const upgraded = new BudgetStore(paths).getState();
    expect(upgraded.version).toBe(4);
    expect(upgraded.linkedHolds).toEqual([]);
    expect(JSON.stringify(upgraded.reservations)).toBe(reservationBytes);
    expect(JSON.parse(readFileSync(paths.budgetsPath, "utf8"))).toEqual(upgraded);
  });

  test("round-trips a strict version-four linked-hold record without credential material", () => {
    const paths = fixturePaths();
    const hold = linkedHold({
      state: "settling",
      transitionNumber: 5,
      childJobId: "child-job",
      brokerEvidence: {
        parentCarveId: "parent-carve",
        targetLeaseId: "target-lease",
        targetLeaseIssuedAt: 1_200,
        targetRequests: 1,
        targetForwardedRequests: 1,
        targetInputTokens: 400,
        targetOutputTokens: 80,
        targetCostUsd: 0.25,
        targetActiveRequests: 0,
        targetRevoked: true,
        targetExpiresAt: 1_900,
      },
      terminalSettlementDigest: "d".repeat(64),
      usageProjection: usageProjection(),
      updatedAt: 1_500,
    });
    const state = BudgetStoreStateSchema.parse({
      version: 4,
      projectId: paths.projectId,
      budgets: [],
      reservations: [],
      linkedHolds: [hold],
      updatedAt: 1_500,
    });
    writeState(paths, state);

    const reopened = new BudgetStore(paths).getState();
    expect(reopened.linkedHolds).toEqual([hold]);
    expect(JSON.stringify(reopened)).not.toContain("token");
  });

  test("fails closed without rewriting persisted unknown states or fields", () => {
    for (const invalidHold of [
      { ...linkedHold(), state: "future" },
      { ...linkedHold(), unknownEvidence: true },
    ]) {
      const paths = fixturePaths();
      const raw = `${JSON.stringify({
        version: 4,
        projectId: paths.projectId,
        budgets: [],
        reservations: [],
        linkedHolds: [invalidHold],
        updatedAt: 1_000,
      })}\n`;
      mkdirSync(paths.projectDir, { recursive: true });
      writeFileSync(paths.budgetsPath, raw, { mode: 0o600 });
      expect(() => new BudgetStore(paths)).toThrow();
      expect(readFileSync(paths.budgetsPath, "utf8")).toBe(raw);
    }
  });

  test("prepares only an idempotent intent and rejects changed identity or unknown finite pricing", () => {
    const paths = fixturePaths();
    const store = new BudgetStore(paths, { now: () => 1_000 });
    createParent(store, paths);
    const before = store.getReservation("parent-reservation")!;
    const input = prepareInput();

    const prepared = store.prepareLinkedProviderHold(input);
    expect(prepared).toMatchObject({ allowed: true, existing: false, hold: { state: "intent", transitionNumber: 0 } });
    expect(store.getState().reservations).toEqual([before]);
    expect(store.getReservation("parent-reservation")?.envelope).toEqual(before.envelope);
    expect(store.prepareLinkedProviderHold(input)).toMatchObject({ allowed: true, existing: true, hold: { linkId: prepared.hold?.linkId } });
    for (const changed of [
      { ...input, targetBackend: "opencode" },
      { ...input, targetProvider: "google" },
      { ...input, promptDigest: "f".repeat(64) },
      { ...input, approvalPolicy: "ask" as const },
      { ...input, childDeadlineAt: 3_900 },
      { ...input, budgetFraction: 0.2 },
      { ...input, parentAllocation: { ...input.parentAllocation, requests: 1 } },
    ]) {
      expect(() => store.prepareLinkedProviderHold(changed)).toThrow("different linked provider hold");
    }
    expect(() => store.prepareLinkedProviderHold({
      ...prepareInput({ requestId: "123e4567-e89b-42d3-a456-426614174002" }),
      targetProvider: "anthropic",
    })).toThrow("different parent and target providers");
    expect(() => store.prepareLinkedProviderHold({
      ...prepareInput({ requestId: "123e4567-e89b-42d3-a456-426614174003" }),
      targetBackend: "claude-code",
    })).toThrow("different parent and target backends");

    const finitePaths = fixturePaths();
    const finite = new BudgetStore(finitePaths);
    finite.upsertBudget(budget(finitePaths, { id: "target-cost", provider: "openai", maxCostUsd: 1 }));
    createParent(finite, finitePaths, { costUsd: null });
    const unknown = finite.prepareLinkedProviderHold(prepareInput({
      parentAllocation: { ...allocation(), costUsd: null },
      targetReservation: { ...allocation(), costUsd: null },
    }));
    expect(unknown.allowed).toBe(false);
    expect(unknown.reasons.join(" ")).toContain("pricing is unknown");
    expect(finite.getState().linkedHolds).toEqual([]);
  });

  test("atomically holds parent authority plus target and global budgets without granting independent authority", () => {
    const paths = fixturePaths();
    const store = new BudgetStore(paths, { now: () => 1_000 });
    store.upsertBudget(budget(paths, { id: "parent-only", provider: "anthropic", maxRequests: 4, maxCostUsd: 4 }));
    store.upsertBudget(budget(paths, {
      id: "target-only",
      provider: "openai",
      maxRequests: 2,
      maxInputTokens: 1_000,
      maxOutputTokens: 200,
      maxCostUsd: 1,
      maxConcurrency: 1,
    }));
    store.upsertBudget(budget(paths, {
      id: "global",
      provider: null,
      maxRequests: 3,
      maxInputTokens: 2_000,
      maxOutputTokens: 400,
      maxCostUsd: 5,
      maxConcurrency: 2,
    }));
    createParent(store, paths);
    const prepared = store.prepareLinkedProviderHold(prepareInput());
    expect(prepared.allowed).toBe(true);

    const applied = store.applyLinkedProviderHold(prepared.hold!.linkId);
    expect(applied).toMatchObject({
      allowed: true,
      existing: false,
      hold: { state: "held", transitionNumber: 1 },
      reservation: {
        id: "child-reservation",
        parentReservationId: "parent-reservation",
        provider: "openai",
        budgetIds: ["target-only", "global"],
        active: false,
      },
    });
    expect(applied.reservation?.budgetIds).not.toContain("parent-only");
    expect(new Set(applied.reservation?.budgetIds).size).toBe(applied.reservation?.budgetIds.length);
    expect(store.getReservation("parent-reservation")?.envelope).toMatchObject({ requests: 6, costUsd: 3 });

    const later = store.reserve(targetReservationRequest(paths, "later-target"));
    expect(later.allowed).toBe(false);
    expect(later.reasons.join(" ")).toContain("request limit");
    expect(store.subreserveDelegation({
      id: "same-provider-bypass",
      parentReservationId: "parent-reservation",
      requestId: crypto.randomUUID(),
      provider: "anthropic",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
    }).allowed).toBe(false);
  });

  test("leaves the parent and child state untouched when target constraints change before apply", () => {
    const paths = fixturePaths();
    const store = new BudgetStore(paths, { now: () => 1_000 });
    store.upsertBudget(budget(paths, { id: "target-limit", provider: "openai", maxRequests: 2, maxCostUsd: 1 }));
    createParent(store, paths);
    const prepared = store.prepareLinkedProviderHold(prepareInput());
    expect(prepared.allowed).toBe(true);
    const before = store.getReservation("parent-reservation")!;
    store.upsertBudget(budget(paths, { id: "target-limit", provider: "openai", maxRequests: 1, maxCostUsd: 1 }));

    const rejected = store.applyLinkedProviderHold(prepared.hold!.linkId);
    expect(rejected.allowed).toBe(false);
    expect(rejected.reasons.join(" ")).toContain("request limit");
    expect(store.getReservation("parent-reservation")).toEqual(before);
    expect(store.getReservation("child-reservation")).toBeNull();
    expect(store.getState().linkedHolds[0]).toMatchObject({ state: "intent", transitionNumber: 0 });
  });

  test("serializes competing apply calls so exactly one child consumes a parent slot", async () => {
    const paths = fixturePaths();
    const store = new BudgetStore(paths, { now: () => 1_000 });
    createParent(store, paths);
    const first = store.prepareLinkedProviderHold(prepareInput());
    const second = store.prepareLinkedProviderHold(prepareInput({
      childReservationId: "child-two",
      requestId: "123e4567-e89b-42d3-a456-426614174001",
      requestDigest: "d".repeat(64),
      promptDigest: "e".repeat(64),
    }));
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);

    const results = await Promise.all([
      Promise.resolve().then(() => store.applyLinkedProviderHold(first.hold!.linkId)),
      Promise.resolve().then(() => store.applyLinkedProviderHold(second.hold!.linkId)),
    ]);
    expect(results.filter((result) => result.allowed)).toHaveLength(1);
    expect(store.getState().reservations.filter((reservation) => reservation.parentReservationId === "parent-reservation")).toHaveLength(1);
    expect(store.getState().linkedHolds.filter((hold) => hold.state === "held")).toHaveLength(1);
  });
});

function fixturePaths() {
  const root = mkdtempSync(join(tmpdir(), "headless-linked-hold-"));
  temporaryPaths.push(root);
  const project = join(root, "project");
  mkdirSync(project);
  return getProjectStatePaths(project, { env: { HEADLESS_STATE_HOME: join(root, "state") } });
}

function writeState(paths: ProjectStatePaths, state: unknown) {
  mkdirSync(paths.projectDir, { recursive: true });
  writeFileSync(paths.budgetsPath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

function legacyV2Reservation(paths: ProjectStatePaths) {
  return {
    projectId: paths.projectId,
    principal: "worker",
    sessionId: null,
    workflowId: null,
    provider: "anthropic",
    inputTokens: 1_000,
    outputTokens: 200,
    costUsd: 2,
    artifactBytes: 64,
    retries: 1,
    id: "legacy-parent",
    budgetIds: [],
    active: true,
    createdAt: 100,
  };
}

function v3Reservation(paths: ProjectStatePaths) {
  return {
    ...legacyV2Reservation(paths),
    parentReservationId: null,
    delegationRequestId: null,
    budgetFraction: null,
    envelope: {
      requests: 8,
      inputTokens: 200_000,
      outputTokens: 32_000,
      costUsd: 2,
      artifactBytes: 64,
      retries: 1,
    },
  };
}

function createParent(
  store: BudgetStore,
  paths: ProjectStatePaths,
  overrides: Partial<Pick<PrepareLinkedProviderHoldInput["parentAllocation"], "costUsd">> = {},
) {
  const reserved = store.reserve({
    id: "parent-reservation",
    projectId: paths.projectId,
    principal: "worker",
    sessionId: null,
    workflowId: null,
    provider: "anthropic",
    inputTokens: 100,
    outputTokens: 40,
    costUsd: overrides.costUsd === undefined ? 4 : overrides.costUsd,
    artifactBytes: 256,
    retries: 0,
  });
  expect(reserved.allowed).toBe(true);
  expect(store.activate("parent-reservation").allowed).toBe(true);
}

function prepareInput(overrides: Partial<PrepareLinkedProviderHoldInput> = {}): PrepareLinkedProviderHoldInput {
  return {
    parentJobId: "parent-job",
    parentReservationId: "parent-reservation",
    childReservationId: "child-reservation",
    requestId: "123e4567-e89b-42d3-a456-426614174000",
    parentBackend: "claude-code",
    targetBackend: "codex",
    parentProvider: "anthropic",
    targetProvider: "openai",
    budgetFraction: 0.25,
    parentDeadlineAt: 5_000,
    childDeadlineAt: 4_000,
    approvalPolicy: "auto",
    parentAllocation: allocation(),
    targetReservation: allocation(),
    requestDigest: "b".repeat(64),
    promptDigest: "c".repeat(64),
    promptBytes: 128,
    ...overrides,
  };
}

function budget(paths: ProjectStatePaths, overrides: Partial<Budget>): Budget {
  return BudgetSchema.parse({
    id: "budget",
    projectId: paths.projectId,
    principal: "worker",
    sessionId: null,
    workflowId: null,
    provider: null,
    maxRequests: null,
    maxInputTokens: null,
    maxOutputTokens: null,
    maxCostUsd: null,
    maxArtifactBytes: null,
    maxConcurrency: null,
    maxRetries: null,
    expiresAt: null,
    usedRequests: 0,
    usedUsage: {
      input: 0,
      output: 0,
      reasoning: 0,
      cached: 0,
      providerTotal: 0,
    },
    usedCost: {
      amountUsd: 0,
      source: "reconciled",
      pricingId: null,
      observedRequests: 0,
    },
    usedArtifactBytes: 0,
    updatedAt: 0,
    ...overrides,
  });
}

function targetReservationRequest(paths: ProjectStatePaths, id: string) {
  return {
    id,
    projectId: paths.projectId,
    principal: "worker",
    sessionId: null,
    workflowId: null,
    provider: "openai",
    inputTokens: 1,
    outputTokens: 1,
    costUsd: 0.1,
    artifactBytes: 0,
    retries: 0,
  };
}

function linkedHold(overrides: Partial<LinkedHoldRecord> = {}): LinkedHoldRecord {
  return {
    linkId: "a".repeat(64),
    parentJobId: "parent-job",
    parentReservationId: "parent-reservation",
    childReservationId: "child-reservation",
    requestId: "123e4567-e89b-42d3-a456-426614174000",
    parentBackend: "claude-code",
    targetBackend: "codex",
    parentProvider: "anthropic",
    targetProvider: "openai",
    depth: 1,
    budgetFraction: 0.25,
    parentDeadlineAt: 2_000,
    childDeadlineAt: 1_900,
    approvalPolicy: "auto",
    parentAllocation: allocation(),
    targetReservation: allocation(),
    parentBudgetIds: ["parent-budget"],
    targetBudgetIds: ["target-budget"],
    parentCarveId: "linked-parent-carve",
    targetQuotaId: "linked-target-quota",
    requestDigest: "b".repeat(64),
    promptDigest: "c".repeat(64),
    promptBytes: 128,
    state: "intent",
    transitionNumber: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    terminalAt: null,
    childJobId: null,
    brokerEvidence: {
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
    },
    terminalSettlementDigest: null,
    usageProjection: null,
    ...overrides,
  };
}

function allocation() {
  return {
    requests: 2,
    inputTokens: 1_000,
    outputTokens: 200,
    costUsd: 1,
    artifactBytes: 64,
    retries: 0,
  };
}

function usageProjection(overrides: Partial<NonNullable<LinkedHoldRecord["usageProjection"]>> = {}) {
  return {
    requests: 1,
    inputTokens: 400,
    outputTokens: 80,
    reasoningTokens: 20,
    cachedTokens: 0,
    providerTotalTokens: 500,
    costUsd: 0.25,
    costSource: "broker" as const,
    pricingId: "pricing-v1",
    artifactBytes: 16,
    ...overrides,
  };
}
