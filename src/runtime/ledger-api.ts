import type { ArtifactStatus } from "./events";
import type { ReadContextView } from "./read-model";
import { redactAndTruncate } from "./redaction";
import { appendEvent, getOrCreateSession, readProjectedContext, readProjectedTaskState, type SessionOptions } from "./session";

export type RuntimeOptions = SessionOptions;

export function appendNote(options: RuntimeOptions & { text: string; handlesHandoffId?: string }) {
  const session = getOrCreateSession(options);
  return appendEvent(session, {
    type: "note",
    source: session.principal,
    content: options.text,
    handlesHandoffId: options.handlesHandoffId,
  });
}

export function recordArtifact(options: RuntimeOptions & {
  kind: string;
  title: string;
  summary: string;
  status?: ArtifactStatus;
  evidence?: string[];
  /** Optional deterministic id for crash-safe, idempotent artifact appends. */
  eventId?: string;
}) {
  const session = getOrCreateSession(options);
  const summary = redactAndTruncate(options.summary, 20_000).text;
  return appendEvent(session, {
    type: "artifact",
    source: session.principal,
    content: `${options.title}: ${summary}`,
    artifact: {
      kind: options.kind,
      title: options.title,
      summary,
      status: options.status ?? "unknown",
      evidence: options.evidence?.slice(0, 128).map((item) => redactAndTruncate(item, 4_096).text),
    },
  }, options.eventId);
}

export function proposeFinal(options: RuntimeOptions & {
  summary: string;
  evidence: string;
  remainingRisk?: string;
  handlesHandoffIds?: string[];
}) {
  const session = getOrCreateSession(options);
  return appendEvent(session, {
    type: "finality_proposal",
    source: session.principal,
    content: `summary: ${options.summary}\n\nevidence: ${options.evidence}\n\nremaining_risk: ${options.remainingRisk ?? "none"}`,
    handlesHandoffIds: options.handlesHandoffIds?.slice(0, 128),
    meta: {
      summary: options.summary,
      evidence: options.evidence,
      remainingRisk: options.remainingRisk ?? "none",
    },
  });
}

export function getReadContext(options: RuntimeOptions & { view?: ReadContextView; limit?: number } = {}) {
  const session = getOrCreateSession(options);
  const limit = options.limit ?? 40;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 1_000) throw new TypeError("Context limit must be an integer from 0 through 1000.");
  return readProjectedContext(session, { view: options.view, limit });
}

export function getTaskState(options: RuntimeOptions = {}) {
  const session = getOrCreateSession(options);
  return readProjectedTaskState(session);
}
