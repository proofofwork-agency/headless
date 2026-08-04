import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  canonicalTemporaryRoot,
  classifyDaemonProcess,
  parseDaemonProcessTable,
} from "../src/runtime/daemon-inventory";
import { countDaemonsForRoots, stopTrackedDaemons, trackDaemonProjectRoot } from "./support/daemon-teardown";
import { schedulingWindow, setTestTimeout } from "./support/timing";

setTestTimeout(20_000);

const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;
const roots: string[] = [];
const runtimeHomes: string[] = [];

afterAll(async () => {
  await stopTrackedDaemons();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
  while (runtimeHomes.length) rmSync(runtimeHomes.pop()!, { recursive: true, force: true });
});

/** Math.random is banned by source hygiene; the clock is enough for uniqueness. */
function runtimeSuffix() {
  return Date.now().toString(36).slice(-5);
}

describe("daemon process inventory", () => {
  test("matches only this user's daemon serve entrypoints", () => {
    const table = [
      "  4242   501 /usr/bin/bun /opt/headless/src/cli.ts daemon serve --cwd /tmp/alpha",
      "  4243   501 /usr/bin/bun /opt/headless/dist/cli.js daemon serve --cwd /tmp/beta",
      "  4244   502 /usr/bin/bun /opt/headless/src/cli.ts daemon serve --cwd /tmp/other-user",
      "  4245   501 /usr/bin/bun /opt/headless/src/cli.ts exec --cwd /tmp/not-a-daemon",
      "  4246   501 /usr/bin/grep daemon serve --cwd /tmp/impostor",
      "  4247   501 /usr/bin/bun /opt/headless/src/cli.ts daemon serve",
      "",
    ].join("\n");
    const entries = parseDaemonProcessTable(table, 501, 9_999);
    expect(entries.map((entry) => entry.pid)).toEqual([4242, 4243, 4247]);
    expect(entries[0]!.projectRoot).toBe("/tmp/alpha");
    expect(entries[1]!.projectRoot).toBe("/tmp/beta");
    // A daemon without --cwd cannot be attributed to a checkout.
    expect(entries[2]!.projectRoot).toBeNull();
  });

  test("never reports the scanning process itself", () => {
    const table = "  7777   501 /usr/bin/bun /opt/headless/src/cli.ts daemon serve --cwd /tmp/self\n";
    expect(parseDaemonProcessTable(table, 501, 7_777)).toEqual([]);
  });

  test("classifies missing, disposable, and resident roots", () => {
    const temporaryRoot = "/tmp/disposable";
    const exists = (path: string) => path !== "/tmp/gone";
    const missing = classifyDaemonProcess({ pid: 1, projectRoot: "/tmp/gone", entrypoint: "cli.ts" }, { temporaryRoot, exists, canonicalize: (path) => path });
    const disposable = classifyDaemonProcess({ pid: 2, projectRoot: "/tmp/disposable/p", entrypoint: "cli.ts" }, { temporaryRoot, exists, canonicalize: (path) => path });
    const resident = classifyDaemonProcess({ pid: 3, projectRoot: "/srv/checkout", entrypoint: "cli.ts" }, { temporaryRoot, exists, canonicalize: (path) => path });
    const rootless = classifyDaemonProcess({ pid: 4, projectRoot: null, entrypoint: "cli.ts" }, { temporaryRoot, exists, canonicalize: (path) => path });
    expect([missing.reason, disposable.reason, resident.reason, rootless.reason])
      .toEqual(["missing-root", "disposable-root", "resident", "missing-root"]);
    expect([missing.strayed, disposable.strayed, resident.strayed, rootless.strayed]).toEqual([true, true, false, true]);
  });

  test("does not treat a checkout that merely shares a temp prefix as disposable", () => {
    const classified = classifyDaemonProcess(
      { pid: 5, projectRoot: "/tmp/disposable-sibling/project", entrypoint: "cli.ts" },
      { temporaryRoot: "/tmp/disposable", exists: () => true },
    );
    expect(classified.reason).toBe("resident");
  });
});

