import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { connectOrStartDaemon } from "../src/daemon/connect";
import { HeadlessDaemonClient } from "../src/daemon/client";
import {
  DAEMON_EXTENSION_MANIFEST_ENV,
  resolveDaemonExtensionConfig,
  serializeDaemonExtensionManifest,
} from "../src/runtime/daemon-extensions";
import type { Job } from "../src/contracts/durable";
import { getProjectStatePaths } from "../src/runtime/project-state";

const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;
const indexUrl = new URL("../src/index.ts", import.meta.url).href;
const serverUrl = new URL("../src/daemon/server.ts", import.meta.url).href;
const children = new Set<ReturnType<typeof Bun.spawn>>();
const detachedDaemonPids = new Set<number>();
const roots: string[] = [];

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited.catch(() => {});
  }
  children.clear();
  for (const pid of detachedDaemonPids) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  detachedDaemonPids.clear();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("trusted daemon extension startup", () => {
  test("validates, canonicalizes, fingerprints, and bounds config entrypoints", () => {
    const root = scratch("headless-extension-config-");
    const modulePath = join(root, "fixture.mjs");
    const configPath = join(root, "extensions.json");
    writeFileSync(modulePath, "export default () => {}\n", { mode: 0o600 });
    writeFileSync(configPath, `${JSON.stringify({ version: 1, modules: ["./fixture.mjs"] })}\n`, { mode: 0o600 });

    const resolved = resolveDaemonExtensionConfig({ configPath });
    expect(resolved.configPath).toBe(realpathSync(configPath));
    expect(resolved.modules).toEqual([{ path: realpathSync(modulePath), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    expect(resolved.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(() => resolveDaemonExtensionConfig({ configPath: "relative.json" })).toThrow("must be absolute");

    chmodSync(modulePath, 0o666);
    expect(() => resolveDaemonExtensionConfig({ configPath })).toThrow("must not be writable by group or other users");
  });

  test("rejects config and module files beneath writable ancestor directories", () => {
    const root = scratch("headless-extension-ancestors-");
    const safeModule = join(root, "safe.mjs");
    writeFileSync(safeModule, "export default () => {}\n", { mode: 0o600 });

    const badConfigRoot = join(root, "writable-config-parent");
    mkdirSync(badConfigRoot, { mode: 0o700 });
    chmodSync(badConfigRoot, 0o770);
    const badConfig = join(badConfigRoot, "extensions.json");
    writeFileSync(badConfig, `${JSON.stringify({ version: 1, modules: [safeModule] })}\n`, { mode: 0o600 });
    expect(() => resolveDaemonExtensionConfig({ configPath: badConfig })).toThrow(
      "ancestor must not be writable by group or other users",
    );

    const badModuleRoot = join(root, "writable-module-parent");
    mkdirSync(badModuleRoot, { mode: 0o700 });
    chmodSync(badModuleRoot, 0o707);
    const badModule = join(badModuleRoot, "extension.mjs");
    writeFileSync(badModule, "export default () => {}\n", { mode: 0o600 });
    const safeConfig = join(root, "safe-extensions.json");
    writeFileSync(safeConfig, `${JSON.stringify({ version: 1, modules: [badModule] })}\n`, { mode: 0o600 });
    expect(() => resolveDaemonExtensionConfig({ configPath: safeConfig })).toThrow(
      "ancestor must not be writable by group or other users",
    );
  });

  test("never executes a module renamed after the parent fingerprints its detached-child manifest", async () => {
    const root = scratch("headless-extension-replacement-");
    const project = join(root, "project");
    const stateHome = join(root, "state");
    const runtimeHome = join("/tmp", `headless-ext-replace-${process.pid}-${randomUUID().slice(0, 8)}`);
    roots.push(runtimeHome);
    mkdirSync(project);
    mkdirSync(runtimeHome, { mode: 0o700 });
    const modulePath = join(root, "extension.mjs");
    const replacementPath = join(root, "replacement.mjs");
    const configPath = join(root, "extensions.json");
    const marker = join(root, "replacement-executed");
    writeFileSync(modulePath, extensionSource(), { mode: 0o600 });
    writeFileSync(configPath, `${JSON.stringify({ version: 1, modules: [modulePath] })}\n`, { mode: 0o600 });
    const manifest = serializeDaemonExtensionManifest(resolveDaemonExtensionConfig({ configPath }));
    writeFileSync(replacementPath, `
await Bun.write(${JSON.stringify(marker)}, "executed");
export default function register() {}
`, { mode: 0o600 });
    renameSync(replacementPath, modulePath);

    const child = Bun.spawn([process.execPath, cliPath, "daemon", "serve", "--cwd", project], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      env: {
        ...process.env,
        HEADLESS_STATE_HOME: stateHome,
        HEADLESS_RUNTIME_HOME: runtimeHome,
        [DAEMON_EXTENSION_MANIFEST_ENV]: manifest,
      },
    });
    children.add(child);
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      Bun.readableStreamToText(child.stderr),
    ]);
    children.delete(child);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("changed after parent startup resolution");
    expect(existsSync(marker)).toBe(false);
  }, 10_000);

  test("public exec bootstraps a detached daemon from the parent's exact startup manifest", async () => {
    const root = scratch("headless-extension-detached-");
    const project = join(root, "project");
    const stateHome = join(root, "state");
    const runtimeHome = join("/tmp", `headless-ext-detached-${process.pid}-${randomUUID().slice(0, 8)}`);
    roots.push(runtimeHome);
    mkdirSync(project);
    mkdirSync(runtimeHome, { mode: 0o700 });
    const modulePath = join(root, "fixture-extension.mjs");
    const configPath = join(root, "extensions.json");
    const publicClientPath = join(root, "public-detached-client.mjs");
    writeFileSync(modulePath, extensionSource(), { mode: 0o600 });
    writeFileSync(configPath, `${JSON.stringify({ version: 1, modules: [modulePath] })}\n`, { mode: 0o600 });
    writeFileSync(publicClientPath, `
import { exec } from ${JSON.stringify(indexUrl)};
console.log(JSON.stringify(await exec({
  backend: "package-fixture",
  cwd: ${JSON.stringify(project)},
  prompt: "detached manifest request",
  model: "package-provider/test-model",
  authMode: "broker",
  containment: "unsafe",
  timeoutMs: 5_000,
  extensionConfigPath: ${JSON.stringify(configPath)},
})));
`, { mode: 0o600 });
    const env = {
      ...process.env,
      HEADLESS_STATE_HOME: stateHome,
      HEADLESS_RUNTIME_HOME: runtimeHome,
      PACKAGE_FIXTURE_PROVIDER_KEY: "detached-fixture-key",
    };
    const clientProcess = Bun.spawn([process.execPath, publicClientPath], {
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      Bun.readableStreamToText(clientProcess.stdout),
      Bun.readableStreamToText(clientProcess.stderr),
      clientProcess.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      backend: "package-fixture",
      output: "extension:detached manifest request",
    });

    const state = getProjectStatePaths(project, { env });
    const metadata = JSON.parse(readFileSync(state.daemonMetadataPath, "utf8")) as { pid: number };
    detachedDaemonPids.add(metadata.pid);
    const daemonClient = new HeadlessDaemonClient({ projectRoot: project, state: { env } });
    expect(await daemonClient.call("ping")).toMatchObject({
      extensionAdapters: ["package-fixture"],
      extensionProviders: ["package-provider"],
      extensionPricing: ["package-provider-test-pricing"],
    });
    await daemonClient.call("budget.upsert", {
      id: "extension-priced-cap",
      provider: "package-provider",
      maxCostUsd: 0.0001,
    });
    const blocked = await daemonClient.call<Job>("run.submit", {
      backend: "package-fixture",
      prompt: "priced admission must exceed the cap",
      model: "package-provider/test-model",
      authMode: "broker",
      containment: "unsafe",
      timeoutMs: 5_000,
    });
    expect(blocked.result).toMatchObject({
      status: "blocked",
      error: { code: "BUDGET_EXCEEDED", message: expect.stringContaining("cost limit exceeded") },
    });
    await daemonClient.call("budget.upsert", {
      id: "extension-priced-cap",
      provider: "package-provider",
      maxCostUsd: 0.01,
    });
    const admitted = await daemonClient.call<Job>("run.submit", {
      backend: "package-fixture",
      prompt: "priced admission fits the enlarged cap",
      model: "package-provider/test-model",
      authMode: "broker",
      containment: "unsafe",
      timeoutMs: 5_000,
    });
    expect(admitted.result?.error?.message ?? "").not.toContain("cost limit exceeded");
    const admittedResult = admitted.result
      ? admitted
      : await daemonClient.call<Job>("run.wait", { jobId: admitted.id, timeoutMs: 5_000 }, 7_000);
    // This fixture makes no provider request and reports no usage, so the
    // final budget gate correctly fails unknown actual cost. Reaching worker
    // output proves the dated estimate admitted under the enlarged cap.
    expect(admittedResult.result).toMatchObject({
      output: "extension:priced admission fits the enlarged cap",
      error: { code: "BUDGET_EXCEEDED", message: "Required budget gate has not passed." },
    });
    process.kill(metadata.pid, "SIGTERM");
    await waitForProcessExit(metadata.pid);
    detachedDaemonPids.delete(metadata.pid);
  }, 15_000);

  test("loads adapters and providers before a cross-process daemon serves public exec", async () => {
    const root = scratch("headless-daemon-extension-");
    const project = join(root, "project");
    const stateHome = join(root, "state");
    const runtimeHome = join("/tmp", `headless-ext-${process.pid}-${randomUUID().slice(0, 8)}`);
    roots.push(runtimeHome);
    mkdirSync(project);
    mkdirSync(runtimeHome, { mode: 0o700 });

    const modulePath = join(root, "fixture-extension.mjs");
    const configPath = join(root, "extensions.json");
    const evilModulePath = join(root, "request-payload-evil.mjs");
    const evilConfigPath = join(root, "evil-extensions.json");
    const evilMarker = join(root, "request-module-loaded");
    writeFileSync(modulePath, extensionSource(), { mode: 0o600 });
    writeFileSync(configPath, `${JSON.stringify({ version: 1, modules: ["./fixture-extension.mjs"] })}\n`, { mode: 0o600 });
    writeFileSync(evilModulePath, `await Bun.write(${JSON.stringify(evilMarker)}, "loaded"); export default () => {};\n`, { mode: 0o600 });
    writeFileSync(evilConfigPath, `${JSON.stringify({ version: 1, modules: ["./request-payload-evil.mjs"] })}\n`, { mode: 0o600 });

    const env = {
      ...process.env,
      HEADLESS_STATE_HOME: stateHome,
      HEADLESS_RUNTIME_HOME: runtimeHome,
      HEADLESS_EXTENSION_CONFIG: configPath,
      PACKAGE_FIXTURE_PROVIDER_KEY: "daemon-only-fixture-key",
    };
    const state = { env };
    const daemon = await startDaemon(project, env, state);
    const ping = await daemon.client.call<{
      extensionConfigDigest: string;
      extensionAdapters: string[];
      extensionProviders: string[];
      extensionPricing: string[];
    }>("ping");
    expect(ping.extensionConfigDigest).toBe(resolveDaemonExtensionConfig({ configPath }).digest);
    expect(ping.extensionAdapters).toEqual(["package-fixture"]);
    expect(ping.extensionProviders).toEqual(["package-provider"]);
    expect(ping.extensionPricing).toEqual(["package-provider-test-pricing"]);

    const publicClientPath = join(root, "public-client.mjs");
    writeFileSync(publicClientPath, `
import { exec } from ${JSON.stringify(indexUrl)};
const result = await exec({
  backend: "package-fixture",
  cwd: ${JSON.stringify(project)},
  prompt: "public extension request",
  model: "package-provider/test-model",
  authMode: "broker",
  containment: "unsafe",
  timeoutMs: 5_000,
  extensionConfigPath: ${JSON.stringify(configPath)},
});
console.log(JSON.stringify(result));
`, { mode: 0o600 });
    const publicRun = Bun.spawn([process.execPath, publicClientPath], {
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      Bun.readableStreamToText(publicRun.stdout),
      Bun.readableStreamToText(publicRun.stderr),
      publicRun.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      backend: "package-fixture",
      output: "extension:public extension request",
      containment: { unsafe: true },
    });

    await expect(daemon.client.call<Job>("run.submit", {
      backend: "package-fixture",
      prompt: "payload cannot load code",
      model: "package-provider/test-model",
      authMode: "broker",
      containment: "unsafe",
      timeoutMs: 5_000,
      extensionConfigPath: evilConfigPath,
      extensionModules: [evilModulePath],
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(existsSync(evilMarker)).toBe(false);

    const { HEADLESS_EXTENSION_CONFIG: _configuredPath, ...mismatchEnv } = env;
    await expect(connectOrStartDaemon({
      projectRoot: project,
      state: { env: mismatchEnv },
      extensionConfigPath: evilConfigPath,
    })).rejects.toMatchObject({ code: "EXTENSION_CONFIG_MISMATCH" });
    expect(existsSync(evilMarker)).toBe(false);
  }, 15_000);

  test("fails closed when embedded daemons request different process-global extension registries", async () => {
    const root = scratch("headless-embedded-extension-");
    const firstProject = join(root, "first");
    const secondProject = join(root, "second");
    const stateHome = join(root, "state");
    const runtimeHome = join("/tmp", `headless-ext-process-${process.pid}-${randomUUID().slice(0, 8)}`);
    roots.push(runtimeHome);
    mkdirSync(firstProject);
    mkdirSync(secondProject);
    mkdirSync(runtimeHome, { mode: 0o700 });
    const modulePath = join(root, "fixture-extension.mjs");
    const configPath = join(root, "extensions.json");
    writeFileSync(modulePath, extensionSource(), { mode: 0o600 });
    writeFileSync(configPath, `${JSON.stringify({ version: 1, modules: [modulePath] })}\n`, { mode: 0o600 });
    const script = join(root, "embedded-check.mjs");
    writeFileSync(script, `
import { HeadlessDaemon } from ${JSON.stringify(serverUrl)};
const state = { env: { ...process.env, HEADLESS_STATE_HOME: ${JSON.stringify(stateHome)}, HEADLESS_RUNTIME_HOME: ${JSON.stringify(runtimeHome)} } };
const first = new HeadlessDaemon({ projectRoot: ${JSON.stringify(firstProject)}, state, extensionConfigPath: ${JSON.stringify(configPath)} });
await first.start();
await first.stop();
const second = new HeadlessDaemon({ projectRoot: ${JSON.stringify(secondProject)}, state });
try {
  await second.start();
  await second.stop();
  console.log("UNEXPECTED_SUCCESS");
  process.exitCode = 2;
} catch (error) {
  console.log(String(error?.message || error));
}
`, { mode: 0o600 });
    const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe", env: process.env });
    const [stdout, stderr, exitCode] = await Promise.all([
      Bun.readableStreamToText(child.stdout),
      Bun.readableStreamToText(child.stderr),
      child.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain("cannot host daemons with different extension configurations");
    expect(stdout).not.toContain("UNEXPECTED_SUCCESS");
  }, 10_000);
});

function extensionSource() {
  return `
export default async function register(api) {
  if (api.version !== 1) throw new Error("unsupported extension API");
  api.registerProvider({
    id: "package-provider",
    upstream: "http://127.0.0.1:9",
    credentialEnv: "PACKAGE_FIXTURE_PROVIDER_KEY",
    routePrefixes: ["/v1/chat/completions"],
    authenticate(headers, credential) { headers.set("authorization", \`Bearer \${credential}\`); },
    validateBoundedInput() { return null; },
  });
  api.registerPricing({
    id: "package-provider-test-pricing",
    provider: "package-provider",
    model: "*",
    effectiveFrom: 0,
    effectiveTo: null,
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
    cachedInputUsdPerMillion: 0.5,
    inputIncludesCached: true,
  });
  api.registerAdapter({
    id: "package-fixture",
    metadata: { id: "package-fixture", aliases: [], promptDelivery: "native", timeoutMs: 5_000, maxDepth: null, canRead: true, canWrite: false },
    capabilities: { write: false, streaming: false, structuredOutput: true, nativeResume: false, cancellation: true, tools: false, effort: false, brokerCompatible: false },
    security: { outerContainmentRequired: true, strictAuth: "broker-api-key", disablesProjectConfig: true, disablesHooks: true, disablesMcp: true, disablesSkills: true },
    probe: { versionCommand: ["/usr/bin/true"], helpCommand: ["/usr/bin/true"], requiredHelpFragments: [], timeoutMs: 1_000, maxOutputBytes: 1_024 },
    stdinPrompt: false,
    credentialPrefixes: [],
    buildCommand(options) { return ["/usr/bin/printf", \`extension:\${options.prompt}\`]; },
    parse(stdout) { return { output: stdout, cost: null, tokens: null, error: null }; },
  });
}
`;
}

function scratch(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function startDaemon(
  project: string,
  env: NodeJS.ProcessEnv,
  state: { env: NodeJS.ProcessEnv },
) {
  const child = Bun.spawn([process.execPath, cliPath, "daemon", "serve", "--cwd", project], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    env,
  });
  children.add(child);
  const stderrPromise = Bun.readableStreamToText(child.stderr);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`daemon exited during startup (${child.exitCode}): ${await stderrPromise}`);
    try {
      const client = new HeadlessDaemonClient({ projectRoot: project, state, timeoutMs: 250 });
      await client.call("ping", {}, 250);
      return { child, client, stderrPromise };
    } catch {
      await Bun.sleep(25);
    }
  }
  child.kill("SIGTERM");
  throw new Error(`daemon did not become ready: ${await stderrPromise}`);
}

async function waitForProcessExit(pid: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!processIsRunning(pid)) return;
    await Bun.sleep(20);
  }
  throw new Error(`detached daemon ${pid} did not exit`);
}

function processIsRunning(pid: number) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  if (process.platform !== "linux") return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}
