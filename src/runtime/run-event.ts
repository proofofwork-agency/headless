import { randomUUID } from "node:crypto";
import type { RunEvent, RunResult } from "../contracts/run";
import { RunEventSchema } from "../contracts/run";
import { redactAndTruncate, type RedactionResult } from "./redaction";
import { HeadlessError } from "./headless-error";

export const DEFAULT_MAX_RUN_EVENT_BYTES = 256 * 1024;
export const MIN_RUN_EVENT_BYTES = 4 * 1024;

type EnvelopeKey = "version" | "eventId" | "jobId" | "sessionId" | "sequence" | "timestamp" | "redacted";
type StripEnvelope<Event> = Event extends RunEvent ? Omit<Event, EnvelopeKey> : never;

/** Client/provider input cannot assign trusted envelope fields. */
export type RunEventInput = StripEnvelope<RunEvent>;

export type RunEventContext = {
  jobId: string;
  sessionId?: string | null;
  sequence: number;
  timestamp?: number;
};

export type RunEventBuilderOptions = {
  createId?: () => string;
  maxEventBytes?: number;
  redact?: (value: unknown, maxLength?: number) => RedactionResult;
};

export function buildRunEvent(
  context: RunEventContext,
  input: RunEventInput,
  options: RunEventBuilderOptions = {},
) {
  const maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_RUN_EVENT_BYTES;
  if (!Number.isSafeInteger(maxEventBytes) || maxEventBytes < MIN_RUN_EVENT_BYTES) {
    throw new TypeError(`Run event limit must be at least ${MIN_RUN_EVENT_BYTES} bytes.`);
  }
  const sanitize = textSanitizer(options.redact ?? redactAndTruncate);
  const envelope = {
    version: 2 as const,
    eventId: options.createId?.() ?? randomUUID(),
    jobId: context.jobId,
    sessionId: context.sessionId ?? null,
    sequence: context.sequence,
    timestamp: context.timestamp ?? Date.now(),
    redacted: true as const,
  };
  const dynamicLimit = (contractLimit: number) => Math.min(contractLimit, Math.max(128, Math.floor(maxEventBytes / 4)));

  let candidate: unknown;
  switch (input.kind) {
    case "stdout":
    case "stderr": {
      const text = sanitize(input.text, dynamicLimit(65_536));
      candidate = { ...envelope, kind: input.kind, text: text.text, truncated: input.truncated || text.truncated };
      break;
    }
    case "lifecycle": {
      const detail = input.detail === undefined ? undefined : sanitize(input.detail, dynamicLimit(4_096)).text;
      candidate = { ...envelope, kind: input.kind, state: input.state, ...(detail === undefined ? {} : { detail }) };
      break;
    }
    case "usage":
      candidate = {
        ...envelope,
        kind: input.kind,
        usage: input.usage,
        cost: {
          ...input.cost,
          pricingId: input.cost.pricingId === null ? null : sanitize(input.cost.pricingId, 256).text,
        },
      };
      break;
    case "tool":
      candidate = {
        ...envelope,
        kind: input.kind,
        name: sanitize(input.name, 256).text,
        phase: input.phase,
        summary: sanitize(input.summary, dynamicLimit(16_384)).text,
      };
      break;
    case "policy":
      candidate = {
        ...envelope,
        kind: input.kind,
        decision: input.decision,
        rule: sanitize(input.rule, 256).text,
        reason: sanitize(input.reason, dynamicLimit(16_384)).text,
      };
      break;
    case "artifact": {
      const summary = sanitize(input.summary, dynamicLimit(16_384));
      candidate = {
        ...envelope,
        kind: input.kind,
        artifactId: sanitize(input.artifactId, 160).text,
        artifactKind: sanitize(input.artifactKind, 128).text,
        summary: summary.text,
        truncated: input.truncated || summary.truncated,
      };
      break;
    }
    case "completion":
      candidate = {
        ...envelope,
        kind: input.kind,
        result: sanitizeResult(input.result, envelope.jobId, envelope.sessionId, sanitize),
      };
      break;
  }

  let event = RunEventSchema.parse(candidate);
  if (eventBytes(event) > maxEventBytes) {
    event = RunEventSchema.parse(minimalEvent(event));
  }
  if (eventBytes(event) > maxEventBytes) {
    throw new HeadlessError("OUTPUT_OVERFLOW", "Run event exceeded its size limit after safe suppression.");
  }
  return event;
}

type SanitizeText = (value: unknown, maxLength: number) => RedactionResult;

function textSanitizer(redact: (value: unknown, maxLength?: number) => RedactionResult): SanitizeText {
  return (value, maxLength) => {
    try {
      const result = redact(value, maxLength);
      if (!result || typeof result.text !== "string") throw new Error("invalid redaction result");
      return result;
    } catch {
      // Fail closed: the original value and redactor error are both discarded.
      return { text: "[SUPPRESSED: REDACTION_FAILED]", redacted: true, truncated: true };
    }
  };
}

