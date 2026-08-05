import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HeadlessDaemonClient } from "../src/daemon/client";
import { HeadlessDaemon } from "../src/daemon/server";
import { ensureProjectStateDirectories, getProjectStatePaths } from "../src/runtime/project-state";

/**
 * Process-level gates for the dedicated `headless-mcp` entrypoint.
 *
 * These claims are about a real Bun process and its stdio lifecycle, so
 * source-level listeners are not evidence for them: the server must actually
 * stay alive on a recoverable binding absence, actually exit nonzero on corrupt
 * state, and actually release the lead when its host closes stdin.
 */

const ENTRYPOINT = resolve(import.meta.dir, "../src/mcp/server.ts");
const fixtures: string[] = [];
const children: Array<ReturnType<typeof Bun.spawn>> = [];
const daemons: HeadlessDaemon[] = [];

afterEach(async () => {
  while (children.length) {
    const child = children.pop()!;
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  while (daemons.length) await daemons.pop()!.stop();
  while (fixtures.length) rmSync(fixtures.pop()!, { recursive: true, force: true });
});

describe("headless-mcp process lifecycle", () => {
  test("a missing binding keeps the server alive and listable", async () => {
    const fixture = projectFixture();
    const child = spawnMcp(fixture);

    // Recoverable: the operator can run `headless lead use` without restarting
    // the harness, so exiting here would report the one failure they cannot act
    // on — "server exited".
    const listed = await mcpListTools(child);
    expect(listed.tools.length).toBeGreaterThan(0);
    expect(child.exitCode).toBeNull();
  }, 30_000);

  test("a corrupt binding is fatal and exits nonzero", async () => {
    const fixture = projectFixture();
    writeFileSync(fixture.state.leadBindingPath, "{ not json", { mode: 0o600 });

    const child = spawnMcp(fixture);
    const exitCode = await withTimeout(child.exited, 20_000, "the server stayed alive on corrupt project state");
    // Collapsing corruption into "no credential installed" made this look
    // recoverable, and the server would sit there telling the operator to
    // reconfigure a lead whose state it could not parse.
    expect(exitCode).not.toBe(0);
  }, 30_000);

  test("closing stdin releases the lead without waiting out the 45s window", async () => {
    const fixture = projectFixture();
    const daemon = new HeadlessDaemon({ projectRoot: fixture.project, state: fixture.stateOptions, token: "a".repeat(48), principal: "root" });
    daemons.push(daemon);
    await daemon.start();
    const root = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.stateOptions, token: "a".repeat(48) });
    await root.call("lead.use", { host: "codex" });

    const child = spawnMcp(fixture);
    expect((await mcpListTools(child)).tools.length).toBeGreaterThan(0);
    expect(await root.call("lead.status")).toMatchObject({ status: "connected" });

    // No signal — just EOF, which is how a host that simply closes the pipe ends
    // this process. Signal handlers alone left the binding `connected` until the
    // 45s window lapsed, so the operator's next attach raced their own ghost.
    child.stdin.end();
    await withTimeout(child.exited, 15_000, "the server did not exit after its stdin closed");
    expect(await root.call("lead.status")).toMatchObject({ status: "disconnected" });
  }, 40_000);
});

function spawnMcp(fixture: ReturnType<typeof projectFixture>) {
  const child = Bun.spawn([process.execPath, ENTRYPOINT, "--host", "codex"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HEADLESS_PROJECT_ROOT: fixture.project,
      HEADLESS_STATE_HOME: fixture.stateHome,
      HEADLESS_RUNTIME_HOME: fixture.runtime,
      HEADLESS_LEAD_HOST: "codex",
    },
  });
  children.push(child);
  return child;
}

/** Minimal MCP stdio client: initialize, then tools/list. */
async function mcpListTools(child: ReturnType<typeof Bun.spawn>) {
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const pending: string[] = [];
  let buffered = "";

  const readMessage = async (): Promise<Record<string, unknown>> => {
    for (;;) {
      const line = pending.shift();
      if (line !== undefined) {
        if (!line.trim()) continue;
        return JSON.parse(line) as Record<string, unknown>;
      }
      const { value, done } = await withTimeout(reader.read(), 15_000, "the server sent no MCP response");
      if (done) throw new Error("the server closed stdout before responding");
      buffered += new TextDecoder().decode(value);
      const parts = buffered.split("\n");
      buffered = parts.pop() ?? "";
      pending.push(...parts);
    }
  };

  const write = (payload: unknown) => child.stdin.write(`${JSON.stringify(payload)}\n`);

  write({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "lead-process-test", version: "0" },
  } });
  const initialized = await readMessage();
  expect(initialized.id).toBe(1);

  write({ jsonrpc: "2.0", method: "notifications/initialized" });
  write({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const listed = await readMessage();
  reader.releaseLock();
  const result = (listed.result ?? {}) as { tools?: unknown[] };
  return { tools: result.tools ?? [] };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, failure: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(failure)), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function projectFixture() {
  const root = mkdtempSync(join(tmpdir(), "headless-mcp-process-"));
  const runtime = mkdtempSync("/tmp/hmp-");
  fixtures.push(root, runtime);
  const project = join(root, "project");
  mkdirSync(project);
  const stateHome = join(root, "state");
  const stateOptions = { env: { HEADLESS_STATE_HOME: stateHome, HEADLESS_RUNTIME_HOME: runtime } };
  const state = ensureProjectStateDirectories(getProjectStatePaths(project, stateOptions));
  return { root, project, runtime, stateHome, state, stateOptions };
}
