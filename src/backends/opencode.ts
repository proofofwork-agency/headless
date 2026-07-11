import type { ExecOptions } from "../index";
import { safeAgentName, safeOption } from "../runtime/validation";
import { buildAdapterEnv } from "./env";
import {
  collectText,
  emptyTokenUsage,
  formatError,
  legacyTokenCount,
  mergeTokenUsage,
  normalizeTokenUsage,
  numberValue,
  objectValue,
  parseJsonValuesDetailed,
  textCollector,
  type NormalizedTokenUsage,
  type ParserDiagnostics,
} from "./json";

export type OpenCodeJsonlParseResult = {
  output: string;
  cost: number | null;
  tokens: number | null;
  error: string | null;
  usage: NormalizedTokenUsage;
  diagnostics: ParserDiagnostics;
};

export const OPENCODE_READ_ONLY_CONFIG = {
  tools: {
    read: true,
    glob: true,
    grep: true,
    list: true,
    // Shell access is safe only because the outer sandbox is authoritative.
    // It also makes the daemon-owned `headless-run-tool` helper callable in
    // read mode without enabling project MCP/configuration surfaces.
    bash: true,
    edit: false,
    write: false,
    patch: false,
    todowrite: false,
    task: false,
    webfetch: false,
    websearch: false,
    skill: false,
    lsp: false,
    external_directory: false,
  },
  permission: {
    "*": "deny",
    read: "allow",
    glob: "allow",
    grep: "allow",
    list: "allow",
    bash: { "*": "allow" },
    edit: "deny",
    write: "deny",
    patch: "deny",
    todowrite: "deny",
    task: "deny",
    webfetch: "deny",
    websearch: "deny",
    skill: "deny",
    lsp: "deny",
    external_directory: "deny",
  },
} as const;

export const OPENCODE_WRITE_CONFIG = {
  tools: {
    read: true,
    glob: true,
    grep: true,
    list: true,
    bash: true,
    edit: true,
    write: true,
    patch: true,
    todowrite: false,
    task: false,
    webfetch: false,
    websearch: false,
    skill: false,
    lsp: false,
    external_directory: false,
  },
  permission: {
    "*": "deny",
    read: "allow",
    glob: "allow",
    grep: "allow",
    list: "allow",
    bash: { "*": "allow" },
    edit: "allow",
    write: "allow",
    patch: "allow",
    todowrite: "deny",
    task: "deny",
    webfetch: "deny",
    websearch: "deny",
    skill: "deny",
    lsp: "deny",
    external_directory: "deny",
  },
} as const;

export const OPENCODE_CONFIG_CONTENT = JSON.stringify(OPENCODE_READ_ONLY_CONFIG);

export function openCodeConfigContent(mode: ExecOptions["mode"] = "read-only") {
  return JSON.stringify(mode === "write" ? OPENCODE_WRITE_CONFIG : OPENCODE_READ_ONLY_CONFIG);
}

export function buildOpenCodeCommand(opts: ExecOptions, cwd: string) {
  const cmd = ["opencode", "run", "--pure", "--format", "json", "--dir", cwd];
  if (opts.model) {
    cmd.push("--model", safeOption(opts.model, "model", { namespace: "OpenCode" }));
  }
  if (opts.agent) {
    cmd.push("--agent", safeAgentName(opts.agent, "OpenCode"));
  }
  if (opts.approvalPolicy === "auto" || opts.approvalPolicy === "bypass") {
    cmd.push("--dangerously-skip-permissions");
  }
  // `--` ends flag parsing: without it, a prompt that begins with a flag (e.g.
  // "--dangerously-skip-permissions") would be parsed by opencode as an argument
  // rather than the message. Everything after `--` is the positional prompt.
  cmd.push("--", opts.prompt);
  return cmd;
}

