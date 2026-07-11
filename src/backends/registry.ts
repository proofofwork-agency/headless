import type { ExecOptions } from "../index";
import { buildAdapterEnv } from "./env";
import { buildClaudeCommand } from "./claude";
import { buildCodexCommand } from "./codex";
import { buildGrokCommand, parseGrokJsonl } from "./grok";
import { parseClaudeStreamJson, parseCodexJson, type JsonParseResult } from "./json";
import { buildOpenCodeCommand, nextOpenCodeEnv, OPENCODE_CREDENTIAL_PREFIXES, parseOpenCodeJsonl } from "./opencode";
import { backendMetadata, type BackendMetadata } from "./metadata";
import { normalizeBackend, type Backend } from "./ids";
import type { AdapterCapabilities } from "../contracts/adapter";

export type BackendAdapterMetadata = Omit<BackendMetadata, "id"> & { id: string };
export type BackendAdapterSecurity = {
  outerContainmentRequired: boolean;
  strictAuth: "broker-api-key" | "credential-free";
  disablesProjectConfig: boolean;
  disablesHooks: boolean;
  disablesMcp: boolean;
  disablesSkills: boolean;
};
export type BackendAdapterProbeSpec = {
  versionCommand: readonly string[];
  helpCommand: readonly string[];
  requiredHelpFragments: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
  minimumVersion?: string;
};
export type BackendAdapter = {
  id: string;
  metadata: BackendAdapterMetadata;
  capabilities: AdapterCapabilities;
  security: BackendAdapterSecurity;
  probe: BackendAdapterProbeSpec;
  stdinPrompt: boolean;
  supportsNamedAgent?: boolean;
  credentialPrefixes: string[];
  selfSandboxed?: boolean;
  buildEnv?: (env: NodeJS.ProcessEnv, opts?: ExecOptions) => NodeJS.ProcessEnv;
  buildCommand: (opts: ExecOptions, cwd: string) => string[];
  buildResumeCommand?: (opts: ExecOptions, cwd: string, nativeSessionId: string) => string[];
  parse: (stdout: string) => JsonParseResult;
};

const builtInBackendAdapters = {
  opencode: {
    id: "opencode",
    metadata: backendMetadata.opencode,
    capabilities: capabilities({ write: true, tools: true }),
    security: hardenedSecurity(),
    probe: probeSpec(
      ["opencode", "--version"],
      ["opencode", "run", "--help"],
      ["--pure", "--format", "--dir", "--model", "--agent"],
      "1.15.3",
    ),
    stdinPrompt: false,
    supportsNamedAgent: true,
    // Single source of truth in opencode.ts (nextOpenCodeEnv uses the same list).
    credentialPrefixes: OPENCODE_CREDENTIAL_PREFIXES,
    buildEnv: nextOpenCodeEnv,
    buildCommand: buildOpenCodeCommand,
    parse: parseOpenCodeJsonl,
  },
  "claude-code": {
    id: "claude-code",
    metadata: backendMetadata["claude-code"],
    capabilities: capabilities({ write: true, tools: true, effort: true }),
    security: hardenedSecurity(),
    probe: probeSpec(
      ["claude", "--version"],
      ["claude", "--help"],
      [
        "--bare",
        "--safe-mode",
        "--setting-sources",
        "--strict-mcp-config",
        "--mcp-config",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--no-chrome",
        "--allowedTools",
        "--disallowedTools",
      ],
      "2.1.206",
    ),
    stdinPrompt: true,
    credentialPrefixes: ["ANTHROPIC_API_KEY"],
    buildCommand: buildClaudeCommand,
    parse: parseClaudeStreamJson,
  },
  codex: {
    id: "codex",
    metadata: backendMetadata.codex,
    capabilities: capabilities({ write: true, tools: true }),
    security: hardenedSecurity(),
    probe: probeSpec(
      ["codex", "--version"],
      ["codex", "exec", "--help"],
      ["--ignore-user-config", "--ignore-rules", "--ephemeral", "read-only", "workspace-write"],
      "0.144.1",
    ),
    stdinPrompt: true,
    credentialPrefixes: ["OPENAI_API_KEY"],
    selfSandboxed: true,
    buildCommand: buildCodexCommand,
    parse: parseCodexJson,
  },
  "grok-build": {
    id: "grok-build",
    metadata: backendMetadata["grok-build"],
    capabilities: capabilities({ write: true, tools: true }),
    security: {
      outerContainmentRequired: true,
      strictAuth: "broker-api-key",
      // The isolated config and startup snapshot masks remove every surface
      // present at launch. Grok 0.2.93 still watches native skill paths, and
      // Linux cannot kernel-mask future glob matches, so required runs remain
      // fail-closed until that dynamic boundary is available.
      disablesProjectConfig: false,
      disablesHooks: false,
      disablesMcp: false,
      disablesSkills: false,
    },
    probe: probeSpec(
      ["grok", "--version"],
      ["grok", "--help"],
      ["--single", "--cwd", "--output-format", "--permission-mode", "--agent", "--no-subagents", "--no-memory", "--disable-web-search", "--verbatim", "--system-prompt-override", "--tools", "inspect"],
      "0.2.93",
    ),
    stdinPrompt: false,
    supportsNamedAgent: true,
    credentialPrefixes: ["XAI_API_KEY"],
    buildCommand: buildGrokCommand,
    parse: parseGrokJsonl,
  },
} satisfies Record<Backend, BackendAdapter>;

