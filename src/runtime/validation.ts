import { HeadlessError } from "./headless-error";
import { GROK_BUILTIN_AGENT_NAMES, isBackendAgentName } from "../contracts/agent-name";

export const RELEASE_PLATFORMS = ["darwin", "linux"] as const;
export { GROK_BUILTIN_AGENT_NAMES };
export const MAX_PUBLIC_TIMEOUT_MS = 86_400_000;
export type ReleasePlatform = typeof RELEASE_PLATFORMS[number];

export type SafeOptionOptions = {
  namespace?: string;
  maxBytes?: number;
};

/** Validate a value that will be passed as the argument following a CLI flag. */
export function safeOption(
  value: unknown,
  name: string,
  options: SafeOptionOptions = {},
) {
  const normalized = typeof value === "string" ? value.trim() : "";
  const maxBytes = options.maxBytes ?? 256;
  if (
    !normalized
    || !Number.isSafeInteger(maxBytes)
    || maxBytes <= 0
    || Buffer.byteLength(normalized) > maxBytes
    || normalized.startsWith("-")
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    const label = [options.namespace, name].filter(Boolean).join(" ");
    throw new HeadlessError("INVALID_REQUEST", `Invalid ${label || "option"}.`);
  }
  return normalized;
}

/** Validate a backend agent name while rejecting CLI-supported definition paths. */
export function safeAgentName(value: unknown, namespace?: string) {
  const normalized = safeOption(value, "agent", { namespace });
  if (!isBackendAgentName(normalized, namespace)) {
    throw new HeadlessError("INVALID_REQUEST", `Invalid ${namespace ? `${namespace} ` : ""}agent.`);
  }
  return normalized;
}

export type PositiveTimeoutOptions = {
  defaultValue?: number;
  max?: number;
  name?: string;
};

export function positiveTimeout(value: unknown, options: PositiveTimeoutOptions = {}) {
  const timeoutMs = value === undefined ? options.defaultValue : value;
  const max = options.max ?? MAX_PUBLIC_TIMEOUT_MS;
  const name = options.name ?? "timeoutMs";
  if (
    typeof timeoutMs !== "number"
    || !Number.isSafeInteger(timeoutMs)
    || timeoutMs <= 0
    || !Number.isSafeInteger(max)
    || max <= 0
    || timeoutMs > max
  ) {
    throw new HeadlessError("INVALID_REQUEST", `${name} must be a positive safe integer no greater than ${max}.`);
  }
  return timeoutMs;
}

export class UnsupportedPlatformError extends HeadlessError {
  constructor(readonly platform: string) {
    super("UNSUPPORTED_PLATFORM", `Headless does not support platform: ${platform}`, {
      details: { platform },
    });
    this.name = "UnsupportedPlatformError";
  }
}

export function supportedPlatform(platform?: string): ReleasePlatform;
export function supportedPlatform<Supported extends readonly string[]>(platform: string, supported: Supported): Supported[number];
export function supportedPlatform(
  platform: string = process.platform,
  supported: readonly string[] = RELEASE_PLATFORMS,
) {
  if (supported.includes(platform)) return platform;
  throw new UnsupportedPlatformError(platform);
}
