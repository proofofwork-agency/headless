import type { DaemonMethod } from "../../daemon/protocol";
import { resolveCommandAction } from "../argv";
import { renderCommandUsage } from "../command-specs";
import {
  MAX_EVENT_LIMIT,
  CliUsageError,
  daemonClient,
  flagArgsBeforeSeparator,
  getArg,
  getRepeatedArgs,
  parseIntegerArg,
  printJson,
  requiredArg,
} from "../shared";

export type CollaborationCommandCall = {
  method: Extract<DaemonMethod, `collaboration.${string}`>;
  params: Record<string, unknown>;
};

export function parseCollaborationCommand(args: string[]): CollaborationCommandCall {
  const { action } = resolveCommandAction(args, "turns");
  const flags = flagArgsBeforeSeparator(args);
  const goalId = requiredArg(flags, "--goal-id");
  if (action === "turns" || action === "messages") {
    return {
      method: action === "turns" ? "collaboration.turns" : "collaboration.messages",
      params: {
        goalId,
        afterSequence: parseNonnegativeInteger(flags, "--after-sequence") ?? 0,
        limit: parseIntegerArg(flags, "--limit", MAX_EVENT_LIMIT) ?? 200,
      },
    };
  }
  if (action === "transfer-synthesizer") {
    return {
      method: "collaboration.transferSynthesizer",
      params: { goalId, agentId: requiredArg(flags, "--agent-id") },
    };
  }
  if (action === "acknowledge" || action === "ack") {
    const messageIds = getRepeatedArgs(flags, "--message-id");
    if (messageIds.length === 0) throw new CliUsageError("At least one --message-id is required.");
    return {
      method: "collaboration.messages.acknowledge",
      params: { goalId, messageIds, prune: !flags.includes("--retain") },
    };
  }
  throw new CliUsageError(renderCommandUsage("collaboration"));
}

export async function runCollaborationCommand(args: string[]) {
  const flags = flagArgsBeforeSeparator(args);
  const call = parseCollaborationCommand(args);
  const client = await daemonClient(getArg(flags, "--cwd") || process.cwd(), flags);
  printJson(await client.call(call.method, call.params));
}

function parseNonnegativeInteger(args: string[], name: string) {
  const value = getArg(args, name);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new CliUsageError(`Invalid value for ${name}: expected a nonnegative integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new CliUsageError(`Invalid value for ${name}: expected a nonnegative integer.`);
  return parsed;
}
