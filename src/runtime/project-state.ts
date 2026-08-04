import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { assertTrustedAncestorChain } from "./trusted-path";
import { supportedPlatform, UnsupportedPlatformError } from "./validation";

export { UnsupportedPlatformError } from "./validation";

export const OWNER_ONLY_DIRECTORY_MODE = 0o700;
export const OWNER_ONLY_FILE_MODE = 0o600;

export type ProjectStateOptions = {
  env?: Readonly<NodeJS.ProcessEnv>;
  homeDir?: string;
  platform?: NodeJS.Platform;
};

export type ProjectStatePaths = {
  canonicalProjectRoot: string;
  projectId: string;
  stateHome: string;
  projectsDir: string;
  projectDir: string;
  ledgerPath: string;
  dbPath: string;
  readModelPath: string;
  migrationManifestPath: string;
  jobsDir: string;
  receiptsDir: string;
  tasksDir: string;
  runEventsPath: string;
  sessionsDir: string;
  workflowsDir: string;
  goalsDir: string;
  policyPath: string;
  budgetsPath: string;
  brokerQuotasPath: string;
  projectTrustPath: string;
  fleetProfilesPath: string;
  collaborationPath: string;
  approvalsPath: string;
  delegationSchedulerPath: string;
  idleOpportunitiesPath: string;
  legacyOperatorStatePath: string;
  skillsDir: string;
  loopsDir: string;
  legacyContextRelayAdapterPath: string;
  leadBindingPath: string;
  activeStateMigrationPath: string;
  archiveDir: string;
  worktreesDir: string;
  artifactsDir: string;
  daemonDir: string;
  daemonRuntimeDir: string;
  daemonMetadataPath: string;
  credentialsPath: string;
  observerTokenPath: string;
  integrationsDir: string;
  tokenPath: string;
  socketPath: string;
};

export function canonicalizeProjectRoot(projectRoot: string) {
  if (!projectRoot.trim()) {
    throw new Error("Project root must not be empty.");
  }

  const canonicalProjectRoot = realpathSync(resolve(projectRoot));
  if (!statSync(canonicalProjectRoot).isDirectory()) {
    throw new Error(`Project root is not a directory: ${projectRoot}`);
  }
  return canonicalProjectRoot;
}

export function projectIdForRoot(projectRoot: string) {
  const canonicalProjectRoot = canonicalizeProjectRoot(projectRoot);
  return createHash("sha256").update(canonicalProjectRoot, "utf8").digest("hex");
}

export function getHeadlessStateHome(options: ProjectStateOptions = {}) {
  const env = options.env ?? process.env;
  const override = nonEmpty(env.HEADLESS_STATE_HOME);
  if (override) return resolve(override);

  const platform = supportedPlatform(options.platform ?? process.platform);
  const homeDir = resolve(options.homeDir ?? homedir());

  if (platform === "darwin") {
    return join(homeDir, "Library", "Application Support", "Headless");
  }
  const xdgStateHome = nonEmpty(env.XDG_STATE_HOME);
  return join(xdgStateHome ? resolve(xdgStateHome) : join(homeDir, ".local", "state"), "headless");
}

export function getProjectStatePaths(projectRoot: string, options: ProjectStateOptions = {}): ProjectStatePaths {
  const env = options.env ?? process.env;
  const canonicalProjectRoot = canonicalizeProjectRoot(projectRoot);
  const projectId = createHash("sha256").update(canonicalProjectRoot, "utf8").digest("hex");
  const stateHome = getHeadlessStateHome(options);
  const projectsDir = join(stateHome, "projects");
  const projectDir = join(projectsDir, projectId);
  const daemonDir = join(projectDir, "daemon");
  // sockaddr_un paths are commonly limited to roughly 104–108 bytes. The
  // required macOS state path plus a 64-byte project id exceeds that limit, so
  // only the authenticated socket lives in a short owner-only runtime path.
  const runtimeBase = nonEmpty(env.HEADLESS_RUNTIME_HOME) ?? join("/tmp", `headless-${typeof process.getuid === "function" ? process.getuid() : "local"}`);
  const daemonRuntimeDir = resolve(runtimeBase);
  const socketPath = join(daemonRuntimeDir, `${projectId.slice(0, 32)}.sock`);
  if (Buffer.byteLength(socketPath) > 103) {
    throw new Error(`Headless daemon socket path is too long (${Buffer.byteLength(socketPath)} bytes). Set HEADLESS_RUNTIME_HOME to a short owner-only path such as /tmp/headless-${typeof process.getuid === "function" ? process.getuid() : "local"}.`);
  }

  return {
    canonicalProjectRoot,
    projectId,
    stateHome,
    projectsDir,
    projectDir,
    ledgerPath: join(projectDir, "ledger.jsonl"),
    dbPath: join(projectDir, "read-model.sqlite"),
    readModelPath: join(projectDir, "read-model.json"),
    migrationManifestPath: join(projectDir, "migration-v1.json"),
    jobsDir: join(projectDir, "jobs"),
    receiptsDir: join(projectDir, "receipts"),
    tasksDir: join(projectDir, "tasks"),
    runEventsPath: join(projectDir, "run-events.json"),
    sessionsDir: join(projectDir, "sessions"),
    workflowsDir: join(projectDir, "workflows"),
    goalsDir: join(projectDir, "goals"),
    policyPath: join(projectDir, "policy.json"),
    budgetsPath: join(projectDir, "budgets.json"),
    brokerQuotasPath: join(projectDir, "broker-quotas.json"),
    projectTrustPath: join(projectDir, "project-trust.json"),
    fleetProfilesPath: join(projectDir, "fleet-profiles.json"),
    collaborationPath: join(projectDir, "collaboration.sqlite"),
    approvalsPath: join(projectDir, "approvals.json"),
    delegationSchedulerPath: join(projectDir, "delegation-scheduler.json"),
    idleOpportunitiesPath: join(projectDir, "idle-opportunities.json"),
    legacyOperatorStatePath: join(projectDir, "operator-state.json"),
    skillsDir: join(projectDir, "skills"),
    loopsDir: join(projectDir, "loops"),
    legacyContextRelayAdapterPath: join(projectDir, "contextrelay-adapter.json"),
    leadBindingPath: join(projectDir, "lead-binding.json"),
    activeStateMigrationPath: join(projectDir, "migration-single-lead-v1.json"),
    archiveDir: join(projectDir, "archive"),
    worktreesDir: join(projectDir, "worktrees"),
    artifactsDir: join(projectDir, "artifacts"),
    daemonDir,
    daemonRuntimeDir,
    daemonMetadataPath: join(daemonDir, "metadata.json"),
    credentialsPath: join(daemonDir, "credentials.json"),
    observerTokenPath: join(daemonDir, "observer.token"),
    integrationsDir: join(daemonDir, "integrations"),
    tokenPath: join(daemonDir, "token"),
    socketPath,
  };
}

