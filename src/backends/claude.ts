import type { ExecOptions } from "../index";
import { safeOption } from "../runtime/validation";

export const CLAUDE_EMPTY_MCP_CONFIG = JSON.stringify({ mcpServers: {} });

// Bash remains inside the outer read-only OS sandbox and is needed to invoke
// the authenticated per-run cooperation helper. Native tool policy is defense
// in depth, never the filesystem or network authority.
export const CLAUDE_READ_TOOLS = ["Read", "Grep", "Glob", "LS", "Bash"] as const;
export const CLAUDE_WRITE_TOOLS = ["Read", "Grep", "Glob", "LS", "Bash", "Edit", "Write", "NotebookEdit"] as const;

const CLAUDE_READ_DENIED_TOOLS = [
  "Edit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
  "Skill",
] as const;

const CLAUDE_WRITE_DENIED_TOOLS = ["WebFetch", "WebSearch", "Task", "Skill"] as const;

/**
 * Claude's native permissions are defense in depth. The outer OS containment
 * remains authoritative for filesystem and network access in both modes.
 */
export function buildClaudeCommand(opts: ExecOptions) {
  const write = opts.mode === "write";
  const allowed = write ? CLAUDE_WRITE_TOOLS : CLAUDE_READ_TOOLS;
  const denied = write ? CLAUDE_WRITE_DENIED_TOOLS : CLAUDE_READ_DENIED_TOOLS;
  const cmd = [
    "claude",
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    // Disable project/user instructions, hooks, plugins, skills, and agents.
    "--safe-mode",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    CLAUDE_EMPTY_MCP_CONFIG,
    "--disable-slash-commands",
    "--no-session-persistence",
    "--no-chrome",
    "--permission-mode",
    claudePermissionMode(opts.approvalPolicy),
    "--tools",
    allowed.join(","),
    "--allowedTools",
    allowed.join(","),
    "--disallowedTools",
    denied.join(","),
  ];
  if ((opts.authMode ?? "native-login") === "broker") cmd.splice(5, 0, "--bare");
  if (opts.model) cmd.push("--model", safeOption(opts.model, "model", { namespace: "Claude" }));
  return cmd;
}

function claudePermissionMode(policy: ExecOptions["approvalPolicy"]) {
  if (policy === "bypass") return "bypassPermissions";
  if (policy === "auto") return "auto";
  return "manual";
}
