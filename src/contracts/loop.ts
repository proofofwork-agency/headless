import { z } from "zod";
import { BackendIdSchema, IdentifierSchema, PrincipalIdSchema, ProjectIdSchema, RunModeSchema, TimestampSchema } from "./common";

/** Named checks resolved by the daemon's gate registry; the loop never accepts raw commands. */
export const GateCheckNameSchema = z.string().trim().regex(/^[a-z][a-z0-9-]{0,62}$/);

export const LoopTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("goal"), objective: z.string().trim().min(1).max(500_000), mode: RunModeSchema.default("read-only"), fleetProfileId: IdentifierSchema.optional() }).strict(),
  z.object({ kind: z.literal("workflow"), definition: z.record(z.unknown()) }).strict(),
  /**
   * Gate-driven repair. Each iteration runs the configured checks, compiles the
   * failures into a dependency graph of repair steps, executes it, and re-runs
   * the checks. The gate report is the oracle: an iteration succeeds only when
   * every check passes, never because an agent claimed success.
   */
  z.object({
    kind: z.literal("repair"),
    checks: z.array(GateCheckNameSchema).min(1).max(16),
    mode: RunModeSchema.default("write"),
    backend: BackendIdSchema.optional(),
    /**
     * Backend for the verification node. Defaults to a different adapter than
     * the repair nodes: a reviewer sharing the author's model and context tends
     * to ratify the author's mistakes, so same-model verification is worth less
     * than it appears. The gate remains the real oracle either way.
     */
    verifyBackend: BackendIdSchema.optional(),
    /**
     * Repair nodes run as ordinary jobs, so they inherit the same auth rules.
     * Broker auth is model-scoped and rejects a job without an explicit model;
     * a subscription-authenticated fleet needs "native-login" instead.
     */
    authMode: z.enum(["broker", "native-login"]).default("broker"),
    /**
     * Approval handling for repair jobs. A write repair that produces a
     * candidate stops at a merge approval, and the job goes terminal while it
     * waits — so an unattended loop paired with "ask" cannot converge no matter
     * how fast an operator responds. Raising this to "auto" is what makes the
     * loop autonomous, and it belongs with integrationPolicy "authorized".
     */
    approvalPolicy: z.enum(["ask", "auto", "bypass"]).default("ask"),
    /** Required by broker auth, which scopes each lease to one model. */
    model: z.string().trim().min(1).max(256).optional(),
    fleetProfileId: IdentifierSchema.optional(),
    /** Bounded by the durable workflow step cap so a compiled graph always admits. */
    maxRepairNodes: z.number().int().positive().max(32).default(8),
    /** Consecutive iterations with an unchanged failure signature before giving up. */
    stagnationLimit: z.number().int().positive().max(16).default(2),
    gateTimeoutMs: z.number().int().positive().max(86_400_000).default(600_000),
    stepTimeoutMs: z.number().int().positive().max(86_400_000).default(900_000),
  }).strict(),
]);
export const LoopPolicySchema = z.object({
  target: LoopTargetSchema,
  maxIterations: z.number().int().positive().max(1_000),
  deadline: TimestampSchema,
  perIteration: z.object({ maxCostUsd: z.number().positive(), maxRequests: z.number().int().positive().max(10_000) }).strict(),
  aggregate: z.object({ maxCostUsd: z.number().positive(), maxRequests: z.number().int().positive().max(100_000) }).strict(),
  backoff: z.object({ kind: z.enum(["fixed", "exponential"]), initialMs: z.number().int().nonnegative().max(86_400_000), maxMs: z.number().int().nonnegative().max(86_400_000) }).strict(),
  success: z.enum(["target-succeeded"]),
  terminalFailures: z.array(z.enum(["failed", "blocked", "cancelled", "timed_out", "budget_exhausted"])).min(1).max(8),
  approvalPolicy: z.enum(["ask", "auto"]).default("ask"),
  integrationPolicy: z.enum(["preserve", "request", "authorized"]).default("preserve"),
}).strict().superRefine((policy, context) => {
  if (policy.backoff.initialMs > policy.backoff.maxMs) context.addIssue({ code: z.ZodIssueCode.custom, message: "Loop initial backoff cannot exceed its maximum." });
  if (policy.perIteration.maxCostUsd > policy.aggregate.maxCostUsd || policy.perIteration.maxRequests > policy.aggregate.maxRequests) context.addIssue({ code: z.ZodIssueCode.custom, message: "Per-iteration budget cannot exceed aggregate budget." });
});

/**
 * What one repair iteration observed, carried into the next one. Without this
 * every iteration re-sends an identical target and re-derives the same failing
 * fix; this is the only channel through which a loop learns.
 */
export const RepairEvidenceSchema = z.object({
  /** Stable digest of the failing checks and their normalized first errors. */
  signature: z.string().regex(/^[a-f0-9]{64}$/),
  failedChecks: z.array(z.object({
    name: GateCheckNameSchema,
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
    /** Bounded, already-redacted head of the failure output. */
    excerpt: z.string().max(8_192),
  }).strict()).max(16),
  attempted: z.array(z.string().max(1_024)).max(32),
  observedAt: TimestampSchema,
}).strict();

export const LoopIterationSchema = z.object({
  id: IdentifierSchema, number: z.number().int().positive(), state: z.enum(["admitted", "running", "succeeded", "failed", "blocked", "cancelled", "timed_out"]),
  workKind: z.enum(["goal", "workflow", "repair"]), workId: IdentifierSchema.nullable(), admittedAt: TimestampSchema, completedAt: TimestampSchema.nullable(),
  reservedCostUsd: z.number().nonnegative(), requests: z.number().int().nonnegative(), error: z.string().max(4_096).nullable(),
  evidence: RepairEvidenceSchema.nullable().default(null),
}).strict();

export const LoopRecordSchema = z.object({
  version: z.literal(1), id: IdentifierSchema, projectId: ProjectIdSchema, principal: PrincipalIdSchema, policy: LoopPolicySchema,
  state: z.enum(["queued", "running", "paused", "backoff", "succeeded", "failed", "cancelled", "budget_exhausted", "deadline_exceeded", "no_progress", "awaiting_integration"]),
  iterations: z.array(LoopIterationSchema).max(1_000), usedCostUsd: z.number().nonnegative(), usedRequests: z.number().int().nonnegative(),
  nextRunAt: TimestampSchema.nullable(), lastObservedAt: TimestampSchema, createdAt: TimestampSchema, updatedAt: TimestampSchema,
}).strict();

export type LoopPolicy = z.infer<typeof LoopPolicySchema>;
export type LoopRecord = z.infer<typeof LoopRecordSchema>;
export type LoopTarget = z.infer<typeof LoopTargetSchema>;
export type RepairTarget = Extract<LoopTarget, { kind: "repair" }>;
export type RepairEvidence = z.infer<typeof RepairEvidenceSchema>;
