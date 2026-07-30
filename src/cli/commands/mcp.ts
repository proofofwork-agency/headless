import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { atomicWriteFile } from "../../runtime/atomic-write";
import { CliUsageError, ensureSupportedPlatform, flagArgsBeforeSeparator, getArg } from "../shared";

export type McpHost = "codex" | "grok" | "claude" | "opencode";

export type McpInstallOptions = {
  checkoutRoot?: string;
  env?: Readonly<NodeJS.ProcessEnv>;
  homeDir?: string;
  log?: (message: string) => void;
  run?: (command: readonly string[], options: { cwd?: string }) => Promise<number>;
};

export async function runMcpCommand(args: string[]) {
  const action = args[1] || "serve";
  const flags = flagArgsBeforeSeparator(args);
  const checkoutRoot = getArg(flags, "--cwd") || process.cwd();
  if (action === "serve" || action === "server") {
    ensureSupportedPlatform();
    const host = normalizeMcpHost(args[2] && !args[2].startsWith("-") ? args[2] : "codex");
    // Prefer env so nested resolution and any residual entrypoint probes agree.
    process.env.HEADLESS_LEAD_HOST = host;
    if (!process.env.HEADLESS_PROJECT_ROOT) {
      process.env.HEADLESS_PROJECT_ROOT = checkoutRoot;
    }
    // Stdio MCP: keep stderr free of noise that hosts might treat as protocol.
    // Operators can still see attach status via lead status / doctor.
    await import("../../mcp/server.js").then((module) => module.startMcpServer({ host }));
    return;
  }
  const host = normalizeMcpHost(args[2] && !args[2].startsWith("-") ? args[2] : "codex");
  if (action === "install") return runMcpInstall(host, { checkoutRoot });
  if (action === "remove") return runMcpRemove(host);
  if (action === "status") return runMcpStatus(host);
  throw new CliUsageError("Usage: headless mcp <serve|install|remove|status> [codex|grok|claude|opencode] [--cwd dir]");
}

export function normalizeMcpHost(value: string | undefined): McpHost {
  const host = value?.trim().toLowerCase();
  if (host === "codex" || host === "codex-cli") return "codex";
  if (host === "grok" || host === "grok-build") return "grok";
  if (host === "claude" || host === "claude-code") return "claude";
  if (host === "opencode") return "opencode";
  throw new CliUsageError(`Unknown MCP host: ${value || "(missing)"}. Expected codex, grok, claude, or opencode.`);
}

export function mcpServerCommand(host: McpHost) {
  return { command: "headless-mcp", args: ["--host", host] };
}

export async function runMcpInstall(hostValue: string, options: McpInstallOptions = {}) {
  const host = normalizeMcpHost(hostValue);
  const server = mcpServerCommand(host);
  const command = [server.command, ...server.args];
  const log = options.log ?? console.log;
  const run = options.run ?? runHostCommand;
  const checkoutRoot = resolve(options.checkoutRoot ?? process.cwd());
  if (host === "codex") {
    let exitCode: number;
    try {
      exitCode = await run(["codex", "mcp", "add", "headless", "--", ...command], { cwd: checkoutRoot });
    } catch (error) {
      throw new Error(`Codex MCP installation failed. Run: codex mcp add headless -- ${command.join(" ")}. ${messageOf(error)}`);
    }
    if (exitCode !== 0) throw new Error(`Codex MCP installation failed. Run: codex mcp add headless -- ${command.join(" ")}`);
    log("Installed the published Headless MCP server for Codex.");
    return;
  }
  if (host === "claude") {
    await installWithPrintedFallback({
      label: "Claude Code",
      invocation: ["claude", "mcp", "add", "headless", "--", ...command],
      checkoutRoot,
      run,
      log,
      fallback: () => {
        log(`claude mcp add headless -- ${command.join(" ")}`);
        log(JSON.stringify({ mcpServers: { headless: server } }, null, 2));
      },
    });
    return;
  }
  if (host === "grok") {
    await installWithPrintedFallback({
      label: "Grok",
      invocation: ["grok", "mcp", "add", "--scope", "user", "headless", "--", ...command],
      checkoutRoot,
      run,
      log,
      fallback: () => {
        log(`grok mcp add --scope user headless -- ${command.join(" ")}`);
        log(`[mcp_servers.headless]\ncommand = "${server.command}"\nargs = ["--host", "${host}"]\nenabled = true`);
      },
    });
    return;
  }
  installOpenCodeGlobalConfig(server, { ...options, checkoutRoot, log });
}

