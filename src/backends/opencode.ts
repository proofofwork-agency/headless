import type { ExecOptions } from "../index";
import { collectText, formatError, numberValue, objectValue, tokenCount } from "./json";

export type OpenCodeJsonlParseResult = {
  output: string;
  cost: number | null;
  tokens: number | null;
  error: string | null;
};

export function buildOpenCodeCommand(opts: ExecOptions, cwd: string) {
  const cmd = ["opencode", "run", "--pure", "--format", "json", "--dir", cwd];
  if (opts.model) {
    cmd.push("--model", opts.model);
  }
  if (opts.agent) {
    cmd.push("--agent", opts.agent);
  }
  cmd.push(opts.prompt);
  return cmd;
}

export function nextOpenCodeEnv(env: NodeJS.ProcessEnv = process.env) {
  const currentDepth = Number.parseInt(env.HEADLESS_DEPTH || "0", 10);
  const depth = Number.isFinite(currentDepth) ? currentDepth : 0;
  if (depth > 1) {
    throw new Error(`Refusing to spawn OpenCode backend at HEADLESS_DEPTH=${depth}`);
  }
  return {
    ...env,
    HEADLESS_PARENT_BACKEND: "opencode",
    HEADLESS_DEPTH: String(depth + 1),
  };
}

export function parseOpenCodeJsonl(stdout: string): OpenCodeJsonlParseResult {
  const output: string[] = [];
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
      output.push(trimmed);
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
