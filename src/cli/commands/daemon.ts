import {
  CliUsageError,
  daemonClient,
  ensureSupportedPlatform,
  flagArgsBeforeSeparator,
  getArg,
  getRepeatedArgs,
  setActiveDaemon,
} from "../shared";

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
    });
    await daemon.start();
    setActiveDaemon(daemon);
    console.error(`Headless daemon ready for ${daemon.state.canonicalProjectRoot}`);
    process.stdin.resume();
    return;
  }
  if (action !== "status") throw new CliUsageError("Usage: headless daemon <serve|status> [--cwd dir]");
  const client = await daemonClient(projectRoot, flags);
  console.log(JSON.stringify(await client.call("ping"), null, 2));
}
