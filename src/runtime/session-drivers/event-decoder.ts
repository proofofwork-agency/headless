import type { SessionBackend, SessionEventKind, SessionTokenUsage } from "./types";

export type DecodedSessionEvent = {
  stableId?: string | null;
  kind: SessionEventKind;
  providerSequence?: number | null;
  sessionId?: string | null;
  turnId?: string | null;
  itemId?: string | null;
  text?: string | null;
  textMode?: "delta" | "snapshot";
  usage?: Partial<SessionTokenUsage>;
  costUsd?: number | null;
  retryAfterMs?: number | null;
  failed?: boolean;
};

export type SessionEventDecoder = (value: Record<string, unknown>) => DecodedSessionEvent[];

export function decoderForBackend(backend: SessionBackend): SessionEventDecoder {
  if (backend === "codex") return decodeCodexEvent;
  if (backend === "claude-code") return decodeClaudeEvent;
  if (backend === "opencode") return decodeOpenCodeEvent;
  return decodeGrokEvent;
}

export function decodeCodexEvent(value: Record<string, unknown>): DecodedSessionEvent[] {
  const method = stringValue(value.method);
  const params = objectValue(value.params);
  const type = stringValue(value.type) ?? method;
  const source = params ?? value;
  const thread = objectValue(source.thread);
  const turn = objectValue(source.turn);
  const item = objectValue(source.item);
  const sessionId = firstString(source.thread_id, source.threadId, thread?.id, value.thread_id, value.threadId);
  const turnId = firstString(source.turn_id, source.turnId, turn?.id, value.turn_id, value.turnId);
  const itemId = firstString(source.item_id, source.itemId, item?.id);
  const sequence = firstNumber(source.sequence, source.seq, value.sequence, value.seq);

  if (type === "thread.started" || type === "thread/started") {
    return [decoded("session", { stableId: sessionId ? `thread:${sessionId}:started` : undefined, sessionId, providerSequence: sequence })];
  }
  if (type === "turn.started" || type === "turn/started") {
    return [decoded("turn", { stableId: turnId ? `turn:${turnId}:started` : undefined, sessionId, turnId, providerSequence: sequence })];
  }
  if (type === "item/agentMessage/delta" || type === "item.agent_message.delta" || type === "response.output_text.delta") {
    const text = firstString(source.delta, value.delta);
    return text ? [decoded("text", {
      stableId: providerEventId(value, source, true),
      sessionId,
      turnId,
      itemId,
      text,
      textMode: "delta",
      providerSequence: sequence,
    })] : [];
  }
  if (type === "item.completed" || type === "item/completed") {
    const itemType = firstString(item?.type, source.item_type);
    if (itemType === "agent_message" || itemType === "agentMessage" || itemType === "message") {
      const text = firstString(item?.text, source.text);
      return text ? [decoded("text", {
        stableId: itemId ? `item:${itemId}:completed` : providerEventId(value, source),
        sessionId,
        turnId,
        itemId,
        text,
        textMode: "snapshot",
        providerSequence: sequence,
      })] : [];
    }
    return [decoded("tool", {
      stableId: itemId ? `item:${itemId}:completed` : providerEventId(value, source),
      sessionId,
      turnId,
      itemId,
      text: itemType ?? "tool item completed",
      providerSequence: sequence,
    })];
  }
  if (type === "thread/tokenUsage/updated" || type === "turn.completed") {
    const usage = objectValue(source.tokenUsage) ?? objectValue(value.usage) ?? objectValue(source.usage);
    const costUsd = reportedCost(value, source, usage);
    const total = objectValue(usage?.total) ?? usage;
    const events: DecodedSessionEvent[] = [];
    if (usage || costUsd !== null) events.push(decoded("usage", {
      stableId: providerEventId(value, source),
      sessionId,
      turnId,
      usage: tokenUsage(total ?? usage ?? {}),
      costUsd,
      providerSequence: sequence,
    }));
    if (type === "turn.completed") events.push(decoded("completion", {
      stableId: turnId ? `turn:${turnId}:completed` : providerEventId(value, source),
      sessionId,
      turnId,
      failed: firstString(turn?.status, source.status) === "failed",
      providerSequence: sequence,
    }));
    return events;
  }
  if (type === "turn/completed") {
    const status = firstString(turn?.status, source.status);
    return [decoded("completion", {
      stableId: turnId ? `turn:${turnId}:completed` : providerEventId(value, source),
      sessionId,
      turnId,
      failed: status === "failed" || status === "cancelled",
      providerSequence: sequence,
    })];
  }
  return genericErrorOrRateLimit(value, source, { sessionId, turnId, providerSequence: sequence });
}

