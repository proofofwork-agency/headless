import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { NativeAuthCapsuleManifestSchema, type NativeAuthCapsuleManifest } from "../contracts/native";
import { resolveOpenCodeNativeModel } from "./opencode-native-model";
import type { WorkerEnvironment } from "./worker-environment";

const MAX_AUTH_FILE_BYTES = 2 * 1024 * 1024;
const MAX_AUTH_CAPSULE_BYTES = 4 * 1024 * 1024;
export const MAX_CLAUDE_SETUP_TOKEN_BYTES = 4 * 1024;
export const CLAUDE_SETUP_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
export const CLAUDE_SETUP_TOKEN_LOGICAL_ENTRY = `env:${CLAUDE_SETUP_TOKEN_ENV}`;
export const CLAUDE_SETUP_TOKEN_PATTERN = /^sk-ant-oat[A-Za-z0-9_-]{20,}$/;
export const CLAUDE_SETUP_TOKEN_REMEDY = "Run `claude setup-token`, store its output at ~/.claude/.headless-setup-token, and run `chmod 600 ~/.claude/.headless-setup-token`.";
export const GROK_LOGIN_REMEDY = "Run `grok login` or `grok login --device-auth`, then retry.";
const NATIVE_AUTH_EXPIRY_MARGIN_MS = 30_000;
const NATIVE_AUTH_CAPSULE_BACKENDS = new Set(["codex", "claude-code", "opencode", "grok-build"]);

type CapsuleFile = {
  source: string;
  destination: (worker: WorkerEnvironment) => string;
};

export type NativeAuthCapsuleResult = {
  available: boolean;
  manifest: NativeAuthCapsuleManifest | null;
  reason: string | null;
  model: string | null;
};

export type NativeAuthCapsuleOptions = {
  homeDir?: string;
  requestedModel?: string;
  resolveOpenCodeModel?: boolean;
  minimumValidityMs?: number;
  nowMs?: number;
};

export function nativeAuthMinimumValidityMs(timeoutMs: number) {
  return Math.min(86_400_000, Math.max(0, timeoutMs) + NATIVE_AUTH_EXPIRY_MARGIN_MS);
}

/** Backends with an audited, minimal regular-file native-auth capsule. */
export function supportsNativeAuthCapsule(backend: string) {
  return NATIVE_AUTH_CAPSULE_BACKENDS.has(backend);
}

export function installNativeAuthCapsule(
  worker: WorkerEnvironment,
  backend: string,
  options: NativeAuthCapsuleOptions = {},
): NativeAuthCapsuleResult {
  let home: string;
  try {
    home = realpathSync.native(resolve(options.homeDir ?? homedir()));
  } catch {
    return {
      available: false,
      manifest: null,
      reason: "Native authentication home could not be resolved safely.",
      model: null,
    };
  }
  const model = backend === "opencode" && options.resolveOpenCodeModel
    ? resolveOpenCodeNativeModel({ homeDir: home, requestedModel: options.requestedModel })
    : null;
  if (model && !model.available) {
    return { available: false, manifest: null, reason: model.reason, model: null };
  }
  if (backend === "claude-code") {
    const setupToken = readClaudeSetupToken(home);
    if (setupToken.status === "invalid") {
      return { available: false, manifest: null, reason: setupToken.reason, model: null };
    }
    if (setupToken.status === "ok") return installClaudeSetupToken(worker, setupToken.contents);
  }
  const files = capsuleFiles(backend, home);
  const installed: Array<{ destination: string; contents: Buffer }> = [];
  let totalBytes = 0;

  for (const file of files) {
    const read = readCapsuleSource(home, file.source, Math.min(MAX_AUTH_FILE_BYTES, MAX_AUTH_CAPSULE_BYTES - totalBytes));
    if (read.status === "missing") continue;
    if (read.status === "invalid") return { available: false, manifest: null, reason: read.reason, model: model?.model ?? null };
    if (backend === "grok-build") {
      const reason = grokOidcReadinessReason(
        read.contents,
        options.nowMs ?? Date.now(),
        options.minimumValidityMs ?? 0,
      );
      if (reason) {
        read.contents.fill(0);
        return { available: false, manifest: null, reason, model: model?.model ?? null };
      }
    }
    const destination = file.destination(worker);
    assertWithinWorker(worker.root, destination);
    const contents = read.contents;
    totalBytes += contents.byteLength;
    installed.push({ destination, contents });
  }

  // A login-keychain-only Claude session cannot currently be discovered from
  // the isolated HOME inside strict Seatbelt containment. Do not substitute
  // the real HOME, ambient OAuth tokens, or a broad keychain export.
  if (installed.length === 0) {
    const reason = backend === "claude-code"
      ? `Claude native login requires supported regular-file state; keychain-only login is unavailable in required containment. ${CLAUDE_SETUP_TOKEN_REMEDY}`
      : `No native authentication state was found for ${backend}.`;
    return { available: false, manifest: null, reason, model: model?.model ?? null };
  }

  const fingerprint = createHash("sha256").update(`headless-native-auth-v1\0${backend}\0`);
  const sorted = installed.sort((left, right) => left.destination.localeCompare(right.destination));
  let fingerprintValue: string;
  try {
    for (const file of sorted) {
      mkdirSync(dirname(file.destination), { recursive: true, mode: 0o700 });
      writeFileSync(file.destination, file.contents, { mode: 0o600, flag: "wx" });
      chmodSync(file.destination, 0o600);
      fingerprint.update(relative(worker.root, file.destination)).update("\0").update(file.contents).update("\0");
    }
    if (model?.available) fingerprint.update("selected-model\0").update(model.model).update("\0");
    fingerprintValue = fingerprint.digest("hex");
  } finally {
    // Avoid retaining a second in-memory copy of backend credentials after the
    // owner-only capsule has been installed.
    for (const file of sorted) file.contents.fill(0);
  }

  const manifest = NativeAuthCapsuleManifestSchema.parse({
    version: 1,
    backend,
    fingerprint: fingerprintValue,
    files: sorted.map((file) => relative(worker.root, file.destination)),
    createdAt: Date.now(),
  });
  return { available: true, manifest, reason: null, model: model?.model ?? null };
}

