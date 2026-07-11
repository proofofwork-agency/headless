import { redactAndTruncate } from "./redaction";

export type RuntimeDiagnosticCategory = "cleanup" | "state" | "stream-callback" | "transport";
export type RuntimeDiagnosticSeverity = "warning" | "error";

export type RuntimeDiagnostic = {
  sequence: number;
  timestamp: number;
  category: RuntimeDiagnosticCategory;
  severity: RuntimeDiagnosticSeverity;
  scope: string;
  message: string;
};

const MAX_RUNTIME_DIAGNOSTICS = 256;
const MAX_DIAGNOSTIC_TEXT = 2_048;
const diagnostics: RuntimeDiagnostic[] = [];
let sequence = 0;

/**
 * Process-local, bounded diagnostics for failures that cannot safely be added
 * to a durable result (for example a best-effort reader lock release). Raw
 * error text is redacted before it is retained.
 */
export function recordRuntimeDiagnostic(
  category: RuntimeDiagnosticCategory,
  scope: string,
  error: unknown,
  severity: RuntimeDiagnosticSeverity = category === "cleanup" || category === "stream-callback" ? "warning" : "error",
) {
  const diagnostic: RuntimeDiagnostic = {
    sequence: ++sequence,
    timestamp: Date.now(),
    category,
    severity,
    scope: boundedText(scope, 160),
    message: boundedError(error),
  };
  diagnostics.push(diagnostic);
  if (diagnostics.length > MAX_RUNTIME_DIAGNOSTICS) diagnostics.splice(0, diagnostics.length - MAX_RUNTIME_DIAGNOSTICS);
  return { ...diagnostic };
}

export function listRuntimeDiagnostics(options: { afterSequence?: number; limit?: number } = {}) {
  const after = Number.isSafeInteger(options.afterSequence) && (options.afterSequence ?? 0) >= 0
    ? options.afterSequence ?? 0
    : 0;
  const limit = Number.isSafeInteger(options.limit) && (options.limit ?? 0) > 0
    ? Math.min(options.limit ?? MAX_RUNTIME_DIAGNOSTICS, MAX_RUNTIME_DIAGNOSTICS)
    : MAX_RUNTIME_DIAGNOSTICS;
  return diagnostics.filter((entry) => entry.sequence > after).slice(-limit).map((entry) => ({ ...entry }));
}

/** Test/reset hook; callers should normally consume by sequence instead. */
export function clearRuntimeDiagnostics() {
  diagnostics.length = 0;
  sequence = 0;
}

export function cleanupWithDiagnostic(scope: string, cleanup: (() => void | Promise<void>) | undefined) {
  if (!cleanup) return Promise.resolve();
  try {
    return Promise.resolve(cleanup()).catch((error) => {
      recordRuntimeDiagnostic("cleanup", scope, error);
    });
  } catch (error) {
    recordRuntimeDiagnostic("cleanup", scope, error);
    return Promise.resolve();
  }
}

function boundedError(error: unknown) {
  const raw = error instanceof Error
    ? `${error.name}: ${error.message}`
    : typeof error === "string"
      ? error
      : safeStringify(error);
  return boundedText(raw, MAX_DIAGNOSTIC_TEXT);
}

function boundedText(value: string, limit: number) {
  try {
    return redactAndTruncate(value, limit).text.slice(0, limit);
  } catch {
    return "[SUPPRESSED: REDACTION FAILURE]";
  }
}

function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "Unserializable runtime diagnostic";
  }
}
