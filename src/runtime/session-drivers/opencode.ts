import { CommandSessionDriver, type CommandSessionDriverOptions } from "./command-driver";
import { decodeOpenCodeEvent } from "./event-decoder";
import type { SessionDriverRuntime } from "./base";
import { safeSessionOption } from "./options";
import { safeAgentName } from "../validation";
import { openCodeColdStartNeedsRetry } from "../../backends/opencode";

export class OpenCodeSessionDriver extends CommandSessionDriver {
  constructor(options: CommandSessionDriverOptions) {
    super({
      backend: "opencode",
      kind: "opencode-session",
      binary: "opencode",
      capabilities: {
        nativeResume: true,
        persistentTransport: false,
        replayFallback: true,
        structuredEvents: true,
        cancellation: true,
      },
      versionArgs: ["--version"],
      helpArgs: ["run", "--help"],
      requiredHelpFragments: ["--session", "--format", "--dir"],
      decoder: decodeOpenCodeEvent,
      buildInitial: (runtime, prompt) => openCodeCommand(runtime, prompt),
      buildResume: (runtime, prompt, nativeSessionId) => openCodeCommand(runtime, prompt, nativeSessionId),
      retryAfterInitialization: openCodeColdStartNeedsRetry,
    }, options.executor, options);
  }
}

function openCodeCommand(runtime: SessionDriverRuntime, prompt: string, nativeSessionId?: string) {
  const argv = ["opencode", "run", "--pure", "--format", "json", "--dir", runtime.cwd];
  if (nativeSessionId) argv.push("--session", safeSessionOption(nativeSessionId, "native id")!);
  if (runtime.model) argv.push("--model", safeSessionOption(runtime.model, "model")!);
  if (runtime.agent) argv.push("--agent", safeAgentName(runtime.agent, "OpenCode"));
  if (runtime.approvalPolicy === "auto" || runtime.approvalPolicy === "bypass") argv.push("--dangerously-skip-permissions");
  argv.push("--", prompt);
  return { argv, stdin: null, protocol: "jsonl" as const };
}
