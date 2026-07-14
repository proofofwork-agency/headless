import {
  DEFAULT_RUN_TIMEOUT_MS,
  backendUsage,
  CliUsageError,
  daemonClient,
  flagArgsBeforeSeparator,
  getArg,
  getApprovalPolicy,
  getAuthMode,
  getMode,
  getPrompt,
  parseBackend,
  parseContainment,
  parseIntegerArg,
  printRunResult,
  submitAndWait,
} from "../shared";

export async function runExecCommand(args: string[]) {
  const flags = flagArgsBeforeSeparator(args);
  const projectRoot = getArg(flags, "--cwd") || process.cwd();
  const backend = parseBackend(getArg(flags, "--backend") || "opencode");
  const prompt = getPrompt(args);
  if (!prompt) throw new CliUsageError(`Usage: headless exec --backend <${backendUsage()}> "your prompt"`);
  const timeoutMs = parseIntegerArg(flags, "--timeout-ms") ?? DEFAULT_RUN_TIMEOUT_MS;
  const containment = parseContainment(flags);
  const client = await daemonClient(projectRoot, flags);
  const result = await submitAndWait(client, {
    backend,
    prompt,
    model: getArg(flags, "--model"),
    agent: getArg(flags, "--agent"),
    mode: getMode(flags),
    timeoutMs,
    sessionId: getArg(flags, "--session-id"),
    containment,
    authMode: getAuthMode(flags),
    approvalPolicy: getApprovalPolicy(flags),
  });
  printRunResult(result, flags.includes("--json") || flags.includes("-j"), flags.includes("--stream"));
  process.exitCode = result.status === "succeeded" ? 0 : 1;
}
