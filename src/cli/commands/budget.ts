import type { DaemonMethod } from "../../daemon/protocol";
import { CliUsageError, daemonClient, flagArgsBeforeSeparator, getArg, printJson } from "../shared";

export type BudgetCommandCall = {
  method: Extract<DaemonMethod, `budget.${string}`>;
  params: Record<string, unknown>;
};

export function parseBudgetCommand(args: string[]): BudgetCommandCall {
  const action = args[1] ?? "list";
  if (action === "list") return { method: "budget.list", params: {} };
  if (action !== "upsert") throw new CliUsageError(budgetUsage());
  const id = getArg(args, "--id");
  if (!id) throw new CliUsageError(budgetUsage());
  return {
    method: "budget.upsert",
    params: compact({
      id,
      principal: getArg(args, "--principal"),
      sessionId: getArg(args, "--session-id"),
      workflowId: getArg(args, "--workflow-id"),
      provider: getArg(args, "--provider"),
      maxRequests: positiveInteger(args, "--max-requests"),
      maxInputTokens: positiveInteger(args, "--max-input-tokens"),
      maxOutputTokens: positiveInteger(args, "--max-output-tokens"),
      maxCostUsd: positiveNumber(args, "--max-cost-usd"),
      maxArtifactBytes: positiveInteger(args, "--max-artifact-bytes"),
      maxConcurrency: positiveInteger(args, "--max-concurrency"),
      maxRetries: nonnegativeInteger(args, "--max-retries"),
      expiresAt: positiveInteger(args, "--expires-at"),
    }),
  };
}

export async function runBudgetCommand(args: string[]) {
  const flags = flagArgsBeforeSeparator(args);
  const call = parseBudgetCommand(args);
  const client = await daemonClient(getArg(flags, "--cwd") || process.cwd(), flags);
  printJson(await client.call(call.method, call.params));
}

function positiveInteger(args: string[], flag: string) {
  const value = optionalNumber(args, flag);
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) throw new CliUsageError(`${flag} must be a positive safe integer.`);
  return value;
}

function nonnegativeInteger(args: string[], flag: string) {
  const value = optionalNumber(args, flag);
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) throw new CliUsageError(`${flag} must be a non-negative safe integer.`);
  return value;
}

function positiveNumber(args: string[], flag: string) {
  const value = optionalNumber(args, flag);
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) throw new CliUsageError(`${flag} must be a positive finite number.`);
  return value;
}

function optionalNumber(args: string[], flag: string) {
  const raw = getArg(args, flag);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new CliUsageError(`${flag} must be numeric.`);
  return value;
}

function compact(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function budgetUsage() {
  return "Usage: headless experimental budget <list|upsert> [--id id] [budget limits] [--cwd dir]";
}
