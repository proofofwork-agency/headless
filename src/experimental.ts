/**
 * Unstable compatibility exports for private-alpha orchestration code.
 * Nothing in this module is covered by the first beta stability promise.
 */
export {
  BrokerBudgetQuotaSchema,
  BrokerLeaseScopeSchema,
  type BrokerBudgetQuota,
  type BrokerLeaseScope,
  type BrokerRequestLog,
} from "./broker/server";
export type { Job } from "./contracts/durable";
export { RunEventSchema, RunRequestSchema, RunResultSchema } from "./contracts/run";
export type { ExperimentalExecResult } from "./experimental/exec-result";
export { experimentalExecResultToRunResult } from "./experimental/run-result-converter";
export { getProvider, listProviders, registerProvider, unregisterProvider, type ProviderDefinition } from "./broker/providers";
export {
  assertModeAllowed,
  backendDefinitions,
  getBackendDefinition,
  listBackendDefinitions,
  registerBackendDefinition,
  resolveBackendId,
  unregisterBackendDefinition,
  type BackendDefinition,
  type BackendDefinitionProbeSpec,
  type BackendDefinitionSecurity,
} from "./backends/registry";
export { probeBackendDefinition, type ProbeExecution, type ProbeExecutor } from "./backends/probe";
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
export { safeOption, positiveTimeout, supportedPlatform } from "./runtime/validation";
export { signalProcessTree, terminateProcessTree as terminateChildProcessTree } from "./runtime/process-tree";
export { installNativeAuthCapsule, type NativeAuthCapsuleOptions, type NativeAuthCapsuleResult } from "./runtime/native-auth-capsule";
export { resolveOpenCodeNativeModel, type OpenCodeNativeModelResolution } from "./runtime/opencode-native-model";
export { NativeSessionManager } from "./runtime/native-session-manager";
export { DelegationScheduler, DelegationSchedulerError } from "./runtime/delegation-scheduler";
export * from "./runtime/goal-delegation-runtime";
export { DirectedMailbox, DirectedMailboxError } from "./runtime/directed-mailbox";
export { DeterministicIdleOpportunityDetector, detectIdleOpportunities } from "./runtime/idle-opportunity-detector";
export * from "./runtime/idle-autonomy-service";
export { scoreLeaderCandidate, selectStickyLeader } from "./runtime/leader-selector";
export * from "./runtime/leader-election";
export * from "./runtime/candidate-integration-service";
export * from "./runtime/candidate-decision-store";
export * from "./runtime/session-drivers/index";
export { HeadlessDaemon, type HeadlessDaemonOptions } from "./daemon/server";
export { getProjectStatePaths, getHeadlessStateHome, canonicalizeProjectRoot, projectIdForRoot } from "./runtime/project-state";
export * from "./runtime/daemon-extensions";
