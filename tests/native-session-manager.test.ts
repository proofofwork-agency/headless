import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBackendDefinition } from "../src/backends/registry";
import { NativeSessionManager, prepareNativeSessionEnvironment } from "../src/runtime/native-session-manager";
import { PersistentSessionStore } from "../src/runtime/persistent-sessions";
import { CLAUDE_SETUP_TOKEN_ENV } from "../src/runtime/native-auth-capsule";
import { ensureProjectStateDirectories, getProjectStatePaths } from "../src/runtime/project-state";
import { createWorkerEnvironment } from "../src/runtime/worker-environment";

const roots: string[] = [];
const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("native session manager", () => {
  test("applies only containment-safe backend environment preparation", () => {
    const fixture = createFixture(false);
    const worker = createWorkerEnvironment({ baseDir: fixture.runtime, sourceEnv: { PATH: process.env.PATH } });
    try {
      const options = {
        prompt: "",
        cwd: fixture.project,
        mode: "read-only" as const,
        containment: "required" as const,
        authMode: "native-login" as const,
        approvalPolicy: "ask" as const,
      };
      const codex = prepareNativeSessionEnvironment(
        getBackendDefinition("codex")!,
        worker,
        { ...options, backend: "codex" },
        "darwin",
      );
      expect(codex).toMatchObject({
        HOME: worker.home,
        SSL_CERT_FILE: "/etc/ssl/cert.pem",
        SSL_CERT_DIR: "/etc/ssl/certs",
      });
      const claude = prepareNativeSessionEnvironment(
        getBackendDefinition("claude-code")!,
        worker,
        { ...options, backend: "claude-code" },
        "darwin",
      );
      expect(claude.CLAUDE_CODE_TMPDIR).toBe(worker.temp);
      const opencode = prepareNativeSessionEnvironment(
        getBackendDefinition("opencode")!,
        worker,
        { ...options, backend: "opencode" },
        "darwin",
      );
      expect(opencode).toMatchObject({
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
      });
      for (const env of [codex, claude, opencode]) {
        expect(Object.keys(env).some((key) => /(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN|SOCKET)$/i.test(key))).toBe(false);
      }
    } finally {
      worker.cleanup();
    }
  });

  test("injects a deliberate Claude setup-token only into native-login environments", () => {
    const fixture = createFixture(false);
    const token = `sk-ant-oat${"E".repeat(32)}`;
    const worker = createWorkerEnvironment({
      baseDir: fixture.runtime,
      sourceEnv: { PATH: process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: "ambient-must-be-scrubbed" },
    });
    try {
      expect(worker.env[CLAUDE_SETUP_TOKEN_ENV]).toBeUndefined();
      worker.credentialEnv[CLAUDE_SETUP_TOKEN_ENV] = token;
      const adapter = getBackendDefinition("claude-code")!;
      const common = {
        backend: "claude-code",
        prompt: "",
        cwd: fixture.project,
        mode: "read-only" as const,
        containment: "required" as const,
        approvalPolicy: "ask" as const,
      };
      const native = prepareNativeSessionEnvironment(adapter, worker, {
        ...common,
        authMode: "native-login",
      }, "darwin");
      const broker = prepareNativeSessionEnvironment(adapter, worker, {
        ...common,
        authMode: "broker",
      }, "darwin");

      expect(native[CLAUDE_SETUP_TOKEN_ENV]).toBe(token);
      expect(broker[CLAUDE_SETUP_TOKEN_ENV]).toBeUndefined();
      expect(native.CLAUDE_CODE_TMPDIR).toBe(worker.temp);
    } finally {
      worker.cleanup();
    }
  });

  test("admits Grok read-only containment but still fails closed before subprocess startup without file auth", async () => {
    const fixture = createFixture(false);
    const sessions = new PersistentSessionStore(fixture.paths);
    const session = sessions.create({
      principal: "owner",
      backend: "grok-build",
      containment: "required",
      authMode: "native-login",
    });
    const manager = new NativeSessionManager(fixture.project, sessions, {
      authHomeDir: fixture.home,
      workerBaseDir: fixture.runtime,
    });

    const result = await manager.turn(session, "must not launch", 5_000);

    expect(result).toMatchObject({
      ok: false,
      status: "blocked",
      sandboxed: false,
      error: { code: "NATIVE_AUTH_UNAVAILABLE" },
      diagnostics: { format: "native-session:prelaunch" },
      containment: {
        requirement: "required",
        enforced: false,
        mechanism: null,
        probe: null,
        isolatedHome: true,
        credentialsIsolated: true,
        network: "denied",
        credentialAccess: "none",
        unsafe: false,
      },
    });
    expect(result.sandboxReason).toBeUndefined();
    expect(result.output).toContain("No native authentication state");
    await manager.closeAll();
  });

  test("reports missing Claude file authentication as a blocked prelaunch outcome", async () => {
    const fixture = createFixture(false);
    const sessions = new PersistentSessionStore(fixture.paths);
    const session = sessions.create({
      principal: "owner",
      backend: "claude-code",
      containment: "required",
      authMode: "native-login",
    });
    const manager = new NativeSessionManager(fixture.project, sessions, {
      authHomeDir: fixture.home,
      workerBaseDir: fixture.runtime,
    });

    const result = await manager.turn(session, "must not launch", 5_000);

    expect(result).toMatchObject({
      ok: false,
      status: "blocked",
      sandboxed: false,
      error: { code: "NATIVE_AUTH_UNAVAILABLE" },
      containment: {
        enforced: false,
        mechanism: null,
        probe: null,
        network: "denied",
        credentialAccess: "none",
        unsafe: false,
      },
    });
    expect(result.sandboxReason).toBeUndefined();
    await manager.closeAll();
  });

  test("reports truthful provider-direct/backend-native evidence for a required native turn", async () => {
    const fixture = createFixture();
    installFakeOpenCode(fixture.bin);
    process.env.PATH = `${fixture.bin}:${originalPath}`;
    const sessions = new PersistentSessionStore(fixture.paths);
    const session = sessions.create({
      principal: "owner",
      backend: "opencode",
      containment: "required",
      authMode: "native-login",
      approvalPolicy: "ask",
    });
    const manager = new NativeSessionManager(fixture.project, sessions, { authHomeDir: fixture.home });

    const result = await manager.turn(session, "contained", 5_000);

    expect(result).toMatchObject({
      ok: true,
      cost: 0.012,
      containment: {
        requirement: "required",
        enforced: true,
        isolatedHome: true,
        credentialsIsolated: true,
        network: "native-direct-unrestricted",
        credentialAccess: "backend-native",
        unsafe: false,
      },
    });
    await manager.closeAll();
  });

  test("creates, resumes, persists metadata, and restores an OpenCode native session after daemon restart", async () => {
    const fixture = createFixture();
    installFakeOpenCode(fixture.bin);
    process.env.PATH = `${fixture.bin}:${originalPath}`;
    const sessions = new PersistentSessionStore(fixture.paths);
    const created = sessions.create({
      principal: "owner",
      backend: "opencode",
      containment: "unsafe",
      authMode: "native-login",
      approvalPolicy: "ask",
    });
    const diagnostics: string[] = [];
    const firstManager = new NativeSessionManager(fixture.project, sessions, {
      authHomeDir: fixture.home,
      diagnostic: (message) => diagnostics.push(message),
    });

    const first = await firstManager.turn(created, "first", 5_000);
    expect(first).toMatchObject({ ok: true, output: "first-reply", cost: 0.012, tokens: 3 });
    const persisted = sessions.get(created.id)!;
    expect(persisted.native).toMatchObject({
      driverKind: "opencode-session",
      nativeSessionId: "native-opencode-1",
      backendVersion: "1.15.3",
      capabilities: { nativeResume: true, providerDirect: true },
      recovery: { state: "ready" },
    });
    await firstManager.closeAll();

    const reopenedStore = new PersistentSessionStore(fixture.paths);
    const restored = reopenedStore.get(created.id)!;
    const secondManager = new NativeSessionManager(fixture.project, reopenedStore, { authHomeDir: fixture.home });
    const second = await secondManager.turn(restored, "second", 5_000);
    expect(second).toMatchObject({ ok: true, output: "resumed-reply", cost: 0.012 });
    expect(reopenedStore.get(created.id)?.native?.recovery.state).toBe("ready");
    expect(diagnostics).toEqual([]);
    await secondManager.closeAll();
  });

  test("passes the safely extracted native default to OpenCode session turns", async () => {
    const fixture = createFixture();
    installFakeOpenCode(fixture.bin);
    process.env.PATH = `${fixture.bin}:${originalPath}`;
    const sessions = new PersistentSessionStore(fixture.paths);
    const session = sessions.create({ principal: "owner", backend: "opencode", containment: "unsafe" });
    const manager = new NativeSessionManager(fixture.project, sessions, { authHomeDir: fixture.home });

    expect((await manager.turn(session, "first", 5_000)).ok).toBe(true);
    expect(readFileSync(join(fixture.project, ".opencode-session-argv"), "utf8")).toContain("--model\nopenai/native-session-default\n");
    await manager.closeAll();
  });

  test("honors an explicit session model and fails before driver launch when no default exists", async () => {
    const explicitFixture = createFixture();
    installFakeOpenCode(explicitFixture.bin);
    process.env.PATH = `${explicitFixture.bin}:${originalPath}`;
    rmSync(join(explicitFixture.home, ".config", "opencode", "opencode.json"));
    const explicitSessions = new PersistentSessionStore(explicitFixture.paths);
    const explicitSession = explicitSessions.create({
      principal: "owner",
      backend: "opencode",
      containment: "unsafe",
      model: "openai/explicit-session",
    });
    const explicitManager = new NativeSessionManager(explicitFixture.project, explicitSessions, { authHomeDir: explicitFixture.home });
    expect((await explicitManager.turn(explicitSession, "first", 5_000)).ok).toBe(true);
    expect(readFileSync(join(explicitFixture.project, ".opencode-session-argv"), "utf8")).toContain("--model\nopenai/explicit-session\n");
    await explicitManager.closeAll();

    const missingFixture = createFixture();
    installFakeOpenCode(missingFixture.bin);
    process.env.PATH = `${missingFixture.bin}:${originalPath}`;
    rmSync(join(missingFixture.home, ".config", "opencode", "opencode.json"));
    const missingSessions = new PersistentSessionStore(missingFixture.paths);
    const missingSession = missingSessions.create({ principal: "owner", backend: "opencode", containment: "unsafe" });
    const missingManager = new NativeSessionManager(missingFixture.project, missingSessions, { authHomeDir: missingFixture.home });
    expect(await missingManager.turn(missingSession, "must not launch", 5_000)).toMatchObject({
      ok: false,
      error: { code: "NATIVE_AUTH_UNAVAILABLE" },
    });
    expect(existsSync(join(missingFixture.project, ".opencode-session-argv"))).toBe(false);
    await missingManager.closeAll();

    const invalidFixture = createFixture();
    installFakeOpenCode(invalidFixture.bin);
    process.env.PATH = `${invalidFixture.bin}:${originalPath}`;
    const invalidSessions = new PersistentSessionStore(invalidFixture.paths);
    const invalidSession = invalidSessions.create({
      principal: "owner",
      backend: "opencode",
      containment: "unsafe",
      model: "openai/unsafe\nmodel",
    });
    const invalidManager = new NativeSessionManager(invalidFixture.project, invalidSessions, { authHomeDir: invalidFixture.home });
    expect(await invalidManager.turn(invalidSession, "must not launch", 5_000)).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    expect(existsSync(join(invalidFixture.project, ".opencode-session-argv"))).toBe(false);
    await invalidManager.closeAll();
  });

  test("refuses native resume when the configured OpenCode model changes", async () => {
    const fixture = createFixture();
    installFakeOpenCode(fixture.bin);
    process.env.PATH = `${fixture.bin}:${originalPath}`;
    const sessions = new PersistentSessionStore(fixture.paths);
    const session = sessions.create({ principal: "owner", backend: "opencode", containment: "unsafe" });
    sessions.append(session.id, "user", "first");
    const firstManager = new NativeSessionManager(fixture.project, sessions, { authHomeDir: fixture.home });
    const first = await firstManager.turn(session, "first", 5_000);
    expect(first.ok).toBe(true);
    sessions.append(session.id, "assistant", first.output);
    await firstManager.closeAll();

    writeFileSync(
      join(fixture.home, ".config", "opencode", "opencode.json"),
      JSON.stringify({ model: "openai/changed-session-default" }),
      { mode: 0o600 },
    );
    sessions.append(session.id, "user", "second");
    const secondManager = new NativeSessionManager(fixture.project, sessions, { authHomeDir: fixture.home });
    const replayed = await secondManager.turn(sessions.get(session.id)!, "second", 5_000);

    expect(replayed).toMatchObject({ ok: true, output: "first-reply" });
    expect(readCalls(fixture.project)).toEqual(["initial", "initial"]);
    expect(sessions.get(session.id)?.native?.recovery.reason).toContain("authentication profile fingerprint changed");
    expect(readFileSync(join(fixture.project, ".opencode-session-argv"), "utf8")).toContain("--model\nopenai/changed-session-default\n");
    await secondManager.closeAll();
  });

  test("returns the structured native-auth error without exposing host HOME content", async () => {
    const fixture = createFixture(false);
    installFakeOpenCode(fixture.bin);
    process.env.PATH = `${fixture.bin}:${originalPath}`;
    writeFileSync(join(fixture.home, "unrelated-secret"), "do-not-copy");
    const sessions = new PersistentSessionStore(fixture.paths);
    const session = sessions.create({ principal: "owner", backend: "opencode", containment: "unsafe" });
    const manager = new NativeSessionManager(fixture.project, sessions, { authHomeDir: fixture.home });
    const result = await manager.turn(session, "test", 5_000);
    expect(result).toMatchObject({
      ok: false,
      status: "blocked",
      sandboxed: false,
      error: { code: "NATIVE_AUTH_UNAVAILABLE" },
      containment: {
        enforced: false,
        mechanism: null,
        probe: null,
        network: "denied",
        credentialAccess: "none",
        unsafe: false,
      },
    });
    expect(result.output).not.toContain("do-not-copy");
    await manager.closeAll();
  });

  test("redacts and bounds generic initialization errors before returning them", async () => {
    const fixture = createFixture();
    installFakeOpenCode(fixture.bin);
    process.env.PATH = `${fixture.bin}:${originalPath}`;
    const secret = `sk-${"s".repeat(32)}`;
    const sessions = new PersistentSessionStore(fixture.paths);
    const session = sessions.create({ principal: "owner", backend: "opencode", containment: "unsafe" });
    const manager = new NativeSessionManager(fixture.project, sessions, { authHomeDir: fixture.home });
    const adapter = getBackendDefinition("opencode")!;
    const originalBuildEnv = adapter.buildEnv;
    adapter.buildEnv = () => { throw new Error(`Native initialization failed with token ${secret}.`); };
    try {
      const result = await manager.turn(session, "must not launch", 5_000);

      expect(result.ok).toBe(false);
      expect(result.output).not.toContain(secret);
      expect(result.error?.message).not.toContain(secret);
      expect(result.output).toContain("[REDACTED_OPENAI_KEY]");
      expect(result.output.length).toBeLessThan(20_000);
      expect(result.redacted).toBe(true);
    } finally {
      adapter.buildEnv = originalBuildEnv;
      await manager.closeAll();
    }
  });

  test("falls back once to bounded redacted replay when a persisted native id is lost", async () => {
    const fixture = createFixture();
    installFakeOpenCode(fixture.bin);
    process.env.PATH = `${fixture.bin}:${originalPath}`;
    const sessions = new PersistentSessionStore(fixture.paths);
    const session = sessions.create({ principal: "owner", backend: "opencode", containment: "unsafe" });
    sessions.append(session.id, "user", "first");
    const firstManager = new NativeSessionManager(fixture.project, sessions, { authHomeDir: fixture.home });
    const first = await firstManager.turn(sessions.get(session.id)!, "first", 5_000);
    expect(first.output).toBe("first-reply");
    sessions.append(session.id, "assistant", first.output);
    await firstManager.closeAll();

    writeFileSync(join(fixture.project, ".lose-native-session"), "1");
    sessions.append(session.id, "user", "second");
    const restored = sessions.get(session.id)!;
    const secondManager = new NativeSessionManager(fixture.project, sessions, { authHomeDir: fixture.home });
    const replayed = await secondManager.turn(restored, "second", 5_000);
    expect(replayed).toMatchObject({ ok: true, output: "first-reply" });
    expect(sessions.get(session.id)?.native?.recovery.state).toBe("ready");
    await secondManager.closeAll();
  });

  test("serializes concurrent first turns so only one native session is created", async () => {
    const fixture = createFixture();
    installFakeOpenCode(fixture.bin);
    process.env.PATH = `${fixture.bin}:${originalPath}`;
    writeFileSync(join(fixture.project, ".slow-turn"), "1");
    const sessions = new PersistentSessionStore(fixture.paths);
    const session = sessions.create({ principal: "owner", backend: "opencode", containment: "unsafe" });
    const manager = new NativeSessionManager(fixture.project, sessions, { authHomeDir: fixture.home });

    const [first, second] = await Promise.all([
      manager.turn(session, "first", 5_000),
      manager.turn(session, "second", 5_000),
    ]);

    expect(first).toMatchObject({ ok: true, output: "first-reply" });
    expect(second).toMatchObject({ ok: true, output: "resumed-reply" });
    expect(readCalls(fixture.project)).toEqual(["initial", "resume"]);
    await manager.closeAll();
  });

  test("does not launch a turn when cancelled during the capability probe", async () => {
    const fixture = createFixture();
    installFakeOpenCode(fixture.bin);
    process.env.PATH = `${fixture.bin}:${originalPath}`;
    writeFileSync(join(fixture.project, ".slow-probe"), "1");
    const sessions = new PersistentSessionStore(fixture.paths);
    const session = sessions.create({ principal: "owner", backend: "opencode", containment: "unsafe" });
    const manager = new NativeSessionManager(fixture.project, sessions, {
      authHomeDir: fixture.home,
      workerBaseDir: fixture.runtime,
    });
    const controller = new AbortController();

    const pending = manager.turn(session, "must-not-run", 5_000, controller.signal);
    await waitForWorkerFile(fixture.runtime, ".probe-started");
    controller.abort("test cancellation");
    const result = await pending;

    expect(result).toMatchObject({ ok: false, status: "cancelled", error: { code: "CANCELLED" } });
    expect(readCalls(fixture.project)).toEqual([]);
    await manager.closeAll();
  }, 15_000);

  test("does not initialize a runtime for a pre-aborted turn", async () => {
    const fixture = createFixture();
    installFakeOpenCode(fixture.bin);
    process.env.PATH = `${fixture.bin}:${originalPath}`;
    writeFileSync(join(fixture.project, ".slow-probe"), "1");
    const sessions = new PersistentSessionStore(fixture.paths);
    const session = sessions.create({ principal: "owner", backend: "opencode", containment: "unsafe" });
    const manager = new NativeSessionManager(fixture.project, sessions, {
      authHomeDir: fixture.home,
      workerBaseDir: fixture.runtime,
    });
    const controller = new AbortController();
    controller.abort("already cancelled");

    const result = await manager.turn(session, "must-not-run", 5_000, controller.signal);

    expect(result).toMatchObject({ ok: false, status: "cancelled", error: { code: "CANCELLED" } });
    expect(workerFileExists(fixture.runtime, ".probe-started")).toBe(false);
    expect(readCalls(fixture.project)).toEqual([]);
    await manager.closeAll();
  });

  test("closeAll observes and cancels a runtime that is still initializing", async () => {
    const fixture = createFixture();
    installFakeOpenCode(fixture.bin);
    process.env.PATH = `${fixture.bin}:${originalPath}`;
    writeFileSync(join(fixture.project, ".slow-probe"), "1");
    const sessions = new PersistentSessionStore(fixture.paths);
    const session = sessions.create({ principal: "owner", backend: "opencode", containment: "unsafe" });
    const manager = new NativeSessionManager(fixture.project, sessions, {
      authHomeDir: fixture.home,
      workerBaseDir: fixture.runtime,
    });

    const pending = manager.turn(session, "must-not-run", 5_000);
    await waitForWorkerFile(fixture.runtime, ".probe-started");
    await manager.closeAll();
    const result = await pending;

    expect(result).toMatchObject({ ok: false, status: "cancelled", error: { code: "CANCELLED" } });
    expect(readCalls(fixture.project)).toEqual([]);
  }, 15_000);

  test("refuses native resume after the auth profile fingerprint changes and uses bounded replay", async () => {
    const fixture = createFixture();
    installFakeOpenCode(fixture.bin);
    process.env.PATH = `${fixture.bin}:${originalPath}`;
    const sessions = new PersistentSessionStore(fixture.paths);
    const session = sessions.create({ principal: "owner", backend: "opencode", containment: "unsafe" });
    sessions.append(session.id, "user", "first");
    const firstManager = new NativeSessionManager(fixture.project, sessions, { authHomeDir: fixture.home });
    const first = await firstManager.turn(sessions.get(session.id)!, "first", 5_000);
    sessions.append(session.id, "assistant", first.output);
    await firstManager.closeAll();
    writeFileSync(join(fixture.home, ".local", "share", "opencode", "auth.json"), JSON.stringify({ token: "rotated-token" }), { mode: 0o600 });
    sessions.append(session.id, "user", "second");

    const secondManager = new NativeSessionManager(fixture.project, sessions, { authHomeDir: fixture.home });
    const replayed = await secondManager.turn(sessions.get(session.id)!, "second", 5_000);

    expect(replayed).toMatchObject({ ok: true, output: "first-reply" });
    expect(readCalls(fixture.project)).toEqual(["initial", "initial"]);
    expect(sessions.get(session.id)?.native?.recovery.reason).toContain("authentication profile fingerprint changed");
    await secondManager.closeAll();
  });

  test("refuses native resume through a different driver and records lost recovery without replay context", async () => {
    const fixture = createFixture();
    installFakeOpenCode(fixture.bin);
    process.env.PATH = `${fixture.bin}:${originalPath}`;
    const sessions = new PersistentSessionStore(fixture.paths);
    const session = sessions.create({ principal: "owner", backend: "opencode", containment: "unsafe" });
    const firstManager = new NativeSessionManager(fixture.project, sessions, { authHomeDir: fixture.home });
    const first = await firstManager.turn(session, "first", 5_000);
    expect(first.ok).toBe(true);
    await firstManager.closeAll();
    const persisted = sessions.get(session.id)!.native!;
    sessions.setNativeMetadata(session.id, { ...persisted, driverKind: "grok-resume" });

    const secondManager = new NativeSessionManager(fixture.project, sessions, { authHomeDir: fixture.home });
    const lost = await secondManager.turn(sessions.get(session.id)!, "second", 5_000);

    expect(lost).toMatchObject({ ok: false, error: { code: "NATIVE_SESSION_LOST" } });
    expect(sessions.get(session.id)?.native).toMatchObject({
      driverKind: "opencode-session",
      nativeSessionId: null,
      recovery: { state: "lost" },
    });
    expect(sessions.get(session.id)?.native?.recovery.reason).toContain("selected session driver differs");
    expect(readCalls(fixture.project)).toEqual(["initial"]);
    await secondManager.closeAll();
  });

  test("preserves native rate-limit retry evidence for durable delegation recovery", async () => {
    const fixture = createFixture();
    installFakeOpenCode(fixture.bin);
    process.env.PATH = `${fixture.bin}:${originalPath}`;
    writeFileSync(join(fixture.project, ".rate-limit"), "1");
    const sessions = new PersistentSessionStore(fixture.paths);
    const session = sessions.create({ principal: "owner", backend: "opencode", containment: "unsafe" });
    const manager = new NativeSessionManager(fixture.project, sessions, { authHomeDir: fixture.home });

    const result = await manager.turn(session, "rate limited", 5_000);

    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      error: {
        code: "RATE_LIMITED",
        retryable: true,
        details: { retryAfterMs: 250, evidence: "HTTP 429 retry-after=250ms" },
      },
      containment: {
        enforced: false,
        mechanism: "native-session:opencode-session",
        probe: "session-driver-factory",
        network: "unrestricted",
        credentialAccess: "backend-native",
        unsafe: true,
      },
    });
    expect(sessions.get(session.id)?.native?.rateLimit).toMatchObject({ limited: true, retryAfterMs: 250 });
    await manager.closeAll();
  });

  test("reports native turn watchdog timeout and output overflow without collapsing them", async () => {
    const timedFixture = createFixture();
    installFakeOpenCode(timedFixture.bin);
    process.env.PATH = `${timedFixture.bin}:${originalPath}`;
    const timedSessions = new PersistentSessionStore(timedFixture.paths);
    const timedSession = timedSessions.create({ principal: "owner", backend: "opencode", containment: "unsafe" });
    const timedManager = new NativeSessionManager(timedFixture.project, timedSessions, { authHomeDir: timedFixture.home });
    expect((await timedManager.turn(timedSession, "warmup", 5_000)).ok).toBe(true);
    writeFileSync(join(timedFixture.project, ".hang-turn"), "1");
    const timed = await timedManager.turn(timedSession, "timeout", 25);
    expect(timed).toMatchObject({ ok: false, status: "timed_out", timedOut: true, error: { code: "TIMED_OUT" } });
    await timedManager.closeAll();

    const overflowFixture = createFixture();
    installFakeOpenCode(overflowFixture.bin);
    process.env.PATH = `${overflowFixture.bin}:${originalPath}`;
    const overflowSessions = new PersistentSessionStore(overflowFixture.paths);
    const overflowSession = overflowSessions.create({ principal: "owner", backend: "opencode", containment: "unsafe" });
    const overflowManager = new NativeSessionManager(overflowFixture.project, overflowSessions, { authHomeDir: overflowFixture.home });
    expect((await overflowManager.turn(overflowSession, "warmup", 5_000)).ok).toBe(true);
    writeFileSync(join(overflowFixture.project, ".overflow-turn"), "1");
    const overflow = await overflowManager.turn(overflowSession, "overflow", 5_000);
    expect(overflow).toMatchObject({ ok: false, truncated: true, error: { code: "OUTPUT_OVERFLOW" } });
    await overflowManager.closeAll();
  });
});

