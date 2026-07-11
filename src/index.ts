/**
 * Headless — Universal AI Coding Agent Runner & Orchestrator
 *
 * Re-exports and thin unified surface for adapters, orchestration,
 * and the native .headless ledger runtime.
 */

export type { Backend } from "./backends/ids";
export * from "./contracts/index";
export {
  BrokerBudgetQuotaSchema,
  BrokerLeaseScopeSchema,
  type BrokerBudgetQuota,
  type BrokerLeaseScope,
  type BrokerRequestLog,
} from "./broker/server";
export { getProvider, listProviders, registerProvider, unregisterProvider, type ProviderDefinition } from "./broker/providers";
export { backendChoices, normalizeBackend } from "./backends/ids";
export { backendMetadata, type BackendMetadata } from "./backends/metadata";
export {
  assertModeAllowed,
  backendAdapters,
  getAdapter,
  listAdapters,
  registerAdapter,
  resolveAdapterId,
  unregisterAdapter,
  type BackendAdapter,
  type BackendAdapterProbeSpec,
  type BackendAdapterSecurity,
} from "./backends/registry";
export { probeBackendAdapter, type ProbeExecution, type ProbeExecutor } from "./backends/probe";
export type { ArtifactStatus, HeadlessEvent, HeadlessEventType } from "./runtime/events";
export {
  isEventOfType,
  isNoteEvent,
  isArtifactEvent,
  isHandoffEvent,
  isHeadlessResultEvent,
  isAskForMoreWorkEvent,
  isAskForBackupEvent,
  isMessageEvent,
  isReleaseGateEvent,
  isTaskClaimEvent,
  isConsensusVoteEvent,
} from "./runtime/events";
export type { ReadContextView, TaskState } from "./runtime/read-model";
export { getCooperationInstructions } from "./runtime/cooperation";
export { splitList } from "./utils/list";
export { PricingEntrySchema, registerPricing, unregisterPricing, listPricing, resolvePricing, calculatePricedCost, type PricingEntry } from "./runtime/pricing";
export { Semaphore, withBoundedConcurrency, createLimiter } from "./runtime/concurrency";
export { HeadlessError, errorCode, isHeadlessError, toHeadlessError, toStructuredError } from "./runtime/headless-error";
export { safeOption, positiveTimeout, supportedPlatform } from "./runtime/validation";
export { signalProcessTree, terminateProcessTree as terminateChildProcessTree } from "./runtime/process-tree";
export { installNativeAuthCapsule, type NativeAuthCapsuleOptions, type NativeAuthCapsuleResult } from "./runtime/native-auth-capsule";
export { resolveOpenCodeNativeModel, type OpenCodeNativeModelResolution } from "./runtime/opencode-native-model";
export { NativeSessionManager } from "./runtime/native-session-manager";
export { DelegationScheduler, DelegationSchedulerError } from "./runtime/delegation-scheduler";
export {
  GoalDelegationRuntime,
  type GoalDelegationAttempt,
  type GoalDelegationEvent,
  type GoalDelegationRunInput,
} from "./runtime/goal-delegation-runtime";
export { DirectedMailbox, DirectedMailboxError } from "./runtime/directed-mailbox";
export { DeterministicIdleOpportunityDetector, detectIdleOpportunities } from "./runtime/idle-opportunity-detector";
export {
  IdleAutonomyService,
  deriveIdleAutonomyEvidence,
  type IdleAutonomyAction,
  type IdleAutonomyEvidence,
  type IdleAutonomyScanReport,
  type IdleAutonomyServiceOptions,
  type IdleSuggestionLane,
  type IdleWorktreeLease,
} from "./runtime/idle-autonomy-service";
export { scoreLeaderCandidate, selectStickyLeader } from "./runtime/leader-selector";
export {
  CouncilElectionBallotSchema,
  CouncilElectionRankingSchema,
  CouncilElectionRoundSchema,
  CouncilLeaderElectionDecisionSchema,
  CouncilLeaderElectionInputSchema,
  LeaderElectionError,
  createCouncilLeaderBallot,
  runCouncilLeaderElection,
  tallyCouncilLeaderElection,
  type CouncilElectionBallot,
  type CouncilElectionRound,
  type CouncilLeaderElectionDecision,
  type CouncilLeaderElectionInput,
  type LeaderElectionErrorCode,
} from "./runtime/leader-election";
export {
  CandidateIntegrationService,
  type CandidateAuthorizationContext,
  type CandidateInspection,
  type CandidateIntegrationServiceOptions,
} from "./runtime/candidate-integration-service";
export {
  CandidateDecisionStore,
  type CandidateDecisionRecord,
  type CandidateIntegrationAttempt,
  type CandidateIntegrationOutcome,
} from "./runtime/candidate-decision-store";
export * from "./runtime/session-drivers/index";
export { connectOrStartDaemon, type ConnectDaemonOptions } from "./daemon/connect";
export { HeadlessDaemonClient, MAX_DAEMON_TRANSPORT_TIMEOUT_MS, type HeadlessDaemonClientOptions } from "./daemon/client";
export { HeadlessDaemon, type HeadlessDaemonOptions } from "./daemon/server";
export { getProjectStatePaths, getHeadlessStateHome, canonicalizeProjectRoot, projectIdForRoot } from "./runtime/project-state";
export {
  resolveDaemonExtensionConfig,
  type HeadlessExtensionApi,
  type HeadlessExtensionRegistration,
  type LoadedDaemonExtensions,
  type ResolvedDaemonExtensionConfig,
  type ResolveDaemonExtensionConfigOptions,
} from "./runtime/daemon-extensions";

