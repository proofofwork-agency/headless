import { spawn } from "bun";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExecOptions, ExecResult, Backend } from "../index";
import { assertModeAllowed, backendAdapters, buildBackendEnv, type BackendAdapter } from "../backends/registry";
import { cleanupSandboxProfile, DARWIN_SANDBOX_EXEC, probeDarwinSandboxWriteDenial, writeDarwinSandboxProfile } from "../runtime/os-sandbox";
import { captureWriteDiff, createWriteWorktree, planWriteWorktree, removeWriteWorktree, type WriteDiff } from "../runtime/worktree";

const DEFAULT_TIMEOUT = 180_000;
const STREAM_CAP_BYTES = 16_000_000;
let sandboxProbe: ReturnType<typeof probeDarwinSandboxWriteDenial> | null = null;

export async function runHeadless(opts: ExecOptions & { backend: Backend }): Promise<ExecResult> {
  const start = Date.now();
  const cwd = opts.cwd || process.cwd();
  const backend = opts.backend;
  const adapter = backendAdapters[backend];
  const timeoutMs = opts.timeoutMs || adapter?.metadata.timeoutMs || DEFAULT_TIMEOUT;
  const prompt = opts.prompt;

  let env: NodeJS.ProcessEnv;

  if (!adapter) {
    throw new Error(`Backend ${backend} not yet implemented in simple runner`);
  }

  try {
    assertModeAllowed(backend, opts.mode);
    env = buildBackendEnv(adapter);
  } catch (error) {
    return failedResult(backend, error, Date.now() - start);
  }

  if (opts.mode === "write") {
    return runContainedWrite(opts, adapter, cwd, env, start, timeoutMs);
  }

  return runBackendProcess(opts, adapter, cwd, env, start, timeoutMs);
}

