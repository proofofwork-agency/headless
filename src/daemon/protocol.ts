import { z } from "zod";
import {
  BackendIdSchema,
  ContainmentRequirementSchema,
  IdentifierSchema,
  PositiveTimeoutSchema,
  RunModeSchema,
  SubmissionIdempotencyKeySchema,
  StructuredErrorSchema,
  TimestampSchema,
} from "../contracts/common";
import { RunRequestObjectSchema } from "../contracts/run";
import { SynthesizerSelectionSchema } from "../contracts/collaboration";
import { ApprovalPolicySchema, AuthModeSchema } from "../contracts/native";
import { AgentNameSchema, backendAgentSelectionRefinement } from "../contracts/agent-name";
import { LoopPolicySchema } from "../contracts/loop";

export const DAEMON_PROTOCOL_VERSION = 2 as const;
// Accommodates one fully bounded RunResult plus JSON framing without allowing
// unbounded local-socket buffering.
export const MAX_DAEMON_MESSAGE_BYTES = 4_000_000;

export const DaemonMethodSchema = z.enum([
  "ping",
  "capability.activate",
  "lead.use",
  "lead.status",
  "lead.release",
  "lead.attach",
  "lead.heartbeat",
  "lead.disconnect",
  "observer.snapshot",
  "observer.events",
  "project.trust.status",
  "project.trust.grant",
  "project.trust.revoke",
  "fleet.profile.upsert",
  "fleet.profile.get",
  "fleet.profile.list",
  "fleet.profile.remove",
  "fleet.health",
  "goal.start",
  "goal.send",
  "goal.status",
  "goal.list",
  "goal.cancel",
  "goal.result",
  "collaboration.turns",
  "collaboration.messages",
  "collaboration.messages.acknowledge",
  "collaboration.transferSynthesizer",
  "approval.list",
  "approval.resolve",
  "candidate.inspect",
  "candidate.integrate",
  "candidate.reject",
  "auth.provisionObserver",
  "auth.list",
  "auth.revoke",
  "authority.grant.add",
  "authority.grant.revoke",
  "authority.grant.list",
  "budget.upsert",
  "budget.list",
  "run.submit",
  "run.status",
  "run.cancel",
  "run.wait",
  "events.snapshot",
  "events.wait",
  "task.create",
  "task.status",
  "task.list",
  "task.claim",
  "task.renew",
  "task.complete",
  "task.cancel",
  "ledger.note",
  "ledger.artifact",
  "ledger.context",
  "ledger.task",
  "ledger.proposeFinal",
  "ledger.event",
  "ledger.verify",
  "ledger.repairTail",
  "receipt.get",
  "receipt.list",
  "receipt.verify",
  "receipt.export",
  "messages.push",
  "messages.pull",
  "messages.markPushed",
  "council.run",
  "council.status",
  "workflow.run",
  "workflow.status",
  "workflow.list",
  "workflow.wait",
  "workflow.cancel",
  "workflow.pause",
  "workflow.resume",
  "workflow.validate",
  "workflow.draft.create",
  "workflow.draft.list",
  "workflow.draft.get",
  "workflow.draft.launch",
  "gate.run",
  "orchestrator.start",
  "orchestrator.stop",
  "orchestrator.status",
  "session.create",
  "session.send",
  "session.resume",
  "session.cancel",
  "session.status",
  "session.result",
  "skill.list",
  "skill.inspect",
  "skill.import",
  "skill.enable",
  "skill.use",
  "skill.revoke",
  "loop.start",
  "loop.list",
  "loop.status",
  "loop.pause",
  "loop.resume",
  "loop.cancel",
]);

export const LeadUseParamsSchema = z.object({
  host: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
}).strict();
export const LeadGenerationParamsSchema = z.object({
  generation: z.number().int().positive(),
}).strict();

export const DaemonRequestSchema = z.object({
  version: z.literal(DAEMON_PROTOCOL_VERSION),
  id: z.string().uuid(),
  token: z.string().min(32).max(512),
  method: DaemonMethodSchema,
  params: z.record(z.unknown()).default({}),
}).strict();

