import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClaudeCommand, CLAUDE_EMPTY_MCP_CONFIG } from "../src/backends/claude";
import { buildCodexCommand, codexProjectPolicyArguments } from "../src/backends/codex";
import { buildGrokCommand } from "../src/backends/grok";
import { buildAdapterEnv } from "../src/backends/env";
import { probeBackendDefinition, type ProbeExecutor } from "../src/backends/probe";
import {
  backendDefinitions,
  getBackendDefinition,
  registerBackendDefinition,
  requiredContainmentSecurityGaps,
  resolveBackendId,
  unregisterBackendDefinition,
  type BackendDefinition,
} from "../src/backends/registry";
import {
  buildOpenCodeCommand,
  nextOpenCodeEnv,
  OPENCODE_READ_ONLY_CONFIG,
  OPENCODE_WRITE_CONFIG,
} from "../src/backends/opencode";
import { runHeadless } from "../src/runner/simple";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

describe("hardened built-in command preparation", () => {
  test("OpenCode uses pure mode, a prompt delimiter, and mode-specific immutable config", () => {
    const read = nextOpenCodeEnv({ PATH: "/bin", OPENCODE_CONFIG: "/evil", OPENCODE_API_KEY: "key" }, { mode: "read-only" });
    const write = nextOpenCodeEnv({ PATH: "/bin", OPENCODE_CONFIG_CONTENT: "evil" }, { mode: "write" });
    const command = buildOpenCodeCommand({ backend: "opencode", prompt: "--dangerously-skip-permissions", mode: "write" }, "/repo");

    expect(JSON.parse(read.OPENCODE_CONFIG_CONTENT!)).toEqual(OPENCODE_READ_ONLY_CONFIG);
    expect(JSON.parse(write.OPENCODE_CONFIG_CONTENT!)).toEqual(OPENCODE_WRITE_CONFIG);
    expect(read.OPENCODE_CONFIG).toBeUndefined();
    expect(read.OPENCODE_API_KEY).toBe("key");
    expect(read.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
    expect(read.OPENCODE_DISABLE_DEFAULT_PLUGINS).toBe("1");
    expect(read.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe("1");
    expect(command.slice(0, 3)).toEqual(["opencode", "run", "--pure"]);
    expect(command.slice(-2)).toEqual(["--", "--dangerously-skip-permissions"]);
  });

  test("Claude preserves native OAuth outside bare mode and has explicit read/write allow and deny sets", () => {
    const read = buildClaudeCommand({ backend: "claude-code", prompt: "read", mode: "read-only", authMode: "native-login" });
    const write = buildClaudeCommand({ backend: "claude-code", prompt: "write", mode: "write", authMode: "native-login" });
    const broker = buildClaudeCommand({ backend: "claude-code", prompt: "broker", authMode: "broker" });

    for (const flag of ["--safe-mode", "--setting-sources", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--no-chrome"]) {
      expect(read).toContain(flag);
      expect(write).toContain(flag);
    }
    // Claude documents that --bare disables OAuth/keychain reads, so it is
    // valid only for broker API-key mode and must not break native login.
    expect(read).not.toContain("--bare");
    expect(write).not.toContain("--bare");
    expect(broker).toContain("--bare");
    expect(read[read.indexOf("--mcp-config") + 1]).toBe(CLAUDE_EMPTY_MCP_CONFIG);
    expect(read[read.indexOf("--tools") + 1]).toContain("Bash");
    expect(read[read.indexOf("--disallowedTools") + 1]).not.toContain("Bash");
    expect(write[write.indexOf("--tools") + 1]).toContain("Bash");
    expect(write[write.indexOf("--disallowedTools") + 1]).toContain("WebFetch");
    expect(write[write.indexOf("--disallowedTools") + 1]).not.toContain("Bash");
  });

  test("Codex disables project control surfaces and delegates required containment to Headless", () => {
    const root = mkdtempSync(join(tmpdir(), "headless-codex-adapter-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, ".agents", "skills", "malicious"), { recursive: true });
    mkdirSync(join(root, ".codex", "skills", "native-malicious"), { recursive: true });
    writeFileSync(join(root, ".agents", "skills", "malicious", "SKILL.md"), "malicious");
    writeFileSync(join(root, ".codex", "skills", "native-malicious", "SKILL.md"), "malicious");

    const read = buildCodexCommand({ backend: "codex", prompt: "read", mode: "read-only" }, root);
    const write = buildCodexCommand({ backend: "codex", prompt: "write", mode: "write" }, root);
    const unsafeWrite = buildCodexCommand({ backend: "codex", prompt: "write", mode: "write", containment: "unsafe" }, root);
    const readConfig = read.filter((value, index) => read[index - 1] === "-c").join("\n");

    expect(read[read.indexOf("--sandbox") + 1]).toBe(process.platform === "darwin" ? "danger-full-access" : "read-only");
    expect(write[write.indexOf("--sandbox") + 1]).toBe(process.platform === "darwin" ? "danger-full-access" : "workspace-write");
    expect(unsafeWrite[unsafeWrite.indexOf("--sandbox") + 1]).toBe("workspace-write");
    expect(read).toContain("--ignore-user-config");
    expect(read).toContain("--ignore-rules");
    expect(read).toContain("--ephemeral");
    expect(readConfig).toContain('trust_level="untrusted"');
    expect(readConfig).toContain("project_doc_max_bytes=0");
    expect(readConfig).toContain('web_search="disabled"');
    expect(readConfig).toContain("apps._default.enabled=false");
    for (const feature of ["apps", "browser_use", "computer_use", "hooks", "multi_agent", "plugins", "remote_plugin", "skill_mcp_dependency_install"]) {
      expect(readConfig).toContain(`features.${feature}=false`);
    }
    expect(readConfig).toContain("malicious/SKILL.md");
    expect(readConfig).toContain("native-malicious/SKILL.md");
    expect(read).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  test("Codex fails closed when repository skills exceed the bounded inspection depth", () => {
    const root = mkdtempSync(join(tmpdir(), "headless-codex-deep-skill-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, ".git"));
    const deep = join(root, ".agents", "skills", ...Array.from({ length: 10 }, (_, index) => `level-${index}`));
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "SKILL.md"), "malicious");
    expect(() => buildCodexCommand({ backend: "codex", prompt: "read" }, root)).toThrow("skill nesting exceeds");
  });

  test("Codex fails closed instead of following a project skill symlink outside the repository", () => {
    const root = mkdtempSync(join(tmpdir(), "headless-codex-symlink-skill-"));
    const external = mkdtempSync(join(tmpdir(), "headless-codex-external-skill-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    cleanups.push(() => rmSync(external, { recursive: true, force: true }));
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, ".agents", "skills"), { recursive: true });
    writeFileSync(join(external, "SKILL.md"), "malicious");
    symlinkSync(external, join(root, ".agents", "skills", "escape"));
    expect(() => buildCodexCommand({ backend: "codex", prompt: "read" }, root)).toThrow("symlinked repository skill paths");
  });

  test("Codex also fails closed on symlinks in its native repository skill root", () => {
    const root = mkdtempSync(join(tmpdir(), "headless-codex-native-symlink-skill-"));
    const external = mkdtempSync(join(tmpdir(), "headless-codex-native-external-skill-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    cleanups.push(() => rmSync(external, { recursive: true, force: true }));
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, ".codex", "skills"), { recursive: true });
    writeFileSync(join(external, "SKILL.md"), "malicious");
    symlinkSync(external, join(root, ".codex", "skills", "escape"));
    expect(() => buildCodexCommand({ backend: "codex", prompt: "read" }, root)).toThrow("symlinked repository skill paths");
  });

  test("Codex fails closed on symlinked parents of both repository skill roots", () => {
    for (const parent of [".agents", ".codex"]) {
      const root = mkdtempSync(join(tmpdir(), `headless-codex-${parent.slice(1)}-parent-`));
      const external = mkdtempSync(join(tmpdir(), "headless-codex-parent-external-"));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      cleanups.push(() => rmSync(external, { recursive: true, force: true }));
      mkdirSync(join(root, ".git"));
      mkdirSync(join(external, "skills"));
      writeFileSync(join(external, "skills", "SKILL.md"), "malicious");
      symlinkSync(external, join(root, parent));

      expect(() => buildCodexCommand({ backend: "codex", prompt: "read" }, root))
        .toThrow("symlinked repository skill paths");
    }
  });

  test("installed Codex accepts the complete strict policy before provider access", () => {
    const codex = Bun.which("codex");
    if (!codex) return;
    const version = Bun.spawnSync([codex, "--version"], { stdout: "pipe", stderr: "pipe" });
    const parsed = version.stdout.toString().match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
    if (!parsed || compareVersion(parsed, [0, 144, 1]) < 0) return;

    const root = mkdtempSync(join(tmpdir(), "headless-codex-strict-policy-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "home", ".codex"), { recursive: true });
    const env = { ...process.env, HOME: join(root, "home"), CODEX_HOME: join(root, "home", ".codex") };
    const accepted = Bun.spawnSync([
      codex,
      "app-server",
      "--listen",
      "stdio://",
      "--strict-config",
      ...codexProjectPolicyArguments(root),
    ], { cwd: root, env, stdin: new Uint8Array(), stdout: "pipe", stderr: "pipe" });
    const rejectedControl = Bun.spawnSync([
      codex,
      "app-server",
      "--listen",
      "stdio://",
      "--strict-config",
      "-c",
      "features.definitely_not_a_headless_feature=false",
    ], { cwd: root, env, stdin: new Uint8Array(), stdout: "pipe", stderr: "pipe" });

    expect(accepted.exitCode, accepted.stderr.toString()).toBe(0);
    expect(rejectedControl.exitCode).not.toBe(0);
    expect(rejectedControl.stderr.toString()).toContain("unknown configuration field");
  });

  test("credential allowlisting does not forward provider control-plane prefixes", () => {
    const env = buildAdapterEnv({
      PATH: "/bin",
      OPENAI_API_KEY: "key",
      OPENAI_BASE_URL: "https://evil.invalid",
      CODEX_HOME: "/host/codex",
      ANTHROPIC_AUTH_TOKEN: "oauth",
    }, ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
    expect(env.OPENAI_API_KEY).toBe("key");
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.CODEX_HOME).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  test("rejects option values that can be reinterpreted as flags", () => {
    expect(() => buildClaudeCommand({ backend: "claude-code", prompt: "x", model: "--help" })).toThrow("Invalid Claude model");
    expect(() => buildCodexCommand({ backend: "codex", prompt: "x", model: "--help" }, "/repo")).toThrow("Invalid Codex model");
    expect(() => buildOpenCodeCommand({ backend: "opencode", prompt: "x", agent: "--evil" }, "/repo")).toThrow("Invalid OpenCode agent");
    expect(() => buildGrokCommand({ backend: "grok-build", prompt: "x", agent: "custom" }, "/repo")).toThrow("Invalid Grok agent");
    expect(buildGrokCommand({ backend: "grok-build", prompt: "x", agent: "review" }, "/repo"))
      .toEqual(expect.arrayContaining(["--agent", "review"]));
  });
});

function compareVersion(left: number[], right: number[]) {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

describe("adapter security metadata and bounded capability probes", () => {
  test("reports write support and hardened strict auth honestly", () => {
    for (const id of ["opencode", "claude-code", "codex"] as const) {
      const adapter = backendDefinitions[id];
      expect(adapter.capabilities.write).toBe(true);
      expect(adapter.metadata.canWrite).toBe(true);
      expect(adapter.security).toEqual({
        outerContainmentRequired: true,
        strictAuth: "broker-api-key",
        disablesProjectConfig: true,
        disablesHooks: true,
        disablesMcp: true,
        disablesSkills: true,
      });
      expect(adapter.probe.timeoutMs).toBeGreaterThan(0);
      expect(adapter.probe.timeoutMs).toBeLessThanOrEqual(30_000);
      expect(adapter.probe.maxOutputBytes).toBeLessThanOrEqual(1_000_000);
    }
  });

  test("admits Grok only when a read-only mount makes late project controls impossible", () => {
    expect(requiredContainmentSecurityGaps(backendDefinitions["grok-build"])).toEqual([
      "project configuration",
      "startup hooks",
      "project MCP servers",
      "project skills",
    ]);
    expect(requiredContainmentSecurityGaps(backendDefinitions["grok-build"], "read-only")).toEqual([]);
    expect(requiredContainmentSecurityGaps(backendDefinitions["grok-build"], "write")).toEqual([
      "project configuration",
      "startup hooks",
      "project MCP servers",
      "project skills",
    ]);
    expect(backendDefinitions["grok-build"].probe.requiredHelpFragments).toEqual(expect.arrayContaining([
      "--no-subagents",
      "--no-memory",
      "--disable-web-search",
      "--verbatim",
      "--system-prompt-override",
      "--tools",
      "inspect",
    ]));
  });

  test("deterministically verifies every required help capability", async () => {
    for (const id of ["opencode", "claude-code", "codex"] as const) {
      const adapter = getBackendDefinition(id)!;
      const execute: ProbeExecutor = async (argv) => argv.includes("--version")
        ? execution("adapter 9.8.7")
        : execution(adapter.probe!.requiredHelpFragments.join("\n"));
      expect(await probeBackendDefinition(id, execute)).toEqual({
        ok: true,
        version: "9.8.7",
        capabilities: adapter.capabilities,
        reason: null,
      });
    }
  });

  test("fails closed when a required capability or probe bound is missing", async () => {
    const versionCommand = getBackendDefinition("opencode")!.probe.versionCommand.join("\0");
    const execute: ProbeExecutor = async (argv) => argv.join("\0") === versionCommand ? execution("1.15.3") : execution("--pure");
    const result = await probeBackendDefinition("opencode", execute);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("--format");
  });

  test("rejects a CLI older than the security surface's minimum version", async () => {
    const execute: ProbeExecutor = async (argv) => argv.includes("--version")
      ? execution("opencode 1.0.0")
      : execution(getBackendDefinition("opencode")!.probe.requiredHelpFragments.join("\n"));
    const result = await probeBackendDefinition("opencode", execute);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("older than required 1.15.3");
  });

  test("refuses to probe an arbitrary backend without a contained executor", async () => {
    const result = await probeBackendDefinition("codex");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("contained probe executor");
  });

  test("resolves built-in aliases and exact registered extension IDs", () => {
    const fixture = fixtureAdapter("credential-free-fixture");
    registerBackendDefinition(fixture);
    cleanups.push(() => unregisterBackendDefinition(fixture.id));
    expect(resolveBackendId("claude")).toBe("claude-code");
    expect(resolveBackendId(fixture.id)).toBe(fixture.id);
    expect(() => resolveBackendId("missing-fixture")).toThrow("Unsupported backend");
  });

  test("runs a registered credential-free adapter through required containment", async () => {
    const root = mkdtempSync(join(tmpdir(), "headless-extension-run-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const fixture = {
      ...fixtureAdapter("credential-free-runner"),
      prepareCommand: () => ["/usr/bin/printf", "fixture-output"],
      decodeOutput: (stdout: string) => ({ output: stdout, cost: null, tokens: null, error: null }),
    } satisfies BackendDefinition;
    registerBackendDefinition(fixture);
    cleanups.push(() => unregisterBackendDefinition(fixture.id));

    const result = await runHeadless({ backend: fixture.id, prompt: "ignored", cwd: root, containment: "required" });
    expect(result.ok).toBe(true);
    expect(result.backend).toBe(fixture.id);
    expect(result.output).toBe("fixture-output");
    expect(result.containment?.enforced).toBe(true);
  });

  test("contains arbitrary probe code with isolated HOME, denied project writes, and denied network", async () => {
    const root = mkdtempSync(join(tmpdir(), "headless-probe-isolation-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const project = join(root, "project");
    const hostSecretRoot = mkdtempSync(join(process.env.HOME ?? root, ".headless-probe-secret-"));
    const hostSecret = join(hostSecretRoot, "secret.txt");
    mkdirSync(project);
    writeFileSync(hostSecret, "must-not-be-readable", { mode: 0o600 });
    cleanups.push(() => rmSync(hostSecretRoot, { recursive: true, force: true }));
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("egress-worked") });
    cleanups.push(() => server.stop(true));
    const probe = join(project, "malicious-probe.ts");
    writeFileSync(probe, `
const [hostHome, secret, url, phase] = process.argv.slice(2);
let escaped = process.env.HOME === hostHome;
try { escaped ||= (await Bun.file(secret).text()) === "must-not-be-readable"; } catch {}
try { await Bun.write("probe-pwned", "write"); escaped = true; } catch {}
try { if ((await fetch(url)).ok) escaped = true; } catch {}
if (escaped) process.exit(91);
console.log(phase === "help" ? "--fixture-capability" : "7.6.5");
`);
    const fixture = {
      ...fixtureAdapter("contained-probe-fixture"),
      probe: {
        versionCommand: [process.execPath, probe, process.env.HOME ?? "", hostSecret, `http://127.0.0.1:${server.port}`, "version"],
        helpCommand: [process.execPath, probe, process.env.HOME ?? "", hostSecret, `http://127.0.0.1:${server.port}`, "help"],
        requiredHelpFragments: ["--fixture-capability"],
        timeoutMs: 2_000,
        maxOutputBytes: 4_096,
      },
      prepareCommand: () => ["/usr/bin/printf", "contained-output"],
      decodeOutput: (stdout: string) => ({ output: stdout, cost: null, tokens: null, error: null }),
    } satisfies BackendDefinition;
    registerBackendDefinition(fixture);
    cleanups.push(() => unregisterBackendDefinition(fixture.id));

    const result = await runHeadless({ backend: fixture.id, prompt: "ignored", cwd: project, containment: "required" });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("contained-output");
    expect(existsSync(join(project, "probe-pwned"))).toBe(false);
  });
});

function execution(stdout: string) {
  return { exitCode: 0, stdout, stderr: "", timedOut: false, overflowed: false };
}

function fixtureAdapter(id: string): BackendDefinition {
  return {
    id,
    metadata: { id, aliases: [], promptDelivery: "native", timeoutMs: 1_000, maxDepth: null, canRead: true, canWrite: false },
    capabilities: { write: false, streaming: false, structuredOutput: true, nativeResume: false, cancellation: true, tools: false, effort: false, brokerCompatible: false },
    security: { outerContainmentRequired: true, strictAuth: "credential-free", disablesProjectConfig: true, disablesHooks: true, disablesMcp: true, disablesSkills: true },
    probe: { versionCommand: ["true", "--version"], helpCommand: ["true", "--help"], requiredHelpFragments: [], timeoutMs: 1_000, maxOutputBytes: 1_024 },
    stdinPrompt: false,
    credentialPrefixes: [],
    prepareCommand: () => ["/usr/bin/true"],
    decodeOutput: () => ({ output: "ok", cost: null, tokens: null, error: null }),
  };
}
