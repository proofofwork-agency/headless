import type { DaemonMethod } from "../../daemon/protocol";
import { CliUsageError, daemonClient, flagArgsBeforeSeparator, getArg, printJson, requiredArg } from "../shared";

export type CandidateCommandCall = {
  method: Extract<DaemonMethod, `candidate.${string}`>;
  params: Record<string, unknown>;
};

export function parseCandidateCommand(args: string[]): CandidateCommandCall {
  const action = args[1] ?? "inspect";
  if (action !== "inspect" && action !== "integrate" && action !== "reject") {
    throw new CliUsageError("Usage: headless candidate <inspect|integrate|reject> --candidate-id id");
  }
  return {
    method: action === "inspect" ? "candidate.inspect" : action === "integrate" ? "candidate.integrate" : "candidate.reject",
    params: { candidateId: requiredArg(flagArgsBeforeSeparator(args), "--candidate-id") },
  };
}

export async function runCandidateCommand(args: string[]) {
  const flags = flagArgsBeforeSeparator(args);
  const call = parseCandidateCommand(args);
  const client = await daemonClient(getArg(flags, "--cwd") || process.cwd(), flags);
  const result = await client.call<Record<string, unknown>>(call.method, call.params);
  printJson(result);
  if (call.method === "candidate.integrate") {
    const outcome = typeof result.outcome === "string" ? result.outcome : "";
    process.exitCode = outcome === "merged_fast_forward" || outcome === "merged_advanced" || outcome === "recovered_applied" ? 0 : 1;
  }
}
