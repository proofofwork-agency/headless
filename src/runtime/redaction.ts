const MAX_TEXT_LENGTH = 20_000;

export const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, "$1\n[REDACTED_PRIVATE_KEY]\n$2"],
  [/\b(sk-[A-Za-z0-9_-]{16,})\b/g, "[REDACTED_OPENAI_KEY]"],
  [/\b(anthropic-[A-Za-z0-9_-]{16,})\b/g, "[REDACTED_ANTHROPIC_KEY]"],
  [/\b(xai-[A-Za-z0-9_-]{16,})\b/g, "[REDACTED_XAI_KEY]"],
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
  [/((?:api|access|secret|auth|bearer|token|password|passwd|pwd|key)[A-Z0-9_\-. ]{0,20}[:=]\s*)["']?(?!\[REDACTED_)[^"'\s]{8,}["']?/gi, "$1[REDACTED]"],
];

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

  const truncated = text.length > maxLength;
  if (truncated) {
    text = `${text.slice(0, maxLength)}\n[TRUNCATED ${text.length - maxLength} chars]`;
  }

  return { text, redacted, truncated };
}

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
