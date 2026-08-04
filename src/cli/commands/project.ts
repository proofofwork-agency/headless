import type { DaemonMethod } from "../../daemon/protocol";
import { resolveCommandAction } from "../argv";
import { CliUsageError, daemonClient, flagArgsBeforeSeparator, getArg } from "../shared";

export type ProjectCommandCall = {
  method: Extract<DaemonMethod, `project.trust.${string}`>;
  params: Record<string, unknown>;
};

export function parseProjectCommand(args: string[]): ProjectCommandCall {
  const { action: namespace, operands } = resolveCommandAction(args);
  const action = operands[0] ?? "status";
  if (namespace !== "trust" || !["status", "grant", "revoke"].includes(action)) {
    throw new CliUsageError("Usage: headless project trust <status|grant|revoke> [--allow-native-direct-unrestricted] [--allow-bypass]");
  }
  if (action === "grant") {
    return {
      method: "project.trust.grant",
      params: {
        nativeLoginAllowed: args.includes("--allow-native-direct-unrestricted"),
        nativeDirectUnrestrictedAcknowledged: args.includes("--allow-native-direct-unrestricted"),
        bypassAllowed: args.includes("--allow-bypass"),
      },
    };
  }
  return { method: action === "revoke" ? "project.trust.revoke" : "project.trust.status", params: {} };
}

export async function runProjectCommand(args: string[]) {
  const flags = flagArgsBeforeSeparator(args);
  const call = parseProjectCommand(args);
  const client = await daemonClient(getArg(flags, "--cwd") || process.cwd(), flags);
  console.log(JSON.stringify(await client.call(call.method, call.params), null, 2));
}
