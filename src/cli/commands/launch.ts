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
  const target = args[1];
  if (target === "opencode-serve") {
    throw new CliUsageError("`headless launch opencode-serve` was removed in v0.2 because it bypasses daemon containment.");
  }
  const backend = parseBackend(target || "");
  const flags = flagArgsBeforeSeparator(args);
  const prompt = getPrompt(["launch", ...args.slice(2)]) || "Respond with ready.";
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
