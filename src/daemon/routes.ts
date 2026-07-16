import { z, type ZodTypeAny } from "zod";
import type { CredentialScope } from "../runtime/credential-store";
import {
  AuthorityGrantAddParamsSchema,
  AuthorityGrantRevokeParamsSchema,
  BudgetUpsertParamsSchema,
  EventsSnapshotParamsSchema,
  EventsWaitParamsSchema,
  GateRunParamsSchema,
  ApprovalListParamsSchema,
  ApprovalResolveParamsSchema,
  CandidateIdParamsSchema,
  CollaborationAcknowledgeParamsSchema,
  CollaborationListParamsSchema,
  CollaborationTransferSynthesizerParamsSchema,
  FleetProfileIdParamsSchema,
  FleetProfileUpsertParamsSchema,
  GoalIdParamsSchema,
  GoalSendParamsSchema,
  GoalStartParamsSchema,
  CouncilRunParamsSchema,
  LedgerArtifactParamsSchema,
  LedgerContextParamsSchema,
  LedgerEventParamsSchema,
  LedgerNoteParamsSchema,
  LedgerProposeFinalParamsSchema,
  LedgerRepairTailParamsSchema,
  LedgerTaskParamsSchema,
  LedgerVerifyParamsSchema,
  ReceiptListParamsSchema,
  ReceiptRunParamsSchema,
  MessagesMarkPushedParamsSchema,
  MessagesPullParamsSchema,
  MessagesPushParamsSchema,
  ProjectTrustGrantParamsSchema,
  RunSubmitParamsSchema,
  SessionCreateParamsSchema,
  SessionTurnParamsSchema,
  TaskCancelParamsSchema,
  TaskClaimParamsSchema,
  TaskCompleteParamsSchema,
  TaskCreateParamsSchema,
  TaskListParamsSchema,
  TaskRenewParamsSchema,
  TaskStatusParamsSchema,
  WorkflowIdParamsSchema,
  WorkflowRunParamsSchema,
  WorkflowWaitParamsSchema,
  WorkflowDraftIdParamsSchema,
  WorkflowDraftLaunchParamsSchema,
  type DaemonMethod,
  SkillIdParamsSchema,
  SkillImportParamsSchema,
  SkillUseParamsSchema,
  LoopStartParamsSchema,
  LoopIdParamsSchema,
  LeadGenerationParamsSchema,
  LeadUseParamsSchema,
  ObserverEventsParamsSchema,
} from "./protocol";

export type DaemonRouteFamily =
  | "system"
  | "lead"
  | "observer"
  | "project-trust"
  | "fleet"
  | "goal"
  | "collaboration"
  | "approval"
  | "candidate"
  | "authentication"
  | "authority"
  | "budget"
  | "run"
  | "events"
  | "task"
  | "ledger"
  | "receipt"
  | "messages"
  | "council"
  | "workflow"
  | "gate"
  | "orchestrator"
  | "session"
  | "skill"
  | "loop";

export type DaemonRouteDefinition<
  Method extends DaemonMethod = DaemonMethod,
  Schema extends ZodTypeAny = ZodTypeAny,
  Family extends DaemonRouteFamily = DaemonRouteFamily,
> = {
  method: Method;
  schema: Schema;
  scope: CredentialScope | null;
  handler: Family;
};

const empty = z.object({}).strict();
const id = (key: string) => z.object({ [key]: z.string().trim().min(1).max(160) }).strict();
const jobId = id("jobId");
const sessionId = id("sessionId");
const workflowId = WorkflowIdParamsSchema;

function route<
  const Method extends DaemonMethod,
  Schema extends ZodTypeAny,
  const Family extends DaemonRouteFamily,
>(
  method: Method,
  schema: Schema,
  scope: CredentialScope | null,
  handler: Family,
): DaemonRouteDefinition<Method, Schema, Family> {
  return { method, schema, scope, handler };
}

