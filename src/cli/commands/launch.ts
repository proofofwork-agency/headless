import { resolveCommandAction } from "../argv";
import { renderCommandUsage } from "../command-specs";
import {
  DEFAULT_RUN_TIMEOUT_MS,
  CliUsageError,
  daemonClient,
  flagArgsBeforeSeparator,
  getArg,
  getApprovalPolicy,
  getAuthMode,
  getPrompt,
  parseBackend,
  parseContainment,
  parseIntegerArg,
  printRunResult,
  submitAndWait,
} from "../shared";

export async function runLaunchCommand(args: string[]) {
  const { action: target, argvWithoutAction } = resolveCommandAction(args);
  if (target === "opencode-serve") {
    throw new CliUsageError("`headless experimental launch opencode-serve` was removed in v0.2 because it bypasses daemon containment.");
  }
  // Fail on the missing backend before any daemon starts; parseBackend("") used
  // to report an invalid --backend for an argument the operator never passed.
  if (!target) throw new CliUsageError(renderCommandUsage("launch"));
  const backend = parseBackend(target);
  const flags = flagArgsBeforeSeparator(args);
  const prompt = getPrompt(argvWithoutAction) || "Respond with ready.";
  const timeoutMs = parseIntegerArg(flags, "--timeout-ms") ?? DEFAULT_RUN_TIMEOUT_MS;
  const client = await daemonClient(getArg(flags, "--cwd") || process.cwd(), flags);
  const result = await submitAndWait(client, {
    backend,
    prompt,
    mode: "read-only",
    timeoutMs,
    containment: parseContainment(flags),
    authMode: getAuthMode(flags),
    approvalPolicy: getApprovalPolicy(flags),
  });
  printRunResult(result, flags.includes("--json") || flags.includes("-j"), false);
  process.exitCode = result.status === "succeeded" ? 0 : 1;
}
