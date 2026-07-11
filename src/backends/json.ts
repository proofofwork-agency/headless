import { safeJsonParse } from "../runtime/safe-json";

export type JsonParseResult = {
  output: string;
  cost: number | null;
  tokens: number | null;
  error: string | null;
  /** Structured usage remains lossless; `tokens` is the legacy aggregate. */
  usage?: NormalizedTokenUsage;
  diagnostics?: ParserDiagnostics;
};

export type NormalizedTokenUsage = {
  input: number | null;
  output: number | null;
  reasoning: number | null;
  cached: number | null;
  providerTotal: number | null;
};

export type ParserDiagnostics = {
  format: string;
  malformedEvents: number;
  ignoredEvents: number;
  messages: string[];
};

export type ParsedJsonValues = {
  values: Record<string, unknown>[];
  diagnostics: ParserDiagnostics;
};

export function parseGenericAgentJson(stdout: string): JsonParseResult {
  const output = textCollector();
  const errors: string[] = [];
  let cost = 0;
  let sawCost = false;
  let usage = emptyTokenUsage();
  const parsed = parseJsonValuesDetailed(stdout, "generic-jsonl");

  for (const event of parsed.values) {
    const outputCount = output.length;
    const errorCount = errors.length;
    collectText(event, output);

    const error = formatError(event.error) ?? (event.type === "error" ? stringValue(event.message) : null);
    if (error) errors.push(error);

    const costValue = numberValue(event.cost) ?? numberValue(event.total_cost_usd);
    if (costValue !== null) {
      sawCost = true;
      cost += costValue;
    }

    const eventUsage = usageValue(event.usage) ?? usageValue(event.tokens);
    if (eventUsage) usage = mergeTokenUsage(usage, eventUsage);

    if (output.length === outputCount && errors.length === errorCount && costValue === null && !eventUsage) {
      parsed.diagnostics.ignoredEvents += 1;
    }
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

export function parseClaudeStreamJson(stdout: string): JsonParseResult {
  const output = textCollector();
  const errors: string[] = [];
  let finalResult: string | null = null;
  let cost = 0;
  let sawCost = false;
  let usage = emptyTokenUsage();
  const parsed = parseJsonValuesDetailed(stdout, "claude-stream-json");

  for (const event of parsed.values) {
    const outputCount = output.length;
    const errorCount = errors.length;
    const priorFinalResult: string | null = finalResult;
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

    const eventUsage = usageValue(event.usage) ?? usageValue(event.tokens);
    if (eventUsage) usage = mergeTokenUsage(usage, eventUsage);

    if (
      output.length === outputCount &&
      errors.length === errorCount &&
      finalResult === priorFinalResult &&
      costValue === null &&
      !eventUsage
    ) {
      parsed.diagnostics.ignoredEvents += 1;
    }
  }

  return {
    output: (output.join("\n").trim() || finalResult || "").trim(),
    cost: sawCost ? cost : null,
    tokens: legacyTokenCount(usage),
    error: errors.length ? errors.join("\n") : null,
    usage,
    diagnostics: parsed.diagnostics,
  };
}

export function parseCodexJson(stdout: string): JsonParseResult {
  const output = textCollector();
  const errors: string[] = [];
  let cost = 0;
  let sawCost = false;
  let usage = emptyTokenUsage();
  const parsed = parseJsonValuesDetailed(stdout, "codex-jsonl");

  for (const event of parsed.values) {
    const outputCount = output.length;
    const errorCount = errors.length;
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

    const eventUsage = usageValue(event.usage) ?? usageValue(event.tokens);
    if (eventUsage) usage = mergeTokenUsage(usage, eventUsage);

    if (output.length === outputCount && errors.length === errorCount && costValue === null && !eventUsage) {
      parsed.diagnostics.ignoredEvents += 1;
    }
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

export function parseJsonValues(stdout: string) {
  return parseJsonValuesDetailed(stdout).values;
}

export function parseJsonValuesDetailed(stdout: string, format = "jsonl"): ParsedJsonValues {
  const values: Record<string, unknown>[] = [];
  const diagnostics = createParserDiagnostics(format);
  const trimmed = stdout.trim();
  if (!trimmed) return { values, diagnostics };

  try {
    const parsed = safeJsonParse<any>(trimmed);
    if (Array.isArray(parsed)) {
      for (const [index, item] of parsed.entries()) {
        const record = objectValue(item);
        if (record) values.push(record);
        else addMalformedDiagnostic(diagnostics, `array item ${index + 1} is not an object`);
      }
      return { values: dedupeStableProviderEvents(values, diagnostics), diagnostics };
    }
    const record = objectValue(parsed);
    if (record) values.push(record);
    else addMalformedDiagnostic(diagnostics, "root JSON value is not an object");
    return { values: dedupeStableProviderEvents(values, diagnostics), diagnostics };
  } catch {
    // The complete payload is not one JSON value. Continue with the bounded
    // JSONL parser below, which records each malformed line explicitly.
  }

  let lineNumber = 0;
  for (const line of stdout.split("\n")) {
    lineNumber += 1;
    const next = line.trim();
    if (!next) continue;
    try {
      const record = objectValue(safeJsonParse<any>(next));
      if (record) values.push(record);
      else addMalformedDiagnostic(diagnostics, `line ${lineNumber} is not a JSON object`);
    } catch {
      addMalformedDiagnostic(diagnostics, `line ${lineNumber} is not valid JSON`);
    }
  }

  return { values: dedupeStableProviderEvents(values, diagnostics), diagnostics };
}

// Bound the parser against a malicious/broken backend: cap recursion depth
// (a deeply-nested JSON object would otherwise overflow the stack) and cap the
// total extracted text (see appendText) so output can't grow unbounded.
const MAX_COLLECT_DEPTH = 64;

export function collectText(value: unknown, output: string[], depth = 0) {
  if (depth > MAX_COLLECT_DEPTH) return;
  if (typeof value === "string") {
    appendText(output, value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectText(item, output, depth + 1);
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
    collectText(record[key], output, depth + 1);
  }
  if (typeof record.content !== "string") {
    collectText(record.content, output, depth + 1);
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
  return legacyTokenCount(normalizeTokenUsage(value));
}

export function normalizeTokenUsage(value: unknown): NormalizedTokenUsage {
  const direct = tokenNumberValue(value);
  if (direct !== null) return { ...emptyTokenUsage(), providerTotal: direct };

  const record = objectValue(value);
  if (!record) return emptyTokenUsage();

  const inputDetails = objectValue(record.input_tokens_details) ?? objectValue(record.inputTokenDetails);
  const outputDetails = objectValue(record.output_tokens_details) ?? objectValue(record.outputTokenDetails);
  const cache = objectValue(record.cache);

  return {
    input: firstNumber(record, ["input", "input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]),
    output: firstNumber(record, ["output", "output_tokens", "outputTokens", "completion_tokens", "completionTokens"]),
    reasoning: firstNumber(record, ["reasoning", "reasoning_tokens", "reasoningTokens", "reasoning_output_tokens", "reasoningOutputTokens"])
      ?? firstNumber(outputDetails, ["reasoning_tokens", "reasoningTokens"]),
    cached: firstNumber(record, ["cached", "cached_tokens", "cachedTokens", "cached_input_tokens", "cachedInputTokens", "cache_read_input_tokens"])
      ?? firstNumber(inputDetails, ["cached_tokens", "cachedTokens"])
      ?? firstNumber(cache, ["read", "read_tokens", "readTokens"]),
    providerTotal: firstNumber(record, ["total_tokens", "totalTokens", "provider_total", "providerTotal"]),
  };
}

export function emptyTokenUsage(): NormalizedTokenUsage {
  return { input: null, output: null, reasoning: null, cached: null, providerTotal: null };
}

export function mergeTokenUsage(current: NormalizedTokenUsage, next: NormalizedTokenUsage): NormalizedTokenUsage {
  return {
    input: next.input ?? current.input,
    output: next.output ?? current.output,
    reasoning: next.reasoning ?? current.reasoning,
    cached: next.cached ?? current.cached,
    providerTotal: next.providerTotal ?? current.providerTotal,
  };
}

export function legacyTokenCount(usage: NormalizedTokenUsage): number | null {
  if (usage.providerTotal !== null) return usage.providerTotal;
  if (usage.input === null && usage.output === null) return null;
  // Input and output are disjoint billable categories. Reasoning and cached
  // tokens are commonly subsets of them, so adding those would double-count.
  return (usage.input ?? 0) + (usage.output ?? 0);
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

// Cap the total extracted text so a backend emitting hundreds of MB of JSONL
// cannot blow up the runner's memory through the collector.
const MAX_COLLECTED_BYTES = 262_144;

type TextCollector = string[] & { bytes?: number };

export function textCollector(): string[] {
  return Object.assign([], { bytes: 0 }) as TextCollector;
}

export function appendText(output: string[], value: string) {
  if (!value.trim()) return;
  const collector = output as TextCollector;
  if (collector.bytes !== undefined && collector.bytes >= MAX_COLLECTED_BYTES) return;
  if (collector.bytes !== undefined) collector.bytes += value.length;
  output.push(value);
}

function createParserDiagnostics(format: string): ParserDiagnostics {
  return { format, malformedEvents: 0, ignoredEvents: 0, messages: [] };
}

function addMalformedDiagnostic(diagnostics: ParserDiagnostics, message: string) {
  diagnostics.malformedEvents += 1;
  if (diagnostics.messages.length < 64) diagnostics.messages.push(message);
}

function dedupeStableProviderEvents(events: Record<string, unknown>[], diagnostics: ParserDiagnostics) {
  const seen = new Set<string>();
  return events.filter((event) => {
    const id = stableProviderEventId(event);
    if (!id) return true;
    if (seen.has(id)) {
      diagnostics.ignoredEvents += 1;
      return false;
    }
    seen.add(id);
    return true;
  });
}

function stableProviderEventId(event: Record<string, unknown>): string | null {
  const direct = firstString(event, ["event_id", "eventId", "eventID"]);
  if (direct) return direct;
  const envelope = objectValue(event.event) ?? objectValue(event.meta) ?? objectValue(event.metadata);
  return firstString(envelope, ["event_id", "eventId", "eventID"]);
}

function usageValue(value: unknown): NormalizedTokenUsage | null {
  const usage = normalizeTokenUsage(value);
  return Object.values(usage).some((entry) => entry !== null) ? usage : null;
}

function firstNumber(record: Record<string, unknown> | null, keys: readonly string[]): number | null {
  if (!record) return null;
  for (const key of keys) {
    const value = tokenNumberValue(record[key]);
    if (value !== null) return value;
  }
  return null;
}

function tokenNumberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function firstString(record: Record<string, unknown> | null, keys: readonly string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value) return value;
  }
  return null;
}
