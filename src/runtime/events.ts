import type { ExecResult } from "../index";

export type HeadlessEventType =
  | "session_started"
  | "note"
  | "artifact"
  | "run_started"
  | "worker_spawned"
  | "headless_result"
  | "handoff"
  | "finality_proposal";

export type ArtifactStatus = "passed" | "failed" | "blocked" | "unknown" | "skipped" | "timed_out";

export type HeadlessEvent = {
  schema: "v1";
  id: string;
  timestamp: number;
  sessionId: string;
  seq?: number;
  prevHash?: string | null;
  hash?: string;
  type: HeadlessEventType;
  source: string;
  content?: string;
  runId?: string;
  workerId?: string;
  handoff?: {
    from: string;
    to: string;
    reason: string;
    ask: string;
    contextRefs?: string[];
    nextSpeaker?: string;
  };
  artifact?: {
    kind: string;
    title: string;
    summary: string;
    status: ArtifactStatus;
    evidence?: string[];
  };
  result?: ExecResult;
  handlesHandoffId?: string;
  handlesHandoffIds?: string[];
  meta?: Record<string, unknown>;
};

export type EventInput = Omit<HeadlessEvent, "schema" | "id" | "timestamp" | "sessionId" | "seq" | "prevHash" | "hash"> & {
  id?: string;
  timestamp?: number;
};
