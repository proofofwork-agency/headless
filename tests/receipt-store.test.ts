import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReceiptBodySchema, ReceiptSchema, type Receipt } from "../src/contracts/receipt";
import { receiptSectionDigests, receiptSelfDigest } from "../src/runtime/receipt-canonical";
import { ReceiptStore } from "../src/runtime/receipt-store";

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("ReceiptStore", () => {
  test("put and get round-trip a strict Receipt", () => {
    const fixture = createStore();
    const receipt = makeReceipt("run-1", "receipt-1");

    fixture.store.put(receipt);

    expect(fixture.store.get(receipt.body.runId)).toEqual(receipt);
  });

  test("get returns null for an unknown run id", () => {
    expect(createStore().store.get("run-missing")).toBeNull();
  });

  test("getByReceiptId finds the receipt without making receiptId a file key", () => {
    const fixture = createStore();
    const receipt = makeReceipt("run-lookup", "receipt-lookup");
    fixture.store.put(receipt);

    expect(fixture.store.getByReceiptId("receipt-lookup")).toEqual(receipt);
    expect(fixture.store.getByReceiptId("receipt-missing")).toBeNull();
  });

  test("list returns newest receipts first and respects limit", () => {
    const fixture = createStore();
    const older = makeReceipt("run-older", "receipt-older", "2026-07-16T00:00:01.000Z");
    const newer = makeReceipt("run-newer", "receipt-newer", "2026-07-16T00:00:02.000Z");
    fixture.store.put(older);
    fixture.store.put(newer);

    expect(fixture.store.list()).toEqual([newer, older]);
    expect(fixture.store.list({ limit: 1 })).toEqual([newer]);
  });

  test("list skips a malformed receipt file without hiding valid receipts", () => {
    const fixture = createStore();
    const receipt = makeReceipt("run-valid", "receipt-valid");
    fixture.store.put(receipt);
    writeFileSync(join(fixture.directory, "run-malformed.receipt.json"), "{not-json", { mode: 0o600 });

    expect(fixture.store.list()).toEqual([receipt]);
  });

  test("receipt files are owner-only", () => {
    const fixture = createStore();
    const receipt = makeReceipt("run-private", "receipt-private");
    fixture.store.put(receipt);

    expect(statSync(join(fixture.directory, "run-private.receipt.json")).mode & 0o777).toBe(0o600);
  });
});

function createStore() {
  const root = mkdtempSync(join(tmpdir(), "headless-receipt-store-"));
  temporaryPaths.push(root);
  const directory = join(root, "receipts");
  return { directory, store: new ReceiptStore(directory) };
}

function makeReceipt(runId: string, receiptId: string, endedAt = "2026-07-16T00:00:01.234Z"): Receipt {
  const body = ReceiptBodySchema.parse({
    receiptId,
    runId,
    sessionId: null,
    projectId: "a".repeat(64),
    principal: "user:alice",
    request: {
      backend: "codex",
      mode: "read-only",
      model: null,
      agent: null,
      timeoutMs: 180_000,
      containment: "required",
      authMode: "broker",
      approvalPolicy: "ask",
      prompt: { digest: "b".repeat(64), bytes: 12, preview: "do the thing" },
    },
    result: {
      status: "succeeded",
      error: null,
      exitCode: 0,
      signal: null,
      usage: { input: 10, output: 20, reasoning: null, cached: null, providerTotal: 30 },
      cost: { amountUsd: null, source: "unknown", pricingId: null, observedRequests: 0 },
      containment: {
        requirement: "required",
        enforced: true,
        platform: "darwin",
        mechanism: "seatbelt",
        probe: null,
        isolatedHome: true,
        credentialsIsolated: true,
        network: "broker-only",
        credentialAccess: "none",
        unsafe: false,
      },
      durationMs: 1_234,
      truncation: { stdout: false, stderr: false, output: false, events: false, artifacts: false, diff: false },
      output: { digest: "c".repeat(64), bytes: 4, preview: "done" },
      diff: null,
    },
    policyTrail: [{ decision: "allowed", rule: "read-only", reason: "read-only run permitted" }],
    authorization: { source: "root", mergeAllowed: false, maxCostUsd: null, grantId: null, grantTerms: null, finality: null },
    brokerLease: null,
    gates: [],
    budget: {
      passed: true,
      reasons: [],
      usage: { input: 10, output: 20, reasoning: null, cached: null, providerTotal: 30 },
      cost: { amountUsd: null, source: "unknown", pricingId: null, observedRequests: 0 },
      reservationId: null,
    },
    provenance: {
      startedAt: "2026-07-16T00:00:00.000Z",
      endedAt,
      headlessVersion: "0.2.0-beta.1",
      platform: "darwin",
      commit: null,
      backendVersion: null,
    },
  });
  return ReceiptSchema.parse({
    version: 1,
    body,
    sectionDigests: receiptSectionDigests(body),
    integrity: {
      selfDigest: receiptSelfDigest(body),
      ledgerAnchor: { projectId: body.projectId, sequence: 7, hash: "d".repeat(64) },
    },
  });
}
