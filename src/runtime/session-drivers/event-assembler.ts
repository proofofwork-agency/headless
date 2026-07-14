import { redactAndTruncate } from "../redaction";
import {
  decoderForBackend,
  type DecodedSessionEvent,
  type SessionEventDecoder,
} from "./event-decoder";
import type { SessionDriverErrorCode } from "./errors";
import type {
  SessionBackend,
  SessionEvent,
  SessionRateLimit,
  SessionTokenUsage,
} from "./types";

export const DEFAULT_MAX_ASSEMBLED_EVENTS = 2_048;
export const DEFAULT_MAX_ASSEMBLED_EVENT_BYTES = 1_000_000;
export const DEFAULT_MAX_ASSEMBLED_OUTPUT_BYTES = 262_144;

type RetainedEvent = {
  decoded: DecodedSessionEvent;
  arrival: number;
  connection: string;
  bytes: number;
};

export type SessionEventAssemblerOptions = {
  backend: SessionBackend;
  decoder?: SessionEventDecoder;
  maxEvents?: number;
  maxEventBytes?: number;
  maxOutputBytes?: number;
  now?: () => number;
};

export type AssembleCompletionInput = {
  exitCode: number | null;
  signal?: string | null;
  cancelled?: boolean;
  timedOut?: boolean;
  overflowed?: boolean;
};

export type AssembledSessionEvents = {
  status: "completed" | "failed" | "cancelled" | "rate-limited" | "incomplete";
  output: string;
  events: SessionEvent[];
  usage: SessionTokenUsage;
  costUsd: number | null;
  nativeSessionId: string | null;
  nativeTurnId: string | null;
  malformedEvents: number;
  inferredCompletion: boolean;
  truncated: boolean;
  rateLimit: SessionRateLimit;
  error: string | null;
  errorCode: SessionDriverErrorCode | null;
};

export class SessionEventAssembler {
  private readonly decoder: SessionEventDecoder;
  private readonly maxEvents: number;
  private readonly maxEventBytes: number;
  private readonly maxOutputBytes: number;
  private readonly retained: RetainedEvent[] = [];
  private readonly stableIds = new Set<string>();
  private arrival = 0;
  private retainedBytes = 0;
  private malformed = 0;
  private truncated = false;
  private connection = "initial";
  private connections = 0;
  private readonly now: () => number;

  constructor(private readonly options: SessionEventAssemblerOptions) {
    this.decoder = options.decoder ?? decoderForBackend(options.backend);
    this.maxEvents = boundedInteger(
      options.maxEvents ?? DEFAULT_MAX_ASSEMBLED_EVENTS,
      16,
      10_000,
      "event count",
    );
    this.maxEventBytes = boundedInteger(
      options.maxEventBytes ?? DEFAULT_MAX_ASSEMBLED_EVENT_BYTES,
      16_384,
      8_000_000,
      "event bytes",
    );
    this.maxOutputBytes = boundedInteger(
      options.maxOutputBytes ?? DEFAULT_MAX_ASSEMBLED_OUTPUT_BYTES,
      1_024,
      1_000_000,
      "output bytes",
    );
    this.now = options.now ?? Date.now;
  }

  beginConnection(id: string) {
    const safe = safeText(id, 128);
    this.connection = safe || `connection-${this.connections + 1}`;
    this.connections += 1;
    if (this.connections > 1) {
      this.retain({
        kind: "diagnostic",
        stableId: `reconnect:${this.connection}`,
        text: `Transport reconnected as ${this.connection}. Stable provider event identifiers remain deduplicated.`,
      });
    }
  }

