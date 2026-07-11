#!/usr/bin/env bun

import { join } from "node:path";
import { resolveCommand } from "./cli/command-table";
import { parseCliInvocation, renderHelp } from "./cli/command-specs";
import { CliUsageError, handleSignal } from "./cli/shared";

export { COMMAND_TABLE, resolveCommand } from "./cli/command-table";
export { COMMAND_SPECS, VALUE_FLAGS, parseCliInvocation, renderHelp, resolveCommandSpec } from "./cli/command-specs";
export { mcpServerCommand, runMcpInstall } from "./cli/commands/mcp";
export { flagArgsBeforeSeparator, getPrompt, parseIntegerArg } from "./cli/shared";

async function main() {
  const args = process.argv.slice(2);
  const invocation = parseCliInvocation(args);
  if (invocation.kind === "help") {
    console.log(renderHelp());
    return;
  }
  if (invocation.kind === "version") {
    console.log(await readVersion());
    return;
  }
  if (invocation.kind === "unknown") {
    throw new CliUsageError(`Unknown command: ${invocation.name ?? "(none)"}. Run headless --help.`);
  }
  const command = resolveCommand(invocation.spec.name);
  if (!command) throw new Error(`CLI command ${invocation.spec.name} has no registered handler.`);
  await command.handler(args);
}

async function readVersion() {
  try {
    return String(JSON.parse(await Bun.file(join(import.meta.dir, "..", "package.json")).text()).version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

if (import.meta.main) {
  process.once("SIGINT", () => void handleSignal("SIGINT"));
  process.once("SIGTERM", () => void handleSignal("SIGTERM"));
  process.once("SIGHUP", () => void handleSignal("SIGHUP"));
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
