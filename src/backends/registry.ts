import type { ExecOptions } from "../index";
import { buildAdapterEnv } from "./env";
import { buildClaudeCommand } from "./claude";
import { buildCodexCommand } from "./codex";
import { buildGrokCommand, buildGrokResumeCommand, parseGrokJsonl } from "./grok";
import { parseClaudeStreamJson, parseCodexJson, type JsonParseResult } from "./json";
import { buildOpenCodeCommand, buildOpenCodeResumeCommand, nextOpenCodeEnv, OPENCODE_CREDENTIAL_PREFIXES, parseOpenCodeJsonl } from "./opencode";
import { backendMetadata, type BackendMetadata } from "./metadata";
import { normalizeBackend, type Backend } from "./ids";
import type { BackendCapabilities } from "../contracts/backend";
import type { WorkerEnvironment } from "../runtime/worker-environment";
import { CLAUDE_SETUP_TOKEN_ENV } from "../runtime/native-auth-capsule";
import {
  grokProjectControlPaths,
  installGrokIsolation,
  managedGrokExecutable,
  prepareGrokTrustCanary,
  validateGrokIsolationInspection,
  validateVacuouslyTrustedGrokInspection,
} from "../runtime/grok-isolation";

export type BackendDefinitionMetadata = Omit<BackendMetadata, "id"> & { id: string };
export type BackendDefinitionSecurity = {
  outerContainmentRequired: boolean;
  strictAuth: "broker-api-key" | "credential-free";
  disablesProjectConfig: boolean;
  disablesHooks: boolean;
  disablesMcp: boolean;
  disablesSkills: boolean;
  /**
   * The outer read-only project mount plus adapter-specific startup masking
   * prevents project control surfaces from being loaded or created. This does
   * not authorize writable execution.
   */
  isolatesReadOnlyProjectControls?: boolean;
};
export type BackendDefinitionProbeSpec = {
  versionCommand: readonly string[];
  helpCommand: readonly string[];
  requiredHelpFragments: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
  minimumVersion?: string;
};
export type BackendDefinition = {
  id: string;
  metadata: BackendDefinitionMetadata;
  capabilities: BackendCapabilities;
  security: BackendDefinitionSecurity;
  probe: BackendDefinitionProbeSpec;
  stdinPrompt: boolean;
  supportsNamedAgent?: boolean;
  credentialPrefixes: string[];
  provider?: "openai" | "anthropic" | "gemini" | "xai" | null;
  fleetPriority?: number;
  selfSandboxed?: boolean;
  nativeAuth?: { resolveModel: boolean };
  configureWorker?: (worker: WorkerEnvironment, options: { authHomeDir?: string }) => void;
  projectControlPaths?: (projectRoot: string) => string[];
  isolationAttestation?: {
    command: readonly string[];
    timeoutMs: number;
    maxOutputBytes: number;
    validate: (value: unknown) => string | null;
    /**
     * Second phase for backends whose trust attestation is vacuous in a
     * project without trust-gated control surfaces: when `validate` rejects
     * the primary inspection but `validateVacuousPrimary` accepts it, the
     * runner re-runs the same attestation inside `prepareCanaryCwd(worker)`
     * and requires the strict `validate` to pass there.
     */
    vacuousTrustFallback?: {
      validateVacuousPrimary: (value: unknown, projectRoot: string) => string | null;
      prepareCanaryCwd: (worker: WorkerEnvironment) => string;
    };
  };
  managedExecutable?: (homeDir?: string) => unknown | null;
  prepareEnvironment?: (
    env: NodeJS.ProcessEnv,
    context: { worker: WorkerEnvironment; platform: NodeJS.Platform; authMode: ExecOptions["authMode"] },
  ) => void;
  buildEnv?: (env: NodeJS.ProcessEnv, opts?: ExecOptions) => NodeJS.ProcessEnv;
  prepareCommand: (opts: ExecOptions, cwd: string) => string[];
  buildResumeCommand?: (opts: ExecOptions, cwd: string, nativeSessionId: string) => string[];
  decodeOutput: (stdout: string) => JsonParseResult;
};