// opencode is multi-provider and auto-detects <PROVIDER>_API_KEY env vars.
// The names come from the models.dev catalog and are NOT always <NAME>_API_KEY —
// notably z.ai / GLM ("zai", "zai-coding-plan") use ZHIPU_API_KEY. Forward the
// common provider key prefixes so env-based auth works under --pure.
//
// SECURITY: forward only the OpenCode *credential* (OPENCODE_API_KEY), NOT the
// broad "OPENCODE_" prefix. Control-plane vars like OPENCODE_PERMISSION,
// OPENCODE_CONFIG, OPENCODE_CONFIG_DIR, OPENCODE_AUTH_CONTENT, and
// OPENCODE_DISABLE_* are applied by opencode and could override our injected
// read-only denies — a caller must never be able to set them through Headless.
export const OPENCODE_CREDENTIAL_PREFIXES = [
  "OPENCODE_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "XAI_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "ZHIPU_API_KEY",
  "ZAI_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
  "DASHSCOPE_API_KEY",
  "GOOGLE_API_KEY",
];

export function nextOpenCodeEnv(env: NodeJS.ProcessEnv = process.env, opts: Pick<ExecOptions, "mode"> = {}) {
  const currentDepth = Number.parseInt(env.HEADLESS_DEPTH || "0", 10);
  const depth = Number.isFinite(currentDepth) ? currentDepth : 0;
  if (depth > 1) {
    throw new Error(`Refusing to spawn OpenCode backend at HEADLESS_DEPTH=${depth}`);
  }
  return {
    ...buildAdapterEnv(env, OPENCODE_CREDENTIAL_PREFIXES),
    HEADLESS_PARENT_BACKEND: "opencode",
    HEADLESS_DEPTH: String(depth + 1),
    OPENCODE_CONFIG_CONTENT: openCodeConfigContent(opts.mode),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
  };
}

export function parseOpenCodeJsonl(stdout: string): OpenCodeJsonlParseResult {
  const output = textCollector();
  const errors: string[] = [];
  let cost = 0;
  let sawCost = false;
  let usage = emptyTokenUsage();
  const parsed = parseJsonValuesDetailed(stdout, "opencode-jsonl");

  for (const event of parsed.values) {
    const outputCount = output.length;
    const errorCount = errors.length;
    const topPart = objectValue(event.part);
    const props = objectValue(event.properties);
    const propPart = objectValue(props?.part);
    // OpenCode can mirror the same part at the top level and under properties.
    // Select one canonical representation instead of globally deduplicating text,
    // which would incorrectly erase legitimate repeated delta events.
    const part = isCompletedPart(propPart) ? propPart : topPart ?? (propPart ? null : event);
    if (part) collectText(part, output);

    if (event.type === "error" || event.type === "session.error") {
      const message = formatError(event.error) ?? formatError(props?.error);
      if (message) errors.push(message);
    }

    const costValue = numberValue(part?.cost) ?? numberValue(propPart?.cost) ?? numberValue(event.cost);
    if (costValue !== null) {
      sawCost = true;
      cost += costValue;
    }

    const eventUsage = firstUsage(part?.tokens, propPart?.tokens, event.tokens, event.usage);
    if (eventUsage) {
      usage = mergeTokenUsage(usage, eventUsage);
    }

    if (output.length === outputCount && errors.length === errorCount && costValue === null && !eventUsage) {
      parsed.diagnostics.ignoredEvents += 1;
    }
  }

  if (parsed.diagnostics.malformedEvents > 0) {
    errors.push(`Malformed OpenCode JSONL: rejected ${parsed.diagnostics.malformedEvents} event${parsed.diagnostics.malformedEvents === 1 ? "" : "s"}.`);
  }

  return {
    output: output.join("\n").trim(),
    cost: sawCost ? cost : null,
    tokens: legacyTokenCount(usage),
    error: errors.length ? errors.join("\n") : null,
    usage,
    diagnostics: parsed.diagnostics,
  };
}

function isCompletedPart(part: Record<string, unknown> | null): part is Record<string, unknown> {
  return !!part && part.type === "text" && !!objectValue(part.time)?.end;
}

function firstUsage(...values: unknown[]): NormalizedTokenUsage | null {
  for (const value of values) {
    const usage = normalizeTokenUsage(value);
    if (Object.values(usage).some((entry) => entry !== null)) return usage;
  }
  return null;
}
