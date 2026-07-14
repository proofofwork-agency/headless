import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunSessionExecutor } from "../src/runtime/session-drivers";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("JSON-RPC session transport cleanup", () => {
  test("removes response and notification waiters after timeout or abort", async () => {
    const { root, executor } = fixtureExecutor();
    const transport = await open(executor, root);

    await expect(transport.request({
      method: "never",
      params: {},
      timeoutMs: 20,
      signal: new AbortController().signal,
    })).rejects.toThrow("timed out");
    expect(await transport.inspect!()).toMatchObject({
      pendingRequests: 0,
      pendingWaiters: 0,
    });

    await expect(transport.request({
      method: "respond",
      params: {},
      waitFor: ["turn/completed"],
      timeoutMs: 200,
      signal: new AbortController().signal,
    })).rejects.toThrow("did not receive");
    expect(await transport.inspect!()).toMatchObject({
      pendingRequests: 0,
      pendingWaiters: 0,
    });

    await transport.close();
  });

  test("close rejects and clears in-flight state before a replacement transport opens", async () => {
    const { root, executor } = fixtureExecutor();
    const transport = await open(executor, root);
    const pending = transport.request({
      method: "never",
      params: {},
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    });
    const outcome = pending.then(
      () => null,
      (error: unknown) => error,
    );
    await waitFor(async () => (await transport.inspect!()).pendingRequests === 1);

    await transport.close();
    const failure = await outcome;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("closed");
    expect(await transport.inspect!()).toMatchObject({
      closed: true,
      pendingRequests: 0,
      pendingWaiters: 0,
    });

    const replacement = await open(executor, root);
    expect((await replacement.request({
      method: "respond",
      params: {},
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    })).result).toEqual({ ok: true });
    expect(await replacement.inspect!()).toMatchObject({ pendingRequests: 0, pendingWaiters: 0 });
    await replacement.close();
  });

  test("concurrent close callers await the same descendant teardown and cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "headless-session-transport-tree-"));
    roots.push(root);
    const marker = join(root, "descendant.pid");
    const script = join(root, "transport-tree.ts");
    writeFileSync(script, `
const descendant = Bun.spawn([
  process.execPath,
  "-e",
  "process.on('SIGTERM', () => {}); await Bun.sleep(60000)",
], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
await Bun.write(${JSON.stringify(marker)}, String(descendant.pid));
process.on("SIGTERM", () => {});
for await (const _chunk of Bun.stdin.stream()) {}
await Bun.sleep(60000);
`);
    let cleanups = 0;
    let cleanupSawLiveDescendant = true;
    const executor = new BunSessionExecutor({
      prepare: () => ({
        argv: [process.execPath, script],
        cleanup: () => {
          cleanups += 1;
          cleanupSawLiveDescendant = processAlive(Number(readFileSync(marker, "utf8")));
        },
      }),
    });
    const transport = await open(executor, root);
    await waitFor(() => existsSync(marker));
    const descendantPid = Number(readFileSync(marker, "utf8"));

    await Promise.all([transport.close(), transport.close()]);
    expect(cleanups).toBe(1);
    expect(cleanupSawLiveDescendant).toBe(false);
    expect(processAlive(descendantPid)).toBe(false);
  });
});

function fixtureExecutor() {
  const root = mkdtempSync(join(tmpdir(), "headless-session-transport-"));
  roots.push(root);
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
    if (request.method !== "respond") continue;
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } }) + "\\n");
  }
}
`);
  return {
    root,
    executor: new BunSessionExecutor({
      prepare: () => ({ argv: [process.execPath, script] }),
    }),
  };
}

function open(executor: BunSessionExecutor, cwd: string) {
  return executor.open!({
    argv: ["fixture-transport"],
    cwd,
    env: process.env,
    timeoutMs: 5_000,
    signal: new AbortController().signal,
    protocol: "json-rpc-jsonl",
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (await predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("condition not reached");
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
