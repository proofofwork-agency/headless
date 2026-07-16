import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureProjectStateDirectories, getProjectStatePaths } from "../src/runtime/project-state";
import { ReceiptJournal } from "../src/runtime/receipt-journal";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("durable receipt journal", () => {
  test("persists immutable assembly inputs and closes completed or explicit-gap records", () => {
    const { journal } = createJournal();
    const intent = receiptIntent("receipt-job-1");

    expect(journal.pending(intent)).toMatchObject({ state: "pending", createdAt: 100, completedAt: null });
    expect(journal.pending(intent)).toMatchObject({ state: "pending" });
    expect(journal.listOpen()).toHaveLength(1);
    expect(() => journal.pending({ ...intent, startedAt: 99 })).toThrow("different inputs");
    expect(journal.markCompleted(intent.jobId)).toMatchObject({ state: "completed", completedAt: 100 });
    expect(journal.markCompleted(intent.jobId)).toMatchObject({ state: "completed" });
    expect(journal.listOpen()).toEqual([]);
    expect(statSync(join(journal.directory, `${intent.jobId}.json`)).mode & 0o777).toBe(0o600);

    const gap = receiptIntent("receipt-job-2");
    journal.pending(gap);
    expect(journal.markGap(gap.jobId, "receipt assembly failed")).toMatchObject({
      state: "gap",
      gapReason: "receipt assembly failed",
      completedAt: 100,
    });
    expect(journal.listOpen()).toEqual([]);
  });

  test("reports one malformed record without hiding other pending work", () => {
    const { journal } = createJournal();
    journal.pending(receiptIntent("receipt-job-good"));
    writeFileSync(join(journal.directory, "receipt-job-bad.json"), "{broken\n", { mode: 0o600 });
    const errors: string[] = [];

    expect(journal.listOpen((path) => errors.push(path))).toHaveLength(1);
    expect(errors).toEqual([join(journal.directory, "receipt-job-bad.json")]);
  });
});

function createJournal() {
  const root = mkdtempSync(join(tmpdir(), "headless-receipt-journal-"));
  roots.push(root);
  const project = join(root, "project");
  mkdirSync(project);
  const paths = ensureProjectStateDirectories(getProjectStatePaths(project, {
    env: { HEADLESS_STATE_HOME: join(root, "state") },
  }));
  return { journal: new ReceiptJournal(paths, () => 100) };
}

function receiptIntent(jobId: string) {
  return {
    jobId,
    sessionId: null,
    principal: "receipt-owner",
    startedAt: 50,
    authorization: {
      source: "root" as const,
      mergeAllowed: true,
      maxCostUsd: null,
      grantId: null,
      grantTerms: null,
      finality: null,
    },
    brokerLease: null,
    gates: [],
    budget: {
      passed: true,
      reasons: [],
      usage: { input: null, output: null, reasoning: null, cached: null, providerTotal: null },
      cost: { amountUsd: null, source: "unknown" as const, pricingId: null, observedRequests: 0 },
      reservationId: null,
    },
    provenance: {
      headlessVersion: "0.2.0-test",
      platform: "test-platform",
      commit: "a".repeat(40),
      backendVersion: "fixture 1.0.0",
    },
    captureFailure: null,
  };
}
