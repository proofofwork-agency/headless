import {
  CliUsageError,
  daemonClient,
  ensureSupportedPlatform,
  flagArgsBeforeSeparator,
  getArg,
  getRepeatedArgs,
  setActiveDaemon,
} from "../shared";
import { connectExistingDaemon } from "../../daemon/connect";
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
    const { HeadlessDaemon } = await import("../../daemon/server.js");
    const daemon = new HeadlessDaemon({
      projectRoot,
      extensionConfigPath: getArg(flags, "--extension-config"),
      extensionModules: getRepeatedArgs(flags, "--extension-module"),
      enableExperimentalSessions: flags.includes("--experimental-sessions"),
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
  if (action !== "status") throw new CliUsageError("Usage: headless daemon <serve|status|stop> [--cwd dir]");
  const client = await daemonClient(projectRoot, flags);
  console.log(JSON.stringify(await client.call("ping"), null, 2));
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
