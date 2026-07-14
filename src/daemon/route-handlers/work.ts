import { HeadlessError } from "../../runtime/headless-error";
import { assertPrincipalOwns } from "../auth";
import type { DaemonFamilyHandlerRegistrations } from "../route-dispatcher";
import type { DaemonRouteContext } from "../route-context";

type WorkFamilies = Pick<DaemonFamilyHandlerRegistrations,
  | "run"
  | "events"
  | "task"
  | "council"
  | "workflow"
  | "gate"
  | "orchestrator"
  | "session"
>;

export function workRouteHandlers(context: DaemonRouteContext): WorkFamilies {
  return {
    run: {
      "run.submit": (params, credential) => {
        context.assertRequestedSessionOwnership(params, credential);
        return context.submitRun(params, credential.principal);
      },
      "run.status": (params, credential) => context.requireJobFor(params.jobId, credential),
      "run.cancel": (params, credential) => context.cancelRun(context.requireJobFor(params.jobId, credential).id),
      "run.wait": (params, credential) => context.waitRun(
        context.requireJobFor(params.jobId, credential).id,
        typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
      ),
    },
    events: {
      "events.snapshot": (params, credential) => {
        requireEventFilter(params.jobId, credential, "reads");
        if (params.jobId) context.requireJobFor(params.jobId, credential);
        return { jobs: context.visibleJobs(credential, params.jobId), ...context.runEvents.snapshot(params) };
      },
      "events.wait": async (params, credential) => {
        requireEventFilter(params.jobId, credential, "waits");
        if (params.jobId) context.requireJobFor(params.jobId, credential);
        return { jobs: context.visibleJobs(credential, params.jobId), ...await context.runEvents.waitForSnapshot(params) };
      },
    },
    task: {
      "task.create": (params, credential) => {
        context.requireJobFor(params.jobId, credential);
        return context.tasks.create({ jobId: params.jobId, projectId: context.projectId, capability: params.capability });
      },
      "task.status": (params, credential) => {
        const task = context.requireTask(params.taskId);
        context.assertTaskVisible(task, credential);
        return task;
      },
      "task.list": (params, credential) => context.tasks.list(params)
        .filter((task) => context.isTaskVisible(task, credential)),
      "task.claim": (params, credential) => {
        context.assertTaskVisible(context.requireTask(params.taskId), credential);
        return context.tasks.claim({ ...params, principal: credential.principal });
      },
      "task.renew": (params, credential) => context.tasks.renew({ ...params, principal: credential.principal }),
      "task.complete": (params, credential) => context.tasks.complete({ ...params, principal: credential.principal }),
      "task.cancel": (params, credential) => {
        const task = context.requireTask(params.taskId);
        const job = context.requireJob(task.jobId);
        if (!credential.scopes.includes("admin") && task.claimedBy !== credential.principal) {
          assertPrincipalOwns(credential, job.principal, "Task");
        }
        return context.tasks.cancel({ ...params, principal: credential.principal });
      },
    },
    council: {
      "council.run": (params, credential) => context.runCouncil(params, credential.principal),
      "council.status": (params, credential) => {
        const record = context.councils.get(params.councilId);
        if (!record) throw new HeadlessError("INVALID_REQUEST", "Unknown council.");
        assertPrincipalOwns(credential, record.council.principal, "Council");
        return record;
      },
    },
    workflow: {
      "workflow.run": (params, credential) => context.createWorkflow(params, credential),
      "workflow.status": (params, credential) => context.requireWorkflowFor(params.workflowId, credential),
      "workflow.list": (_params, credential) => context.workflows.list()
        .filter((workflow) => credential.scopes.includes("admin") || workflow.principal === credential.principal),
      "workflow.wait": (params, credential) => {
        context.requireWorkflowFor(params.workflowId, credential);
        return context.waitWorkflow(params.workflowId, params.timeoutMs);
      },
      "workflow.cancel": (params, credential) => context.cancelWorkflow(
        context.requireWorkflowFor(params.workflowId, credential).id,
      ),
      "workflow.pause": (params, credential) => context.pauseWorkflow(context.requireWorkflowFor(params.workflowId, credential).id),
      "workflow.resume": (params, credential) => context.resumeWorkflow(context.requireWorkflowFor(params.workflowId, credential).id),
      "workflow.validate": (params, credential) => context.validateWorkflow(params, credential),
      "workflow.draft.create": (params, credential) => context.createWorkflowDraft(params, credential),
      "workflow.draft.list": (_params, credential) => context.listWorkflowDrafts(credential),
      "workflow.draft.get": (params, credential) => context.getWorkflowDraft(params.draftId, credential),
      "workflow.draft.launch": (params, credential) => context.launchWorkflowDraft(params.draftId, credential),
    },
    gate: {
      "gate.run": (params, credential) => context.runGate(params, credential.principal),
    },
    orchestrator: {
      "orchestrator.start": () => context.enableAutonomy(),
      "orchestrator.stop": () => context.disableAutonomy(),
      "orchestrator.status": () => context.autonomyStatus(),
    },
    session: {
      "session.create": (params, credential) => context.createSession(params, credential.principal),
      "session.send": (params, credential) => context.sendSession(params, credential),
      "session.resume": (params, credential) => context.sendSession(params, credential),
      "session.cancel": (params, credential) => context.cancelSession(params.sessionId, credential),
      "session.status": (params, credential) => context.requireSessionFor(params.sessionId, credential),
      "session.result": (params, credential) => context.requireSessionFor(params.sessionId, credential).result,
    },
  };
}

function requireEventFilter(jobId: string | undefined, credential: { scopes: string[] }, operation: "reads" | "waits") {
  if (!jobId && !credential.scopes.includes("admin")) {
    throw new HeadlessError("POLICY_DENIED", `Scoped event ${operation} require an owned jobId filter.`);
  }
}
