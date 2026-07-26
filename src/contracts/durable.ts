import { z } from "zod";
import {
  BackendIdSchema,
  BoundedTextSchema,
  IdentifierSchema,
  PositiveTimeoutSchema,
  PrincipalIdSchema,
  ProjectIdSchema,
  RunModeSchema,
  SubmissionIdempotencyKeySchema,
  StructuredErrorSchema,
  TimestampSchema,
} from "./common";
import { CostAttributionSchema, RunResultSchema, TokenUsageSchema } from "./run";
import {
  ApprovalPolicySchema,
  AuthModeSchema,
  NativeSessionMetadataSchema,
} from "./native";

export const JobStateSchema = z.enum([
  "queued",
  "preparing",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "blocked",
]);

export const RunDelegationLinkSchema = z.object({
  parentJobId: IdentifierSchema,
  requestId: z.string().uuid(),
  depth: z.literal(1),
  budgetFraction: z.number().positive().max(0.5),
}).strict();

export const JobSchema = z.object({
  id: IdentifierSchema,
  projectId: ProjectIdSchema,
  principal: PrincipalIdSchema,
  sessionId: IdentifierSchema.nullable(),
  workflowId: IdentifierSchema.nullable().default(null),
  /** Durable council phase-slot binding used to reconcile crash orphans. */
  councilId: IdentifierSchema.nullable().default(null),
  councilSlot: z.string().min(1).max(160).nullable().default(null),
  /** Daemon-assigned worker delegation relationship; never accepted from RPC input. */
  delegationOf: RunDelegationLinkSchema.nullable().default(null),
  /** Principal-scoped client replay key; absent submissions retain mint-on-call behavior. */
  idempotencyKey: SubmissionIdempotencyKeySchema.nullable().default(null),
  backend: BackendIdSchema,
  mode: RunModeSchema,
  authMode: AuthModeSchema.default("broker"),
  approvalPolicy: ApprovalPolicySchema.default("ask"),
  /** Durable daemon policy: council candidates are never merged before vote. */
  mergePolicy: z.enum(["authorized", "preserve"]).default("authorized"),
  /**
   * Base this write on an earlier candidate commit instead of primary HEAD, so
   * a repair loop can chain attempts and gate the accumulated result. Daemon
   * assigned; never accepted from RPC input, and verified to descend from
   * primary HEAD before a worktree is created.
   */
  candidateBase: z.string().regex(/^[0-9a-f]{40}$/).nullable().default(null),
  state: JobStateSchema,
  attempt: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
  retryNumber: z.number().int().nonnegative().max(1_000).default(0),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  leaseOwner: IdentifierSchema.nullable(),
  leaseExpiresAt: TimestampSchema.nullable(),
  result: RunResultSchema.nullable(),
}).strict().superRefine((job, context) => {
  if ((job.councilId === null) !== (job.councilSlot === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Council job bindings require both councilId and councilSlot." });
  }
});

export const TaskSchema = z.object({
  id: IdentifierSchema,
  jobId: IdentifierSchema,
  projectId: ProjectIdSchema,
  capability: z.string().min(1).max(128),
  state: z.enum(["pending", "claimed", "completed", "failed", "cancelled"]),
  claimedBy: IdentifierSchema.nullable(),
  leaseExpiresAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict().superRefine((task, context) => {
  if (task.state === "pending" && (task.claimedBy !== null || task.leaseExpiresAt !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Pending tasks cannot retain claim ownership or a lease." });
  }
  if (task.state === "claimed" && (task.claimedBy === null || task.leaseExpiresAt === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Claimed tasks require an authenticated owner and lease expiry." });
  }
  if (task.state !== "claimed" && task.leaseExpiresAt !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Only claimed tasks may retain a lease expiry." });
  }
});

export const SessionSchema = z.object({
  id: IdentifierSchema,
  projectId: ProjectIdSchema,
  principal: PrincipalIdSchema,
  backend: BackendIdSchema,
  model: z.string().max(256).nullable(),
  agent: z.string().max(256).nullable(),
  containment: z.enum(["required", "unsafe"]),
  authMode: AuthModeSchema.default("broker"),
  approvalPolicy: ApprovalPolicySchema.default("ask"),
  state: z.enum(["idle", "running", "cancelling", "completed", "failed", "cancelled"]),
  nativeSessionId: z.string().max(512).nullable(),
  replay: z.boolean(),
  transcriptBytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  lastJobId: IdentifierSchema.nullable(),
  result: RunResultSchema.nullable(),
  native: NativeSessionMetadataSchema.nullable().default(null),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();

export const GrantSchema = z.object({
  id: IdentifierSchema,
  projectId: ProjectIdSchema,
  principal: PrincipalIdSchema,
  operations: z.array(z.enum(["run", "write", "merge", "council", "workflow", "admin"])).min(1),
  backends: z.array(BackendIdSchema).min(1),
  expiresAt: TimestampSchema,
  maxCostUsd: z.number().nonnegative().nullable(),
  maxIterations: z.number().int().positive().nullable().default(null),
  usedIterations: z.number().int().nonnegative().default(0),
  issuedBy: PrincipalIdSchema,
  createdAt: TimestampSchema,
  revokedAt: TimestampSchema.nullable(),
}).strict();

export const BudgetSchema = z.object({
  id: IdentifierSchema,
  projectId: ProjectIdSchema,
  principal: PrincipalIdSchema.nullable(),
  sessionId: IdentifierSchema.nullable(),
  workflowId: IdentifierSchema.nullable(),
  provider: z.string().max(128).nullable(),
  maxRequests: z.number().int().positive().nullable(),
  maxInputTokens: z.number().int().positive().nullable(),
  maxOutputTokens: z.number().int().positive().nullable(),
  maxCostUsd: z.number().positive().nullable(),
  maxArtifactBytes: z.number().int().positive().nullable(),
  maxConcurrency: z.number().int().positive().nullable(),
  maxRetries: z.number().int().nonnegative().nullable(),
  expiresAt: TimestampSchema.nullable().default(null),
  usedRequests: z.number().int().nonnegative(),
  usedUsage: TokenUsageSchema,
  usedCost: CostAttributionSchema,
  usedArtifactBytes: z.number().int().nonnegative(),
  updatedAt: TimestampSchema,
}).strict();

export const CouncilSchema = z.object({
  id: IdentifierSchema,
  projectId: ProjectIdSchema,
  principal: PrincipalIdSchema,
  jobId: IdentifierSchema,
  phase: z.enum(["proposal", "execution", "review", "vote", "decision"]),
  authMode: AuthModeSchema.default("broker"),
  approvalPolicy: ApprovalPolicySchema.default("ask"),
  participants: z.array(PrincipalIdSchema).min(2).max(64),
  proposalArtifactIds: z.array(IdentifierSchema),
  candidateArtifactIds: z.array(IdentifierSchema),
  reviewArtifactIds: z.array(IdentifierSchema),
  voteIds: z.array(IdentifierSchema),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();

export const WorkflowStepKindSchema = z.enum(["execution", "test", "review", "vote"]);
export const WorkflowStepStateSchema = z.enum(["pending", "queued", "running", "succeeded", "failed", "blocked", "cancelled"]);

export const WorkflowStepSchema = z.object({
  id: IdentifierSchema,
  kind: WorkflowStepKindSchema,
  backend: BackendIdSchema,
  prompt: BoundedTextSchema,
  mode: RunModeSchema,
  authMode: AuthModeSchema.default("broker"),
  approvalPolicy: ApprovalPolicySchema.default("ask"),
  model: z.string().trim().min(1).max(256).nullable(),
  agent: z.string().trim().min(1).max(256).nullable(),
  timeoutMs: PositiveTimeoutSchema,
  dependsOn: z.array(IdentifierSchema).max(32),
  /**
   * Dependencies that must *settle* but need not succeed. A step waits for
   * these to reach a terminal state and then runs regardless of the outcome,
   * receiving the failure as evidence. This is what lets one node die without
   * failing the whole run: a verifier can still report on the work that landed
   * when a sibling repair failed, instead of being blocked into silence.
   */
  optionalDependsOn: z.array(IdentifierSchema).max(32).default([]),
  maxAttempts: z.number().int().positive().max(8),
  attempt: z.number().int().nonnegative().max(8),
  state: WorkflowStepStateSchema,
  jobIds: z.array(IdentifierSchema).max(8),
  lastJobId: IdentifierSchema.nullable(),
  result: RunResultSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict().superRefine((step, context) => {
  if (step.attempt > step.maxAttempts) context.addIssue({ code: z.ZodIssueCode.custom, message: "Workflow step attempts exceed maxAttempts." });
  if (step.dependsOn.includes(step.id) || step.optionalDependsOn.includes(step.id)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Workflow step cannot depend on itself." });
  for (const dependency of step.optionalDependsOn) {
    if (step.dependsOn.includes(dependency)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Workflow dependency ${dependency} cannot be both required and optional.` });
  }
  if (step.lastJobId !== null && !step.jobIds.includes(step.lastJobId)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Workflow step lastJobId must be present in jobIds." });
});

export const WorkflowFinalityRequirementsSchema = z.object({
  policy: z.boolean(),
  tests: z.boolean(),
  review: z.boolean(),
  vote: z.boolean(),
  budget: z.boolean(),
}).strict();

export const WorkflowSchema = z.object({
  id: IdentifierSchema,
  projectId: ProjectIdSchema,
  principal: PrincipalIdSchema,
  sessionId: IdentifierSchema.nullable(),
  authMode: AuthModeSchema.default("broker"),
  approvalPolicy: ApprovalPolicySchema.default("ask"),
  /**
   * Whether write steps may integrate into the primary checkout. Defaults to
   * "preserve": edits stay in an isolated candidate and a human decides. Only
   * an explicit policy may raise this, and the daemon's write gates still
   * apply on top.
   */
  mergePolicy: z.enum(["authorized", "preserve"]).default("preserve"),
  state: z.enum(["queued", "running", "paused", "cancelling", "succeeded", "failed", "blocked", "cancelled"]),
  steps: z.array(WorkflowStepSchema).min(1).max(64),
  requirements: WorkflowFinalityRequirementsSchema,
  finality: z.lazy(() => FinalityDecisionSchema).nullable(),
  error: StructuredErrorSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict().superRefine((workflow, context) => {
  const ids = new Set<string>();
  for (const [index, step] of workflow.steps.entries()) {
    if (ids.has(step.id)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate workflow step id: ${step.id}`, path: ["steps", index, "id"] });
    ids.add(step.id);
  }
  for (const [index, step] of workflow.steps.entries()) {
    for (const field of ["dependsOn", "optionalDependsOn"] as const) {
      for (const dependency of step[field]) {
        if (!ids.has(dependency)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Unknown workflow dependency: ${dependency}`, path: ["steps", index, field] });
      }
    }
  }
  // Optional edges still order execution, so they must be acyclic too.
  if (hasWorkflowCycle(workflow.steps)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Workflow dependencies must form an acyclic graph.", path: ["steps"] });
});

export const FinalityDecisionSchema = z.object({
  id: IdentifierSchema,
  projectId: ProjectIdSchema,
  jobId: IdentifierSchema,
  allowed: z.boolean(),
  policyPassed: z.boolean(),
  budgetPassed: z.boolean(),
  testsPassed: z.boolean(),
  reviewPassed: z.boolean(),
  votePassed: z.boolean(),
  reasons: z.array(z.string().max(4_096)).max(128),
  decidedBy: PrincipalIdSchema,
  createdAt: TimestampSchema,
}).strict();

export type Job = z.infer<typeof JobSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type DurableSession = z.infer<typeof SessionSchema>;
export type Grant = z.infer<typeof GrantSchema>;
export type Budget = z.infer<typeof BudgetSchema>;
export type Council = z.infer<typeof CouncilSchema>;
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;
export type FinalityDecision = z.infer<typeof FinalityDecisionSchema>;

function hasWorkflowCycle(steps: Array<{ id: string; dependsOn: string[]; optionalDependsOn?: string[] }>) {
  const dependencies = new Map(steps.map((step) => [step.id, [...step.dependsOn, ...step.optionalDependsOn ?? []]]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) if (visit(dependency)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return steps.some((step) => visit(step.id));
}
