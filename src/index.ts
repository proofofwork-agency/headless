/** Stable Beta 1 surface: contained execution, run contracts, backend metadata, and structured errors. */

export type { Backend } from "./backends/ids";
export type { RunEvent, RunRequest, RunResult } from "./contracts/run";
export { backendChoices, normalizeBackend } from "./backends/ids";
export { backendMetadata, type BackendMetadata } from "./backends/metadata";
export { HeadlessError, errorCode, isHeadlessError, toHeadlessError, toStructuredError } from "./runtime/headless-error";

import type { Backend } from "./backends/ids";
import { resolveBackendId } from "./backends/registry";
import { HeadlessError } from "./runtime/headless-error";

export interface ExecOptions {
  backend: Backend | string;
  prompt: string;
  cwd?: string;
  mode?: "read-only" | "write";
  model?: string;
  agent?: string;
  timeoutMs?: number;
  /** Fail-closed by default. Unsafe execution must be explicitly requested. */
  containment?: "required" | "unsafe";
  /** Programmatic cancellation. */
  signal?: AbortSignal;
  sessionId?: string;
  /** Use the installed coder's scoped subscription login, or a daemon broker lease. */
  authMode?: import("./contracts/native").AuthMode;
  /** Tool/merge approval behavior; containment and finality remain mandatory. */
  approvalPolicy?: import("./contracts/native").ApprovalPolicy;
  /** Completion callback retained for lightweight callers; daemon events provide live streaming. */
  onStdoutChunk?: (chunk: string) => void;
  /** Receives each durable run event as it is observed from the daemon. */
  onEvent?: (event: import("./contracts/run").RunEvent) => void;
  /** Absolute trusted startup config used only when connecting/bootstrapping the daemon. */
  extensionConfigPath?: string;
  /** Absolute trusted extension entrypoints; never serialized into RunRequest. */
  extensionModules?: readonly string[];
}

/**
 * exec() — public simple entry for direct one-off contained execution.
 * Submits through the authenticated project daemon so policy, budgets, events,
 * cancellation, and durable job state have one authority.
 */
export async function exec(opts: ExecOptions): Promise<import("./contracts/run").RunResult> {
  const { connectOrStartDaemon } = await import("./daemon/connect.js");
  const { RunRequestSchema } = await import("./contracts/run.js");
  const projectRoot = (await import("./runtime/project-state.js")).canonicalizeProjectRoot(opts.cwd ?? process.cwd());
  let backend: string;
  try {
    backend = resolveBackendId(opts.backend);
  } catch {
    // Registered extension adapters may live in the already-running daemon
    // rather than this client process. The daemon remains the authority that
    // resolves and validates the final adapter id.
    backend = String(opts.backend).trim();
  }
  const validated = RunRequestSchema.parse({
    backend,
    prompt: opts.prompt,
    projectRoot,
    mode: opts.mode,
    model: opts.model,
    agent: opts.agent,
    timeoutMs: opts.timeoutMs,
    sessionId: opts.sessionId,
    containment: opts.containment,
    authMode: opts.authMode,
    approvalPolicy: opts.approvalPolicy,
  });
  const client = await connectOrStartDaemon({
    projectRoot,
    extensionConfigPath: opts.extensionConfigPath,
    extensionModules: opts.extensionModules,
  });
  const { projectRoot: _daemonOwnedProjectRoot, ...submittedRequest } = validated;
  const submitted = await client.call<import("./contracts/durable").Job>("run.submit", submittedRequest);
  const cancel = () => { void client.call("run.cancel", { jobId: submitted.id }, 2_000).catch(() => {}); };
  let waitFinished = false;
  const streamDiagnostics: string[] = [];
  const eventStream = streamExecEvents(client, submitted.id, opts, () => waitFinished, streamDiagnostics);
  opts.signal?.addEventListener("abort", cancel, { once: true });
  if (opts.signal?.aborted) cancel();
  try {
    const waitTimeoutMs = Math.min(validated.timeoutMs + 10_000, 86_400_000);
    const completed = submitted.result
      ? submitted
      : await waitForExecJob(client, submitted.id, waitTimeoutMs);
    if (!completed.result) throw new Error("Daemon returned a terminal job without a result.");
    waitFinished = true;
    await eventStream;
    let result = completed.result;
    if (streamDiagnostics.length > 0 && result.diagnostics) {
      result.diagnostics = {
        ...result.diagnostics,
        ignoredEvents: result.diagnostics.ignoredEvents + streamDiagnostics.length,
        messages: [...result.diagnostics.messages, ...streamDiagnostics].slice(0, 64),
      };
    }
    return result;
  } finally {
    waitFinished = true;
    await eventStream;
    opts.signal?.removeEventListener("abort", cancel);
  }
}

async function streamExecEvents(
  client: import("./daemon/client").HeadlessDaemonClient,
  jobId: string,
  opts: Pick<ExecOptions, "onEvent" | "onStdoutChunk">,
  isWaitFinished: () => boolean,
  diagnostics: string[],
) {
  if (!opts.onEvent && !opts.onStdoutChunk) return;
  let afterCursor = 0;
  while (true) {
    try {
      const snapshot = await client.call<{
        events: import("./contracts/run").RunEvent[];
        nextCursor: number;
      }>("events.wait", { jobId, afterCursor, limit: 200, timeoutMs: 500 }, 2_000);
      afterCursor = snapshot.nextCursor;
      for (const event of snapshot.events) {
        invokeExecCallback(() => opts.onEvent?.(event), "onEvent", diagnostics);
        if (event.kind === "stdout") {
          invokeExecCallback(() => opts.onStdoutChunk?.(event.text), "onStdoutChunk", diagnostics);
        }
      }
      if (snapshot.events.some((event) => event.kind === "completion")) return;
      if (isWaitFinished() && snapshot.events.length === 0) return;
    } catch {
      diagnostics.push("SDK event streaming became unavailable; the durable terminal result was still returned.");
      return;
    }
  }
}

function invokeExecCallback(callback: () => void, name: string, diagnostics: string[]) {
  try {
    callback();
  } catch {
    diagnostics.push(`SDK ${name} callback failed; execution continued.`);
  }
}

async function waitForExecJob(
  client: import("./daemon/client").HeadlessDaemonClient,
  jobId: string,
  waitTimeoutMs: number,
) {
  try {
    return await client.call<import("./contracts/durable").Job>(
      "run.wait",
      { jobId, timeoutMs: waitTimeoutMs },
      waitTimeoutMs + 5_000,
    );
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "TIMED_OUT") throw error;
    // The daemon owns the total lifecycle deadline. At the 24-hour public
    // boundary the wait timeout cannot include extra server-side grace, so poll
    // the durable terminal result briefly rather than throwing an expected
    // timeout as an exception or leaving queued work unattended.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const job = await client.call<import("./contracts/durable").Job>("run.status", { jobId }, 2_000);
      if (job.result) return job;
      await Bun.sleep(25);
    }
    await client.call("run.cancel", { jobId }, 2_000).catch(() => {});
    const job = await client.call<import("./contracts/durable").Job>("run.status", { jobId }, 2_000);
    if (job.result) return job;
    throw new HeadlessError("DAEMON_UNAVAILABLE", "Daemon did not persist a terminal result after the total lifecycle deadline.");
  }
}
