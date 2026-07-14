import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore, integrationTokenPath } from "../src/runtime/credential-store";
import { ensureProjectStateDirectories, getProjectStatePaths } from "../src/runtime/project-state";

const fixtures: string[] = [];
let fixtureIndex = 0;

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

describe("daemon credential registry", () => {
  test("persists only token digests and derives an integration principal", () => {
    const { paths } = fixture();
    const rootToken = "r".repeat(48);
    const store = new CredentialStore(paths, { token: rootToken, principal: "coordinator" });
    const root = store.authenticate(rootToken)!;

    const provisioned = store.provisionIntegration(root, "mcp");
    const integrationToken = readFileSync(integrationTokenPath(paths, "mcp"), "utf8").trim();
    const integration = store.authenticate(integrationToken);
    const registry = readFileSync(paths.credentialsPath, "utf8");

    expect(provisioned.credential.principal).toBe("integration:mcp");
    expect(integration).toMatchObject({
      id: "integration:mcp",
      principal: "integration:mcp",
      kind: "integration",
    });
    expect(integration?.scopes).toContain("run");
    expect(integration?.scopes).not.toContain("admin");
    expect(integration?.scopes).not.toContain("orchestrator");
    expect(registry).not.toContain(rootToken);
    expect(registry).not.toContain(integrationToken);
    expect(statSync(paths.credentialsPath).mode & 0o777).toBe(0o600);
    expect(statSync(integrationTokenPath(paths, "mcp")).mode & 0o777).toBe(0o600);
  });

  test("requires root authority for provisioning and revocation", () => {
    const { paths } = fixture();
    const store = new CredentialStore(paths, { token: "r".repeat(48), principal: "coordinator" });
    const root = store.authenticate("r".repeat(48))!;
    store.provisionIntegration(root, "plugin");
    const token = readFileSync(integrationTokenPath(paths, "plugin"), "utf8").trim();
    const integration = store.authenticate(token)!;

    expect(() => store.provisionIntegration(integration, "attacker")).toThrow("root credential");
    expect(() => store.revoke(integration, "integration:plugin")).toThrow("root credential");
    expect(store.authorize(integration, "ledger:read")).toBe(true);
    expect(store.authorize(integration, "orchestrator")).toBe(false);

    store.revoke(root, "integration:plugin");
    expect(store.authenticate(token)).toBeNull();
  });

  test("rotates a missing or tampered integration token", () => {
    const { paths } = fixture();
    const rootToken = "r".repeat(48);
    const store = new CredentialStore(paths, { token: rootToken, principal: "coordinator" });
    const root = store.authenticate(rootToken)!;
    store.provisionIntegration(root, "mcp");
    const first = readFileSync(integrationTokenPath(paths, "mcp"), "utf8").trim();

    writeFileSync(integrationTokenPath(paths, "mcp"), `${"x".repeat(48)}\n`);
    store.provisionIntegration(root, "mcp");
    const second = readFileSync(integrationTokenPath(paths, "mcp"), "utf8").trim();

    expect(second).not.toBe(first);
    expect(second).not.toBe("x".repeat(48));
    expect(store.authenticate(first)).toBeNull();
    expect(store.authenticate(second)?.principal).toBe("integration:mcp");
  });

  test("never resurrects a revoked integration id through provisioning", () => {
    const { paths } = fixture();
    const rootToken = "r".repeat(48);
    const store = new CredentialStore(paths, { token: rootToken, principal: "coordinator" });
    const root = store.authenticate(rootToken)!;
    store.provisionIntegration(root, "mcp");
    const token = readFileSync(integrationTokenPath(paths, "mcp"), "utf8").trim();
    store.revoke(root, "integration:mcp");

    expect(() => store.provisionIntegration(root, "mcp")).toThrow("revoked");
    expect(store.authenticate(token)).toBeNull();
  });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "headless-credential-store-"));
  fixtures.push(root);
  const project = join(root, "project");
  const stateHome = join(root, "state");
  const runtimeHome = join(tmpdir(), `hcred-${process.pid}-${fixtureIndex++}`);
  fixtures.push(runtimeHome);
  mkdirSync(project);
  const paths = ensureProjectStateDirectories(getProjectStatePaths(project, {
    env: { HEADLESS_STATE_HOME: stateHome, HEADLESS_RUNTIME_HOME: runtimeHome },
  }));
  return { paths };
}
