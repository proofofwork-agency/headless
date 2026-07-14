import { CliUsageError, daemonClient, flagArgsBeforeSeparator, getArg } from "../shared";

export async function runLedgerCommand(args: string[]) {
  const flags = flagArgsBeforeSeparator(args);
  if (flags[1] !== "repair-tail" || !flags.includes("--confirm")) {
    throw new CliUsageError("Usage: headless experimental ledger repair-tail --confirm [--cwd dir]");
  }
  const client = await daemonClient(getArg(flags, "--cwd") || process.cwd(), flags);
  console.log(JSON.stringify(await client.call("ledger.repairTail", { confirm: true }), null, 2));
}
