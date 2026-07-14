import { CommandSessionDriver, type CommandSessionDriverOptions } from "./command-driver";
import { decodeGrokEvent } from "./event-decoder";
import type { SessionDriverRuntime } from "./base";
import { safeSessionOption } from "./options";
import { safeAgentName } from "../validation";
import { GROK_HEADLESS_SYSTEM_PROMPT, GROK_READ_TOOLS, GROK_WRITE_TOOLS } from "../grok-isolation";

export class GrokSessionDriver extends CommandSessionDriver {
  constructor(options: CommandSessionDriverOptions) {
    super({
      backend: "grok-build",
      kind: "grok-resume",
      binary: "grok",
      capabilities: {
        nativeResume: true,
        persistentTransport: false,
        replayFallback: true,
        structuredEvents: true,
        cancellation: true,
      },
      versionArgs: ["--version"],
      helpArgs: ["--help"],
      requiredHelpFragments: ["--resume", "--output-format", "--single", "--agent", "--no-subagents", "--no-memory", "--disable-web-search", "--verbatim", "--system-prompt-override", "--tools"],
      decoder: decodeGrokEvent,
      buildInitial: (runtime, prompt) => grokCommand(runtime, prompt),
      buildResume: (runtime, prompt, nativeSessionId) => grokCommand(runtime, prompt, nativeSessionId),
    }, options.executor, options);
  }
}

function grokCommand(runtime: SessionDriverRuntime, prompt: string, nativeSessionId?: string) {
  const argv = ["grok", "--single", prompt, "--cwd", runtime.cwd, "--output-format", "streaming-json"];
  if (nativeSessionId) argv.push("--resume", safeSessionOption(nativeSessionId, "native id")!);
  if (runtime.model) argv.push("--model", safeSessionOption(runtime.model, "model")!);
  if (runtime.agent) argv.push("--agent", safeAgentName(runtime.agent, "Grok"));
  argv.push(
    "--no-subagents",
    "--no-memory",
    "--disable-web-search",
    "--verbatim",
    "--system-prompt-override",
    GROK_HEADLESS_SYSTEM_PROMPT,
    "--tools",
    runtime.mode === "write" ? GROK_WRITE_TOOLS : GROK_READ_TOOLS,
  );
  const permissionMode = runtime.approvalPolicy === "bypass"
    ? "bypassPermissions"
    : runtime.approvalPolicy === "auto"
      ? "auto"
      : runtime.mode === "read-only" ? "plan" : "default";
  argv.push("--permission-mode", permissionMode);
  return { argv, stdin: null, protocol: "jsonl" as const };
}
