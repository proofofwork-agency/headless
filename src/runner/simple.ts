import { spawn } from "bun";
import type { ExecOptions, ExecResult, Backend } from "../index";
import { assertModeAllowed, backendAdapters, buildBackendEnv } from "../backends/registry";

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
    ok: !timedOut && !parseError && !noAssistantOutput && (exitCode === 0 || exitCode === null),
    backend,
    output: finalOutput,
    cost,
    tokens,
    durationMs,
    exitCode,
    timedOut,
  };
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