const builtInBackendDefinitions = {
  opencode: {
    id: "opencode",
    metadata: backendMetadata.opencode,
    capabilities: capabilities({ write: true, tools: true, nativeResume: true }),
    security: hardenedSecurity(),
    probe: probeSpec(
      ["opencode", "--version"],
      ["opencode", "run", "--help"],
      ["--pure", "--format", "--dir", "--model", "--agent", "--session", "--auto"],
      "1.15.3",
    ),
    stdinPrompt: false,
    supportsNamedAgent: true,
    // Single source of truth in opencode.ts (nextOpenCodeEnv uses the same list).
    credentialPrefixes: OPENCODE_CREDENTIAL_PREFIXES,
    provider: null,
    fleetPriority: 5,
    nativeAuth: { resolveModel: true },
    prepareEnvironment: prepareOpenCodeEnvironment,
    buildEnv: nextOpenCodeEnv,
    prepareCommand: buildOpenCodeCommand,
    buildResumeCommand: buildOpenCodeResumeCommand,
    decodeOutput: parseOpenCodeJsonl,
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
    provider: "anthropic",
    fleetPriority: 10,
    nativeAuth: { resolveModel: false },
    prepareEnvironment: prepareClaudeEnvironment,
    prepareCommand: buildClaudeCommand,
    decodeOutput: parseClaudeStreamJson,
  },
  codex: {
    id: "codex",
    metadata: backendMetadata.codex,
    capabilities: capabilities({ write: true, tools: true, nativeResume: true }),
    security: hardenedSecurity(),
    probe: probeSpec(
      ["codex", "--version"],
      ["codex", "exec", "--help"],
      ["--ignore-user-config", "--ignore-rules", "--ephemeral", "read-only", "workspace-write"],
      "0.144.1",
    ),
    stdinPrompt: true,
    credentialPrefixes: ["OPENAI_API_KEY"],
    provider: "openai",
    fleetPriority: 20,
    nativeAuth: { resolveModel: false },
    prepareEnvironment: prepareCodexEnvironment,
    selfSandboxed: true,
    prepareCommand: buildCodexCommand,
    decodeOutput: parseCodexJson,
  },
  "grok-build": {
    id: "grok-build",
    metadata: backendMetadata["grok-build"],
    capabilities: capabilities({ tools: true, nativeResume: true }),
    security: {
      outerContainmentRequired: true,
      strictAuth: "broker-api-key",
      // The isolated config and startup snapshot masks remove every surface
      // present at launch. Grok 0.2.99 additionally requires a contained
      // inspection attestation before provider access; write mode remains
      // fail-closed because Linux cannot mask future glob matches.
      disablesProjectConfig: false,
      disablesHooks: false,
      disablesMcp: false,
      disablesSkills: false,
      isolatesReadOnlyProjectControls: true,
    },
    probe: probeSpec(
      ["grok", "--version"],
      ["grok", "--help"],
      ["--single", "--cwd", "--output-format", "--permission-mode", "--agent", "--no-subagents", "--no-memory", "--disable-web-search", "--verbatim", "--system-prompt-override", "--tools", "inspect"],
      "0.2.99",
    ),
    stdinPrompt: false,
    supportsNamedAgent: true,
    credentialPrefixes: ["XAI_API_KEY"],
    provider: "xai",
    fleetPriority: 0,
    nativeAuth: { resolveModel: false },
    configureWorker: (worker, options) => installGrokIsolation(worker, { homeDir: options.authHomeDir }),
    projectControlPaths: grokProjectControlPaths,
    isolationAttestation: {
      command: ["grok", "inspect", "--json"],
      timeoutMs: 30_000,
      maxOutputBytes: 1_000_000,
      validate: validateGrokIsolationInspection,
      vacuousTrustFallback: {
        validateVacuousPrimary: validateVacuouslyTrustedGrokInspection,
        prepareCanaryCwd: prepareGrokTrustCanary,
      },
    },
    managedExecutable: managedGrokExecutable,
    prepareCommand: buildGrokCommand,
    buildResumeCommand: buildGrokResumeCommand,
    decodeOutput: parseGrokJsonl,
  },
} satisfies Record<Backend, BackendDefinition>;

/** Stable built-in view retained for existing runner consumers. */
export const backendDefinitions: Readonly<Record<Backend, BackendDefinition>> = builtInBackendDefinitions;

const builtInIds = new Set<string>(Object.keys(builtInBackendDefinitions));
const registeredDefinitions = new Map<string, BackendDefinition>(
  Object.values(builtInBackendDefinitions).map((adapter) => [adapter.id, adapter]),
);

export function registerBackendDefinition(adapter: BackendDefinition, opts: { replace?: boolean } = {}) {
  validateBackendDefinition(adapter);
  const existing = registeredDefinitions.get(adapter.id);
  if (builtInIds.has(adapter.id)) {
    throw new Error(`Cannot replace built-in backend definition: ${adapter.id}`);
  }
  if (existing && !opts.replace) {
    throw new Error(`Backend definition already registered: ${adapter.id}`);
  }
  registeredDefinitions.set(adapter.id, adapter);
  return adapter;
}