export function decodeClaudeEvent(value: Record<string, unknown>): DecodedSessionEvent[] {
  const type = stringValue(value.type);
  const subtype = stringValue(value.subtype);
  const sessionId = firstString(value.session_id, value.sessionId);
  const message = objectValue(value.message);
  const messageId = firstString(message?.id, value.message_id);
  const sequence = firstNumber(value.sequence, value.seq);
  if (type === "system" && subtype === "init") {
    return [decoded("session", { stableId: sessionId ? `session:${sessionId}:init` : providerEventId(value), sessionId, providerSequence: sequence })];
  }
  if (type === "assistant") {
    const content = arrayValue(message?.content) ?? arrayValue(value.content) ?? [];
    return content.flatMap((block, index) => {
      const item = objectValue(block);
      const text = item?.type === "text" ? stringValue(item.text) : null;
      if (!text) return [];
      const itemId = firstString(item!.id, messageId ? `${messageId}:${index}` : null);
      return [decoded("text", {
        stableId: itemId ? `assistant:${itemId}` : providerEventId(value),
        sessionId,
        itemId: itemId ?? undefined,
        text,
        textMode: "snapshot",
        providerSequence: sequence,
      })];
    });
  }
  if (type === "stream_event") {
    const event = objectValue(value.event);
    const delta = objectValue(event?.delta);
    const text = delta?.type === "text_delta" ? stringValue(delta.text) : null;
    if (!text) return genericErrorOrRateLimit(value, event ?? value, { sessionId, providerSequence: sequence });
    const index = firstNumber(event?.index, event?.content_block_index);
    return [decoded("text", {
      stableId: providerEventId(value, event ?? value, true),
      sessionId,
      itemId: messageId ? `${messageId}:${index ?? 0}` : `content:${index ?? 0}`,
      text,
      textMode: "delta",
      providerSequence: sequence,
    })];
  }
  if (type === "result") {
    const usage = objectValue(value.usage);
    const costUsd = reportedCost(value, usage);
    const events: DecodedSessionEvent[] = [];
    const result = stringValue(value.result);
    if (result) events.push(decoded("text", {
      stableId: providerEventId(value) ?? (sessionId ? `session:${sessionId}:result-text` : undefined),
      sessionId,
      itemId: "result",
      text: result,
      textMode: "snapshot",
      providerSequence: sequence,
    }));
    if (usage || costUsd !== null) events.push(decoded("usage", {
      stableId: sessionId ? `session:${sessionId}:usage` : undefined,
      sessionId,
      usage: tokenUsage(usage ?? {}),
      costUsd,
      providerSequence: sequence,
    }));
    events.push(decoded("completion", {
      stableId: sessionId ? `session:${sessionId}:completed` : providerEventId(value),
      sessionId,
      failed: value.is_error === true || subtype === "error",
      providerSequence: sequence,
    }));
    return events;
  }
  return genericErrorOrRateLimit(value, message ?? value, { sessionId, providerSequence: sequence });
}

