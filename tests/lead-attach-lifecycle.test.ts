import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeadlessDaemonClient } from "../src/daemon/client";
import { LeadDaemonClientPool, lapsedLeadAttachment } from "../src/daemon/connect";
import { HeadlessDaemon } from "../src/daemon/server";
import { LEAD_ATTACHMENT_REQUIRED, LeadBindingStore, probeLeadBinding, readLeadBinding } from "../src/runtime/lead-binding";
import { resolveLeadProjectRoot } from "../src/runtime/lead-project-root";
import { ensureProjectStateDirectories, getProjectStatePaths } from "../src/runtime/project-state";

const fixtures: Array<{ root: string; runtime: string; daemon?: HeadlessDaemon; pool?: LeadDaemonClientPool }> = [];

afterEach(async () => {
  while (fixtures.length) {
    const fixture = fixtures.pop()!;
    await fixture.pool?.disconnectAll();
    await fixture.daemon?.stop();
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.runtime, { recursive: true, force: true });
  }
});

describe("foreground lead attach lifecycle", () => {
  test("a lapsed attachment is recoverable: attach is legal from disconnected", () => {
    const fixture = stateFixture();
    let now = 1_700_000_000_000;
    const store = new LeadBindingStore(fixture.state, () => now);
    store.use({ host: "codex", backendId: "codex", integrationPrincipal: "integration:lead-codex-g1", generation: 1 });
    expect(store.attach("integration:lead-codex-g1", 1).status).toBe("connected");

    // Idle past the 45s window (lead-binding.ts:127-135).
    now += 45_001;
    expect(store.status()?.status).toBe("disconnected");

    // The daemon was ALWAYS willing to take the lead back — assertCurrent checks
    // principal and generation and never looks at status. Defect #1 was therefore
    // never a daemon refusal; it was the client throwing the recovery away.
    expect(store.attach("integration:lead-codex-g1", 1).status).toBe("connected");
    expect(store.status()?.generation).toBe(1);
  });

  test("reading a binding never materializes project state for the wrong root", () => {
    const fixture = stateFixture();
    const unconfigured = join(fixture.root, "not-a-project");
    mkdirSync(unconfigured);
    const paths = getProjectStatePaths(unconfigured, fixture.stateOptions);

    expect(readLeadBinding(paths)).toBeNull();
    // Constructing a LeadBindingStore here would have created the whole tree and
    // written a binding file, making this non-project look configured forever.
    expect(existsSync(paths.projectDir)).toBe(false);

    const store = new LeadBindingStore(fixture.state, () => 1_700_000_000_000);
    store.use({ host: "codex", backendId: "codex", integrationPrincipal: "integration:lead-codex-g1", generation: 1 });
    expect(readLeadBinding(fixture.state)).toMatchObject({ host: "codex", generation: 1 });
  });

  test("the client pool re-attaches itself after the daemon marks the lead disconnected", async () => {
    const fixture = await daemonFixture();
    await fixture.rootClient.call("lead.use", { host: "codex" });

    const pool = new LeadDaemonClientPool();
    fixture.record.pool = pool;
    const lead = await pool.client({ projectRoot: fixture.project, state: fixture.stateOptions, host: "codex" });
    await lead.call("ledger.note", { text: "before the lapse", sessionId: "attach-lifecycle" });

    // Drive the binding to the same terminal state a 45s idle window produces,
    // without fake timers against a live daemon.
    const direct = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.stateOptions, credential: { integration: "lead-codex-g1" } });
    await direct.call("lead.disconnect", { generation: 1 });
    expect(await fixture.rootClient.call("lead.status")).toMatchObject({ status: "disconnected" });

    // A raw client stays broken — this is the failure operators actually hit.
    await expect(direct.call("ledger.note", { text: "raw client" })).rejects.toMatchObject({ code: "POLICY_DENIED" });

    // The pooled client repairs itself and the write lands.
    await lead.call("ledger.note", { text: "after the lapse", sessionId: "attach-lifecycle" });
    expect(await fixture.rootClient.call("lead.status")).toMatchObject({ status: "connected" });

    const context = await fixture.rootClient.call<{ entries: Array<{ content?: string }> }>(
      "ledger.context",
      { view: "raw", limit: 50, sessionId: "attach-lifecycle" },
    );
    expect(context.entries).toContainEqual(expect.objectContaining({ content: "after the lapse" }));
  });

  test("the heartbeat alone restores the attachment, with no tool call to trigger it", async () => {
    const fixture = await daemonFixture();
    await fixture.rootClient.call("lead.use", { host: "codex" });

    const pool = new LeadDaemonClientPool(25);
    fixture.record.pool = pool;
    await pool.client({ projectRoot: fixture.project, state: fixture.stateOptions, host: "codex" });

    const direct = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.stateOptions, credential: { integration: "lead-codex-g1" } });
    await direct.call("lead.disconnect", { generation: 1 });
    expect(await fixture.rootClient.call("lead.status")).toMatchObject({ status: "disconnected" });

    // Nothing calls a tool here. If the heartbeat still swallowed its rejection
    // the binding would stay disconnected for the life of the process.
    await waitFor(async () => {
      const status = await fixture.rootClient.call<{ status: string }>("lead.status");
      return status.status === "connected";
    }, "the heartbeat never re-attached the lapsed lead");
  });
});

