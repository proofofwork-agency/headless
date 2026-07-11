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
  },
  "claude-code": {
    id: "claude-code",
    aliases: [...getBackendAliases("claude-code")],
    promptDelivery: "stdin",
    timeoutMs: 180_000,
    maxDepth: null,
    canRead: true,
    canWrite: true,
  },
  codex: {
    id: "codex",
    aliases: [...getBackendAliases("codex")],
    promptDelivery: "stdin",
    timeoutMs: 180_000,
    maxDepth: null,
    canRead: true,
    canWrite: true,
  },
  "grok-build": {
    id: "grok-build",
    aliases: [...getBackendAliases("grok-build")],
    promptDelivery: "native",
    timeoutMs: 180_000,
    maxDepth: null,
    canRead: true,
    canWrite: true,
  },
};

// Ensure all supported are covered at runtime (central alias source drives this).
for (const b of SUPPORTED_BACKENDS) {
  if (!backendMetadata[b]) throw new Error(`Missing metadata for backend ${b}`);
}
