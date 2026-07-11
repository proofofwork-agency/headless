export const DEFAULT_TERMINATION_GRACE_MS = 1_500;
export const DEFAULT_KILL_WAIT_MS = 1_000;

export type ProcessTreeSignal = "SIGTERM" | "SIGKILL";

export type KillableChild = {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly exited: Promise<number>;
  kill(signal: ProcessTreeSignal): void;
};

export type ProcessTreeSignalDelivery = "group" | "child" | "none";

export type TerminateProcessTreeOptions = {
  graceMs?: number;
  killWaitMs?: number;
  signalGroup?: (pid: number, signal: ProcessTreeSignal) => void;
  groupAlive?: (pid: number) => boolean;
};

/**
 * Signal a detached child's process group, falling back to Bun's signal-only
 * Subprocess.kill API when process-group delivery is unavailable.
 */
export function signalProcessTree(
  child: Pick<KillableChild, "pid" | "kill">,
  signal: ProcessTreeSignal,
  signalGroup: (pid: number, signal: ProcessTreeSignal) => void = globalThis.process.kill,
): ProcessTreeSignalDelivery {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return "none";
  try {
    signalGroup(-child.pid, signal);
    return "group";
  } catch {
    try {
      child.kill(signal);
      return "child";
    } catch {
      return "none";
    }
  }
}

/** Deliver TERM, wait a bounded grace period, then escalate the full tree. */
export async function terminateProcessTree(
  child: KillableChild,
  options: TerminateProcessTreeOptions = {},
) {
  const graceMs = boundedDelay(options.graceMs, DEFAULT_TERMINATION_GRACE_MS);
  const killWaitMs = boundedDelay(options.killWaitMs, DEFAULT_KILL_WAIT_MS);
  const groupAlive = options.groupAlive ?? processGroupAlive;
  if (child.exitCode !== null && !groupAlive(child.pid)) {
    return { term: "none" as const, kill: "none" as const, exited: true };
  }
  const term = signalProcessTree(child, "SIGTERM", options.signalGroup);
  const tracksGroup = term === "group";
  if (await exitsWithin(child, graceMs, tracksGroup ? groupAlive : undefined)) {
    return { term, kill: "none" as const, exited: true };
  }
  const kill = signalProcessTree(child, "SIGKILL", options.signalGroup);
  const exited = await exitsWithin(child, killWaitMs, kill === "group" ? groupAlive : undefined);
  return { term, kill, exited };
}

async function exitsWithin(
  child: Pick<KillableChild, "pid" | "exitCode" | "exited">,
  waitMs: number,
  groupAlive?: (pid: number) => boolean,
) {
  if (groupAlive) {
    if (!groupAlive(child.pid)) return true;
    if (waitMs === 0) return false;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await delay(Math.min(25, Math.max(1, deadline - Date.now())));
      if (!groupAlive(child.pid)) return true;
    }
    return !groupAlive(child.pid);
  }
  if (child.exitCode !== null) return true;
  if (waitMs === 0) return Promise.resolve(false);
  return await Promise.race([
    child.exited.then(() => true, () => true),
    delay(waitMs).then(() => false),
  ]);
}

function processGroupAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !!error && typeof error === "object" && "code" in error && error.code === "EPERM";
  }
}

function boundedDelay(value: number | undefined, fallback: number) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > 60_000) {
    throw new TypeError("Process termination delay must be an integer between 0 and 60000 milliseconds.");
  }
  return value;
}

function delay(ms: number) {
  let timeout: ReturnType<typeof setTimeout>;
  const promise = new Promise<void>((resolve) => { timeout = setTimeout(resolve, ms); });
  timeout!.unref?.();
  return promise;
}
