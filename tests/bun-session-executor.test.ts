import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunSessionExecutor } from "../src/runtime/session-drivers";
import { CLAUDE_SETUP_TOKEN_ENV } from "../src/runtime/native-auth-capsule";
import { schedulingWindow } from "./support/timing";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("Bun session executor", () => {
  test("executes bounded structured commands and parses JSONL", async () => {
    const root = fixture();
    const executor = new BunSessionExecutor();
    const result = await executor.execute({
      argv: [process.execPath, "-e", "console.log(JSON.stringify({type:'text',text:'ready'}))"],
      cwd: root,
      env: process.env,
      stdin: null,
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      protocol: "jsonl",
    });
    expect(result.exitCode).toBe(0);
    expect(result.events).toEqual([{ type: "text", text: "ready" }]);
  });

  test("reports watchdog timeout and output overflow instead of collapsing them into process failure", async () => {
    const root = fixture();
    const timed = await new BunSessionExecutor().execute({
      argv: [process.execPath, "-e", "process.on('SIGTERM',()=>{}); await Bun.sleep(60000)"],
      cwd: root,
      env: process.env,
      stdin: null,
      timeoutMs: 20,
      signal: new AbortController().signal,
      protocol: "text",
    });
    expect(timed).toMatchObject({ timedOut: true, overflowed: false });
    expect(timed.stderr).toContain("timed out");

    const overflowed = await new BunSessionExecutor({ maxOutputBytes: 64 }).execute({
      argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(10000)); await Bun.sleep(60000)"],
      cwd: root,
      env: process.env,
      stdin: null,
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      protocol: "text",
    });
    expect(overflowed).toMatchObject({ timedOut: false, overflowed: true });
    expect(overflowed.stderr).toContain("output bound");
  });

  test("does not launch after an asynchronous preparation is cancelled", async () => {
    const root = fixture();
    const marker = join(root, "launched");
    const controller = new AbortController();
    const executor = new BunSessionExecutor({
      prepare: async (request) => {
        controller.abort("cancel during prepare");
        await Bun.sleep(1);
        return { argv: [process.execPath, "-e", `await Bun.write(${JSON.stringify(marker)}, "launched")`] };
      },
    });
    const result = await executor.execute({
      argv: ["fixture"],
      cwd: root,
      env: process.env,
      stdin: null,
      timeoutMs: 5_000,
      signal: controller.signal,
      protocol: "text",
    });
    expect(result).toMatchObject({ exitCode: null, signal: "SIGTERM", timedOut: false, overflowed: false });
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("awaits full descendant termination before prepared-command cleanup", async () => {
    const root = fixture();
    const marker = join(root, "descendant.pid");
    const script = join(root, "descendant-parent.ts");
    writeFileSync(script, `
const descendant = Bun.spawn([
  process.execPath,
  "-e",
  "process.on('SIGTERM', () => {}); await Bun.sleep(60000)",
], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
await Bun.write(${JSON.stringify(marker)}, String(descendant.pid));
process.on("SIGTERM", () => {});
await Bun.sleep(60000);
`);
    let cleanupSawLiveDescendant = true;
    const executor = new BunSessionExecutor({
      prepare: () => ({
        argv: [process.execPath, script],
        cleanup: () => {
          const pid = Number(readFileSync(marker, "utf8"));
          cleanupSawLiveDescendant = processAlive(pid);
        },
      }),
    });

    const result = await executor.execute({
      argv: ["fixture"],
      cwd: root,
      env: process.env,
      stdin: null,
      timeoutMs: 2_000,
      signal: new AbortController().signal,
      protocol: "text",
    });
    expect(result.timedOut).toBe(true);
    expect(existsSync(marker)).toBe(true);
    const descendantPid = Number(readFileSync(marker, "utf8"));
    expect(cleanupSawLiveDescendant).toBe(false);
    expect(processAlive(descendantPid)).toBe(false);
  }, 10_000);

  test("runs a persistent JSON-RPC transport and waits for lifecycle notifications", async () => {
    const root = fixture();
    const script = join(root, "transport.ts");
    writeFileSync(script, `
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    const result = request.method === "thread/start" ? { thread: { id: "thread-1" } } : { ok: true };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
    if (request.method === "thread/start") process.stdout.write(JSON.stringify({ method: "thread/started", params: result }) + "\\n");
  }
}
`);
    let cleaned = 0;
    const executor = new BunSessionExecutor({ prepare: (request) => ({
      argv: request.argv[0] === "fixture-app-server" ? [process.execPath, script] : request.argv,
      cleanup: () => { cleaned += 1; },
    }) });
    const transport = await executor.open!({
      argv: ["fixture-app-server"],
      cwd: root,
      env: process.env,
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      protocol: "json-rpc-jsonl",
    });
    const initialized = await transport.request({
      method: "initialize",
      params: {},
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    });
    expect(initialized.result).toEqual({ ok: true });
    const started = await transport.request({
      method: "thread/start",
      params: {},
      waitFor: ["thread/started"],
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    });
    expect(started.result).toEqual({ thread: { id: "thread-1" } });
    expect(started.events).toContainEqual({ method: "thread/started", params: { thread: { id: "thread-1" } } });
    await transport.close();
    expect(cleaned).toBe(1);
  });

  test("uses stable event cursors and releases completed request history under sustained transport use", async () => {
    const root = fixture();
    const script = join(root, "transport-pressure.ts");
    writeFileSync(script, `
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { id: request.id } }) + "\\n");
    process.stdout.write(JSON.stringify({ method: "turn/completed", params: { id: request.id } }) + "\\n");
  }
}
`);
    const executor = new BunSessionExecutor({ prepare: () => ({ argv: [process.execPath, script] }) });
    const transport = await executor.open!({
      argv: ["fixture-app-server"],
      cwd: root,
      env: process.env,
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      protocol: "json-rpc-jsonl",
    });

    for (let index = 0; index < 2_055; index += 1) {
      const exchange = await transport.request({
        method: "turn/start",
        params: { index },
        waitFor: ["turn/completed"],
        timeoutMs: 5_000,
        signal: new AbortController().signal,
      });
      expect(exchange.events).toContainEqual({ method: "turn/completed", params: { id: index + 1 } });
    }
    expect(await transport.inspect!()).toMatchObject({
      closed: false,
      retainedEvents: 0,
      retainedEventBytes: 0,
    });
    await transport.close();
  });

  test("fails closed instead of dropping lifecycle events when one request exceeds the transport bound", async () => {
    const root = fixture();
    const script = join(root, "transport-overflow.ts");
    writeFileSync(script, `
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  const lines = buffer.split("\\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } }) + "\\n");
    process.stdout.write(JSON.stringify({ method: "turn/delta", params: { text: "x".repeat(950) } }) + "\\n");
    process.stdout.write(JSON.stringify({ method: "turn/completed", params: {} }) + "\\n");
  }
}
`);
    const executor = new BunSessionExecutor({
      maxOutputBytes: 1_024,
      prepare: () => ({ argv: [process.execPath, script] }),
    });
    const transport = await executor.open!({
      argv: ["fixture-app-server"],
      cwd: root,
      env: process.env,
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      protocol: "json-rpc-jsonl",
    });

    await expect(transport.request({
      method: "turn/start",
      params: {},
      waitFor: ["turn/completed"],
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    })).rejects.toThrow("event buffer exceeded");
    await waitFor(async () => (await transport.inspect!()).closed === true);
    expect(await transport.inspect!()).toMatchObject({ closed: true, pendingRequests: 0, pendingWaiters: 0 });
  });

  test("detects a scoped native auth capsule without exposing its contents", async () => {
    const root = fixture();
    const home = join(root, "home");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), "private-auth-state");
    const executor = new BunSessionExecutor();
    const result = await executor.probeAuth!({
      backend: "codex",
      cwd: root,
      env: { HOME: home },
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    });
    expect(result.available).toBe(true);
    expect(result.profileFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain("private-auth-state");
  });

  test("does not treat a keychain-only Claude host as an available worker capsule", async () => {
    const root = fixture();
    const home = join(root, "home");
    mkdirSync(home);
    const executor = new BunSessionExecutor();

    await expect(executor.probeAuth!({
      backend: "claude-code",
      cwd: root,
      env: { HOME: home },
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    })).resolves.toEqual({
      available: false,
      reason: "No native authentication capsule is available for claude-code.",
      profileFingerprint: null,
    });
  });

  test("detects a Claude setup-token environment without returning the bearer", async () => {
    const root = fixture();
    const token = `sk-ant-oat${"Q".repeat(32)}`;
    const executor = new BunSessionExecutor();
    const result = await executor.probeAuth!({
      backend: "claude-code",
      cwd: root,
      env: { HOME: join(root, "home"), [CLAUDE_SETUP_TOKEN_ENV]: token },
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      available: true,
      reason: "Claude setup-token capsule is present.",
    });
    expect(result.profileFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain(token);
  });
});

function fixture() {
  const path = mkdtempSync(join(tmpdir(), "headless-session-executor-"));
  roots.push(path);
  return path;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + schedulingWindow(timeoutMs);
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for session transport state.");
    await Bun.sleep(5);
  }
}

function processAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
