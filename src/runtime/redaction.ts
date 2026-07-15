import assert from "node:assert/strict";

const MAX_TEXT_LENGTH = 20_000;

export const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, "$1\n[REDACTED_PRIVATE_KEY]\n$2"],
  [/(?<![A-Za-z0-9_-])(sk-ant-oat[A-Za-z0-9_-]{20,})(?![A-Za-z0-9_-])/g, "[REDACTED_CLAUDE_SETUP_TOKEN]"],
  [/\b(sk-[A-Za-z0-9_-]{16,})\b/g, "[REDACTED_OPENAI_KEY]"],
  [/\b(anthropic-[A-Za-z0-9_-]{16,})\b/g, "[REDACTED_ANTHROPIC_KEY]"],
  [/\b(xai-[A-Za-z0-9_-]{16,})\b/g, "[REDACTED_XAI_KEY]"],
  // Daemon-issued provider broker leases are base64url values longer than the
  // `hls_<uuid>` message identifiers used by integrations. Keep the minimum
  // length above a UUID so ordinary message IDs are not destroyed.
  // Base64url credentials may legitimately end in `-`. A trailing `\b`
  // backtracks before that non-word character and leaks the suffix, making
  // redaction depend on random token bytes. Bound against the complete token
  // alphabet instead so every credential byte is consumed deterministically.
  [/(?<![A-Za-z0-9_-])(hls_[A-Za-z0-9_-]{40,})(?![A-Za-z0-9_-])/g, "[REDACTED_HEADLESS_BROKER_TOKEN]"],
  [/(?<![A-Za-z0-9_-])(hlt_[A-Za-z0-9_-]{40,})(?![A-Za-z0-9_-])/g, "[REDACTED_HEADLESS_RUN_TOOL_TOKEN]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi, "Bearer [REDACTED_BEARER_TOKEN]"],
  [/\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g, "[REDACTED_SLACK_TOKEN]"],
  [/\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\b(github_pat_[A-Za-z0-9_]{22,})\b/g, "[REDACTED_GITHUB_PAT]"],
  [/\b(AIza[0-9A-Za-z_-]{35})\b/g, "[REDACTED_GOOGLE_API_KEY]"],
  [/\b(xapp-[0-9]-[A-Za-z0-9-]{8,})\b/g, "[REDACTED_SLACK_APP_TOKEN]"],
  [/\bBasic\s+[A-Za-z0-9+/=]{16,}/gi, "Basic [REDACTED_BASIC_AUTH]"],
  [/\b(AKIA[0-9A-Z]{16})\b/g, "[REDACTED_AWS_ACCESS_KEY]"],
  [/\b(ASIA[0-9A-Z]{16})\b/g, "[REDACTED_AWS_TEMP_KEY]"],
  [/\b((?:eyJ[A-Za-z0-9_-]{10,})\.(?:eyJ[A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,})\b/g, "[REDACTED_JWT]"],
  [/\b((?:sk|pk)_(?:live|test)_[A-Za-z0-9]{12,})\b/g, "[REDACTED_STRIPE_KEY]"],
  [/"private_key"\s*:\s*"-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----\\n?"/g, "\"private_key\":\"[REDACTED_GCP_PRIVATE_KEY]\""],
  // Hardened generic key=value redaction (avoids invalid JSON + reduces false positives):
  // - word-boundary on keyword start via lookbehind (?<![A-Za-z0-9]) prevents substring matches inside words like "monkey", "turkey", "mykey", "apikeyfoo" etc.
  // - still catches "api_key", "SECRET_KEY", "access-token", etc because _ - . " ' etc don't block start of keyword.
  // - intentionally excludes bare `key` assignments: React `key={...}` and
  //   ordinary constants such as `STORAGE_KEY` are not credentials, while
  //   compound API/access/secret key names remain covered by their prefixes.
  // - matches key names optionally quoted, before :=
  // - captures opening quote style (group 2), requires matching closer via backref \2
  // - replacement re-uses exact quotes (so "k":"v" -> "k":"[REDACTED]" not broken)
  // - value stops at JSON structure chars / ws / common terminators to avoid mangling code, urls, paths
  // - requires 8+ chars, skips already-redacted
  [/(?<![A-Za-z0-9])((?:["']?(?:api|access|secret|auth|bearer|token|password|passwd|pwd)[A-Z0-9_\-. ]{0,20}["']?\s*[:=]\s*))(["'])(?!\[REDACTED_)([^"'\r\n]{8,})\2/gi, '$1$2[REDACTED]$2'],
  [/(?<![A-Za-z0-9])((?:["']?(?:api|access|secret|auth|bearer|token|password|passwd|pwd)[A-Z0-9_\-. ]{0,20}["']?\s*[:=]\s*))(["']?)(?!\[REDACTED_)(?![A-Za-z_$][A-Za-z0-9_$]*\s*\()([^"'\s,}\]>&|;]{8,})\2/gi, '$1$2[REDACTED]$2'],
];
assert(SECRET_PATTERNS.length >= 18, `redaction must cover 18+ patterns, got ${SECRET_PATTERNS.length}`);

export interface RedactionResult {
  text: string;
  redacted: boolean;
  truncated: boolean;
}

export function redactAndTruncate(value: unknown, maxLength = MAX_TEXT_LENGTH): RedactionResult {
  let text = typeof value === "string" ? value : JSON.stringify(value);
  let redacted = false;

  for (const [pattern, replacement] of SECRET_PATTERNS) {
    const next = text.replace(pattern, replacement);
    if (next !== text) redacted = true;
    text = next;
  }

  const alreadyTruncated = /\n\[TRUNCATED \d+ chars\]$/.test(text);
  const truncated = alreadyTruncated || text.length > maxLength;
  if (truncated && !alreadyTruncated) {
    text = `${text.slice(0, maxLength)}\n[TRUNCATED ${text.length - maxLength} chars]`;
  }

  return { text, redacted, truncated };
}

/**
 * Stateful redaction for process streams.
 *
 * A secret can be split at any byte/chunk boundary, so independently
 * redacting chunks is unsafe. This redactor retains an overlap and extends it
 * back to the beginning of any unfinished credential-shaped token or private
 * key. Only a prefix that can no longer be completed into a secret is emitted.
 * `finish()` redacts the final retained tail. The caller remains responsible
 * for applying a total stream byte cap before calling `push`.
 */
export class StreamingRedactor {
  private pending = "";
  private failed = false;

  constructor(
    private readonly emit: (chunk: string) => void,
    private readonly overlapChars = 8_192,
    private readonly redact: (value: unknown, maxLength?: number) => RedactionResult = redactAndTruncate,
  ) {
    if (!Number.isSafeInteger(overlapChars) || overlapChars < 256) {
      throw new TypeError("Streaming redaction overlap must be a safe integer of at least 256 characters.");
    }
  }

  push(chunk: string) {
    if (this.failed || !chunk) return;
    this.pending += chunk;
    const cut = safeStreamingCut(this.pending, this.overlapChars);
    if (cut <= 0) return;
    const prefix = this.pending.slice(0, cut);
    this.pending = this.pending.slice(cut);
    this.emitRedacted(prefix);
  }

  finish() {
    if (this.failed) return;
    const tail = this.pending;
    this.pending = "";
    if (tail) this.emitRedacted(tail);
  }

  private emitRedacted(value: string) {
    try {
      const safe = this.redact(value, Math.max(value.length * 2, 65_536));
      if (!safe || typeof safe.text !== "string") throw new Error("invalid redaction result");
      this.emit(safe.text);
    } catch {
      this.failed = true;
      this.pending = "";
      try {
        this.emit("[SUPPRESSED: REDACTION FAILURE]");
      } catch {
        // The user sink failed while reporting the fail-closed marker. Never
        // retry with the raw value or the redactor exception.
      }
    }
  }
}

const STREAM_TOKEN_START = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-|anthropic-|xai-|hls_|hlt_|xox[baprs]-|gh[pousr]_|github_pat_|AIza|xapp-|AKIA|ASIA|Bearer\s+|Basic\s+|(?:sk|pk)_(?:live|test)_|eyJ)|(?<![A-Za-z0-9])(?:["']?(?:api|access|secret|auth|bearer|token|password|passwd|pwd)[A-Z0-9_\-. ]{0,20}["']?\s*[:=]\s*["']?))/gi;

function safeStreamingCut(value: string, overlapChars: number) {
  let cut = Math.max(0, value.length - overlapChars);
  if (cut === 0) return 0;

  // If a complete recognized secret happens to straddle the nominal cut,
  // move the cut to its beginning before redacting the prefix.
  for (const [pattern] of SECRET_PATTERNS) {
    const matcher = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    for (let match = matcher.exec(value); match; match = matcher.exec(value)) {
      if (match.index < cut && match.index + match[0].length > cut) cut = match.index;
      if (match[0].length === 0) matcher.lastIndex += 1;
    }
  }

  // Never emit an unterminated private key. This handles keys much larger than
  // the nominal overlap without imposing another unbounded copy.
  const privateKeyStart = value.lastIndexOf("-----BEGIN ");
  if (privateKeyStart >= 0) {
    const markerEnd = value.indexOf("PRIVATE KEY-----", privateKeyStart);
    const keyEnd = value.indexOf("-----END ", markerEnd < 0 ? privateKeyStart : markerEnd);
    if (markerEnd < 0 || keyEnd < 0) cut = Math.min(cut, privateKeyStart);
  }

  // If a credential-shaped token reaches the current end of the stream, keep
  // it from its start. A later delimiter makes it safe to redact and release.
  STREAM_TOKEN_START.lastIndex = 0;
  for (let match = STREAM_TOKEN_START.exec(value); match; match = STREAM_TOKEN_START.exec(value)) {
    const suffix = value.slice(match.index);
    const delimiter = credentialDelimiterIndex(suffix, match[0].length);
    if (delimiter < 0 || match.index < cut && match.index + delimiter >= cut) {
      cut = Math.min(cut, match.index);
    }
    if (match[0].length === 0) STREAM_TOKEN_START.lastIndex += 1;
  }
  return cut;
}

function credentialDelimiterIndex(suffix: string, prefixLength: number) {
  if (suffix.startsWith("-----BEGIN ")) {
    const end = suffix.search(/-----END [A-Z ]*PRIVATE KEY-----/);
    return end < 0 ? -1 : end;
  }
  // Token values in all supported patterns terminate at whitespace or common
  // structured-data punctuation. Quoted generic assignments terminate only at
  // their matching quote.
  const assignmentAt = suffix.search(/[:=]/);
  if (assignmentAt >= 0 && assignmentAt < prefixLength) {
    let valueStart = assignmentAt + 1;
    while (/\s/.test(suffix[valueStart] ?? "")) valueStart += 1;
    const quote = suffix[valueStart];
    if (quote === '"' || quote === "'") {
      const end = suffix.indexOf(quote, valueStart + 1);
      return end < 0 ? -1 : end;
    }
    const relative = suffix.slice(valueStart).search(/[\s,}\]>&|;]/);
    return relative < 0 ? -1 : valueStart + relative;
  }
  const relative = suffix.slice(prefixLength).search(/[\s,}\]>&|;]/);
  return relative < 0 ? -1 : prefixLength + relative;
}

assert(typeof redactAndTruncate === "function");

export interface DeepRedactionResult {
  value: unknown;
  redacted: boolean;
  truncated: boolean;
}

// Redact secrets from EVERY string in a nested value (recursing objects/arrays),
// not just a single content field. Non-string leaves (numbers/booleans/null) are
// preserved. This ensures secrets in artifact/handoff/meta/result fields cannot
// reach the ledger in cleartext.
export function redactDeep(value: unknown, maxLength = MAX_TEXT_LENGTH): DeepRedactionResult {
  let redacted = false;
  let truncated = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redactAndTruncate(v, maxLength);
      if (r.redacted) redacted = true;
      if (r.truncated) truncated = true;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return { value: walk(value), redacted, truncated };
}
