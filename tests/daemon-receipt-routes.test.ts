import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerBackendDefinition, unregisterBackendDefinition, type BackendDefinition } from "../src/backends/registry";
import type { Receipt } from "../src/contracts/receipt";
import type { Job } from "../src/contracts/durable";
import { HeadlessDaemonClient } from "../src/daemon/client";
import { HeadlessDaemon } from "../src/daemon/server";
import type { CredentialStore } from "../src/runtime/credential-store";
import type { ReceiptVerificationVerdict } from "../src/runtime/receipt-verify";
import { setTestTimeout } from "./support/timing";

setTestTimeout(25_000);

const daemons: HeadlessDaemon[] = [];
const roots: string[] = [];
const runtimes: string[] = [];
const backends: string[] = [];
let fixtureId = 0;

afterEach(async () => {
  while (daemons.length) await daemons.pop()!.stop().catch(() => {});
  while (backends.length) unregisterBackendDefinition(backends.pop()!);
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
  while (runtimes.length) rmSync(runtimes.pop()!, { recursive: true, force: true });
});

describe("daemon receipt routes", () => {
  test("gets and lists only owned receipts while enforcing not-found, ownership, and scope", async () => {
    const fixture = await startFixture();
    const alice = provisionClient(fixture, "alice", ["run", "ledger:read"]);
    const bob = provisionClient(fixture, "bob", ["run", "ledger:read"]);
    const runOnly = provisionClient(fixture, "run-only", ["run"]);
    await grantRun(fixture.rootClient, fixture.backend, "integration:alice", "grant-alice");
    await grantRun(fixture.rootClient, fixture.backend, "integration:bob", "grant-bob");

    const aliceJob = await run(alice, fixture.backend, "alice receipt");
    const bobJob = await run(bob, fixture.backend, "bob receipt");

    expect(await alice.call<Receipt>("receipt.get", { runId: aliceJob.id })).toMatchObject({
      body: { runId: aliceJob.id, principal: "integration:alice" },
    });
    expect((await alice.call<Receipt[]>("receipt.list")).map((receipt) => receipt.body.runId)).toEqual([aliceJob.id]);
    expect((await alice.call<Receipt[]>("receipt.list", { limit: 1 })).map((receipt) => receipt.body.runId)).toEqual([aliceJob.id]);
    expect((await bob.call<Receipt[]>("receipt.list")).map((receipt) => receipt.body.runId)).toEqual([bobJob.id]);
    await expect(alice.call("receipt.get", { runId: "missing-run" })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("Unknown receipt"),
    });
    await expect(bob.call("receipt.get", { runId: aliceJob.id })).rejects.toMatchObject({ code: "POLICY_DENIED" });
    await expect(bob.call("receipt.verify", { runId: aliceJob.id })).rejects.toMatchObject({ code: "POLICY_DENIED" });
    await expect(runOnly.call("receipt.get", { runId: aliceJob.id })).rejects.toMatchObject({
      code: "POLICY_DENIED",
      message: expect.stringContaining("ledger:read"),
    });
    expect((await fixture.rootClient.call<Receipt[]>("receipt.list", { limit: 1 }))).toHaveLength(1);
  });

  test("verifies a genuine receipt and returns an integrity verdict after ledger tampering", async () => {
    const fixture = await startFixture();
    const alice = provisionClient(fixture, "alice", ["run", "ledger:read"]);
    await grantRun(fixture.rootClient, fixture.backend, "integration:alice", "grant-alice");
    const job = await run(alice, fixture.backend, "verify receipt");

    expect(await alice.call<ReceiptVerificationVerdict>("receipt.verify", { runId: job.id })).toMatchObject({
      ok: true,
      ledger: { ok: true },
      anchor: { ok: true },
      selfDigest: { ok: true },
    });

    const lines = readFileSync(fixture.daemon.state.ledgerPath, "utf8").trimEnd().split("\n");
    const record = JSON.parse(lines[0]!) as { payload: Record<string, unknown> };
    record.payload.tampered = true;
    lines[0] = JSON.stringify(record);
    writeFileSync(fixture.daemon.state.ledgerPath, `${lines.join("\n")}\n`, { mode: 0o600 });

    expect(await alice.call<ReceiptVerificationVerdict>("receipt.verify", { runId: job.id })).toMatchObject({
      ok: false,
      ledger: { ok: false, firstBreakAt: { sequence: 1, reason: expect.stringContaining("Hash mismatch") } },
    });
  });
});

