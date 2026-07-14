import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { safeOption } from "./validation";

export const MAX_OPENCODE_NATIVE_CONFIG_BYTES = 64 * 1024;

export type OpenCodeNativeModelResolution =
  | { available: true; model: string; source: "explicit" | "opencode.json" | "opencode.jsonc" }
  | { available: false; model: null; reason: string };

/**
 * Resolve only OpenCode's scalar global model default. The host configuration
 * itself is never copied into the worker, so plugins, MCP servers, commands,
 * and every other user-controlled surface remain disabled by `--pure`.
 */
export function resolveOpenCodeNativeModel(options: {
  homeDir?: string;
  requestedModel?: string;
} = {}): OpenCodeNativeModelResolution {
  if (options.requestedModel !== undefined) {
    return {
      available: true,
      model: safeOption(options.requestedModel, "model", { namespace: "OpenCode" }),
      source: "explicit",
    };
  }

  let home: string;
  try {
    home = realpathSync.native(resolve(options.homeDir ?? homedir()));
  } catch {
    return unavailable("OpenCode's native model configuration home could not be resolved safely.");
  }

  for (const name of ["opencode.json", "opencode.jsonc"] as const) {
    const path = join(home, ".config", "opencode", name);
    const read = readOwnerFile(home, path);
    if (read.status === "missing") continue;
    if (read.status === "invalid") return unavailable(read.reason);
    try {
      const parsed = parseJsonConfig(read.contents);
      if (!isObject(parsed) || typeof parsed.model !== "string") {
        return unavailable(`OpenCode ${name} does not contain a scalar model default.`);
      }
      let model: string;
      try {
        model = safeOption(parsed.model, "model", { namespace: "OpenCode" });
      } catch {
        return unavailable(`OpenCode ${name} contains an unsafe model default.`);
      }
      return { available: true, model, source: name };
    } catch {
      return unavailable(`OpenCode ${name} could not be parsed safely.`);
    } finally {
      read.contents.fill(0);
    }
  }

  return unavailable("OpenCode native login requires a safe global model in ~/.config/opencode/opencode.json or opencode.jsonc when no model is specified.");
}

function readOwnerFile(home: string, path: string):
  | { status: "ok"; contents: Buffer }
  | { status: "missing" }
  | { status: "invalid"; reason: string } {
  let canonical: string;
  try {
    canonical = realpathSync.native(path);
  } catch (error) {
    return isMissing(error)
      ? { status: "missing" }
      : { status: "invalid", reason: "OpenCode's native model configuration could not be resolved safely." };
  }
  if (canonical !== resolve(path) || !canonical.startsWith(`${home}${sep}`)) {
    return { status: "invalid", reason: "OpenCode's native model configuration must use its canonical global path inside the real home." };
  }

  let descriptor: number | null = null;
  let buffer: Buffer | null = null;
  try {
    descriptor = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(descriptor);
    const uid = process.getuid?.();
    if (
      !info.isFile()
      || info.nlink !== 1
      || (uid !== undefined && info.uid !== uid)
      || (info.mode & 0o022) !== 0
    ) {
      return { status: "invalid", reason: "OpenCode's native model configuration must be a single-link owner file." };
    }
    if (info.size > MAX_OPENCODE_NATIVE_CONFIG_BYTES) {
      return { status: "invalid", reason: "OpenCode's native model configuration exceeds its size limit." };
    }

    buffer = Buffer.allocUnsafe(MAX_OPENCODE_NATIVE_CONFIG_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const count = readSync(descriptor, buffer, offset, buffer.byteLength - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > MAX_OPENCODE_NATIVE_CONFIG_BYTES) {
      return { status: "invalid", reason: "OpenCode's native model configuration exceeds its size limit." };
    }
    return { status: "ok", contents: Buffer.from(buffer.subarray(0, offset)) };
  } catch {
    return { status: "invalid", reason: "OpenCode's native model configuration could not be opened safely." };
  } finally {
    buffer?.fill(0);
    if (descriptor !== null) closeSync(descriptor);
  }
}

function parseJsonConfig(contents: Buffer) {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(contents);
  const withoutBom = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  return JSON.parse(stripTrailingCommas(stripJsonComments(withoutBom))) as unknown;
}

function stripJsonComments(source: string) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    const next = source[index + 1];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n" && source[index] !== "\r") index += 1;
      if (index < source.length) output += source[index];
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n" || source[index] === "\r") output += source[index];
        index += 1;
      }
      if (index >= source.length) throw new SyntaxError("Unterminated JSONC comment.");
      index += 1;
      continue;
    }
    output += char;
  }
  if (inString) throw new SyntaxError("Unterminated JSON string.");
  return output;
}

function stripTrailingCommas(source: string) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === ",") {
      let lookahead = index + 1;
      while (/\s/.test(source[lookahead] ?? "")) lookahead += 1;
      if (source[lookahead] === "}" || source[lookahead] === "]") continue;
    }
    output += char;
  }
  return output;
}

function unavailable(reason: string): OpenCodeNativeModelResolution {
  return { available: false, model: null, reason };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissing(error: unknown) {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR");
}
