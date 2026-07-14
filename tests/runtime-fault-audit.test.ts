import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendDefinition } from "../src/backends/registry";
import { registerBackendDefinition, unregisterBackendDefinition } from "../src/backends/registry";
import type { JsonParseResult } from "../src/backends/json";
import { normalizeAdapterResult } from "../src/backends/result-normalization";
import { executeBoundedProbe } from "../src/backends/probe";
import type { Job } from "../src/contracts/durable";
import { HeadlessDaemonClient } from "../src/daemon/client";
import type { RunToolEndpointManager } from "../src/daemon/run-tool-endpoint";
import { HeadlessDaemon } from "../src/daemon/server";
import { runHeadless } from "../src/runner/simple";
import {
  cleanupWithDiagnostic,
  clearRuntimeDiagnostics,
  listRuntimeDiagnostics,
  recordRuntimeDiagnostic,
} from "../src/runtime/diagnostics";
import { PersistentSessionStore } from "../src/runtime/persistent-sessions";
import { supportsNativeAuthCapsule } from "../src/runtime/native-auth-capsule";
import { DARWIN_SANDBOX_EXEC, probeLinuxBwrap } from "../src/runtime/os-sandbox";
import { ensureProjectStateDirectories, getProjectStatePaths } from "../src/runtime/project-state";
import { BunSessionExecutor } from "../src/runtime/session-drivers";

