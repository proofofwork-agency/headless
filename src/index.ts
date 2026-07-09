/**
 * Headless — Universal AI Coding Agent Runner & Orchestrator
 *
 * Re-exports and thin unified surface for adapters, orchestration,
 * and the native .headless ledger runtime.
 */

export type { Backend } from "./backends/ids";
export { backendChoices, normalizeBackend } from "./backends/ids";
export { backendMetadata, type BackendMetadata } from "./backends/metadata";
export { assertModeAllowed, backendAdapters, type BackendAdapter } from "./backends/registry";
export type { ArtifactStatus, HeadlessEvent, HeadlessEventType } from "./runtime/events";
export { readContext as replayReadContext, deriveTaskState, type ReadContextView, type TaskState } from "./runtime/read-model";
export { appendEvent, getOrCreateSession, readLedger, readRecentEvents, LedgerIntegrityError, type HeadlessSession } from "./runtime/session";
export {
  appendNote,
  deliberate,
  getReadContext,
  getTaskState,
  headlessRun,
  loadRuntime,
  proposeFinal,
  recordArtifact,
  type DeliberationOptions,
  type HeadlessRunOptions,
} from "./runtime/orchestrator";

import { normalizeBackend, type Backend } from "./backends/ids";

export interface ExecOptions {
  backend: Backend | string;
  prompt: string;
  cwd?: string;
  mode?: "read-only" | "write";
  model?: string;
  agent?: string;
  timeoutMs?: number;
}

export interface ExecResult {
  ok: boolean;
  backend: Backend;
  output: string;
  cost: number | null;
  tokens: number | null;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  diff?: {
    patch: string;
    status: string;
    files: string[];
  } | null;
  worktreeBranch?: string | null;
}

export async function exec(opts: ExecOptions): Promise<ExecResult> {
  const { runHeadless } = await import("./runner/simple.js");
  return runHeadless({
    ...opts,
    backend: normalizeBackend(opts.backend),
  });
}
