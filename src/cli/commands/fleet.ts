import type { DaemonMethod } from "../../daemon/protocol";
import {
  CliUsageError,
  daemonClient,
  flagArgsBeforeSeparator,
  getApprovalPolicy,
  getArg,
  getAuthMode,
  requiredArg,
} from "../shared";

const MAX_PROFILE_BYTES = 2_500_000;

export type FleetCommandCall = {
  method: Extract<DaemonMethod, `fleet.${string}`>;
  params: Record<string, unknown>;
};

export async function parseFleetCommand(args: string[]): Promise<FleetCommandCall> {
  const namespace = args[1] ?? "health";
  const action = args[2];
  const flags = flagArgsBeforeSeparator(args);
  if (namespace === "health" && (action === undefined || action.startsWith("-"))) {
    return { method: "fleet.health", params: optionalProfileId(flags) };
  }
  if (namespace !== "profile" || !action || !["upsert", "get", "list", "remove"].includes(action)) {
    throw new CliUsageError("Usage: headless fleet <health|profile upsert|get|list|remove> [options]");
  }
  if (action === "list") return { method: "fleet.profile.list", params: {} };
  if (action === "get" || action === "remove") {
    return { method: `fleet.profile.${action}`, params: { profileId: requiredArg(flags, "--profile-id") } };
  }

  const profile = await readProfileDefinition(requiredArg(flags, "--file"));
  const authMode = getAuthMode(flags);
  const approvalPolicy = getApprovalPolicy(flags);
  if (authMode) profile.authMode = authMode;
  if (approvalPolicy) profile.approvalPolicy = approvalPolicy;
  if (flags.includes("--activate") && flags.includes("--no-activate")) {
    throw new CliUsageError("Choose either --activate or --no-activate, not both.");
  }
  if (flags.includes("--activate")) profile.activate = true;
  if (flags.includes("--no-activate")) profile.activate = false;
  return { method: "fleet.profile.upsert", params: profile };
}

export async function runFleetCommand(args: string[]) {
  const flags = flagArgsBeforeSeparator(args);
  const call = await parseFleetCommand(args);
  const client = await daemonClient(getArg(flags, "--cwd") || process.cwd(), flags);
  console.log(JSON.stringify(await client.call(call.method, call.params), null, 2));
}

async function readProfileDefinition(path: string) {
  const file = Bun.file(path);
  if (!await file.exists()) throw new CliUsageError(`Fleet profile does not exist: ${path}`);
  if (file.size > MAX_PROFILE_BYTES) throw new CliUsageError(`Fleet profile exceeds the ${MAX_PROFILE_BYTES}-byte CLI limit.`);
  try {
    const parsed = JSON.parse(await file.text());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("root must be an object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new CliUsageError(`Fleet profile is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function optionalProfileId(args: string[]) {
  const profileId = getArg(args, "--profile-id");
  return profileId ? { profileId } : {};
}
