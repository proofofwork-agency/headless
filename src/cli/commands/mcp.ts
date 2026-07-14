import { CliUsageError, ensureSupportedPlatform } from "../shared";

export async function runMcpCommand(args: string[]) {
  const action = args[1] || "serve";
  if (action === "serve" || action === "server") {
    ensureSupportedPlatform();
    const host = args[2]?.toLowerCase();
    if (!host) throw new CliUsageError("Usage: headless mcp serve <host>");
    console.error(`Starting Headless MCP server over stdio for the configured ${host} lead.`);
    await import("../../mcp/server.js").then((module) => module.startMcpServer({ host }));
    return;
  }
  const host = args[2]?.toLowerCase() || "codex";
  if (action === "install") return runMcpInstall(host);
  if (action === "remove") return runMcpRemove(host);
  if (action === "status") return runMcpStatus(host);
  throw new CliUsageError("Usage: headless mcp <serve|install|remove|status> [codex|grok|claude|opencode]");
}

export function mcpServerCommand(host: string) {
  return { command: "headless-mcp", args: ["--host", host] };
}

export async function runMcpInstall(host: string) {
  const server = mcpServerCommand(host);
  const command = [server.command, ...server.args];
  if (host === "codex" || host === "codex-cli") {
    const child = Bun.spawn(["codex", "mcp", "add", "headless", "--", ...command], { stdout: "inherit", stderr: "inherit" });
    const exitCode = await child.exited;
    if (exitCode !== 0) throw new Error(`Codex MCP installation failed. Run: codex mcp add headless -- ${command.join(" ")}`);
    console.log("Installed the published Headless MCP server for Codex.");
    return;
  }
  if (host === "grok" || host === "grok-build") {
    console.log(`grok mcp add headless -- ${command.join(" ")}`);
    console.log(`[mcp_servers.headless]\ncommand = "${server.command}"\nargs = ["--host", "${host}"]`);
    return;
  }
  if (host === "claude" || host === "claude-code") {
    console.log(JSON.stringify({ mcpServers: { headless: server } }, null, 2));
    return;
  }
  if (host === "opencode") {
    console.log(JSON.stringify({ mcp: { headless: { type: "local", command } } }, null, 2));
    return;
  }
  throw new CliUsageError(`Unknown MCP host: ${host}. Expected codex, grok, claude, or opencode.`);
}

async function runMcpRemove(host: string) {
  if (host !== "codex" && host !== "codex-cli") {
    console.log(`Remove Headless with ${host}'s MCP configuration UI or command.`);
    return;
  }
  const child = Bun.spawn(["codex", "mcp", "remove", "headless"], { stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error("Codex MCP removal failed.");
}

async function runMcpStatus(host: string) {
  if (host !== "codex" && host !== "codex-cli") {
    console.log(`Inspect Headless with ${host}'s MCP list command or configuration UI.`);
    return;
  }
  const child = Bun.spawn(["codex", "mcp", "get", "headless"], { stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error("Headless is not configured in Codex.");
}
