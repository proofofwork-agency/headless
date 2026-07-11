import { HeadlessError } from "../runtime/headless-error";

export function stringParam(params: Record<string, unknown>, name: string) {
  const value = params[name];
  if (typeof value !== "string" || !value) throw new HeadlessError("INVALID_REQUEST", `${name} is required.`);
  return value;
}

export function boundedChatId(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 160) {
    throw new HeadlessError("INVALID_REQUEST", "chatId must be a non-empty string no longer than 160 characters.");
  }
  return value;
}

export function optionalString(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new HeadlessError("INVALID_REQUEST", "Expected a string parameter.");
  return value;
}

export function optionalNumber(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new HeadlessError("INVALID_REQUEST", "Expected a non-negative integer parameter.");
  }
  return value;
}

export function stringArray(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new HeadlessError("INVALID_REQUEST", "Expected an array of strings.");
  }
  return value as string[];
}

export function optionalTimeout(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 86_400_000) {
    throw new HeadlessError("INVALID_REQUEST", "timeoutMs must be a positive bounded integer.");
  }
  return value;
}
