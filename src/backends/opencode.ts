import type { ExecOptions } from "../index";
import { buildAdapterEnv } from "./env";
import { appendText, collectText, formatError, numberValue, objectValue, textCollector, tokenCount } from "./json";

export type OpenCodeJsonlParseResult = {
  output: string;
  cost: number | null;
  tokens: number | null;
  error: string | null;
};

export const OPENCODE_READ_ONLY_CONFIG = {
  tools: {
    read: true,
    glob: true,
    grep: true,
    list: true,
    bash: false,
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
    bash: { "*": "deny" },
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

export const OPENCODE_CONFIG_CONTENT = JSON.stringify(OPENCODE_READ_ONLY_CONFIG);

export function buildOpenCodeCommand(opts: ExecOptions, cwd: string) {
  const cmd = ["opencode", "run", "--pure", "--format", "json", "--dir", cwd];
  if (opts.model) {
    cmd.push("--model", opts.model);
  }
  if (opts.agent) {
    cmd.push("--agent", opts.agent);
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
  "OPENCODE_API_KEY", "ANTHROPIC_", "OPENAI_", "XAI_", "GEMINI_", "OPENROUTER_",
  "ZHIPU_", "ZAI_", "GROQ_", "DEEPSEEK_", "MISTRAL_", "DASHSCOPE_",
  // Google is scoped to the actual credential vars rather than the broad
  // "GOOGLE_" prefix, which would over-match unrelated GOOGLE_* env.
  "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GOOGLE_GENAI",
];

export function nextOpenCodeEnv(env: NodeJS.ProcessEnv = process.env) {
  const currentDepth = Number.parseInt(env.HEADLESS_DEPTH || "0", 10);
  const depth = Number.isFinite(currentDepth) ? currentDepth : 0;
  if (depth > 1) {
    throw new Error(`Refusing to spawn OpenCode backend at HEADLESS_DEPTH=${depth}`);
  }
  return {
    ...buildAdapterEnv(env, OPENCODE_CREDENTIAL_PREFIXES),
    HEADLESS_PARENT_BACKEND: "opencode",
    HEADLESS_DEPTH: String(depth + 1),
    OPENCODE_CONFIG_CONTENT,
  };
}

export function parseOpenCodeJsonl(stdout: string): OpenCodeJsonlParseResult {
  const output = textCollector();
  const errors: string[] = [];
  let cost = 0;
  let tokens = 0;
  let sawCost = false;
  let sawTokens = false;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      appendText(output, trimmed);
      continue;
    }

    const part = objectValue(event.part) ?? event;
    collectText(part, output);

    if (event.type === "error" || event.type === "session.error") {
      const props = objectValue(event.properties);
      const message = formatError(event.error) ?? formatError(props?.error);
      if (message) errors.push(message);
    }

    const props = objectValue(event.properties);
    const propPart = objectValue(props?.part);
    if (propPart) collectCompletedText(propPart, output);

    const costValue = numberValue(part.cost) ?? numberValue(propPart?.cost) ?? numberValue(event.cost);
    if (costValue !== null) {
      sawCost = true;
      cost += costValue;
    }

    const tokenValue = tokenCount(part.tokens) ?? tokenCount(propPart?.tokens) ?? tokenCount(event.tokens);
    if (tokenValue !== null) {
      sawTokens = true;
      tokens += tokenValue;
    }
  }

  return {
    output: output.join("\n").trim(),
    cost: sawCost ? cost : null,
    tokens: sawTokens ? tokens : null,
    error: errors.length ? errors.join("\n") : null,
  };
}

function collectCompletedText(part: Record<string, unknown>, output: string[]) {
  if (part.type === "text" && objectValue(part.time)?.end) {
    collectText(part, output);
  }
}
