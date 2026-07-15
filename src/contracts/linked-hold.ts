import { z } from "zod";
import {
  BackendIdSchema,
  IdentifierSchema,
  MAX_RUN_PROMPT_BYTES,
  TimestampSchema,
} from "./common";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().safe();
const nullableCount = count.nullable();
const nullableCost = z.number().nonnegative().finite().nullable();
const providerId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);

export const LinkedHoldStateSchema = z.enum([
  "intent",
  "held",
  "parent_carved",
  "admitted",
  "leased",
  "settling",
  "settled",
  "rolled_back",
  "exhausted",
  "recovery_required",
]);

export const LinkedHoldEnvelopeSchema = z.object({
  requests: count,
  inputTokens: nullableCount,
  outputTokens: nullableCount,
  costUsd: nullableCost,
  artifactBytes: count,
  retries: count,
}).strict();

export const LinkedHoldBrokerEvidenceSchema = z.object({
  parentCarveId: IdentifierSchema.nullable(),
  targetLeaseId: IdentifierSchema.nullable(),
  targetLeaseIssuedAt: TimestampSchema.nullable(),
  targetRequests: count.nullable(),
  targetForwardedRequests: count.nullable(),
  targetInputTokens: count.nullable(),
  targetOutputTokens: count.nullable(),
  targetCostUsd: nullableCost,
  targetActiveRequests: count.nullable(),
  targetRevoked: z.boolean().nullable(),
  targetExpiresAt: TimestampSchema.nullable(),
}).strict();

export const LinkedHoldUsageProjectionSchema = z.object({
  requests: count,
  inputTokens: nullableCount,
  outputTokens: nullableCount,
  reasoningTokens: nullableCount,
  cachedTokens: nullableCount,
  providerTotalTokens: nullableCount,
  costUsd: nullableCost,
  costSource: z.enum(["provider", "broker", "reconciled", "unknown"]),
  pricingId: z.string().max(256).nullable(),
  artifactBytes: count,
}).strict();

export const LinkedHoldRecordSchema = z.object({
  linkId: digest,
  parentJobId: IdentifierSchema,
  parentReservationId: IdentifierSchema,
  childReservationId: IdentifierSchema,
  requestId: z.string().uuid(),
  parentBackend: BackendIdSchema,
  targetBackend: BackendIdSchema,
  parentProvider: providerId,
  targetProvider: providerId,
  depth: z.literal(1),
  budgetFraction: z.number().positive().max(0.5),
  parentDeadlineAt: TimestampSchema,
  childDeadlineAt: TimestampSchema,
  approvalPolicy: z.enum(["ask", "auto"]),
  parentAllocation: LinkedHoldEnvelopeSchema,
  targetReservation: LinkedHoldEnvelopeSchema,
  parentBudgetIds: z.array(IdentifierSchema).max(256),
  targetBudgetIds: z.array(IdentifierSchema).max(256),
  parentCarveId: IdentifierSchema,
  targetQuotaId: IdentifierSchema,
  requestDigest: digest,
  promptDigest: digest,
  promptBytes: count.max(MAX_RUN_PROMPT_BYTES),
  state: LinkedHoldStateSchema,
  transitionNumber: count,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  terminalAt: TimestampSchema.nullable(),
  childJobId: IdentifierSchema.nullable(),
  brokerEvidence: LinkedHoldBrokerEvidenceSchema,
  terminalSettlementDigest: digest.nullable(),
  usageProjection: LinkedHoldUsageProjectionSchema.nullable(),
}).strict().superRefine((record, context) => {
  if (record.parentProvider === record.targetProvider) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["targetProvider"], message: "Linked holds require different parent and target providers." });
  }
  if (record.parentBackend === record.targetBackend) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["targetBackend"], message: "Linked holds require different parent and target backends." });
  }
  if (record.childDeadlineAt > record.parentDeadlineAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["childDeadlineAt"], message: "The child deadline cannot exceed the parent deadline." });
  }
  if (record.updatedAt < record.createdAt || (record.terminalAt !== null && record.terminalAt < record.createdAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["updatedAt"], message: "Linked-hold timestamps cannot precede creation." });
  }
  requireUnique(record.parentBudgetIds, context, ["parentBudgetIds"], "parent budget id");
  requireUnique(record.targetBudgetIds, context, ["targetBudgetIds"], "target budget id");
  if (record.usageProjection) {
    requireAtMost(record.usageProjection.requests, record.targetReservation.requests, context, ["usageProjection", "requests"], "request usage");
    requireNullableAtMost(record.usageProjection.inputTokens, record.targetReservation.inputTokens, context, ["usageProjection", "inputTokens"], "input token usage");
    requireNullableAtMost(record.usageProjection.outputTokens, record.targetReservation.outputTokens, context, ["usageProjection", "outputTokens"], "output token usage");
    requireNullableAtMost(record.usageProjection.costUsd, record.targetReservation.costUsd, context, ["usageProjection", "costUsd"], "cost usage");
    requireAtMost(record.usageProjection.artifactBytes, record.targetReservation.artifactBytes, context, ["usageProjection", "artifactBytes"], "artifact usage");
  }
});

export type LinkedHoldState = z.infer<typeof LinkedHoldStateSchema>;
export type LinkedHoldEnvelope = z.infer<typeof LinkedHoldEnvelopeSchema>;
export type LinkedHoldBrokerEvidence = z.infer<typeof LinkedHoldBrokerEvidenceSchema>;
export type LinkedHoldUsageProjection = z.infer<typeof LinkedHoldUsageProjectionSchema>;
export type LinkedHoldRecord = z.infer<typeof LinkedHoldRecordSchema>;

function requireUnique(values: string[], context: z.RefinementCtx, path: Array<string | number>, label: string) {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path, message: `Linked holds require unique ${label}s.` });
  }
}

function requireAtMost(value: number, maximum: number, context: z.RefinementCtx, path: Array<string | number>, label: string) {
  if (value > maximum) context.addIssue({ code: z.ZodIssueCode.custom, path, message: `Linked-hold ${label} exceeds its target reservation.` });
}

function requireNullableAtMost(
  value: number | null,
  maximum: number | null,
  context: z.RefinementCtx,
  path: Array<string | number>,
  label: string,
) {
  if (value !== null && maximum !== null) requireAtMost(value, maximum, context, path, label);
}