export function decodeOpenCodeEvent(value: Record<string, unknown>): DecodedSessionEvent[] {
  const type = stringValue(value.type);
  const properties = objectValue(value.properties);
  const part = objectValue(properties?.part) ?? objectValue(value.part);
  const sessionId = firstString(value.sessionID, value.session_id, properties?.sessionID, part?.sessionID);
  const turnId = firstString(value.messageID, properties?.messageID, part?.messageID);
  const itemId = firstString(part?.id, value.id);
  const sequence = firstNumber(value.sequence, properties?.sequence);
  if (type === "session.created" || type === "session.updated" || type === "session.start") {
    return [decoded("session", { stableId: providerEventId(value, properties ?? value), sessionId, providerSequence: sequence })];
  }
  if (part?.type === "text" && typeof part.text === "string") {
    const completed = !!objectValue(part.time)?.end;
    return [decoded("text", {
      stableId: completed && itemId ? `part:${itemId}:completed` : providerEventId(value, properties ?? value, !completed),
      sessionId,
      turnId,
      itemId,
      text: part.text,
      textMode: completed ? "snapshot" : "delta",
      providerSequence: sequence,
    })];
  }
  if (type === "step_finish" || type === "step.finish") {
    return [decoded("usage", {
      stableId: providerEventId(value, properties ?? value),
      sessionId,
      turnId,
      usage: tokenUsage(objectValue(value.tokens) ?? objectValue(part?.tokens) ?? {}),
      costUsd: reportedCost(value, part, properties),
      providerSequence: sequence,
    })];
  }
  if (type === "session.idle" || type === "session.completed" || type === "turn.completed") {
    return [decoded("completion", {
      stableId: sessionId ? `session:${sessionId}:${type}` : providerEventId(value),
      sessionId,
      turnId,
      providerSequence: sequence,
    })];
  }
  return genericErrorOrRateLimit(value, properties ?? value, { sessionId, turnId, providerSequence: sequence });
}

export function decodeGrokEvent(value: Record<string, unknown>): DecodedSessionEvent[] {
  const type = firstString(value.type, value.event);
  const sessionId = firstString(value.session_id, value.sessionId, value.thread_id, value.threadId);
  const turnId = firstString(value.turn_id, value.turnId);
  const itemId = firstString(value.item_id, value.itemId, value.id);
  const sequence = firstNumber(value.sequence, value.seq);
  if (type === "session" || type === "session.started" || type === "thread.started") {
    return [decoded("session", { stableId: providerEventId(value), sessionId, providerSequence: sequence })];
  }
  if (type === "text" || type === "assistant" || type === "content.delta" || type === "message.delta") {
    const grokDataDelta = type === "text" ? firstString(value.data) : null;
    const text = grokDataDelta ?? firstString(value.delta, value.text, value.content);
    const delta = grokDataDelta !== null || type.endsWith("delta");
    return text ? [decoded("text", {
      stableId: providerEventId(value, value, delta),
      sessionId,
      turnId,
      itemId,
      text,
      textMode: delta ? "delta" : "snapshot",
      providerSequence: sequence,
    })] : [];
  }
  if (type === "usage") {
    const usage = objectValue(value.usage) ?? value;
    return [decoded("usage", {
      stableId: providerEventId(value),
      sessionId,
      turnId,
      usage: tokenUsage(usage),
      costUsd: reportedCost(value, usage),
      providerSequence: sequence,
    })];
  }
  // grok-build emits {"type":"max_turns_reached"} then bails; without this the
  // event carried no error field and was silently ignored (headless.rs:1313).
  if (type === "max_turns_reached") {
    return [decoded("error", {
      stableId: providerEventId(value),
      sessionId,
      turnId,
      text: "Grok reached its maximum turn limit before completing the turn.",
      failed: true,
      providerSequence: sequence,
    })];
  }
  if (type === "result" || type === "completed" || type === "turn.completed" || type === "end") {
    const events: DecodedSessionEvent[] = [];
    const text = firstString(value.output, value.result, value.text);
    if (text) events.push(decoded("text", {
      stableId: providerEventId(value) ?? (turnId ? `turn:${turnId}:result` : undefined),
      sessionId,
      turnId,
      itemId: itemId ?? "result",
      text,
      textMode: "snapshot",
      providerSequence: sequence,
    }));
    const usage = objectValue(value.usage);
    const costUsd = reportedCost(value, usage);
    if (usage || costUsd !== null) events.push(decoded("usage", {
      sessionId,
      turnId,
      usage: tokenUsage(usage ?? {}),
      costUsd,
      providerSequence: sequence,
    }));
    const stopReason = firstString(value.stop_reason, value.stopReason)?.toLowerCase() ?? "";
    // grok-build Debug-formats acp::StopReason into stopReason; these variants
    // mean the turn did not complete usefully (Refusal, ContentFilter,
    // Cancelled, ModelContextWindowExceeded) even though no error event fires.
    const stopFailed = ["refusal", "contentfilter", "content_filter", "cancelled", "canceled", "modelcontextwindowexceeded"]
      .some((marker) => stopReason.includes(marker));
    events.push(decoded("completion", {
      stableId: turnId ? `turn:${turnId}:completed` : providerEventId(value),
      sessionId,
      turnId,
      failed: value.ok === false || value.success === false || stopReason.includes("error") || stopReason.includes("fail") || stopFailed,
      providerSequence: sequence,
    }));
    return events;
  }
  return genericErrorOrRateLimit(value, value, { sessionId, turnId, providerSequence: sequence });
}

