import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type ValidationCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
};

export type LiveValidationFixture = {
  root: string;
  project: string;
  stateHome: string;
  runtimeHome: string;
  cli: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  run(args: string[], timeoutMs?: number): Promise<ValidationCommandResult>;
};

type SignalName = "SIGINT" | "SIGTERM" | "SIGHUP";
const SIGNAL_EXIT_CODES: ReadonlyArray<readonly [SignalName, number]> = [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
];

/**
 * Own one disposable live-validation project from creation through bounded
 * daemon shutdown and filesystem cleanup, including interrupt paths.
 */
export async function withLiveValidationFixture<T>(
  prefix: string,
  execute: (fixture: LiveValidationFixture) => Promise<T>,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const project = join(root, "project");
  const stateHome = join(root, "state");
  const runtimeHome = mkdtempSync(join("/tmp", `${prefix.slice(0, 12)}-runtime-`));
  const cli = resolve(import.meta.dir, "../dist/cli.js");
  mkdirSync(project, { recursive: true, mode: 0o700 });
  mkdirSync(stateHome, { recursive: true, mode: 0o700 });

  const env = {
    ...process.env,
    HEADLESS_STATE_HOME: stateHome,
    HEADLESS_RUNTIME_HOME: runtimeHome,
    XDG_RUNTIME_DIR: runtimeHome,
    // Live validators exercise native-login, never ambient broker credentials.
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    GEMINI_API_KEY: "",
    GOOGLE_API_KEY: "",
    XAI_API_KEY: "",
  };
  const controller = new AbortController();
  const activeChildren = new Set<ReturnType<typeof Bun.spawn>>();
  let signalExitCode: number | null = null;
  const signalHandlers = SIGNAL_EXIT_CODES.map(([signal, exitCode]) => {
    const handler = () => {
      signalExitCode = exitCode;
      controller.abort(signal);
      for (const child of activeChildren) child.kill("SIGTERM");
    };
    process.once(signal, handler);
    return { signal, handler };
  });

  const run = (args: string[], timeoutMs = 120_000) => runBounded(
    ["bun", cli, ...args],
    { cwd: project, env, timeoutMs, signal: controller.signal, activeChildren },
  );

  try {
    const result = await execute({
      root,
      project,
      stateHome,
      runtimeHome,
      cli,
      env,
      signal: controller.signal,
      run,
    });
    if (controller.signal.aborted) {
      throw new Error(`Live validation interrupted by ${String(controller.signal.reason)}.`);
    }
    return result;
  } finally {
    controller.abort("validation cleanup");
    for (const child of activeChildren) child.kill("SIGTERM");
    await stopFixtureDaemon(cli, project, env);
    rmSync(root, { recursive: true, force: true });
    rmSync(runtimeHome, { recursive: true, force: true });
    for (const { signal, handler } of signalHandlers) process.off(signal, handler);
    if (signalExitCode !== null) process.exitCode = signalExitCode;
  }
}

async function stopFixtureDaemon(cli: string, project: string, env: NodeJS.ProcessEnv) {
  // `daemon stop` never autostarts. A non-zero result simply means setup never
  // reached daemon ownership or the daemon already exited.
  await runBounded(
    ["bun", cli, "daemon", "stop", "--cwd", project],
    {
      cwd: project,
      env,
      timeoutMs: 40_000,
      signal: new AbortController().signal,
      activeChildren: new Set(),
    },
  ).catch(() => undefined);
}

async function runBounded(
  command: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    signal: AbortSignal;
    activeChildren: Set<ReturnType<typeof Bun.spawn>>;
  },
): Promise<ValidationCommandResult> {
  if (options.signal.aborted) throw new Error(`Command cancelled before launch: ${String(options.signal.reason)}.`);
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  options.activeChildren.add(child);
  let timedOut = false;
  const onAbort = () => child.kill("SIGTERM");
  options.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, options.timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode: exitCode ?? 1, timedOut };
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", onAbort);
    options.activeChildren.delete(child);
  }
}
