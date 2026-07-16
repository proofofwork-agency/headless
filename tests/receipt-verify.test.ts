import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReceiptBodySchema, ReceiptSchema, type Receipt } from "../src/contracts/receipt";
import { LedgerV2, type LedgerRecordV2 } from "../src/runtime/ledger-v2";
import { receiptAnchorArtifact } from "../src/runtime/receipt-anchor";
import { receiptSectionDigests, receiptSelfDigest } from "../src/runtime/receipt-canonical";
import {
  ExportedReceiptSchema,
  verifyExportedReceipt,
  verifyReceipt,
  verifyReceiptAgainstLedger,
  verifyReceiptSelfDigest,
} from "../src/runtime/receipt-verify";

const roots: string[] = [];
let fixtureId = 0;

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("receipt verification", () => {
  test("verifies the self-digest and localizes a changed result section", () => {
    const { receipt } = fixture();
    expect(verifyReceiptSelfDigest(receipt)).toEqual({ ok: true });

    const tampered = mutateResult(receipt);
    expect(verifyReceiptSelfDigest(tampered)).toEqual({
      ok: false,
      failingSection: "result",
      reason: "Receipt section digest mismatch in section result.",
    });
  });

  test("rejects doctored section digests even when the body self-digest is intact", () => {
    const { receipt } = fixture();
    const tampered = {
      ...receipt,
      sectionDigests: { ...receipt.sectionDigests, result: "f".repeat(64) },
    } as Receipt;

    expect(verifyReceiptSelfDigest(tampered)).toEqual({
      ok: false,
      failingSection: "result",
      reason: "Receipt section digest mismatch in section result.",
    });
  });

  test("verifies a receipt against its complete matching ledger", () => {
    const { receipt, ledger } = fixture();
    expect(verifyReceipt({ receipt, records: ledger.readAll() })).toMatchObject({
      ok: true,
      ledger: { ok: true, recordsChecked: 1 },
      anchor: { ok: true },
      selfDigest: { ok: true },
    });
  });

  test("fails at the anchor when its persisted record no longer matches", () => {
    const { receipt, anchorRecord } = fixture();
    const changed = { ...anchorRecord, hash: "f".repeat(64) } as LedgerRecordV2;
    expect(verifyReceiptAgainstLedger(receipt, [changed])).toEqual({
      ok: false,
      reason: "Ledger anchor hash does not match the receipt.",
    });
  });

  test("fails the full verdict when a later ledger record breaks the chain", () => {
    const { receipt, ledger } = fixture();
    ledger.append("tail", { value: 1 });
    const records = ledger.readAll();
    const broken = records.map((record, index) => index === 1
      ? { ...record, payload: { value: 2 } }
      : record) as LedgerRecordV2[];

    expect(verifyReceipt({ receipt, records: broken })).toMatchObject({
      ok: false,
      ledger: { ok: false, firstBreakAt: { sequence: 2, reason: expect.stringContaining("Hash mismatch") } },
      anchor: { ok: true },
      selfDigest: { ok: true },
    });
  });
});

describe("exported receipt verification", () => {
  test("re-hashes an unkeyed embedded record offline and detects body tampering", () => {
    const clean = fixture();
    const exported = exportedReceipt(clean.receipt, clean.anchorRecord, clean.ledger.readAll());
    expect(verifyExportedReceipt(exported)).toMatchObject({
      ok: true,
      assurance: "embedded-record",
      selfDigest: { ok: true },
      anchor: "verified",
      ledger: { status: "not-provided" },
    });

    const tampered = ExportedReceiptSchema.parse({ ...exported, receipt: mutateResult(clean.receipt) });
    expect(verifyExportedReceipt(tampered)).toMatchObject({
      ok: false,
      assurance: "failed",
      selfDigest: { ok: false, failingSection: "result" },
      anchor: "failed",
    });
  });

  test("reports an embedded HMAC record as unverified without its key", () => {
    const hmac = fixture({ hmac: true });
    const exported = exportedReceipt(hmac.receipt, hmac.anchorRecord, hmac.ledger.readAll());
    expect(verifyExportedReceipt(exported)).toMatchObject({
      ok: true,
      assurance: "structural-only",
      selfDigest: { ok: true },
      anchor: "embedded-unverified",
      ledger: { status: "not-provided" },
      reason: expect.stringContaining("requires the live ledger and verification key"),
    });
  });

  test("upgrades an export to full proof against the matching live chain", () => {
    const hmac = fixture({ hmac: true });
    hmac.ledger.append("tail", { value: 1 });
    const records = hmac.ledger.readAll();
    const exported = exportedReceipt(hmac.receipt, hmac.anchorRecord, records);
    expect(verifyExportedReceipt(exported, {
      records,
      hmacKey: hmac.hmacKey,
      hmacKeyId: hmac.hmacKeyId,
    })).toMatchObject({
      ok: true,
      assurance: "full-chain",
      anchor: "verified",
      ledger: { status: "verified", verdict: { ok: true, recordsChecked: 2 } },
    });
  });
});