export const DaemonResponseSchema = z.object({
  version: z.literal(DAEMON_PROTOCOL_VERSION),
  id: z.string().uuid(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: StructuredErrorSchema.optional(),
}).strict();

export const AuthorityGrantAddParamsSchema = z.object({
  id: IdentifierSchema.optional(),
  principal: z.string().trim().min(1).max(128),
  operations: z.array(z.enum(["run", "write", "merge", "council", "workflow", "admin"])).min(1).max(16),
  backends: z.array(z.string().trim().min(1).max(64)).min(1).max(64),
  expiresAt: z.number().int().positive(),
  maxCostUsd: z.number().nonnegative().nullable().default(null),
  maxIterations: z.number().int().positive().max(10_000).nullable().default(null),
}).strict();

export const ProjectTrustGrantParamsObjectSchema = z.object({
  nativeLoginAllowed: z.boolean().default(false),
  nativeDirectUnrestrictedAcknowledged: z.boolean().default(false),
  bypassAllowed: z.boolean().default(false),
}).strict();

export const ProjectTrustGrantParamsSchema = ProjectTrustGrantParamsObjectSchema.superRefine((value, context) => {
  if (value.nativeLoginAllowed && !value.nativeDirectUnrestrictedAcknowledged) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["nativeDirectUnrestrictedAcknowledged"],
      message: "Native login requires explicit acknowledgement of unrestricted provider egress.",
    });
  }
});

/** Project root and principal are always derived from the authenticated daemon. */
export const RunSubmitParamsSchema = RunRequestObjectSchema.omit({
  projectRoot: true,
  containment: true,
  authMode: true,
  approvalPolicy: true,
}).extend({
  containment: ContainmentRequirementSchema.optional(),
  authMode: AuthModeSchema.optional(),
  approvalPolicy: ApprovalPolicySchema.optional(),
  idempotencyKey: SubmissionIdempotencyKeySchema.optional(),
})
  .superRefine(backendAgentSelectionRefinement);

const AgentProfileInputSchema = z.object({
  id: IdentifierSchema,
  backend: BackendIdSchema,
  name: z.string().trim().min(1).max(160),
  model: z.string().trim().min(1).max(256).refine((value) => !value.startsWith("-"), "Model must not begin with a flag prefix.").optional(),
  authMode: AuthModeSchema.default("broker"),
  approvalPolicy: ApprovalPolicySchema.default("ask"),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(-100).max(100).default(0),
  capabilities: z.array(z.string().trim().min(1).max(128)).max(64).default([]),
  maxConcurrentTurns: z.number().int().positive().max(32).default(1),
}).strict();

export const FleetProfileUpsertParamsSchema = z.object({
  id: IdentifierSchema,
  name: z.string().trim().min(1).max(160),
  authMode: AuthModeSchema.default("broker"),
  approvalPolicy: ApprovalPolicySchema.default("ask"),
  agents: z.array(AgentProfileInputSchema).min(1).max(64),
  maxActiveWorkers: z.number().int().positive().max(64).default(4),
  maxQueuedDelegations: z.number().int().positive().max(1_024).default(64),
  maxDeliberationRounds: z.number().int().positive().max(64).default(8),
  maxAttemptsPerDelegation: z.number().int().positive().max(8).default(2),
  goalTimeoutMs: PositiveTimeoutSchema.default(3_600_000),
  idleAutonomy: z.enum(["off", "suggest", "read-only", "write"]).default("suggest"),
  activate: z.boolean().default(true),
}).strict();

export const FleetProfileIdParamsSchema = z.object({ profileId: IdentifierSchema }).strict();

export const GoalStartParamsSchema = z.object({
  objective: z.string().trim().min(1).max(500_000),
  mode: RunModeSchema.default("read-only"),
  fleetProfileId: IdentifierSchema.optional(),
  synthesizer: SynthesizerSelectionSchema.optional(),
  // Optional by design: omission inherits the selected fleet profile rather
  // than forcing the global native-login/ask defaults over that profile.
  authMode: AuthModeSchema.optional(),
  approvalPolicy: ApprovalPolicySchema.optional(),
  autonomous: z.boolean().default(false),
  timeoutMs: PositiveTimeoutSchema.default(3_600_000),
  detach: z.boolean().default(false),
}).strict();

