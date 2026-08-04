import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeadlessError } from "../src/runtime/headless-error";
import {
  assertSecureSocket,
  secureBunUnixServe,
  secureUnixListen,
} from "../src/runtime/secure-socket";

const temporaryPaths: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    try {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    } catch {
      // best-effort
    }
  }
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaryPaths.push(dir);
  return dir;
}

function trackServer(server: Server): Server {
  servers.push(server);
  return server;
}

describe("secureUnixListen", () => {
  test("binds an owner-only socket (mode & 0o077)===0 and uid===getuid()", async () => {
    const dir = tempDir("headless-secure-sock-ok-");
    const socketPath = join(dir, "control.sock");
    const server = trackServer(createServer());
    await secureUnixListen(server, socketPath);

    const info = lstatSync(socketPath);
    expect(info.isSocket()).toBe(true);
    expect(info.mode & 0o077).toBe(0);
    expect(info.uid).toBe(process.getuid());
    // umask 0o077 ⇒ typical mode 0o700 (owner rwx); any owner-only mode is fine
    expect(info.mode & 0o777).toBe(0o700);
  });

  test("still yields owner-only mode when process umask was permissive beforehand", async () => {
    const dir = tempDir("headless-secure-sock-umask-");
    const socketPath = join(dir, "control.sock");
    const previous = process.umask(0o000); // maximally permissive ambient umask
    try {
      const server = trackServer(createServer());
      await secureUnixListen(server, socketPath);
      const mode = lstatSync(socketPath).mode & 0o777;
      expect(mode & 0o077).toBe(0);
      expect(mode).toBe(0o700);
    } finally {
      process.umask(previous);
    }
  });

  test("restores process umask after a successful bind", async () => {
    const dir = tempDir("headless-secure-sock-restore-");
    const socketPath = join(dir, "control.sock");
    const marker = 0o022;
    const previous = process.umask(marker);
    try {
      const server = trackServer(createServer());
      await secureUnixListen(server, socketPath);
      // umask() returns the previous value and leaves the new one set — sample then restore
      const current = process.umask(marker);
      expect(current).toBe(marker);
    } finally {
      process.umask(previous);
    }
  });

  test("restores process umask when listen fails", async () => {
    const dir = tempDir("headless-secure-sock-fail-");
    // Point listen at a non-existent parent so bind fails after umask is set.
    const socketPath = join(dir, "missing-parent", "control.sock");
    const marker = 0o027;
    const previous = process.umask(marker);
    try {
      const server = trackServer(createServer());
      await expect(secureUnixListen(server, socketPath)).rejects.toBeDefined();
      const current = process.umask(marker);
      expect(current).toBe(marker);
    } finally {
      process.umask(previous);
    }
  });

  test("owner can connect immediately after listen returns", async () => {
    const dir = tempDir("headless-secure-sock-connect-");
    const socketPath = join(dir, "control.sock");
    const server = trackServer(
      createServer((socket) => {
        socket.end("ok");
      }),
    );
    await secureUnixListen(server, socketPath);

    const reply = await new Promise<string>((resolve, reject) => {
      const client = createConnection(socketPath);
      let buf = "";
      client.setEncoding("utf8");
      client.on("data", (chunk) => {
        buf += chunk;
      });
      client.on("end", () => resolve(buf));
      client.on("error", reject);
    });
    expect(reply).toBe("ok");
  });
});

describe("assertSecureSocket", () => {
  test("rejects a non-socket path", () => {
    const dir = tempDir("headless-secure-sock-nonsock-");
    const filePath = join(dir, "not-a-socket");
    writeFileSync(filePath, "x", { mode: 0o600 });
    expect(() => assertSecureSocket(filePath)).toThrow(HeadlessError);
    expect(() => assertSecureSocket(filePath)).toThrow(/not a Unix socket/i);
  });

  test("rejects a missing path", () => {
    const dir = tempDir("headless-secure-sock-missing-");
    const missing = join(dir, "gone.sock");
    expect(() => assertSecureSocket(missing)).toThrow(HeadlessError);
    expect(() => assertSecureSocket(missing)).toThrow(/unable to stat/i);
  });

  test("rejects a socket with group/other bits (simulated via assert after chmod-less create)", async () => {
    // Create under permissive umask without the helper, then assert fails closed.
    const dir = tempDir("headless-secure-sock-permissive-");
    const socketPath = join(dir, "open.sock");
    const server = trackServer(createServer());
    const previous = process.umask(0o000);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => resolve());
      });
    } finally {
      process.umask(previous);
    }
    const mode = lstatSync(socketPath).mode & 0o777;
    // On most platforms umask 0o000 yields 0o777 for the socket.
    if ((mode & 0o077) === 0) {
      // Platform already created owner-only despite umask — nothing to reject; skip.
      return;
    }
    expect(() => assertSecureSocket(socketPath)).toThrow(HeadlessError);
    expect(() => assertSecureSocket(socketPath)).toThrow(/permissive mode/i);
  });
});

describe("secureBunUnixServe", () => {
  test("factory result is returned and socket is owner-only (Bun.serve unix)", () => {
    const dir = tempDir("headless-secure-bun-unix-");
    const socketPath = join(dir, "broker.sock");
    const previous = process.umask(0o000);
    let bunServer: { stop: (closeActiveConnections?: boolean) => void } | null = null;
    try {
      bunServer = secureBunUnixServe(socketPath, () =>
        Bun.serve({
          unix: socketPath,
          fetch() {
            return new Response("ok");
          },
        }),
      );
      const info = lstatSync(socketPath);
      expect(info.isSocket()).toBe(true);
      expect(info.mode & 0o077).toBe(0);
      expect(info.uid).toBe(process.getuid());
    } finally {
      process.umask(previous);
      try {
        bunServer?.stop(true);
      } catch {
        // best-effort
      }
    }
  });

  test("restores umask when factory throws", () => {
    const dir = tempDir("headless-secure-bun-throw-");
    const socketPath = join(dir, "broker.sock");
    const marker = 0o033;
    const previous = process.umask(marker);
    try {
      expect(() =>
        secureBunUnixServe(socketPath, () => {
          throw new Error("factory boom");
        }),
      ).toThrow(/factory boom/);
      const current = process.umask(marker);
      expect(current).toBe(marker);
    } finally {
      process.umask(previous);
    }
  });
});
