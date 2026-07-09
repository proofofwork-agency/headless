import type { HeadlessEvent } from "./events";

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
  };
  artifacts: NonNullable<HeadlessEvent["artifact"]>[];
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
    .filter((event) => event.type === "handoff" && event.handoff)
    .map((event) => {
      const handlers = handled.get(event.id) || [];
      return {
        id: event.id,
        owner: event.handoff?.to || "unknown",
        from: event.handoff?.from || event.source,
        status: handlers.length ? "handled" : "active",
        reason: event.handoff?.reason || "",
        ask: event.handoff?.ask || event.content || "",
        nextSpeaker: event.handoff?.nextSpeaker,
        createdAt: event.timestamp,
        updatedAt: latestUpdateFor(event.id, events) ?? event.timestamp,
        handledBy: handlers,
      };
    });

  const artifacts = events.flatMap((event) => (event.artifact ? [event.artifact] : []));
  const results = events.flatMap((event) => (event.result ? [event.result] : []));
  const failed = results.filter((result) => !result.ok).length;
  const timedOut = results.filter((result) => result.timedOut).length;
  const activeCount = lanes.filter((lane) => lane.status === "active").length;
  const blockers = [
    activeCount ? `${activeCount} active handoff${activeCount === 1 ? "" : "s"}` : null,
    failed ? `${failed} failed run${failed === 1 ? "" : "s"}` : null,
    timedOut ? `${timedOut} timed out run${timedOut === 1 ? "" : "s"}` : null,
  ].filter((value): value is string => Boolean(value));

  return {
    sessionId,
    taskBoard: {
      lanes,
      activeCount,
      handledCount: lanes.length - activeCount,
    },
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
  return {
    id: event.id,
    timestamp: event.timestamp,
    sessionId: event.sessionId,
    type: event.type,
    source: event.source,
    content: event.content,
    runId: event.runId,
    workerId: event.workerId,
    handoff: event.handoff,
    artifact: event.artifact,
    result: event.result
      ? {
          ok: event.result.ok,
          backend: event.result.backend,
          output: event.result.output.slice(0, 2_000),
          cost: event.result.cost,
          tokens: event.result.tokens,
          durationMs: event.result.durationMs,
          exitCode: event.result.exitCode,
          timedOut: event.result.timedOut,
        }
      : undefined,
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