async function waitFor(condition: () => Promise<boolean>, failure: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(failure);
}

describe("only a lapsed attachment is retried", () => {
  test("the daemon marks the recoverable denial, and marks nothing else", async () => {
    const fixture = await daemonFixture();
    await fixture.rootClient.call("lead.use", { host: "codex" });
    const lead = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.stateOptions, credential: { integration: "lead-codex-g1" } });
    await lead.call("lead.attach", { generation: 1 });

    // A genuine refusal: this route is admin-only, and no amount of re-attaching
    // will ever make it succeed. It must NOT be classified as recoverable, or the
    // pool re-issues a forbidden request and the operator is told to reconfigure
    // a lead that was never the problem.
    const denial = await lead.call("approval.resolve", { approvalId: "self", decision: "approved" }).catch((error: unknown) => error);
    expect(denial).toMatchObject({ code: "POLICY_DENIED" });
    expect(lapsedLeadAttachment(denial)).toBe(false);

    // The recoverable one carries the structured reason.
    await lead.call("lead.disconnect", { generation: 1 });
    const lapse = await lead.call("ledger.note", { text: "after lapse" }).catch((error: unknown) => error);
    expect(lapse).toMatchObject({ code: "POLICY_DENIED", details: { reason: LEAD_ATTACHMENT_REQUIRED } });
    expect(lapsedLeadAttachment(lapse)).toBe(true);
  });

  test("the classifier ignores bare codes it cannot repair", () => {
    expect(lapsedLeadAttachment({ code: "POLICY_DENIED" })).toBe(false);
    // Re-attaching with the same rejected token cannot succeed.
    expect(lapsedLeadAttachment({ code: "DAEMON_AUTH_FAILED" })).toBe(false);
    expect(lapsedLeadAttachment({ code: "POLICY_DENIED", details: { reason: LEAD_ATTACHMENT_REQUIRED } })).toBe(true);
  });
});

