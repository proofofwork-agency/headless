import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  type Stats,
  writeSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import {
  MAX_EXECUTABLE_SHEBANG_BYTES,
  resolveExecutable,
} from "./executable-read-roots";
import type { WorkerEnvironmentPaths } from "./worker-environment";

export const MAX_DARWIN_STAGED_BUN_SCRIPT_BYTES = 256 * 1_024;
const STAGE_PREFIX = "darwin-bun-stage-";
const O_CLOEXEC = process.platform === "darwin" ? 0x01000000 : process.platform === "linux" ? 0x80000 : 0;

export type DarwinBunStage =
  | { kind: "none"; command: string[]; cleanup: () => void }
  | { kind: "rejected"; command: string[]; reason: string; cleanup: () => void }
  | {
    kind: "staged";
    command: string[];
    stagedDirectory: string;
    stagedScript: string;
    cleanup: () => void;
  };

export function stageDarwinBunScript(
  command: string[],
  pathValue: string | undefined,
  worker: Pick<WorkerEnvironmentPaths, "root" | "runtime">,
  workdir: string,
): DarwinBunStage {
  const noop = () => {};
  const executable = resolveExecutable(command[0], pathValue);
  if (!executable || basename(executable) === "codex.js") return { kind: "none", command, cleanup: noop };

  const exactBun = process.versions.bun ? resolveExecutable(process.execPath, undefined) : null;
  const inspected = inspectScript(executable, exactBun);
  if (inspected.kind === "none") return { kind: "none", command, cleanup: noop };
  if (inspected.kind === "rejected") {
    return { kind: "rejected", command, reason: inspected.reason, cleanup: noop };
  }

  const workerPaths = verifiedWorkerRuntime(worker);
  const project = canonicalDirectory(workdir);
  if (!workerPaths || !project) {
    inspected.content.fill(0);
    return {
      kind: "rejected",
      command,
      reason: "A verified Bun script requires a canonical owner-only worker runtime.",
      cleanup: noop,
    };
  }
  if (isWithin(executable, project) || isWithin(executable, workerPaths.root)) {
    inspected.content.fill(0);
    return { kind: "none", command, cleanup: noop };
  }

  let stagedDirectory: string | undefined;
  try {
    stagedDirectory = mkdtempSync(join(workerPaths.runtime, STAGE_PREFIX));
    chmodSync(stagedDirectory, 0o700);
    const stagedScript = join(stagedDirectory, "entry.ts");
    writeExclusive(stagedScript, inspected.content);
    return {
      kind: "staged",
      command: [inspected.exactBun, stagedScript, ...command.slice(1)],
      stagedDirectory,
      stagedScript,
      cleanup: () => rmSync(stagedDirectory!, { recursive: true, force: true }),
    };
  } catch {
    if (stagedDirectory) rmSync(stagedDirectory, { recursive: true, force: true });
    return {
      kind: "rejected",
      command,
      reason: "A verified Bun script could not be staged inside the isolated worker runtime.",
      cleanup: noop,
    };
  } finally {
    inspected.content.fill(0);
  }
}

function verifiedWorkerRuntime(worker: Pick<WorkerEnvironmentPaths, "root" | "runtime">) {
  try {
    const root = realpathSync.native(worker.root);
    const runtime = realpathSync.native(worker.runtime);
    const rootInfo = lstatSync(root);
    const runtimeInfo = lstatSync(runtime);
    const rel = relative(root, runtime);
    const uid = typeof process.getuid === "function" ? process.getuid() : rootInfo.uid;
    if (!rootInfo.isDirectory()
      || !runtimeInfo.isDirectory()
      || (rootInfo.mode & 0o700) !== 0o700
      || (runtimeInfo.mode & 0o700) !== 0o700
      || (rootInfo.mode & 0o077) !== 0
      || (runtimeInfo.mode & 0o077) !== 0
      || rootInfo.uid !== uid
      || runtimeInfo.uid !== uid
      || rel === ""
      || rel === ".."
      || rel.startsWith(`..${sep}`)
      || isAbsolute(rel)) return null;
    return { root, runtime };
  } catch {
    return null;
  }
}

function canonicalDirectory(path: string) {
  try {
    const canonical = realpathSync.native(path);
    return lstatSync(canonical).isDirectory() ? canonical : null;
  } catch {
    return null;
  }
}

