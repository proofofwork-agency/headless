import type { HeadlessEvent } from "./events";
import {
  isArtifactEvent,
  isHandoffEvent,
  isHeadlessResultEvent,
  isEventOfType,
} from "./events";

export type ReadContextView = "summary" | "recent" | "raw";

export type HandoffLane = {
  id: string;
  owner: string;
  from: string;
  status: "active" | "handled";
  reason: string;
  ask: string;
  nextSpeaker?: string;
  createdAt: number;
  updatedAt: number;
  handledBy: string[];
};

export type TaskState = {
  sessionId: string | null;
  taskBoard: {
    lanes: HandoffLane[];
    activeCount: number;
    handledCount: number;
    pendingMoreWork: number;   // agents explicitly asking for more work
    backupRequests: number;    // agents asking for backup
  };
  workRequests: Array<{
    type: "more_work" | "backup";
    from: string;
    content: string;
    neededStrength?: string;
    timestamp: number;
  }>;
  taskClaims: Array<{ task: string; claimedBy: string; timestamp: number }>;
  artifacts: Array<{ kind: string; title: string; summary: string; status: string; evidence?: string[] }>; // variant payload from artifact etc events
  finality: {
    proposals: HeadlessEvent[];
    blockers: string[];
  };
  runs: {
    total: number;
    failed: number;
    timedOut: number;
  };
};

export function emptyTaskState(sessionId: string | null = null): TaskState {
  return {
    sessionId,
    taskBoard: { lanes: [], activeCount: 0, handledCount: 0, pendingMoreWork: 0, backupRequests: 0 },
    workRequests: [],
    taskClaims: [],
    artifacts: [],
    finality: { proposals: [], blockers: [] },
    runs: { total: 0, failed: 0, timedOut: 0 },
  };
}

/** Incremental, size-bounded semantic projection used by daemon read APIs. */
export function projectTaskState(previous: TaskState, event: HeadlessEvent): TaskState {
  const state = structuredClone(previous);
  state.sessionId = event.sessionId;
  for (const id of handledIds(event)) {
    const lane = state.taskBoard.lanes.find((candidate) => candidate.id === id);
    if (!lane || lane.handledBy.includes(event.id)) continue;
    lane.handledBy.push(event.id);
    lane.status = "handled";
    lane.updatedAt = event.timestamp;
  }
  if (isHandoffEvent(event) && event.handoff) {
    const handoff = event.handoff;
    pushBounded(state.taskBoard.lanes, {
      id: event.id,
      owner: String(handoff.to || "unknown"),
      from: String(handoff.from || event.source || "unknown"),
      status: "active",
      reason: String(handoff.reason || ""),
      ask: String(handoff.ask || event.content || ""),
      nextSpeaker: handoff.nextSpeaker ? String(handoff.nextSpeaker) : undefined,
      createdAt: event.timestamp,
      updatedAt: event.timestamp,
      handledBy: [],
    }, 1_000);
  }
  if (isArtifactEvent(event) && event.artifact) pushBounded(state.artifacts, event.artifact, 1_000);
  if (isHeadlessResultEvent(event) && event.result) {
    state.runs.total += 1;
    if (!event.result.ok) state.runs.failed += 1;
    if (event.result.timedOut) state.runs.timedOut += 1;
  }
  if (event.type === "ask_for_more_work" || event.type === "idle_ask_for_work") {
    const meta = (event.meta ?? {}) as Record<string, unknown>;
    pushBounded(state.workRequests, {
      type: "more_work",
      from: typeof meta.from === "string" ? meta.from : event.source || "unknown",
      content: event.content || "",
      timestamp: event.timestamp,
    }, 1_000);
    state.taskBoard.pendingMoreWork += 1;
  }
  if (event.type === "ask_for_backup") {
    const meta = (event.meta ?? {}) as Record<string, unknown>;
    pushBounded(state.workRequests, {
      type: "backup",
      from: typeof meta.from === "string" ? meta.from : event.source || "unknown",
      content: event.content || "",
      neededStrength: typeof meta.neededStrength === "string" ? meta.neededStrength : undefined,
      timestamp: event.timestamp,
    }, 1_000);
    state.taskBoard.backupRequests += 1;
  }
  if (event.type === "task_claim") {
    const meta = (event.meta ?? {}) as Record<string, unknown>;
    pushBounded(state.taskClaims, {
      task: typeof meta.task === "string" ? meta.task : (event.content || "").replace(/^\[Claimed:[^\]]+\]\s*/, ""),
      claimedBy: typeof meta.claimedBy === "string" ? meta.claimedBy : "unknown",
      timestamp: event.timestamp,
    }, 1_000);
  }
  if (event.type === "finality_proposal") pushBounded(state.finality.proposals, event, 128);
  state.workRequests.sort((left, right) => right.timestamp - left.timestamp);
  state.taskBoard.activeCount = state.taskBoard.lanes.filter((lane) => lane.status === "active").length;
  state.taskBoard.handledCount = state.taskBoard.lanes.length - state.taskBoard.activeCount;
  state.finality.blockers = taskStateBlockers(state);
  return state;
}

