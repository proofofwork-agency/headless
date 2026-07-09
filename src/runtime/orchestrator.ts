import type { Backend, ExecOptions, ExecResult } from "../index";
import { normalizeBackend } from "../backends/ids";
import { backendMetadata } from "../backends/metadata";
import { runHeadless } from "../runner/simple";
import type { ArtifactStatus, HeadlessEvent } from "./events";
import { deriveTaskState, readContext, type ReadContextView } from "./read-model";
import { redactAndTruncate } from "./redaction";
import { appendEvent, getOrCreateSession, readLedger, type HeadlessSession, type SessionOptions } from "./session";

export type RuntimeOptions = SessionOptions & {
  source?: string;
};

export type HeadlessRunOptions = ExecOptions & RuntimeOptions & {
  label?: string;
};

export type DeliberationOptions = RuntimeOptions & {
  question: string;
  backends?: Array<Backend | string>;
  contextRefs?: string[];
  timeoutMs?: number;
  mode?: "read-only" | "write";
};

export function loadRuntime(opts: RuntimeOptions = {}) {
  const session = getOrCreateSession(opts);
  return {
    session,
    events: readLedger(session),
  };
}

export function appendNote(opts: RuntimeOptions & { text: string; handlesHandoffId?: string }) {
  const session = getOrCreateSession(opts);
  return appendEvent(session, {
    type: "note",
    source: opts.source || "headless",
    content: opts.text,
    handlesHandoffId: opts.handlesHandoffId,
  });
}

export function recordArtifact(opts: RuntimeOptions & {
  kind: string;
  title: string;
  summary: string;
  status?: ArtifactStatus;
  evidence?: string[];
}) {
  const session = getOrCreateSession(opts);
  return appendEvent(session, {
    type: "artifact",
    source: opts.source || "headless",
    content: `${opts.title}: ${opts.summary}`,
    artifact: {
      kind: opts.kind,
      title: opts.title,
      summary: opts.summary,
      status: opts.status || "unknown",
      evidence: opts.evidence,
    },
  });
}

export function proposeFinal(opts: RuntimeOptions & {
  summary: string;
  evidence: string;
  remainingRisk?: string;
  handlesHandoffIds?: string[];
}) {
  const session = getOrCreateSession(opts);
  return appendEvent(session, {
    type: "finality_proposal",
    source: opts.source || "headless",
    content: `summary: ${opts.summary}\n\nevidence: ${opts.evidence}\n\nremaining_risk: ${opts.remainingRisk || "none"}`,
    handlesHandoffIds: opts.handlesHandoffIds,
    meta: {
      summary: opts.summary,
      evidence: opts.evidence,
      remainingRisk: opts.remainingRisk || "none",
    },
  });
}

export function getReadContext(opts: RuntimeOptions & { view?: ReadContextView; limit?: number } = {}) {
  const session = getOrCreateSession(opts);
  return readContext(readLedger(session), { view: opts.view, limit: opts.limit });
}

export function getTaskState(opts: RuntimeOptions = {}) {
  const session = getOrCreateSession(opts);
  return deriveTaskState(readLedger(session));
}

export async function headlessRun(opts: HeadlessRunOptions) {
  const session = getOrCreateSession(opts);
  const runId = crypto.randomUUID();
  const backend = normalizeBackend(opts.backend);
  const source = opts.source || "headless";

  appendEvent(session, {
    type: "run_started",
    source,
    runId,
    content: opts.prompt,
    meta: {
      label: opts.label,
      backend,
      mode: opts.mode || "read-only",
      model: opts.model,
      agent: opts.agent,
      adapter: backendMetadata[backend],
    },
  });

  appendEvent(session, {
    type: "worker_spawned",
    source,
    runId,
    workerId: runId,
    content: `Spawned ${backend} worker.`,
    meta: {
      backend,
      cwd: opts.cwd || process.cwd(),
      timeoutMs: opts.timeoutMs,
    },
  });

  let result: ExecResult;
  try {
    result = await runHeadless({ ...opts, backend });
  } catch (error) {
    result = failedResult(backend, error);
  }

  const ledgerResult = redactResultForLedger(result);
  const event = appendResult(session, source, runId, ledgerResult);
  if (ledgerResult.diff) {
    appendEvent(session, {
      type: "artifact",
      source,
      runId,
      workerId: runId,
      content: `Write diff: ${ledgerResult.diff.files.length} file${ledgerResult.diff.files.length === 1 ? "" : "s"} changed.`,
      artifact: {
        kind: "write_diff",
        title: "Write diff",
        summary: `${ledgerResult.diff.files.length} file${ledgerResult.diff.files.length === 1 ? "" : "s"} changed in ${ledgerResult.worktreeBranch ?? "ephemeral worktree"}.`,
        status: ledgerResult.ok ? "passed" : "failed",
        evidence: ledgerResult.diff.files,
      },
      meta: {
        branch: ledgerResult.worktreeBranch,
        status: ledgerResult.diff.status,
        patch: ledgerResult.diff.patch,
      },
    });
  }
  return { session, runId, event, result };
}

