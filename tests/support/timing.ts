const inCi = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
const slowLinuxCi = process.platform === "linux" && inCi;

/**
 * Explicit multiplier for a machine the suite cannot detect as loaded. A
 * developer box running a full build alongside the suite is slower than a CI
 * runner, but nothing in the environment says so.
 */
const declaredScale = (() => {
  const raw = Number(process.env.HEADLESS_TEST_TIME_SCALE);
  return Number.isFinite(raw) && raw >= 1 && raw <= 20 ? raw : 1;
})();

/**
 * CI runners are slow everywhere, not only on Linux. The original ceiling only
 * widened for Linux CI, which left macOS CI and every loaded developer machine
 * asserting against a local-speed deadline — the most common source of a test
 * that passes alone and fails inside the full suite.
 */
const baseScale = inCi ? 2 : 1;
const scale = baseScale * declaredScale;

/**
 * Keep scheduler/condition assertions tight locally while allowing a loaded
 * runner to deliver the event that the test is observing.
 * This changes only the observation ceiling, never the product deadline.
 */
export function schedulingWindow(localMs: number) {
  const scaled = Math.ceil(localMs * scale);
  return slowLinuxCi ? Math.max(scaled, 10_000) : scaled;
}

/** Keep condition-driven polling dense while extending only its CI ceiling. */
export function schedulingAttempts(localAttempts: number) {
  return slowLinuxCi ? localAttempts * 4 : Math.ceil(localAttempts * scale);
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

/**
 * A per-test ceiling for a body that is deterministic but CPU-heavy. Bun's 5s
 * default is a local-speed budget, and such a test does not get slower — the
 * machine does. Left on the default it passes alone and reports a timeout as a
 * product failure inside the full suite, which is indistinguishable from a real
 * regression in the log. Pass a bound generous enough that only a genuine hang
 * can reach it.
 */
export function cpuBoundTimeout(localMs: number) {
  return schedulingWindow(localMs);
}
