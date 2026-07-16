const slowLinuxCi = process.platform === "linux"
  && (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true");

/**
 * Keep scheduler/condition assertions tight locally while allowing a loaded
 * two-core Linux runner to deliver the event that the test is observing.
 * This changes only the observation ceiling, never the product deadline.
 */
export function schedulingWindow(localMs: number) {
  return slowLinuxCi ? Math.max(localMs, 10_000) : localMs;
}

/** Keep condition-driven polling dense while extending only its CI ceiling. */
export function schedulingAttempts(localAttempts: number) {
  return slowLinuxCi ? localAttempts * 4 : localAttempts;
}