export function readContext(events: HeadlessEvent[], opts: { view?: ReadContextView; limit?: number } = {}) {
  const view = opts.view || "summary";
  const limit = opts.limit || 40;
  const recent = events.slice(Math.max(0, events.length - limit));

  if (view === "raw") {
    return { entries: recent };
  }

  if (view === "recent") {
    return {
      entries: recent.map(summarizeEvent),
    };
  }

  return {
    summary: deriveTaskState(events),
    entries: recent.map(summarizeEvent),
  };
}

export function deriveTaskState(events: HeadlessEvent[]): TaskState {
  const sessionId = events.at(-1)?.sessionId ?? null;
  const handled = new Map<string, string[]>();

  for (const event of events) {
    for (const id of handledIds(event)) {
      const handlers = handled.get(id) || [];
      handlers.push(event.id);
      handled.set(id, handlers);
    }
  }

  const lanes: HandoffLane[] = events
    .filter((event): event is Extract<HeadlessEvent, { type: "handoff" }> => isHandoffEvent(event) && !!event.handoff)
    .map((event) => {
      const h = (event.handoff || {}) as Record<string, unknown>;
      const handlers = handled.get(event.id) || [];
      return {
        id: event.id,
        owner: String(h.to || "unknown"),
        from: String(h.from || event.source || "unknown"),
        status: handlers.length ? "handled" : "active",
        reason: String(h.reason || ""),
        ask: String(h.ask || event.content || ""),
        nextSpeaker: h.nextSpeaker ? String(h.nextSpeaker) : undefined,
        createdAt: event.timestamp,
        updatedAt: latestUpdateFor(event.id, events) ?? event.timestamp,
        handledBy: handlers,
      } as HandoffLane;
    });

  const artifacts = events.flatMap((event) => (isArtifactEvent(event) && event.artifact ? [event.artifact] : []));
  const results = events.flatMap((event) => (isHeadlessResultEvent(event) && event.result ? [event.result] : []));
  const failed = results.filter((result) => !result.ok).length;
  const timedOut = results.filter((result) => result.timedOut).length;
  const activeCount = lanes.filter((lane) => lane.status === "active").length;

  // Support for ask-for-more-work, backup requests, and task claims (from claw + CR synthesis)
  const moreWorkEvents = events.filter(e => e.type === "ask_for_more_work" || e.type === "idle_ask_for_work");
  const backupEvents = events.filter(e => e.type === "ask_for_backup");
  const claimEvents = events.filter(e => e.type === "task_claim");

  const workRequests = [
    ...moreWorkEvents.map(e => {
      const m = (e.meta ?? {}) as Record<string, unknown>;
      return {
        type: "more_work" as const,
        from: (m.from as string) || e.source || "unknown",
        content: e.content || "",
        timestamp: e.timestamp,
      };
    }),
    ...backupEvents.map(e => {
      const m = (e.meta ?? {}) as Record<string, unknown>;
      return {
        type: "backup" as const,
        from: (m.from as string) || e.source || "unknown",
        content: e.content || "",
        neededStrength: m.neededStrength as string | undefined,
        timestamp: e.timestamp,
      };
    }),
  ].sort((a, b) => b.timestamp - a.timestamp);

  const taskClaims = claimEvents.map(e => {
    const m = (e.meta ?? {}) as Record<string, unknown>;
    return {
      task: (m.task as string) || (e.content || "").replace(/^\[Claimed:[^\]]+\]\s*/, ""),
      claimedBy: (m.claimedBy as string) || "unknown",
      timestamp: e.timestamp,
    };
  });

  const pendingMoreWork = moreWorkEvents.length;
  const backupRequests = backupEvents.length;

  const blockers = [
    activeCount ? `${activeCount} active handoff${activeCount === 1 ? "" : "s"}` : null,
    pendingMoreWork ? `${pendingMoreWork} agents asking for more work` : null,
    backupRequests ? `${backupRequests} backup requests open` : null,
    failed ? `${failed} failed run${failed === 1 ? "" : "s"}` : null,
    timedOut ? `${timedOut} timed out run${timedOut === 1 ? "" : "s"}` : null,
  ].filter((value): value is string => Boolean(value));

  return {
    sessionId,
    taskBoard: {
      lanes,
      activeCount,
      handledCount: lanes.length - activeCount,
      pendingMoreWork,
      backupRequests,
    },
    workRequests,
    taskClaims,
    artifacts,
    finality: {
      proposals: events.filter((event) => event.type === "finality_proposal"),
      blockers,
    },
    runs: {
      total: results.length,
      failed,
      timedOut,
    },
  };
}

