import type { ExecOptions } from "../index";
import { buildAdapterEnv } from "./env";
import { buildGrokCommand, parseGrokJsonl } from "./grok";
import { parseClaudeStreamJson, parseCodexJson, type JsonParseResult } from "./json";
import { buildOpenCodeCommand, nextOpenCodeEnv, OPENCODE_CREDENTIAL_PREFIXES, parseOpenCodeJsonl } from "./opencode";
import { backendMetadata } from "./metadata";
import type { Backend } from "./ids";

export type BackendAdapter = {
  id: Backend;
  metadata: typeof backendMetadata[Backend];
  stdinPrompt: boolean;
  credentialPrefixes: string[];
  selfSandboxed?: boolean;
  buildEnv?: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  buildCommand: (opts: ExecOptions, cwd: string) => string[];
  parse: (stdout: string) => JsonParseResult;
};

export const backendAdapters: Record<Backend, BackendAdapter> = {
  opencode: {
    id: "opencode",
    metadata: backendMetadata.opencode,
    stdinPrompt: false,
    // Single source of truth in opencode.ts (nextOpenCodeEnv uses the same list).
    credentialPrefixes: OPENCODE_CREDENTIAL_PREFIXES,
    buildEnv: nextOpenCodeEnv,
    buildCommand: buildOpenCodeCommand,
    parse: parseOpenCodeJsonl,
  },
  "claude-code": {
    id: "claude-code",
    metadata: backendMetadata["claude-code"],
    stdinPrompt: true,
    credentialPrefixes: ["ANTHROPIC_", "CLAUDE_"],
    buildCommand: buildClaudeCommand,
    parse: parseClaudeStreamJson,
  },
  codex: {
    id: "codex",
    metadata: backendMetadata.codex,
    stdinPrompt: true,
    credentialPrefixes: ["OPENAI_", "CODEX_"],
    selfSandboxed: true,
    buildCommand: buildCodexCommand,
    parse: parseCodexJson,
  },
  "grok-build": {
    id: "grok-build",
    metadata: backendMetadata["grok-build"],
    stdinPrompt: false,
    credentialPrefixes: ["XAI_", "GROK_"],
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

export function buildBackendEnv(adapter: BackendAdapter, env: NodeJS.ProcessEnv = process.env) {
  return adapter.buildEnv ? adapter.buildEnv(env) : buildAdapterEnv(env, adapter.credentialPrefixes);
}

function buildClaudeCommand(opts: ExecOptions) {
  const cmd = ["claude", "-p", "--output-format", "stream-json", "--verbose", "--allowedTools", "Read,Grep,Glob,LS"];
  if (opts.model) cmd.push("--model", opts.model);
  return cmd;
}

function buildCodexCommand(opts: ExecOptions) {
  const cmd = ["codex", "exec"];
  if (opts.model) cmd.push("--model", opts.model);
  cmd.push("--json", "--sandbox", "read-only", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "--ephemeral", "-");
  return cmd;
}
