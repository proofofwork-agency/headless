import type { DaemonMethod } from "../../daemon/protocol";
import {
  CliUsageError,
  daemonClient,
  flagArgsBeforeSeparator,
  getArg,
  getPrompt,
  requiredArg,
} from "../shared";

export type ApprovalCommandCall = {
  method: Extract<DaemonMethod, `approval.${string}`>;
  params: Record<string, unknown>;
};

export function parseApprovalCommand(args: string[]): ApprovalCommandCall {
  const action = args[1] ?? "list";
  const flags = flagArgsBeforeSeparator(args);
  if (action === "list") {
    const status = getArg(flags, "--status");
    if (status && !["pending", "approved", "rejected", "cancelled", "expired"].includes(status)) {
      throw new CliUsageError("Invalid --status. Expected pending, approved, rejected, cancelled, or expired.");
    }
    return {
      method: "approval.list",
      params: compact({ goalId: getArg(flags, "--goal-id"), status }),
    };
  }
  if (action === "resolve") {
    const decision = requiredArg(flags, "--decision");
    if (decision !== "approved" && decision !== "rejected") {
      throw new CliUsageError("Invalid --decision. Expected approved or rejected.");
    }
    const resolution = getArg(flags, "--resolution") ?? getPrompt(["approval", ...args.slice(2)]);
    if (!resolution) throw new CliUsageError("A resolution is required via --resolution or a positional argument.");
    return {
      method: "approval.resolve",
      params: { approvalId: requiredArg(flags, "--approval-id"), decision, resolution },
    };
  }
  throw new CliUsageError("Usage: headless approval <list|resolve> [options]");
}

export async function runApprovalCommand(args: string[]) {
  const flags = flagArgsBeforeSeparator(args);
  const call = parseApprovalCommand(args);
  const client = await daemonClient(getArg(flags, "--cwd") || process.cwd(), flags);
  console.log(JSON.stringify(await client.call(call.method, call.params), null, 2));
}

function compact(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
