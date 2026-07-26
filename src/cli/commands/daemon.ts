import {
  CliUsageError,
  daemonClient,
  ensureSupportedPlatform,
  flagArgsBeforeSeparator,
  getArg,
  getRepeatedArgs,
  parseIntegerArg,
  setActiveDaemon,
} from "../shared";
import { connectExistingDaemon } from "../../daemon/connect";
import { listDaemonInventory } from "../../runtime/daemon-inventory";
import { HeadlessError } from "../../runtime/headless-error";
import { existsSync } from "node:fs";
import { basename } from "node:path";

const DAEMON_STOP_TIMEOUT_MS = 35_000;

export async function runDaemonCommand(args: string[]) {
  const action = args[1] || "status";
  const flags = flagArgsBeforeSeparator(args);
  const projectRoot = getArg(flags, "--cwd") || process.cwd();
  ensureSupportedPlatform();
  if (action === "serve" || action === "start") {
    const { HeadlessDaemon, DEFAULT_DAEMON_IDLE_TIMEOUT_MS } = await import("../../daemon/server.js");
    const idleTimeoutMs = flags.includes("--no-idle-timeout")
      ? 0
      : parseIntegerArg(flags, "--idle-timeout-ms") ?? DEFAULT_DAEMON_IDLE_TIMEOUT_MS;
    const daemon = new HeadlessDaemon({
      projectRoot,
      extensionConfigPath: getArg(flags, "--extension-config"),
      extensionModules: getRepeatedArgs(flags, "--extension-module"),
      enableExperimentalSessions: flags.includes("--experimental-sessions"),
      idleTimeoutMs,
      onIdleShutdown: () => { void shutdownIdleDaemon(daemon, idleTimeoutMs); },
    });
    await daemon.start();
    setActiveDaemon(daemon);
    console.error(`Headless daemon ready for ${daemon.state.canonicalProjectRoot}`);
    process.stdin.resume();
    return;
  }
  if (action === "stop") {
    const client = await connectExistingDaemon({
      projectRoot,
      extensionConfigPath: getArg(flags, "--extension-config"),
      extensionModules: getRepeatedArgs(flags, "--extension-module"),
    });
    if (!client) {
      throw new HeadlessError("DAEMON_UNAVAILABLE", `No Headless daemon is running for ${projectRoot}.`);
    }
    const ping = await client.call<{ runtime?: { pid?: unknown; entrypoint?: unknown } }>("ping", {}, 2_000);
    const pid = ping.runtime?.pid;
    if (!Number.isSafeInteger(pid) || Number(pid) <= 1 || Number(pid) === process.pid) {
      throw new HeadlessError("DAEMON_UNAVAILABLE", "The running daemon did not report a safe owner process id.");
    }
    const entrypoint = ping.runtime?.entrypoint;
    if (typeof entrypoint !== "string" || !["cli.js", "cli.ts"].includes(basename(entrypoint))) {
      throw new HeadlessError(
        "POLICY_DENIED",
        "The project daemon is embedded in another host process; stop it through that host instead of signaling the entire process.",
      );
    }
    signalDaemonOwner(Number(pid));
    await waitForDaemonSocketRemoval(client.state.socketPath);
    console.log(JSON.stringify({ stopped: true, pid }, null, 2));
    return;
  }
  if (action === "reap") return runDaemonReap(flags);
  if (action !== "status") throw new CliUsageError("Usage: headless daemon <serve|status|stop|reap> [--cwd dir]");
  const client = await daemonClient(projectRoot, flags);
  console.log(JSON.stringify(await client.call("ping"), null, 2));
}

/**
 * Reports every daemon this user owns and, once confirmed, signals the stray
 * ones. Reaping is never automatic: a resident daemon is a live control plane
 * for a real checkout, so only disposable and root-less daemons are candidates
 * unless the operator explicitly widens the selection.
 */
async function runDaemonReap(flags: string[]) {
  const inventory = listDaemonInventory();
  const all = flags.includes("--all");
  const candidates = inventory.filter((entry) => all || entry.strayed);
  const report = {
    scanned: inventory.length,
    candidates: candidates.length,
    selection: all ? "all" : "strayed",
    daemons: inventory.map((entry) => ({
      pid: entry.pid,
      projectRoot: entry.projectRoot,
      reason: entry.reason,
      selected: all || entry.strayed,
    })),
  };
  if (!flags.includes("--confirm")) {
    console.log(JSON.stringify({ ...report, reaped: [], confirmed: false }, null, 2));
    console.error(`Re-run with --confirm to stop ${candidates.length} daemon(s).`);
    return;
  }
  const reaped: Array<{ pid: number; stopped: boolean; error?: string }> = [];
  for (const entry of candidates) {
    try {
      signalDaemonOwner(entry.pid);
      reaped.push({ pid: entry.pid, stopped: true });
    } catch (error) {
      reaped.push({ pid: entry.pid, stopped: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  console.log(JSON.stringify({ ...report, reaped, confirmed: true }, null, 2));
  process.exitCode = reaped.some((entry) => !entry.stopped) ? 1 : 0;
}

/**
 * The watchdog only fires on a quiescent daemon, so a clean stop is expected.
 * Failures propagate back to the watchdog, which records the diagnostic, keeps
 * the daemon resident, and retries after another idle window.
 */
async function shutdownIdleDaemon(daemon: { stop: () => Promise<void> }, idleTimeoutMs: number) {
  await daemon.stop();
  console.error(`Headless daemon exited after ${idleTimeoutMs}ms idle.`);
  process.exit(0);
}

function signalDaemonOwner(pid: number) {
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ESRCH") throw new HeadlessError("DAEMON_UNAVAILABLE", "The Headless daemon exited before it could be stopped.");
    if (code === "EPERM") throw new HeadlessError("POLICY_DENIED", `Permission was denied while signaling daemon process ${pid}.`);
    throw new HeadlessError("DAEMON_UNAVAILABLE", `Unable to signal daemon process ${pid}.`, { cause: error });
  }
}

async function waitForDaemonSocketRemoval(socketPath: string) {
  const deadline = Date.now() + DAEMON_STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!existsSync(socketPath)) return;
    await Bun.sleep(50);
  }
  throw new HeadlessError(
    "DAEMON_UNAVAILABLE",
    "The daemon did not finish its graceful shutdown within 35 seconds; inspect active jobs and retry.",
    { retryable: true },
  );
}
