/** Parse untrusted JSON only after enforcing a bounded structural depth. */
export function safeJsonParse<T = unknown>(text: string, maxDepth = 100): T {
  if (jsonNestingDepth(text) > maxDepth) throw new Error(`JSON nesting depth exceeds limit of ${maxDepth}`);
  return JSON.parse(text) as T;
}

function jsonNestingDepth(text: string) {
  let maximum = 0;
  let current = 0;
  let inString = false;
  let escaped = false;
  for (const character of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (character === "{" || character === "[") maximum = Math.max(maximum, ++current);
    if (character === "}" || character === "]") current -= 1;
  }
  return maximum;
}
