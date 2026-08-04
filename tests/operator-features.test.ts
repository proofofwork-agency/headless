import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopService } from "../src/daemon/loop-service";
import { LeadBindingStore } from "../src/runtime/lead-binding";
import { LoopStore } from "../src/runtime/loop-store";
import { migrateSingleLeadState } from "../src/runtime/project-state-migration";
import { ensureProjectStateDirectories, getProjectStatePaths } from "../src/runtime/project-state";
import { SkillRegistry } from "../src/runtime/skill-registry";
import { schedulingWindow, setTestTimeout } from "./support/timing";

setTestTimeout(2_000);

const roots: string[] = [];
const runtimeRoots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); while (runtimeRoots.length) rmSync(runtimeRoots.pop()!, { recursive: true, force: true }); });

describe("single-lead migration and retained automation foundations", () => {
  test("rotates one durable foreground lead and rejects previous generations", () => {
    const paths = fixture();
    let now = 100;
    const leads = new LeadBindingStore(paths, () => now);
    expect(leads.status()).toBeNull();
    const codex = leads.use({ host: "codex", backendId: "codex", integrationPrincipal: "integration:lead-codex-g1", generation: 1 });
    expect(codex).toMatchObject({ generation: 1, status: "configured", attachedAt: null });
    now = 110;
    expect(leads.attach(codex.integrationPrincipal, 1)).toMatchObject({ status: "connected", attachedAt: 110, lastSeenAt: 110 });
    now = 120;
    expect(leads.heartbeat(codex.integrationPrincipal, 1).lastSeenAt).toBe(120);

    now = 130;
    const opencode = leads.use({ host: "opencode", backendId: "opencode", integrationPrincipal: "integration:lead-opencode-g2", generation: 2 });
    expect(opencode).toMatchObject({ generation: 2, status: "configured" });
    expect(() => leads.assertCurrent(codex.integrationPrincipal, 1)).toThrow("no longer active");
    expect(leads.release()).toMatchObject({ host: "opencode", generation: 2 });
    expect(leads.status()).toBeNull();
    expect(leads.nextGeneration()).toBe(4);
  });

  test("expires a lost lead heartbeat without electing a replacement", () => {
    const paths = fixture();
    let now = 100;
    const leads = new LeadBindingStore(paths, () => now);
    const lead = leads.use({ host: "codex", backendId: "codex", integrationPrincipal: "integration:lead-codex-g1", generation: 1 });
    leads.attach(lead.integrationPrincipal, 1);
    now += 45_001;
    expect(leads.status()).toMatchObject({ host: "codex", generation: 1, status: "disconnected" });
  });

  test("archives private-alpha control metadata, migrates synthesis fields, and leaves ledger bytes untouched", () => {
    const paths = fixture();
    const ledger = "{\"seq\":1,\"hash\":\"unchanged\"}\n";
    writeFileSync(paths.ledgerPath, ledger, { mode: 0o600 });
    writeFileSync(paths.legacyOperatorStatePath, JSON.stringify({ proposals: [{ id: "pending", status: "pending" }], cores: [{ sessionId: "session-preserved-elsewhere" }] }), { mode: 0o600 });
    writeFileSync(paths.legacyContextRelayAdapterPath, JSON.stringify({ envelopes: [{ id: "legacy-external" }] }), { mode: 0o600 });
    writeFileSync(paths.fleetProfilesPath, JSON.stringify({ version: 1, projectId: paths.projectId, profiles: [{ id: "fleet-one", coordinator: { kind: "automatic" }, agents: [] }] }), { mode: 0o600 });
    writeFileSync(join(paths.goalsDir, "goal-one.json"), JSON.stringify({ goal: { id: "goal-one", coordinator: { kind: "human" }, leaderAgentId: "worker-one" } }), { mode: 0o600 });

    const migrated = migrateSingleLeadState(paths, 500);
    expect(migrated).toMatchObject({
      migratedAt: 500,
      fleetCoordinatorFieldsDiscarded: 1,
      goalsMigrated: ["goal-one"],
      ledgerModified: false,
      externalContextRelayState: "intentionally-left-untouched",
    });
    expect(migrated.archived).toHaveLength(2);
    expect(migrated.archived.find((item) => item.source === paths.legacyOperatorStatePath)?.pendingProposals).toBe(1);
    expect(readFileSync(paths.ledgerPath, "utf8")).toBe(ledger);
    expect(existsSync(paths.legacyOperatorStatePath)).toBe(false);
    expect(existsSync(paths.legacyContextRelayAdapterPath)).toBe(false);
    expect(JSON.parse(readFileSync(paths.fleetProfilesPath, "utf8")).profiles[0]).not.toHaveProperty("coordinator");
    expect(JSON.parse(readFileSync(join(paths.goalsDir, "goal-one.json"), "utf8")).goal).toMatchObject({
      synthesizer: { kind: "automatic" },
      synthesizerAgentId: "worker-one",
    });
    expect(migrateSingleLeadState(paths, 900)).toEqual(migrated);
  });

  test("imports only immutable text skills, requires enablement, audits use, and rejects links and executables", () => {
    const paths = fixture();
    const source = join(roots[roots.length - 1]!, "skill-source");
    mkdirSync(join(source, "references"), { recursive: true });
    writeFileSync(join(source, "manifest.json"), JSON.stringify({ schemaVersion: 1, id: "reviewer", version: "1.0.0", name: "Reviewer", license: "MIT", instructions: "instructions.md", references: ["references/checklist.md"], tools: [], requirements: { read: true, write: false, network: false, delegation: false }, roles: ["reviewer"], providers: ["codex", "claude-code"], verification: ["report evidence"] }));
    writeFileSync(join(source, "instructions.md"), "Review bounded evidence only.");
    writeFileSync(join(source, "references/checklist.md"), "- tests\n- containment");
    const skills = new SkillRegistry(paths);
    const imported = skills.import(source, "operator");
    expect(imported.state).toBe("quarantined");
    expect(() => skills.invocation("reviewer@1.0.0", "check", "operator", ["codex"])).toThrow("explicit enablement");
    skills.enable("reviewer@1.0.0", "operator");
    const invocation = skills.invocation("reviewer@1.0.0", "check", "operator", ["codex"]);
    expect(invocation.prompt).toContain("Native provider skills");
    skills.completeInvocation(invocation.auditId, { status: "succeeded" });
    expect(skills.audit()).toHaveLength(1);
    expect(skills.audit()[0]?.result).toContain("succeeded");
    const registryPath = join(paths.skillsDir, "registry.json");
    const legacyRegistry = JSON.parse(readFileSync(registryPath, "utf8"));
    delete legacyRegistry.audit[0].jobId;
    delete legacyRegistry.audit[0].status;
    writeFileSync(registryPath, JSON.stringify(legacyRegistry), { mode: 0o600 });
    expect(new SkillRegistry(paths).audit()[0]).toMatchObject({ jobId: null, status: "admitted" });

    const linked = join(roots[roots.length - 1]!, "linked-skill");
    mkdirSync(linked); writeFileSync(join(linked, "manifest.json"), "{}"); symlinkSync(join(source, "instructions.md"), join(linked, "instructions.md"));
    expect(() => skills.import(linked, "operator")).toThrow("symbolic link");
    chmodSync(join(source, "instructions.md"), 0o700);
    const second = new SkillRegistry(paths);
    expect(() => second.import(source, "operator")).toThrow("executable content");
  });

  test("runs a finite loop once, persists deterministic admission, and terminates on success", async () => {
    const paths = fixture();
    const started: string[] = [];
    const service = new LoopService({
      store: new LoopStore(paths),
      startGoal: (_target, _principal, workId) => { started.push(workId); return { id: workId }; },
      goalStatus: () => ({ state: "succeeded", terminal: true, succeeded: true }),
      startWorkflow: (_definition, _principal, workId) => ({ id: workId }),
      workflowStatus: () => ({ state: "succeeded", terminal: true, succeeded: true }),
      cancelGoal: () => undefined, cancelWorkflow: () => undefined,
    });
    const loop = service.start(policy(), "operator");
    await waitUntil(() => service.store.get(loop.id)?.state === "succeeded");
    const completed = service.store.get(loop.id)!;
    expect(completed.iterations).toHaveLength(1);
    expect(completed.iterations[0]?.id).toBe(`${loop.id}-iteration-1`);
    expect(started).toEqual([`${loop.id}-iteration-1-goal`]);
    service.dispose();
  });

  test("reconciles an admitted loop iteration with one deterministic logical work id after restart", async () => {
    const paths = fixture();
    const store = new LoopStore(paths);
    const created = store.create(policy(), "operator");
    store.update(created.id, (loop) => {
      loop.state = "running";
      loop.usedCostUsd = 1;
      loop.usedRequests = 1;
      loop.iterations.push({ id: `${loop.id}-iteration-1`, number: 1, state: "admitted", workKind: "goal", workId: null, admittedAt: Date.now(), completedAt: null, reservedCostUsd: 1, requests: 1, error: null });
    });
    const logical = new Set<string>();
    const service = new LoopService({ store, startGoal: (_target, _principal, workId) => { logical.add(workId); return { id: workId }; }, goalStatus: () => ({ state: "succeeded", terminal: true, succeeded: true }), startWorkflow: (_definition, _principal, workId) => ({ id: workId }), workflowStatus: () => ({ state: "succeeded", terminal: true, succeeded: true }), cancelGoal: () => undefined, cancelWorkflow: () => undefined });
    service.recover();
    await waitUntil(() => store.get(created.id)?.state === "succeeded");
    service.dispose();
    const restarted = new LoopService({ store, startGoal: (_target, _principal, workId) => { logical.add(workId); return { id: workId }; }, goalStatus: () => ({ state: "succeeded", terminal: true, succeeded: true }), startWorkflow: (_definition, _principal, workId) => ({ id: workId }), workflowStatus: () => ({ state: "succeeded", terminal: true, succeeded: true }), cancelGoal: () => undefined, cancelWorkflow: () => undefined });
    restarted.recover();
    await Bun.sleep(20);
    expect(logical).toEqual(new Set([`${created.id}-iteration-1-goal`]));
  });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "headless-operator-features-")); roots.push(root);
  const project = join(root, "project"); mkdirSync(project);
  const runtime = join("/tmp", `hof-${process.pid}-${roots.length}`); runtimeRoots.push(runtime);
  return ensureProjectStateDirectories(getProjectStatePaths(project, { env: { HEADLESS_STATE_HOME: join(root, "state"), HEADLESS_RUNTIME_HOME: runtime }, platform: "linux" }));
}
function policy() { return { target: { kind: "goal" as const, objective: "finish once", mode: "read-only" as const }, maxIterations: 5, deadline: Date.now() + 60_000, perIteration: { maxCostUsd: 1, maxRequests: 1 }, aggregate: { maxCostUsd: 5, maxRequests: 5 }, backoff: { kind: "fixed" as const, initialMs: 0, maxMs: 0 }, success: "target-succeeded" as const, terminalFailures: ["blocked" as const], approvalPolicy: "ask" as const, integrationPolicy: "preserve" as const }; }
async function waitUntil(predicate: () => boolean) { const deadline = Date.now() + schedulingWindow(2_000); while (!predicate()) { if (Date.now() > deadline) throw new Error("timed out"); await Bun.sleep(10); } }
