import { CommandSessionDriver, type CommandSessionDriverOptions } from "./command-driver";
import { codexProjectPolicyArguments } from "../../backends/codex";
import { decodeCodexEvent } from "./event-decoder";
import type { SessionDriverRuntime } from "./base";
import { safeSessionOption } from "./options";

export class CodexExecSessionDriver extends CommandSessionDriver {
  constructor(options: CommandSessionDriverOptions) {
    super({
      backend: "codex",
      kind: "codex-exec-resume",
      binary: "codex",
      capabilities: {
        nativeResume: true,
        persistentTransport: false,
        replayFallback: true,
        structuredEvents: true,
        cancellation: true,
      },
      versionArgs: ["--version"],
      helpArgs: ["exec", "resume", "--help"],
      requiredHelpFragments: ["--json"],
      decoder: decodeCodexEvent,
      buildInitial: (runtime, prompt) => codexInitialCommand(runtime, prompt),
      buildResume: (runtime, prompt, nativeSessionId) => codexResumeCommand(runtime, prompt, nativeSessionId),
    }, options.executor, options);
  }
}

function codexInitialCommand(runtime: SessionDriverRuntime, prompt: string) {
  const argv = [
    "codex",
    "exec",
    "--json",
    "--sandbox",
    runtime.mode === "write" ? "workspace-write" : "read-only",
    "--cd",
    runtime.cwd,
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
  ];
  argv.push(...codexPolicyArguments(runtime));
  if (runtime.model) argv.push("--model", safeSessionOption(runtime.model, "model")!);
  argv.push("-");
  return { argv, stdin: `${prompt}\n`, protocol: "jsonl" as const };
}

function codexResumeCommand(runtime: SessionDriverRuntime, prompt: string, nativeSessionId: string) {
  const argv = [
    "codex", "exec", "resume", safeSessionOption(nativeSessionId, "native id")!,
    "--json", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "--strict-config",
    ...codexPolicyArguments(runtime),
  ];
  if (runtime.model) argv.push("--model", safeSessionOption(runtime.model, "model")!);
  argv.push("-");
  return { argv, stdin: `${prompt}\n`, protocol: "jsonl" as const };
}

function codexPolicyArguments(runtime: SessionDriverRuntime) {
  const values = [
    ...codexProjectPolicyArguments(runtime.cwd),
  ];
  if (runtime.approvalPolicy === "bypass") values.push("--dangerously-bypass-approvals-and-sandbox");
  else values.push("-c", `approval_policy=${JSON.stringify(runtime.approvalPolicy === "auto" ? "never" : "on-request")}`);
  return values;
}