async function startFixture() {
  fixtureId += 1;
  const root = mkdtempSync(join(tmpdir(), "headless-receipt-routes-"));
  const runtime = mkdtempSync("/tmp/hrr-");
  roots.push(root);
  runtimes.push(runtime);
  const project = join(root, "project");
  const executable = join(root, "receipt-route-worker");
  mkdirSync(project);
  writeFileSync(executable, `#!/usr/bin/env bun
if (process.argv[2] === "--version") {
  console.log("receipt-route-fixture 1.0.0");
  process.exit(0);
}
console.log("completed:" + (process.argv[2] ?? ""));
`, { mode: 0o700 });
  chmodSync(executable, 0o700);
  const backend = `receipt-route-${fixtureId}`;
  registerBackendDefinition(fixtureAdapter(backend, executable));
  backends.push(backend);
  const state = {
    env: {
      ...process.env,
      HEADLESS_STATE_HOME: join(root, "state"),
      HEADLESS_RUNTIME_HOME: runtime,
      HEADLESS_COMMIT: "a".repeat(40),
    },
    homeDir: root,
  };
  const token = "r".repeat(48);
  const daemon = new HeadlessDaemon({ projectRoot: project, state, token, principal: "receipt-root" });
  daemons.push(daemon);
  await daemon.start();
  return {
    daemon,
    project,
    state,
    token,
    backend,
    rootClient: new HeadlessDaemonClient({ projectRoot: project, state, token }),
  };
}

function provisionClient(
  fixture: Awaited<ReturnType<typeof startFixture>>,
  name: string,
  scopes: Array<"run" | "ledger:read">,
) {
  const credentials = (fixture.daemon as unknown as { credentials: CredentialStore }).credentials;
  const root = credentials.authenticate(fixture.token)!;
  credentials.provisionIntegration(root, name, scopes);
  return new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, credential: { integration: name } });
}

async function grantRun(
  root: HeadlessDaemonClient,
  backend: string,
  principal: string,
  id: string,
) {
  await root.call("authority.grant.add", {
    id,
    principal,
    operations: ["run"],
    backends: [backend],
    expiresAt: Date.now() + 60_000,
  });
}

async function run(client: HeadlessDaemonClient, backend: string, prompt: string) {
  const submitted = await client.call<Job>("run.submit", {
    backend,
    prompt,
    containment: "unsafe",
    authMode: "broker",
    timeoutMs: 10_000,
  });
  return client.call<Job>("run.wait", { jobId: submitted.id, timeoutMs: 20_000 }, 25_000);
}

function fixtureAdapter(id: string, executable: string): BackendDefinition {
  return {
    id,
    metadata: { id, aliases: [], promptDelivery: "argv", timeoutMs: 10_000, maxDepth: null, canRead: true, canWrite: false },
    capabilities: { write: false, streaming: true, structuredOutput: true, nativeResume: false, cancellation: true, tools: false, effort: false, brokerCompatible: false },
    security: { outerContainmentRequired: true, strictAuth: "credential-free", disablesProjectConfig: true, disablesHooks: true, disablesMcp: true, disablesSkills: true },
    probe: { versionCommand: [executable, "--version"], helpCommand: [executable, "--help"], requiredHelpFragments: [], timeoutMs: 1_000, maxOutputBytes: 1_024 },
    stdinPrompt: false,
    credentialPrefixes: [],
    provider: null,
    prepareCommand: (options) => [executable, options.prompt],
    decodeOutput: (stdout) => ({ output: stdout.trim(), cost: null, tokens: null, error: null }),
  };
}