describe("selected state is strict, discovery is fail-closed", () => {
  test("the selected read surfaces corruption instead of reporting a missing credential", () => {
    const fixture = stateFixture();
    writeFileSync(fixture.state.leadBindingPath, "{ not json", { mode: 0o600 });
    // Collapsing this to null made corrupt state indistinguishable from "no lead
    // configured", so the harness told the operator to run `headless lead use`
    // and stayed alive on a project it could not read.
    expect(() => readLeadBinding(fixture.state)).toThrow();

    writeFileSync(fixture.state.leadBindingPath, JSON.stringify({
      version: 1,
      projectId: "f".repeat(64),
      generation: 1,
      binding: null,
      updatedAt: 1_700_000_000_000,
    }), { mode: 0o600 });
    expect(() => readLeadBinding(fixture.state)).toThrow(/another project/);
  });

  test("a dangling symlink is a fact, not an absence", () => {
    const fixture = stateFixture();
    rmSync(fixture.state.leadBindingPath, { force: true });
    symlinkSync(join(fixture.root, "nowhere"), fixture.state.leadBindingPath);

    // `existsSync` follows the link and reports false, so this state read as "no
    // lead was ever configured" — laundering a security anomaly into
    // CREDENTIAL_MISSING, which the MCP server treats as recoverable and stays
    // alive on. Absence has to mean ENOENT and nothing else.
    expect(() => readLeadBinding(fixture.state)).toThrow(/not a regular file/);
    // Discovery stays tolerant of the wrong candidate, but still refuses to
    // treat this as a configured lead.
    expect(probeLeadBinding(fixture.state)).toBeNull();
  });

  test("a dangling symlink one directory UP is also not an absence", () => {
    const fixture = stateFixture();
    rmSync(fixture.state.projectDir, { recursive: true, force: true });
    symlinkSync(join(fixture.root, "nowhere"), fixture.state.projectDir);

    // `lstat` on the full path follows the intermediate link and raises ENOENT —
    // the SAME errno as genuine absence. Trusting that errno alone launders the
    // anomaly into "never configured" exactly one directory above the leaf case.
    expect(() => readLeadBinding(fixture.state)).toThrow(/symlinked ancestor/);
    expect(probeLeadBinding(fixture.state)).toBeNull();
  });

  test("a non-directory ancestor is reported, not read as absence", () => {
    const fixture = stateFixture();
    rmSync(fixture.state.projectDir, { recursive: true, force: true });
    writeFileSync(fixture.state.projectDir, "not a directory", { mode: 0o600 });

    // Deterministic non-ENOENT case that needs no root: the parent is a regular
    // file, so the state directory was replaced rather than never created. This
    // one never reaches the ancestor walk — the leaf `lstat` itself raises
    // ENOTDIR, and propagating it unchanged is the correct fail-closed answer.
    expect(() => readLeadBinding(fixture.state)).toThrow(/ENOTDIR|not a directory/);
    expect(probeLeadBinding(fixture.state)).toBeNull();
  });

  test("a resolvable symlinked ancestor is an ordinary alias, not corruption", () => {
    const root = mkdtempSync(join(tmpdir(), "headless-alias-"));
    const runtime = mkdtempSync("/tmp/hal-");
    fixtures.push({ root, runtime });
    const realHome = join(root, "real-home");
    const linkedHome = join(root, "linked-home");
    mkdirSync(realHome);
    symlinkSync(realHome, linkedHome);
    const project = join(root, "project");
    mkdirSync(project);

    // State home under a SYMLINKED home directory, not yet materialized — the
    // ordinary first run for anyone whose home is an alias. Rejecting every
    // symlinked ancestor would make that fatal, while the rest of this path
    // system deliberately follows intermediate aliases and canonicalizes.
    const paths = getProjectStatePaths(project, {
      env: { HEADLESS_STATE_HOME: join(linkedHome, "state"), HEADLESS_RUNTIME_HOME: runtime },
    });
    expect(readLeadBinding(paths)).toBeNull();
    expect(probeLeadBinding(paths)).toBeNull();
  });

  test("state that was never materialized is still a plain absence", () => {
    const fixture = stateFixture();
    rmSync(fixture.state.projectDir, { recursive: true, force: true });

    // The fix must not make a fresh, never-configured project fatal.
    expect(readLeadBinding(fixture.state)).toBeNull();
    expect(probeLeadBinding(fixture.state)).toBeNull();
  });

  test("discovery refuses an insecure binding rather than trusting it", () => {
    const fixture = stateFixture();
    new LeadBindingStore(fixture.state, () => 1_700_000_000_000)
      .use({ host: "codex", backendId: "codex", integrationPrincipal: "integration:lead-codex-g1", generation: 1 });
    expect(probeLeadBinding(fixture.state)).toMatchObject({ host: "codex" });

    // A group/other-readable binding must not get to decide which project a lead
    // attaches to. Skipping validation to avoid the chmod would have trusted it.
    chmodSync(fixture.state.leadBindingPath, 0o644);
    expect(probeLeadBinding(fixture.state)).toBeNull();

    writeFileSync(fixture.state.leadBindingPath, "{ not json", { mode: 0o600 });
    expect(probeLeadBinding(fixture.state)).toBeNull();
  });
});

