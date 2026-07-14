import { z } from "zod";
import { IdentifierSchema, PrincipalIdSchema, ProjectIdSchema, RunModeSchema, TimestampSchema } from "./common";

export const LoopTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("goal"), objective: z.string().trim().min(1).max(500_000), mode: RunModeSchema.default("read-only"), fleetProfileId: IdentifierSchema.optional() }).strict(),
  z.object({ kind: z.literal("workflow"), definition: z.record(z.unknown()) }).strict(),
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

export const LoopIterationSchema = z.object({
  id: IdentifierSchema, number: z.number().int().positive(), state: z.enum(["admitted", "running", "succeeded", "failed", "blocked", "cancelled", "timed_out"]),
  workKind: z.enum(["goal", "workflow"]), workId: IdentifierSchema.nullable(), admittedAt: TimestampSchema, completedAt: TimestampSchema.nullable(),
  reservedCostUsd: z.number().nonnegative(), requests: z.number().int().nonnegative(), error: z.string().max(4_096).nullable(),
}).strict();

export const LoopRecordSchema = z.object({
  version: z.literal(1), id: IdentifierSchema, projectId: ProjectIdSchema, principal: PrincipalIdSchema, policy: LoopPolicySchema,
  state: z.enum(["queued", "running", "paused", "backoff", "succeeded", "failed", "cancelled", "budget_exhausted", "deadline_exceeded"]),
  iterations: z.array(LoopIterationSchema).max(1_000), usedCostUsd: z.number().nonnegative(), usedRequests: z.number().int().nonnegative(),
  nextRunAt: TimestampSchema.nullable(), lastObservedAt: TimestampSchema, createdAt: TimestampSchema, updatedAt: TimestampSchema,
}).strict();

export type LoopPolicy = z.infer<typeof LoopPolicySchema>;
export type LoopRecord = z.infer<typeof LoopRecordSchema>;