function createFixture(withAuth = true) {
  const root = mkdtempSync(join(tmpdir(), "headless-native-manager-"));
  const runtime = mkdtempSync("/tmp/hnm-");
  const project = join(root, "project");
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(project);
  mkdirSync(home);
  mkdirSync(bin);
  if (withAuth) {
    const authDir = join(home, ".local", "share", "opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({ token: "native-test-token" }), { mode: 0o600 });
  }
  const configDir = join(home, ".config", "opencode");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "opencode.json"), JSON.stringify({ model: "openai/native-session-default" }), { mode: 0o600 });
  roots.push(root, runtime);
  const paths = ensureProjectStateDirectories(getProjectStatePaths(project, {
    env: { ...process.env, HEADLESS_STATE_HOME: join(root, "state"), HEADLESS_RUNTIME_HOME: runtime },
    homeDir: home,
  }));
  return { root, runtime, project, home, bin, paths };
}

function installFakeOpenCode(bin: string) {
  const path = join(bin, "opencode");
  writeFileSync(path, `#!/bin/sh
if [ "$1" = "--version" ]; then
  if [ -f "$PWD/.slow-probe" ]; then
    : > "$HOME/.probe-started"
    sleep 0.25
  fi
  printf '%s\n' 'opencode 1.15.3'
  exit 0
fi
if [ "$1" = "run" ] && [ "$2" = "--help" ]; then
  printf '%s\n' '--session --format --dir'
  exit 0
fi
printf '%s\n' "$@" >> "$PWD/.opencode-session-argv"
resumed=0
for arg in "$@"; do
  if [ "$arg" = "--session" ]; then resumed=1; fi
done
if [ "$resumed" = "1" ]; then
  printf '%s\n' 'resume' >> "$PWD/.opencode-calls"
else
  printf '%s\n' 'initial' >> "$PWD/.opencode-calls"
fi
if [ -f "$PWD/.slow-turn" ]; then sleep 0.1; fi
if [ -f "$PWD/.hang-turn" ]; then exec sleep 60; fi
if [ -f "$PWD/.overflow-turn" ]; then exec awk 'BEGIN { for (i = 0; i < 1100000; i++) printf "x" }'; fi
if [ -f "$PWD/.rate-limit" ]; then
  printf '%s\n' '{"type":"rate_limit","message":"HTTP 429 retry-after=250ms","retry_after_ms":250,"id":"rate-limit-1"}'
  exit 1
fi
if [ "$resumed" = "1" ] && [ -f "$PWD/.lose-native-session" ]; then
  printf '%s\n' 'session native-opencode-1 not found' >&2
  exit 1
fi
printf '%s\n' '{"type":"session.start","sessionID":"native-opencode-1","id":"session-start"}'
if [ "$resumed" = "1" ]; then
  printf '%s\n' '{"type":"part.updated","sessionID":"native-opencode-1","properties":{"part":{"id":"part-1","type":"text","text":"resumed-reply","time":{"end":1}}}}'
else
  printf '%s\n' '{"type":"part.updated","sessionID":"native-opencode-1","properties":{"part":{"id":"part-1","type":"text","text":"first-reply","time":{"end":1}}}}'
fi
printf '%s\n' '{"type":"step_finish","sessionID":"native-opencode-1","tokens":{"input":1,"output":2,"total":3},"cost":0.012,"id":"usage-1"}'
printf '%s\n' '{"type":"session.completed","sessionID":"native-opencode-1","id":"session-completed"}'
`, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function readCalls(project: string) {
  const path = join(project, ".opencode-calls");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];
}

async function waitForWorkerFile(baseDir: string, name: string) {
  const deadline = Date.now() + 10_000;
  while (!workerFileExists(baseDir, name)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${name} beneath ${baseDir}.`);
    await Bun.sleep(5);
  }
}

function workerFileExists(baseDir: string, name: string) {
  return readdirSync(baseDir).some((entry) => existsSync(join(baseDir, entry, "home", name)));
}
