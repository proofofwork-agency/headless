import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeadlessError } from "../src/runtime/headless-error";
import {
  assertSecureSocket,
  secureBunUnixServe,
  secureUnixListen,
} from "../src/runtime/secure-socket";

type StoppableServer = { stop: (closeActiveConnections?: boolean) => void };

const temporaryPaths: string[] = [];
const servers: Server[] = [];
const bunServers: StoppableServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    try {
      // A server whose listen() was refused never opened; closing it can leave
      // the close callback unfired, so skip it rather than hang the suite.
      if (!server.listening) continue;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    } catch {
      // best-effort
    }
  }
  for (const server of bunServers.splice(0)) {
    try {
      server.stop(true);
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

function trackBunServer<T extends StoppableServer>(server: T): T {
  bunServers.push(server);
  return server;
}

/** Resolve to the rejection reason, or null when the promise fulfilled. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Read the live process umask without leaving it changed. */
function sampleUmask(): number {
  const current = process.umask(0o022);
  process.umask(current);
  return current;
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

  // Regression: the helper used to rmSync(socketPath) before binding, which made
  // EADDRINUSE unreachable and let a second process silently steal the path.
  // EADDRINUSE is the kernel backstop behind every caller's single-owner election.
  test("refuses a second bind to a live socket path instead of taking it over", async () => {
    const dir = tempDir("hl-sock-excl-");
    const socketPath = join(dir, "c.sock");
    const first = trackServer(
      createServer((socket) => {
        socket.end("first");
      }),
    );
    await secureUnixListen(first, socketPath);
    const firstInode = lstatSync(socketPath).ino;

    const second = trackServer(createServer());
    const error = await rejection(secureUnixListen(second, socketPath));
    expect(error).not.toBeNull();
    expect(errorCode(error)).toBe("EADDRINUSE");
    expect(second.listening).toBe(false);

    // The original owner still owns the path — same inode, still serving.
    expect(lstatSync(socketPath).ino).toBe(firstInode);
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
    expect(reply).toBe("first");
  });

  // Deciding that a leftover socket is stale (and unlinking it) is caller policy —
  // HeadlessDaemon.start probes liveness first. If this helper cleared the path
  // itself that election would be bypassed, so a stale entry must still refuse.
  test("refuses a bind onto a stale socket entry (caller owns the unlink policy)", async () => {
    const dir = tempDir("hl-sock-stale-");
    const socketPath = join(dir, "c.sock");
    // A SIGKILLed owner is the real stale case: close() would unlink the entry.
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `require("node:net").createServer().listen(${JSON.stringify(socketPath)}, () => { console.log("ready"); setInterval(() => {}, 1000); });`,
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    try {
      const reader = child.stdout.getReader();
      await reader.read();
      reader.releaseLock();
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
    expect(existsSync(socketPath)).toBe(true);

    const next = trackServer(createServer());
    const error = await rejection(secureUnixListen(next, socketPath));
    expect(errorCode(error)).toBe("EADDRINUSE");
    expect(existsSync(socketPath)).toBe(true);
  });

  // Genuinely concurrent: every bind is launched before any of them resolves.
  test("concurrent binds to one path elect exactly one owner", async () => {
    const dir = tempDir("hl-sock-race-");
    const socketPath = join(dir, "c.sock");
    const attempts = Array.from({ length: 6 }, () => trackServer(createServer()));
    const results = await Promise.allSettled(
      attempts.map((server) => secureUnixListen(server, socketPath)),
    );

    const winners = results.filter((result) => result.status === "fulfilled");
    expect(winners.length).toBe(1);
    for (const result of results) {
      if (result.status === "rejected") expect(errorCode(result.reason)).toBe("EADDRINUSE");
    }
    expect(attempts.filter((server) => server.listening).length).toBe(1);
    expect(lstatSync(socketPath).mode & 0o077).toBe(0);
  });

  // Regression: process.umask() is process-global and was held across an await,
  // so overlapping binds each captured the other's temporary 0o077 as "previous"
  // and restored that, stranding the process at 0o077.
  test("concurrent binds restore the process umask exactly once", async () => {
    const dir = tempDir("hl-sock-umask-race-");
    const marker = 0o022;
    const previous = process.umask(marker);
    try {
      const binds = Array.from({ length: 5 }, (_unused, index) =>
        secureUnixListen(trackServer(createServer()), join(dir, `c${index}.sock`)),
      );
      await Promise.all(binds);
      expect(sampleUmask()).toBe(marker);
    } finally {
      process.umask(previous);
    }
  });

  test("concurrent binds restore the umask even when some of them fail", async () => {
    const dir = tempDir("hl-sock-umask-mixed-");
    const socketPath = join(dir, "c.sock");
    const marker = 0o022;
    const previous = process.umask(marker);
    try {
      // All five race for one path: one wins, four reject with EADDRINUSE.
      const binds = Array.from({ length: 5 }, () =>
        secureUnixListen(trackServer(createServer()), socketPath),
      );
      const results = await Promise.allSettled(binds);
      expect(results.filter((result) => result.status === "fulfilled").length).toBe(1);
      expect(sampleUmask()).toBe(marker);
    } finally {
      process.umask(previous);
    }
  });

  // The Bun path is synchronous, so it can land inside an in-flight async window.
  test("a synchronous Bun bind nested in an async bind window keeps the baseline", async () => {
    const dir = tempDir("hl-sock-umask-mix-");
    const marker = 0o022;
    const previous = process.umask(marker);
    try {
      const asyncBind = secureUnixListen(trackServer(createServer()), join(dir, "a.sock"));
      const bunPath = join(dir, "b.sock");
      const bunServer = trackBunServer(
        secureBunUnixServe(bunPath, () =>
          Bun.serve({
            unix: bunPath,
            fetch() {
              return new Response("ok");
            },
          }),
        ),
      );
      await asyncBind;
      expect(lstatSync(bunPath).mode & 0o077).toBe(0);
      expect(sampleUmask()).toBe(marker);
      bunServer.stop(true);
    } finally {
      process.umask(previous);
    }
  });

  test("fails closed when the bound socket cannot be ownership-verified", async () => {
    const dir = tempDir("hl-sock-nogetuid-");
    const socketPath = join(dir, "c.sock");
    const server = trackServer(createServer());
    const original = process.getuid;
    const marker = 0o022;
    const previous = process.umask(marker);
    try {
      process.getuid = undefined;
      const error = await rejection(secureUnixListen(server, socketPath));
      expect(error).toBeInstanceOf(HeadlessError);
      expect((error as HeadlessError).message).toMatch(/getuid is unavailable/i);
      // Fail-closed refusal must still hand the umask back.
      expect(sampleUmask()).toBe(marker);
    } finally {
      process.getuid = original;
      process.umask(previous);
    }
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

  // The uid comparison is the only defence against a foreign-owned substitution,
  // so a platform that cannot report a uid must refuse, never skip the check.
  test("fails closed when process.getuid is unavailable", async () => {
    const dir = tempDir("hl-sock-guid-");
    const socketPath = join(dir, "c.sock");
    const server = trackServer(createServer());
    // Bind a genuinely owner-only socket first: the missing getuid is then the
    // only possible reason to refuse it.
    await secureUnixListen(server, socketPath);
    expect(() => assertSecureSocket(socketPath)).not.toThrow();

    const original = process.getuid;
    try {
      process.getuid = undefined;
      expect(() => assertSecureSocket(socketPath)).toThrow(HeadlessError);
      expect(() => assertSecureSocket(socketPath)).toThrow(/getuid is unavailable/i);
    } finally {
      process.getuid = original;
    }
    expect(() => assertSecureSocket(socketPath)).not.toThrow();
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

  // Regression: the created server was a local that the caller never receives,
  // so a throwing verification leaked a listener the fail-closed path could not
  // close — it refused the socket while leaving it accepting frames.
  test("stops the created server when verification refuses the socket", () => {
    const dir = tempDir("hl-bun-refuse-");
    // Verification targets a path the factory never binds, so assertSecureSocket
    // throws while the factory's server is already live.
    const verifiedPath = join(dir, "never-created.sock");
    const stops: boolean[] = [];
    expect(() =>
      secureBunUnixServe(verifiedPath, () => ({
        stop: (closeActiveConnections?: boolean) => {
          stops.push(closeActiveConnections === true);
        },
      })),
    ).toThrow(HeadlessError);
    expect(stops).toEqual([true]);
  });

  test("a refused real Bun listener is torn down, not leaked", () => {
    const dir = tempDir("hl-bun-leak-");
    const boundPath = join(dir, "bound.sock");
    const verifiedPath = join(dir, "other.sock");
    expect(() =>
      secureBunUnixServe(verifiedPath, () =>
        Bun.serve({
          unix: boundPath,
          fetch() {
            return new Response("ok");
          },
        }),
      ),
    ).toThrow(/unable to stat/i);
    // Bun unlinks the unix path on stop(), so a surviving entry means the
    // refused listener was never disposed.
    expect(existsSync(boundPath)).toBe(false);
  });

  test("refuses a second serve on a live socket path instead of taking it over", () => {
    const dir = tempDir("hl-bun-excl-");
    const socketPath = join(dir, "broker.sock");
    const first = trackBunServer(
      secureBunUnixServe(socketPath, () =>
        Bun.serve({
          unix: socketPath,
          fetch() {
            return new Response("first");
          },
        }),
      ),
    );
    const firstInode = lstatSync(socketPath).ino;

    let error: unknown = null;
    try {
      trackBunServer(
        secureBunUnixServe(socketPath, () =>
          Bun.serve({
            unix: socketPath,
            fetch() {
              return new Response("second");
            },
          }),
        ),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).not.toBeNull();
    expect(errorCode(error)).toBe("EADDRINUSE");
    // The original owner keeps the path: same inode, never unlinked underneath it.
    expect(lstatSync(socketPath).ino).toBe(firstInode);
    first.stop(true);
  });

  test("fails closed when process.getuid is unavailable", () => {
    const dir = tempDir("hl-bun-guid-");
    const socketPath = join(dir, "broker.sock");
    const original = process.getuid;
    const marker = 0o022;
    const previous = process.umask(marker);
    let created: { stop: (close?: boolean) => void } | null = null;
    try {
      process.getuid = undefined;
      expect(() =>
        secureBunUnixServe(socketPath, () => {
          created = trackBunServer(
            Bun.serve({
              unix: socketPath,
              fetch() {
                return new Response("ok");
              },
            }),
          );
          return created;
        }),
      ).toThrow(/getuid is unavailable/i);
      expect(created).not.toBeNull();
      expect(sampleUmask()).toBe(marker);
      // Refused ⇒ disposed, so Bun's unlink-on-stop removed the entry.
      expect(existsSync(socketPath)).toBe(false);
    } finally {
      process.getuid = original;
      process.umask(previous);
    }
  });
});
