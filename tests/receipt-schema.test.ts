import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ReceiptBodySchema, ReceiptSchema, decodePersistedReceipt, type ReceiptBody } from "../src/contracts/receipt";
import { canonicalReceiptJson, receiptSectionDigests, receiptSelfDigest, sha256Hex } from "../src/runtime/receipt-canonical";
import { findReceiptAnchor, parseReceiptAnchor, receiptAnchorArtifact, type ReceiptAnchor } from "../src/runtime/receipt-anchor";
import type { LedgerRecordV2 } from "../src/runtime/ledger-v2";

function bodyInput(overrides: Record<string, unknown> = {}) {
  return {
    receiptId: "receipt-1",
    runId: "job-1",
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
      endedAt: "2026-07-16T00:00:01.234Z",
      headlessVersion: "0.2.0-beta.1",
      platform: "darwin",
      commit: null,
      backendVersion: null,
    },
    ...overrides,
  };
}

function makeBody(overrides: Record<string, unknown> = {}): ReceiptBody {
  return ReceiptBodySchema.parse(bodyInput(overrides));
}

function makeReceipt(body: ReceiptBody) {
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

function sampleAnchor(overrides: Partial<ReceiptAnchor> = {}): ReceiptAnchor {
  return {
    version: 1,
    receiptId: "receipt-1",
    runId: "job-1",
    sha256: "e".repeat(64),
    mode: "read-only",
    status: "succeeded",
    provenance: {
      generatedAt: "2026-07-16T00:00:01.234Z",
      headlessVersion: "0.2.0-beta.1",
      platform: "darwin",
      commit: null,
    },
    ...overrides,
  };
}

function anchorRecord(anchor: ReceiptAnchor, sequence: number): LedgerRecordV2 {
  return {
    version: 2,
    sequence,
    timestamp: 0,
    projectId: "a".repeat(64),
    principal: "user:alice",
    eventId: randomUUID(),
    previousHash: null,
    integrity: { algorithm: "sha256", keyId: null },
    type: "artifact",
    payload: { event: { artifact: receiptAnchorArtifact(anchor) } },
    hash: "0".repeat(64),
  } as LedgerRecordV2;
}

describe("canonicalReceiptJson", () => {
  test("is key-order independent for objects", () => {
    expect(canonicalReceiptJson({ b: 1, a: 2 })).toBe(canonicalReceiptJson({ a: 2, b: 1 }));
    expect(canonicalReceiptJson({ b: 1, a: 2 })).toBe(`{"a":2,"b":1}`);
  });
  test("preserves array order", () => {
    expect(canonicalReceiptJson([1, 2])).not.toBe(canonicalReceiptJson([2, 1]));
  });
  test("sorts nested keys recursively", () => {
    expect(canonicalReceiptJson({ z: { b: 1, a: 2 } })).toBe(`{"z":{"a":2,"b":1}}`);
  });
  test("drops undefined members", () => {
    expect(canonicalReceiptJson({ a: 1, b: undefined })).toBe(`{"a":1}`);
  });
  test("rejects non-finite numbers", () => {
    expect(() => canonicalReceiptJson({ a: Number.POSITIVE_INFINITY })).toThrow();
  });
});

describe("receipt digests", () => {
  test("self-digest equals sha256 of the canonical body and is stable", () => {
    const body = makeBody();
    expect(receiptSelfDigest(body)).toBe(sha256Hex(canonicalReceiptJson(body)));
    expect(receiptSelfDigest(makeBody())).toBe(receiptSelfDigest(body));
  });
  test("self-digest changes when any body field changes", () => {
    expect(receiptSelfDigest(makeBody({ runId: "job-2" }))).not.toBe(receiptSelfDigest(makeBody()));
  });
  test("section digests localize a change to a single section", () => {
    const body = makeBody();
    const before = receiptSectionDigests(body);
    const after = receiptSectionDigests(makeBody({ result: { ...body.result, durationMs: 9_999 } }));
    expect(after.result).not.toBe(before.result);
    expect(after.request).toBe(before.request);
    expect(after.authorization).toBe(before.authorization);
    expect(after.provenance).toBe(before.provenance);
  });
});

describe("ReceiptSchema", () => {
  test("parses a well-formed receipt and rejects unknown keys", () => {
    const receipt = makeReceipt(makeBody());
    expect(receipt.version).toBe(1);
    expect(() => ReceiptSchema.parse({ ...receipt, extra: true })).toThrow();
  });
  test("decodePersistedReceipt round-trips a v1 receipt and rejects a future version", () => {
    const receipt = makeReceipt(makeBody());
    expect(decodePersistedReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
    expect(() => decodePersistedReceipt({ version: 2 })).toThrow();
  });
});

describe("receipt authorization invariants", () => {
  const grantTerms = { operations: ["run", "write"], backends: ["codex"], expiresAt: 1_800_000_000_000, maxCostUsd: 5, maxIterations: 3 };
  test("a grant authorization requires grantId and grantTerms", () => {
    expect(() => makeBody({ authorization: { source: "grant", mergeAllowed: true, maxCostUsd: 5, grantId: "grant-1", grantTerms, finality: null } })).not.toThrow();
    expect(() => makeBody({ authorization: { source: "grant", mergeAllowed: true, maxCostUsd: 5, grantId: null, grantTerms, finality: null } })).toThrow();
    expect(() => makeBody({ authorization: { source: "grant", mergeAllowed: true, maxCostUsd: 5, grantId: "grant-1", grantTerms: null, finality: null } })).toThrow();
  });
  test("root/foreground_lead authorization must not carry grant fields", () => {
    expect(() => makeBody({ authorization: { source: "root", mergeAllowed: true, maxCostUsd: null, grantId: "grant-1", grantTerms: null, finality: null } })).toThrow();
    expect(() => makeBody({ authorization: { source: "foreground_lead", mergeAllowed: false, maxCostUsd: null, grantId: null, grantTerms, finality: null } })).toThrow();
  });
});

describe("receipt broker lease snapshot", () => {
  const brokerLease = {
    provider: "openai",
    models: ["gpt-5"],
    endpointClasses: ["responses"],
    expiresAt: 1_800_000_000_000,
    maxRequests: 100,
    maxBodyBytes: 1_000_000,
    maxConcurrentRequests: 4,
    maxInFlightBodyBytes: 4_000_000,
    maxStreamMs: 600_000,
    maxCostUsd: 5,
    quotas: [{ id: "quota-1", maxRequests: 100, maxInputTokens: 1_000_000, maxOutputTokens: 200_000, maxCostUsd: 5 }],
    scopeDigest: "f".repeat(64),
  };
  test("parses a redacted lease snapshot", () => {
    expect(() => makeBody({ brokerLease })).not.toThrow();
  });
  test("rejects bearer/credential material by construction (strict schema)", () => {
    expect(() => makeBody({ brokerLease: { ...brokerLease, token: "hls_secret" } })).toThrow();
    expect(() => makeBody({ brokerLease: { ...brokerLease, baseUrl: "https://broker/openai" } })).toThrow();
  });
  test("changes the brokerLease section digest vs a null lease", () => {
    expect(receiptSectionDigests(makeBody({ brokerLease })).brokerLease).not.toBe(receiptSectionDigests(makeBody()).brokerLease);
  });
});

describe("receipt gate manifest", () => {
  test("parses bounded gate entries and enforces the ceiling", () => {
    const gate = { phase: "candidate", name: "check", status: "passed", definitionDigest: "1".repeat(64), evidenceDigest: "2".repeat(64) };
    expect(() => makeBody({ gates: [gate] })).not.toThrow();
    expect(() => makeBody({ gates: Array.from({ length: 65 }, () => gate) })).toThrow();
  });
});

describe("receipt anchor", () => {
  test("artifact marker round-trips through parseReceiptAnchor", () => {
    const anchor = sampleAnchor();
    const artifact = receiptAnchorArtifact(anchor);
    expect(artifact.kind).toBe("execution_receipt");
    expect(artifact.status).toBe("passed");
    expect(parseReceiptAnchor(artifact.evidence)).toEqual(anchor);
  });
  test("a non-succeeded run maps to a failed artifact status", () => {
    expect(receiptAnchorArtifact(sampleAnchor({ status: "failed" })).status).toBe("failed");
  });
  test("findReceiptAnchor returns the latest record for a receiptId", () => {
    const records = [
      anchorRecord(sampleAnchor({ sha256: "1".repeat(64) }), 3),
      anchorRecord(sampleAnchor({ sha256: "2".repeat(64) }), 9),
      anchorRecord(sampleAnchor({ receiptId: "receipt-other" }), 11),
    ];
    const found = findReceiptAnchor(records, "receipt-1");
    expect(found?.sequence).toBe(9);
    expect(found?.anchor.sha256).toBe("2".repeat(64));
    expect(findReceiptAnchor(records, "receipt-missing")).toBeNull();
  });
  test("parseReceiptAnchor requires exactly one marker", () => {
    expect(parseReceiptAnchor([])).toBeNull();
    expect(parseReceiptAnchor(["not-a-marker"])).toBeNull();
    const marker = receiptAnchorArtifact(sampleAnchor()).evidence[0];
    expect(parseReceiptAnchor([marker, marker])).toBeNull();
  });
});