describe("bootstrapped daemon lifecycle", () => {
  /**
   * The regression this suite exists for: a CLI command that reaches the
   * control plane leaves a detached daemon behind, and nothing ever reaps it.
   * Every disposable project root used by the suite must return to zero.
   */
  test("returns to a zero daemon baseline after the fixture drains", async () => {
    const root = mkdtempSync(join(tmpdir(), "headless-leak-"));
    roots.push(root);
    const project = trackDaemonProjectRoot(join(root, "project"));
    const state = join(root, "state");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "marker.txt"), "leak\n");

    expect(countDaemonsForRoots([project])).toBe(0);
    // sockaddr_un caps the socket path near 104 bytes, so the runtime home has
    // to stay short — a temp-rooted path plus the project id overruns it.
    const runtimeHome = `/tmp/hr-${process.pid}-${runtimeSuffix()}`;
    runtimeHomes.push(runtimeHome);
    const init = await runCli(["init", "--cwd", project], {
      HEADLESS_STATE_HOME: state,
      HOME: join(root, "home"),
      HEADLESS_RUNTIME_HOME: runtimeHome,
    });
    expect(init.exitCode, init.stderr).toBe(0);
    expect(countDaemonsForRoots([project])).toBe(1);

    const signalled = await stopTrackedDaemons(schedulingWindow(15_000));
    expect(signalled.length).toBe(1);
    expect(countDaemonsForRoots([project])).toBe(0);
  }, 60_000);

  test("exits on its own once the idle deadline passes", async () => {
    const fixture = idleFixture("headless-idle-exit-");
    const daemon = spawnDaemon(fixture, ["--idle-timeout-ms", String(IDLE_MS)]);
    let exitCode: number | "timeout";
    try {
      await waitForDaemonReady(daemon);
      exitCode = await Promise.race([
        daemon.exited,
        Bun.sleep(schedulingWindow(20_000)).then(() => "timeout" as const),
      ]);
    } finally {
      // Idle shutdown is the behaviour under test, so on the happy path this is
      // already gone; it matters when readiness throws or the watchdog does not
      // fire, which is exactly the failure that would otherwise leak.
      if (!daemon.killed) daemon.kill("SIGTERM");
      await daemon.exited;
    }
    expect(exitCode).toBe(0);
  }, 60_000);

  test("stays resident while a client keeps using it", async () => {
    const fixture = idleFixture("headless-idle-busy-");
    const daemon = spawnDaemon(fixture, ["--idle-timeout-ms", String(BUSY_IDLE_MS)]);
    try {
      await waitForDaemonReady(daemon);
      // Outlast the idle window while pinging: activity must reset the deadline.
      const deadline = Date.now() + BUSY_IDLE_MS * 3;
      while (Date.now() < deadline) {
        const ping = await runCli(["daemon", "status", "--cwd", fixture.project], fixture.env);
        expect(ping.exitCode, ping.stderr).toBe(0);
        await Bun.sleep(BUSY_IDLE_MS / 4);
      }
      expect(daemon.killed).toBe(false);
    } finally {
      // A failing assertion above must not also leak the daemon: the failure
      // would then surface later as a stray with no link to this fixture.
      daemon.kill("SIGTERM");
      await daemon.exited;
    }
  }, 60_000);

  test("never arms the watchdog when the operator opts out", async () => {
    const fixture = idleFixture("headless-idle-optout-");
    const daemon = spawnDaemon(fixture, ["--no-idle-timeout"]);
    try {
      await waitForDaemonReady(daemon);
      const outcome = await Promise.race([
        daemon.exited.then((code) => `exited:${code}`),
        Bun.sleep(IDLE_MS * 3).then(() => "resident" as const),
      ]);
      expect(outcome).toBe("resident");
    } finally {
      // This daemon opted out of the idle watchdog, so nothing will ever
      // reclaim it on its own. Leaking it here is permanent.
      daemon.kill("SIGTERM");
      await daemon.exited;
    }
  }, 60_000);

  test("classifies a suite fixture root as disposable so reaping can find it", () => {
    const root = mkdtempSync(join(tmpdir(), "headless-leak-classify-"));
    roots.push(root);
    const classified = classifyDaemonProcess(
      { pid: process.pid, projectRoot: root, entrypoint: "cli.ts" },
      { temporaryRoot: canonicalTemporaryRoot() },
    );
    expect(classified.reason).toBe("disposable-root");
    expect(classified.strayed).toBe(true);
  });
});

const IDLE_MS = 2_000;

/**
 * The busy-loop test's daemon has to outlive a single ping, and every ping is a
 * cold `bun src/cli.ts` process — roughly 500ms locally and several times that
 * on a loaded or CI machine. Against a flat 2s deadline, one slow ping lets the
 * daemon idle out between pings and the next reports "No Headless daemon is
 * running": a real product-failure signature produced entirely by machine load.
 * Scaling the deadline keeps what the test actually asserts — that activity
 * resets it — while giving each ping the same headroom everywhere.
 *
 * Capped because the loop runs for three of these and has to finish inside the
 * test's own budget — scaling without a ceiling is how a widened window becomes
 * unreachable, which is the defect this file's sibling fix exists for. Beyond a
 * few seconds of headroom a ping is not slow, the machine is broken.
 */
const BUSY_IDLE_MS = Math.min(schedulingWindow(2_000), 6_000);

function idleFixture(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  const project = trackDaemonProjectRoot(join(root, "project"));
  mkdirSync(project, { recursive: true });
  const runtimeHome = `/tmp/hr-${process.pid}-${runtimeSuffix()}`;
  runtimeHomes.push(runtimeHome);
  return {
    project,
    env: {
      HEADLESS_STATE_HOME: join(root, "state"),
      HOME: join(root, "home"),
      HEADLESS_RUNTIME_HOME: runtimeHome,
    },
  };
}

function spawnDaemon(fixture: ReturnType<typeof idleFixture>, extraArgs: string[]) {
  return Bun.spawn(["bun", cliPath, "daemon", "serve", "--cwd", fixture.project, ...extraArgs], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...processEnv(), ...fixture.env },
  });
}

async function waitForDaemonReady(daemon: ReturnType<typeof Bun.spawn>) {
  const decoder = new TextDecoder();
  let text = "";
  const scan = (async () => {
    for await (const chunk of daemon.stderr as ReadableStream<Uint8Array>) {
      text += decoder.decode(chunk, { stream: true });
      if (text.includes("Headless daemon ready")) return;
    }
  })();
  await Promise.race([
    scan,
    daemon.exited.then((code) => { throw new Error(`daemon exited before readiness with ${code}: ${text}`); }),
    Bun.sleep(schedulingWindow(15_000)).then(() => { throw new Error(`daemon readiness timed out: ${text}`); }),
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
