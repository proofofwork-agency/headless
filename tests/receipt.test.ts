import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerBackendDefinition, unregisterBackendDefinition, type BackendDefinition } from "../src/backends/registry";
import { RECEIPT_POLICY_REASON_MAX, RECEIPT_PREVIEW_MAX } from "../src/contracts/receipt";
import type { Job } from "../src/contracts/durable";
import { HeadlessDaemonClient } from "../src/daemon/client";
import { HeadlessDaemon } from "../src/daemon/server";
import { RunEventStore } from "../src/daemon/run-event-store";
import { clearRuntimeDiagnostics, listRuntimeDiagnostics } from "../src/runtime/diagnostics";
import type { AuthorityStore } from "../src/runtime/authority-store";
import { runGitStrict } from "../src/runtime/git";
import { LedgerRecordV2Schema, ledgerIntegrityOptionsFromEnv, verifyLedgerChain } from "../src/runtime/ledger-v2";
import { findReceiptAnchor, parseReceiptAnchorRecord, RECEIPT_ANCHOR_ARTIFACT_KIND } from "../src/runtime/receipt-anchor";
import { sha256Hex } from "../src/runtime/receipt-canonical";
import { ReceiptJournal } from "../src/runtime/receipt-journal";
import { ReceiptStore } from "../src/runtime/receipt-store";
import {
  assembleAndAnchorReceipt,
  RECEIPT_GAP_ARTIFACT_KIND,
  recordReceiptGap,
  receiptAnchorEventId,
  receiptBrokerLeaseSnapshot,
  receiptIdForRun,
} from "../src/runtime/receipt-service";

setDefaultTimeout(45_000);

const roots: string[] = [];
const runtimes: string[] = [];
const adapters: string[] = [];
const daemons: HeadlessDaemon[] = [];
let fixtureNumber = 0;

afterEach(async () => {
  while (daemons.length) await daemons.pop()!.stop().catch(() => {});
  while (adapters.length) unregisterBackendDefinition(adapters.pop()!);
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
  while (runtimes.length) rmSync(runtimes.pop()!, { recursive: true, force: true });
  clearRuntimeDiagnostics();
});

