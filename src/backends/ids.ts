export type Backend = "claude-code" | "codex" | "grok-build" | "opencode";

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
