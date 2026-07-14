import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DAEMON_PROTOCOL_VERSION } from "../src/daemon/protocol";
import { MCP_VERSION } from "../src/mcp/server";

const root = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const plugin = JSON.parse(readFileSync(join(root, "plugin", "package.json"), "utf8"));

describe("v0.2 private-alpha package metadata", () => {
  test("keeps package, MCP, plugin, schema, and daemon protocol versions aligned", () => {
    expect(pkg.version).toBe("0.2.0-alpha.0");
    expect(pkg.private).toBe(true);
    expect(pkg.packageManager).toBe("bun@1.3.14");
    expect(plugin.version).toBe(pkg.version);
    expect(MCP_VERSION).toBe(pkg.version);
    expect(DAEMON_PROTOCOL_VERSION).toBe(2);
  });

  test("packs only compiled entrypoints and declares the plugin runtime peer", () => {
    expect(pkg.files).toEqual(["dist", "README.md", "CHANGELOG.md", "SECURITY.md", "docs/mcp-integration.md", "docs/native-login.md", "docs/command-reference.md", "docs/cli-and-tui-guide.md", "docs/plan.md", "LICENSE"]);
    expect(pkg.scripts.prepare).toBeUndefined();
    expect(Object.values(pkg.bin).every((path) => path.startsWith("./dist/") && path.endsWith(".js"))).toBe(true);
    expect(new Set(Object.values(pkg.bin)).size).toBe(Object.keys(pkg.bin).length);
    for (const target of Object.values(pkg.exports) as Array<Record<string, string>>) {
      expect(target.import).toStartWith("./dist/");
      expect(target.types).toStartWith("./dist/");
    }

    expect(plugin.files).toEqual(["dist", "README.md", "LICENSE"]);
    expect(plugin.main).toBe("./dist/index.js");
    expect(plugin.types).toBe("./dist/index.d.ts");
    expect(plugin.version).toBe("0.2.0-alpha.0");
    expect(plugin.private).toBe(true);
    expect(plugin.peerDependencies["@proofofwork-agency/headless"]).toBe("0.2.0-alpha.0");
    expect(plugin.peerDependenciesMeta?.["@proofofwork-agency/headless"]?.optional).not.toBe(true);
  });

  test("keeps credentialed provider smoke behind an explicit protected workflow", () => {
    const workflow = readFileSync(join(root, ".github", "workflows", "provider-smoke.yml"), "utf8");
    expect(pkg.scripts["smoke:providers"]).toBe("bun scripts/provider-smoke.ts");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("environment: provider-smoke");
    expect(workflow).toContain("bun run smoke:providers");
    for (const credential of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY"]) {
      expect(workflow).toContain(`secrets.${credential}`);
    }
  });

  test("keeps native subscription smoke behind a separate exact opt-in guard", () => {
    const harness = readFileSync(join(root, "scripts", "native-subscription-smoke.ts"), "utf8");
    expect(pkg.scripts["smoke:native"]).toBe("bun scripts/native-subscription-smoke.ts");
    expect(harness).toContain('process.env[OPT_IN_ENV] !== "1"');
    expect(harness).toContain('resolve(import.meta.dir, "../dist/cli.js")');
    expect(harness).toContain("providerApiKeyEnvironmentCleared: true");
    expect(harness).toContain("providerCredentialEnvironmentCleared: true");
    expect(harness).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });
});