export function unregisterBackendDefinition(id: string) {
  if (builtInIds.has(id)) return false;
  return registeredDefinitions.delete(id);
}

export function getBackendDefinition(id: string) {
  return registeredDefinitions.get(id);
}

/** Resolve aliases for built-ins and preserve exact registered extension IDs. */
export function resolveBackendId(input: string) {
  try {
    return normalizeBackend(input);
  } catch {
    if (registeredDefinitions.has(input)) return input;
    throw new Error(`Unsupported backend: ${input}`);
  }
}

export function listBackendDefinitions() {
  return [...registeredDefinitions.values()];
}

export function assertModeAllowed(backend: Backend | string, mode: ExecOptions["mode"] = "read-only") {
  const id = resolveBackendId(backend);
  const adapter = getBackendDefinition(id);
  if (!adapter) throw new Error(`Backend ${backend} is not registered.`);
  if (mode === "write" && !adapter.metadata.canWrite) {
    throw new Error(`Backend ${backend} does not support write mode in Headless yet.`);
  }
}

/** Security capabilities that required outer containment cannot replace. */
export function requiredContainmentSecurityGaps(adapter: BackendDefinition, mode?: ExecOptions["mode"]) {
  const gaps: string[] = [];
  if (!adapter.security.outerContainmentRequired) gaps.push("outer containment authority");
  if (mode === "read-only" && adapter.security.isolatesReadOnlyProjectControls) return gaps;
  if (!adapter.security.disablesProjectConfig) gaps.push("project configuration");
  if (!adapter.security.disablesHooks) gaps.push("startup hooks");
  if (!adapter.security.disablesMcp) gaps.push("project MCP servers");
  if (!adapter.security.disablesSkills) gaps.push("project skills");
  return gaps;
}

export function buildBackendEnv(adapter: BackendDefinition, env: NodeJS.ProcessEnv = process.env) {
  return adapter.buildEnv ? adapter.buildEnv(env) : buildAdapterEnv(env, adapter.credentialPrefixes);
}

function capabilities(overrides: Partial<BackendCapabilities> = {}): BackendCapabilities {
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

function hardenedSecurity(): BackendDefinitionSecurity {
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
): BackendDefinitionProbeSpec {
  return { versionCommand, helpCommand, requiredHelpFragments, timeoutMs: 5_000, maxOutputBytes: 262_144, minimumVersion };
}

export function validateBackendDefinition(adapter: BackendDefinition) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(adapter.id)) {
    throw new Error(`Invalid backend definition id: ${adapter.id}`);
  }
  if (adapter.metadata.id !== adapter.id) {
    throw new Error(`Backend definition metadata id mismatch: ${adapter.metadata.id} !== ${adapter.id}`);
  }
  if (adapter.capabilities.write !== adapter.metadata.canWrite) {
    throw new Error(`Backend definition write capability mismatch for ${adapter.id}`);
  }
  if (!adapter.security || !adapter.probe) {
    throw new Error(`Backend definition ${adapter.id} must declare security and probe metadata.`);
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
    throw new Error(`Backend definition ${adapter.id} has invalid probe limits.`);
  }
  if (typeof adapter.prepareCommand !== "function" || typeof adapter.decodeOutput !== "function") {
    throw new Error(`Backend definition ${adapter.id} must provide prepareCommand and decodeOutput functions.`);
  }
  if (adapter.capabilities.nativeResume && typeof adapter.buildResumeCommand !== "function") {
    throw new Error(`Backend definition ${adapter.id} declares native resume without a tested resume command implementation.`);
  }
}

function prepareOpenCodeEnvironment(env: NodeJS.ProcessEnv) {
  env.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
  env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1";
  env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "1";
  env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = "1";
}

function prepareClaudeEnvironment(
  env: NodeJS.ProcessEnv,
  context: { worker: WorkerEnvironment; authMode: ExecOptions["authMode"] },
) {
  env.CLAUDE_CODE_TMPDIR = context.worker.temp;
  if (context.authMode !== "native-login") return;
  const setupToken = context.worker.credentialEnv[CLAUDE_SETUP_TOKEN_ENV];
  if (setupToken) env[CLAUDE_SETUP_TOKEN_ENV] = setupToken;
}

function prepareCodexEnvironment(env: NodeJS.ProcessEnv, context: { platform: NodeJS.Platform }) {
  if (context.platform !== "darwin") return;
  env.SSL_CERT_FILE = "/etc/ssl/cert.pem";
  env.SSL_CERT_DIR = "/etc/ssl/certs";
}
