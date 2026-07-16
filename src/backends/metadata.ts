import type { Backend } from "./ids";
import { getBackendAliases, SUPPORTED_BACKENDS } from "./ids";

export type BackendMetadata = {
  id: Backend;
  aliases: string[];
  promptDelivery: "argv" | "stdin" | "native";
  timeoutMs: number;
  maxDepth: number | null;
  canRead: boolean;
  canWrite: boolean;
  nativeResume: boolean;
  login?: {
    displayName: string;
    argv?: [string, ...string[]];
    instructions: string;
    interactive: boolean;
    brokerMode: boolean;
  };
};

export const backendMetadata: Record<Backend, BackendMetadata> = {
  opencode: {
    id: "opencode",
    aliases: [...getBackendAliases("opencode")],
    promptDelivery: "argv",
    timeoutMs: 180_000,
    maxDepth: 2,
    canRead: true,
    canWrite: true,
    nativeResume: true,
    login: { displayName: "OpenCode", argv: ["opencode", "auth", "login"], instructions: "Run `opencode auth login`, then refresh Fleet health.", interactive: true, brokerMode: true },
  },
  "claude-code": {
    id: "claude-code",
    aliases: [...getBackendAliases("claude-code")],
    promptDelivery: "stdin",
    timeoutMs: 180_000,
    maxDepth: null,
    canRead: true,
    canWrite: true,
    nativeResume: false,
    login: { displayName: "Claude Code", argv: ["claude", "auth", "login"], instructions: "Run `claude auth login`. Headless requires supported regular-file login state; broker mode is also available.", interactive: true, brokerMode: true },
  },
  codex: {
    id: "codex",
    aliases: [...getBackendAliases("codex")],
    promptDelivery: "stdin",
    timeoutMs: 180_000,
    maxDepth: null,
    canRead: true,
    canWrite: true,
    nativeResume: true,
    login: { displayName: "Codex", argv: ["codex", "login"], instructions: "Run `codex login`, then refresh Fleet health.", interactive: true, brokerMode: true },
  },
  "grok-build": {
    id: "grok-build",
    aliases: [...getBackendAliases("grok-build")],
    promptDelivery: "native",
    timeoutMs: 180_000,
    maxDepth: null,
    canRead: true,
    canWrite: false,
    nativeResume: true,
    login: { displayName: "Grok Build", argv: ["grok", "login"], instructions: "Run `grok login` (browser OAuth) or `grok login --device-auth` on a display-less host, then refresh Fleet health.", interactive: true, brokerMode: true },
  },
};

// Ensure all supported are covered at runtime (central alias source drives this).
for (const b of SUPPORTED_BACKENDS) {
  if (!backendMetadata[b]) throw new Error(`Missing metadata for backend ${b}`);
}
