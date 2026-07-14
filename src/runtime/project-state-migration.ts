import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { ensureOwnerOnlyDirectory, ensureOwnerOnlyFile, type ProjectStatePaths } from "./project-state";
import { writeOwnerOnlyJson } from "./owner-json";

const MigrationManifestSchema = z.object({
  version: z.literal(1),
  projectId: z.string().length(64),
  migratedAt: z.number().int().positive(),
  archived: z.array(z.object({ source: z.string(), archive: z.string(), sha256: z.string().length(64), pendingProposals: z.number().int().nonnegative() }).strict()),
  goalsMigrated: z.array(z.string()),
  fleetCoordinatorFieldsDiscarded: z.number().int().nonnegative(),
  ledgerModified: z.literal(false),
  externalContextRelayState: z.literal("intentionally-left-untouched"),
}).strict();

/**
 * Private-alpha state migration for the single foreground lead architecture.
 * It deliberately never opens or rewrites the verified ledger.
 */
export function migrateSingleLeadState(paths: ProjectStatePaths, now = Date.now()) {
  if (existsSync(paths.activeStateMigrationPath)) {
    ensureOwnerOnlyFile(paths.activeStateMigrationPath);
    return MigrationManifestSchema.parse(JSON.parse(readFileSync(paths.activeStateMigrationPath, "utf8")));
  }

  const archiveRoot = ensureOwnerOnlyDirectory(join(paths.archiveDir, "single-lead-v1"));
  const archived = [paths.legacyOperatorStatePath, paths.legacyContextRelayAdapterPath]
    .flatMap((source) => archiveLegacyFile(source, archiveRoot));
  const fleetCoordinatorFieldsDiscarded = migrateFleetProfiles(paths.fleetProfilesPath);
  const goalsMigrated = migrateGoals(paths.goalsDir);
  const manifest = MigrationManifestSchema.parse({
    version: 1,
    projectId: paths.projectId,
    migratedAt: now,
    archived,
    goalsMigrated,
    fleetCoordinatorFieldsDiscarded,
    ledgerModified: false,
    externalContextRelayState: "intentionally-left-untouched",
  });
  writeOwnerOnlyJson(paths.activeStateMigrationPath, manifest);
  return manifest;
}

function archiveLegacyFile(source: string, archiveRoot: string) {
  const archive = join(archiveRoot, basename(source));
  if (!existsSync(source)) return existsSync(archive) ? [archivedFileRecord(source, archive)] : [];
  const info = lstatSync(source);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Legacy state is not a regular file: ${source}`);
  ensureOwnerOnlyFile(source);
  if (existsSync(archive)) throw new Error(`Refusing to replace an existing state archive: ${archive}`);
  renameSync(source, archive);
  return [archivedFileRecord(source, archive)];
}

function archivedFileRecord(source: string, archive: string) {
  ensureOwnerOnlyFile(archive);
  const contents = readFileSync(archive);
  const parsed = safeObject(contents);
  const pendingProposals = Array.isArray(parsed?.proposals)
    ? parsed.proposals.filter((proposal) => isRecord(proposal) && proposal.status === "pending").length
    : 0;
  return { source, archive, sha256: createHash("sha256").update(contents).digest("hex"), pendingProposals };
}

function migrateFleetProfiles(path: string) {
  if (!existsSync(path)) return 0;
  ensureOwnerOnlyFile(path);
  const state = safeObject(readFileSync(path));
  if (!state || !Array.isArray(state.profiles)) return 0;
  let removed = 0;
  for (const profile of state.profiles) {
    if (!isRecord(profile) || !("coordinator" in profile)) continue;
    delete profile.coordinator;
    removed += 1;
  }
  if (removed > 0) writeOwnerOnlyJson(path, state);
  return removed;
}

function migrateGoals(directory: string) {
  if (!existsSync(directory)) return [];
  const migrated: string[] = [];
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json")).sort()) {
    const path = join(directory, name);
    ensureOwnerOnlyFile(path);
    const record = safeObject(readFileSync(path));
    const goal = isRecord(record?.goal) ? record.goal : null;
    if (!goal) continue;
    let changed = false;
    if ("leaderAgentId" in goal) {
      goal.synthesizerAgentId = goal.leaderAgentId ?? null;
      delete goal.leaderAgentId;
      changed = true;
    }
    if ("coordinator" in goal) {
      const coordinator = isRecord(goal.coordinator) ? goal.coordinator : null;
      goal.synthesizer = coordinator?.kind === "agent" || coordinator?.kind === "election" || coordinator?.kind === "automatic"
        ? coordinator
        : { kind: "automatic" };
      delete goal.coordinator;
      changed = true;
    }
    if (!("synthesizer" in goal)) {
      goal.synthesizer = { kind: "automatic" };
      changed = true;
    }
    if (!("synthesizerAgentId" in goal)) {
      goal.synthesizerAgentId = null;
      changed = true;
    }
    if (changed) {
      writeOwnerOnlyJson(path, record);
      migrated.push(name.slice(0, -5));
    }
  }
  return migrated;
}

function safeObject(contents: Buffer) {
  const value: unknown = JSON.parse(contents.toString("utf8"));
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