/** Stable built-in view retained for existing runner consumers. */
export const backendAdapters: Readonly<Record<Backend, BackendAdapter>> = builtInBackendAdapters;

const builtInIds = new Set<string>(Object.keys(builtInBackendAdapters));
const registeredAdapters = new Map<string, BackendAdapter>(
  Object.values(builtInBackendAdapters).map((adapter) => [adapter.id, adapter]),
);

export function registerAdapter(adapter: BackendAdapter, opts: { replace?: boolean } = {}) {
  validateAdapterDefinition(adapter);
  const existing = registeredAdapters.get(adapter.id);
  if (builtInIds.has(adapter.id)) {
    throw new Error(`Cannot replace built-in backend adapter: ${adapter.id}`);
  }
  if (existing && !opts.replace) {
    throw new Error(`Backend adapter already registered: ${adapter.id}`);
  }
  registeredAdapters.set(adapter.id, adapter);
  return adapter;
}

export function unregisterAdapter(id: string) {
  if (builtInIds.has(id)) return false;
  return registeredAdapters.delete(id);
}

export function getAdapter(id: string) {
  return registeredAdapters.get(id);
}

/** Resolve aliases for built-ins and preserve exact registered extension IDs. */
export function resolveAdapterId(input: string) {
  try {
    return normalizeBackend(input);
  } catch {
    if (registeredAdapters.has(input)) return input;
    throw new Error(`Unsupported backend: ${input}`);
  }
}

export function listAdapters() {
  return [...registeredAdapters.values()];
}

export function assertModeAllowed(backend: Backend | string, mode: ExecOptions["mode"] = "read-only") {
  const id = resolveAdapterId(backend);
  const adapter = getAdapter(id);
  if (!adapter) throw new Error(`Backend ${backend} is not registered.`);
  if (mode === "write" && !adapter.metadata.canWrite) {
    throw new Error(`Backend ${backend} does not support write mode in Headless yet.`);
  }
}

/** Security capabilities that required outer containment cannot replace. */
export function requiredContainmentSecurityGaps(adapter: BackendAdapter) {
  const gaps: string[] = [];
  if (!adapter.security.outerContainmentRequired) gaps.push("outer containment authority");
  if (!adapter.security.disablesProjectConfig) gaps.push("project configuration");
  if (!adapter.security.disablesHooks) gaps.push("startup hooks");
  if (!adapter.security.disablesMcp) gaps.push("project MCP servers");
  if (!adapter.security.disablesSkills) gaps.push("project skills");
  return gaps;
}

export function buildBackendEnv(adapter: BackendAdapter, env: NodeJS.ProcessEnv = process.env) {
  return adapter.buildEnv ? adapter.buildEnv(env) : buildAdapterEnv(env, adapter.credentialPrefixes);
}

function capabilities(overrides: Partial<AdapterCapabilities> = {}): AdapterCapabilities {
  return {
    write: false,
    streaming: true,
    structuredOutput: true,
    nativeResume: false,
    cancellation: true,
    tools: false,
    effort: false,
    brokerCompatible: true,
    ...overrides,
  };
}

function hardenedSecurity(): BackendAdapterSecurity {
  return {
    outerContainmentRequired: true,
    strictAuth: "broker-api-key",
    disablesProjectConfig: true,
    disablesHooks: true,
    disablesMcp: true,
    disablesSkills: true,
  };
}

function probeSpec(
  versionCommand: readonly string[],
  helpCommand: readonly string[],
  requiredHelpFragments: readonly string[],
  minimumVersion: string,
): BackendAdapterProbeSpec {
  return { versionCommand, helpCommand, requiredHelpFragments, timeoutMs: 5_000, maxOutputBytes: 262_144, minimumVersion };
}

export function validateAdapterDefinition(adapter: BackendAdapter) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(adapter.id)) {
    throw new Error(`Invalid backend adapter id: ${adapter.id}`);
  }
  if (adapter.metadata.id !== adapter.id) {
    throw new Error(`Backend adapter metadata id mismatch: ${adapter.metadata.id} !== ${adapter.id}`);
  }
  if (adapter.capabilities.write !== adapter.metadata.canWrite) {
    throw new Error(`Backend adapter write capability mismatch for ${adapter.id}`);
  }
  if (!adapter.security || !adapter.probe) {
    throw new Error(`Backend adapter ${adapter.id} must declare security and probe metadata.`);
  }
  if (
    !Number.isSafeInteger(adapter.probe.timeoutMs)
    || adapter.probe.timeoutMs <= 0
    || adapter.probe.timeoutMs > 30_000
    || !Number.isSafeInteger(adapter.probe.maxOutputBytes)
    || adapter.probe.maxOutputBytes <= 0
    || adapter.probe.maxOutputBytes > 1_000_000
    || (adapter.probe.minimumVersion !== undefined && !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(adapter.probe.minimumVersion))
  ) {
    throw new Error(`Backend adapter ${adapter.id} has invalid probe limits.`);
  }
  if (typeof adapter.buildCommand !== "function" || typeof adapter.parse !== "function") {
    throw new Error(`Backend adapter ${adapter.id} must provide buildCommand and parse functions.`);
  }
  if (adapter.capabilities.nativeResume && typeof adapter.buildResumeCommand !== "function") {
    throw new Error(`Backend adapter ${adapter.id} declares native resume without a tested resume command implementation.`);
  }
}
