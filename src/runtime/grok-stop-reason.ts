/**
 * True when grok-build's ACP terminal reason means the turn did not complete
 * usefully despite a zero process exit. Refusal, Cancelled, and MaxTokens are
 * externally emitted ACP reasons. The content-filter/context-window spellings
 * remain accepted defensively for older/internal event variants.
 */
export function grokStopReasonFailed(reason: string | null | undefined) {
  const normalized = (reason ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return [
    "refusal",
    "cancelled",
    "canceled",
    "maxtokens",
    "contentfilter",
    "modelcontextwindowexceeded",
    "error",
    "fail",
  ].some((marker) => normalized.includes(marker));
}
