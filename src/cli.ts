#!/usr/bin/env bun

import { join } from "node:path";
import { resolveCommand } from "./cli/command-table";
import { parseCliInvocation, renderInvocationHelp } from "./cli/command-specs";
import { validateCommandFlags } from "./cli/argv";
import { printRemedy } from "./cli/remedy";
import { CliUsageError, getArg, handleSignal } from "./cli/shared";
import { toStructuredError } from "./runtime/headless-error";
import { isValidationError, validationErrorDetails, validationErrorMessage } from "./runtime/validation-error";

export { COMMAND_TABLE, resolveCommand } from "./cli/command-table";
export { COMMAND_SPECS, VALUE_FLAGS, parseCliInvocation, renderCommandUsage, renderHelp, renderInvocationHelp, resolveCommandSpec } from "./cli/command-specs";
export { parseCommandArgv, resolveCommandAction, validateCommandFlags } from "./cli/argv";
export { CLI_AUDIT_MANIFEST, auditManifestCommands } from "./cli/audit-manifest";
export { COMMAND_REGISTRY_VERSION, UNIFIED_COMMAND_REGISTRY } from "./command-registry";
export { mcpServerCommand, runMcpInstall } from "./cli/commands/mcp";
export { flagArgsBeforeSeparator, getPrompt, parseIntegerArg } from "./cli/shared";

async function main() {
  const args = process.argv.slice(2);
  const invocation = parseCliInvocation(args);
  if (invocation.kind === "help") {
    console.log(renderInvocationHelp(args));
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
  // Validate against the resolved command's own flags, after the experimental
  // namespace is stripped so argv[0] is the command, and before the handler so
  // a typo cannot be read as a subcommand.
  const commandArgs = args[0] === "experimental" ? args.slice(1) : args;
  validateCommandFlags(commandArgs);
  await command.handler(commandArgs);
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
    // A CliUsageError is operator input, not a runtime fault. Classify it once
    // here so text and --json agree: deriving it only in the --json branch let
    // text mode fall through to INTERNAL_ERROR and send typos to `daemon status`.
    const structured = toStructuredError(error, error instanceof CliUsageError ? {
      code: "INVALID_REQUEST",
      safeMessage: error.message,
    } : validation ? {
      code: "INVALID_REQUEST",
      safeMessage: validationErrorMessage(error),
      details: validationErrorDetails(error),
    } : {});
    const separator = process.argv.indexOf("--");
    const flagArgs = separator < 0 ? process.argv : process.argv.slice(0, separator);
    if (flagArgs.includes("--json")) {
      console.log(JSON.stringify({ ok: false, error: structured }, null, 2));
    } else {
      console.error(validation
        ? structured.message
        : error instanceof Error
          ? error.message
          : structured.message);
      // The renderer must never fault on the error it is rendering: getArg
      // throws CliUsageError for a malformed --cwd, and that would escape the
      // catch uncaught, replacing the remedy with a raw stack trace.
      let cwd = process.cwd();
      try {
        cwd = getArg(flagArgs, "--cwd") || cwd;
      } catch {
        // Keep process.cwd(); the remedy is advisory, never worth a crash.
      }
      printRemedy(structured.code, structured.message, cwd);
    }
    process.exitCode = 1;
  });
}