const roots: string[] = [];
const adapters: string[] = [];
const daemons: HeadlessDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop().catch(() => {});
  clearRuntimeDiagnostics();
  while (adapters.length) unregisterBackendDefinition(adapters.pop()!);
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("runtime fault classification", () => {
  test("grants native provider capability only to the four audited capsule backends", () => {
    for (const backend of ["codex", "claude-code", "opencode", "grok-build"]) {
      expect(supportsNativeAuthCapsule(backend)).toBe(true);
    }
    expect(supportsNativeAuthCapsule("credential-free-extension")).toBe(false);
  });

  test("normalizes untrusted adapter cost, usage, and diagnostics at one boundary", () => {
    const parsed = normalizeAdapterResult({
      output: "ready",
      error: { message: "not text" },
      cost: -12,
      tokens: 7,
      usage: { input_tokens: -1, output_tokens: 2.5 },
      diagnostics: {
        format: "x".repeat(200),
        malformedEvents: -3,
        ignoredEvents: Number.POSITIVE_INFINITY,
        messages: [`secret sk-${"a".repeat(32)}`, 42],
      },
    } as unknown as JsonParseResult, "fixture-result");

    expect(parsed).toMatchObject({
      output: "ready",
      error: null,
      cost: null,
      tokens: 7,
      usage: { input: null, output: null, reasoning: null, cached: null, providerTotal: 7 },
      diagnostics: { malformedEvents: 0, ignoredEvents: 0 },
    });
    expect(parsed.diagnostics.format.length).toBeLessThanOrEqual(128);
    expect(parsed.diagnostics.messages.join("\n")).not.toContain(`sk-${"a".repeat(32)}`);
    expect(parsed.diagnostics.messages.join("\n")).toContain("invalid cost");
    expect(parsed.diagnostics.messages.join("\n")).toContain("no valid non-negative integer");
  });

  test("isolates a throwing stdout callback and increments returned diagnostics", async () => {
    const root = fixture("headless-callback-audit-");
    const adapter = fixtureAdapter("callback-diagnostic-fixture", () => ["/usr/bin/printf", "callback-output"]);
    registerBackendDefinition(adapter);
    adapters.push(adapter.id);

    const result = await runHeadless({
      backend: adapter.id,
      prompt: "ignored",
      cwd: root,
      containment: "unsafe",
      onStdoutChunk: () => { throw new Error("consumer failed"); },
    });

    expect(result.ok).toBe(true);
    expect(result.output).toBe("callback-output");
    expect(result.diagnostics?.ignoredEvents).toBe(1);
    expect(result.diagnostics?.messages).toContain("User stdout callback failed 1 time; backend execution continued.");
    expect(listRuntimeDiagnostics().some((entry) => entry.category === "stream-callback" && entry.scope === "runner.stdout-callback")).toBe(true);
  });

  test("retains cleanup failures in a bounded redacted ring without replacing success", async () => {
    const secret = `sk-${"b".repeat(32)}`;
    for (let index = 0; index < 300; index += 1) {
      recordRuntimeDiagnostic("cleanup", `cleanup-${index}`, new Error(`${secret}-${index}`));
    }
    await cleanupWithDiagnostic("async-cleanup", async () => { throw new Error("async cleanup failed"); });
    const diagnostics = listRuntimeDiagnostics();
    expect(diagnostics).toHaveLength(256);
    expect(diagnostics.at(-1)).toMatchObject({ category: "cleanup", scope: "async-cleanup", severity: "warning" });
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
  });

  test("does not silently omit a corrupt durable session", () => {
    const project = fixture("headless-session-project-");
    const stateHome = fixture("headless-session-state-");
    const paths = ensureProjectStateDirectories(getProjectStatePaths(project, {
      env: { HEADLESS_STATE_HOME: stateHome, HEADLESS_RUNTIME_HOME: `/tmp/hfa-${process.pid}` },
      homeDir: stateHome,
      platform: "linux",
    }));
    writeFileSync(join(paths.sessionsDir, "corrupt.json"), "{}\n", { mode: 0o600 });
    const store = new PersistentSessionStore(paths);
    expect(() => store.list()).toThrow();
  });

  test("reports probe spawn failure instead of returning an unexplained empty execution", async () => {
    const result = await executeBoundedProbe(
      [join(fixture("headless-missing-probe-"), "does-not-exist")],
      { timeoutMs: 500, maxOutputBytes: 1_024 },
      { cwd: process.cwd(), env: process.env },
    );
    expect(result).toMatchObject({ exitCode: null, error: "Capability probe process could not be started." });
    expect(listRuntimeDiagnostics().some((entry) => entry.scope === "backend-probe.spawn")).toBe(true);
  });

  test("records prepared-command cleanup failure after a successful session execution", async () => {
    const root = fixture("headless-session-cleanup-");
    const executable = join(root, "session-command");
    writeFileSync(executable, "#!/bin/sh\nprintf ready\n", { mode: 0o700 });
    chmodSync(executable, 0o700);
    const executor = new BunSessionExecutor({
      prepare: () => ({ argv: [executable], cleanup: () => { throw new Error("cleanup failed"); } }),
    });
    const result = await executor.execute({
      argv: [executable],
      cwd: root,
      env: process.env,
      stdin: null,
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      protocol: "text",
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: "ready" });
    expect(listRuntimeDiagnostics().some((entry) => entry.scope === "session-executor.prepared-command")).toBe(true);
  });

  test.skipIf(!strictContainmentAvailable())("records run-tool revocation failure without replacing a successful run", async () => {
    const root = fixture("headless-run-execution-cleanup-");
    const project = join(root, "project");
    mkdirSync(project);
    const runtime = `/tmp/hre-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    roots.push(runtime);
    const adapter = fixtureAdapter("run-execution-cleanup-fixture", () => ["/usr/bin/printf", "run-complete"]);
    registerBackendDefinition(adapter);
    adapters.push(adapter.id);

    const state = {
      env: { ...process.env, HEADLESS_STATE_HOME: join(root, "state"), HEADLESS_RUNTIME_HOME: runtime },
      homeDir: root,
    };
    const token = "r".repeat(48);
    const daemon = new HeadlessDaemon({ projectRoot: project, state, token, principal: "coordinator" });
    daemons.push(daemon);
    await daemon.start();

    const internal = daemon as unknown as { runTools: RunToolEndpointManager };
    const revoke = internal.runTools.revoke.bind(internal.runTools);
    const secret = `sk-${"z".repeat(32)}`;
    internal.runTools.revoke = async () => { throw new Error(`cleanup ${secret}`); };
    clearRuntimeDiagnostics();
    try {
      const client = new HeadlessDaemonClient({ projectRoot: project, state, token });
      const submitted = await client.call<Job>("run.submit", {
        backend: adapter.id,
        prompt: "complete despite cleanup diagnostics",
        containment: "required",
        timeoutMs: 5_000,
      });
      const completed = await client.call<Job>("run.wait", { jobId: submitted.id, timeoutMs: 10_000 }, 15_000);
      expect(completed.result).toMatchObject({ status: "succeeded", output: "run-complete" });
      const diagnostics = listRuntimeDiagnostics();
      expect(diagnostics.some((entry) => entry.scope === "run-execution.run-tool-revoke")).toBe(true);
      expect(JSON.stringify(diagnostics)).not.toContain(secret);
    } finally {
      internal.runTools.revoke = revoke;
      await internal.runTools.revokeAll();
    }
  });
});

function fixture(prefix: string) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

function fixtureAdapter(id: string, prepareCommand: () => string[]): BackendDefinition {
  return {
    id,
    metadata: { id, aliases: [], promptDelivery: "native", timeoutMs: 1_000, maxDepth: null, canRead: true, canWrite: false },
    capabilities: { write: false, streaming: true, structuredOutput: true, nativeResume: false, cancellation: true, tools: false, effort: false, brokerCompatible: false },
    security: { outerContainmentRequired: true, strictAuth: "credential-free", disablesProjectConfig: true, disablesHooks: true, disablesMcp: true, disablesSkills: true },
    probe: { versionCommand: ["true"], helpCommand: ["true"], requiredHelpFragments: [], timeoutMs: 1_000, maxOutputBytes: 1_024 },
    stdinPrompt: false,
    credentialPrefixes: [],
    prepareCommand,
    decodeOutput: (stdout) => ({ output: stdout, cost: null, tokens: null, error: null }),
  };
}

function strictContainmentAvailable() {
  if (process.platform === "darwin") return existsSync(DARWIN_SANDBOX_EXEC);
  if (process.platform === "linux") return probeLinuxBwrap().ok;
  return false;
}