export const GoalIdParamsSchema = z.object({ goalId: IdentifierSchema }).strict();
export const GoalSendParamsSchema = GoalIdParamsSchema.extend({ text: z.string().trim().min(1).max(500_000) }).strict();
export const CollaborationListParamsSchema = GoalIdParamsSchema.extend({
  afterSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.number().int().positive().max(1_000).default(200),
}).strict();
export const CollaborationAcknowledgeParamsSchema = GoalIdParamsSchema.extend({
  messageIds: z.array(IdentifierSchema).min(1).max(1_000)
    .refine((values) => new Set(values).size === values.length, "Message acknowledgement ids must be unique."),
  prune: z.boolean().default(true),
}).strict();
export const CollaborationTransferSynthesizerParamsSchema = GoalIdParamsSchema.extend({ agentId: IdentifierSchema }).strict();
export const ApprovalListParamsSchema = z.object({
  goalId: IdentifierSchema.optional(),
  status: z.enum(["pending", "approved", "rejected", "cancelled", "expired"]).optional(),
}).strict();
export const ApprovalResolveParamsSchema = z.object({
  approvalId: IdentifierSchema,
  decision: z.enum(["approved", "rejected"]),
  resolution: z.string().trim().min(1).max(16_384),
}).strict();
export const CandidateIdParamsSchema = z.object({ candidateId: IdentifierSchema }).strict();

export const AuthorityGrantRevokeParamsSchema = z.object({ grantId: IdentifierSchema }).strict();

export const BudgetUpsertParamsSchema = z.object({
  id: IdentifierSchema,
  principal: z.string().trim().min(1).max(128).nullable().default(null),
  sessionId: IdentifierSchema.nullable().default(null),
  workflowId: IdentifierSchema.nullable().default(null),
  provider: z.string().trim().min(1).max(128).nullable().default(null),
  maxRequests: z.number().int().positive().nullable().default(null),
  maxInputTokens: z.number().int().positive().nullable().default(null),
  maxOutputTokens: z.number().int().positive().nullable().default(null),
  maxCostUsd: z.number().positive().nullable().default(null),
  maxArtifactBytes: z.number().int().positive().nullable().default(null),
  maxConcurrency: z.number().int().positive().nullable().default(null),
  maxRetries: z.number().int().nonnegative().nullable().default(null),
  expiresAt: TimestampSchema.nullable().default(null),
}).strict();

/**
 * Task principals and project ids are intentionally absent from all client
 * parameters. The daemon supplies them from its authenticated connection and
 * canonical project boundary before calling TaskStore.
 */
export const TaskCreateParamsSchema = z.object({
  jobId: IdentifierSchema,
  capability: z.string().trim().min(1).max(128),
}).strict();

export const TaskStatusParamsSchema = z.object({ taskId: IdentifierSchema }).strict();

export const TaskListParamsSchema = z.object({
  jobId: IdentifierSchema.optional(),
  state: z.enum(["pending", "claimed", "completed", "failed", "cancelled"]).optional(),
}).strict();

export const TaskClaimParamsSchema = z.object({
  taskId: IdentifierSchema,
  leaseMs: PositiveTimeoutSchema,
}).strict();

export const TaskRenewParamsSchema = TaskClaimParamsSchema;

export const TaskCompleteParamsSchema = z.object({
  taskId: IdentifierSchema,
  outcome: z.enum(["completed", "failed"]).default("completed"),
}).strict();

export const TaskCancelParamsSchema = TaskStatusParamsSchema;

export const EventsSnapshotParamsSchema = z.object({
  jobId: IdentifierSchema.optional(),
  sessionId: IdentifierSchema.optional(),
  afterCursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.number().int().positive().max(1_000).default(200),
}).strict();

