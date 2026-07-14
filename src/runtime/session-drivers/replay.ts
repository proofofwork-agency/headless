import { redactAndTruncate } from "../redaction";
import type { SessionTranscriptEntry } from "./types";

export const MAX_SESSION_REPLAY_BYTES = 200_000;

export type ReplayDecision = {
  strategy: "native-resume" | "replay" | "unavailable";
  reason: string;
  text: string;
  bytes: number;
  truncated: boolean;
};

export function decideReplayFallback(input: {
  nativeResumeSupported: boolean;
  nativeResumeAvailable?: boolean;
  nativeSessionId?: string | null;
  transcript?: SessionTranscriptEntry[];
  maxBytes?: number;
}): ReplayDecision {
  if (input.nativeResumeSupported && input.nativeResumeAvailable !== false && input.nativeSessionId) {
    return {
      strategy: "native-resume",
      reason: "A native session identifier and resume capability are available.",
      text: "",
      bytes: 0,
      truncated: false,
    };
  }

  const transcript = input.transcript ?? [];
  if (transcript.length === 0) {
    return {
      strategy: "unavailable",
      reason: "Native resume is unavailable and no bounded transcript is available for replay.",
      text: "",
      bytes: 0,
      truncated: false,
    };
  }

  const limit = checkedReplayLimit(input.maxBytes ?? MAX_SESSION_REPLAY_BYTES);
  const selected: string[] = [];
  let bytes = 0;
  let truncated = false;
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index];
    const safe = redactAndTruncate(entry.content, limit);
    const line = truncateUtf8(`${entry.role.toUpperCase()}: ${safe.text}`, limit).text;
    const size = Buffer.byteLength(line) + 2;
    if (bytes + size > limit) {
      if (selected.length === 0) {
        const remaining = Math.max(1, limit - Buffer.byteLength(`${entry.role.toUpperCase()}: `));
        selected.unshift(`${entry.role.toUpperCase()}: ${truncateUtf8(safe.text, remaining).text}`);
      }
      truncated = true;
      break;
    }
    selected.unshift(line);
    bytes += size;
    truncated ||= safe.truncated;
  }
  if (selected.length === 0) {
    return {
      strategy: "unavailable",
      reason: "The redacted transcript could not fit within the replay bound.",
      text: "",
      bytes: 0,
      truncated: true,
    };
  }
  if (truncated) selected.unshift("SUMMARY: Earlier redacted transcript entries were omitted by the replay bound.");
  const bounded = truncateUtf8(selected.join("\n\n"), limit);
  return {
    strategy: "replay",
    reason: "Native resume is unavailable; a bounded redacted transcript replay will be used.",
    text: bounded.text,
    bytes: Buffer.byteLength(bounded.text),
    truncated: truncated || bounded.truncated,
  };
}

export function replayPrompt(replay: string, prompt: string) {
  if (!replay) return prompt;
  return `BOUNDED REDACTED SESSION REPLAY:\n${replay}\n\nNEW USER REQUEST:\n${prompt}`;
}

function checkedReplayLimit(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_SESSION_REPLAY_BYTES) {
    throw new TypeError(`Replay bound must be a positive safe integer no greater than ${MAX_SESSION_REPLAY_BYTES}.`);
  }
  return value;
}

function truncateUtf8(value: string, maxBytes: number) {
  if (Buffer.byteLength(value) <= maxBytes) return { text: value, truncated: false };
  let end = maxBytes;
  const buffer = Buffer.from(value);
  let text = buffer.subarray(0, end).toString("utf8");
  while (Buffer.byteLength(text) > maxBytes && end > 0) {
    end -= 1;
    text = buffer.subarray(0, end).toString("utf8");
  }
  return { text, truncated: true };
}