/**
 * Grok rotates its OIDC refresh token when an expired disposable capsule is
 * refreshed. That refreshed file cannot safely update the operator's real
 * login, so the next worker would copy an invalidated refresh token. Refuse a
 * recognized OIDC capsule before it can expire during the bounded turn. Keep
 * unknown future/auth-file formats forward compatible and let the CLI decide.
 */
function grokOidcReadinessReason(contents: Buffer, nowMs: number, minimumValidityMs: number) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const entries = Object.values(parsed as Record<string, unknown>);
  const oidc = entries.filter((entry): entry is Record<string, unknown> => (
    !!entry
    && typeof entry === "object"
    && !Array.isArray(entry)
    && (entry as Record<string, unknown>).auth_mode === "oidc"
  ));
  if (oidc.length === 0) return null;
  const requiredUntil = nowMs + Math.max(0, minimumValidityMs);
  if (oidc.some((entry) => {
    if (typeof entry.key !== "string" || entry.key.length === 0) return false;
    if (typeof entry.expires_at !== "string") return false;
    const expiresAt = Date.parse(entry.expires_at);
    return Number.isFinite(expiresAt) && expiresAt > requiredUntil;
  })) return null;
  return `Grok native login is expired or expires before this bounded turn can finish. ${GROK_LOGIN_REMEDY}`;
}

function readClaudeSetupToken(home: string):
  | { status: "ok"; contents: Buffer }
  | { status: "missing" }
  | { status: "invalid"; reason: string } {
  const source = join(home, ".claude", ".headless-setup-token");
  const read = readCapsuleSource(home, source, MAX_CLAUDE_SETUP_TOKEN_BYTES, {
    resolveReason: "Claude setup-token could not be resolved safely.",
    pathReason: "Claude setup-token must be a canonical non-symlinked file at ~/.claude/.headless-setup-token.",
    fileReason: "Claude setup-token must be a single-link regular file.",
    sizeReason: `Claude setup-token exceeds its ${MAX_CLAUDE_SETUP_TOKEN_BYTES}-byte limit.`,
    openReason: "Claude setup-token could not be opened safely.",
    validateInfo: (info) => {
      const uid = process.getuid?.();
      if ((uid !== undefined && info.uid !== uid) || (info.mode & 0o077) !== 0) {
        return "Claude setup-token must be owned by the current user and accessible only to that user (chmod 600).";
      }
      return null;
    },
  });
  if (read.status !== "ok") return read;
  try {
    let token: string;
    try {
      token = new TextDecoder("utf-8", { fatal: true }).decode(read.contents).trim();
    } catch {
      return { status: "invalid", reason: "Claude setup-token must contain valid UTF-8 text." };
    }
    if (!token) return { status: "invalid", reason: "Claude setup-token must not be empty." };
    if (!CLAUDE_SETUP_TOKEN_PATTERN.test(token)) {
      return { status: "invalid", reason: "Claude setup-token must match the expected sk-ant-oat token format." };
    }
    return { status: "ok", contents: Buffer.from(token, "utf8") };
  } finally {
    read.contents.fill(0);
  }
}

