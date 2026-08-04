import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerBackendDefinition, unregisterBackendDefinition, type BackendDefinition } from "../src/backends/registry";
import type { Job } from "../src/contracts/durable";
import type { Receipt } from "../src/contracts/receipt";
import { HeadlessDaemonClient } from "../src/daemon/client";
import { HeadlessDaemon } from "../src/daemon/server";
import type { ExportedReceipt } from "../src/runtime/receipt-verify";
import { diffReceipts, runReceiptCommand } from "../src/cli/commands/receipt";
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

describe("receipt CLI", () => {
  test("verify --file confirms a genuine export offline and surfaces its assurance level", async () => {
    const fixture = await startFixture();
    const job = await run(fixture.rootClient, fixture.backend, "cli receipt");
    const exported = await fixture.rootClient.call<ExportedReceipt>("receipt.export", { runId: job.id });
    const file = join(fixture.root, "export.json");
    writeFileSync(file, `${JSON.stringify(exported)}\n`, { mode: 0o600 });

    const good = await runCli(["verify", "--file", file]);
    expect(good.code).toBe(0);
    expect(good.stdout).toContain("VERIFIED");
    // The fixture ledger is unkeyed, so an offline export proves embedded-record, not full-chain.
    expect(good.stdout).toContain("embedded-record");
  });

  test("verify --file fails closed when the exported bytes are tampered", async () => {
    const fixture = await startFixture();
    const job = await run(fixture.rootClient, fixture.backend, "cli receipt");
    const exported = await fixture.rootClient.call<ExportedReceipt>("receipt.export", { runId: job.id });
    const file = join(fixture.root, "export.json");
    const tampered = JSON.parse(JSON.stringify(exported)) as ExportedReceipt;
    tampered.receipt.body.result.durationMs += 1;
    writeFileSync(file, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });

    const bad = await runCli(["verify", "--file", file]);
    expect(bad.code).toBe(1);
    expect(`${bad.stdout}${bad.stderr}`).toContain("FAILED");
  });

  test("dispatch rejects an unknown verb and a missing run id", async () => {
    await expect(runReceiptCommand(["receipt", "bogus"])).rejects.toThrow();
    await expect(runReceiptCommand(["receipt", "show"])).rejects.toThrow();
  });

  test("diffReceipts reports only the changed fields", async () => {
    const fixture = await startFixture();
    const job = await run(fixture.rootClient, fixture.backend, "cli receipt");
    const left = await fixture.rootClient.call<Receipt>("receipt.get", { runId: job.id });
    const right = JSON.parse(JSON.stringify(left)) as Receipt;
    right.body.result.status = "failed";
    right.body.request.model = "other-model";

    const changed = diffReceipts(left, right).map((change) => change.field);
    expect(changed).toContain("status");
    expect(changed).toContain("model");
    expect(changed).not.toContain("backend");
    expect(diffReceipts(left, left)).toHaveLength(0);
  });
});

async function runCli(args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalExit = process.exitCode;
  process.exitCode = 0;
  console.log = (...parts: unknown[]) => { stdout.push(parts.map(String).join(" ")); };
  console.error = (...parts: unknown[]) => { stderr.push(parts.map(String).join(" ")); };
  process.stdout.write = ((chunk: unknown) => { stdout.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    await runReceiptCommand(["receipt", ...args]);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalWrite;
  }
  const code = process.exitCode ?? 0;
  process.exitCode = originalExit;
  return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), code };
}

async function startFixture() {
  fixtureId += 1;
  const root = mkdtempSync(join(tmpdir(), "headless-receipt-cli-"));
  const runtime = mkdtempSync("/tmp/hrc-");
  roots.push(root);
  runtimes.push(runtime);
  const project = join(root, "project");
  const executable = join(root, "receipt-cli-worker");
  mkdirSync(project);
  writeFileSync(executable, `#!/usr/bin/env bun
if (process.argv[2] === "--version") {
  console.log("receipt-cli-fixture 1.0.0");
  process.exit(0);
}
console.log("completed:" + (process.argv[2] ?? ""));
`, { mode: 0o700 });
  chmodSync(executable, 0o700);
  const backend = `receipt-cli-${fixtureId}`;
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
  const daemon = new HeadlessDaemon({ projectRoot: project, state, token, principal: "receipt-cli-root" });
  daemons.push(daemon);
  await daemon.start();
  return {
    daemon,
    root,
    project,
    state,
    token,
    backend,
    rootClient: new HeadlessDaemonClient({ projectRoot: project, state, token }),
  };
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
