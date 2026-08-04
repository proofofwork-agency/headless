import type { CouncilRecord } from "../../runtime/council-store";
import {
  DEFAULT_RUN_TIMEOUT_MS,
  CliUsageError,
  boundedCouncilTimeout,
  boundedGateTimeout,
  daemonClient,
  flagArgsBeforeSeparator,
  getArg,
  getApprovalPolicy,
  getAuthMode,
  getMode,
  getPrompt,
  getRepeatedArgs,
  parseBackend,
  parseIntegerArg,
} from "../shared";

export async function runGateCommand(args: string[]) {
  const flags = flagArgsBeforeSeparator(args);
  const timeoutMs = parseIntegerArg(flags, "--timeout-ms") ?? 120_000;
  const checks = getRepeatedArgs(flags, "--check");
  const client = await daemonClient(getArg(flags, "--cwd") || process.cwd(), flags);
  const report = await client.call<{ ok: boolean }>("gate.run", {
    checks: checks.length ? checks : undefined,
    timeoutMs,
    sessionId: getArg(flags, "--session-id"),
  }, boundedGateTimeout(timeoutMs, checks.length || 2));
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}

export async function runCouncilCommand(args: string[]) {
  const flags = flagArgsBeforeSeparator(args);
  if (flags.includes("--unsafe-no-sandbox")) throw new CliUsageError("Councils prohibit --unsafe-no-sandbox.");
  const question = getPrompt(args) || "Improve project structure using a reviewed multi-agent council.";
  const timeoutMs = parseIntegerArg(flags, "--timeout-ms") ?? DEFAULT_RUN_TIMEOUT_MS;
  const agents = getRepeatedArgs(flags, "--agent");
  const client = await daemonClient(getArg(flags, "--cwd") || process.cwd(), flags);
  const result = await client.call<CouncilRecord>("council.run", {
    question,
    agents: agents.length ? agents.map(parseBackend) : undefined,
    mode: getMode(flags),
    containment: "required",
    authMode: getAuthMode(flags),
    approvalPolicy: getApprovalPolicy(flags),
    timeoutMs,
  }, boundedCouncilTimeout(timeoutMs, Math.max(agents.length, 3)));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.decision?.approved ? 0 : 1;
}
