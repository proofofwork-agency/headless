import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInitCommand } from "../src/cli/commands/lifecycle";
import { opencodeGlobalConfigPath, runMcpCommand, runMcpInstall } from "../src/cli/commands/mcp";

describe("MCP host installation", () => {
  test("requires an explicit host before install or remove can mutate global configuration", async () => {
    await expect(runMcpCommand(["mcp", "install", "--cwd", "/fixture/project"])).rejects.toThrow("MCP host is required for install");
    await expect(runMcpCommand(["mcp", "remove", "--cwd", "/fixture/project"])).rejects.toThrow("MCP host is required for remove");
  });

  test("installs Codex, Claude Code, and Grok with each host's non-interactive CLI", async () => {
    const checkout = "/fixture/project";
    const cases = [
      ["codex", ["codex", "mcp", "add", "headless", "--", "headless-mcp", "--host", "codex"]],
      ["claude", ["claude", "mcp", "add", "headless", "--", "headless-mcp", "--host", "claude"]],
      ["grok", ["grok", "mcp", "add", "--scope", "user", "headless", "--", "headless-mcp", "--host", "grok"]],
    ] as const;

    for (const [host, expected] of cases) {
      const calls: Array<{ command: readonly string[]; cwd?: string }> = [];
      const messages: string[] = [];
      await runMcpInstall(host, {
        checkoutRoot: checkout,
        log: (message) => messages.push(message),
        run: async (command, options) => {
          calls.push({ command, cwd: options.cwd });
          return 0;
        },
      });
      expect(calls).toEqual([{ command: expected, cwd: checkout }]);
      expect(messages).toEqual([expect.stringContaining("Installed the published Headless MCP server")]);
    }
  });

  test("prints copy-paste-complete Claude and Grok configurations when their CLI fails", async () => {
    for (const host of ["claude", "grok"] as const) {
      const messages: string[] = [];
      await runMcpInstall(host, {
        checkoutRoot: "/fixture/project",
        log: (message) => messages.push(message),
        run: async () => 17,
      });
      const output = messages.join("\n");
      expect(output).toContain("exited with code 17");
      expect(output).toContain(`headless-mcp --host ${host}`);
      if (host === "claude") {
        expect(output).toContain("claude mcp add headless -- headless-mcp --host claude");
        expect(output).toContain('"mcpServers"');
      } else {
        expect(output).toContain("grok mcp add --scope user headless -- headless-mcp --host grok");
        expect(output).toContain("[mcp_servers.headless]");
      }
    }
  });

  test("prints the Claude fallback when spawning the host CLI throws", async () => {
    const messages: string[] = [];
    await runMcpInstall("claude", {
      checkoutRoot: "/fixture/project",
      log: (message) => messages.push(message),
      run: async () => { throw new Error("claude executable not found"); },
    });
    expect(messages.join("\n")).toContain("claude executable not found");
    expect(messages.join("\n")).toContain("claude mcp add headless -- headless-mcp --host claude");
  });

  test("merges Headless into OpenCode's global config without touching the checkout", async () => {
    const fixture = directories();
    try {
      const configPath = opencodeGlobalConfigPath({ homeDir: fixture.home, env: {} });
      mkdirSync(join(fixture.home, ".config", "opencode"), { recursive: true });
      writeFileSync(configPath, JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: "openai/existing",
        mcp: { existing: { type: "remote", url: "https://example.test/mcp" } },
      }));
      const messages: string[] = [];

      await runMcpInstall("opencode", {
        checkoutRoot: fixture.checkout,
        homeDir: fixture.home,
        env: {},
        log: (message) => messages.push(message),
      });

      expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
        $schema: "https://opencode.ai/config.json",
        model: "openai/existing",
        mcp: {
          existing: { type: "remote", url: "https://example.test/mcp" },
          headless: { type: "local", command: ["headless-mcp", "--host", "opencode"] },
        },
      });
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
      expect(messages.join("\n")).toContain("OpenCode's global config");
      expect(existsSync(join(fixture.checkout, "opencode.json"))).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("refuses an OpenCode global-config path inside the checkout and prints the merge snippet", async () => {
    const fixture = directories();
    try {
      const messages: string[] = [];
      await runMcpInstall("opencode", {
        checkoutRoot: fixture.checkout,
        env: { XDG_CONFIG_HOME: join(fixture.checkout, "config") },
        log: (message) => messages.push(message),
      });

      expect(existsSync(join(fixture.checkout, "config"))).toBe(false);
      expect(messages.join("\n")).toContain("Refusing to write OpenCode global configuration inside the project checkout");
      expect(messages.join("\n")).toContain('"type": "local"');
      expect(messages.join("\n")).toContain('"headless-mcp"');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("keeps unknown hosts fail closed", async () => {
    await expect(runMcpInstall("future-host", { run: async () => 0 })).rejects.toThrow("Unknown MCP host");
  });
});

describe("init --lead", () => {
  test("initializes state, installs MCP, then binds the lead without granting trust", async () => {
    const order: string[] = [];
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const messages: string[] = [];
    const fakeClient = {
      state: { projectDir: "/external/state/project" },
      call: async (method: string, params?: Record<string, unknown>) => {
        order.push(method);
        calls.push({ method, params });
        if (method === "ping") return { projectId: "project-id", projectRoot: "/canonical/project", principal: "root" };
        return { host: "claude" };
      },
    };

    await runInitCommand(["init", "--lead", "claude", "--cwd", "/requested/project"], {
      client: (async (projectRoot, flags) => {
        expect(projectRoot).toBe("/requested/project");
        expect(flags).toContain("--lead");
        return fakeClient;
      }) as never,
      installMcp: async (host, options) => {
        order.push("mcp.install");
        expect(host).toBe("claude");
        expect(options.checkoutRoot).toBe("/canonical/project");
      },
      log: (message) => messages.push(message),
    });

    expect(order).toEqual(["ping", "mcp.install", "lead.use"]);
    expect(calls).toEqual([
      { method: "ping", params: undefined },
      { method: "lead.use", params: { host: "claude" } },
    ]);
    expect(calls.some(({ method }) => method.includes("trust"))).toBe(false);
    expect(messages.join("\n")).toContain("Project trust and native egress remain unchanged");
  });
});

function directories() {
  const root = mkdtempSync(join(tmpdir(), "headless-mcp-install-"));
  const home = join(root, "home");
  const checkout = join(root, "checkout");
  mkdirSync(home);
  mkdirSync(checkout);
  return { root, home, checkout };
}
