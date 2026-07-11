import type { Job, Task } from "../contracts/durable";
import type { ArtifactStatus } from "../runtime/events";
import { appendNote, getReadContext, proposeFinal, recordArtifact } from "../runtime/ledger-api";
import type { PersistentMessageQueue } from "../runtime/message-queue";
import type { ProjectStateOptions } from "../runtime/project-state";
import { redactAndTruncate } from "../runtime/redaction";
import { HeadlessError } from "../runtime/headless-error";
import { appendEvent, getOrCreateSession } from "../runtime/session";
import { sanitizeIdentityFields } from "./auth";
import type { RunToolCallHandler } from "./run-tool-endpoint";

export type RunToolOperationDependencies = {
  projectRoot: string;
  state?: ProjectStateOptions;
  getJob: (jobId: string) => Job | null;
  getTask: (jobId: string) => Task | null;
  messages: PersistentMessageQueue;
};

/** Build the deliberately small, non-administrative worker cooperation API. */
export function createRunToolCallHandler(deps: RunToolOperationDependencies): RunToolCallHandler {
  return (scope, operation, params) => {
    const job = deps.getJob(scope.jobId);
    if (!job || job.projectId !== scope.projectId || job.principal !== scope.principal) {
      throw denied("Run tool scope no longer matches its daemon-owned job.");
    }
    if ((job.sessionId ?? job.id) !== scope.sessionId) throw denied("Run tool session scope does not match its job.");
    if (job.state !== "running") throw denied("Run tool calls are accepted only while the scoped job is running.");

    const runtime = {
      cwd: deps.projectRoot,
      state: deps.state,
      authenticatedPrincipal: scope.principal,
      sessionId: scope.sessionId,
    };

    if (operation === "context") {
      return getReadContext({
        ...runtime,
        view: params.view as "summary" | "recent",
        limit: params.limit as number,
      });
    }
    if (operation === "task_status") {
      const task = deps.getTask(scope.jobId);
      if (!task || task.jobId !== scope.jobId || task.projectId !== scope.projectId) throw denied("Scoped job task is unavailable.");
      return task;
    }
    if (operation === "note") {
      return appendNote({
        ...runtime,
        text: params.text as string,
        handlesHandoffId: params.handlesHandoffId as string | undefined,
      });
    }
    if (operation === "artifact") {
      return recordArtifact({
        ...runtime,
        kind: params.kind as string,
        title: params.title as string,
        summary: params.summary as string,
        status: params.status as ArtifactStatus,
        evidence: params.evidence as string[],
      });
    }
    if (operation === "propose_final") {
      return proposeFinal({
        ...runtime,
        summary: params.summary as string,
        evidence: params.evidence as string,
        remainingRisk: params.remainingRisk as string | undefined,
        handlesHandoffIds: params.handlesHandoffIds as string[],
      });
    }
    if (operation === "message_send") {
      const content = redactAndTruncate(params.content, 65_536).text;
      const meta = sanitizeIdentityFields(params.meta as Record<string, unknown>);
      const queued = deps.messages.enqueue(scope.principal, scope.sessionId, content, {
        ...meta,
        runToolJobId: scope.jobId,
      });
      const session = getOrCreateSession(runtime);
      appendEvent(session, {
        type: "message",
        source: scope.principal,
        runId: scope.jobId,
        content,
        message: { from: scope.principal, to: params.to as string, content, kind: "run-scoped" },
        meta,
      });
      return queued;
    }
    if (operation === "messages_pull") {
      const messages = deps.messages.listUndrained(scope.principal, scope.sessionId, params.limit as number);
      deps.messages.markDrained(scope.principal, messages.map((message) => message.id));
      return { messages };
    }

    const content = operation === "ask_for_more_work"
      ? params.completed as string
      : params.reason as string;
    const session = getOrCreateSession(runtime);
    return appendEvent(session, {
      type: operation,
      source: scope.principal,
      runId: scope.jobId,
      content,
      meta: operation === "ask_for_more_work"
        ? { from: scope.principal, completed: content, runScoped: true }
        : { from: scope.principal, reason: content, runScoped: true },
    });
  };
}

function denied(message: string) {
  return new HeadlessError("POLICY_DENIED", message);
}
