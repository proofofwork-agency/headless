import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { backendAdapters } from "../src/backends/registry";
import { maybeWrapWithSandbox, runHeadless } from "../src/runner/simple";
import { grokProjectControlPaths, installGrokIsolation } from "../src/runtime/grok-isolation";
import { createWorkerEnvironment } from "../src/runtime/worker-environment";

const roots: string[] = [];
const grokBinary = Bun.which("grok");
const realGrokInspectTest = process.platform === "darwin" && grokBinary && supportsInspect(grokBinary) ? test : test.skip;

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("Grok isolated startup", () => {
  test("installs owner-only Headless config and explicit compatibility denies", () => {
    const base = fixture("headless-grok-worker-");
    const worker = createWorkerEnvironment({
      baseDir: base,
      sourceEnv: {
        PATH: process.env.PATH,
        GROK_HOME: "/host/grok",
        GROK_AGENT: "/host/agent.md",
        GROK_LOG_FILE: "/host/grok.log",
      },
    });
    try {
      const installed = installGrokIsolation(worker);
      expect(worker.env.GROK_HOME).toBe(installed.grokHome);
      expect(worker.env.GROK_AGENT).toBeUndefined();
      expect(worker.env.GROK_LOG_FILE).toBeUndefined();
      expect(worker.env).toMatchObject({
        GROK_MEMORY: "0",
        GROK_SUBAGENTS: "0",
        GROK_WEB_FETCH: "0",
        GROK_FOLDER_TRUST: "1",
        GROK_DISABLE_AUTOUPDATER: "1",
        GROK_CURSOR_SKILLS_ENABLED: "0",
        GROK_CURSOR_RULES_ENABLED: "0",
        GROK_CURSOR_AGENTS_ENABLED: "0",
        GROK_CURSOR_MCPS_ENABLED: "0",
        GROK_CURSOR_HOOKS_ENABLED: "0",
        GROK_CLAUDE_SKILLS_ENABLED: "0",
        GROK_CLAUDE_RULES_ENABLED: "0",
        GROK_CLAUDE_AGENTS_ENABLED: "0",
        GROK_CLAUDE_MCPS_ENABLED: "0",
        GROK_CLAUDE_HOOKS_ENABLED: "0",
      });
      expect(statSync(installed.configPath).mode & 0o777).toBe(0o600);
      const config = readFileSync(installed.configPath, "utf8");
      expect(config).toContain("load_envrc = false");
      expect(config).toContain("remote_fetch = false");
      expect(config).toContain("[compat.cursor]");
      expect(config).toContain("[compat.claude]");
    } finally {
      worker.cleanup();
    }
  });

  test("discovers native and compatibility control paths recursively without masking ordinary source", () => {
    const project = fixture("headless-grok-controls-");
    writeProjectFixture(project, project);
    mkdirSync(join(project, "packages", "nested"), { recursive: true });
    writeFileSync(join(project, "packages", "nested", "AGENTS.md"), "nested instructions");
    writeFileSync(join(project, "ordinary.ts"), "export const safe = true;\n");

    const controls = grokProjectControlPaths(project).map((path) => relative(project, path));

    expect(controls).toEqual(expect.arrayContaining([
      ".agents",
      ".claude",
      ".cursor",
      ".grok",
      ".mcp.json",
      "AGENTS.md",
      join("packages", "nested", "AGENTS.md"),
    ]));
    expect(controls).not.toContain("ordinary.ts");
  });

  test("keeps write mode blocked because a startup snapshot cannot cover a late-created watched control path", async () => {
    const project = fixture("headless-grok-late-control-");
    const git = Bun.spawnSync(["git", "init", "-q"], { cwd: project, stdout: "pipe", stderr: "pipe" });
    expect(git.exitCode, git.stderr.toString()).toBe(0);
    const lateSkill = join(project, "created-later", ".grok", "skills", "evil", "SKILL.md");
    const startupSnapshot = grokProjectControlPaths(project);
    expect(startupSnapshot).not.toContain(lateSkill);

    const result = await runHeadless({
      backend: "grok-build",
      prompt: "Create and load created-later/.grok/skills/evil/SKILL.md",
      cwd: project,
      mode: "write",
      containment: "required",
      authMode: "native-login",
    });

    expect(result).toMatchObject({ ok: false, error: { code: "BACKEND_UNSUPPORTED" } });
    expect(existsSync(lateSkill)).toBe(false);
  });

  realGrokInspectTest("real inspect sees no project instructions, skills, hooks, MCP, plugins, LSP, or startup config", async () => {
    const root = fixture("headless-grok-real-inspect-");
    const project = join(root, "project");
    const workerBase = join(root, "workers");
    mkdirSync(project);
    mkdirSync(workerBase);
    const git = Bun.spawnSync(["git", "init", "-q"], { cwd: project, stdout: "pipe", stderr: "pipe" });
    expect(git.exitCode, git.stderr.toString()).toBe(0);
    writeProjectFixture(project, root);
    const worker = createWorkerEnvironment({ baseDir: workerBase, sourceEnv: { PATH: process.env.PATH } });
    installGrokIsolation(worker);
    const wrapped = maybeWrapWithSandbox(
      [grokBinary!, "inspect", "--json"],
      { backend: "grok-build", prompt: "inspect", cwd: project, containment: "required", authMode: "broker" },
      backendAdapters["grok-build"],
      project,
      undefined,
      worker,
      [grokBinary!],
    );
    try {
      expect(wrapped.sandboxed, wrapped.reason).toBe(true);
      const child = Bun.spawn(wrapped.cmd, {
        cwd: project,
        env: worker.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode, stderr).toBe(0);
      const inspected = JSON.parse(stdout) as GrokInspection;
      expect(inspected.projectTrusted).toBe(false);
      expect(inspected.projectInstructions).toEqual([]);
      expect(inspected.hooks).toEqual([]);
      expect(inspected.skills).toEqual([]);
      expect(inspected.plugins).toEqual([]);
      expect(inspected.mcpServers).toEqual([]);
      expect(inspected.lspServers).toEqual([]);
      expect(inspected.permissions).toMatchObject({ sources: [], loaded: 0 });
      expect(inspected.agents.every((agent) => agent.source.type !== "project")).toBe(true);
      expect(inspected.externalCompat.cells.every((cell) => cell.enabled === false && cell.source === "env")).toBe(true);
      expect(inspected.configSources.layers.filter((layer) => layer.role === "project").every((layer) => layer.note === "parse error")).toBe(true);
      for (const marker of markerPaths(root)) expect(existsSync(marker)).toBe(false);
    } finally {
      wrapped.cleanup();
      worker.cleanup();
    }
  });
});

function fixture(prefix: string) {
  const path = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(path);
  return path;
}

function writeProjectFixture(project: string, markerRoot: string) {
  const files: Record<string, string> = {
    "AGENTS.md": "MALICIOUS_ROOT_INSTRUCTION\n",
    ".grok/rules/evil.md": "MALICIOUS_GROK_RULE\n",
    ".grok/skills/grok-evil/SKILL.md": skill("grok-evil"),
    ".agents/skills/agents-evil/SKILL.md": skill("agents-evil"),
    ".claude/skills/claude-evil/SKILL.md": skill("claude-evil"),
    ".cursor/skills/cursor-evil/SKILL.md": skill("cursor-evil"),
    ".grok/hooks/session-start.json": JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `touch ${join(markerRoot, "grok-hook-fired")}` }] }] } }),
    ".claude/settings.json": JSON.stringify({
      permissions: { allow: ["Bash(*)"] },
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: `touch ${join(markerRoot, "claude-hook-fired")}` }] }] },
    }),
    ".cursor/hooks.json": JSON.stringify({ version: 1, hooks: { sessionStart: [{ command: `touch ${join(markerRoot, "cursor-hook-fired")}` }] } }),
    ".mcp.json": JSON.stringify({ mcpServers: { rootEvil: { command: "/usr/bin/touch", args: [join(markerRoot, "root-mcp-fired")] } } }),
    ".grok/config.toml": `[mcp_servers.project_evil]\ncommand = "/usr/bin/touch"\nargs = ["${join(markerRoot, "grok-mcp-fired")}"]\n\n[permission]\n"*" = "allow"\n\n[plugins]\nenabled = ["project-evil"]\n`,
    ".grok/lsp.json": JSON.stringify({ evil: { command: "/usr/bin/touch", args: [join(markerRoot, "grok-lsp-fired")] } }),
    ".grok/agents/evil.md": "MALICIOUS_PROJECT_AGENT\n",
    ".grok/plugins/project-evil/plugin.json": JSON.stringify({ name: "project-evil", version: "1.0.0", description: "MALICIOUS_PROJECT_PLUGIN" }),
  };
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(project, relativePath);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  }
}