import type { Backend } from "./backends/ids";
import { resolveAdapterId } from "./backends/registry";
import { HeadlessError } from "./runtime/headless-error";

export interface ExecOptions {
  backend: Backend | string;
  prompt: string;
  cwd?: string;
  mode?: "read-only" | "write";
  model?: string;
  agent?: string;
  timeoutMs?: number;
  /** Fail-closed by default. Unsafe execution must be explicitly requested. */
  containment?: "required" | "unsafe";
  /** Programmatic cancellation. */
  signal?: AbortSignal;
  sessionId?: string;
  /** Use the installed coder's scoped subscription login, or a daemon broker lease. */
  authMode?: import("./contracts/native").AuthMode;
  /** Tool/merge approval behavior; containment and finality remain mandatory. */
  approvalPolicy?: import("./contracts/native").ApprovalPolicy;
  /** Completion callback retained for lightweight callers; daemon events provide live streaming. */
  onStdoutChunk?: (chunk: string) => void;
  /** Absolute trusted startup config used only when connecting/bootstrapping the daemon. */
  extensionConfigPath?: string;
  /** Absolute trusted extension entrypoints; never serialized into RunRequest. */
  extensionModules?: readonly string[];
}

export interface ExecResult {
  ok: boolean;
  backend: string;
  output: string;
  cost: number | null;
  tokens: number | null;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  status?: "succeeded" | "failed" | "timed_out" | "cancelled" | "blocked";
  error?: import("./contracts/common").StructuredError | null;
  stderr?: string;
  diagnostics?: import("./contracts/run").RunResult["diagnostics"];
  signal?: string | null;
  usage?: import("./contracts/run").RunResult["usage"];
  containment?: import("./contracts/run").RunResult["containment"];
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
  writeOutcome?: import("./runtime/write-integration").WriteMergeOutcome | null;
  sandboxed?: boolean;
  sandboxReason?: string;
  /** Redaction/truncation flags from secret scrubbing (populated by runner + headlessRun redaction paths). */
  redacted?: boolean;
  truncated?: boolean;
  outputTruncated?: boolean;
  diffTruncated?: boolean;
}

/**
 * exec() — public simple entry for direct one-off contained execution.
 * Submits through the authenticated project daemon so policy, budgets, events,
 * cancellation, and durable job state have one authority.
 */