  push(value: unknown) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return;
      try {
        this.pushParsed(JSON.parse(trimmed));
      } catch {
        this.recordMalformed(trimmed);
      }
      return;
    }
    this.pushParsed(value);
  }

  pushJsonl(value: string) {
    for (const line of value.split(/\r?\n/)) this.push(line);
  }

  finish(input: AssembleCompletionInput): AssembledSessionEvents {
    const beforeCompletion = [...this.retained].sort(compareRetained);
    const initialOutput = assembledOutput(
      beforeCompletion,
      this.maxOutputBytes,
    );
    const rate = beforeCompletion
      .filter((entry) => entry.decoded.kind === "rate-limit")
      .at(-1)?.decoded;
    const explicitCompletion = findLastDecoded(beforeCompletion, "completion");
    const inferredCompletion =
      !explicitCompletion &&
      !input.cancelled &&
      !input.timedOut &&
      !input.overflowed &&
      !rate &&
      input.exitCode === 0 &&
      initialOutput.text.length > 0;
    if (inferredCompletion) {
      this.retain({
        kind: "completion",
        stableId: "inferred-completion",
        text: "Completion inferred from a successful process exit and assistant output.",
      });
    }
    const ordered = [...this.retained].sort(compareRetained);
    const usage = assembledUsage(ordered);
    const costUsd = assembledCost(ordered);
    const nativeSessionId = lastValue(ordered, "sessionId");
    const nativeTurnId = lastValue(ordered, "turnId");
    const output = assembledOutput(ordered, this.maxOutputBytes);
    const errorEvent = findLastDecoded(ordered, "error");
    const status = input.cancelled
      ? "cancelled"
      : input.timedOut || input.overflowed
        ? "failed"
        : rate
          ? "rate-limited"
          : explicitCompletion
            ? explicitCompletion.failed
              ? "failed"
              : "completed"
            : inferredCompletion
              ? "completed"
              : input.exitCode !== 0 || errorEvent
                ? "failed"
                : "incomplete";
    const errorCode: SessionDriverErrorCode | null = input.cancelled
      ? null
      : input.timedOut
        ? "TIMED_OUT"
        : input.overflowed
          ? "OUTPUT_OVERFLOW"
          : null;
    const error = input.cancelled
      ? "Turn cancelled."
      : input.timedOut
        ? "Session command timed out."
        : input.overflowed
          ? "Session command exceeded its output bound."
          : status === "rate-limited"
            ? rate?.text ?? "Backend rate limit reported."
            : status === "failed"
              ? errorEvent?.text ??
                `Backend exited ${String(input.exitCode)}${input.signal ? ` (${input.signal})` : ""}.`
              : null;
    const canonical = ordered.map((entry, index) => {
      const event = canonicalEvent(this.options.backend, entry, index);
      if (
        inferredCompletion &&
        entry.decoded.stableId === "inferred-completion"
      )
        event.inferred = true;
      return event;
    });
    return {
      status,
      output: output.text,
      events: canonical,
      usage,
      costUsd,
      nativeSessionId,
      nativeTurnId,
      malformedEvents: this.malformed,
      inferredCompletion,
      truncated: this.truncated || output.truncated || !!input.overflowed,
      rateLimit: {
        limited: !!rate,
        retryAfterMs: rate?.retryAfterMs ?? null,
        observedAt: rate ? this.now() : null,
        reason: rate?.text ?? null,
      },
      error,
      errorCode,
    };
  }

  private pushParsed(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      this.recordMalformed(JSON.stringify(value));
      return;
    }
    let decoded: DecodedSessionEvent[];
    try {
      decoded = this.decoder(value as Record<string, unknown>);
    } catch {
      this.recordMalformed(JSON.stringify(value));
      return;
    }
    for (const event of decoded) this.retain(event);
  }

  private retain(decoded: DecodedSessionEvent) {
    if (decoded.stableId && this.stableIds.has(decoded.stableId)) return;
    if (decoded.stableId) this.stableIds.add(decoded.stableId);
    const event = this.boundedEvent(sanitizeDecoded(decoded));
    if (!event) {
      this.truncated = true;
      return;
    }
    if (
      this.withinBounds(
        this.retained.length + 1,
        this.retainedBytes + event.bytes,
      )
    ) {
      this.retained.push(event);
      this.retainedBytes += event.bytes;
      return;
    }
    this.truncated = true;
    const incomingPriority = retentionPriority(event.decoded.kind);
    const candidates = this.retained
      .filter(
        (entry) => retentionPriority(entry.decoded.kind) <= incomingPriority,
      )
      .sort(compareEviction);
    const evicted = new Set<RetainedEvent>();
    let retainedBytes = this.retainedBytes;
    let retainedCount = this.retained.length;
    for (const candidate of candidates) {
      evicted.add(candidate);
      retainedBytes -= candidate.bytes;
      retainedCount -= 1;
      if (this.withinBounds(retainedCount + 1, retainedBytes + event.bytes))
        break;
    }
    if (!this.withinBounds(retainedCount + 1, retainedBytes + event.bytes))
      return;
    this.retained.splice(
      0,
      this.retained.length,
      ...this.retained.filter((entry) => !evicted.has(entry)),
      event,
    );
    this.retainedBytes = retainedBytes + event.bytes;
  }

  private boundedEvent(decoded: DecodedSessionEvent): RetainedEvent | null {
    const event = {
      decoded,
      arrival: this.arrival++,
      connection: this.connection,
      bytes: 0,
    };
    event.bytes = retainedEventBytes(
      this.options.backend,
      event,
      this.maxEvents,
    );
    if (this.withinBounds(1, event.bytes)) return event;
    if (!decoded.text) return null;
    this.truncated = true;
    let byteLimit = Math.max(0, Buffer.byteLength(decoded.text));
    while (byteLimit > 0) {
      byteLimit = Math.floor(byteLimit / 2);
      event.decoded = {
        ...decoded,
        text: truncateBytes(decoded.text, byteLimit).text || undefined,
      };
      event.bytes = retainedEventBytes(
        this.options.backend,
        event,
        this.maxEvents,
      );
      if (this.withinBounds(1, event.bytes)) return event;
    }
    event.decoded = { ...decoded, text: undefined };
    event.bytes = retainedEventBytes(
      this.options.backend,
      event,
      this.maxEvents,
    );
    return this.withinBounds(1, event.bytes) ? event : null;
  }

  private withinBounds(count: number, payloadBytes: number) {
    const serializedBytes = 2 + payloadBytes + Math.max(0, count - 1);
    return count <= this.maxEvents && serializedBytes <= this.maxEventBytes;
  }

  private recordMalformed(value: string) {
    this.malformed += 1;
    this.retain({
      kind: "diagnostic",
      text: `Malformed structured backend event ${this.malformed}: ${safeText(value, 512)}`,
    });
  }
}

