import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { NativeAuthCapsuleManifestSchema, type NativeAuthCapsuleManifest } from "../contracts/native";
import { resolveOpenCodeNativeModel } from "./opencode-native-model";
import type { WorkerEnvironment } from "./worker-environment";

const MAX_AUTH_FILE_BYTES = 2 * 1024 * 1024;
const MAX_AUTH_CAPSULE_BYTES = 4 * 1024 * 1024;
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
};

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
  const files = capsuleFiles(backend, home);
  const installed: Array<{ destination: string; contents: Buffer }> = [];
  let totalBytes = 0;

  for (const file of files) {
    const read = readCapsuleSource(home, file.source, Math.min(MAX_AUTH_FILE_BYTES, MAX_AUTH_CAPSULE_BYTES - totalBytes));
    if (read.status === "missing") continue;
    if (read.status === "invalid") return { available: false, manifest: null, reason: read.reason, model: model?.model ?? null };
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
      ? "Claude native login requires supported regular-file state; keychain-only login is unavailable in required containment."
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
    return [
      { source: join(home, ".grok", "auth.json"), destination: (worker) => join(worker.home, ".grok", "auth.json") },
      { source: join(home, ".config", "grok", "auth.json"), destination: (worker) => join(worker.config, "grok", "auth.json") },
    ];
  }
  return [];
}

function assertWithinWorker(root: string, path: string) {
  const base = `${resolve(root)}${sep}`;
  const destination = resolve(path);
  if (!destination.startsWith(base)) throw new Error("Native authentication capsule escaped the worker root.");
}

function readCapsuleSource(home: string, source: string, maxBytes: number):
  | { status: "ok"; contents: Buffer }
  | { status: "missing" }
  | { status: "invalid"; reason: string } {
  let canonical: string;
  try {
    canonical = realpathSync.native(source);
  } catch (error) {
    return isMissing(error)
      ? { status: "missing" }
      : { status: "invalid", reason: "Native authentication state could not be resolved safely." };
  }
  const expected = resolve(source);
  if (canonical !== expected || !canonical.startsWith(`${home}${sep}`)) {
    return { status: "invalid", reason: "Native authentication state must use an allowlisted regular path inside the real home." };
  }

  let descriptor: number | null = null;
  let buffer: Buffer | null = null;
  try {
    descriptor = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1) {
      return { status: "invalid", reason: "Native authentication state is not a regular file." };
    }
    if (maxBytes < 0 || info.size > maxBytes) {
      return { status: "invalid", reason: "Native authentication state exceeds its capsule limit." };
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
      return { status: "invalid", reason: "Native authentication state exceeds its capsule limit." };
    }
    return { status: "ok", contents: Buffer.from(buffer.subarray(0, offset)) };
  } catch {
    return { status: "invalid", reason: "Native authentication state could not be opened safely." };
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
