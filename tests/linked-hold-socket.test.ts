import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeadlessError } from "../src/runtime/headless-error";
import { inspectLinkedHoldOffline } from "../src/runtime/linked-hold-quarantine";
import { writeOwnerOnlyJson } from "../src/runtime/owner-json";
import { getProjectStatePaths } from "../src/runtime/project-state";

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("offline linked-hold lock socket", () => {
  test("creates the lock socket owner-only at creation even under a permissive umask", async () => {
    const fixture = lockFixture();
    const permissive = process.umask(0o000);
    const observed = recordUmaskWindow(fixture.paths.socketPath);
    const inspected = await inspectLinkedHoldOffline(fixture.projectRoot, fixture.linkId, fixture.stateOptions)
      .finally(() => {
        observed.restore();
        process.umask(permissive);
      });

    expect(inspected.linkId).toBe(fixture.linkId);
    // One balanced restrictive window around the bind: the socket must not exist
    // when it opens and must already be owner-only when it closes. A
    // listen-then-chmod bind never enters a window at all, so it records nothing.
    expect(observed.records.map((record) => record.mask)).toEqual([0o077, 0o000]);
    expect(observed.records[0]).toMatchObject({ exists: false });
    expect(observed.records[1]).toMatchObject({ exists: true, mode: 0o700, uid: process.getuid!() });
    expect(existsSync(fixture.paths.socketPath)).toBe(false);
  });

  test("refuses a second holder instead of stealing a live lock socket", async () => {
    const fixture = lockFixture();
    const holder = createServer((socket) => socket.destroy());
    await listen(holder, fixture.paths.socketPath);
    const held = lstatSync(fixture.paths.socketPath).ino;
    try {
      const failure = await inspectLinkedHoldOffline(fixture.projectRoot, fixture.linkId, fixture.stateOptions)
        .then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(HeadlessError);
      expect((failure as HeadlessError).code).toBe("DAEMON_ALREADY_RUNNING");
      // The live owner keeps its own socket inode and its listener.
      expect(lstatSync(fixture.paths.socketPath).ino).toBe(held);
      expect(await accepts(fixture.paths.socketPath)).toBe(true);
    } finally {
      await close(holder);
    }
  });

  test("reclaims a lock socket that a crashed holder left behind", async () => {
    const fixture = lockFixture();
    // secureUnixListen never unlinks (EADDRINUSE is the single-owner backstop),
    // so the caller must still clear a proven-dead entry itself. Renaming a live
    // socket reproduces a crashed holder in-process: close() would unlink it.
    const donorPath = join(fixture.paths.daemonRuntimeDir, "donor.sock");
    const donor = createServer((socket) => socket.destroy());
    await listen(donor, donorPath);
    renameSync(donorPath, fixture.paths.socketPath);
    await close(donor);
    expect(lstatSync(fixture.paths.socketPath).isSocket()).toBe(true);
    expect(await accepts(fixture.paths.socketPath)).toBe(false);

    const inspected = await inspectLinkedHoldOffline(fixture.projectRoot, fixture.linkId, fixture.stateOptions);
    expect(inspected.linkId).toBe(fixture.linkId);
    expect(existsSync(fixture.paths.socketPath)).toBe(false);
  });

  test("releases the lock socket when the guarded operation fails", async () => {
    const fixture = lockFixture();
    const failure = await inspectLinkedHoldOffline(fixture.projectRoot, "b".repeat(64), fixture.stateOptions)
      .then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(HeadlessError);
    expect((failure as HeadlessError).code).toBe("CONFLICT");
    expect(existsSync(fixture.paths.socketPath)).toBe(false);
  });
});

function lockFixture() {
  const root = mkdtempSync(join(tmpdir(), "headless-linked-lock-"));
  temporaryPaths.push(root);
  const projectRoot = join(root, "project");
  mkdirSync(projectRoot);
  // sockaddr_un caps the socket path, so the runtime home stays short.
  const runtimeRoot = join(tmpdir(), `hls-${process.pid}-${temporaryPaths.length}`);
  temporaryPaths.push(runtimeRoot);
  const stateOptions = { env: { HEADLESS_STATE_HOME: join(root, "state"), HEADLESS_RUNTIME_HOME: runtimeRoot } };
  const paths = getProjectStatePaths(projectRoot, stateOptions);
  // Tests that seed a socket bind before the recovery entry point runs need the
  // runtime home to exist already; ensureProjectStateDirectories only reaches it later.
  mkdirSync(paths.daemonRuntimeDir, { recursive: true, mode: 0o700 });
  const linkId = "a".repeat(64);
  // Minimal version-four state holding exactly one (deliberately unparsable)
  // link: inspection reports it as invalid instead of throwing, so the lock
  // lifecycle is what these tests observe.
  writeOwnerOnlyJson(paths.budgetsPath, {
    version: 4,
    projectId: paths.projectId,
    budgets: [],
    reservations: [],
    linkedHolds: [{ linkId }],
    manualRecoveries: [],
    updatedAt: Date.now(),
  });
  return { paths, stateOptions, linkId, projectRoot: paths.canonicalProjectRoot };
}

/**
 * The bind is the only moment the lock socket exists without the event loop
 * having yielded, so nothing outside the process can sample it there. The
 * restrictive umask the secure bind installs is the one in-process hook that
 * brackets that moment: record the socket at both edges of the window to prove
 * it was never world-accessible, not merely repaired by a later chmod.
 */
function recordUmaskWindow(socketPath: string) {
  const original = process.umask as (mask?: number) => number;
  const records: { mask: number; exists: boolean; mode: number | null; uid: number | null }[] = [];
  process.umask = ((mask?: number) => {
    if (mask === undefined) return original.call(process);
    const info = existsSync(socketPath) ? lstatSync(socketPath) : null;
    records.push({
      mask,
      exists: info !== null,
      mode: info ? info.mode & 0o777 : null,
      uid: info ? info.uid : null,
    });
    return original.call(process, mask);
  }) as typeof process.umask;
  return { records, restore: () => { process.umask = original as typeof process.umask; } };
}

function listen(server: Server, path: string) {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
}

function close(server: Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function accepts(path: string) {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection(path);
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}
