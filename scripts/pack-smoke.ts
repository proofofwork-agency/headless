import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { terminateProcessTree } from "../src/runtime/process-tree";
import { HEADLESS_VERSION } from "../src/version";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "headless-pack-smoke-"));
const packs = join(scratch, "packs");
const installRoot = join(scratch, "consumer");
const rootTarball = join(packs, "headless.tgz");
const pluginTarball = join(packs, "headless-plugin.tgz");

try {
  mkdirSync(packs, { recursive: true });
  await run(["bun", "pm", "pack", "--ignore-scripts", "--filename", rootTarball], root);
  await run(["bun", "pm", "pack", "--ignore-scripts", "--filename", pluginTarball], join(root, "plugin"));

  const rootEntries = lines(await run(["tar", "-tzf", rootTarball], root));
  const pluginEntries = lines(await run(["tar", "-tzf", pluginTarball], root));
  requireEntries(rootEntries, [
    "package/package.json",
    "package/dist/cli.js",
    "package/dist/hless.js",
    "package/dist/index.js",
    "package/dist/index.d.ts",
    "package/dist/experimental.js",
    "package/dist/experimental.d.ts",
    "package/dist/mcp/server.js",
    "package/dist/mcp/server.d.ts",
    "package/dist/daemon/client.js",
    "package/dist/daemon/client.d.ts",
    "package/dist/broker/linux-relay.js",
    "package/dist/broker/linux-relay.d.ts",
    "package/dist/tui/App.js",
    "package/dist/tui/App.d.ts",
    "package/README.md",
    "package/CHANGELOG.md",
    "package/SECURITY.md",
    "package/LICENSE",
    "package/docs/mcp-integration.md",
    "package/docs/native-login.md",
    "package/docs/command-reference.md",
    "package/docs/cli-and-tui-guide.md",
    "package/docs/plan.md",
  ]);
  requireEntries(pluginEntries, ["package/package.json", "package/dist/index.js", "package/dist/index.d.ts", "package/README.md", "package/LICENSE"]);
  validateTarPaths(rootEntries, "root");
  validateTarPaths(pluginEntries, "plugin");
  rejectSourceEntries(rootEntries, "root");
  rejectSourceEntries(pluginEntries, "plugin");
  requirePublishedFileAllowlist(rootEntries, "root", [
    "package/package.json",
    "package/README.md",
    "package/CHANGELOG.md",
    "package/SECURITY.md",
    "package/LICENSE",
    "package/docs/mcp-integration.md",
    "package/docs/native-login.md",
    "package/docs/command-reference.md",
    "package/docs/cli-and-tui-guide.md",
    "package/docs/plan.md",
  ]);
  requirePublishedFileAllowlist(pluginEntries, "plugin", [
    "package/package.json",
    "package/README.md",
    "package/LICENSE",
  ]);
  requireGeneratedArtifactParity(rootEntries, join(root, "dist"), "root");
  requireGeneratedArtifactParity(pluginEntries, join(root, "plugin", "dist"), "plugin");
  validatePackedManifest(
    JSON.parse(await run(["tar", "-xOzf", rootTarball, "package/package.json"], root)),
    {
      name: "@proofofwork-agency/headless",
      version: HEADLESS_VERSION,
      bins: {
        headless: "./dist/cli.js",
        hless: "./dist/hless.js",
        "headless-mcp": "./dist/mcp/server.js",
      },
    },
  );
  validatePackedManifest(
    JSON.parse(await run(["tar", "-xOzf", pluginTarball, "package/package.json"], root)),
    { name: "@proofofwork-agency/headless-plugin", version: HEADLESS_VERSION },
  );

  writeFileSync(join(scratch, "pack-contents.json"), `${JSON.stringify({ rootEntries, pluginEntries }, null, 2)}\n`);
  mkdirSync(installRoot, { recursive: true });
  writeFileSync(join(installRoot, "package.json"), `${JSON.stringify({
    private: true,
    type: "module",
    dependencies: {
      "@opencode-ai/plugin": "1.17.17",
      "@proofofwork-agency/headless": `file:${rootTarball}`,
      "@proofofwork-agency/headless-plugin": `file:${pluginTarball}`,
    },
    overrides: {
      "@proofofwork-agency/headless": `file:${rootTarball}`,
    },
  }, null, 2)}\n`);

  await run(["bun", "install", "--ignore-scripts"], installRoot, 120_000);
  const version = (await run([join(installRoot, "node_modules", ".bin", "headless"), "--version"], installRoot)).trim();
  if (version !== HEADLESS_VERSION) throw new Error(`Installed headless binary reported ${JSON.stringify(version)} instead of ${HEADLESS_VERSION}.`);
  const aliasVersion = (await run([join(installRoot, "node_modules", ".bin", "hless"), "--version"], installRoot)).trim();
  if (aliasVersion !== version) throw new Error(`Installed hless alias reported ${JSON.stringify(aliasVersion)} instead of ${version}.`);

  await verifyIsolatedNpmLink(installRoot, scratch, version);

  await run(["bun", "-e", [
    'import { RunRequestSchema, resolveDaemonExtensionConfig } from "@proofofwork-agency/headless/experimental";',
    'import { HeadlessDaemonClient } from "@proofofwork-agency/headless/daemon";',
    'import { runLinuxBrokerRelay } from "@proofofwork-agency/headless/experimental/broker/linux-relay";',
    'import { MCP_VERSION, mcpToolDefinitions } from "@proofofwork-agency/headless/experimental/mcp";',
    'import plugin from "@proofofwork-agency/headless-plugin";',
    'if (RunRequestSchema.parse({ backend: "opencode", prompt: "ok", projectRoot: process.cwd() }).containment !== "required") throw new Error("contract import failed");',
    'if (typeof resolveDaemonExtensionConfig !== "function") throw new Error("daemon extension export failed");',
    'if (typeof HeadlessDaemonClient !== "function") throw new Error("daemon export failed");',
    'if (typeof runLinuxBrokerRelay !== "function") throw new Error("Linux broker relay export failed");',
    `if (MCP_VERSION !== ${JSON.stringify(HEADLESS_VERSION)} || !mcpToolDefinitions.some((tool) => tool.name === "headless_run")) throw new Error("MCP export failed");`,
    'if (plugin.id !== "headless" || typeof plugin.server !== "function") throw new Error("plugin export failed");',
  ].join(" ")], installRoot);

  await verifyInstalledTui(installRoot);

  await verifyInstalledExtensionDaemon(installRoot, scratch);

  console.log(`pack smoke passed: ${rootEntries.length} root files, ${pluginEntries.length} plugin files, installed CLI/npm-link/doctor/TUI/MCP/plugin/extensions verified`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

async function run(
  command: string[],
  cwd: string,
  timeoutMs = 30_000,
  input?: string,
  extraEnv: Record<string, string> = {},
) {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...process.env, FORCE_COLOR: "0", ...extraEnv },
    detached: true,
    stdin: input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input !== undefined && child.stdin && typeof child.stdin !== "number") {
    child.stdin.write(input);
    child.stdin.end();
  }
  const stdoutPromise = Bun.readableStreamToText(child.stdout);
  const stderrPromise = Bun.readableStreamToText(child.stderr);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopping: ReturnType<typeof terminateProcessTree> | null = null;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      stopping ??= terminateProcessTree(child, { graceMs: 250, killWaitMs: 1_000 });
      reject(new Error(`Timed out after ${timeoutMs}ms: ${command.join(" ")}`));
    }, timeoutMs);
  });
  try {
    const exitCode = await Promise.race([child.exited, timedOut]);
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    if (exitCode !== 0) {
      throw new Error(`Command failed (${exitCode}): ${command.join(" ")}\n${stderr || stdout}`);
    }
    return stdout;
  } catch (error) {
    const pendingTermination = stopping as ReturnType<typeof terminateProcessTree> | null;
    if (pendingTermination) await pendingTermination;
    await Promise.allSettled([stdoutPromise, stderrPromise]);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function verifyIsolatedNpmLink(installRoot: string, scratch: string, expectedVersion: string) {
  const prefix = join(scratch, "npm-prefix");
  const cache = join(scratch, "npm-cache");
  const home = join(scratch, "npm-home");
  mkdirSync(prefix, { recursive: true });
  mkdirSync(cache, { recursive: true });
  mkdirSync(home, { recursive: true });
  const env = {
    HOME: home,
    NPM_CONFIG_PREFIX: prefix,
    NPM_CONFIG_CACHE: cache,
    NPM_CONFIG_USERCONFIG: join(home, ".npmrc"),
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    NPM_CONFIG_PACKAGE_LOCK: "false",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_PROGRESS: "false",
    NPM_CONFIG_COLOR: "false",
    NPM_CONFIG_OFFLINE: "true",
  };
  const packedPackage = join(installRoot, "node_modules", "@proofofwork-agency", "headless");
  await run(["npm", "link", "--ignore-scripts", "--no-audit", "--no-fund", "--offline"], packedPackage, 60_000, undefined, env);
  for (const binary of ["headless", "hless"]) {
    const reported = (await run([join(prefix, "bin", binary), "--version"], installRoot, 10_000, undefined, env)).trim();
    if (reported !== expectedVersion) {
      throw new Error(`Isolated npm-link ${binary} reported ${JSON.stringify(reported)} instead of ${expectedVersion}.`);
    }
  }
}

async function verifyInstalledTui(installRoot: string) {
  const moduleUrl = pathToFileURL(join(
    installRoot,
    "node_modules",
    "@proofofwork-agency",
    "headless",
    "dist",
    "tui",
    "App.js",
  )).href;
  const tui = await import(`${moduleUrl}?pack-smoke=${randomUUID()}`) as Record<string, unknown>;
  if (typeof tui.App !== "function" || typeof tui.runTui !== "function") {
    throw new Error("Packed TUI module does not export App and runTui functions.");
  }
}

async function verifyInstalledExtensionDaemon(installRoot: string, scratch: string) {
  const extensionRoot = join(scratch, "extension-smoke");
  const project = join(extensionRoot, "project");
  const stateHome = join(extensionRoot, "state");
  const runtimeHome = join("/tmp", `headless-pack-ext-${process.pid}-${randomUUID().slice(0, 8)}`);
  const modulePath = join(extensionRoot, "fixture-extension.mjs");
  const configPath = join(extensionRoot, "extensions.json");
  mkdirSync(project, { recursive: true });
  mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
  writeFileSync(modulePath, `
export default function register(api) {
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
  api.registerBackendDefinition({
    id: "package-fixture",
    metadata: { id: "package-fixture", aliases: [], promptDelivery: "native", timeoutMs: 5_000, maxDepth: null, canRead: true, canWrite: false },
    capabilities: { write: false, streaming: false, structuredOutput: true, nativeResume: false, cancellation: true, tools: false, effort: false, brokerCompatible: false },
    security: { outerContainmentRequired: true, strictAuth: "broker-api-key", disablesProjectConfig: true, disablesHooks: true, disablesMcp: true, disablesSkills: true },
    probe: { versionCommand: ["/usr/bin/true"], helpCommand: ["/usr/bin/true"], requiredHelpFragments: [], timeoutMs: 1_000, maxOutputBytes: 1_024 },
    stdinPrompt: false,
    credentialPrefixes: [],
    prepareCommand(options) { return ["/usr/bin/printf", \`packed-extension:\${options.prompt}\`]; },
    decodeOutput(stdout) { return { output: stdout, cost: null, tokens: null, error: null }; },
  });
}
`, { mode: 0o600 });
  writeFileSync(configPath, `${JSON.stringify({ version: 1, modules: [modulePath] })}\n`, { mode: 0o600 });
  const cli = join(installRoot, "node_modules", ".bin", "headless");
  const env = {
    HEADLESS_STATE_HOME: stateHome,
    HEADLESS_RUNTIME_HOME: runtimeHome,
    PACKAGE_FIXTURE_PROVIDER_KEY: "package-smoke-key",
  };
  const daemon = Bun.spawn([cli, "daemon", "serve", "--cwd", project, "--extension-config", configPath], {
    cwd: installRoot,
    env: { ...process.env, FORCE_COLOR: "0", ...env },
    detached: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderrPromise = Bun.readableStreamToText(daemon.stderr);
  try {
    const installedClientUrl = pathToFileURL(join(
      installRoot,
      "node_modules",
      "@proofofwork-agency",
      "headless",
      "dist",
      "daemon",
      "client.js",
    )).href;
    const { HeadlessDaemonClient } = await import(`${installedClientUrl}?smoke=${randomUUID()}`);
    let client: InstanceType<typeof HeadlessDaemonClient> | null = null;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (daemon.exitCode !== null) throw new Error(`Installed extension daemon exited (${daemon.exitCode}): ${await stderrPromise}`);
      try {
        const candidate = new HeadlessDaemonClient({ projectRoot: project, state: { env }, timeoutMs: 250 });
        await candidate.call("ping", {}, 250);
        client = candidate;
        break;
      } catch {
        await Bun.sleep(25);
      }
    }
    if (!client) throw new Error("Installed extension daemon did not become ready.");
    const ping = await client.call("ping") as {
      projectRoot?: string;
      extensionAdapters?: string[];
      extensionProviders?: string[];
      extensionPricing?: string[];
    };
    if (
      typeof ping.projectRoot !== "string"
      || ping.projectRoot.length === 0
      || !ping.extensionAdapters?.includes("package-fixture")
      || !ping.extensionProviders?.includes("package-provider")
      || !ping.extensionPricing?.includes("package-provider-test-pricing")
    ) {
      throw new Error(`Installed extension daemon did not report configured registrations: ${JSON.stringify(ping)}`);
    }
    await run([
      cli,
      "lead",
      "use",
      "opencode",
      "--cwd",
      project,
      "--extension-config",
      configPath,
    ], installRoot, 10_000, undefined, env);
    await run([
      join(installRoot, "node_modules", ".bin", "headless-mcp"),
      "--host",
      "opencode",
    ], project, 10_000, "", { ...env, HEADLESS_PROJECT_ROOT: project });
    const doctor = await run([
      cli,
      "doctor",
      "--cwd",
      project,
      "--extension-config",
      configPath,
    ], installRoot, 10_000, undefined, env);
    for (const evidence of [
      "headless doctor — v0.2 daemon and runtime self-check",
      `Project: ${ping.projectRoot}`,
      "Authenticated principal:",
      "External state:",
    ]) {
      if (!doctor.includes(evidence)) throw new Error(`Installed doctor output is missing ${JSON.stringify(evidence)}.`);
    }
    const raw = await run([
      cli,
      "exec",
      "--cwd",
      project,
      "--backend",
      "package-fixture",
      "--auth-mode",
      "broker",
      "--model",
      "package-provider/test-model",
      "--extension-config",
      configPath,
      "--unsafe-no-sandbox",
      "--timeout-ms",
      "5000",
      "--json",
      "installed package request",
    ], installRoot, 10_000, undefined, env);
    const result = JSON.parse(raw) as { status?: string; backend?: string; output?: string };
    if (result.status !== "succeeded" || result.backend !== "package-fixture" || result.output !== "packed-extension:installed package request") {
      throw new Error(`Installed extension execution failed: ${raw}`);
    }
  } finally {
    if (daemon.exitCode === null) await terminateProcessTree(daemon, { graceMs: 500, killWaitMs: 1_000 });
    rmSync(runtimeHome, { recursive: true, force: true });
  }
}

function lines(value: string) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function requireEntries(entries: string[], required: string[]) {
  for (const entry of required) {
    if (!entries.includes(entry)) throw new Error(`Packed tarball is missing ${entry}.`);
  }
}

function rejectSourceEntries(entries: string[], label: string) {
  const forbidden = entries.filter((entry) =>
    entry.startsWith("package/src/") ||
    entry.startsWith("package/tests/") ||
    entry.startsWith("package/scripts/") ||
    entry.startsWith("package/.github/") ||
    entry.startsWith("package/plugin/") ||
    entry.includes("node_modules/") ||
    /\.(?:ts|tsx|mts|cts)$/.test(entry) && !entry.endsWith(".d.ts"),
  );
  if (forbidden.length) throw new Error(`${label} tarball contains unpublished source paths: ${forbidden.join(", ")}`);
}

function validateTarPaths(entries: string[], label: string) {
  const unsafe = entries.filter((entry) =>
    !entry.startsWith("package/") ||
    entry.startsWith("/") ||
    entry.split("/").includes("..") ||
    entry.includes("\\"),
  );
  if (unsafe.length) throw new Error(`${label} tarball contains unsafe paths: ${unsafe.join(", ")}`);
}

function requirePublishedFileAllowlist(entries: string[], label: string, exactFiles: string[]) {
  const exact = new Set(exactFiles);
  const unexpected = entries.filter((entry) =>
    !entry.endsWith("/") &&
    !entry.startsWith("package/dist/") &&
    !exact.has(entry),
  );
  if (unexpected.length) throw new Error(`${label} tarball contains files outside the publish allowlist: ${unexpected.join(", ")}`);
}

function requireGeneratedArtifactParity(entries: string[], distRoot: string, label: string) {
  const packed = new Set(entries
    .filter((entry) => entry.startsWith("package/dist/") && !entry.endsWith("/"))
    .map((entry) => entry.slice("package/dist/".length)));
  const generated = new Set([...new Bun.Glob("**/*").scanSync({ cwd: distRoot, onlyFiles: true })]);
  const missing = [...generated].filter((entry) => !packed.has(entry));
  const stale = [...packed].filter((entry) => !generated.has(entry));
  if (missing.length || stale.length) {
    throw new Error(`${label} tarball/generated dist mismatch; missing=${missing.join(",") || "none"}; stale=${stale.join(",") || "none"}`);
  }
}

function validatePackedManifest(
  manifest: unknown,
  expected: { name: string; version: string; bins?: Record<string, string>; private?: boolean },
) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("Packed package.json is not an object.");
  const value = manifest as Record<string, unknown>;
  if (value.name !== expected.name || value.version !== expected.version || value.private !== (expected.private ?? true)) {
    throw new Error(`Packed manifest identity mismatch for ${expected.name}@${expected.version}.`);
  }
  if (expected.bins) {
    if (!value.bin || typeof value.bin !== "object" || Array.isArray(value.bin)) throw new Error("Packed root manifest is missing bin mappings.");
    for (const [name, target] of Object.entries(expected.bins)) {
      if ((value.bin as Record<string, unknown>)[name] !== target) throw new Error(`Packed manifest has an invalid ${name} bin target.`);
    }
  }
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    const dependencies = value[field];
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
    for (const [name, specifier] of Object.entries(dependencies)) {
      if (typeof specifier === "string" && /^(?:file|link|workspace):/.test(specifier)) {
        throw new Error(`Packed manifest contains local ${field} entry ${name}: ${specifier}.`);
      }
    }
  }
}