export const EventsWaitParamsSchema = EventsSnapshotParamsSchema.extend({
  timeoutMs: PositiveTimeoutSchema.max(60_000).default(30_000),
}).strict();

export const ObserverEventsParamsSchema = z.object({
  afterCursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.number().int().positive().max(1_000).default(200),
}).strict();

const LedgerTextSchema = z.string().min(1).max(500_000);
const OptionalSessionIdSchema = IdentifierSchema.optional();

export const LedgerNoteParamsSchema = z.object({
  sessionId: OptionalSessionIdSchema,
  text: LedgerTextSchema,
  handlesHandoffId: IdentifierSchema.optional(),
}).strict();

export const LedgerArtifactParamsSchema = z.object({
  sessionId: OptionalSessionIdSchema,
  kind: z.string().trim().min(1).max(128),
  title: z.string().trim().min(1).max(1_024),
  summary: LedgerTextSchema,
  status: z.enum(["passed", "failed", "blocked", "unknown", "skipped", "timed_out"]).optional(),
  evidence: z.array(z.string().max(16_384)).max(256).optional(),
}).strict();

export const LedgerContextParamsSchema = z.object({
  sessionId: OptionalSessionIdSchema,
  view: z.enum(["summary", "recent", "raw"]).optional(),
  limit: z.number().int().nonnegative().max(10_000).optional(),
}).strict();

export const LedgerTaskParamsSchema = z.object({ sessionId: OptionalSessionIdSchema }).strict();

export const LedgerProposeFinalParamsSchema = z.object({
  sessionId: OptionalSessionIdSchema,
  summary: LedgerTextSchema,
  evidence: LedgerTextSchema,
  remainingRisk: z.string().max(500_000).optional(),
  handlesHandoffIds: z.array(IdentifierSchema).max(256).optional(),
}).strict();

export const LedgerEventParamsSchema = z.object({
  sessionId: OptionalSessionIdSchema,
  type: z.string().trim().min(1).max(128),
  payload: z.record(z.unknown()),
}).strict();

export const LedgerVerifyParamsSchema = z.object({ evidence: z.boolean().default(false) }).strict();
export const LedgerRepairTailParamsSchema = z.object({ confirm: z.literal(true) }).strict();
export const ReceiptRunParamsSchema = z.object({ runId: IdentifierSchema }).strict();
export const ReceiptListParamsSchema = z.object({
  limit: z.number().int().positive().max(10_000).optional(),
}).strict();

export const MessagesPushParamsSchema = z.object({
  chatId: IdentifierSchema,
  content: z.string().min(1).max(500_000),
  meta: z.record(z.unknown()).optional(),
  to: z.string().trim().min(1).max(128).optional(),
}).strict();

export const MessagesPullParamsSchema = z.object({
  chatId: IdentifierSchema,
  limit: z.number().int().positive().max(50).default(20),
}).strict();

export const MessagesMarkPushedParamsSchema = z.object({ messageId: IdentifierSchema }).strict();

export const CouncilRunParamsSchema = z.object({
  question: z.string().trim().min(1).max(500_000),
  agents: z.array(BackendIdSchema).max(64).optional(),
  mode: z.enum(["read-only", "write"]).default("read-only"),
  containment: ContainmentRequirementSchema.default("required"),
  authMode: AuthModeSchema.default("broker"),
  approvalPolicy: ApprovalPolicySchema.default("ask"),
  timeoutMs: PositiveTimeoutSchema.default(180_000),
}).strict();

export const GateRunParamsSchema = z.object({
  checks: z.array(z.string().trim().min(1).max(128)).max(64).optional(),
  timeoutMs: PositiveTimeoutSchema.optional(),
  sessionId: IdentifierSchema.optional(),
}).strict();