export function opencodeGlobalConfigPath(options: Pick<McpInstallOptions, "env" | "homeDir"> = {}) {
  const env = options.env ?? process.env;
  const configured = env.XDG_CONFIG_HOME?.trim();
  if (configured && !isAbsolute(configured)) throw new Error("XDG_CONFIG_HOME must be an absolute path before Headless can update OpenCode's global configuration.");
  const configHome = configured || join(resolve(options.homeDir ?? homedir()), ".config");
  return join(configHome, "opencode", "opencode.json");
}

async function installWithPrintedFallback(options: {
  label: string;
  invocation: readonly string[];
  checkoutRoot: string;
  run: NonNullable<McpInstallOptions["run"]>;
  log: (message: string) => void;
  fallback: () => void;
}) {
  try {
    const exitCode = await options.run(options.invocation, { cwd: options.checkoutRoot });
    if (exitCode !== 0) throw new Error(`${options.label} exited with code ${exitCode}.`);
    options.log(`Installed the published Headless MCP server for ${options.label}.`);
  } catch (error) {
    options.log(`${options.label} MCP installation could not be automated: ${messageOf(error)}`);
    options.log("Apply either of the following equivalent configurations manually:");
    options.fallback();
  }
}

function installOpenCodeGlobalConfig(
  server: ReturnType<typeof mcpServerCommand>,
  options: McpInstallOptions & { checkoutRoot: string; log: (message: string) => void },
) {
  const snippet = { mcp: { headless: { type: "local", command: [server.command, ...server.args] } } };
  let path: string;
  try {
    path = opencodeGlobalConfigPath(options);
    assertOutsideCheckout(path, options.checkoutRoot);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const existing = existsSync(path) ? readOpenCodeConfig(path) : { $schema: "https://opencode.ai/config.json" };
    const mcp = existing.mcp === undefined ? {} : requireRecord(existing.mcp, "OpenCode global mcp configuration");
    const next = {
      ...existing,
      mcp: {
        ...mcp,
        headless: snippet.mcp.headless,
      },
    };
    atomicWriteFile(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    options.log(`Installed the published Headless MCP server in OpenCode's global config: ${path}`);
  } catch (error) {
    options.log(`OpenCode MCP installation could not update its global config: ${messageOf(error)}`);
    options.log("Merge this entry into ~/.config/opencode/opencode.json:");
    options.log(JSON.stringify(snippet, null, 2));
  }
}

function readOpenCodeConfig(path: string) {
  const size = statSync(path).size;
  if (size > 4 * 1024 * 1024) throw new Error("OpenCode global config exceeds the 4 MiB installer safety bound.");
  return requireRecord(JSON.parse(readFileSync(path, "utf8")), "OpenCode global configuration");
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be a JSON object.`);
  return value as Record<string, unknown>;
}

function assertOutsideCheckout(path: string, checkoutRoot: string) {
  const checkout = resolve(checkoutRoot);
  const candidate = resolve(path);
  const fromCheckout = relative(checkout, candidate);
  if (fromCheckout === "" || (fromCheckout !== ".." && !fromCheckout.startsWith(`..${sep}`) && !isAbsolute(fromCheckout))) {
    throw new Error(`Refusing to write OpenCode global configuration inside the project checkout: ${candidate}`);
  }
}

async function runHostCommand(command: readonly string[], options: { cwd?: string }) {
  const child = Bun.spawn([...command], { cwd: options.cwd, stdout: "inherit", stderr: "inherit" });
  return child.exited;
}

async function runMcpRemove(host: McpHost) {
  if (host !== "codex") {
    console.log(`Remove Headless with ${host}'s MCP configuration UI or command.`);
    return;
  }
  const child = Bun.spawn(["codex", "mcp", "remove", "headless"], { stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error("Codex MCP removal failed.");
}

async function runMcpStatus(host: McpHost) {
  if (host !== "codex") {
    console.log(`Inspect Headless with ${host}'s MCP list command or configuration UI.`);
    return;
  }
  const child = Bun.spawn(["codex", "mcp", "get", "headless"], { stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error("Headless is not configured in Codex.");
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