describe("terminal execution receipts", () => {
  test("projects broker authority into a token-free immutable cap envelope", () => {
    const snapshot = receiptBrokerLeaseSnapshot({
      runId: "run-one",
      provider: "openai",
      models: ["gpt-5"],
      endpointClasses: ["responses"],
      expiresAt: Date.now() + 60_000,
      maxRequests: 4,
      maxBodyBytes: 1_000_000,
      maxConcurrentRequests: 2,
      maxInFlightBodyBytes: 2_000_000,
      maxStreamMs: 30_000,
      maxCostUsd: 2,
      budgetQuotas: [{
        id: "quota-one",
        maxRequests: 4,
        usedRequests: 3,
        maxInputTokens: 1_000,
        usedInputTokens: 200,
        maxOutputTokens: 500,
        usedOutputTokens: 50,
        maxCostUsd: 2,
        usedCostUsd: 0.5,
      }],
    });
    expect(snapshot).toMatchObject({
      provider: "openai",
      maxRequests: 4,
      quotas: [{ id: "quota-one", maxRequests: 4, maxInputTokens: 1_000, maxOutputTokens: 500, maxCostUsd: 2 }],
      scopeDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(snapshot)).not.toContain("usedRequests");
    expect(JSON.stringify(snapshot)).not.toContain("usedCostUsd");
    expect(JSON.stringify(snapshot)).not.toContain("token");
  });

  test("anchors a read-only receipt and resolves provenance once per daemon", async () => {
    const fixture = createFixture();
    const { daemon, client } = await startFixture(fixture);

    const first = await run(client, fixture.backend, "first read");
    const second = await run(client, fixture.backend, "second read");
    expect(first.result?.status).toBe("succeeded");
    expect(second.result?.status).toBe("succeeded");

    const store = new ReceiptStore(daemon.state.receiptsDir);
    const receipt = store.get(first.id);
    expect(receipt, JSON.stringify(listRuntimeDiagnostics())).not.toBeNull();
    const anchorSequence = receipt!.integrity.ledgerAnchor.sequence;
    expect(receipt).toMatchObject({
      body: {
        runId: first.id,
        request: { mode: "read-only", prompt: { bytes: 10 } },
        authorization: { source: "root" },
        gates: [],
        provenance: { commit: "a".repeat(40), backendVersion: "receipt-fixture 1.0.0" },
      },
      integrity: { ledgerAnchor: { projectId: daemon.state.projectId, sequence: expect.any(Number), hash: expect.any(String) } },
    });
    expect(Number.isSafeInteger(anchorSequence) && anchorSequence > 0).toBe(true);
    expect(store.get(second.id)?.body.provenance).toMatchObject({
      commit: receipt!.body.provenance.commit,
      backendVersion: receipt!.body.provenance.backendVersion,
    });
    expect(readFileSync(daemon.state.ledgerPath, "utf8")).toContain(RECEIPT_ANCHOR_ARTIFACT_KIND);
    expect(verifyLedgerChain({
      ledgerPath: daemon.state.ledgerPath,
      projectId: daemon.state.projectId,
      ...ledgerIntegrityOptionsFromEnv(fixture.state.env),
    })).toMatchObject({ ok: true });
  });

  test("stores and anchors receipts whose output exceeds the preview bound", async () => {
    const fixture = createFixture();
    const { daemon, client } = await startFixture(fixture);
    const completed = await run(client, fixture.backend, "x".repeat(RECEIPT_PREVIEW_MAX + 1_000));

    expect(completed.result?.status).toBe("succeeded");
    expect(completed.result!.output.length).toBeGreaterThan(RECEIPT_PREVIEW_MAX);
    const receipt = new ReceiptStore(daemon.state.receiptsDir).get(completed.id);
    expect(receipt, JSON.stringify(listRuntimeDiagnostics())).not.toBeNull();
    expect(receipt!.body.request.prompt.preview.length).toBeLessThanOrEqual(RECEIPT_PREVIEW_MAX);
    expect(receipt!.body.result.output.preview.length).toBeLessThanOrEqual(RECEIPT_PREVIEW_MAX);
    expect(readFileSync(daemon.state.ledgerPath, "utf8")).toContain(RECEIPT_ANCHOR_ARTIFACT_KIND);
  });

  test("hard-bounds an oversized preview carrying an existing truncation marker", async () => {
    const fixture = createFixture();
    const { daemon, client } = await startFixture(fixture);
    const alreadyTruncated = `${"y".repeat(RECEIPT_PREVIEW_MAX + 1_000)}\n[TRUNCATED 1000 chars]`;
    const completed = await run(client, fixture.backend, alreadyTruncated);

    expect(completed.result?.status).toBe("succeeded");
    const receipt = new ReceiptStore(daemon.state.receiptsDir).get(completed.id);
    expect(receipt, JSON.stringify(listRuntimeDiagnostics())).not.toBeNull();
    expect(receipt!.body.request.prompt.preview.length).toBeLessThanOrEqual(RECEIPT_PREVIEW_MAX);
    expect(receipt!.body.request.prompt.preview).toEndWith("[TRUNCATED]");
  });

  test("bounds a maximum-size policy reason after receipt redaction", async () => {
    const fixture = createFixture();
    const { daemon, client } = await startFixture(fixture);
    const submitted = await client.call<Job>("run.submit", {
      backend: fixture.backend,
      prompt: "delay-policy-receipt",
      containment: "unsafe",
      authMode: "broker",
      timeoutMs: 15_000,
    });
    const internal = daemon as unknown as { runEvents: RunEventStore };
    internal.runEvents.append({ jobId: submitted.id, sessionId: null }, {
      kind: "policy",
      decision: "allowed",
      rule: "maximum-policy-reason",
      reason: "p".repeat(RECEIPT_POLICY_REASON_MAX),
    });
    const completed = await client.call<Job>("run.wait", { jobId: submitted.id, timeoutMs: 30_000 }, 35_000);

    expect(completed.result?.status).toBe("succeeded");
    const receipt = new ReceiptStore(daemon.state.receiptsDir).get(completed.id);
    const policy = receipt?.body.policyTrail.find((entry) => entry.rule === "maximum-policy-reason");
    expect(receipt, JSON.stringify(listRuntimeDiagnostics())).not.toBeNull();
    expect(policy?.reason.length).toBeLessThanOrEqual(RECEIPT_POLICY_REASON_MAX);
    expect(policy?.reason).toContain("TRUNCATED");
  });

  test("captures write authorization, bounded gates, and the integrated diff digest", async () => {
    const fixture = createFixture();
    const { daemon, client } = await startFixture(fixture);
    const completed = await run(client, fixture.backend, "write receipt", {
      mode: "write",
      containment: "required",
      approvalPolicy: "auto",
    });

    expect(completed.result).toMatchObject({ status: "succeeded", commit: { merged: true } });
    const receipt = new ReceiptStore(daemon.state.receiptsDir).get(completed.id);
    expect(receipt?.body.authorization).toMatchObject({ source: "root", mergeAllowed: true });
    expect(receipt?.body.gates.length).toBeGreaterThan(0);
    expect(receipt?.body.gates[0]).toMatchObject({
      phase: "candidate",
      name: "receipt-check",
      status: "passed",
      definitionDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(receipt?.body.result.diff).toMatchObject({
      digest: sha256Hex(completed.result!.diff!.patch),
      files: expect.arrayContaining(["receipt-change.txt"]),
    });
    expect(existsSync(join(fixture.project, "receipt-change.txt"))).toBe(true);
  });

  test("does not attest a run denied at its execution authorization checkpoint", async () => {
    const fixture = createFixture();
    const { daemon, client } = await startFixture(fixture);
    const internal = daemon as unknown as { authority: AuthorityStore };
    const authorize = internal.authority.authorize.bind(internal.authority);
    let runAuthorizations = 0;
    internal.authority.authorize = ((input) => {
      const decision = authorize(input);
      if (input.operation === "run" && ++runAuthorizations === 2) {
        return {
          allowed: false,
          root: false,
          grantId: null,
          mergeAllowed: false,
          maxCostUsd: null,
          reason: "execution checkpoint denied by test policy",
        };
      }
      return decision;
    }) as AuthorityStore["authorize"];
    clearRuntimeDiagnostics();

    const completed = await run(client, fixture.backend, "authorization denied");

    expect(completed.result).toMatchObject({
      status: "blocked",
      error: { code: "POLICY_DENIED", message: "execution checkpoint denied by test policy" },
    });
    expect(new ReceiptStore(daemon.state.receiptsDir).get(completed.id)).toBeNull();
    const ledgerText = existsSync(daemon.state.ledgerPath) ? readFileSync(daemon.state.ledgerPath, "utf8") : "";
    expect(ledgerText).not.toContain(RECEIPT_ANCHOR_ARTIFACT_KIND);
    expect(verifyLedgerChain({
      ledgerPath: daemon.state.ledgerPath,
      projectId: daemon.state.projectId,
      ...ledgerIntegrityOptionsFromEnv(fixture.state.env),
    })).toMatchObject({ ok: true });
    expect(listRuntimeDiagnostics().some((entry) => entry.scope.startsWith("receipt."))).toBe(false);
  });

  test("survives bounded RunEventStore compaction in its separate store", async () => {
    const fixture = createFixture();
    const { daemon, client } = await startFixture(fixture);
    const completed = await run(client, fixture.backend, "compact events");
    const receiptBefore = new ReceiptStore(daemon.state.receiptsDir).get(completed.id);
    expect(receiptBefore).not.toBeNull();

    const internal = daemon as unknown as { runEvents: RunEventStore };
    for (let index = 0; index < 20; index += 1) {
      internal.runEvents.append({ jobId: `flood-${index}` }, { kind: "stdout", text: "x".repeat(1_000), truncated: false });
    }
    await daemon.stop();
    daemons.splice(daemons.indexOf(daemon), 1);
    const compacted = new RunEventStore(daemon.state.runEventsPath, { maxEvents: 1, compactOnOpen: true });
    expect(compacted.snapshot().events.length).toBeLessThanOrEqual(1);
    expect(new ReceiptStore(daemon.state.receiptsDir).get(completed.id)).toEqual(receiptBefore);
  });

  test("recovers one pending terminal receipt exactly once across restarts", async () => {
    const fixture = createFixture();
    fixture.state.env.HEADLESS_RECEIPTS = "off";
    const { daemon, client } = await startFixture(fixture);
    const completed = await run(client, fixture.backend, "recover pending receipt");
    const request = daemon.jobs.request(completed.id)!;
    expect(new ReceiptStore(daemon.state.receiptsDir).get(completed.id)).toBeNull();
    await stopTracked(daemon);

    const journal = new ReceiptJournal(daemon.state);
    journal.pending(receiptJournalIntent(completed, "b".repeat(40)));
    fixture.state.env.HEADLESS_RECEIPTS = "on";
    const recovered = await restartFixture(fixture);
    const receipt = new ReceiptStore(recovered.state.receiptsDir).get(completed.id);
    expect(receipt?.body.provenance.commit).toBe("b".repeat(40));
    expect(await new HeadlessDaemonClient({
      projectRoot: fixture.project,
      state: fixture.state,
      token: "r".repeat(48),
    }).call<{ ok: boolean }>("receipt.verify", { runId: completed.id })).toMatchObject({ ok: true });
    expect(anchorRecords(recovered.state.ledgerPath, completed.id)).toHaveLength(1);
    expect(journal.get(completed.id)?.state).toBe("completed");

    await stopTracked(recovered);
    const second = await restartFixture(fixture);
    expect(anchorRecords(second.state.ledgerPath, completed.id)).toHaveLength(1);
    expect(new ReceiptStore(second.state.receiptsDir).get(completed.id)).toEqual(receipt);
  });

  test("turns a mismatched dangling anchor into an explicit non-anchor gap", async () => {
    const fixture = createFixture();
    fixture.state.env.HEADLESS_RECEIPTS = "off";
    const { daemon, client } = await startFixture(fixture);
    const completed = await run(client, fixture.backend, "dangling receipt anchor");
    const request = daemon.jobs.request(completed.id)!;
    await stopTracked(daemon);

    const journal = new ReceiptJournal(daemon.state);
    const intent = receiptJournalIntent(completed, "b".repeat(40));
    journal.pending(intent);
    expect(() => assembleAndAnchorReceipt({
      paths: daemon.state,
      stateOptions: fixture.state,
      receipts: { put: () => { throw new Error("simulated crash after receipt anchor"); } },
      provenance: journalProvenance(request.backend, intent.provenance),
    }, {
      jobId: completed.id,
      sessionId: completed.sessionId,
      principal: completed.principal,
      request,
      result: completed.result!,
      policyEvents: new RunEventStore(daemon.state.runEventsPath, { compactOnOpen: false })
        .snapshot({ jobId: completed.id, limit: 1_000 }).events,
      authorization: intent.authorization!,
      brokerLease: intent.brokerLease,
      gates: intent.gates,
      budget: intent.budget,
      startedAt: intent.startedAt!,
      endedAt: completed.updatedAt,
    })).toThrow("simulated crash");
    const markerPath = join(journal.directory, `${completed.id}.json`);
    const mutated = JSON.parse(readFileSync(markerPath, "utf8"));
    mutated.provenance.commit = "c".repeat(40);
    writeFileSync(markerPath, `${JSON.stringify(mutated)}\n`, { mode: 0o600 });

    fixture.state.env.HEADLESS_RECEIPTS = "on";
    clearRuntimeDiagnostics();
    const recovered = await restartFixture(fixture);
    expect(new ReceiptStore(recovered.state.receiptsDir).get(completed.id)).toBeNull();
    expect(journal.get(completed.id)).toMatchObject({ state: "gap", gapReason: expect.stringContaining("replay mismatch") });
    const records = ledgerRecords(recovered.state.ledgerPath);
    const gap = records.find((record) => (
      (record.payload.event as { artifact?: { kind?: string } } | undefined)?.artifact?.kind === RECEIPT_GAP_ARTIFACT_KIND
    ));
    expect(gap).toBeDefined();
    expect(parseReceiptAnchorRecord(gap!)).toBeNull();
    expect(findReceiptAnchor(records, receiptIdForRun(completed.id))?.anchor.runId).toBe(completed.id);
    expect(listRuntimeDiagnostics()).toContainEqual(expect.objectContaining({
      scope: `daemon.start.receipt:${completed.id}`,
      message: expect.stringContaining("replay mismatch"),
    }));
  });

  test("keeps a pending marker when verifier-only HMAC state cannot append receipt or gap", async () => {
    const fixture = createFixture();
    const key = "receipt-hmac-key-material-00000001";
    fixture.state.env.HEADLESS_RECEIPTS = "off";
    fixture.state.env.HEADLESS_LEDGER_KEY = key;
    fixture.state.env.HEADLESS_LEDGER_KEY_ID = "receipt-test-key";
    const { daemon, client } = await startFixture(fixture);
    const completed = await run(client, fixture.backend, "hmac receipt recovery");
    recordReceiptGap({ paths: daemon.state, stateOptions: fixture.state }, {
      jobId: "hmac-history-seed",
      sessionId: null,
      principal: "receipt-hmac-seed",
      reason: "seed signed history",
    });
    await stopTracked(daemon);
    const journal = new ReceiptJournal(daemon.state);
    journal.pending(receiptJournalIntent(completed, "b".repeat(40)));

    fixture.state.env.HEADLESS_RECEIPTS = "on";
    delete fixture.state.env.HEADLESS_LEDGER_KEY;
    delete fixture.state.env.HEADLESS_LEDGER_KEY_ID;
    fixture.state.env.HEADLESS_LEDGER_KEYS = JSON.stringify({ "receipt-test-key": key });
    clearRuntimeDiagnostics();
    const recovered = await restartFixture(fixture);

    expect((recovered as unknown as { ready: boolean }).ready).toBe(true);
    expect(journal.get(completed.id)?.state).toBe("pending");
    expect(new ReceiptStore(recovered.state.receiptsDir).get(completed.id)).toBeNull();
    expect(listRuntimeDiagnostics()).toContainEqual(expect.objectContaining({
      scope: `daemon.start.receipt-gap:${completed.id}`,
      message: expect.stringContaining("Refusing to append an unsigned SHA record"),
    }));
  });

  test("boots past a malformed receipt marker and leaves it for repair", async () => {
    const fixture = createFixture();
    const daemon = new HeadlessDaemon({
      projectRoot: fixture.project,
      state: fixture.state,
      token: "r".repeat(48),
      principal: "receipt-root",
    });
    const journal = new ReceiptJournal(daemon.state);
    const markerPath = join(journal.directory, "corrupt.json");
    writeFileSync(markerPath, "{broken\n", { mode: 0o600 });
    clearRuntimeDiagnostics();
    daemons.push(daemon);

    await daemon.start();

    expect((daemon as unknown as { ready: boolean }).ready).toBe(true);
    expect(existsSync(markerPath)).toBe(true);
    expect(listRuntimeDiagnostics()).toContainEqual(expect.objectContaining({
      scope: "daemon.start.receipt-journal-record",
    }));
  });

  test("records an assembly diagnostic without changing a successful run", async () => {
    const fixture = createFixture();
    const { daemon, client } = await startFixture(fixture);
    const internal = daemon as unknown as { receipts: ReceiptStore };
    internal.receipts.put = () => { throw new Error("injected receipt-store failure"); };
    clearRuntimeDiagnostics();

    const completed = await run(client, fixture.backend, "receipt failure");

    expect(completed.result?.status).toBe("succeeded");
    expect(listRuntimeDiagnostics()).toContainEqual(expect.objectContaining({
      category: "state",
      scope: "receipt.assemble-and-anchor",
      message: expect.stringContaining("injected receipt-store failure"),
    }));
  });
});

async function startFixture(fixture: ReturnType<typeof createFixture>) {
  const daemon = new HeadlessDaemon({
    projectRoot: fixture.project,
    state: fixture.state,
    token: "r".repeat(48),
    principal: "receipt-root",
    writeGateChecks: [{ name: "receipt-check", command: "bun", args: ["-e", "console.log('receipt gate ok')"] }],
  });
  daemons.push(daemon);
  await daemon.start();
  return {
    daemon,
    client: new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: "r".repeat(48) }),
  };
}

async function run(
  client: HeadlessDaemonClient,
  backend: string,
  prompt: string,
  overrides: Record<string, unknown> = {},
) {
  const submitted = await client.call<Job>("run.submit", {
    backend,
    prompt,
    containment: "unsafe",
    authMode: "broker",
    timeoutMs: 15_000,
    ...overrides,
  });
  return client.call<Job>("run.wait", { jobId: submitted.id, timeoutMs: 30_000 }, 35_000);
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "headless-receipt-"));
  const runtime = mkdtempSync("/tmp/hrc-");
  roots.push(root);
  runtimes.push(runtime);
  const project = join(root, "project");
  const bin = join(root, "receipt-worker");
  mkdirSync(project);
  writeFileSync(bin, `#!/usr/bin/env bun
import { join } from "node:path";
if (process.argv[2] === "--version") {
  console.log("receipt-fixture 1.0.0");
  process.exit(0);
}
const mode = process.argv[2];
const prompt = process.argv[3] ?? "";
if (prompt === "delay-policy-receipt") await Bun.sleep(200);
if (mode === "write") await Bun.write(join(process.cwd(), "receipt-change.txt"), "receipt write\\n");
console.log("completed:" + prompt);
`, { mode: 0o700 });
  chmodSync(bin, 0o700);
  expect(runGitStrict(["init", "-b", "main"], project).ok).toBe(true);
  writeFileSync(join(project, "README.md"), "receipt fixture\n");
  expect(runGitStrict(["add", "--all"], project).ok).toBe(true);
  expect(runGitStrict(["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--no-gpg-sign", "-m", "base"], project).ok).toBe(true);
  const backend = `receipt-fixture-${++fixtureNumber}`;
  registerBackendDefinition(fixtureAdapter(backend, bin));
  adapters.push(backend);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HEADLESS_STATE_HOME: join(root, "state"),
    HEADLESS_RUNTIME_HOME: runtime,
    HEADLESS_COMMIT: "a".repeat(40),
  };
  return { root, project, backend, state: { env, homeDir: root } };
}