function summarizeEvent(event: HeadlessEvent) {
  let handoff: unknown = undefined;
  let artifact: unknown = undefined;
  let resultSummary: unknown = undefined;
  if (isHandoffEvent(event)) handoff = event.handoff;
  if (isArtifactEvent(event) || isEventOfType(event, "idle_action_result") || isEventOfType(event, "release_gate")) artifact = (event as { artifact?: unknown }).artifact;
  if (isHeadlessResultEvent(event) && event.result) {
    const r = event.result;
    resultSummary = {
      ok: r.ok,
      backend: r.backend,
      output: String(r.output || "").slice(0, 2_000),
      cost: r.cost,
      tokens: r.tokens,
      durationMs: r.durationMs,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
    };
  }
  return {
    id: event.id,
    timestamp: event.timestamp,
    sessionId: event.sessionId,
    type: event.type,
    source: event.source,
    content: event.content,
    runId: event.runId,
    workerId: event.workerId,
    handoff,
    artifact,
    result: resultSummary,
    handlesHandoffId: event.handlesHandoffId,
    handlesHandoffIds: event.handlesHandoffIds,
    meta: event.meta,
  };
}

function handledIds(event: HeadlessEvent) {
  return [
    event.handlesHandoffId,
    ...(event.handlesHandoffIds || []),
  ].filter((value): value is string => Boolean(value));
}

function latestUpdateFor(handoffId: string, events: HeadlessEvent[]) {
  let timestamp: number | null = null;
  for (const event of events) {
    if (handledIds(event).includes(handoffId)) {
      timestamp = event.timestamp;
    }
  }
  return timestamp;
}

function pushBounded<T>(values: T[], value: T, max: number) {
  values.push(value);
  if (values.length > max) values.splice(0, values.length - max);
}

function taskStateBlockers(state: TaskState) {
  return [
    state.taskBoard.activeCount ? `${state.taskBoard.activeCount} active handoff${state.taskBoard.activeCount === 1 ? "" : "s"}` : null,
    state.taskBoard.pendingMoreWork ? `${state.taskBoard.pendingMoreWork} agents asking for more work` : null,
    state.taskBoard.backupRequests ? `${state.taskBoard.backupRequests} backup requests open` : null,
    state.runs.failed ? `${state.runs.failed} failed run${state.runs.failed === 1 ? "" : "s"}` : null,
    state.runs.timedOut ? `${state.runs.timedOut} timed out run${state.runs.timedOut === 1 ? "" : "s"}` : null,
  ].filter((value): value is string => Boolean(value));
}
