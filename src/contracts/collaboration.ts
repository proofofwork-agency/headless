import { z } from "zod";
import {
  BackendIdSchema,
  IdentifierSchema,
  PositiveTimeoutSchema,
  PrincipalIdSchema,
  ProjectIdSchema,
  RunModeSchema,
  TimestampSchema,
} from "./common";
import { ApprovalPolicySchema, AuthModeSchema } from "./native";

const ModelSchema = z.string().trim().min(1).max(256)
  .refine((value) => !value.startsWith("-"), "Model must not begin with a flag prefix.");
const LabelSchema = z.string().trim().min(1).max(160);
const CapabilitySchema = z.string().trim().min(1).max(128);
const CollaborationTextSchema = z.string().max(32_768)
  .refine((value) => Buffer.byteLength(value) <= 65_536, "Collaboration text exceeds 65536 UTF-8 bytes.");
const SummarySchema = z.string().max(16_384)
  .refine((value) => Buffer.byteLength(value) <= 32_768, "Summary exceeds 32768 UTF-8 bytes.");
const BoundedDetailsSchema = z.record(z.unknown()).refine((value) => {
  try {
    return Buffer.byteLength(JSON.stringify(value)) <= 65_536;
  } catch {
    return false;
  }
}, "Approval details exceed 65536 serialized bytes.");

export const AgentProfileSchema = z.object({
  id: IdentifierSchema,
  backend: BackendIdSchema,
  name: LabelSchema,
  model: ModelSchema.optional(),
  authMode: AuthModeSchema.default("broker"),
  approvalPolicy: ApprovalPolicySchema.default("ask"),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(-100).max(100).default(0),
  capabilities: z.array(CapabilitySchema).max(64).default([]),
  maxConcurrentTurns: z.number().int().positive().max(32).default(1),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict().superRefine((profile, context) => {
  if (profile.updatedAt < profile.createdAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Agent profile updatedAt cannot precede createdAt.", path: ["updatedAt"] });
  }
  requireUnique(profile.capabilities, context, ["capabilities"], "agent capability");
});

export const SynthesizerSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent"), agentId: IdentifierSchema }).strict(),
  z.object({ kind: z.literal("automatic") }).strict(),
  z.object({ kind: z.literal("election") }).strict(),
]);