function fixture(options: { hmac?: boolean } = {}) {
  fixtureId += 1;
  const root = mkdtempSync(join(tmpdir(), "headless-receipt-verify-"));
  roots.push(root);
  const projectId = "a".repeat(64);
  const hmacKey = "receipt-verification-key-material";
  const hmacKeyId = "receipt-test-key";
  const ledger = new LedgerV2({
    ledgerPath: join(root, "ledger.jsonl"),
    readModelPath: join(root, "ledger-read.json"),
    projectId,
    principal: "user:auditor",
    ...(options.hmac ? { hmacKey, hmacKeyId } : {}),
  });
  const body = ReceiptBodySchema.parse({
    receiptId: `receipt-${fixtureId}`,
    runId: `run-${fixtureId}`,
    sessionId: null,
    projectId,
    principal: "user:auditor",
    request: {
      backend: "codex",
      mode: "read-only",
      model: null,
      agent: null,
      timeoutMs: 30_000,
      containment: "required",
      authMode: "broker",
      approvalPolicy: "ask",
      prompt: { digest: "b".repeat(64), bytes: 4, preview: "work" },
    },
    result: {
      status: "succeeded",
      error: null,
      exitCode: 0,
      signal: null,
      usage: { input: 1, output: 2, reasoning: null, cached: null, providerTotal: 3 },
      cost: { amountUsd: null, source: "unknown", pricingId: null, observedRequests: 0 },
      containment: {
        requirement: "required",
        enforced: true,
        platform: "other",
        mechanism: "fixture",
        probe: null,
        isolatedHome: true,
        credentialsIsolated: true,
        network: "broker-only",
        credentialAccess: "none",
        unsafe: false,
      },
      durationMs: 10,
      truncation: { stdout: false, stderr: false, output: false, events: false, artifacts: false, diff: false },
      output: { digest: "c".repeat(64), bytes: 4, preview: "done" },
      diff: null,
    },
    policyTrail: [],
    authorization: { source: "root", mergeAllowed: false, maxCostUsd: null, grantId: null, grantTerms: null, finality: null },
    brokerLease: null,
    gates: [],
    budget: {
      passed: true,
      reasons: [],
      usage: { input: 1, output: 2, reasoning: null, cached: null, providerTotal: 3 },
      cost: { amountUsd: null, source: "unknown", pricingId: null, observedRequests: 0 },
      reservationId: null,
    },
    provenance: {
      startedAt: "2026-07-16T00:00:00.000Z",
      endedAt: "2026-07-16T00:00:00.010Z",
      headlessVersion: "0.2.0-beta.1",
      platform: "test",
      commit: null,
      backendVersion: "fixture 1.0.0",
    },
  });
  const selfDigest = receiptSelfDigest(body);
  const anchorRecord = ledger.append("artifact", {
    event: {
      artifact: receiptAnchorArtifact({
        version: 1,
        receiptId: body.receiptId,
        runId: body.runId,
        sha256: selfDigest,
        mode: body.request.mode,
        status: body.result.status,
        provenance: {
          generatedAt: body.provenance.endedAt,
          headlessVersion: body.provenance.headlessVersion,
          platform: body.provenance.platform,
          commit: body.provenance.commit,
        },
      }),
    },
  });
  const receipt = ReceiptSchema.parse({
    version: 1,
    body,
    sectionDigests: receiptSectionDigests(body),
    integrity: {
      selfDigest,
      ledgerAnchor: { projectId, sequence: anchorRecord.sequence, hash: anchorRecord.hash },
    },
  });
  return { ledger, receipt, anchorRecord, hmacKey, hmacKeyId };
}

function mutateResult(receipt: Receipt) {
  return ReceiptSchema.parse({
    ...receipt,
    body: {
      ...receipt.body,
      result: { ...receipt.body.result, durationMs: receipt.body.result.durationMs + 1 },
    },
  });
}

function exportedReceipt(receipt: Receipt, anchorRecord: LedgerRecordV2, records: readonly LedgerRecordV2[]) {
  const head = records.at(-1)!;
  return ExportedReceiptSchema.parse({
    receipt,
    anchorRecord,
    exportEnvelope: {
      exportedAt: "2026-07-16T01:00:00.000Z",
      exporterVersion: "0.2.0-beta.1",
      ledgerHead: { sequence: head.sequence, hash: head.hash },
    },
  });
}