function sanitizeDecoded(value: DecodedSessionEvent): DecodedSessionEvent {
  return {
    ...value,
    stableId: value.stableId ? safeText(value.stableId, 256) : undefined,
    sessionId: value.sessionId ? safeText(value.sessionId, 512) : undefined,
    turnId: value.turnId ? safeText(value.turnId, 512) : undefined,
    itemId: value.itemId ? safeText(value.itemId, 512) : undefined,
    text: value.text ? safeText(value.text, 65_536) : undefined,
    providerSequence: finiteNonnegative(value.providerSequence),
    retryAfterMs: finiteNonnegative(value.retryAfterMs),
  };
}

function canonicalEvent(
  backend: SessionBackend,
  value: RetainedEvent,
  sequence: number,
): SessionEvent {
  const event = value.decoded;
  return {
    id: event.stableId ?? `${backend}:${value.connection}:${value.arrival}`,
    kind: event.kind,
    backend,
    sequence,
    providerSequence: event.providerSequence ?? null,
    sessionId: event.sessionId ?? null,
    turnId: event.turnId ?? null,
    itemId: event.itemId ?? null,
    text: event.text ?? null,
    usage: event.usage ? normalizedUsage(event.usage) : null,
    costUsd: finiteNonnegative(event.costUsd) ?? null,
    retryAfterMs: event.retryAfterMs ?? null,
    inferred: false,
  };
}

function assembledOutput(events: RetainedEvent[], maxBytes: number) {
  const groups = new Map<
    string,
    { order: number; deltas: RetainedEvent[]; snapshots: RetainedEvent[] }
  >();
  for (const event of events) {
    if (event.decoded.kind !== "text" || !event.decoded.text) continue;
    const groupId = event.decoded.itemId ?? event.decoded.turnId ?? "turn-text";
    const group = groups.get(groupId) ?? {
      order: event.arrival,
      deltas: [],
      snapshots: [],
    };
    group.order = Math.min(group.order, event.arrival);
    if (event.decoded.textMode === "delta") group.deltas.push(event);
    else group.snapshots.push(event);
    groups.set(groupId, group);
  }
  const chunks = [...groups.values()]
    .sort((left, right) => left.order - right.order)
    .map((group) => {
      if (group.deltas.length > 0)
        return group.deltas
          .sort(compareRetained)
          .map((entry) => entry.decoded.text)
          .join("");
      return group.snapshots.sort(compareRetained).at(-1)?.decoded.text ?? "";
    })
    .filter(Boolean);
  const joined = chunks.join("\n");
  return truncateBytes(joined, maxBytes);
}