export const FleetProfileSchema = z.object({
  id: IdentifierSchema,
  projectId: ProjectIdSchema,
  name: LabelSchema,
  authMode: AuthModeSchema.default("broker"),
  approvalPolicy: ApprovalPolicySchema.default("ask"),
  agents: z.array(AgentProfileSchema).min(1).max(64),
  maxActiveWorkers: z.number().int().positive().max(64).default(4),
  maxQueuedDelegations: z.number().int().positive().max(1_024).default(64),
  maxDeliberationRounds: z.number().int().positive().max(64).default(8),
  maxAttemptsPerDelegation: z.number().int().positive().max(8).default(2),
  goalTimeoutMs: PositiveTimeoutSchema.default(3_600_000),
  idleAutonomy: z.enum(["off", "suggest", "read-only", "write"]).default("suggest"),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict().superRefine((profile, context) => {
  if (profile.updatedAt < profile.createdAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Fleet profile updatedAt cannot precede createdAt.", path: ["updatedAt"] });
  }
  requireUnique(profile.agents.map((agent) => agent.id), context, ["agents"], "agent id");
});

export const GoalStateSchema = z.enum([
  "queued",
  "planning",
  "delegating",
  "active",
  "critiquing",
  "gating",
  "waiting_approval",
  "integrating",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);

export const GoalSchema = z.object({
  id: IdentifierSchema,
  projectId: ProjectIdSchema,
  principal: PrincipalIdSchema,
  fleetProfileId: IdentifierSchema,
  objective: CollaborationTextSchema,
  mode: RunModeSchema.default("read-only"),
  state: GoalStateSchema,
  authMode: AuthModeSchema.default("broker"),
  approvalPolicy: ApprovalPolicySchema.default("ask"),
  synthesizer: SynthesizerSelectionSchema,
  synthesizerAgentId: IdentifierSchema.nullable().default(null),
  autonomous: z.boolean().default(false),
  deadlineAt: TimestampSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict().superRefine((goal, context) => {
  if (goal.deadlineAt <= goal.createdAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Goal deadline must be after creation.", path: ["deadlineAt"] });
  }
  if (goal.updatedAt < goal.createdAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Goal updatedAt cannot precede createdAt.", path: ["updatedAt"] });
  }
  if (goal.synthesizer.kind === "agent" && goal.synthesizerAgentId !== null && goal.synthesizer.agentId !== goal.synthesizerAgentId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Explicit synthesizer and sticky synthesis agent must identify the same agent.", path: ["synthesizerAgentId"] });
  }
});

export const TurnSchema = z.object({
  id: IdentifierSchema,
  goalId: IdentifierSchema,
  delegationId: IdentifierSchema.nullable().default(null),
  agentId: IdentifierSchema,
  nativeSessionId: z.string().trim().min(1).max(512).nullable(),
  authMode: AuthModeSchema.default("broker"),
  sequence: z.number().int().positive(),
  state: z.enum(["queued", "running", "waiting", "succeeded", "failed", "cancelled", "timed_out"]),
  input: CollaborationTextSchema,
  output: CollaborationTextSchema.nullable(),
  artifactIds: z.array(IdentifierSchema).max(256).default([]),
  startedAt: TimestampSchema.nullable(),
  completedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict().superRefine((turn, context) => {
  requireUnique(turn.artifactIds, context, ["artifactIds"], "artifact id");
  if (turn.updatedAt < turn.createdAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Turn updatedAt cannot precede createdAt.", path: ["updatedAt"] });
  }
  if (turn.startedAt !== null && turn.startedAt < turn.createdAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Turn startedAt cannot precede createdAt.", path: ["startedAt"] });
  }
  const terminal = ["succeeded", "failed", "cancelled", "timed_out"].includes(turn.state);
  if (terminal !== (turn.completedAt !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Terminal turns require completedAt and nonterminal turns cannot set it.", path: ["completedAt"] });
  }
  if (["running", "waiting"].includes(turn.state) && turn.startedAt === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Started turn states require startedAt.", path: ["startedAt"] });
  }
});

export const DelegationRateLimitSchema = z.object({
  observedAt: TimestampSchema,
  retryAfterMs: z.number().int().positive().max(86_400_000),
  evidence: z.string().max(4_096),
}).strict();

export const DelegationSchema = z.object({
  id: IdentifierSchema,
  goalId: IdentifierSchema,
  fromAgentId: IdentifierSchema,
  toAgentId: IdentifierSchema,
  nativeSessionId: z.string().trim().min(1).max(512).nullable(),
  sequence: z.number().int().positive(),
  task: CollaborationTextSchema,
  state: z.enum(["queued", "active", "succeeded", "failed", "cancelled", "expired"]),
  attempt: z.number().int().nonnegative().max(8),
  maxAttempts: z.number().int().positive().max(8).default(2),
  availableAt: TimestampSchema,
  deadlineAt: TimestampSchema,
  rateLimit: DelegationRateLimitSchema.nullable().default(null),
  resultTurnId: IdentifierSchema.nullable().default(null),
  artifactIds: z.array(IdentifierSchema).max(256).default([]),
  lastError: z.string().max(16_384).nullable().default(null),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict().superRefine((delegation, context) => {
  if (delegation.attempt > delegation.maxAttempts) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Delegation attempts exceed maxAttempts.", path: ["attempt"] });
  }
  if (delegation.deadlineAt <= delegation.createdAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Delegation deadline must be after creation.", path: ["deadlineAt"] });
  }
  if (delegation.updatedAt < delegation.createdAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Delegation updatedAt cannot precede createdAt.", path: ["updatedAt"] });
  }
  if (delegation.state === "active" && delegation.attempt === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "An active delegation must have started an attempt.", path: ["attempt"] });
  }
  if (delegation.state === "succeeded" && delegation.resultTurnId === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A succeeded delegation requires its result turn.", path: ["resultTurnId"] });
  }
  requireUnique(delegation.artifactIds, context, ["artifactIds"], "artifact id");
});

export const DirectedMessageKindSchema = z.enum([
  "chat",
  "question",
  "report",
  "delegation",
  "review",
  "vote",
  "lifecycle",
  "policy",
  "approval",
  "completion",
]);

export const DirectedMessageSchema = z.object({
  id: IdentifierSchema,
  collaborationId: IdentifierSchema,
  senderId: IdentifierSchema,
  recipientId: IdentifierSchema,
  sequence: z.number().int().positive(),
  kind: DirectedMessageKindSchema,
  content: CollaborationTextSchema,
  redacted: z.literal(true),
  truncated: z.boolean().default(false),
  artifactIds: z.array(IdentifierSchema).max(256).default([]),
  acknowledgedAt: TimestampSchema.nullable().default(null),
  createdAt: TimestampSchema,
}).strict().superRefine((message, context) => {
  requireUnique(message.artifactIds, context, ["artifactIds"], "artifact id");
  if (message.acknowledgedAt !== null && message.acknowledgedAt < message.createdAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Message acknowledgement cannot precede creation.", path: ["acknowledgedAt"] });
  }
});

export const ReviewSchema = z.object({
  id: IdentifierSchema,
  collaborationId: IdentifierSchema,
  candidateId: IdentifierSchema,
  reviewerId: IdentifierSchema,
  verdict: z.enum(["approve", "request_changes", "reject"]),
  summary: SummarySchema,
  findings: z.array(SummarySchema).max(128).default([]),
  citedTurnIds: z.array(IdentifierSchema).max(256).default([]),
  citedArtifactIds: z.array(IdentifierSchema).max(256).default([]),
  createdAt: TimestampSchema,
}).strict().superRefine((review, context) => {
  if (review.citedTurnIds.length + review.citedArtifactIds.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A review must cite at least one turn or artifact." });
  }
  requireUnique(review.citedTurnIds, context, ["citedTurnIds"], "turn citation");
  requireUnique(review.citedArtifactIds, context, ["citedArtifactIds"], "artifact citation");
});

export const VoteSchema = z.object({
  id: IdentifierSchema,
  collaborationId: IdentifierSchema,
  candidateId: IdentifierSchema,
  voterId: IdentifierSchema,
  choice: z.enum(["approve", "revise", "reject", "abstain"]),
  rationale: SummarySchema,
  citedTurnIds: z.array(IdentifierSchema).max(256).default([]),
  citedArtifactIds: z.array(IdentifierSchema).max(256).default([]),
  createdAt: TimestampSchema,
}).strict().superRefine((vote, context) => {
  if (vote.citedTurnIds.length + vote.citedArtifactIds.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A vote must cite at least one turn or artifact." });
  }
  requireUnique(vote.citedTurnIds, context, ["citedTurnIds"], "turn citation");
  requireUnique(vote.citedArtifactIds, context, ["citedArtifactIds"], "artifact citation");
});

export const ApprovalRequestSchema = z.object({
  id: IdentifierSchema,
  collaborationId: IdentifierSchema,
  requestedBy: IdentifierSchema,
  assignedTo: PrincipalIdSchema,
  kind: z.enum(["coder_tool", "merge", "unpriced_broker_run"]),
  status: z.enum(["pending", "approved", "rejected", "cancelled", "expired"]),
  summary: SummarySchema,
  details: BoundedDetailsSchema.default({}),
  artifactIds: z.array(IdentifierSchema).max(256).default([]),
  resolvedBy: PrincipalIdSchema.nullable().default(null),
  resolution: z.string().max(16_384).nullable().default(null),
  expiresAt: TimestampSchema,
  resolvedAt: TimestampSchema.nullable().default(null),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict().superRefine((request, context) => {
  const pending = request.status === "pending";
  if (pending && (request.resolvedBy !== null || request.resolvedAt !== null || request.resolution !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Pending approvals cannot contain resolution state." });
  }
  if (!pending && (request.resolvedBy === null || request.resolvedAt === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Resolved approvals require resolver attribution and time." });
  }
  if (request.expiresAt <= request.createdAt || request.updatedAt < request.createdAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Approval timestamps are inconsistent." });
  }
  requireUnique(request.artifactIds, context, ["artifactIds"], "artifact id");
});

export const CandidateGateSchema = z.object({
  id: IdentifierSchema,
  status: z.enum(["passed", "failed", "pending", "not_required"]),
  evidenceArtifactIds: z.array(IdentifierSchema).max(256).default([]),
}).strict().superRefine((gate, context) => {
  requireUnique(gate.evidenceArtifactIds, context, ["evidenceArtifactIds"], "gate evidence artifact");
});

export const CandidateDecisionSchema = z.object({
  id: IdentifierSchema,
  collaborationId: IdentifierSchema,
  candidateId: IdentifierSchema,
  decision: z.enum(["integrate", "revise", "reject", "blocked"]),
  decidedBy: PrincipalIdSchema,
  reviewIds: z.array(IdentifierSchema).max(256).default([]),
  voteIds: z.array(IdentifierSchema).max(256).default([]),
  citedTurnIds: z.array(IdentifierSchema).max(256).default([]),
  citedArtifactIds: z.array(IdentifierSchema).max(256).default([]),
  gates: z.array(CandidateGateSchema).max(128).default([]),
  reasons: z.array(SummarySchema).min(1).max(128),
  createdAt: TimestampSchema,
}).strict().superRefine((decision, context) => {
  for (const [values, path, label] of [
    [decision.reviewIds, ["reviewIds"], "review id"],
    [decision.voteIds, ["voteIds"], "vote id"],
    [decision.citedTurnIds, ["citedTurnIds"], "turn citation"],
    [decision.citedArtifactIds, ["citedArtifactIds"], "artifact citation"],
    [decision.gates.map((gate) => gate.id), ["gates"], "gate id"],
  ] as const) requireUnique(values, context, path, label);
  if (decision.decision === "integrate" && decision.gates.some((gate) => gate.status === "failed" || gate.status === "pending")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "An integration decision requires every gate to pass or be not required.", path: ["gates"] });
  }
});

export type AgentProfile = z.infer<typeof AgentProfileSchema>;
export type SynthesizerSelection = z.infer<typeof SynthesizerSelectionSchema>;
export type FleetProfile = z.infer<typeof FleetProfileSchema>;
export type Goal = z.infer<typeof GoalSchema>;
export type Turn = z.infer<typeof TurnSchema>;
export type Delegation = z.infer<typeof DelegationSchema>;
export type DirectedMessage = z.infer<typeof DirectedMessageSchema>;
export type Review = z.infer<typeof ReviewSchema>;
export type Vote = z.infer<typeof VoteSchema>;
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
export type CandidateDecision = z.infer<typeof CandidateDecisionSchema>;

function requireUnique(
  values: readonly string[],
  context: z.RefinementCtx,
  path: readonly (string | number)[],
  label: string,
) {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate ${label}.`, path: [...path] });
  }
}
