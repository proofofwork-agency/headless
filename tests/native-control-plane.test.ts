import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunRequestSchema } from "../src/contracts/run";
import { DaemonMethodSchema, GoalStartParamsSchema, SessionCreateParamsSchema } from "../src/daemon/protocol";
import { DAEMON_ROUTES, parseDaemonRouteParams } from "../src/daemon/routes";
import { ensureProjectStateDirectories, getProjectStatePaths } from "../src/runtime/project-state";
import { ProjectTrustStore } from "../src/runtime/project-trust-store";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("native-login control plane", () => {
  test("defaults runs to native login with optional model and explicit approval policy", () => {
    const request = RunRequestSchema.parse({ backend: "codex", prompt: "inspect", projectRoot: process.cwd() });
    expect(request).toMatchObject({
      authMode: "native-login",
      approvalPolicy: "ask",
    });
    expect(request.model).toBeUndefined();
    expect(RunRequestSchema.parse({ ...request, authMode: "broker", approvalPolicy: "bypass" })).toMatchObject({
      authMode: "broker",
      approvalPolicy: "bypass",
    });
    expect(RunRequestSchema.parse({ ...request, backend: "grok-build", agent: "review" }).agent).toBe("review");
    expect(() => RunRequestSchema.parse({ ...request, backend: "grok-build", agent: "custom" })).toThrow();
    expect(() => RunRequestSchema.parse({ ...request, backend: "opencode", agent: "agent.toml" })).toThrow();
    expect(SessionCreateParamsSchema.parse({ backend: "grok-build", agent: "build" }).agent).toBe("build");
    expect(() => SessionCreateParamsSchema.parse({ backend: "grok-build", agent: "custom" })).toThrow();
  });

  test("defaults collaborative goals to read-only and strictly validates write mode", () => {
    expect(GoalStartParamsSchema.parse({ objective: "Review the candidate." })).toMatchObject({
      mode: "read-only",
    });
    expect(GoalStartParamsSchema.parse({ objective: "Implement the candidate.", mode: "write" })).toMatchObject({
      mode: "write",
    });
    expect(() => GoalStartParamsSchema.parse({ objective: "Escape containment.", mode: "unsafe" })).toThrow();
    expect(() => GoalStartParamsSchema.parse({ objective: "Spoof a root.", projectRoot: "/tmp/other" })).toThrow();
  });

  test("persists one-time project trust owner-only and revokes native/bypass authority together", () => {
    const project = fixture("headless-trust-project-");
    const stateHome = fixture("headless-trust-state-");
    const runtimeHome = shortRuntimeFixture();
    const paths = ensureProjectStateDirectories(getProjectStatePaths(project, {
      env: { HEADLESS_STATE_HOME: stateHome, HEADLESS_RUNTIME_HOME: runtimeHome },
      homeDir: stateHome,
      platform: "linux",
    }));
    const store = new ProjectTrustStore(paths);
    expect(store.status()).toMatchObject({ trusted: false, nativeLoginAllowed: false, bypassAllowed: false });
    expect(existsSync(paths.projectTrustPath)).toBe(false);

    const granted = store.grant({ principal: "coordinator", nativeLoginAllowed: true, bypassAllowed: true });
    expect(granted).toMatchObject({ trusted: true, trustedBy: "coordinator", nativeLoginAllowed: true, bypassAllowed: true });
    expect(statSync(paths.projectTrustPath).mode & 0o777).toBe(0o600);
    expect(store.assertNativeLoginAllowed("bypass")).toMatchObject({ trusted: true });

    expect(store.revoke()).toMatchObject({ trusted: false, nativeLoginAllowed: false, bypassAllowed: false });
    expect(() => store.assertNativeLoginAllowed("ask")).toThrow("one-time project trust");
  });

  test("keeps route schema, scope, and handler metadata exhaustive and rejects client roots", () => {
    const methods = DaemonMethodSchema.options;
    expect(Object.keys(DAEMON_ROUTES).sort()).toEqual([...methods].sort());
    for (const method of methods) {
      expect(DAEMON_ROUTES[method].method).toBe(method);
      expect(DAEMON_ROUTES[method].schema).toBeDefined();
      expect(DAEMON_ROUTES[method].handler.length).toBeGreaterThan(0);
    }
    expect(() => parseDaemonRouteParams("run.submit", {
      backend: "codex",
      prompt: "inspect",
      projectRoot: "/tmp/client-controlled",
    })).toThrow();
    expect(parseDaemonRouteParams("run.submit", { backend: "codex", prompt: "inspect" })).toMatchObject({
      authMode: "native-login",
      approvalPolicy: "ask",
    });
  });
});

function fixture(prefix: string) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

function shortRuntimeFixture() {
  const path = mkdtempSync("/tmp/headless-run-");
  roots.push(path);
  return path;
}
