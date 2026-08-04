import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { countDaemonsForRoots, stopTrackedDaemons, trackDaemonProjectRoot } from "./support/daemon-teardown";
import { schedulingWindow } from "./support/timing";

const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;
const roots: string[] = [];

afterAll(async () => {
  await stopTrackedDaemons();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("read-only daemon status", () => {
  test("never bootstraps a daemon for either stable status command", async () => {
    const fixture = createFixture("headless-status-absent-");

    expect(countDaemonsForRoots([fixture.project])).toBe(0);
    for (const command of [["status"], ["daemon", "status"]]) {
      const result = await runCli([...command, "--cwd", fixture.project], fixture.env);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`No Headless daemon is running for ${fixture.project}.`);
      expect(countDaemonsForRoots([fixture.project])).toBe(0);
    }
  });

  test("reports through an explicitly started daemon without changing the response", async () => {
    const fixture = createFixture("headless-status-running-");
    const daemon = Bun.spawn(["bun", cliPath, "daemon", "serve", "--cwd", fixture.project], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...processEnv(), ...fixture.env },
    });
    await waitForDaemonReady(daemon);

    const daemonStatus = await runCli(["daemon", "status", "--cwd", fixture.project], fixture.env);
    expect(daemonStatus.exitCode, daemonStatus.stderr).toBe(0);
    expect(JSON.parse(daemonStatus.stdout).projectRoot).toBe(realpathSync(fixture.project));

    const status = await runCli(["status", "--cwd", fixture.project], fixture.env);
    expect(status.exitCode, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout).daemon.projectRoot).toBe(realpathSync(fixture.project));
  }, 30_000);
});

function createFixture(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  const project = trackDaemonProjectRoot(join(root, "project"));
  mkdirSync(project);
  return {
    project,
    env: {
      HEADLESS_STATE_HOME: join(root, "state"),
      HOME: join(root, "home"),
    },
  };
}

async function waitForDaemonReady(daemon: ReturnType<typeof Bun.spawn>) {
  const decoder = new TextDecoder();
  let stderr = "";
  const ready = (async () => {
    for await (const chunk of daemon.stderr as ReadableStream<Uint8Array>) {
      stderr += decoder.decode(chunk, { stream: true });
      if (stderr.includes("Headless daemon ready")) return;
    }
  })();
  await Promise.race([
    ready,
    daemon.exited.then((exitCode) => { throw new Error(`daemon exited before readiness with ${exitCode}: ${stderr}`); }),
    Bun.sleep(schedulingWindow(10_000)).then(() => { throw new Error(`daemon readiness timed out: ${stderr}`); }),
  ]);
}

async function runCli(args: string[], extraEnv: Record<string, string>) {
  const child = Bun.spawn(["bun", cliPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...processEnv(), ...extraEnv },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    Bun.readableStreamToText(child.stdout),
    Bun.readableStreamToText(child.stderr),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function processEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}
