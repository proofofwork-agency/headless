import type { SerializedRunRequest, RunResult } from "../contracts/run";
import type { ExperimentalExecResult } from "./exec-result";

/** Temporary bridge while experimental write/session runners are retired. */
export function experimentalExecResultToRunResult(
  result: ExperimentalExecResult,
  request: SerializedRunRequest,
  jobId: string,
): RunResult {
  const status = result.status ?? (result.timedOut ? "timed_out" : result.ok ? "succeeded" : "failed");
  return {
    status,
    error: result.ok
      ? null
      : result.error ?? {
          code: result.timedOut ? "TIMED_OUT" : status === "cancelled" ? "CANCELLED" : "PROCESS_ERROR",
          message: result.output || "Backend execution failed.",
          retryable: false,
        },
    backend: result.backend,
    output: result.output,
    stderr: result.stderr ?? "",
    diagnostics: result.diagnostics ?? { format: "experimental", malformedEvents: 0, ignoredEvents: 0, messages: [] },
    exitCode: result.exitCode,
    signal: result.signal ?? null,
    usage: result.usage ?? { input: null, output: result.tokens, reasoning: null, cached: null, providerTotal: result.tokens },
    cost: typeof result.cost === "number"
      ? { amountUsd: result.cost, source: "provider", pricingId: null, observedRequests: 0 }
      : result.cost && typeof result.cost === "object"
        ? result.cost
        : { amountUsd: null, source: "unknown", pricingId: null, observedRequests: 0 },
    containment: result.containment ?? fallbackContainment(result, request),
    durationMs: result.durationMs,
    sessionId: request.sessionId ?? null,
    jobId,
    diff: result.diff ? {
      ...result.diff,
      baseCommit: result.diff.baseCommit ?? result.commit?.base ?? null,
      candidateCommit: result.diff.candidateCommit ?? result.commit?.candidate ?? null,
      resultingCommit: result.diff.resultingCommit ?? result.commit?.result ?? null,
    } : null,
    commit: result.commit ?? null,
    truncation: {
      stdout: false,
      stderr: false,
      output: !!(result.outputTruncated ?? result.truncated),
      events: false,
      artifacts: false,
      diff: !!result.diffTruncated,
    },
  };
}

function fallbackContainment(result: ExperimentalExecResult, request: SerializedRunRequest): RunResult["containment"] {
  const platform = process.platform === "darwin" || process.platform === "linux" || process.platform === "win32"
    ? process.platform
    : "other";
  return {
    requirement: request.containment,
    enforced: !!result.sandboxed,
    platform,
    mechanism: result.sandboxReason ?? null,
    probe: result.sandboxReason ?? null,
    isolatedHome: false,
    credentialsIsolated: false,
    network: request.containment === "unsafe"
      ? "unrestricted"
      : request.authMode === "native-login" ? "native-direct-unrestricted" : "denied",
    credentialAccess: request.authMode === "native-login" ? "backend-native" : "none",
    unsafe: request.containment === "unsafe",
  };
}
