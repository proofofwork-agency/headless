#!/usr/bin/env bun

import { join } from "node:path";
import { resolveCommand } from "./cli/command-table";
import { parseCliInvocation, renderHelp } from "./cli/command-specs";
import { CliUsageError, handleSignal } from "./cli/shared";
import { toStructuredError } from "./runtime/headless-error";
import { isValidationError, validationErrorDetails, validationErrorMessage } from "./runtime/validation-error";

export { COMMAND_TABLE, resolveCommand } from "./cli/command-table";
export { COMMAND_SPECS, VALUE_FLAGS, parseCliInvocation, renderHelp, resolveCommandSpec } from "./cli/command-specs";
export { CLI_AUDIT_MANIFEST, auditManifestCommands } from "./cli/audit-manifest";
export { COMMAND_REGISTRY_VERSION, UNIFIED_COMMAND_REGISTRY } from "./command-registry";
export { mcpServerCommand, runMcpInstall } from "./cli/commands/mcp";
export { flagArgsBeforeSeparator, getPrompt, parseIntegerArg } from "./cli/shared";

async function main() {
  const args = process.argv.slice(2);
  const invocation = parseCliInvocation(args);
  if (invocation.kind === "help") {
    console.log(renderHelp(args[0] === "experimental" || args.includes("--experimental")));
    return;
  }
  if (invocation.kind === "version") {
    console.log(await readVersion());
    return;
  }
  if (invocation.kind === "unknown") {
    const knownExperimental = invocation.name ? resolveCommand(invocation.name) : undefined;
    throw new CliUsageError(knownExperimental
      ? `Command ${invocation.name} is experimental. Run headless experimental ${invocation.name} ...`
      : `Unknown command: ${invocation.name ?? "(none)"}. Run headless --help.`);
  }
  const command = resolveCommand(invocation.spec.name);
  if (!command) throw new Error(`CLI command ${invocation.spec.name} has no registered handler.`);
  await command.handler(args[0] === "experimental" ? args.slice(1) : args);
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
    const validation = isValidationError(error);
    const structured = toStructuredError(error, validation ? {
      code: "INVALID_REQUEST",
      safeMessage: validationErrorMessage(error),
      details: validationErrorDetails(error),
    } : {});
    const separator = process.argv.indexOf("--");
    const flagArgs = separator < 0 ? process.argv : process.argv.slice(0, separator);
    if (flagArgs.includes("--json")) {
      const errorValue = error instanceof CliUsageError
        ? toStructuredError(error, { code: "INVALID_REQUEST", safeMessage: error.message })
        : structured;
      console.log(JSON.stringify({ ok: false, error: errorValue }, null, 2));
    } else {
      console.error(validation
        ? structured.message
        : error instanceof Error
          ? error.message
          : structured.message);
    }
    process.exitCode = 1;
  });
}