function genericErrorOrRateLimit(
  value: Record<string, unknown>,
  source: Record<string, unknown>,
  context: Pick<DecodedSessionEvent, "sessionId" | "turnId" | "providerSequence">,
) {
  const type = firstString(value.type, value.method, source.type)?.toLowerCase() ?? "";
  const error = objectValue(value.error) ?? objectValue(source.error);
  const message = firstString(error?.message, value.message, source.message, value.error, source.error);
  const retryAfterMs = retryAfter(value, source, error);
  if (type.includes("rate") && type.includes("limit") || retryAfterMs !== null || message && /(?:rate.?limit|too many requests|\b429\b)/i.test(message)) {
    return [decoded("rate-limit", {
      stableId: providerEventId(value, source),
      ...context,
      text: message ?? "Backend rate limit reported.",
      retryAfterMs: retryAfterMs ?? undefined,
    })];
  }
  if (error || type === "error" || type.endsWith("/error") || type.endsWith(".error")) {
    return [decoded("error", {
      stableId: providerEventId(value, source),
      ...context,
      text: message ?? "Backend reported an error.",
      failed: true,
    })];
  }
  return [];
}

function decoded(kind: SessionEventKind, value: Omit<DecodedSessionEvent, "kind">): DecodedSessionEvent {
  return { kind, ...value };
}

function providerEventId(value: Record<string, unknown>, source: Record<string, unknown> = value, delta = false) {
  const id = firstString(value.event_id, value.eventId, source.event_id, source.eventId);
  if (id) return id;
  if (delta) {
    const sequence = firstNumber(value.sequence, value.seq, source.sequence, source.seq);
    const itemId = firstString(source.item_id, source.itemId, objectValue(source.item)?.id);
    if (sequence !== null && itemId) return `${itemId}:delta:${sequence}`;
    return undefined;
  }
  return firstString(value.id, source.id);
}

function retryAfter(...values: Array<Record<string, unknown> | null>) {
  for (const value of values) {
    if (!value) continue;
    const milliseconds = firstNumber(value.retry_after_ms, value.retryAfterMs);
    if (milliseconds !== null && milliseconds >= 0) return Math.min(milliseconds, 86_400_000);
    const seconds = firstNumber(value.retry_after, value.retryAfter);
    if (seconds !== null && seconds >= 0) return Math.min(seconds * 1_000, 86_400_000);
  }
  return null;
}

function tokenUsage(value: Record<string, unknown>): Partial<SessionTokenUsage> {
  return {
    input: firstNumber(value.input, value.input_tokens, value.inputTokens),
    output: firstNumber(value.output, value.output_tokens, value.outputTokens),
    reasoning: firstNumber(value.reasoning, value.reasoning_tokens, value.reasoning_output_tokens, value.reasoningOutputTokens),
    cached: firstNumber(value.cached, value.cached_tokens, value.cached_input_tokens, value.cachedInputTokens, value.cache_read_input_tokens),
    total: firstNumber(value.total, value.total_tokens, value.totalTokens),
  };
}

function reportedCost(...values: Array<Record<string, unknown> | null>) {
  for (const value of values) {
    if (!value) continue;
    const cost = firstNumber(
      value.cost,
      value.cost_usd,
      value.costUsd,
      value.total_cost_usd,
      value.totalCostUsd,
    );
    if (cost !== null) return cost;
  }
  return null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function arrayValue(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    const result = stringValue(value);
    if (result) return result;
  }
  return null;
}

function firstNumber(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}
