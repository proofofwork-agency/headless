import { afterEach, expect, test } from "bun:test";
import { createConnection, createServer, Socket, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridgeStreamConnection, startStreamProxy } from "../src/broker/linux-relay";

/**
 * The contained worker writes its run-tool request the instant its loopback
 * connect completes; the relay reaches its upstream Unix socket a moment later.
 * If the relay has no consumer attached across that window the request is
 * silently discarded — nothing errors, the daemon holds an accepted connection
 * that never receives a frame, and the worker waits out its whole deadline.
 *
 * That is what failed all four daemon-run-tool cooperation cases on
 * GitHub-hosted x86-64 at ~5.4s each while every arm64 Linux leg passed.
 *
 * The window is opened explicitly here with a real but not-yet-connected
 * upstream socket. Racing a real relay for it is not a usable regression test:
 * that version passed on macOS against the DEFECTIVE relay, because the bytes
 * landed before accept where the kernel buffer preserves them. A stream.Duplex
 * stand-in is no good either — it has correct Node buffering semantics, so it
 * cannot exhibit the loss at all. Both were tried, and both were regression
 * tests that could not regress.
 */
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function upstreamEcho() {
  const root = mkdtempSync(join(tmpdir(), "headless-relay-proxy-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const socketPath = join(root, "upstream.sock");
  let seen = "";
  const server = createServer((socket) => {
    socket.on("data", (chunk) => {
      seen += chunk;
      if (seen.includes("\n")) socket.write(`{"ok":true}\n`);
    });
  });
  cleanups.push(() => server.close());
  return {
    socketPath,
    listen: () => new Promise<void>((resolve) => server.listen(socketPath, () => resolve())),
    seen: () => seen,
  };
}

/** A relay whose upstream is a real socket this test connects on demand. */
async function relayWithPendingUpstream(onClose: () => void) {
  const pending = new Socket();
  cleanups.push(() => pending.destroy());
  const relay = createServer((client) => bridgeStreamConnection(client, pending, onClose));
  cleanups.push(() => relay.close());
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", () => resolve()));
  const address = relay.address() as { port: number };
  const client = createConnection({ host: "127.0.0.1", port: address.port });
  cleanups.push(() => client.destroy());
  await new Promise<void>((resolve) => client.once("connect", () => resolve()));
  return { pending, client };
}

test("a request that arrives before the upstream connects is still forwarded", async () => {
  const upstream = upstreamEcho();
  await upstream.listen();
  let closed = false;
  const { pending, client } = await relayWithPendingUpstream(() => { closed = true; });

  client.write(`{"operation":"task_status"}\n`);
  await Bun.sleep(150);
  expect(upstream.seen(), "nothing can reach an upstream that has not connected").toBe("");

  pending.connect(upstream.socketPath);
  await new Promise<void>((resolve) => pending.once("connect", () => resolve()));
  await Bun.sleep(150);

  expect(upstream.seen(), "the request must survive the window and flush on the connect edge").toContain("task_status");
  expect(closed).toBe(false);
}, 15_000);

test("a request that arrives after the upstream connects is forwarded directly", async () => {
  const upstream = upstreamEcho();
  await upstream.listen();
  const { pending, client } = await relayWithPendingUpstream(() => {});

  pending.connect(upstream.socketPath);
  await new Promise<void>((resolve) => pending.once("connect", () => resolve()));
  client.write(`{"operation":"note"}\n`);
  await Bun.sleep(150);

  expect(upstream.seen(), "the steady-state path must be unaffected by the buffering").toContain("note");
}, 15_000);

test("a client that floods an unconnected upstream is closed rather than buffered without limit", async () => {
  const upstream = upstreamEcho();
  await upstream.listen();
  let closed = false;
  const { client } = await relayWithPendingUpstream(() => { closed = true; });

  client.write("x".repeat(1_048_577));
  await Bun.sleep(250);

  expect(closed, "an unconnected upstream must not let a client grow the buffer without limit").toBe(true);
  expect(upstream.seen()).toBe("");
}, 15_000);

test("the proxy carries a real request and response end to end", async () => {
  const upstream = upstreamEcho();
  await upstream.listen();

  const proxy = await startStreamProxy(upstream.socketPath, 0);
  cleanups.push(() => proxy.close());
  const address = (proxy.server as Server).address() as { port: number };

  const client = createConnection({ host: "127.0.0.1", port: address.port });
  cleanups.push(() => client.destroy());
  const response = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no response before the deadline")), 5_000);
    client.once("error", (error) => { clearTimeout(timer); reject(error); });
    client.on("data", (chunk) => { clearTimeout(timer); resolve(String(chunk)); });
  });
  await new Promise<void>((resolve) => client.once("connect", () => resolve()));
  client.write(`{"operation":"task_status"}\n`);

  expect(await response).toContain(`"ok":true`);
  expect(upstream.seen()).toContain("task_status");
}, 15_000);