function assembledUsage(events: RetainedEvent[]): SessionTokenUsage {
  const usage: SessionTokenUsage = {
    input: null,
    output: null,
    reasoning: null,
    cached: null,
    total: null,
  };
  for (const event of events) {
    if (event.decoded.kind !== "usage" || !event.decoded.usage) continue;
    for (const key of [
      "input",
      "output",
      "reasoning",
      "cached",
      "total",
    ] as const) {
      const value = event.decoded.usage[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        usage[key] = usage[key] === null ? value : Math.max(usage[key], value);
      }
    }
  }
  return usage;
}

function assembledCost(events: RetainedEvent[]) {
  let total = 0;
  let reported = false;
  for (const event of events) {
    const value = event.decoded.costUsd;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
    reported = true;
    total += value;
  }
  return reported ? total : null;
}

function lastValue(events: RetainedEvent[], key: "sessionId" | "turnId") {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const value = events[index].decoded[key];
    if (value) return value;
  }
  return null;
}

function findLastDecoded(
  events: RetainedEvent[],
  kind: DecodedSessionEvent["kind"],
) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].decoded.kind === kind) return events[index].decoded;
  }
  return undefined;
}

function compareRetained(left: RetainedEvent, right: RetainedEvent) {
  const a = left.decoded.providerSequence;
  const b = right.decoded.providerSequence;
  if (a != null && b != null && a !== b) return a - b;
  return left.arrival - right.arrival;
}

function compareEviction(left: RetainedEvent, right: RetainedEvent) {
  const priority =
    retentionPriority(left.decoded.kind) -
    retentionPriority(right.decoded.kind);
  return priority || left.arrival - right.arrival;
}

function retentionPriority(kind: DecodedSessionEvent["kind"]) {
  if (kind === "completion") return 5;
  if (kind === "rate-limit" || kind === "error") return 4;
  if (kind === "session" || kind === "turn") return 3;
  if (kind === "usage") return 2;
  if (kind === "text" || kind === "tool") return 1;
  return 0;
}

function retainedEventBytes(
  backend: SessionBackend,
  event: RetainedEvent,
  maxEvents: number,
) {
  // Size with the widest possible canonical sequence so the public event array
  // cannot exceed the configured byte bound after ordering.
  return Buffer.byteLength(
    JSON.stringify(canonicalEvent(backend, event, maxEvents - 1)),
  );
}

function safeText(value: string, maxLength: number) {
  try {
    return redactAndTruncate(value, maxLength).text;
  } catch {
    return "[SUPPRESSED: REDACTION FAILURE]";
  }
}

function truncateBytes(value: string, maxBytes: number) {
  if (Buffer.byteLength(value) <= maxBytes)
    return { text: value, truncated: false };
  const buffer = Buffer.from(value);
  let end = maxBytes;
  let text = buffer.subarray(0, end).toString("utf8");
  while (Buffer.byteLength(text) > maxBytes && end > 0) {
    end -= 1;
    text = buffer.subarray(0, end).toString("utf8");
  }
  return { text, truncated: true };
}

function normalizedUsage(value: Partial<SessionTokenUsage>): SessionTokenUsage {
  return {
    input: finiteNonnegative(value.input) ?? null,
    output: finiteNonnegative(value.output) ?? null,
    reasoning: finiteNonnegative(value.reasoning) ?? null,
    cached: finiteNonnegative(value.cached) ?? null,
    total: finiteNonnegative(value.total) ?? null,
  };
}

function finiteNonnegative(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(
      `Session assembler ${name} must be from ${minimum} through ${maximum}.`,
    );
  }
  return value;
}