export async function exec(opts: ExecOptions): Promise<ExecResult> {
  const { connectOrStartDaemon } = await import("./daemon/connect.js");
  const { RunRequestSchema } = await import("./contracts/run.js");
  const projectRoot = (await import("./runtime/project-state.js")).canonicalizeProjectRoot(opts.cwd ?? process.cwd());
  let backend: string;
  try {
    backend = resolveAdapterId(opts.backend);
  } catch {
    // Registered extension adapters may live in the already-running daemon
    // rather than this client process. The daemon remains the authority that
    // resolves and validates the final adapter id.
    backend = String(opts.backend).trim();
  }
  const validated = RunRequestSchema.parse({
    backend,
    prompt: opts.prompt,
    projectRoot,
    mode: opts.mode,
    model: opts.model,
    agent: opts.agent,
    timeoutMs: opts.timeoutMs,
    sessionId: opts.sessionId,
    containment: opts.containment,
    authMode: opts.authMode,
    approvalPolicy: opts.approvalPolicy,
  });
  const client = await connectOrStartDaemon({
    projectRoot,
    extensionConfigPath: opts.extensionConfigPath,
    extensionModules: opts.extensionModules,
  });
  const { projectRoot: _daemonOwnedProjectRoot, ...submittedRequest } = validated;
  const submitted = await client.call<import("./contracts/durable").Job>("run.submit", submittedRequest);
  const cancel = () => { void client.call("run.cancel", { jobId: submitted.id }, 2_000).catch(() => {}); };
  opts.signal?.addEventListener("abort", cancel, { once: true });
  if (opts.signal?.aborted) cancel();
  try {
    const waitTimeoutMs = Math.min(validated.timeoutMs + 10_000, 86_400_000);
    const completed = submitted.result
      ? submitted
      : await waitForExecJob(client, submitted.id, waitTimeoutMs);
    if (!completed.result) throw new Error("Daemon returned a terminal job without a result.");
    const result = legacyExecResult(completed.result);
    if (result.output) opts.onStdoutChunk?.(result.output);
    return result;
  } finally {
    opts.signal?.removeEventListener("abort", cancel);
  }
}

async function waitForExecJob(
  client: import("./daemon/client").HeadlessDaemonClient,
  jobId: string,
  waitTimeoutMs: number,
) {
  try {
    return await client.call<import("./contracts/durable").Job>(
      "run.wait",
      { jobId, timeoutMs: waitTimeoutMs },
      waitTimeoutMs + 5_000,
    );
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "TIMED_OUT") throw error;
    // The daemon owns the total lifecycle deadline. At the 24-hour public
    // boundary the wait timeout cannot include extra server-side grace, so poll
    // the durable terminal result briefly rather than throwing an expected
    // timeout as an exception or leaving queued work unattended.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const job = await client.call<import("./contracts/durable").Job>("run.status", { jobId }, 2_000);
      if (job.result) return job;
      await Bun.sleep(25);
    }
    await client.call("run.cancel", { jobId }, 2_000).catch(() => {});
    const job = await client.call<import("./contracts/durable").Job>("run.status", { jobId }, 2_000);
    if (job.result) return job;
    throw new HeadlessError("DAEMON_UNAVAILABLE", "Daemon did not persist a terminal result after the total lifecycle deadline.");
  }
}

function legacyExecResult(result: import("./contracts/run").RunResult): ExecResult {
  const tokens = result.usage.providerTotal
    ?? (result.usage.input !== null && result.usage.output !== null ? result.usage.input + result.usage.output : null);
  return {
    ok: result.status === "succeeded",
    backend: result.backend,
    output: result.output,
    stderr: result.stderr,
    diagnostics: result.diagnostics,
    cost: result.cost.amountUsd,
    tokens,
    usage: result.usage,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.status === "timed_out",
    status: result.status,
    error: result.error,
    containment: result.containment,
    diff: result.diff,
    commit: result.commit,
    sandboxed: result.containment.enforced,
    sandboxReason: result.containment.mechanism ?? undefined,
    redacted: true,
    truncated: Object.values(result.truncation).some(Boolean),
  };
}
