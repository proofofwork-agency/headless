import type { ParserDiagnostics, JsonParseResult, NormalizedTokenUsage } from "./json";
import { emptyTokenUsage, legacyTokenCount, normalizeTokenUsage } from "./json";
import type { RunErrorCode } from "../contracts/common";
import { redactAndTruncate } from "../runtime/redaction";

export type NormalizedAdapterResult = Required<Pick<JsonParseResult,
  "output" | "cost" | "tokens" | "error" | "usage" | "diagnostics"
>>;

export type AdapterFailureClassification = {
  code: RunErrorCode;
  retryable: boolean;
  status: "failed" | "blocked";
};

/** Normalize built-in and third-party adapter output at the trust boundary. */
export function normalizeAdapterResult(value: JsonParseResult, fallbackFormat = "adapter-result"): NormalizedAdapterResult {
  const source = asRecord(value);
  const diagnostics = normalizeDiagnostics(source?.diagnostics, fallbackFormat);
  const output = typeof source?.output === "string" ? source.output : "";
  const error = typeof source?.error === "string" && source.error.length > 0 ? source.error : null;
  const cost = nonnegativeFinite(source?.cost);
  if (source?.cost !== null && source?.cost !== undefined && cost === null) addDiagnostic(diagnostics, "Adapter reported an invalid cost; cost was suppressed.");

  const explicitTokens = tokenNumber(source?.tokens);
  if (source?.tokens !== null && source?.tokens !== undefined && explicitTokens === null) {
    addDiagnostic(diagnostics, "Adapter reported an invalid token total; total was suppressed.");
  }
  const normalized = source?.usage === undefined ? emptyTokenUsage() : normalizeTokenUsage(source.usage);
  const validUsageFields = Object.values(normalized).some((entry) => entry !== null);
  const usage: NormalizedTokenUsage = {
    ...normalized,
    providerTotal: normalized.providerTotal ?? explicitTokens,
  };
  const tokens = legacyTokenCount(usage);
  if (source?.usage !== undefined && !validUsageFields) {
    addDiagnostic(diagnostics, "Adapter usage was present but contained no valid non-negative integer counters.");
  }
  if (typeof source?.output !== "string") addDiagnostic(diagnostics, "Adapter output was not text and was suppressed.");
  if (source?.error !== null && source?.error !== undefined && typeof source.error !== "string") {
    addDiagnostic(diagnostics, "Adapter error was not text and was suppressed.");
  }
  return { output, error, cost, tokens, usage, diagnostics };
}

export function appendAdapterDiagnostic(
  diagnostics: ParserDiagnostics,
  message: string,
  options: { malformed?: number; ignored?: number } = {},
) {
  diagnostics.malformedEvents = boundedCounter(diagnostics.malformedEvents + (options.malformed ?? 0));
  diagnostics.ignoredEvents = boundedCounter(diagnostics.ignoredEvents + (options.ignored ?? 0));
  addDiagnostic(diagnostics, message);
  return diagnostics;
}

/** Convert bounded CLI/provider diagnostics into stable public error classes. */
export function classifyAdapterFailure(input: {
  authMode: "native-login" | "broker";
  error: string | null;
  output: string;
  stderr: string;
  malformedEvents?: number;
}): AdapterFailureClassification {
  const evidence = `${input.error ?? ""}\n${input.output}\n${input.stderr}`.slice(0, 65_536);
  if (/(?:rate[ -]?limit|too many requests|http\s*429|status(?: code)?\s*429|retry[- ]after|quota (?:is )?exceeded)/i.test(evidence)) {
    return { code: "RATE_LIMITED", retryable: true, status: "failed" };
  }
  if (/(?:approval (?:is )?required|requires? approval|permission request|tool (?:use )?awaiting approval|not approved|user rejected permission)/i.test(evidence)) {
    return { code: "APPROVAL_REQUIRED", retryable: false, status: "blocked" };
  }
  if (input.authMode === "native-login" && /(?:not (?:logged|signed) in|please (?:log|sign) in|login required|authentication (?:is )?(?:required|unavailable|failed)|unauthori[sz]ed|invalid (?:oauth|auth|credential)|(?:oauth|credential|access token).*(?:missing|expired|unavailable))/i.test(evidence)) {
    return { code: "NATIVE_AUTH_UNAVAILABLE", retryable: false, status: "blocked" };
  }
  if ((input.malformedEvents ?? 0) > 0 && input.error) {
    return { code: "PARSE_ERROR", retryable: false, status: "failed" };
  }
  return { code: "PROCESS_ERROR", retryable: false, status: "failed" };
}

function normalizeDiagnostics(value: unknown, fallbackFormat: string): ParserDiagnostics {
  const record = asRecord(value);
  const messages = Array.isArray(record?.messages)
    ? record.messages.flatMap((message) => typeof message === "string" ? [safeText(message, 2_048)] : []).slice(0, 64)
    : [];
  return {
    format: safeText(typeof record?.format === "string" && record.format ? record.format : fallbackFormat, 128),
    malformedEvents: boundedCounter(record?.malformedEvents),
    ignoredEvents: boundedCounter(record?.ignoredEvents),
    messages,
  };
}

function addDiagnostic(diagnostics: ParserDiagnostics, message: string) {
  if (diagnostics.messages.length < 64) diagnostics.messages.push(safeText(message, 2_048));
}

function boundedCounter(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function tokenNumber(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function nonnegativeFinite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function safeText(value: string, limit: number) {
  try {
    return redactAndTruncate(value, limit).text.slice(0, limit);
  } catch {
    return "[SUPPRESSED: REDACTION FAILURE]";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
