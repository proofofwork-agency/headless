export type JsonParseResult = {
  output: string;
  cost: number | null;
  tokens: number | null;
  error: string | null;
};

export function parseGenericAgentJson(stdout: string): JsonParseResult {
  const output = textCollector();
  const errors: string[] = [];
  let cost = 0;
  let tokens = 0;
  let sawCost = false;
  let sawTokens = false;

  for (const event of parseJsonValues(stdout)) {
    collectText(event, output);

    const error = formatError(event.error) ?? (event.type === "error" ? stringValue(event.message) : null);
    if (error) errors.push(error);

    const costValue = numberValue(event.cost) ?? numberValue(event.total_cost_usd);
    if (costValue !== null) {
      sawCost = true;
      cost += costValue;
    }

    const tokenValue = tokenCount(event.usage) ?? tokenCount(event.tokens);
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

export function parseClaudeStreamJson(stdout: string): JsonParseResult {
  const output = textCollector();
  const errors: string[] = [];
  let finalResult: string | null = null;
  let cost = 0;
  let tokens = 0;
  let sawCost = false;
  let sawTokens = false;

  for (const event of parseJsonValues(stdout)) {
    if (event.type === "assistant") {
      collectText(event.message, output);
    }

    if (event.type === "result") {
      finalResult = stringValue(event.result) ?? finalResult;
      if (event.is_error === true || event.subtype === "error") {
        const message = stringValue(event.result) ?? stringValue(event.error) ?? stringValue(event.subtype);
        if (message) errors.push(message);
      }
    }

    const error = formatError(event.error) ?? (event.type === "error" ? stringValue(event.message) : null);
    if (error) errors.push(error);

    const costValue = numberValue(event.cost) ?? numberValue(event.total_cost_usd);
    if (costValue !== null) {
      sawCost = true;
      cost += costValue;
    }

    const tokenValue = tokenCount(event.usage) ?? tokenCount(event.tokens);
    if (tokenValue !== null) {
      sawTokens = true;
      tokens += tokenValue;
    }
  }

  return {
    output: (output.join("\n").trim() || finalResult || "").trim(),
    cost: sawCost ? cost : null,
    tokens: sawTokens ? tokens : null,
    error: errors.length ? errors.join("\n") : null,
  };
}

export function parseCodexJson(stdout: string): JsonParseResult {
  const output = textCollector();
  const errors: string[] = [];
  let cost = 0;
  let tokens = 0;
  let sawCost = false;
  let sawTokens = false;

  for (const event of parseJsonValues(stdout)) {
    if (event.type === "item.completed") {
      const item = objectValue(event.item);
      if (item?.type === "agent_message") {
        const text = stringValue(item.text) ?? stringValue(item.message);
        if (text) appendText(output, text);
      }
      if (item?.type === "error") {
        const message = formatError(item.error) ?? stringValue(item.message) ?? stringValue(item.text) ?? "Codex item failed.";
        errors.push(message);
      }
    }

    // Backward-compatible local fixture shape used before Codex 0.143.0's
    // item.completed envelope was captured from a live run.
    if (event.type === "agent_message") {
      const text = stringValue(event.text) ?? stringValue(event.message);
      if (text) appendText(output, text);
    }

    if (event.type === "turn.failed") {
      const message = formatError(event.error) ?? stringValue(event.message) ?? "Codex turn failed.";
      errors.push(message);
    }

    const error = formatError(event.error) ?? (event.type === "error" ? stringValue(event.message) : null);
    if (error) errors.push(error);

    const costValue = numberValue(event.cost) ?? numberValue(event.total_cost_usd);
    if (costValue !== null) {
      sawCost = true;
      cost += costValue;
    }

    const tokenValue = tokenCount(event.usage) ?? tokenCount(event.tokens);
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

export function parseJsonValues(stdout: string) {
  const values: Record<string, unknown>[] = [];
  const trimmed = stdout.trim();
  if (!trimmed) return values;

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.flatMap((item) => {
        const record = objectValue(item);
        return record ? [record] : [];
      });
    }
    const record = objectValue(parsed);
    return record ? [record] : values;
  } catch {}

  for (const line of stdout.split("\n")) {
    const next = line.trim();
    if (!next) continue;
    try {
      const record = objectValue(JSON.parse(next));
      if (record) values.push(record);
    } catch {}
  }

  return values;
}

export function collectText(value: unknown, output: string[]) {
  if (typeof value === "string") {
    appendText(output, value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectText(item, output);
    return;
  }

  const record = objectValue(value);
  if (!record) return;

  if (record.type === "error") return;

  for (const key of ["text", "content", "delta", "output_text", "result"] as const) {
    const next = stringValue(record[key]);
    if (next) appendText(output, next);
  }

  for (const key of ["part", "message", "response", "output"] as const) {
    collectText(record[key], output);
  }
  if (typeof record.content !== "string") {
    collectText(record.content, output);
  }
}

export function objectValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function tokenCount(value: unknown): number | null {
  const direct = numberValue(value);
  if (direct !== null) return direct;

  const record = objectValue(value);
  if (!record) return null;

  const explicitTotal = numberValue(record.total_tokens);
  if (explicitTotal !== null) return explicitTotal;

  let total = 0;
  let saw = false;
  for (const key of ["input", "output", "reasoning", "input_tokens", "output_tokens", "reasoning_tokens", "reasoning_output_tokens"] as const) {
    const count = numberValue(record[key]);
    if (count !== null) {
      saw = true;
      total += count;
    }
  }

  return saw ? total : null;
}

export function formatError(value: unknown): string | null {
  if (typeof value === "string") return value;
  const error = objectValue(value);
  if (!error) return null;

  const data = objectValue(error.data);
  return (
    stringValue(data?.message) ??
    stringValue(error.message) ??
    stringValue(error.name)
  );
}

export function textCollector(): string[] {
  return Object.assign([], { seen: new Set<string>() }) as string[] & { seen: Set<string> };
}

export function appendText(output: string[], value: string) {
  if (!value.trim()) return;
  const maybeSeen = (output as string[] & { seen?: Set<string> }).seen;
  if (maybeSeen) {
    if (maybeSeen.has(value)) return;
    maybeSeen.add(value);
  }
  output.push(value);
}
