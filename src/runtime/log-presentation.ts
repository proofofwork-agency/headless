import type { RunEvent } from "../contracts/run";

export type LogDisplayMode = "compact" | "verbose" | "strict";
export type LogChannel = "all" | "errors" | "activity";

export function parseLogDisplayMode(value: string | undefined, fallback: LogDisplayMode = "compact") {
  if (value === undefined) return fallback;
  if (value !== "compact" && value !== "verbose" && value !== "strict") throw new TypeError(`Invalid log display mode ${value}. Expected compact, verbose, or strict.`);
  return value;
}

export function isErrorEvent(event: RunEvent) {
  return event.kind === "stderr"
    || event.kind === "completion" && event.result.status !== "succeeded"
    || event.kind === "policy" && event.decision === "denied"
    || event.kind === "lifecycle" && ["failed", "blocked", "timed_out"].includes(event.state);
}

export function isFunctionalActivityEvent(event: RunEvent) {
  return event.kind === "lifecycle" || event.kind === "policy" || event.kind === "tool" || event.kind === "artifact" || event.kind === "completion";
}

export function selectLogEvents(events: readonly RunEvent[], mode: LogDisplayMode, channel: LogChannel = "all") {
  return events.filter((event) => {
    if (channel === "errors" && !isErrorEvent(event)) return false;
    if (channel === "activity" && !isFunctionalActivityEvent(event)) return false;
    if (mode === "verbose") return true;
    if (mode === "strict") return isErrorEvent(event) || isFunctionalActivityEvent(event);
    return isErrorEvent(event) || isFunctionalActivityEvent(event);
  });
}

export function strictLogIdentity(event: RunEvent) {
  return `event=${event.eventId} job=${event.jobId} session=${event.sessionId ?? "none"} seq=${event.sequence}`;
}