export function ensureOwnerOnlyDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE });
  assertOwnedLeaf(path, lstatSync(path), "directory");
  chmodSync(path, OWNER_ONLY_DIRECTORY_MODE);
  const verified = lstatSync(path);
  assertOwnedLeaf(path, verified, "directory");
  if ((verified.mode & 0o077) !== 0) {
    throw new Error(`Owner-only directory path remained group/other accessible after chmod: ${path}`);
  }
  // realpath before ancestor walk (same pattern as secureCanonicalFile) so
  // platform aliasing like macOS /var → /private/var is not rejected as a
  // symlink ancestor. Leaf symlink rejection already happened via lstat above.
  const canonical = realpathSync(path);
  assertTrustedAncestorChain(canonical, `Owner-only directory ${path}`);
  return path;
}

export function ensureOwnerOnlyFile(path: string) {
  assertOwnedLeaf(path, lstatSync(path), "file");
  chmodSync(path, OWNER_ONLY_FILE_MODE);
  const verified = lstatSync(path);
  assertOwnedLeaf(path, verified, "file");
  if ((verified.mode & 0o077) !== 0) {
    throw new Error(`Owner-only file path remained group/other accessible after chmod: ${path}`);
  }
  const canonical = realpathSync(path);
  assertTrustedAncestorChain(canonical, `Owner-only file ${path}`);
  return path;
}

/**
 * Fail-closed leaf checks shared by ensureOwnerOnlyDirectory/File.
 * Does not auto-repair ownership — foreign-uid paths are refused.
 */
function assertOwnedLeaf(path: string, info: Stats, expected: "directory" | "file") {
  if (info.isSymbolicLink()) {
    throw new Error(
      expected === "directory"
        ? `Owner-only directory path is not a directory: ${path}`
        : `Owner-only file path is not a regular file: ${path}`,
    );
  }
  if (expected === "directory") {
    if (!info.isDirectory()) {
      throw new Error(`Owner-only directory path is not a directory: ${path}`);
    }
  } else if (!info.isFile()) {
    throw new Error(`Owner-only file path is not a regular file: ${path}`);
  }

  if (typeof process.getuid === "function") {
    const uid = process.getuid();
    // Root may only use root-owned leaves (getuid()===0). Non-root must match exactly.
    if (info.uid !== uid) {
      throw new Error(
        `path ${path} is not owned by current uid ${uid} (owner ${info.uid}) — refusing to use untrusted trust root`,
      );
    }
  }
}

export function ensureProjectStateDirectories(paths: ProjectStatePaths) {
  for (const path of [
    paths.stateHome,
    paths.projectsDir,
    paths.projectDir,
    paths.jobsDir,
    paths.receiptsDir,
    paths.tasksDir,
    paths.sessionsDir,
    paths.workflowsDir,
    paths.goalsDir,
    paths.skillsDir,
    paths.loopsDir,
    paths.worktreesDir,
    paths.artifactsDir,
    paths.archiveDir,
    paths.daemonDir,
    paths.integrationsDir,
    paths.daemonRuntimeDir,
  ]) {
    ensureOwnerOnlyDirectory(path);
  }
  return paths;
}

function nonEmpty(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
