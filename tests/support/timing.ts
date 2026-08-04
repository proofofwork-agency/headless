import { setDefaultTimeout } from "bun:test";

/**
 * bun's per-test ceiling when a file declares none, and the reason a scaled
 * observation window is not free: every wall-clock wait happens *inside* a
 * per-test budget, so a window wider than that budget can never be reached. The
 * test dies at the budget with an opaque `timed out after Nms` that is
 * indistinguishable from a real product hang, and the fixture's own diagnostic
 * never prints.
 */
const BUN_DEFAULT_TEST_TIMEOUT_MS = 5_000;

/**
 * Head-room a test needs around its longest wait: fixture setup, teardown, and
 * the assertions themselves. Keeping it in one place is what makes a declared
 * budget provably larger than a window of the same local size.
 */
const FIXTURE_ALLOWANCE_MS = 5_000;

/** The widened ceiling a two-core hosted Linux runner needs to deliver an event. */
const SLOW_LINUX_CI_FLOOR_MS = 10_000;

/**
 * Scaling inputs, taken as a value so the invariant between a window and its
 * enclosing budget can be asserted for legs this machine is not (Linux CI in
 * particular, where the floor below is what made the old ceiling unreachable).
 */
export type TimingContext = {
  inCi: boolean;
  slowLinuxCi: boolean;
  declaredScale: number;
};

export function timingContext(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  platform: string = process.platform,
): TimingContext {
  const inCi = env.CI === "true" || env.GITHUB_ACTIONS === "true";
  /**
   * Explicit multiplier for a machine the suite cannot detect as loaded. A
   * developer box running a full build alongside the suite is slower than a CI
   * runner, but nothing in the environment says so.
   */
  const raw = Number(env.HEADLESS_TEST_TIME_SCALE);
  return {
    inCi,
    slowLinuxCi: platform === "linux" && inCi,
    declaredScale: Number.isFinite(raw) && raw >= 1 && raw <= 20 ? raw : 1,
  };
}

/**
 * CI runners are slow everywhere, not only on Linux. The original ceiling only
 * widened for Linux CI, which left macOS CI and every loaded developer machine
 * asserting against a local-speed deadline — the most common source of a test
 * that passes alone and fails inside the full suite.
 */
export function scaledWindow(localMs: number, context: TimingContext) {
  const scaled = Math.ceil(localMs * (context.inCi ? 2 : 1) * context.declaredScale);
  return context.slowLinuxCi ? Math.max(scaled, SLOW_LINUX_CI_FLOOR_MS) : scaled;
}

/**
 * The per-test budget that makes a window of the same local size reachable.
 * Both sides scale identically, so a file that declares its longest wait is
 * correct on every leg — including the Linux floor, which lifts window and
 * budget together instead of only the window.
 */
export function scaledTestTimeout(localMs: number, context: TimingContext) {
  return scaledWindow(localMs, context) + scaledWindow(FIXTURE_ALLOWANCE_MS, context);
}

const ambient = timingContext();

/**
 * bun runs one test file at a time but every file shares this module, so a
 * budget declared by the previously-run file would silently license a window
 * the current file never asked for. Attribute declarations and requests to
 * their source file so an undeclared file keeps bun's default.
 */
const declaredBudgets = new Map<string, number>();
const TIMING_MODULE = import.meta.path;

function callerFile() {
  for (const line of (new Error().stack ?? "").split("\n")) {
    const file = /(\/[^\s()]+\.(?:ts|tsx|js|mjs|cjs))[:)]/.exec(line)?.[1];
    if (file && file !== TIMING_MODULE) return file;
  }
  return null;
}

/**
 * Declares the calling file's per-test budget from the longest local window it
 * waits on, and applies it through bun. Prefer this over a bare
 * `setDefaultTimeout`: an unscaled budget stops scaling with the windows inside
 * it, which is how a widened CI ceiling ends up unreachable again.
 */
export function setTestTimeout(localMs: number) {
  const budget = scaledTestTimeout(localMs, ambient);
  const file = callerFile();
  if (file) declaredBudgets.set(file, budget);
  setDefaultTimeout(budget);
  return budget;
}

/**
 * A single test's ceiling, for a case that needs more than its file's budget
 * (a CPU-heavy body, or one real sandbox/relay launch). Same scaling as
 * `setTestTimeout`, so it can only ever raise the ceiling, never strand a
 * window above it.
 */
export function testTimeout(localMs: number) {
  return scaledTestTimeout(localMs, ambient);
}

/**
 * Keep scheduler/condition assertions tight locally while allowing a loaded
 * runner to deliver the event that the test is observing.
 * This changes only the observation ceiling, never the product deadline.
 *
 * Refuses to hand back a window the enclosing per-test budget cannot reach: a
 * silent clamp is what let the 2026-07 Linux deflake widen every ceiling to 10s
 * inside a 5s budget, buying nothing and replacing a legible fixture error with
 * a bun timeout.
 */
export function schedulingWindow(localMs: number) {
  const scaled = scaledWindow(localMs, ambient);
  const file = callerFile();
  const budget = (file && declaredBudgets.get(file)) ?? BUN_DEFAULT_TEST_TIMEOUT_MS;
  if (scaled >= budget) {
    throw new Error(
      `Observation window of ${scaled}ms is not reachable inside a ${budget}ms per-test budget`
      + ` (requested ${localMs}ms local${ambient.slowLinuxCi ? ", raised by the slow-Linux-CI floor" : ""}).`
      + ` Declare the budget in ${file ?? "the test file"} with setTestTimeout(${localMs}) from tests/support/timing.`,
    );
  }
  return scaled;
}

/** Keep condition-driven polling dense while extending only its CI ceiling. */
export function schedulingAttempts(localAttempts: number) {
  return ambient.slowLinuxCi ? localAttempts * 4 : Math.ceil(localAttempts * (ambient.inCi ? 2 : 1) * ambient.declaredScale);
}

/**
 * A deadline for a polling loop. Prefer this over a bare `Date.now() + n`: an
 * unscaled deadline is the exact shape that passes locally and fails on a
 * loaded machine, and it is invisible in review because it looks like ordinary
 * arithmetic.
 */
export function schedulingDeadline(localMs: number) {
  return Date.now() + schedulingWindow(localMs);
}