async function runContainedWrite(
  opts: ExecOptions & { backend: Backend },
  adapter: BackendAdapter,
  cwd: string,
  env: NodeJS.ProcessEnv,
  start: number,
  timeoutMs: number,
): Promise<ExecResult> {
  let plan;
  try {
    plan = planWriteWorktree({ primaryRoot: cwd, label: opts.backend });
    createWriteWorktree(plan);
  } catch (error) {
    const message = error instanceof Error && error.message.includes("not a git worktree root")
      ? `write mode requires a git repository: ${cwd}`
      : error;
    return failedResult(opts.backend, message, Date.now() - start);
  }

  let result: ExecResult = failedResult(opts.backend, "write-mode backend did not run", Date.now() - start);
  let captured: WriteDiff | null = null;
  try {
    try {
      result = await runBackendProcess(opts, adapter, plan.worktreePath, env, start, timeoutMs);
    } catch (error) {
      result = failedResult(opts.backend, error, Date.now() - start);
    }

    try {
      captured = captureWriteDiff(plan);
    } catch (error) {
      result = markFailed(result, `Failed to capture write diff: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    try {
      removeWriteWorktree(plan, { force: true });
    } catch (error) {
      // Cleanup errors are surfaced below after the forced removal attempt.
      captured = captured ?? null;
      const cleanupMessage = `Failed to clean up write worktree: ${error instanceof Error ? error.message : String(error)}`;
      result = markFailed(result, cleanupMessage);
    }
  }

  return {
    ...result,
    diff: captured ? { patch: captured.diff, status: captured.status, files: captured.files } : null,
    worktreeBranch: plan.branch,
  };
}

async function runBackendProcess(
  opts: ExecOptions & { backend: Backend },
  adapter: BackendAdapter,
  cwd: string,
  env: NodeJS.ProcessEnv,
  start: number,
  timeoutMs: number,
): Promise<ExecResult> {
  const backend = opts.backend;
  const prompt = opts.prompt;
  const wrapped = maybeWrapWithSandbox(adapter.buildCommand(opts, cwd), opts, adapter, cwd);

  try {
    const proc = spawn(wrapped.cmd, {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: adapter.stdinPrompt ? "pipe" : undefined,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(proc.pid);
    }, timeoutMs);

    // Feed prompt for stdin-based tools. When sandboxed, stdin flows through
    // sandbox-exec to the wrapped backend process.
    if (adapter.stdinPrompt && proc.stdin) {
      proc.stdin.write(prompt + "\n");
      proc.stdin.end();
    }

    // Read with a byte cap so a backend flooding stdout/stderr cannot OOM the
    // runner: on overflow we stop reading and kill the process tree.
    const onOverflow = () => killProcessTree(proc.pid);
    const [exitCode, outText, errText] = await Promise.all([
      proc.exited,
      readStreamCapped(proc.stdout, STREAM_CAP_BYTES, onOverflow),
      readStreamCapped(proc.stderr, STREAM_CAP_BYTES, onOverflow),
    ]);
    stdout = outText;
    stderr = errText;

    clearTimeout(timer);
    const durationMs = Date.now() - start;

    let output = stdout.trim();
    let cost: number | null = null;
    let tokens: number | null = null;
    let parseError: string | null = null;

    const parsed = adapter.parse(stdout);
    output = parsed.output;
    cost = parsed.cost;
    tokens = parsed.tokens;
    parseError = parsed.error;

    const noAssistantOutput = !output && !parseError;
    const finalOutput = output || parseError || stderr.trim() || (noAssistantOutput ? "No assistant output was produced by the backend." : stdout.trim());

    return {
      ok: isSuccessfulRun({ timedOut, parseError, noAssistantOutput, exitCode }),
      backend,
      output: finalOutput,
      cost,
      tokens,
      durationMs,
      exitCode,
      timedOut,
    };
  } finally {
    wrapped.cleanup();
  }
}

export function isSuccessfulRun(input: { timedOut: boolean; parseError: string | null; noAssistantOutput: boolean; exitCode: number | null }) {
  return !input.timedOut && !input.parseError && !input.noAssistantOutput && input.exitCode === 0;
}

function failedResult(backend: Backend, error: unknown, durationMs: number): ExecResult {
  return {
    ok: false,
    backend,
    output: error instanceof Error ? error.message : String(error),
    cost: null,
    tokens: null,
    durationMs,
    exitCode: null,
    timedOut: false,
  };
}

function markFailed(result: ExecResult, message: string): ExecResult {
  return {
    ...result,
    ok: false,
    output: result.output ? `${result.output}\n\n${message}` : message,
  };
}

export function maybeWrapWithSandbox(
  cmd: string[],
  opts: ExecOptions & { backend: Backend },
  adapter: BackendAdapter,
  cwd: string,
): { cmd: string[]; cleanup: () => void; sandboxed: boolean; reason?: string } {
  if (opts.mode === "write") return { cmd, cleanup: noop, sandboxed: false, reason: "write mode uses worktree containment" };
  if (process.platform !== "darwin") return { cmd, cleanup: noop, sandboxed: false, reason: `unsupported platform: ${process.platform}` };
  if (adapter.selfSandboxed) return { cmd, cleanup: noop, sandboxed: false, reason: "backend self-sandboxed" };

  // Cache only a SUCCESSFUL probe (the sandbox won't disappear once proven).
  // Re-probe whenever we don't yet have a success, so one transient failure
  // does not latch the sandbox off for the whole process lifetime.
  if (!sandboxProbe?.ok) sandboxProbe = probeDarwinSandboxWriteDenial();
  if (!sandboxProbe.ok) return { cmd, cleanup: noop, sandboxed: false, reason: sandboxProbe.reason };

  const profilePath = writeDarwinSandboxProfile({
    workdir: cwd,
    denyWriteRoots: sandboxCredentialRoots(),
    denyReadRoots: sandboxCredentialRoots(),
  });

  return {
    cmd: [DARWIN_SANDBOX_EXEC, "-f", profilePath, ...cmd],
    cleanup: () => cleanupSandboxProfile(profilePath),
    sandboxed: true,
  };
}

// Credential directories a read-only run should never read or write, kept
// outside the project so ordinary source reads are unaffected. (The project
// dir itself is always write-denied via `workdir`.)
function sandboxCredentialRoots() {
  const home = homedir();
  return [
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".gnupg"),
    join(home, ".config", "gcloud"),
  ].filter((path) => existsSync(path));
}

function noop() {}

async function readStreamCapped(stream: ReadableStream<Uint8Array>, maxBytes: number, onOverflow: () => void): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        onOverflow();
        try {
          await reader.cancel();
        } catch {}
        break;
      }
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
  return out;
}

function killProcessTree(pid: number | undefined) {
  if (!pid) return;
  // Recursively signal the WHOLE descendant tree, not just direct children:
  // `pkill -P` reaches one level, but a sandboxed backend's real workers are
  // grandchildren under sandbox-exec. TERM the tree (deepest first), then KILL
  // any survivors after a short grace. Runs detached so the grace doesn't block.
  const script = [
    'kt() { for c in $(pgrep -P "$1" 2>/dev/null); do kt "$c"; done; kill -TERM "$1" 2>/dev/null || true; }',
    'kt "$1"',
    'sleep 2',
    'kk() { for c in $(pgrep -P "$1" 2>/dev/null); do kk "$c"; done; kill -KILL "$1" 2>/dev/null || true; }',
    'kk "$1"',
  ].join("; ");
  try {
    spawn(["sh", "-c", script, "sh", String(pid)], {
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
}
