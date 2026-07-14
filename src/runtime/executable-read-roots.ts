import { createRequire } from "node:module";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export const MAX_EXECUTABLE_PATH_ENTRIES = 256;
export const MAX_EXECUTABLE_RUNTIME_ROOTS = 32;
export const MAX_EXECUTABLE_PATH_BYTES = 4_096;
export const MAX_EXECUTABLE_PATH_VALUE_BYTES = 64 * 1_024;
export const MAX_EXECUTABLE_MANIFEST_BYTES = 64 * 1_024;
export const MAX_EXECUTABLE_SHEBANG_BYTES = 512;
const MAX_NODE_MODULE_ANCESTORS = 16;
const CODEX_PACKAGE_NAME = "@openai/codex";
const MAX_PACKAGE_VERSION_BYTES = 256;

type PackageMetadata = {
  name: string;
  version: string | null;
  optionalDependencies: Record<string, string>;
};

export function executableReadRoots(command: string[], env: NodeJS.ProcessEnv) {
  const roots = new Set<string>();
  const executable = resolveExecutable(command[0], env.PATH);
  if (!executable) return [];
  addRoot(roots, executable);
  for (const interpreter of shebangInterpreterRoots(executable, env.PATH)) addRoot(roots, interpreter);

  const codex = codexRuntimeRoots(executable);
  if (codex) {
    for (const root of codex) addRoot(roots, root);
    const node = resolveExecutable("node", env.PATH);
    if (node) addRoot(roots, node);
  }
  return [...roots];
}

function shebangInterpreterRoots(executable: string, pathValue: string | undefined) {
  const shebang = readShebang(executable);
  if (!shebang) return [];
  const fields = shebang.split(/[\t ]+/);
  if (fields[0] === "/usr/bin/env") {
    if (fields.length !== 2 || !safeInterpreterName(fields[1])) return [];
    const env = resolveExecutable("/usr/bin/env", undefined);
    const interpreter = resolveExecutable(fields[1], pathValue);
    return env && interpreter ? [env, interpreter] : [];
  }
  if (fields.length !== 1 || !isAbsolute(fields[0]!)) return [];
  const interpreter = resolveExecutable(fields[0], undefined);
  return interpreter ? [interpreter] : [];
}

function readShebang(path: string) {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) return null;
    const buffer = Buffer.alloc(MAX_EXECUTABLE_SHEBANG_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (buffer.subarray(0, length).includes(0x0a)) break;
    }
    const newline = buffer.subarray(0, length).indexOf(0x0a);
    const lineLength = newline >= 0 ? newline : length;
    if (lineLength > MAX_EXECUTABLE_SHEBANG_BYTES || (newline < 0 && length === buffer.length)) return null;
    let line = buffer.subarray(0, lineLength).toString("utf8");
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line.startsWith("#!")) return null;
    const value = line.slice(2).trim();
    return value && !/[\0\r\n]/.test(value) ? value : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // A close failure cannot expand the exact interpreter allowlist.
      }
    }
  }
}

function safeInterpreterName(value: string | undefined): value is string {
  return !!value
    && Buffer.byteLength(value) <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value);
}

export function resolveExecutable(executable: string | undefined, pathValue: string | undefined) {
  if (!executable || Buffer.byteLength(executable) > MAX_EXECUTABLE_PATH_BYTES || executable.includes("\0")) return null;
  if (!isAbsolute(executable)
    && (!pathValue
      || Buffer.byteLength(pathValue) > MAX_EXECUTABLE_PATH_VALUE_BYTES
      || pathValue.includes("\0"))) return null;
  const candidates = isAbsolute(executable)
    ? [executable]
    : pathValue!.split(delimiter).filter(Boolean).slice(0, MAX_EXECUTABLE_PATH_ENTRIES).map((entry) => join(entry, executable));
  for (const candidate of candidates) {
    if (Buffer.byteLength(candidate) > MAX_EXECUTABLE_PATH_BYTES || !existsSync(candidate)) continue;
    try {
      const canonical = realpathSync.native(candidate);
      const info = lstatSync(canonical);
      if (!info.isFile() || Buffer.byteLength(canonical) > MAX_EXECUTABLE_PATH_BYTES) continue;
      return canonical;
    } catch {
      // A broken, looping, or concurrently replaced shim is not a readable
      // runtime root. The eventual contained spawn remains fail-closed.
    }
  }
  return null;
}