async function stopTracked(daemon: HeadlessDaemon) {
  await daemon.stop();
  const index = daemons.indexOf(daemon);
  if (index >= 0) daemons.splice(index, 1);
}

async function restartFixture(fixture: ReturnType<typeof createFixture>) {
  const daemon = new HeadlessDaemon({
    projectRoot: fixture.project,
    state: fixture.state,
    token: "r".repeat(48),
    principal: "receipt-root",
    writeGateChecks: [{ name: "receipt-check", command: "bun", args: ["-e", "console.log('receipt gate ok')"] }],
  });
  daemons.push(daemon);
  await daemon.start();
  return daemon;
}

function receiptJournalIntent(job: Job, commit: string) {
  return {
    jobId: job.id,
    sessionId: job.sessionId,
    principal: job.principal,
    startedAt: job.createdAt,
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
      usage: job.result!.usage,
      cost: job.result!.cost,
      reservationId: null,
    },
    provenance: {
      headlessVersion: "0.2.0-crash-test",
      platform: "test-platform",
      commit,
      backendVersion: "receipt-fixture 1.0.0",
    },
    captureFailure: null,
  };
}

function journalProvenance(backend: string, provenance: ReturnType<typeof receiptJournalIntent>["provenance"]) {
  return {
    headlessVersion: provenance.headlessVersion,
    platform: provenance.platform,
    commit: provenance.commit,
    backendVersions: { [backend]: provenance.backendVersion },
  };
}

