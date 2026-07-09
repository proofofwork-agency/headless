import type { Backend } from "./ids";

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
    aliases: ["headless-opencode"],
    promptDelivery: "argv",
    timeoutMs: 180_000,
    maxDepth: 2,
    canRead: true,
    canWrite: false,
  },
  "claude-code": {
    id: "claude-code",
    aliases: ["claude"],
    promptDelivery: "stdin",
    timeoutMs: 180_000,
    maxDepth: null,
    canRead: true,
    canWrite: false,
  },
  codex: {
    id: "codex",
    aliases: ["codex-cli"],
    promptDelivery: "stdin",
    timeoutMs: 180_000,
    maxDepth: null,
    canRead: true,
    canWrite: false,
  },
  "grok-build": {
    id: "grok-build",
    aliases: ["grok"],
    promptDelivery: "native",
    timeoutMs: 180_000,
    maxDepth: null,
    canRead: true,
    canWrite: true,
  },
};
