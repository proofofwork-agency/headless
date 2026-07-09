import type { ExecOptions } from "../index";
import { buildGrokCommand, parseGrokJsonl } from "./grok";
import { parseClaudeStreamJson, parseCodexJson, type JsonParseResult } from "./json";
import { buildOpenCodeCommand, nextOpenCodeEnv, parseOpenCodeJsonl } from "./opencode";
import { backendMetadata } from "./metadata";
import type { Backend } from "./ids";

export type BackendAdapter = {
  id: Backend;
  metadata: typeof backendMetadata[Backend];
  stdinPrompt: boolean;
  prepareEnv?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  buildCommand: (opts: ExecOptions, cwd: string) => string[];
  parse: (stdout: string) => JsonParseResult;
};

export const backendAdapters: Record<Backend, BackendAdapter> = {
  opencode: {
    id: "opencode",
    metadata: backendMetadata.opencode,
    stdinPrompt: false,
    prepareEnv: nextOpenCodeEnv,
    buildCommand: buildOpenCodeCommand,
    parse: parseOpenCodeJsonl,
  },
  "claude-code": {
    id: "claude-code",
    metadata: backendMetadata["claude-code"],
    stdinPrompt: true,
    buildCommand: () => ["claude", "-p", "--output-format", "stream-json", "--verbose", "--allowedTools", "Read,Grep,Glob,LS"],
    parse: parseClaudeStreamJson,
  },
  codex: {
    id: "codex",
    metadata: backendMetadata.codex,
    stdinPrompt: true,
    buildCommand: () => ["codex", "exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "--ephemeral", "-"],
    parse: parseCodexJson,
  },
  "grok-build": {
    id: "grok-build",
    metadata: backendMetadata["grok-build"],
    stdinPrompt: false,
    buildCommand: buildGrokCommand,
    parse: parseGrokJsonl,
  },
};

export function assertModeAllowed(backend: Backend, mode: ExecOptions["mode"] = "read-only") {
  const adapter = backendAdapters[backend];
  if (mode === "write" && !adapter.metadata.canWrite) {
    throw new Error(`Backend ${backend} does not support write mode in Headless yet.`);
  }
}
