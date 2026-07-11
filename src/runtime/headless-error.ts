import {
  MAX_ERROR_DETAILS_BYTES,
  MAX_ERROR_MESSAGE_LENGTH,
  RunErrorCodeSchema,
  type RunErrorCode,
  type StructuredError,
} from "../contracts/common";
import { redactAndTruncate } from "./redaction";

const ERROR_DETAIL_DEPTH = 8;
const ERROR_DETAIL_ENTRIES = 128;
const ERROR_DETAIL_STRING_LENGTH = 4_096;

export type HeadlessErrorOptions = {
  retryable?: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
};

export type HeadlessErrorFallback = {
  code?: RunErrorCode;
  safeMessage?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
};

/**
 * An error that is safe to cross the daemon boundary.
 *
 * Callers must still provide a user-facing message rather than forwarding an
 * arbitrary exception. The constructor applies a final secret-redaction and
 * size bound before exposing it as `message`/`safeMessage`.
 */
export class HeadlessError extends Error {
  readonly safeMessage: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    readonly code: RunErrorCode,
    safeMessage: string,
    options: HeadlessErrorOptions = {},
  ) {
    const message = boundedSafeMessage(safeMessage);
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HeadlessError";
    this.safeMessage = message;
    this.retryable = options.retryable ?? false;
    this.details = boundedErrorDetails(options.details);
  }

  toStructuredError(): StructuredError {
    return {
      code: this.code,
      message: this.safeMessage,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function isHeadlessError(value: unknown): value is HeadlessError {
  return value instanceof HeadlessError;
}

export function isRunErrorCode(value: unknown): value is RunErrorCode {
  return RunErrorCodeSchema.safeParse(value).success;
}

/** Convert an unknown failure without exposing an unclassified raw message. */
export function toHeadlessError(
  error: unknown,
  fallback: HeadlessErrorFallback = {},
): HeadlessError {
  if (error instanceof HeadlessError) return error;
  const coded = codedError(error);
  if (coded) {
    return new HeadlessError(coded.code, coded.safeMessage, {
      retryable: coded.retryable ?? fallback.retryable,
      details: coded.details ?? fallback.details,
      cause: error,
    });
  }
  return new HeadlessError(
    fallback.code ?? "INTERNAL_ERROR",
    fallback.safeMessage ?? "Headless could not complete the request.",
    { retryable: fallback.retryable, details: fallback.details, cause: error },
  );
}

export function toStructuredError(
  error: unknown,
  fallback: HeadlessErrorFallback = {},
): StructuredError {
  return toHeadlessError(error, fallback).toStructuredError();
}

export function errorCode(error: unknown, fallback: RunErrorCode = "INTERNAL_ERROR") {
  if (error instanceof HeadlessError) return error.code;
  if (error && typeof error === "object" && "code" in error && isRunErrorCode(error.code)) return error.code;
  return fallback;
}

function codedError(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error) || !isRunErrorCode(error.code)) return null;
  const safeMessage = "safeMessage" in error && typeof error.safeMessage === "string"
    ? error.safeMessage
    : "message" in error && typeof error.message === "string"
      ? error.message
      : "Headless could not complete the request.";
  const retryable = "retryable" in error && typeof error.retryable === "boolean" ? error.retryable : undefined;
  const details = "details" in error && isRecord(error.details) ? error.details : undefined;
  return { code: error.code, safeMessage, retryable, details };
}

function boundedSafeMessage(value: string) {
  const input = typeof value === "string" ? value : "Headless could not complete the request.";
  try {
    const redacted = redactAndTruncate(input, MAX_ERROR_MESSAGE_LENGTH).text;
    return redacted.trim().slice(0, MAX_ERROR_MESSAGE_LENGTH) || "Headless could not complete the request.";
  } catch {
    return "Headless could not complete the request.";
  }
}

function boundedErrorDetails(details: Record<string, unknown> | undefined) {
  if (!details) return undefined;
  try {
    const normalized = normalizeDetail(details, 0, new WeakSet());
    if (!isRecord(normalized)) return undefined;
    const serialized = JSON.stringify(normalized);
    if (Buffer.byteLength(serialized) <= MAX_ERROR_DETAILS_BYTES) return normalized;
  } catch {
    return { suppressed: "Error details could not be safely serialized." };
  }
  return { suppressed: "Error details exceeded the safe serialization bound." };
}

function normalizeDetail(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return boundedDetailString(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return String(value);
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return undefined;
  if (depth >= ERROR_DETAIL_DEPTH) return "[MAX_DEPTH]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const entries = value.slice(0, ERROR_DETAIL_ENTRIES).map((entry) => normalizeDetail(entry, depth + 1, seen));
      if (value.length > ERROR_DETAIL_ENTRIES) entries.push(`[TRUNCATED ${value.length - ERROR_DETAIL_ENTRIES} entries]`);
      return entries;
    }
    const output: Record<string, unknown> = {};
    const entries = Object.entries(value).slice(0, ERROR_DETAIL_ENTRIES);
    for (const [key, entry] of entries) {
      const normalized = normalizeDetail(entry, depth + 1, seen);
      if (normalized !== undefined) output[key.slice(0, 256)] = normalized;
    }
    const omitted = Object.keys(value).length - entries.length;
    if (omitted > 0) output._truncated = `${omitted} entries`;
    return output;
  } finally {
    seen.delete(value);
  }
}

function boundedDetailString(value: string) {
  try {
    return redactAndTruncate(value, ERROR_DETAIL_STRING_LENGTH).text.slice(0, ERROR_DETAIL_STRING_LENGTH);
  } catch {
    return "[SUPPRESSED: REDACTION FAILURE]";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
