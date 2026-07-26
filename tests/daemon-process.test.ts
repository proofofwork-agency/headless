import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeadlessDaemonClient } from "../src/daemon/client";
import { schedulingAttempts, schedulingWindow } from "./support/timing";

const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;
const children = new Set<ReturnType<typeof Bun.spawn>>();
const roots: string[] = [];

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited.catch(() => {});
  }
  children.clear();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("cross-process authenticated daemon", () => {
  test("preserves the configured lead credential, attribution, ledger, and queues across restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "headless-daemon-process-"));
    roots.push(root);
    const project = join(root, "project");
    const stateHome = join(root, "state");
    const runtimeHome = join("/tmp", `headless-proc-${process.pid}-${randomUUID().slice(0, 8)}`);
    roots.push(runtimeHome);
    mkdirSync(project);
    mkdirSync(runtimeHome, { mode: 0o700 });
    const env = {
      ...process.env,
      HEADLESS_STATE_HOME: stateHome,
      HEADLESS_RUNTIME_HOME: runtimeHome,
    };
    const state = { env };

    const first = await startDaemon(project, env, state);
    await first.root.call("lead.use", { host: "codex" });
    const integration = new HeadlessDaemonClient({
      projectRoot: project,
      state,
      credential: { integration: "lead-codex-g1" },
      timeoutMs: 5_000,
    });
    await integration.call("lead.attach", { generation: 1 });
    expect((await integration.call<{ principal: string }>("ping")).principal).toBe("integration:lead-codex-g1");
    await integration.call("ledger.note", { sessionId: "process-session", text: "durable cross-process note" });
    await expect(integration.call("messages.push", {
      chatId: "process-session",
      content: "durable cross-process message",
      principal: "spoofed-principal",
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await integration.call("messages.push", {
      chatId: "process-session",
      content: "durable cross-process message",
    });
    await stopDaemon(first.child);

    const second = await startDaemon(project, env, state);
    const resumed = new HeadlessDaemonClient({
      projectRoot: project,
      state,
      credential: { integration: "lead-codex-g1" },
      timeoutMs: 5_000,
    });
    expect((await resumed.call<{ principal: string }>("ping")).principal).toBe("integration:lead-codex-g1");
    const context = await resumed.call("ledger.context", { sessionId: "process-session", view: "raw" });
    expect(JSON.stringify(context)).toContain("durable cross-process note");
    expect(JSON.stringify(context)).toContain("integration:lead-codex-g1");
    expect(JSON.stringify(context)).not.toContain("spoofed-principal");

    const pulled = await resumed.call<{ messages: Array<{ content: string; principal: string }> }>("messages.pull", {
      chatId: "process-session",
    });
    expect(pulled.messages).toEqual([
      expect.objectContaining({
        content: "durable cross-process message",
        principal: "integration:lead-codex-g1",
      }),
    ]);
    await stopDaemon(second.child);
  }, 30_000);
});

async function startDaemon(
  project: string,
  env: NodeJS.ProcessEnv,
  state: { env: NodeJS.ProcessEnv },
) {
  const child = Bun.spawn([process.execPath, cliPath, "daemon", "serve", "--cwd", project], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    env,
  });
  children.add(child);
  const stderrPromise = Bun.readableStreamToText(child.stderr);
  for (let attempt = 0; attempt < schedulingAttempts(120); attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`daemon exited during startup (${child.exitCode}): ${await stderrPromise}`);
    }
    try {
      const root = new HeadlessDaemonClient({ projectRoot: project, state, timeoutMs: 250 });
      await root.call("ping", {}, 250);
      return { child, root, stderrPromise };
    } catch {
      await Bun.sleep(25);
    }
  }
  child.kill("SIGTERM");
  throw new Error(`daemon did not become ready: ${await stderrPromise}`);
}

async function stopDaemon(child: ReturnType<typeof Bun.spawn>) {
  if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.race([
    child.exited,
    Bun.sleep(schedulingWindow(10_000)).then(() => { throw new Error("daemon did not stop within its bounded window"); }),
  ]);
  children.delete(child);
}
