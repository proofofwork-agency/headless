import type { DaemonMethod } from "../../daemon/protocol";
import type { HeadlessDaemonClient } from "../../daemon/client";
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

export async function parseFleetCommand(
  args: string[],
  existingProfile?: Record<string, unknown>,
): Promise<FleetCommandCall> {
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

  const file = getArg(flags, "--file");
  const profile = file
    ? await readProfileDefinition(file)
    : existingProfile
      ? normalizeProfileDefinition(existingProfile)
      : (() => {
          throw new CliUsageError(
            "--file is required to create or replace a fleet profile. To update the active profile, pass --auth-mode and/or --approval-policy without --file.",
          );
        })();
  const authMode = getAuthMode(flags);
  const approvalPolicy = getApprovalPolicy(flags);
  if (authMode) applyFleetOverride(profile, "authMode", authMode);
  if (approvalPolicy) applyFleetOverride(profile, "approvalPolicy", approvalPolicy);
  if (flags.includes("--activate") && flags.includes("--no-activate")) {
    throw new CliUsageError("Choose either --activate or --no-activate, not both.");
  }
  if (flags.includes("--activate")) profile.activate = true;
  if (flags.includes("--no-activate")) profile.activate = false;
  return { method: "fleet.profile.upsert", params: profile };
}

export async function runFleetCommand(args: string[]) {
  const flags = flagArgsBeforeSeparator(args);
  const client = await daemonClient(getArg(flags, "--cwd") || process.cwd(), flags);
  const existing = isProfileUpsert(args) && !getArg(flags, "--file")
    ? await activeProfileForPartialUpdate(client, flags)
    : undefined;
  const call = await parseFleetCommand(args, existing);
  console.log(JSON.stringify(await client.call(call.method, call.params), null, 2));
}

async function readProfileDefinition(path: string) {
  const file = Bun.file(path);
  if (!await file.exists()) throw new CliUsageError(`Fleet profile does not exist: ${path}`);
  if (file.size > MAX_PROFILE_BYTES) throw new CliUsageError(`Fleet profile exceeds the ${MAX_PROFILE_BYTES}-byte CLI limit.`);
  try {
    const parsed = JSON.parse(await file.text());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("root must be an object");
    return normalizeProfileDefinition(parsed as Record<string, unknown>);
  } catch (error) {
    throw new CliUsageError(`Fleet profile is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Convert a daemon-owned profile projection back to the strict upsert input. */
export function normalizeProfileDefinition(profile: Record<string, unknown>) {
  const normalized = { ...profile };
  for (const field of ["projectId", "active", "activeProfileId", "createdAt", "updatedAt"]) delete normalized[field];
  if (Array.isArray(normalized.agents)) {
    normalized.agents = normalized.agents.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      const agent = { ...(value as Record<string, unknown>) };
      delete agent.createdAt;
      delete agent.updatedAt;
      return agent;
    });
  }
  return normalized;
}

async function activeProfileForPartialUpdate(client: HeadlessDaemonClient, flags: string[]) {
  const authMode = getAuthMode(flags);
  const approvalPolicy = getApprovalPolicy(flags);
  if (!authMode && !approvalPolicy && !flags.includes("--activate") && !flags.includes("--no-activate")) {
    throw new CliUsageError("Fleet profile upsert requires --file or at least one of --auth-mode, --approval-policy, --activate, or --no-activate.");
  }
  const listed = await client.call<{
    profiles: Array<Record<string, unknown> & { id: string }>;
    activeProfileId: string | null;
  }>("fleet.profile.list");
  const requestedId = getArg(flags, "--profile-id");
  const profileId = requestedId ?? listed.activeProfileId ?? (listed.profiles.length === 1 ? listed.profiles[0]?.id : undefined);
  if (!profileId) {
    throw new CliUsageError("No active fleet profile is configured. Pass --profile-id or create one with --file first.");
  }
  const profile = listed.profiles.find((candidate) => candidate.id === profileId);
  if (!profile) throw new CliUsageError(`Unknown fleet profile: ${profileId}`);
  return profile;
}

function isProfileUpsert(args: string[]) {
  return args[1] === "profile" && args[2] === "upsert";
}

function applyFleetOverride(
  profile: Record<string, unknown>,
  field: "authMode" | "approvalPolicy",
  value: string,
) {
  profile[field] = value;
  if (!Array.isArray(profile.agents)) return;
  profile.agents = profile.agents.map((agent) => agent && typeof agent === "object" && !Array.isArray(agent)
    ? { ...(agent as Record<string, unknown>), [field]: value }
    : agent);
}

function optionalProfileId(args: string[]) {
  const profileId = getArg(args, "--profile-id");
  return profileId ? { profileId } : {};
}