function isWithin(path: string, root: string) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function inspectScript(executable: string, exactBun: string | null):
  | { kind: "none" }
  | { kind: "rejected"; reason: string }
  | { kind: "staged"; content: Buffer; exactBun: string } {
  let fd: number | undefined;
  try {
    fd = openSync(executable, constants.O_RDONLY | constants.O_NOFOLLOW | O_CLOEXEC);
    const initial = fstatSync(fd);
    if (!initial.isFile() || (initial.mode & 0o111) === 0) return { kind: "none" };
    const shebang = readFirstLine(fd);
    const classification = classifyShebang(shebang, exactBun);
    if (classification === "other") return { kind: "none" };
    if (classification === "unsafe" || !exactBun) {
      return { kind: "rejected", reason: "The Bun script uses an unsafe or unavailable interpreter shebang." };
    }
    if (initial.size > MAX_DARWIN_STAGED_BUN_SCRIPT_BYTES) {
      return { kind: "rejected", reason: "The Bun script exceeds the bounded staging limit." };
    }
    const content = readBounded(fd, MAX_DARWIN_STAGED_BUN_SCRIPT_BYTES);
    if (!content) {
      return { kind: "rejected", reason: "The Bun script changed or exceeded its bound during secure staging." };
    }
    const final = fstatSync(fd);
    let finalPath: string;
    let finalPathInfo: ReturnType<typeof lstatSync>;
    try {
      finalPath = realpathSync.native(executable);
      finalPathInfo = lstatSync(finalPath);
    } catch {
      content.fill(0);
      return { kind: "rejected", reason: "The Bun script identity changed during secure staging." };
    }
    if (classifyShebang(firstLine(content), exactBun) !== "safe"
      || finalPath !== executable
      || !sameFileState(initial, final)
      || !sameFileState(final, finalPathInfo)) {
      content.fill(0);
      return { kind: "rejected", reason: "The Bun script identity changed during secure staging." };
    }
    return { kind: "staged", content, exactBun };
  } catch {
    return { kind: "none" };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The descriptor is read-only and no staging grant is widened on close failure.
      }
    }
  }
}

function sameFileState(left: Stats, right: Stats) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function classifyShebang(line: string | null, exactBun: string | null) {
  if (!line?.startsWith("#!")) return "other" as const;
  if (line === "#!/usr/bin/env bun") return "safe" as const;
  const interpreter = line.slice(2);
  if (isAbsolute(interpreter) && !/[\t ]/.test(interpreter)) {
    const resolved = resolveExecutable(interpreter, undefined);
    if (exactBun && resolved === exactBun) return "safe" as const;
    return basename(interpreter) === "bun" ? "unsafe" as const : "other" as const;
  }
  if ((line.startsWith("#!/usr/bin/env") && /(?:^|[\t ])bun(?:$|[\t ])/.test(interpreter))
    || (exactBun && interpreter.startsWith(`${exactBun} `))
    || basename(interpreter.split(/[\t ]/, 1)[0] ?? "") === "bun") return "unsafe" as const;
  return "other" as const;
}

function readFirstLine(fd: number) {
  const buffer = Buffer.alloc(MAX_EXECUTABLE_SHEBANG_BYTES + 1);
  let length = 0;
  while (length < buffer.length) {
    const read = readSync(fd, buffer, length, buffer.length - length, length);
    if (read === 0) break;
    length += read;
    if (buffer.subarray(0, length).includes(0x0a)) break;
  }
  const newline = buffer.subarray(0, length).indexOf(0x0a);
  const lineLength = newline >= 0 ? newline : length;
  if (lineLength > MAX_EXECUTABLE_SHEBANG_BYTES || (newline < 0 && length === buffer.length)) return null;
  let line = buffer.subarray(0, lineLength).toString("utf8");
  if (line.endsWith("\r")) line = line.slice(0, -1);
  return line;
}

function readBounded(fd: number, maxBytes: number) {
  const buffer = Buffer.alloc(maxBytes + 1);
  let length = 0;
  while (length < buffer.length) {
    const read = readSync(fd, buffer, length, buffer.length - length, length);
    if (read === 0) break;
    length += read;
  }
  if (length > maxBytes) {
    buffer.fill(0);
    return null;
  }
  return buffer.subarray(0, length);
}

function firstLine(content: Buffer) {
  const newline = content.indexOf(0x0a);
  let line = content.subarray(0, newline >= 0 ? newline : content.length).toString("utf8");
  if (line.endsWith("\r")) line = line.slice(0, -1);
  return line;
}

function writeExclusive(path: string, content: Buffer) {
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | O_CLOEXEC,
      0o600,
    );
    let offset = 0;
    while (offset < content.length) {
      const written = writeSync(fd, content, offset, content.length - offset, offset);
      if (written <= 0) throw new Error("The staged Bun script could not be written completely.");
      offset += written;
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
