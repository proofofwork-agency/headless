import { CommandSessionDriver, type CommandSessionDriverOptions } from "./command-driver";
import { decodeClaudeEvent } from "./event-decoder";
import { safeSessionOption } from "./options";
import type { SessionDriverRuntime } from "./base";
import { CLAUDE_EMPTY_MCP_CONFIG, CLAUDE_READ_TOOLS, CLAUDE_WRITE_TOOLS } from "../../backends/claude";

export class ClaudeSessionDriver extends CommandSessionDriver {
  constructor(options: CommandSessionDriverOptions) {
    super({
      backend: "claude-code",
      kind: "claude-print-resume",
      binary: "claude",
      capabilities: {
        nativeResume: true,
        persistentTransport: false,
        replayFallback: true,
        structuredEvents: true,
        cancellation: true,
      },
      versionArgs: ["--version"],
      helpArgs: ["--help"],
      requiredHelpFragments: ["--resume", "--session-id", "--output-format"],
      decoder: decodeClaudeEvent,
      initialNativeSessionId: (runtime) => runtime.handle.id,
      buildInitial: (runtime, prompt) => claudeCommand(runtime, prompt, "--session-id", runtime.nativeSessionId ?? runtime.handle.id),
      buildResume: (runtime, prompt, nativeSessionId) => claudeCommand(runtime, prompt, "--resume", nativeSessionId),
    }, options.executor, options);
  }
}

function claudeCommand(runtime: SessionDriverRuntime, prompt: string, sessionFlag: "--session-id" | "--resume", sessionId: string) {
  const argv = [
    "claude",
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--safe-mode",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    CLAUDE_EMPTY_MCP_CONFIG,
    "--disable-slash-commands",
    "--no-chrome",
    sessionFlag,
    safeSessionOption(sessionId, "native id")!,
    "--permission-mode",
    claudePermissionMode(runtime.approvalPolicy),
    "--tools",
    (runtime.mode === "write" ? CLAUDE_WRITE_TOOLS : CLAUDE_READ_TOOLS).join(","),
    "--allowedTools",
    (runtime.mode === "write" ? CLAUDE_WRITE_TOOLS : CLAUDE_READ_TOOLS).join(","),
  ];
  if (runtime.model) argv.push("--model", safeSessionOption(runtime.model, "model")!);
  return { argv, stdin: `${prompt}\n`, protocol: "jsonl" as const };
}

function claudePermissionMode(policy: SessionDriverRuntime["approvalPolicy"]) {
  if (policy === "bypass") return "bypassPermissions";
  if (policy === "auto") return "auto";
  return "manual";
}
