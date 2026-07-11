import { CommandSessionDriver, type CommandSessionDriverOptions } from "./command-driver";
import { decodeOpenCodeEvent } from "./event-decoder";
import type { SessionDriverRuntime } from "./base";
import { safeSessionOption } from "./options";
import { safeAgentName } from "../validation";
import { parseOpenCodeJsonl } from "../../backends/opencode";

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
      retryAfterInitialization: isColdStartWithoutOutput,
    }, options.executor, options);
  }
}

/**
 * True when an opencode run finished cleanly but produced **no assistant text** —
 * opencode's one-time, fresh-data-dir cold start. The driver retries once in the
 * same (now-warm) worker, which yields the real turn. Two shapes are covered:
 *  - opencode ≤ 1.15: the DB-migration run exits 0 with empty stdout and a
 *    `sqlite-migration:done` / `Database migration complete.` banner on stderr.
 *  - opencode ≥ 1.17: the init run emits `step_start`/`step_finish` on stdout but
 *    no `text` part (the banner is gone), so key off the parsed output instead.
 */
function isColdStartWithoutOutput(result: { exitCode: number | null; stdout?: string; stderr?: string }) {
  if (result.exitCode !== 0) return false;
  const stdout = result.stdout ?? "";
  if (!stdout.trim()) {
    const diagnostic = result.stderr ?? "";
    return diagnostic.includes("Performing one time database migration")
      || (diagnostic.includes("sqlite-migration:done") && diagnostic.includes("Database migration complete."));
  }
  // A clean run that carried no assistant text back is the cold-start init turn.
  return parseOpenCodeJsonl(stdout).output.trim() === "";
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
