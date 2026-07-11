import type { ExecResult } from "../index";

export type HeadlessEventType =
  | "session_started"
  | "note"
  | "artifact"
  | "run_started"
  | "worker_spawned"
  | "headless_result"
  | "handoff"
  | "finality_proposal"
  | "finality_decision"
  | "message"
  | "idle_ask_for_work"
  | "ask_for_more_work"          // explicit "I'm ready for the next task / more work"
  | "ask_for_backup"            // "I'm stuck, need help from another agent"
  | "task_claim"                // claiming part of a shared plan
  | "consensus_vote"            // for council-style decisions
  | "idle_action_result"
  | "idle_evaluation_result"
  | "idle_opportunity"
  | "coordination_checkpoint"
  | "release_gate"
  | "bridge_message";

export type ArtifactStatus = "passed" | "failed" | "blocked" | "unknown" | "skipped" | "timed_out";

interface BaseEvent {
  schema: "v2";
  version: 2;
  id: string;
  eventId: string;
  timestamp: number;
  sessionId: string;
  projectId: string;
  principal: string;
  seq?: number;
  sequence: number;
  prevHash?: string | null;
  previousHash: string | null;
  hash?: string;
  integrity: { algorithm: "sha256" | "hmac-sha256"; keyId: string | null };
  source: string;
  content?: string;
  runId?: string;
  workerId?: string;
  handlesHandoffId?: string;
  handlesHandoffIds?: string[];
  meta?: Record<string, unknown>;
}

export type HeadlessEvent =
  | (BaseEvent & { type: "session_started" })
  | (BaseEvent & { type: "note" })
  | (BaseEvent & { type: "artifact"; artifact?: { kind: string; title: string; summary: string; status: ArtifactStatus; evidence?: string[]; } })
  | (BaseEvent & { type: "run_started"; runId?: string })
  | (BaseEvent & { type: "worker_spawned"; runId?: string; workerId?: string })
  | (BaseEvent & { type: "headless_result"; result?: ExecResult; runId?: string; workerId?: string })
  | (BaseEvent & { type: "handoff"; handoff?: { from: string; to: string; reason: string; ask: string; contextRefs?: string[]; nextSpeaker?: string; } })
  | (BaseEvent & { type: "finality_proposal"; handlesHandoffIds?: string[] })
  | (BaseEvent & { type: "finality_decision" })
  | (BaseEvent & { type: "message"; message?: { from: string; to: string; content: string; kind?: string; } })
  | (BaseEvent & { type: "idle_ask_for_work" })
  | (BaseEvent & { type: "ask_for_more_work" })
  | (BaseEvent & { type: "ask_for_backup" })
  | (BaseEvent & { type: "task_claim" })
  | (BaseEvent & { type: "consensus_vote" })
  | (BaseEvent & { type: "idle_action_result"; artifact?: { kind: string; title: string; summary: string; status: ArtifactStatus; evidence?: string[]; } })
  | (BaseEvent & { type: "idle_evaluation_result" })
  | (BaseEvent & { type: "idle_opportunity" })
  | (BaseEvent & { type: "coordination_checkpoint"; checkpoint?: { gitState?: Record<string, unknown>; summary?: string; } })
  | (BaseEvent & { type: "release_gate"; artifact?: { kind: string; title: string; summary: string; status: ArtifactStatus; evidence?: string[]; } })
  | (BaseEvent & { type: "bridge_message" });

// Type guards for discriminated union (use to narrow safely)
export function isEventOfType<T extends HeadlessEventType>(
  event: HeadlessEvent,
  type: T,
): event is Extract<HeadlessEvent, { type: T }> {
  return event.type === type;
}

export function isNoteEvent(e: HeadlessEvent): e is Extract<HeadlessEvent, { type: "note" }> {
  return e.type === "note";
}

export function isArtifactEvent(e: HeadlessEvent): e is Extract<HeadlessEvent, { type: "artifact" }> {
  return e.type === "artifact";
}

export function isHandoffEvent(e: HeadlessEvent): e is Extract<HeadlessEvent, { type: "handoff" }> {
  return e.type === "handoff";
}

export function isHeadlessResultEvent(e: HeadlessEvent): e is Extract<HeadlessEvent, { type: "headless_result" }> {
  return e.type === "headless_result";
}

export function isAskForMoreWorkEvent(e: HeadlessEvent): e is Extract<HeadlessEvent, { type: "ask_for_more_work" }> {
  return e.type === "ask_for_more_work";
}

export function isAskForBackupEvent(e: HeadlessEvent): e is Extract<HeadlessEvent, { type: "ask_for_backup" }> {
  return e.type === "ask_for_backup";
}

export function isMessageEvent(e: HeadlessEvent): e is Extract<HeadlessEvent, { type: "message" }> {
  return e.type === "message";
}

export function isReleaseGateEvent(e: HeadlessEvent): e is Extract<HeadlessEvent, { type: "release_gate" }> {
  return e.type === "release_gate";
}

export function isTaskClaimEvent(e: HeadlessEvent): e is Extract<HeadlessEvent, { type: "task_claim" }> {
  return e.type === "task_claim";
}

export function isConsensusVoteEvent(e: HeadlessEvent): e is Extract<HeadlessEvent, { type: "consensus_vote" }> {
  return e.type === "consensus_vote";
}

export type EventInput = Omit<HeadlessEvent, "schema" | "version" | "id" | "eventId" | "timestamp" | "sessionId" | "projectId" | "principal" | "seq" | "sequence" | "prevHash" | "previousHash" | "hash" | "integrity"> & {
  id?: string;
  timestamp?: number;
} & Record<string, unknown>; // allow variant-specific fields (artifact, handoff, result, etc.) on inputs for appends in orchestrator/read-model consumers