function ledgerRecords(path: string) {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => (
    LedgerRecordV2Schema.parse(JSON.parse(line))
  ));
}

function anchorRecords(path: string, runId: string) {
  const eventId = receiptAnchorEventId(runId);
  return ledgerRecords(path).filter((record) => record.eventId === eventId);
}

function fixtureAdapter(id: string, executable: string): BackendDefinition {
  return {
    id,
    metadata: { id, aliases: [], promptDelivery: "argv", timeoutMs: 15_000, maxDepth: null, canRead: true, canWrite: true },
    capabilities: { write: true, streaming: true, structuredOutput: true, nativeResume: false, cancellation: true, tools: false, effort: false, brokerCompatible: false },
    security: { outerContainmentRequired: true, strictAuth: "credential-free", disablesProjectConfig: true, disablesHooks: true, disablesMcp: true, disablesSkills: true },
    probe: { versionCommand: [executable, "--version"], helpCommand: [executable, "--help"], requiredHelpFragments: [], timeoutMs: 1_000, maxOutputBytes: 1_024 },
    stdinPrompt: false,
    credentialPrefixes: [],
    provider: null,
    prepareCommand: (options) => [executable, options.mode, options.prompt],
    decodeOutput: (stdout) => ({ output: stdout.trim(), cost: null, tokens: null, error: null }),
  };
}
