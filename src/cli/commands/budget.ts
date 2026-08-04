import type { DaemonMethod } from "../../daemon/protocol";
import { inspectLinkedHoldOffline, quarantineLinkedHoldOffline } from "../../runtime/linked-hold-quarantine";
import { resolveCommandAction } from "../argv";
import { renderCommandUsage } from "../command-specs";
import { CliUsageError, daemonClient, flagArgsBeforeSeparator, getArg, getRepeatedArgs, printJson } from "../shared";

export type BudgetCommandCall = {
  method: Extract<DaemonMethod, `budget.${string}`>;
  params: Record<string, unknown>;
} | {
  offline: "inspect";
  linkId: string;
} | {
  offline: "quarantine";
  linkId: string;
  expectedDigest: string;
  resolution: "exhaust" | "release";
  confirm: boolean;
};

export function parseBudgetCommand(args: string[]): BudgetCommandCall {
  const { action, operands } = resolveCommandAction(args, "list");
  if (action === "list") return { method: "budget.list", params: {} };
  if (action === "linked-hold") return parseLinkedHoldRecovery(args, operands[0]);
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
  const cwd = getArg(flags, "--cwd") || process.cwd();
  if ("offline" in call) {
    if (call.offline === "inspect") {
      printJson(await inspectLinkedHoldOffline(cwd, call.linkId));
      return;
    }
    printJson(await quarantineLinkedHoldOffline({
      projectRoot: cwd,
      linkId: call.linkId,
      expectedDigest: call.expectedDigest,
      resolution: call.resolution,
      confirm: call.confirm,
    }));
    return;
  }
  const client = await daemonClient(cwd, flags);
  printJson(await client.call(call.method, call.params));
}

function parseLinkedHoldRecovery(args: string[], action: string | undefined): BudgetCommandCall {
  const linkIds = getRepeatedArgs(args, "--link-id");
  if (linkIds.length !== 1 || /[*?,]/.test(linkIds[0]!)) throw new CliUsageError("Linked-hold recovery requires one literal --link-id.");
  if (action === "inspect") return { offline: "inspect", linkId: linkIds[0]! };
  if (action !== "quarantine") throw new CliUsageError(budgetUsage());
  const expected = getRepeatedArgs(args, "--expected-digest");
  if (expected.length !== 1) throw new CliUsageError("Linked-hold quarantine requires one --expected-digest.");
  const resolution = getArg(args, "--resolution");
  if (resolution !== "exhaust" && resolution !== "release") {
    throw new CliUsageError("Linked-hold quarantine requires --resolution exhaust|release.");
  }
  return {
    offline: "quarantine",
    linkId: linkIds[0]!,
    expectedDigest: expected[0]!,
    resolution,
    confirm: args.includes("--confirm"),
  };
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
  return renderCommandUsage("budget");
}
