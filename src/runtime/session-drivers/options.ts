export const DEFAULT_SESSION_TIMEOUT_MS = 180_000;
export const MAX_SESSION_TIMEOUT_MS = 86_400_000;

export function safeSessionOption(value: string | undefined, name: string) {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || normalized.startsWith("-") || normalized.includes("\0")) {
    throw new TypeError(`Invalid session ${name}.`);
  }
  return normalized;
}

export function sessionTimeout(value?: number) {
  const timeoutMs = value ?? DEFAULT_SESSION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_SESSION_TIMEOUT_MS) {
    throw new TypeError(`Session timeout must be a positive safe integer no greater than ${MAX_SESSION_TIMEOUT_MS}.`);
  }
  return timeoutMs;
}

export function commandEnvironment(value?: NodeJS.ProcessEnv) {
  return { ...(value ?? {}) };
}

export function parseCliVersion(output: string) {
  return output.match(/(?:^|[^0-9])(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/)?.[1] ?? null;
}
