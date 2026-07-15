import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LinkedHoldRecordSchema,
  LinkedHoldStateSchema,
  type LinkedHoldRecord,
} from "../src/contracts/linked-hold";
import { BudgetStore, BudgetStoreStateSchema } from "../src/runtime/budget-store";
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