function codexRuntimeRoots(entrypoint: string) {
  if (basename(entrypoint) !== "codex.js" || basename(dirname(entrypoint)) !== "bin") return null;
  const packageRoot = canonicalDirectory(dirname(dirname(entrypoint)));
  if (!packageRoot) return null;
  const packageManifest = canonicalFileWithin(join(packageRoot, "package.json"), packageRoot);
  const mainMetadata = packageManifest ? packageMetadata(packageManifest) : null;
  if (!packageManifest || mainMetadata?.name !== CODEX_PACKAGE_NAME) return null;
  const target = codexPlatformTarget();
  if (!target) return [packageManifest];
  const aliasVersion = codexAliasVersion(mainMetadata.optionalDependencies[target.packageName]);

  const allowedNodeModules = nodeModulesAncestors(packageRoot);
  if (allowedNodeModules.length === 0) return [packageManifest];
  let platformManifestPath: string;
  try {
    platformManifestPath = createRequire(entrypoint).resolve(`${target.packageName}/package.json`);
  } catch {
    const bundledNative = canonicalFileWithin(
      join(packageRoot, "vendor", target.triple, "bin", "codex"),
      packageRoot,
    );
    return bundledNative ? [packageManifest, bundledNative] : [packageManifest];
  }
  const platformManifest = canonicalManifestWithinAny(
    platformManifestPath,
    allowedNodeModules,
    target.packageName,
    aliasVersion,
  );
  if (!platformManifest) return [packageManifest];
  const platformRoot = dirname(platformManifest);
  const nativeCandidate = join(platformRoot, "vendor", target.triple, "bin", "codex");
  const nativeExecutable = canonicalFileWithin(nativeCandidate, platformRoot);
  return nativeExecutable
    ? [packageManifest, platformManifest, nativeExecutable]
    : [packageManifest, platformManifest];
}

function codexPlatformTarget() {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return { packageName: "@openai/codex-darwin-arm64", triple: "aarch64-apple-darwin" };
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return { packageName: "@openai/codex-darwin-x64", triple: "x86_64-apple-darwin" };
  }
  if (process.platform === "linux" && process.arch === "arm64") {
    return { packageName: "@openai/codex-linux-arm64", triple: "aarch64-unknown-linux-musl" };
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return { packageName: "@openai/codex-linux-x64", triple: "x86_64-unknown-linux-musl" };
  }
  return null;
}

function canonicalManifestWithinAny(
  path: string,
  roots: string[],
  expectedName: string,
  aliasVersion: string | null,
) {
  let canonical: string;
  try {
    canonical = realpathSync.native(path);
  } catch {
    return null;
  }
  if (Buffer.byteLength(canonical) > MAX_EXECUTABLE_PATH_BYTES) return null;
  if (!roots.some((root) => isWithin(canonical, root))) return null;
  const metadata = packageMetadata(canonical);
  if (metadata?.name === expectedName) return canonical;
  return metadata?.name === CODEX_PACKAGE_NAME
    && aliasVersion !== null
    && metadata.version === aliasVersion
    ? canonical
    : null;
}

function packageMetadata(path: string): PackageMetadata | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_EXECUTABLE_MANIFEST_BYTES) return null;
    const buffer = Buffer.alloc(MAX_EXECUTABLE_MANIFEST_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > MAX_EXECUTABLE_MANIFEST_BYTES) return null;
    const value = JSON.parse(buffer.subarray(0, length).toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.name !== "string") return null;
    const version = typeof record.version === "string"
      && Buffer.byteLength(record.version) <= MAX_PACKAGE_VERSION_BYTES
      ? record.version
      : null;
    const optionalDependencies: Record<string, string> = {};
    if (record.optionalDependencies
      && typeof record.optionalDependencies === "object"
      && !Array.isArray(record.optionalDependencies)) {
      for (const [name, specifier] of Object.entries(record.optionalDependencies)) {
        if (typeof specifier === "string") optionalDependencies[name] = specifier;
      }
    }
    return { name: record.name, version, optionalDependencies };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // A close failure does not make untrusted package metadata readable.
      }
    }
  }
}

function codexAliasVersion(specifier: string | undefined) {
  const prefix = `npm:${CODEX_PACKAGE_NAME}@`;
  if (!specifier?.startsWith(prefix)) return null;
  const version = specifier.slice(prefix.length);
  return version
    && Buffer.byteLength(version) <= MAX_PACKAGE_VERSION_BYTES
    && /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(version)
    ? version
    : null;
}

function canonicalDirectory(path: string) {
  try {
    const canonical = realpathSync.native(path);
    return lstatSync(canonical).isDirectory() && Buffer.byteLength(canonical) <= MAX_EXECUTABLE_PATH_BYTES
      ? canonical
      : null;
  } catch {
    return null;
  }
}

function canonicalFileWithin(path: string, root: string) {
  try {
    const canonical = realpathSync.native(path);
    if (!isWithin(canonical, root) || Buffer.byteLength(canonical) > MAX_EXECUTABLE_PATH_BYTES) return null;
    return lstatSync(canonical).isFile() ? canonical : null;
  } catch {
    return null;
  }
}

function nodeModulesAncestors(path: string) {
  const roots: string[] = [];
  let current = path;
  const filesystemRoot = parse(path).root;
  for (let index = 0; index < MAX_NODE_MODULE_ANCESTORS && current !== filesystemRoot; index += 1) {
    if (basename(current) === "node_modules") roots.push(current);
    current = dirname(current);
  }
  return roots;
}

function isWithin(path: string, root: string) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function addRoot(roots: Set<string>, path: string) {
  if (roots.size >= MAX_EXECUTABLE_RUNTIME_ROOTS || Buffer.byteLength(path) > MAX_EXECUTABLE_PATH_BYTES) return;
  roots.add(resolve(path));
}