export const SessionCreateParamsSchema = z.object({
  backend: BackendIdSchema,
  model: z.string().trim().min(1).max(256).refine((value) => !value.startsWith("-"), "Model must not begin with a flag prefix.").optional(),
  agent: AgentNameSchema.optional(),
  containment: ContainmentRequirementSchema.default("required"),
  authMode: AuthModeSchema.default("broker"),
  approvalPolicy: ApprovalPolicySchema.default("ask"),
  nativeSessionId: z.string().trim().min(1).max(512).optional(),
}).strict().superRefine(backendAgentSelectionRefinement);

export const SessionTurnParamsSchema = z.object({
  sessionId: IdentifierSchema,
  prompt: z.string().min(1).max(500_000),
  timeoutMs: PositiveTimeoutSchema.default(180_000),
}).strict();

export const WorkflowStepParamsSchema = z.object({
  id: IdentifierSchema,
  kind: z.enum(["execution", "test", "review", "vote"]).default("execution"),
  backend: z.string().trim().min(1).max(64),
  prompt: z.string().trim().min(1).max(500_000),
  mode: z.enum(["read-only", "write"]).default("read-only"),
  authMode: AuthModeSchema.optional(),
  approvalPolicy: ApprovalPolicySchema.optional(),
  model: z.string().trim().min(1).max(256).nullable().default(null),
  agent: z.string().trim().min(1).max(256).nullable().default(null),
  timeoutMs: PositiveTimeoutSchema.default(180_000),
  dependsOn: z.array(IdentifierSchema).max(32).default([]),
  /** Dependencies that must settle but need not succeed; see WorkflowStepSchema. */
  optionalDependsOn: z.array(IdentifierSchema).max(32).default([]),
  maxAttempts: z.number().int().positive().max(8).default(1),
}).strict();

export const WorkflowRunParamsSchema = z.object({
  id: IdentifierSchema.optional(),
  sessionId: IdentifierSchema.nullable().default(null),
  authMode: AuthModeSchema.default("broker"),
  approvalPolicy: ApprovalPolicySchema.default("ask"),
  /** Write steps stay in an isolated candidate unless explicitly authorized. */
  mergePolicy: z.enum(["authorized", "preserve"]).default("preserve"),
  steps: z.array(WorkflowStepParamsSchema).min(1).max(64),
  requirements: z.object({
    policy: z.boolean().default(true),
    tests: z.boolean().default(false),
    review: z.boolean().default(false),
    vote: z.boolean().default(false),
    budget: z.boolean().default(true),
  }).strict().default({}),
}).strict().superRefine((workflow, context) => {
  const totalPromptBytes = workflow.steps.reduce((total, step) => total + Buffer.byteLength(step.prompt), 0);
  if (totalPromptBytes > 2_000_000) context.addIssue({ code: z.ZodIssueCode.custom, message: "Workflow prompts exceed the total 2000000-byte limit.", path: ["steps"] });
});

export const WorkflowIdParamsSchema = z.object({ workflowId: IdentifierSchema }).strict();
export const WorkflowWaitParamsSchema = WorkflowIdParamsSchema.extend({
  timeoutMs: PositiveTimeoutSchema.max(86_400_000).default(180_000),
}).strict();
export const WorkflowDraftIdParamsSchema = z.object({ draftId: IdentifierSchema }).strict();
export const WorkflowDraftLaunchParamsSchema = WorkflowDraftIdParamsSchema;

export const SkillIdParamsSchema = z.object({ skill: z.string().trim().min(1).max(256) }).strict();
export const SkillImportParamsSchema = z.object({ source: z.string().trim().min(1).max(1_024) }).strict();
export const SkillUseParamsSchema = SkillIdParamsSchema.extend({
  arguments: z.string().max(64_000).default(""),
  backend: BackendIdSchema.optional(),
  timeoutMs: PositiveTimeoutSchema.default(180_000),
}).strict();
export const LoopStartParamsSchema = z.object({ policy: LoopPolicySchema }).strict();
export const LoopIdParamsSchema = z.object({ loopId: IdentifierSchema }).strict();
export type DaemonMethod = z.infer<typeof DaemonMethodSchema>;
export type DaemonRequest = z.infer<typeof DaemonRequestSchema>;
export type DaemonResponse = z.infer<typeof DaemonResponseSchema>;