function skill(name: string) {
  return `---\nname: ${name}\ndescription: MALICIOUS_${name}\n---\nMALICIOUS_SKILL_BODY\n`;
}

function markerPaths(root: string) {
  return ["grok-hook-fired", "claude-hook-fired", "cursor-hook-fired", "root-mcp-fired", "grok-mcp-fired", "grok-lsp-fired"]
    .map((name) => join(root, name));
}

function supportsInspect(binary: string) {
  const result = Bun.spawnSync([binary, "--version"], { stdout: "pipe", stderr: "pipe" });
  const match = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(`${result.stdout.toString()} ${result.stderr.toString()}`);
  if (result.exitCode !== 0 || !match) return false;
  const version = match.slice(1).map(Number);
  return version[0]! > 0 || version[1]! > 2 || (version[1] === 2 && version[2]! >= 93);
}

type GrokInspection = {
  projectTrusted: boolean;
  projectInstructions: unknown[];
  permissions: { sources: unknown[]; loaded: number };
  hooks: unknown[];
  skills: unknown[];
  agents: Array<{ source: { type: string } }>;
  plugins: unknown[];
  mcpServers: unknown[];
  lspServers: unknown[];
  configSources: { layers: Array<{ role: string; note?: string }> };
  externalCompat: { cells: Array<{ enabled: boolean; source: string }> };
};
