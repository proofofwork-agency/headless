import type { ExecOptions } from "../index";
import { GROK_HEADLESS_SYSTEM_PROMPT, GROK_READ_TOOLS, GROK_WRITE_TOOLS } from "../runtime/grok-isolation";
import { GROK_BUILTIN_AGENT_NAMES, safeAgentName, safeOption } from "../runtime/validation";
import { grokStopReasonFailed } from "../runtime/grok-stop-reason";
import {
  appendText,
  collectText,
  emptyTokenUsage,
  formatError,
  legacyTokenCount,
  mergeTokenUsage,
  normalizeTokenUsage,
  numberValue,
  objectValue,
  parseJsonValuesDetailed,
  stringValue,
  textCollector,
  type NormalizedTokenUsage,
  type ParserDiagnostics,
} from "./json";

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
  usage: NormalizedTokenUsage;
  diagnostics: ParserDiagnostics;
};

const AGENTS: Record<typeof GROK_BUILTIN_AGENT_NAMES[number], GrokAgentInfo> = {
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

export function buildGrokCommand(opts: ExecOptions, cwd: string, nativeSessionId?: string) {
  const cmd = ["grok", "--single", opts.prompt, "--cwd", cwd, "--output-format", "streaming-json"];
  if (nativeSessionId) {
    cmd.push("--resume", safeOption(nativeSessionId, "native session id", { namespace: "Grok" }));
  }
  if (opts.model) {
    cmd.push("--model", safeOption(opts.model, "model", { namespace: "Grok" }));
  }
  if (opts.agent) {
    cmd.push("--agent", safeAgentName(opts.agent, "Grok"));
  }
  // The isolated HOME contains authentication only. Disable every optional
  // native collaboration/configuration surface that Grok exposes directly;
  // outer containment remains the filesystem and network authority.
  cmd.push(
    "--no-subagents",
    "--no-memory",
    "--disable-web-search",
    "--verbatim",
    "--system-prompt-override",
    GROK_HEADLESS_SYSTEM_PROMPT,
    "--tools",
    opts.mode === "write" ? GROK_WRITE_TOOLS : GROK_READ_TOOLS,
  );
  const permissionMode = opts.approvalPolicy === "bypass"
    ? "bypassPermissions"
    : opts.approvalPolicy === "auto"
      ? "auto"
      : opts.mode === "read-only" ? "plan" : "default";
  cmd.push("--permission-mode", permissionMode);
  return cmd;
}

export function buildGrokResumeCommand(opts: ExecOptions, cwd: string, nativeSessionId: string) {
  return buildGrokCommand(opts, cwd, nativeSessionId);
}

export function parseGrokJsonl(stdout: string): GrokJsonParseResult {
  const text = textCollector();
  const errors: string[] = [];
  let cost = 0;
  let sawCost = false;
  let normalizedUsage = emptyTokenUsage();
  const parsed = parseJsonValuesDetailed(stdout, "grok-streaming-json");

  for (const event of parsed.values) {
    const outputCount = text.length;
    const errorCount = errors.length;
    if (event.type === "text") {
      const delta = stringValue(event.data);
      if (delta) appendText(text, delta);
    } else if (event.type === "max_turns_reached") {
      // grok-build emits this then bails with exit 1 (headless.rs:1313-1318).
      errors.push("Grok reached its maximum turn limit before completing the turn.");
    } else if (event.type === "end") {
      const stopReason = stringValue(event.stop_reason) ?? stringValue(event.stopReason);
      if (grokStopReasonFailed(stopReason)) {
        errors.push(`Grok ended the turn without completion${stopReason ? ` (${stopReason})` : ""}.`);
      }
      collectText(event, text);
    } else if (event.type !== "error" && event.type !== "thought") {
      collectText(event, text);
    }

    const message = formatError(event.error) ?? (event.type === "error" ? String(event.message || "") : null);
    if (event.type === "error" && message) errors.push(message);

    const usage = objectValue(event.usage) ?? objectValue(event.token_usage);
    const eventUsage = firstUsage(usage, event.tokens);
    if (eventUsage) normalizedUsage = mergeTokenUsage(normalizedUsage, eventUsage);

    const costValue = numberValue(event.cost) ?? numberValue(event.total_cost_usd);
    if (costValue !== null) {
      sawCost = true;
      cost += costValue;
    }

    if (text.length === outputCount && errors.length === errorCount && costValue === null && !eventUsage) {
      parsed.diagnostics.ignoredEvents += 1;
    }
  }

  return {
    output: text.join("").trim(),
    cost: sawCost ? cost : null,
    tokens: legacyTokenCount(normalizedUsage),
    error: errors.length ? errors.join("\n") : null,
    usage: normalizedUsage,
    diagnostics: parsed.diagnostics,
  };
}

function firstUsage(...values: unknown[]): NormalizedTokenUsage | null {
  for (const value of values) {
    const usage = normalizeTokenUsage(value);
    if (Object.values(usage).some((entry) => entry !== null)) return usage;
  }
  return null;
}
