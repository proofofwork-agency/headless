import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeadlessError } from "../src/runtime/headless-error";
import {
  socketElectionDatabasePath,
  withSocketElection,
} from "../src/runtime/socket-election";

const temporaryPaths: string[] = [];

afterEach(() => {
  while (temporaryPaths.length) rmSync(temporaryPaths.pop()!, { recursive: true, force: true });
});

describe("persistent socket election", () => {
  test("creates one owner-only database and never replaces it between elections", async () => {
    const socketPath = fixtureSocketPath();
    const databasePath = socketElectionDatabasePath(socketPath);

    await withSocketElection(socketPath, { busyMessage: "Election is busy." }, async () => {
      expect(existsSync(databasePath)).toBe(true);
      expect(lstatSync(databasePath).mode & 0o777).toBe(0o600);
    });

    // A dev+ino comparison cannot prove persistence: ext4 reused the socket
    // inode in 20,000/20,000 measured replacements. Put durable application-
    // foreign state in the database instead; delete-and-recreate loses it even
    // when the filesystem hands the replacement the same numeric identity.
    const writer = new Database(databasePath);
    writer.exec("CREATE TABLE persistence_probe (value TEXT NOT NULL)");
    writer.query("INSERT INTO persistence_probe VALUES (?)").run("survived");
    writer.close(false);

    await withSocketElection(socketPath, { busyMessage: "Election is busy." }, () => undefined);
    const reader = new Database(databasePath, { readonly: true });
    expect(reader.query<{ value: string }, []>("SELECT value FROM persistence_probe").get()).toEqual({ value: "survived" });
    reader.close(false);
    expect(existsSync(databasePath)).toBe(true);
  });

  test("serializes independent Bun processes and releases on close", async () => {
    const socketPath = fixtureSocketPath();

    const blocked = await withSocketElection(socketPath, { busyMessage: "Parent owns the election." }, () => {
      return runElectionChild(socketPath);
    });
    expect(blocked).toEqual({ exitCode: 0, output: { code: "DAEMON_ALREADY_RUNNING", retryable: true } });

    expect(await runElectionChild(socketPath)).toEqual({ exitCode: 0, output: "acquired" });
  });

  test("releases the cross-process election when its holder is killed", async () => {
    const socketPath = fixtureSocketPath();
    const child = spawnElectionHolder(socketPath);
    try {
      const reader = child.stdout.getReader();
      const ready = await reader.read();
      reader.releaseLock();
      expect(new TextDecoder().decode(ready.value).trim()).toBe("ready");

      const blocked = await withSocketElection(socketPath, { busyMessage: "Child owns the election." }, () => undefined)
        .then(() => null, (error: unknown) => error);
      expect(blocked).toMatchObject({ code: "DAEMON_ALREADY_RUNNING", retryable: true });

      child.kill("SIGKILL");
      await child.exited;
      await expect(withSocketElection(socketPath, { busyMessage: "Election is busy." }, () => "acquired"))
        .resolves.toBe("acquired");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited.catch(() => undefined);
    }
  });

  test("fails closed on corruption without invoking the socket operation", async () => {
    const socketPath = fixtureSocketPath();
    const databasePath = socketElectionDatabasePath(socketPath);
    writeFileSync(databasePath, "not a sqlite database", { mode: 0o600 });
    let called = false;

    const failure = await withSocketElection(socketPath, { busyMessage: "Election is busy." }, () => {
      called = true;
    }).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(HeadlessError);
    expect(failure).toMatchObject({ code: "INTERNAL_ERROR", retryable: false });
    expect(called).toBe(false);
    expect(readFileSync(databasePath, "utf8")).toBe("not a sqlite database");
    expect(existsSync(socketPath)).toBe(false);
  });
});

function fixtureSocketPath() {
  const root = mkdtempSync(join(tmpdir(), "headless-election-"));
  temporaryPaths.push(root);
  return join(root, "daemon.sock");
}

async function runElectionChild(socketPath: string) {
  const moduleUrl = new URL("../src/runtime/socket-election.ts", import.meta.url).href;
  const script = `
    import { withSocketElection } from ${JSON.stringify(moduleUrl)};
    try {
      await withSocketElection(${JSON.stringify(socketPath)}, { busyMessage: "Child found a busy election." }, () => undefined);
      console.log(JSON.stringify("acquired"));
    } catch (error) {
      console.log(JSON.stringify({ code: error?.code, retryable: error?.retryable }));
    }
  `;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    Bun.readableStreamToText(child.stdout),
    Bun.readableStreamToText(child.stderr),
  ]);
  if (stderr.trim()) throw new Error(`Election child wrote stderr: ${stderr.trim()}`);
  return { exitCode, output: JSON.parse(stdout.trim()) as unknown };
}

function spawnElectionHolder(socketPath: string) {
  const moduleUrl = new URL("../src/runtime/socket-election.ts", import.meta.url).href;
  const script = `
    import { withSocketElection } from ${JSON.stringify(moduleUrl)};
    await withSocketElection(${JSON.stringify(socketPath)}, { busyMessage: "Election is busy." }, async () => {
      console.log("ready");
      await new Promise(() => undefined);
    });
  `;
  return Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "ignore" });
}
