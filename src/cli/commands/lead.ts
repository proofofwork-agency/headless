import { CliUsageError, daemonClient, flagArgsBeforeSeparator, getArg, printJson } from "../shared";

export async function runLeadCommand(args: string[]) {
  const action = args[1] ?? "status";
  const flags = flagArgsBeforeSeparator(args);
  const client = await daemonClient(getArg(flags, "--cwd") || process.cwd(), flags);
  if (action === "status") {
    printJson(await client.call("lead.status"));
    return;
  }
  if (action === "release") {
    printJson(await client.call("lead.release"));
    return;
  }
  if (action === "use") {
    const host = args[2]?.trim().toLowerCase();
    if (!host || host.startsWith("-")) throw new CliUsageError("Usage: headless lead use <host> [--cwd dir]");
    printJson(await client.call("lead.use", { host }));
    return;
  }
  throw new CliUsageError("Usage: headless lead <use <host>|status|release> [--cwd dir]");
}