export async function deliberate(opts: DeliberationOptions) {
  const session = getOrCreateSession(opts);
  const source = opts.source || "headless";
  const backends = (opts.backends?.length ? opts.backends : ["opencode"]).map(normalizeBackend);

  const handoff = appendEvent(session, {
    type: "handoff",
    source,
    content: opts.question,
    handoff: {
      from: source,
      to: "headless_workers",
      reason: "Bounded deliberation",
      ask: opts.question,
      contextRefs: opts.contextRefs,
      nextSpeaker: source,
    },
  });

  const runs = await Promise.all(
    backends.map((backend) =>
      headlessRun({
        cwd: opts.cwd,
        sessionId: session.sessionId,
        source,
        backend,
        prompt: deliberationPrompt(opts.question, opts.contextRefs),
        mode: opts.mode || "read-only",
        timeoutMs: opts.timeoutMs ?? backendMetadata[backend].timeoutMs,
        label: `deliberate:${handoff.id}`,
      }),
    ),
  );

  const okCount = runs.filter((run) => run.result.ok).length;
  appendEvent(session, {
    type: "note",
    source,
    content: okCount
      ? `Collected ${runs.length} deliberation result${runs.length === 1 ? "" : "s"} for parent synthesis.`
      : `Deliberation failed: all ${runs.length} worker result${runs.length === 1 ? "" : "s"} failed.`,
    handlesHandoffId: okCount ? handoff.id : undefined,
    meta: {
      runIds: runs.map((run) => run.runId),
      okCount,
    },
  });

  return {
    session,
    handoff,
    results: runs.map((run) => run.result),
  };
}

function appendResult(session: HeadlessSession, source: string, runId: string, result: ExecResult): HeadlessEvent {
  return appendEvent(session, {
    type: "headless_result",
    source,
    runId,
    workerId: runId,
    content: result.output,
    result,
    meta: {
      backend: result.backend,
      status: result.timedOut ? "timed_out" : result.ok ? "passed" : "failed",
    },
  });
}

function redactResultForLedger(result: ExecResult): ExecResult {
  const output = redactAndTruncate(result.output);
  const patch = result.diff ? redactAndTruncate(result.diff.patch) : null;
  const status = result.diff ? redactAndTruncate(result.diff.status) : null;
  return {
    ...result,
    output: output.text,
    diff: result.diff
      ? {
          ...result.diff,
          patch: patch?.text ?? result.diff.patch,
          status: status?.text ?? result.diff.status,
        }
      : result.diff,
  };
}

function failedResult(backend: Backend, error: unknown): ExecResult {
  return {
    ok: false,
    backend,
    output: error instanceof Error ? error.message : String(error),
    cost: null,
    tokens: null,
    durationMs: 0,
    exitCode: null,
    timedOut: false,
    diff: null,
    worktreeBranch: null,
  };
}

function deliberationPrompt(question: string, contextRefs?: string[]) {
  const refs = contextRefs?.length ? `\n\nContext refs:\n${contextRefs.map((ref) => `- ${ref}`).join("\n")}` : "";
  return `${question}${refs}\n\nReturn your independent analysis. Do not make file edits.`;
}