function installClaudeSetupToken(worker: WorkerEnvironment, contents: Buffer): NativeAuthCapsuleResult {
  const fingerprint = createHash("sha256")
    .update("headless-native-auth-v1\0claude-code\0")
    .update(CLAUDE_SETUP_TOKEN_LOGICAL_ENTRY)
    .update("\0")
    .update(contents)
    .update("\0")
    .digest("hex");
  const token = contents.toString("utf8");
  contents.fill(0);
  worker.credentialEnv[CLAUDE_SETUP_TOKEN_ENV] = token;
  try {
    const manifest = NativeAuthCapsuleManifestSchema.parse({
      version: 1,
      backend: "claude-code",
      fingerprint,
      files: [CLAUDE_SETUP_TOKEN_LOGICAL_ENTRY],
      createdAt: Date.now(),
    });
    return { available: true, manifest, reason: null, model: null };
  } catch (error) {
    delete worker.credentialEnv[CLAUDE_SETUP_TOKEN_ENV];
    throw error;
  }
}

function capsuleFiles(backend: string, home: string): CapsuleFile[] {
  if (backend === "codex") {
    return [{ source: join(home, ".codex", "auth.json"), destination: (worker) => join(worker.home, ".codex", "auth.json") }];
  }
  if (backend === "claude-code") {
    return [{ source: join(home, ".claude", ".credentials.json"), destination: (worker) => join(worker.home, ".claude", ".credentials.json") }];
  }
  if (backend === "opencode") {
    return [{ source: join(home, ".local", "share", "opencode", "auth.json"), destination: (worker) => join(worker.data, "opencode", "auth.json") }];
  }
  if (backend === "grok-build") {
    // grok-build reads credentials only from `$GROK_HOME/auth.json` (default
    // `~/.grok/auth.json`; auth/storage.rs) — it never consults XDG config, so
    // the former `~/.config/grok/auth.json` candidate was dead weight.
    return [{ source: join(home, ".grok", "auth.json"), destination: (worker) => join(worker.home, ".grok", "auth.json") }];
  }
  return [];
}

function assertWithinWorker(root: string, path: string) {
  const base = `${resolve(root)}${sep}`;
  const destination = resolve(path);
  if (!destination.startsWith(base)) throw new Error("Native authentication capsule escaped the worker root.");
}

type CapsuleSourcePolicy = {
  resolveReason: string;
  pathReason: string;
  fileReason: string;
  sizeReason: string;
  openReason: string;
  validateInfo?: (info: Stats) => string | null;
};

const DEFAULT_SOURCE_POLICY: CapsuleSourcePolicy = {
  resolveReason: "Native authentication state could not be resolved safely.",
  pathReason: "Native authentication state must use an allowlisted regular path inside the real home.",
  fileReason: "Native authentication state is not a regular file.",
  sizeReason: "Native authentication state exceeds its capsule limit.",
  openReason: "Native authentication state could not be opened safely.",
};

function readCapsuleSource(home: string, source: string, maxBytes: number, policy: CapsuleSourcePolicy = DEFAULT_SOURCE_POLICY):
  | { status: "ok"; contents: Buffer }
  | { status: "missing" }
  | { status: "invalid"; reason: string } {
  let canonical: string;
  try {
    canonical = realpathSync.native(source);
  } catch (error) {
    return isMissing(error)
      ? { status: "missing" }
      : { status: "invalid", reason: policy.resolveReason };
  }
  const expected = resolve(source);
  if (canonical !== expected || !canonical.startsWith(`${home}${sep}`)) {
    return { status: "invalid", reason: policy.pathReason };
  }

  let descriptor: number | null = null;
  let buffer: Buffer | null = null;
  try {
    descriptor = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1) {
      return { status: "invalid", reason: policy.fileReason };
    }
    const invalidInfo = policy.validateInfo?.(info);
    if (invalidInfo) return { status: "invalid", reason: invalidInfo };
    if (maxBytes < 0 || info.size > maxBytes) {
      return { status: "invalid", reason: policy.sizeReason };
    }

    // Read at most one byte beyond the remaining bound. This stays bounded
    // even if a same-user process grows the file after fstat.
    buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const count = readSync(descriptor, buffer, offset, buffer.byteLength - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > maxBytes) {
      return { status: "invalid", reason: policy.sizeReason };
    }
    return { status: "ok", contents: Buffer.from(buffer.subarray(0, offset)) };
  } catch {
    return { status: "invalid", reason: policy.openReason };
  } finally {
    buffer?.fill(0);
    if (descriptor !== null) closeSync(descriptor);
  }
}

function isMissing(error: unknown) {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR");
}
