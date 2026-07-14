import type { StructuredError } from "../contracts/common";
import type { RunResult } from "../contracts/run";
import type { WriteMergeOutcome } from "../runtime/write-integration";

/**
 * Temporary internal result used by the pre-Beta runner and persistent-session
 * implementation. Stable callers receive RunResult from the daemon boundary.
 */
export interface ExperimentalExecResult {
  ok: boolean;
  backend: string;
  output: string;
  cost: number | null;
  tokens: number | null;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  status?: "succeeded" | "failed" | "timed_out" | "cancelled" | "blocked";
  error?: StructuredError | null;
  stderr?: string;
  diagnostics?: RunResult["diagnostics"];
  signal?: string | null;
  usage?: RunResult["usage"];
  containment?: RunResult["containment"];
  diff?: {
    patch: string;
    status: string;
    files: string[];
    baseCommit?: string | null;
    candidateCommit?: string | null;
    resultingCommit?: string | null;
  } | null;
  worktreeBranch?: string | null;
  commit?: {
    base: string | null;
    candidate: string | null;
    result: string | null;
    merged: boolean;
  } | null;
  writeOutcome?: WriteMergeOutcome | null;
  sandboxed?: boolean;
  sandboxReason?: string;
  redacted?: boolean;
  truncated?: boolean;
  outputTruncated?: boolean;
  diffTruncated?: boolean;
}
