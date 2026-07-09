import { spawn } from "bun";
import type { ExecOptions, ExecResult, Backend } from "../index";
import { assertModeAllowed, backendAdapters, buildBackendEnv, type BackendAdapter } from "../backends/registry";
import { captureWriteDiff, createWriteWorktree, planWriteWorktree, removeWriteWorktree, type WriteDiff } from "../runtime/worktree";

const DEFAULT_TIMEOUT = 180_000;

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
  const cmd = adapter.buildCommand(opts, cwd);

  const proc = spawn(cmd, {
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

  // Feed prompt for stdin-based tools
  if (adapter.stdinPrompt && proc.stdin) {
    proc.stdin.write(prompt + "\n");
    proc.stdin.end();
  }

  const stdoutPromise = Bun.readableStreamToText(proc.stdout);
  const stderrPromise = Bun.readableStreamToText(proc.stderr);
  const [exitCode, outText, errText] = await Promise.all([
    proc.exited,
    stdoutPromise,
    stderrPromise,
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

function killProcessTree(pid: number | undefined) {
  if (!pid) return;
  try {
    spawn(["sh", "-c", "pkill -TERM -P \"$1\" 2>/dev/null || true; kill -TERM \"$1\" 2>/dev/null || true", "sh", String(pid)], {
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
}