describe("lead project-root resolution", () => {
  test("prefers an explicit root, then a configured ancestor, over the launch directory", () => {
    const fixture = stateFixture();
    const nested = join(fixture.project, "packages", "web", "src");
    mkdirSync(nested, { recursive: true });

    // An MCP host launching from a subdirectory must not hash that subdirectory
    // into a different, empty project id (project-state.ts:107-110).
    expect(resolveLeadProjectRoot({ cwd: nested, env: {}, state: fixture.stateOptions })).toBe(fixture.project);

    const elsewhere = join(fixture.root, "elsewhere");
    mkdirSync(elsewhere);
    expect(resolveLeadProjectRoot({ cwd: nested, env: { HEADLESS_PROJECT_ROOT: elsewhere }, state: fixture.stateOptions })).toBe(elsewhere);
  });

  test("a stale lead in a shared parent never outranks the nearer project", () => {
    const fixture = stateFixture();
    // The realistic trap: a home directory that was once used as a project still
    // has a configured lead, and the operator is working inside a repo below it.
    const home = fixture.project;
    const repo = join(home, "repo");
    const nested = join(repo, "packages", "web");
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(repo, ".git"));
    new LeadBindingStore(fixture.state, () => 1_700_000_000_000)
      .use({ host: "codex", backendId: "codex", integrationPrincipal: "integration:lead-codex-g1", generation: 1 });
    expect(readLeadBinding(fixture.state)).not.toBeNull();

    // Ranking "any configured ancestor" first would return `home` and silently
    // bind the harness to the wrong project.
    expect(resolveLeadProjectRoot({ cwd: nested, env: {}, state: fixture.stateOptions })).toBe(repo);
  });

  test("probing candidate roots does not rewrite their permissions", () => {
    const fixture = stateFixture();
    // cwd must sit BELOW the binding being probed, or resolution stops at a
    // nearer boundary and never reads it — which would make this assertion
    // vacuous rather than protective.
    const nested = join(fixture.project, "packages", "web");
    mkdirSync(nested, { recursive: true });
    new LeadBindingStore(fixture.state, () => 1_700_000_000_000)
      .use({ host: "codex", backendId: "codex", integrationPrincipal: "integration:lead-codex-g1", generation: 1 });

    chmodSync(fixture.state.leadBindingPath, 0o644);
    expect(resolveLeadProjectRoot({ cwd: nested, env: {}, state: fixture.stateOptions })).toBe(fixture.project);
    // Discovery is a question, not a repair: `ensureOwnerOnlyFile` chmods, so a
    // probing read would silently mutate every candidate it inspected.
    expect(statSync(fixture.state.leadBindingPath).mode & 0o777).toBe(0o644);
  });

  test("falls back to the git root, then the launch directory, when no project state exists", () => {
    const fixture = stateFixture();
    const untracked = mkdtempSync(join(tmpdir(), "headless-lead-root-"));
    fixtures.push({ root: untracked, runtime: untracked });
    const repo = join(untracked, "repo");
    const deep = join(repo, "a", "b");
    mkdirSync(deep, { recursive: true });
    mkdirSync(join(repo, ".git"));

    expect(resolveLeadProjectRoot({ cwd: deep, env: {}, state: fixture.stateOptions })).toBe(repo);

    const bare = join(untracked, "bare");
    mkdirSync(bare);
    expect(resolveLeadProjectRoot({ cwd: bare, env: {}, state: fixture.stateOptions })).toBe(bare);
  });
});

async function daemonFixture() {
  const fixture = stateFixture();
  const daemon = new HeadlessDaemon({ projectRoot: fixture.project, state: fixture.stateOptions, token: "a".repeat(48), principal: "root" });
  fixture.record.daemon = daemon;
  await daemon.start();
  return {
    ...fixture,
    daemon,
    rootClient: new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.stateOptions, token: "a".repeat(48) }),
  };
}

function stateFixture() {
  const root = mkdtempSync(join(tmpdir(), "headless-lead-attach-"));
  const runtime = mkdtempSync("/tmp/hla-");
  const project = join(root, "project");
  mkdirSync(project);
  const record = { root, runtime } as { root: string; runtime: string; daemon?: HeadlessDaemon; pool?: LeadDaemonClientPool };
  fixtures.push(record);
  const stateOptions = { env: { HEADLESS_STATE_HOME: join(root, "state"), HEADLESS_RUNTIME_HOME: runtime }, platform: "linux" as const };
  const state = ensureProjectStateDirectories(getProjectStatePaths(project, stateOptions));
  return { root, runtime, project, state, stateOptions, record };
}
