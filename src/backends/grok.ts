import type { ExecOptions } from "../index";
import { collectText, formatError, numberValue, objectValue, parseJsonValues, tokenCount } from "./json";

export interface GrokAgentInfo {
  name: string;
  description?: string;
  mode: "plan" | "build" | "review" | "general" | "all";
  systemPrompt?: string;
}

export type GrokJsonParseResult = {
  output: string;
  cost: number | null;
  tokens: number | null;
  error: string | null;
};

const AGENTS: Record<string, GrokAgentInfo> = {
  plan: {
    name: "plan",
    description: "Read-only planning agent.",
    mode: "plan",
  },
  build: {
    name: "build",
    description: "Primary coding agent.",
    mode: "build",
  },
  review: {
    name: "review",
    description: "Read-only reviewer.",
    mode: "review",
  },
  general: {
    name: "general",
    description: "General-purpose agent.",
    mode: "general",
  },
};

export function getGrokAgents(): GrokAgentInfo[] {
  return Object.values(AGENTS);
}

export function buildGrokCommand(opts: ExecOptions, cwd: string) {
  const cmd = ["grok", "--single", opts.prompt, "--cwd", cwd, "--output-format", "streaming-json"];
  if (opts.model) {
    cmd.push("--model", opts.model);
  }
  if (opts.agent) {
    cmd.push("--agent", opts.agent);
  }
  if (opts.mode === "read-only") {
    cmd.push("--permission-mode", "plan");
  }
  return cmd;
}

export function parseGrokJsonl(stdout: string): GrokJsonParseResult {
  const text: string[] = [];
  const errors: string[] = [];
  let cost = 0;
  let tokens = 0;
  let sawCost = false;
  let sawTokens = false;

  for (const event of parseJsonValues(stdout)) {
    if (event.type !== "error") collectText(event, text);

    const message = formatError(event.error) ?? (event.type === "error" ? String(event.message || "") : null);
    if (event.type === "error" && message) errors.push(message);

    const usage = objectValue(event.usage) ?? objectValue(event.token_usage);
    const tokenValue = tokenCount(usage) ?? tokenCount(event.tokens);
    if (tokenValue !== null) {
      sawTokens = true;
      tokens += tokenValue;
    }

    const costValue = numberValue(event.cost) ?? numberValue(event.total_cost_usd);
    if (costValue !== null) {
      sawCost = true;
      cost += costValue;
    }
  }

  return {
    output: text.join("").trim(),
    cost: sawCost ? cost : null,
    tokens: sawTokens ? tokens : null,
    error: errors.length ? errors.join("\n") : null,
  };
}