function sanitizeResult(result: RunResult, jobId: string, sessionId: string | null, sanitize: SanitizeText): RunResult {
  const output = sanitize(result.output, 48 * 1024);
  const stderr = sanitize(result.stderr, 48 * 1024);
  const diagnosticMessages = result.diagnostics.messages.slice(0, 64).map((message) => sanitize(message, 2_048).text);
  const sanitizedDiff = result.diff === null ? null : sanitizeDiff(result.diff, sanitize);
  const diff = sanitizedDiff?.value ?? null;
  const details = result.error?.details === undefined ? undefined : sanitizeUnknown(result.error.details, sanitize);
  return {
    ...result,
    backend: sanitize(result.backend, 64).text,
    output: output.text,
    stderr: stderr.text,
    diagnostics: {
      ...result.diagnostics,
      format: sanitize(result.diagnostics.format, 128).text,
      messages: diagnosticMessages,
    },
    error: result.error === null ? null : {
      ...result.error,
      message: sanitize(result.error.message, 16_384).text,
      ...(details === undefined ? {} : { details }),
    },
    signal: result.signal === null ? null : sanitize(result.signal, 64).text,
    cost: {
      ...result.cost,
      pricingId: result.cost.pricingId === null ? null : sanitize(result.cost.pricingId, 256).text,
    },
    containment: {
      ...result.containment,
      mechanism: result.containment.mechanism === null ? null : sanitize(result.containment.mechanism, 256).text,
      probe: result.containment.probe === null ? null : sanitize(result.containment.probe, 2_048).text,
    },
    sessionId,
    jobId,
    diff,
    commit: result.commit === null ? null : {
      base: nullableText(result.commit.base, 128, sanitize),
      candidate: nullableText(result.commit.candidate, 128, sanitize),
      result: nullableText(result.commit.result, 128, sanitize),
      merged: result.commit.merged,
    },
    truncation: {
      ...result.truncation,
      output: result.truncation.output || output.truncated,
      stderr: result.truncation.stderr || stderr.truncated,
      diff: result.truncation.diff || (sanitizedDiff?.truncated ?? false),
    },
  };
}

function sanitizeDiff(diff: NonNullable<RunResult["diff"]>, sanitize: SanitizeText) {
  const patch = sanitize(diff.patch, 24 * 1024);
  const status = sanitize(diff.status, 8 * 1024);
  const files = diff.files.slice(0, 64).map((file) => sanitize(file, 512).text);
  const truncated = patch.truncated || status.truncated || files.length < diff.files.length;
  return {
    value: {
      patch: patch.text,
      status: status.text,
      files,
      baseCommit: nullableText(diff.baseCommit, 128, sanitize),
      candidateCommit: nullableText(diff.candidateCommit, 128, sanitize),
      resultingCommit: nullableText(diff.resultingCommit, 128, sanitize),
    },
    truncated,
  };
}

function nullableText(value: string | null, maxLength: number, sanitize: SanitizeText) {
  return value === null ? null : sanitize(value, maxLength).text;
}

function sanitizeUnknown(value: unknown, sanitize: SanitizeText) {
  let nodes = 0;
  const walk = (entry: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > 256 || depth > 5) return "[SUPPRESSED: DETAIL_LIMIT]";
    if (typeof entry === "string") return sanitize(entry, 2_048).text;
    if (entry === null || typeof entry === "number" || typeof entry === "boolean") return entry;
    if (Array.isArray(entry)) return entry.slice(0, 64).map((item) => walk(item, depth + 1));
    if (entry && typeof entry === "object") {
      const output: Record<string, unknown> = {};
      for (const [rawKey, item] of Object.entries(entry).slice(0, 64)) {
        const key = sanitize(rawKey, 128).text;
        output[key] = walk(item, depth + 1);
      }
      return output;
    }
    return sanitize(String(entry), 2_048).text;
  };
  return walk(value, 0) as Record<string, unknown>;
}

function minimalEvent(event: RunEvent): RunEvent {
  if (event.kind === "completion") {
    return {
      ...event,
      result: {
        ...event.result,
        output: "[SUPPRESSED: EVENT_SIZE_LIMIT]",
        stderr: "[SUPPRESSED: EVENT_SIZE_LIMIT]",
        error: event.result.error === null ? null : {
          ...event.result.error,
          message: event.result.error.message.slice(0, 512),
          details: undefined,
        },
        diagnostics: {
          ...event.result.diagnostics,
          format: event.result.diagnostics.format.slice(0, 64),
          messages: ["Completion event payload exceeded its size limit."],
        },
        containment: {
          ...event.result.containment,
          mechanism: event.result.containment.mechanism?.slice(0, 128) ?? null,
          probe: null,
        },
        diff: null,
        truncation: { ...event.result.truncation, stdout: true, stderr: true, output: true, events: true, artifacts: true, diff: true },
      },
    };
  }
  if (event.kind === "stdout" || event.kind === "stderr") return { ...event, text: "[SUPPRESSED: EVENT_SIZE_LIMIT]", truncated: true };
  if (event.kind === "lifecycle") return { ...event, detail: "[SUPPRESSED: EVENT_SIZE_LIMIT]" };
  if (event.kind === "tool") return { ...event, summary: "[SUPPRESSED: EVENT_SIZE_LIMIT]" };
  if (event.kind === "policy") return { ...event, reason: "[SUPPRESSED: EVENT_SIZE_LIMIT]" };
  if (event.kind === "artifact") return { ...event, summary: "[SUPPRESSED: EVENT_SIZE_LIMIT]", truncated: true };
  return event;
}

function eventBytes(event: RunEvent) {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}
