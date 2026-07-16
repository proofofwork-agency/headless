import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  OWNER_ONLY_DIRECTORY_MODE,
  OWNER_ONLY_FILE_MODE,
  UnsupportedPlatformError,
  canonicalizeProjectRoot,
  ensureOwnerOnlyDirectory,
  ensureOwnerOnlyFile,
  ensureProjectStateDirectories,
  getHeadlessStateHome,
  getProjectStatePaths,
  projectIdForRoot,
} from "../src/runtime/project-state";

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("project state", () => {
  test("canonicalizes relative and symlinked project roots before hashing", () => {
    const fixture = temporaryDirectory("headless-project-state-");
    const project = join(fixture, "project");
    const link = join(fixture, "project-link");
    mkdirSync(project);
    symlinkSync(project, link, "dir");

    const canonical = canonicalizeProjectRoot(project);
    expect(canonicalizeProjectRoot(link)).toBe(canonical);
    expect(projectIdForRoot(link)).toBe(projectIdForRoot(project));
    expect(projectIdForRoot(project)).toBe(createHash("sha256").update(canonical, "utf8").digest("hex"));
    expect(projectIdForRoot(project)).toMatch(/^[a-f0-9]{64}$/);
  });

  test("rejects empty, missing, and non-directory project roots", () => {
    const fixture = temporaryDirectory("headless-project-state-invalid-");
    const file = join(fixture, "file.txt");
    writeFileSync(file, "not a project");

    expect(() => canonicalizeProjectRoot("  ")).toThrow("must not be empty");
    expect(() => canonicalizeProjectRoot(join(fixture, "missing"))).toThrow();
    expect(() => canonicalizeProjectRoot(file)).toThrow("is not a directory");
  });

  test("uses HEADLESS_STATE_HOME before platform defaults", () => {
    const fixture = temporaryDirectory("headless-project-state-home-");
    const override = join(fixture, "controlled-state");

    expect(getHeadlessStateHome({
      env: { HEADLESS_STATE_HOME: override },
      homeDir: "/ignored",
      platform: "win32",
    })).toBe(resolve(override));
  });

  test("resolves macOS, Linux XDG, and Linux fallback state homes", () => {
    expect(getHeadlessStateHome({ env: {}, homeDir: "/Users/tester", platform: "darwin" }))
      .toBe("/Users/tester/Library/Application Support/Headless");
    expect(getHeadlessStateHome({ env: { XDG_STATE_HOME: "/var/state/tester" }, homeDir: "/home/tester", platform: "linux" }))
      .toBe("/var/state/tester/headless");
    expect(getHeadlessStateHome({ env: {}, homeDir: "/home/tester", platform: "linux" }))
      .toBe("/home/tester/.local/state/headless");
    expect(() => getHeadlessStateHome({ env: {}, homeDir: "/tmp", platform: "win32" }))
      .toThrow(UnsupportedPlatformError);
  });

  test("returns every project-scoped runtime path", () => {
    const fixture = temporaryDirectory("headless-project-state-paths-");
    const project = join(fixture, "project");
    const stateHome = join(fixture, "state");
    const runtimeHome = join("/tmp", `hls-paths-${process.pid}`);
    mkdirSync(project);

    const paths = getProjectStatePaths(project, {
      env: { HEADLESS_STATE_HOME: stateHome, HEADLESS_RUNTIME_HOME: runtimeHome },
      platform: "linux",
    });
    const root = join(resolve(stateHome), "projects", paths.projectId);

    expect(paths.canonicalProjectRoot).toBe(canonicalizeProjectRoot(project));
    expect(paths.projectId).toBe(projectIdForRoot(project));
    expect(paths.projectsDir).toBe(join(resolve(stateHome), "projects"));
    expect(paths.projectDir).toBe(root);
    expect(paths.ledgerPath).toBe(join(root, "ledger.jsonl"));
    expect(paths.dbPath).toBe(join(root, "read-model.sqlite"));
    expect(paths.jobsDir).toBe(join(root, "jobs"));
    expect(paths.receiptsDir).toBe(join(root, "receipts"));
    expect(paths.tasksDir).toBe(join(root, "tasks"));
    expect(paths.runEventsPath).toBe(join(root, "run-events.json"));
    expect(paths.sessionsDir).toBe(join(root, "sessions"));
    expect(paths.workflowsDir).toBe(join(root, "workflows"));
    expect(paths.goalsDir).toBe(join(root, "goals"));
    expect(paths.delegationSchedulerPath).toBe(join(root, "delegation-scheduler.json"));
    expect(paths.idleOpportunitiesPath).toBe(join(root, "idle-opportunities.json"));
    expect(paths.policyPath).toBe(join(root, "policy.json"));
    expect(paths.budgetsPath).toBe(join(root, "budgets.json"));
    expect(paths.worktreesDir).toBe(join(root, "worktrees"));
    expect(paths.artifactsDir).toBe(join(root, "artifacts"));
    expect(paths.daemonDir).toBe(join(root, "daemon"));
    expect(paths.daemonRuntimeDir).toBe(runtimeHome);
    expect(paths.daemonMetadataPath).toBe(join(root, "daemon", "metadata.json"));
    expect(paths.credentialsPath).toBe(join(root, "daemon", "credentials.json"));
    expect(paths.integrationsDir).toBe(join(root, "daemon", "integrations"));
    expect(paths.tokenPath).toBe(join(root, "daemon", "token"));
    expect(paths.socketPath).toBe(join(runtimeHome, `${paths.projectId.slice(0, 32)}.sock`));
    expect(Buffer.byteLength(paths.socketPath)).toBeLessThan(104);
  });

  test("creates project state directories with owner-only permissions", () => {
    const fixture = temporaryDirectory("headless-project-state-modes-");
    const project = join(fixture, "project");
    const stateHome = join(fixture, "state");
    mkdirSync(project);

    const paths = getProjectStatePaths(project, { env: { HEADLESS_STATE_HOME: stateHome } });
    ensureProjectStateDirectories(paths);

    for (const path of [
      paths.stateHome,
      paths.projectsDir,
      paths.projectDir,
      paths.jobsDir,
      paths.receiptsDir,
      paths.tasksDir,
      paths.sessionsDir,
      paths.workflowsDir,
      paths.worktreesDir,
      paths.artifactsDir,
      paths.daemonDir,
      paths.integrationsDir,
      paths.daemonRuntimeDir,
    ]) {
      expect(mode(path)).toBe(OWNER_ONLY_DIRECTORY_MODE);
    }
  });

  test("tightens existing directory and file permissions and rejects symlinks", () => {
    const fixture = temporaryDirectory("headless-project-state-owner-");
    const directory = join(fixture, "directory");
    const file = join(fixture, "token");
    const fileLink = join(fixture, "token-link");
    mkdirSync(directory, { mode: 0o777 });
    writeFileSync(file, "secret", { mode: 0o666 });
    chmodSync(directory, 0o777);
    chmodSync(file, 0o666);
    symlinkSync(file, fileLink);

    expect(ensureOwnerOnlyDirectory(directory)).toBe(directory);
    expect(ensureOwnerOnlyFile(file)).toBe(file);
    expect(mode(directory)).toBe(OWNER_ONLY_DIRECTORY_MODE);
    expect(mode(file)).toBe(OWNER_ONLY_FILE_MODE);
    expect(() => ensureOwnerOnlyFile(fileLink)).toThrow("not a regular file");
  });
});

function temporaryDirectory(prefix: string) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

function mode(path: string) {
  return statSync(path).mode & 0o777;
}
