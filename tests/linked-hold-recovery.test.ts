import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderBroker, type BrokerLinkedOperation } from "../src/broker/server";
import { BudgetSchema } from "../src/contracts/durable";
import { recoverLinkedProviderHolds } from "../src/daemon/linked-hold-recovery";
import { JobStore } from "../src/daemon/job-store";
import { HeadlessDaemon } from "../src/daemon/server";
import { RunEventStore } from "../src/daemon/run-event-store";
import { BudgetStore } from "../src/runtime/budget-store";
import { DurableBrokerQuotaStore } from "../src/runtime/broker-quota-store";
import { inspectLinkedHoldOffline, quarantineLinkedHoldOffline } from "../src/runtime/linked-hold-quarantine";
import { getProjectStatePaths, type ProjectStatePaths } from "../src/runtime/project-state";

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("cross-provider linked-hold startup recovery", () => {
  test("replays every valid crash cut to rolled-back, settled, or exhausted exactly once", () => {
    for (const cut of ["intent", "held", "parent_carved", "admitted", "leased_zero", "leased_nonzero", "settling"] as const) {
      const fixture = recoveryFixture(cut);
      const restarted = restartBroker(fixture.paths);
      recoverLinkedProviderHolds({ budgets: fixture.budgets, broker: restarted, jobs: fixture.jobs });
      const hold = fixture.budgets.getLinkedProviderHold(fixture.linkId)!;
      const expected = cut === "leased_nonzero" ? "exhausted" : cut === "settling" ? "settled" : "rolled_back";
      expect(hold.state, cut).toBe(expected);
      expect(fixture.budgets.getReservation("child-job"), cut).toBeNull();
      if (["admitted", "leased_zero", "leased_nonzero"].includes(cut)) {
        expect(fixture.jobs.get("child-job")?.state, cut).toBe("blocked");
      }
      if (cut === "leased_nonzero") {
        expect(fixture.budgets.getState().budgets.find((budget) => budget.id === "target")?.usedRequests).toBe(2);
      }
      expect(() => recoverLinkedProviderHolds({ budgets: fixture.budgets, broker: restarted, jobs: fixture.jobs })).not.toThrow();
    }
  });

  test("quarantines impossible state, missing jobs, altered allocations, regressed counters, duplicate children, and digest mismatch", () => {
    for (const corruption of ["one-sided", "missing-job", "allocation", "counter", "duplicate", "digest"] as const) {
      const fixture = recoveryFixture(
        corruption === "counter" ? "leased_zero"
          : corruption === "missing-job" ? "admitted"
            : corruption === "digest" ? "settling"
              : "held",
      );
      const beforeParent = fixture.budgets.getReservation("parent-job")!.envelope;
      const raw = JSON.parse(readFileSync(fixture.paths.budgetsPath, "utf8"));
      const hold = raw.linkedHolds[0];
      if (corruption === "one-sided") {
        hold.state = "intent";
        hold.transitionNumber = 0;
      } else if (corruption === "missing-job") {
        rmSync(join(fixture.paths.jobsDir, "child-job.job.json"), { force: true });
      } else if (corruption === "allocation") {
        raw.reservations.find((reservation: { id: string }) => reservation.id === "child-job").envelope.requests = 1;
      } else if (corruption === "counter") {
        hold.brokerEvidence.targetRequests = 1;
      } else if (corruption === "duplicate") {
        raw.linkedHolds.push({
          ...structuredClone(hold),
          linkId: "f".repeat(64),
          childReservationId: "other-child",
          requestId: "123e4567-e89b-42d3-a456-426614174099",
          requestDigest: "e".repeat(64),
          promptDigest: "f".repeat(64),
        });
      } else {
        hold.terminalSettlementDigest = "0".repeat(64);
      }
      writeFileSync(fixture.paths.budgetsPath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
      const budgets = new BudgetStore(fixture.paths);
      expect(() => recoverLinkedProviderHolds({ budgets, broker: restartBroker(fixture.paths), jobs: fixture.jobs }), corruption).toThrow("operator action");
      expect(budgets.getState().linkedHolds.some((candidate) => candidate.state === "recovery_required"), corruption).toBe(true);
      expect(budgets.getReservation("parent-job")?.envelope, corruption).toEqual(beforeParent);
    }
  });

  test("blocks daemon readiness before ordinary recovery when one link is ambiguous", async () => {
    const fixture = recoveryFixture("held");
    const raw = JSON.parse(readFileSync(fixture.paths.budgetsPath, "utf8"));
    raw.reservations.find((reservation: { id: string }) => reservation.id === "child-job").envelope.requests = 1;
    writeFileSync(fixture.paths.budgetsPath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    const daemon = new HeadlessDaemon({ projectRoot: fixture.paths.canonicalProjectRoot, state: fixture.stateOptions });
    await expect(daemon.start()).rejects.toThrow("operator action");
    expect(existsSync(fixture.paths.socketPath)).toBe(false);
    expect(new BudgetStore(fixture.paths).getLinkedProviderHold(fixture.linkId)?.state).toBe("recovery_required");
  });

  test("replays a durable mid-settlement digest before readiness without double charge or quota return", async () => {
    const fixture = recoveryFixture("settling");
    const before = fixture.budgets.getLinkedProviderHold(fixture.linkId)!;
    expect(before.state).toBe("settling");
    const daemon = new HeadlessDaemon({ projectRoot: fixture.paths.canonicalProjectRoot, state: fixture.stateOptions });
    await daemon.start();
    await daemon.stop();

    const recoveredStore = new BudgetStore(fixture.paths);
    const recovered = recoveredStore.getLinkedProviderHold(fixture.linkId)!;
    expect(recovered).toMatchObject({
      state: "settled",
      terminalSettlementDigest: before.terminalSettlementDigest,
      usageProjection: before.usageProjection,
      settlementObservation: before.settlementObservation,
    });
    expect(recoveredStore.getReservation("child-job")).toBeNull();
    expect(recoveredStore.getState().budgets.find((budget) => budget.id === "target")?.usedRequests).toBe(0);
    const once = JSON.stringify(recoveredStore.getState().linkedHolds);

    const second = new HeadlessDaemon({ projectRoot: fixture.paths.canonicalProjectRoot, state: fixture.stateOptions });
    await second.start();
    await second.stop();
    expect(JSON.stringify(new BudgetStore(fixture.paths).getState().linkedHolds)).toBe(once);
  });

  test("quarantines one corrupt link offline, restores readiness, and preserves every other hold byte-for-byte", async () => {
    const fixture = recoveryFixture("settling");
    const otherLinkId = seedUnrelatedRolledBackHold(fixture);
    const otherBefore = JSON.stringify(fixture.budgets.getLinkedProviderHold(otherLinkId));
    const raw = JSON.parse(readFileSync(fixture.paths.budgetsPath, "utf8"));
    raw.linkedHolds.find((hold: { linkId: string }) => hold.linkId === fixture.linkId).terminalSettlementDigest = "f".repeat(64);
    writeFileSync(fixture.paths.budgetsPath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });

    const blocked = new HeadlessDaemon({ projectRoot: fixture.paths.canonicalProjectRoot, state: fixture.stateOptions });
    await expect(blocked.start()).rejects.toThrow("operator action");
    expect(existsSync(fixture.paths.socketPath)).toBe(false);
    expect(JSON.stringify(new BudgetStore(fixture.paths).getLinkedProviderHold(otherLinkId))).toBe(otherBefore);

    const inspected = await inspectLinkedHoldOffline(fixture.paths.canonicalProjectRoot, fixture.linkId, fixture.stateOptions);
    await expect(quarantineLinkedHoldOffline({
      projectRoot: fixture.paths.canonicalProjectRoot,
      state: fixture.stateOptions,
      linkId: fixture.linkId,
      expectedDigest: "0".repeat(64),
      resolution: "exhaust",
      confirm: true,
    })).rejects.toThrow("changed after inspection");
    const quarantined = await quarantineLinkedHoldOffline({
      projectRoot: fixture.paths.canonicalProjectRoot,
      state: fixture.stateOptions,
      linkId: fixture.linkId,
      expectedDigest: inspected.recordDigest,
      resolution: "exhaust",
      confirm: true,
    });
    expect(JSON.stringify(new BudgetStore(fixture.paths).getLinkedProviderHold(otherLinkId))).toBe(otherBefore);

    const ready = new HeadlessDaemon({ projectRoot: fixture.paths.canonicalProjectRoot, state: fixture.stateOptions });
    await ready.start();
    await ready.stop();
    const reopened = new BudgetStore(fixture.paths);
    expect(reopened.getLinkedProviderHold(fixture.linkId)).toBeNull();
    expect(JSON.stringify(reopened.getLinkedProviderHold(otherLinkId))).toBe(otherBefore);
    expect(reopened.manualRecoveryMarkers()).toContainEqual(expect.objectContaining({
      linkId: fixture.linkId,
      resolution: "exhaust",
      auditEventId: quarantined.auditEventId,
      auditedAt: expect.any(Number),
    }));
    expect(new RunEventStore(fixture.paths.runEventsPath).protectedSnapshot({ limit: 100 }).records)
      .toContainEqual(expect.objectContaining({ event: expect.objectContaining({
        eventId: quarantined.auditEventId,
        rule: "linked-hold-manual-recovery",
      }) }));
  });
});

describe("offline linked-hold operator recovery", () => {
  test("refuses a non-isolatable child-allocation corruption without releasing either side", async () => {
    const fixture = recoveryFixture("held");
    const raw = JSON.parse(readFileSync(fixture.paths.budgetsPath, "utf8"));
    raw.reservations.find((reservation: { id: string }) => reservation.id === "child-job").envelope.requests = 1;
    writeFileSync(fixture.paths.budgetsPath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    const budgets = new BudgetStore(fixture.paths);
    expect(() => recoverLinkedProviderHolds({ budgets, broker: restartBroker(fixture.paths), jobs: fixture.jobs })).toThrow("operator action");
    const inspected = await inspectLinkedHoldOffline(fixture.paths.canonicalProjectRoot, fixture.linkId, fixture.stateOptions);
    const parentBefore = budgets.getReservation("parent-job")!.envelope;
    const childBefore = budgets.getReservation("child-job")!.envelope;

    await expect(quarantineLinkedHoldOffline({
      projectRoot: fixture.paths.canonicalProjectRoot,
      state: fixture.stateOptions,
      linkId: fixture.linkId,
      expectedDigest: inspected.recordDigest,
      resolution: "exhaust",
      confirm: true,
    })).rejects.toThrow("no longer matches its durable hold");
    const unchanged = new BudgetStore(fixture.paths);
    expect(unchanged.getLinkedProviderHold(fixture.linkId)?.state).toBe("recovery_required");
    expect(unchanged.getReservation("parent-job")?.envelope).toEqual(parentBefore);
    expect(unchanged.getReservation("child-job")?.envelope).toEqual(childBefore);
    expect(unchanged.manualRecoveryMarkers()).toEqual([]);
  });

  test("inspects one exact link, enforces the digest, writes evidence first, and releases only zero egress", async () => {
    const fixture = recoveryFixture("admitted");
    fixture.budgets.markLinkedRecoveryRequired(fixture.linkId, "injected admitted-state contradiction");
    const other = unrelatedHold(fixture.budgets.getLinkedProviderHold(fixture.linkId)!);
    const raw = JSON.parse(readFileSync(fixture.paths.budgetsPath, "utf8"));
    raw.linkedHolds.push(other);
    writeFileSync(fixture.paths.budgetsPath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });

    const inspected = await inspectLinkedHoldOffline(fixture.paths.canonicalProjectRoot, fixture.linkId, fixture.stateOptions);
    expect(inspected).toMatchObject({ linkId: fixture.linkId, state: "recovery_required", zeroEgress: true });
    expect(JSON.stringify(inspected)).not.toContain("prompt for child");
    await expect(quarantineLinkedHoldOffline({
      projectRoot: fixture.paths.canonicalProjectRoot,
      state: fixture.stateOptions,
      linkId: fixture.linkId,
      expectedDigest: "0".repeat(64),
      resolution: "release",
      confirm: true,
    })).rejects.toThrow("changed after inspection");

    const beforeOther = JSON.stringify(other);
    const result = await quarantineLinkedHoldOffline({
      projectRoot: fixture.paths.canonicalProjectRoot,
      state: fixture.stateOptions,
      linkId: fixture.linkId,
      expectedDigest: inspected.recordDigest,
      resolution: "release",
      confirm: true,
    });
    expect(result).toMatchObject({ ok: true, resolution: "release", existing: false });
    const reopened = new BudgetStore(fixture.paths);
    expect(reopened.getLinkedProviderHold(fixture.linkId)).toBeNull();
    expect(JSON.stringify(reopened.getState().linkedHolds[0])).toBe(beforeOther);
    expect(reopened.getReservation("child-job")).toBeNull();
    expect(reopened.getReservation("parent-job")?.envelope).toMatchObject({ requests: 8, costUsd: 4 });
    expect(reopened.manualRecoveryMarkers()).toHaveLength(1);
    expect(readFileSync(result.quarantineArtifact, "utf8")).toContain(inspected.recordDigest);
    expect((await quarantineLinkedHoldOffline({
      projectRoot: fixture.paths.canonicalProjectRoot,
      state: fixture.stateOptions,
      linkId: fixture.linkId,
      expectedDigest: inspected.recordDigest,
      resolution: "release",
      confirm: true,
    })).existing).toBe(true);
  });

  test("exhausts one ambiguous leased link and rejects missing confirmation or bulk selectors", async () => {
    const fixture = recoveryFixture("leased_nonzero");
    fixture.budgets.markLinkedRecoveryRequired(fixture.linkId, "injected counter ambiguity");
    const inspected = await inspectLinkedHoldOffline(fixture.paths.canonicalProjectRoot, fixture.linkId, fixture.stateOptions);
    await expect(quarantineLinkedHoldOffline({
      projectRoot: fixture.paths.canonicalProjectRoot,
      state: fixture.stateOptions,
      linkId: fixture.linkId,
      expectedDigest: inspected.recordDigest,
      resolution: "release",
      confirm: true,
    })).rejects.toThrow("zero-egress");
    await expect(quarantineLinkedHoldOffline({
      projectRoot: fixture.paths.canonicalProjectRoot,
      state: fixture.stateOptions,
      linkId: fixture.linkId,
      expectedDigest: inspected.recordDigest,
      resolution: "exhaust",
      confirm: false,
    })).rejects.toThrow("requires literal --confirm");
    const result = await quarantineLinkedHoldOffline({
      projectRoot: fixture.paths.canonicalProjectRoot,
      state: fixture.stateOptions,
      linkId: fixture.linkId,
      expectedDigest: inspected.recordDigest,
      resolution: "exhaust",
      confirm: true,
    });
    expect(result.resolution).toBe("exhaust");
    const reopened = new BudgetStore(fixture.paths);
    expect(reopened.getReservation("parent-job")?.envelope).toMatchObject({ requests: 6, costUsd: 3 });
    expect(reopened.getState().budgets.find((budget) => budget.id === "target")?.usedRequests).toBe(2);
  });

  test("emits one deterministic protected audit before readiness and marks it durably", async () => {
    const fixture = recoveryFixture("admitted");
    fixture.budgets.markLinkedRecoveryRequired(fixture.linkId, "injected admitted-state contradiction");
    const inspected = await inspectLinkedHoldOffline(fixture.paths.canonicalProjectRoot, fixture.linkId, fixture.stateOptions);
    const recovered = await quarantineLinkedHoldOffline({
      projectRoot: fixture.paths.canonicalProjectRoot,
      state: fixture.stateOptions,
      linkId: fixture.linkId,
      expectedDigest: inspected.recordDigest,
      resolution: "release",
      confirm: true,
    });
    const daemon = new HeadlessDaemon({ projectRoot: fixture.paths.canonicalProjectRoot, state: fixture.stateOptions });
    await daemon.start();
    await daemon.stop();
    const markers = new BudgetStore(fixture.paths).manualRecoveryMarkers();
    expect(markers[0]).toMatchObject({ auditEventId: recovered.auditEventId });
    expect(markers[0]!.auditedAt).not.toBeNull();
    const events = new RunEventStore(fixture.paths.runEventsPath).protectedSnapshot({ limit: 100 }).records;
    expect(events.filter((record) => record.event.eventId === recovered.auditEventId)).toHaveLength(1);
    expect(events.find((record) => record.event.eventId === recovered.auditEventId)?.event).toMatchObject({
      kind: "policy",
      rule: "linked-hold-manual-recovery",
    });
  });
});

type Cut = "intent" | "held" | "parent_carved" | "admitted" | "leased_zero" | "leased_nonzero" | "settling";

function recoveryFixture(cut: Cut) {
  const root = mkdtempSync(join(tmpdir(), "headless-linked-recovery-"));
  temporaryPaths.push(root);
  const projectRoot = join(root, "project");
  mkdirSync(projectRoot);
  const runtimeRoot = join(tmpdir(), `hlr-${process.pid}-${temporaryPaths.length}`);
  temporaryPaths.push(runtimeRoot);
  const stateOptions = { env: { HEADLESS_STATE_HOME: join(root, "state"), HEADLESS_RUNTIME_HOME: runtimeRoot } };
  const paths = getProjectStatePaths(projectRoot, stateOptions);
  const budgets = new BudgetStore(paths);
  budgets.upsertBudget(testBudget(paths, "parent", "anthropic", 8));
  budgets.upsertBudget(testBudget(paths, "target", "openai", 4));
  budgets.upsertBudget(testBudget(paths, "global", null, 16));
  expect(budgets.reserve({
    id: "parent-job", projectId: paths.projectId, principal: "worker", sessionId: null, workflowId: null,
    provider: "anthropic", inputTokens: 1_000, outputTokens: 200, costUsd: 4, artifactBytes: 256, retries: 0,
  }).allowed).toBe(true);
  expect(budgets.activate("parent-job").allowed).toBe(true);

  const jobs = new JobStore(paths.jobsDir);
  const parentRequest = runRequest(paths, "claude-code", "parent prompt", "anthropic-model");
  jobs.create({ id: "parent-job", projectId: paths.projectId, principal: "worker", request: parentRequest });
  jobs.claim("parent-job", "daemon", 60_000);
  jobs.transition("parent-job", "running");

  const quotaStore = new DurableBrokerQuotaStore(paths);
  const broker = brokerFromStore(paths, quotaStore);
  broker.start();
  broker.issueLease({
    runId: "parent-job", provider: "anthropic", models: ["anthropic-model"], endpointClasses: ["messages"],
    expiresAt: Date.now() + 120_000, maxRequests: 8, maxCostUsd: 4,
    budgetQuotas: [{ id: "headless-run-parent", maxRequests: 8, usedRequests: 0, maxInputTokens: 200_000, usedInputTokens: 0, maxOutputTokens: 32_000, usedOutputTokens: 0, maxCostUsd: 4, usedCostUsd: 0 }],
  });
  const prepared = budgets.prepareLinkedProviderHold({
    parentJobId: "parent-job", parentReservationId: "parent-job", childReservationId: "child-job",
    requestId: "123e4567-e89b-42d3-a456-426614174000", parentBackend: "claude-code", targetBackend: "codex",
    parentProvider: "anthropic", targetProvider: "openai", budgetFraction: 0.25,
    parentDeadlineAt: Date.now() + 100_000, childDeadlineAt: Date.now() + 80_000, approvalPolicy: "auto",
    parentAllocation: allocation(), targetReservation: allocation(), requestDigest: "b".repeat(64), promptDigest: "c".repeat(64), promptBytes: 16,
  });
  const linkId = prepared.hold!.linkId;
  const finished = () => {
    broker.stop();
    return { paths, stateOptions, budgets, jobs, linkId };
  };
  if (cut === "intent") return finished();
  budgets.applyLinkedProviderHold(linkId);
  if (cut === "held") return finished();
  const carve = broker.carveLinkedParent(linkId, "parent-job", { requests: 2, inputTokens: 1_000, outputTokens: 200, costUsd: 1 });
  budgets.markLinkedParentCarved(linkId, carve.id);
  if (cut === "parent_carved") return finished();
  budgets.activate("child-job");
  jobs.create({
    id: "child-job", projectId: paths.projectId, principal: "worker",
    request: runRequest(paths, "codex", "prompt for child", "openai-model"),
    delegationOf: { parentJobId: "parent-job", requestId: "123e4567-e89b-42d3-a456-426614174000", depth: 1, budgetFraction: 0.25 },
  });
  budgets.markLinkedAdmitted(linkId, "child-job");
  if (cut === "admitted") return finished();
  const limits = budgets.brokerLeaseLimits("child-job");
  const issued = broker.issueLinkedTarget(linkId, "child-job", {
    provider: "openai", models: ["openai-model"], endpointClasses: ["responses"],
    expiresAt: Date.now() + 90_000, childDeadlineAt: Date.now() + 80_000, replyMarginMs: 10_000,
    maxRequests: limits.maxRequests, maxInputTokens: limits.maxInputTokens, maxOutputTokens: limits.maxOutputTokens,
    maxCostUsd: limits.maxCostUsd, budgetQuotas: limits.budgetQuotas,
  });
  if (issued.status !== "issued") throw new Error("fixture target lease was not minted");
  const runQuota = issued.evidence.targetQuotaScope.budgetQuotas[0]!;
  budgets.markLinkedLeased(linkId, {
    targetLeaseId: issued.evidence.targetLeaseId,
    targetTokenHash: issued.evidence.targetTokenHash,
    targetIssuedAt: issued.evidence.targetIssuedAt,
    targetQuotaScope: {
      provider: issued.evidence.targetQuotaScope.provider,
      runQuotaId: runQuota.id,
      budgetQuotaIds: issued.evidence.targetQuotaScope.budgetQuotas.map((quota) => quota.id),
      maxRequests: issued.evidence.targetQuotaScope.maxRequests,
      maxInputTokens: runQuota.maxInputTokens,
      maxOutputTokens: runQuota.maxOutputTokens,
      maxCostUsd: issued.evidence.targetQuotaScope.maxCostUsd,
    },
    targetExpiresAt: issued.evidence.targetExpiresAt,
  });
  if (cut === "leased_nonzero") {
    const target = broker.linkedOperationSnapshot(linkId).target!;
    if (target.kind !== "target") throw new Error("fixture target operation mismatch");
    quotaStore.updateLinkedOperation({
      ...target,
      observation: { ...target.observation, requests: 1, forwardedRequests: 1, accountedInputTokens: 10 },
      updatedAt: Date.now(),
    });
  }
  if (cut === "settling") {
    broker.revokeLinkedTarget(linkId);
    const observation = broker.observeLinkedTarget(linkId)!;
    budgets.beginLinkedProviderSettlement(linkId, { disposition: "settled", usage: zeroUsage(), observation });
  }
  return finished();
}

function restartBroker(paths: ProjectStatePaths) {
  const store = new DurableBrokerQuotaStore(paths);
  return brokerFromStore(paths, store);
}

function brokerFromStore(paths: ProjectStatePaths, store: DurableBrokerQuotaStore) {
  return new ProviderBroker({
    initialBudgetQuotas: store.snapshot(),
    persistBudgetQuota: (quota, expiresAt) => store.update(quota, expiresAt),
    initialLinkedOperations: store.linkedSnapshot(),
    persistLinkedOperation: (operation: BrokerLinkedOperation) => store.updateLinkedOperation(operation),
  });
}

function runRequest(paths: ProjectStatePaths, backend: string, prompt: string, model: string) {
  return {
    backend, prompt, projectRoot: paths.canonicalProjectRoot, mode: "read-only" as const, model,
    timeoutMs: 60_000, containment: "required" as const,
    authMode: "broker" as const, approvalPolicy: "auto" as const,
  };
}

function testBudget(paths: ProjectStatePaths, id: string, provider: string | null, maxRequests: number, principal = "worker") {
  return BudgetSchema.parse({
    id, projectId: paths.projectId, principal, sessionId: null, workflowId: null, provider,
    maxRequests, maxInputTokens: 500_000, maxOutputTokens: 100_000, maxCostUsd: 20,
    maxArtifactBytes: 1_000_000, maxConcurrency: 8, maxRetries: 2, expiresAt: null,
    usedRequests: 0, usedUsage: { input: 0, output: 0, reasoning: 0, cached: 0, providerTotal: 0 },
    usedCost: { amountUsd: 0, source: "reconciled", pricingId: null, observedRequests: 0 },
    usedArtifactBytes: 0, updatedAt: Date.now(),
  });
}

function allocation() {
  return { requests: 2, inputTokens: 1_000, outputTokens: 200, costUsd: 1, artifactBytes: 64, retries: 0 };
}

function zeroUsage() {
  return {
    requests: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0,
    providerTotalTokens: 0, costUsd: 0, costSource: "broker" as const, pricingId: null, artifactBytes: 0,
  };
}

function unrelatedHold(source: ReturnType<BudgetStore["getLinkedProviderHold"]> extends infer T ? NonNullable<T> : never) {
  return {
    ...structuredClone(source),
    linkId: "f".repeat(64),
    parentJobId: "unrelated-parent",
    parentReservationId: "unrelated-parent",
    childReservationId: "unrelated-child",
    requestId: "123e4567-e89b-42d3-a456-426614174099",
    state: "intent" as const,
    transitionNumber: 0,
    childJobId: null,
    brokerEvidence: {
      parentCarveId: null, targetLeaseId: null, targetTokenHash: null, targetLeaseIssuedAt: null,
      targetQuotaScope: null, targetRequests: null, targetForwardedRequests: null, targetInputTokens: null,
      targetOutputTokens: null, targetCostUsd: null, targetActiveRequests: null, targetRevoked: null, targetExpiresAt: null,
    },
    terminalAt: null,
    terminalSettlementDigest: null,
    usageProjection: null,
    settlementDisposition: null,
    settlementObservation: null,
    recoveryReason: null,
  };
}

function seedUnrelatedRolledBackHold(fixture: ReturnType<typeof recoveryFixture>) {
  fixture.budgets.upsertBudget(testBudget(fixture.paths, "other-parent-budget", "anthropic", 4, "other-worker"));
  expect(fixture.budgets.reserve({
    id: "other-parent",
    projectId: fixture.paths.projectId,
    principal: "other-worker",
    sessionId: null,
    workflowId: null,
    provider: "anthropic",
    inputTokens: 1_000,
    outputTokens: 200,
    costUsd: 2,
    artifactBytes: 64,
    retries: 0,
  }).allowed).toBe(true);
  expect(fixture.budgets.activate("other-parent").allowed).toBe(true);
  const prepared = fixture.budgets.prepareLinkedProviderHold({
    parentJobId: "other-parent",
    parentReservationId: "other-parent",
    childReservationId: "other-child",
    requestId: "123e4567-e89b-42d3-a456-426614174077",
    parentBackend: "claude-code",
    targetBackend: "codex",
    parentProvider: "anthropic",
    targetProvider: "openai",
    budgetFraction: 0.25,
    parentDeadlineAt: Date.now() + 100_000,
    childDeadlineAt: Date.now() + 80_000,
    approvalPolicy: "auto",
    parentAllocation: { requests: 1, inputTokens: 250, outputTokens: 50, costUsd: 0.5, artifactBytes: 16, retries: 0 },
    targetReservation: { requests: 1, inputTokens: 250, outputTokens: 50, costUsd: 0.5, artifactBytes: 16, retries: 0 },
    requestDigest: "d".repeat(64),
    promptDigest: "e".repeat(64),
    promptBytes: 16,
  });
  fixture.budgets.rollbackLinkedProviderHold(prepared.hold!.linkId);
  return prepared.hold!.linkId;
}