/** Single exhaustive source for daemon method validation, authorization, and dispatch family. */
export const DAEMON_ROUTES = {
  "ping": route("ping", empty, null, "system"),
  "lead.use": route("lead.use", LeadUseParamsSchema, "admin", "lead"),
  "lead.status": route("lead.status", empty, null, "lead"),
  "lead.release": route("lead.release", empty, "admin", "lead"),
  "lead.attach": route("lead.attach", LeadGenerationParamsSchema, null, "lead"),
  "lead.heartbeat": route("lead.heartbeat", LeadGenerationParamsSchema, null, "lead"),
  "lead.disconnect": route("lead.disconnect", LeadGenerationParamsSchema, null, "lead"),
  "observer.snapshot": route("observer.snapshot", empty, "observe", "observer"),
  "observer.events": route("observer.events", ObserverEventsParamsSchema, "observe", "observer"),
  "project.trust.status": route("project.trust.status", empty, "run", "project-trust"),
  "project.trust.grant": route("project.trust.grant", ProjectTrustGrantParamsSchema, "admin", "project-trust"),
  "project.trust.revoke": route("project.trust.revoke", empty, "admin", "project-trust"),
  "fleet.profile.upsert": route("fleet.profile.upsert", FleetProfileUpsertParamsSchema, "admin", "fleet"),
  "fleet.profile.get": route("fleet.profile.get", FleetProfileIdParamsSchema, "run", "fleet"),
  "fleet.profile.list": route("fleet.profile.list", empty, "run", "fleet"),
  "fleet.profile.remove": route("fleet.profile.remove", FleetProfileIdParamsSchema, "admin", "fleet"),
  "fleet.health": route("fleet.health", z.object({ profileId: z.string().trim().min(1).max(160).optional() }).strict(), "run", "fleet"),
  "goal.start": route("goal.start", GoalStartParamsSchema, "session", "goal"),
  "goal.send": route("goal.send", GoalSendParamsSchema, "session", "goal"),
  "goal.status": route("goal.status", GoalIdParamsSchema, "session", "goal"),
  "goal.list": route("goal.list", empty, "session", "goal"),
  "goal.cancel": route("goal.cancel", GoalIdParamsSchema, "session", "goal"),
  "goal.result": route("goal.result", GoalIdParamsSchema, "session", "goal"),
  "collaboration.turns": route("collaboration.turns", CollaborationListParamsSchema, "session", "collaboration"),
  "collaboration.messages": route("collaboration.messages", CollaborationListParamsSchema, "messages", "collaboration"),
  "collaboration.messages.acknowledge": route("collaboration.messages.acknowledge", CollaborationAcknowledgeParamsSchema, "messages", "collaboration"),
  "collaboration.transferSynthesizer": route("collaboration.transferSynthesizer", CollaborationTransferSynthesizerParamsSchema, "admin", "collaboration"),
  "approval.list": route("approval.list", ApprovalListParamsSchema, "session", "approval"),
  "approval.resolve": route("approval.resolve", ApprovalResolveParamsSchema, "admin", "approval"),
  "candidate.inspect": route("candidate.inspect", CandidateIdParamsSchema, "run", "candidate"),
  "candidate.integrate": route("candidate.integrate", CandidateIdParamsSchema, "run", "candidate"),
  "candidate.reject": route("candidate.reject", CandidateIdParamsSchema, "admin", "candidate"),
  "auth.provisionObserver": route("auth.provisionObserver", empty, "admin", "authentication"),
  "auth.list": route("auth.list", empty, "admin", "authentication"),
  "auth.revoke": route("auth.revoke", id("id"), "admin", "authentication"),
  "authority.grant.add": route("authority.grant.add", AuthorityGrantAddParamsSchema, "admin", "authority"),
  "authority.grant.revoke": route("authority.grant.revoke", AuthorityGrantRevokeParamsSchema, "admin", "authority"),
  "authority.grant.list": route("authority.grant.list", empty, "admin", "authority"),
  "budget.upsert": route("budget.upsert", BudgetUpsertParamsSchema, "admin", "budget"),
  "budget.list": route("budget.list", empty, "admin", "budget"),
  "run.submit": route("run.submit", RunSubmitParamsSchema, "run", "run"),
  "run.status": route("run.status", jobId, "run", "run"),
  "run.cancel": route("run.cancel", jobId, "run", "run"),
  "run.wait": route("run.wait", jobId.extend({ timeoutMs: z.number().int().positive().max(86_400_000).optional() }), "run", "run"),
  "events.snapshot": route("events.snapshot", EventsSnapshotParamsSchema, "run", "events"),
  "events.wait": route("events.wait", EventsWaitParamsSchema, "run", "events"),
  "task.create": route("task.create", TaskCreateParamsSchema, "task", "task"),
  "task.status": route("task.status", TaskStatusParamsSchema, "task", "task"),
  "task.list": route("task.list", TaskListParamsSchema, "task", "task"),
  "task.claim": route("task.claim", TaskClaimParamsSchema, "task", "task"),
  "task.renew": route("task.renew", TaskRenewParamsSchema, "task", "task"),
  "task.complete": route("task.complete", TaskCompleteParamsSchema, "task", "task"),
  "task.cancel": route("task.cancel", TaskCancelParamsSchema, "task", "task"),
  "ledger.note": route("ledger.note", LedgerNoteParamsSchema, "ledger:write", "ledger"),
  "ledger.artifact": route("ledger.artifact", LedgerArtifactParamsSchema, "ledger:write", "ledger"),
  "ledger.context": route("ledger.context", LedgerContextParamsSchema, "ledger:read", "ledger"),
  "ledger.task": route("ledger.task", LedgerTaskParamsSchema, "ledger:read", "ledger"),
  "ledger.proposeFinal": route("ledger.proposeFinal", LedgerProposeFinalParamsSchema, "ledger:write", "ledger"),
  "ledger.event": route("ledger.event", LedgerEventParamsSchema, "ledger:write", "ledger"),
  "ledger.verify": route("ledger.verify", LedgerVerifyParamsSchema, "ledger:read", "ledger"),
  "ledger.repairTail": route("ledger.repairTail", LedgerRepairTailParamsSchema, "admin", "ledger"),
  "receipt.get": route("receipt.get", ReceiptRunParamsSchema, "ledger:read", "receipt"),
  "receipt.list": route("receipt.list", ReceiptListParamsSchema, "ledger:read", "receipt"),
  "receipt.verify": route("receipt.verify", ReceiptRunParamsSchema, "ledger:read", "receipt"),
  "messages.push": route("messages.push", MessagesPushParamsSchema, "messages", "messages"),
  "messages.pull": route("messages.pull", MessagesPullParamsSchema, "messages", "messages"),
  "messages.markPushed": route("messages.markPushed", MessagesMarkPushedParamsSchema, "messages", "messages"),
  "council.run": route("council.run", CouncilRunParamsSchema, "council", "council"),
  "council.status": route("council.status", id("councilId"), "council", "council"),
  "workflow.run": route("workflow.run", WorkflowRunParamsSchema, "run", "workflow"),
  "workflow.status": route("workflow.status", workflowId, "run", "workflow"),
  "workflow.list": route("workflow.list", empty, "run", "workflow"),
  "workflow.wait": route("workflow.wait", WorkflowWaitParamsSchema, "run", "workflow"),
  "workflow.cancel": route("workflow.cancel", workflowId, "run", "workflow"),
  "workflow.pause": route("workflow.pause", workflowId, "run", "workflow"),
  "workflow.resume": route("workflow.resume", workflowId, "run", "workflow"),
  "workflow.validate": route("workflow.validate", WorkflowRunParamsSchema, "run", "workflow"),
  "workflow.draft.create": route("workflow.draft.create", WorkflowRunParamsSchema, "session", "workflow"),
  "workflow.draft.list": route("workflow.draft.list", empty, "session", "workflow"),
  "workflow.draft.get": route("workflow.draft.get", WorkflowDraftIdParamsSchema, "session", "workflow"),
  "workflow.draft.launch": route("workflow.draft.launch", WorkflowDraftLaunchParamsSchema, "session", "workflow"),
  "gate.run": route("gate.run", GateRunParamsSchema, "gate", "gate"),
  "orchestrator.start": route("orchestrator.start", empty, "orchestrator", "orchestrator"),
  "orchestrator.stop": route("orchestrator.stop", empty, "orchestrator", "orchestrator"),
  "orchestrator.status": route("orchestrator.status", empty, "orchestrator", "orchestrator"),
  "session.create": route("session.create", SessionCreateParamsSchema, "session", "session"),
  "session.send": route("session.send", SessionTurnParamsSchema, "session", "session"),
  "session.resume": route("session.resume", SessionTurnParamsSchema, "session", "session"),
  "session.cancel": route("session.cancel", sessionId, "session", "session"),
  "session.status": route("session.status", sessionId, "session", "session"),
  "session.result": route("session.result", sessionId, "session", "session"),
  "skill.list": route("skill.list", empty, "run", "skill"),
  "skill.inspect": route("skill.inspect", SkillIdParamsSchema, "run", "skill"),
  "skill.import": route("skill.import", SkillImportParamsSchema, "admin", "skill"),
  "skill.enable": route("skill.enable", SkillIdParamsSchema, "admin", "skill"),
  "skill.use": route("skill.use", SkillUseParamsSchema, "session", "skill"),
  "skill.revoke": route("skill.revoke", SkillIdParamsSchema, "admin", "skill"),
  "loop.start": route("loop.start", LoopStartParamsSchema, "session", "loop"),
  "loop.list": route("loop.list", empty, "session", "loop"),
  "loop.status": route("loop.status", LoopIdParamsSchema, "session", "loop"),
  "loop.pause": route("loop.pause", LoopIdParamsSchema, "session", "loop"),
  "loop.resume": route("loop.resume", LoopIdParamsSchema, "session", "loop"),
  "loop.cancel": route("loop.cancel", LoopIdParamsSchema, "session", "loop"),
} satisfies Record<DaemonMethod, DaemonRouteDefinition>;

export function daemonRoute(method: DaemonMethod) {
  return DAEMON_ROUTES[method];
}

export function parseDaemonRouteParams(method: DaemonMethod, params: unknown) {
  return daemonRoute(method).schema.parse(params);
}
