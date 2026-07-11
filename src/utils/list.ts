/** Split comma/newline-delimited CLI and integration inputs into bounded items. */
export function splitList(value?: string) {
  if (!value) return undefined;
  const items = value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 1_000);
  return items.length ? items : undefined;
}
