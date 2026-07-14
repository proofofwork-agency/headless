export const SUPPORTED_BACKENDS = ["opencode", "claude-code", "codex", "grok-build"] as const;
export type Backend = (typeof SUPPORTED_BACKENDS)[number];

// Single source of truth for aliases (alias or input -> canonical backend).
// Used by normalize + choices (for CLI help/errors) + metadata.
const BACKEND_ALIASES = {
  "claude-code": "claude-code",
  claude: "claude-code",
  codex: "codex",
  "codex-cli": "codex",
  "grok-build": "grok-build",
  grok: "grok-build",
  opencode: "opencode",
  "headless-opencode": "opencode",
} as const satisfies Record<string, Backend>;

// Canonical aliases lists (for metadata/docs, derived from the map above for centralization).
const ALIASES_BY_BACKEND: Record<Backend, readonly string[]> = {
  opencode: ["headless-opencode"],
  "claude-code": ["claude"],
  codex: ["codex-cli"],
  "grok-build": ["grok"],
};

export type BackendInput = keyof typeof BACKEND_ALIASES | Backend;

export function normalizeBackend(input: string): Backend {
  const backend = BACKEND_ALIASES[input as keyof typeof BACKEND_ALIASES];
  if (!backend) {
    throw new Error(`Unsupported backend: ${input}`);
  }
  return backend;
}

export function backendChoices() {
  return Object.keys(BACKEND_ALIASES);
}

export function getBackendAliases(backend: Backend): readonly string[] {
  return ALIASES_BY_BACKEND[backend] ?? [];
}

export { SUPPORTED_BACKENDS as backends };
