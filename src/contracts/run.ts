import { z } from "zod";
import {
  BackendIdSchema,
  BoundedTextSchema,
  ContainmentRequirementSchema,
  IdentifierSchema,
  PositiveTimeoutSchema,
  RunModeSchema,
  StructuredErrorSchema,
} from "./common";
import { ApprovalPolicySchema, AuthModeSchema, CredentialAccessSchema } from "./native";
import { AgentNameSchema, backendAgentSelectionRefinement } from "./agent-name";

export const RunRequestObjectSchema = z.object({
  backend: BackendIdSchema,
  prompt: BoundedTextSchema,
  projectRoot: z.string().min(1).max(4_096),
  mode: RunModeSchema.default("read-only"),
  model: z.string().trim().min(1).max(256).refine((value) => !value.startsWith("-"), "Model must not begin with a flag prefix.").optional(),
  agent: AgentNameSchema.optional(),
  timeoutMs: PositiveTimeoutSchema.default(180_000),
  sessionId: IdentifierSchema.optional(),
  containment: ContainmentRequirementSchema.default("required"),
  authMode: AuthModeSchema.default("broker"),
  approvalPolicy: ApprovalPolicySchema.default("ask"),
}).strict();

export const RunRequestSchema = RunRequestObjectSchema.superRefine(backendAgentSelectionRefinement);

export type SerializedRunRequest = z.infer<typeof RunRequestSchema>;
export type RunRequest = SerializedRunRequest & { signal?: AbortSignal };

export const TokenUsageSchema = z.object({
  input: z.number().int().nonnegative().nullable().default(null),
  output: z.number().int().nonnegative().nullable().default(null),
  reasoning: z.number().int().nonnegative().nullable().default(null),
  cached: z.number().int().nonnegative().nullable().default(null),
  providerTotal: z.number().int().nonnegative().nullable().default(null),
}).strict();

export const CostAttributionSchema = z.object({
  amountUsd: z.number().nonnegative().nullable(),
  source: z.enum(["provider", "broker", "reconciled", "unknown"]),
  pricingId: z.string().max(256).nullable().default(null),
  observedRequests: z.number().int().nonnegative().default(0),
}).strict();

export const ParserDiagnosticsSchema = z.object({
  format: z.string().max(128),
  malformedEvents: z.number().int().nonnegative().default(0),
  ignoredEvents: z.number().int().nonnegative().default(0),
  messages: z.array(z.string().max(2_048)).max(64).default([]),
}).strict();

export const ContainmentEvidenceSchema = z.object({
  requirement: ContainmentRequirementSchema,
  enforced: z.boolean(),
  platform: z.enum(["darwin", "linux", "win32", "other"]),
  mechanism: z.string().max(256).nullable(),
  probe: z.string().max(2_048).nullable(),
  isolatedHome: z.boolean(),
  credentialsIsolated: z.boolean(),
  network: z.enum(["broker-only", "native-direct-unrestricted", "denied", "unrestricted"]),
  credentialAccess: CredentialAccessSchema.default("none"),
  unsafe: z.boolean(),
}).strict();

export const RunDiffSchema = z.object({
  patch: z.string().max(270_000),
  status: z.string().max(70_000),
  files: z.array(z.string().max(2_048)).max(256),
  baseCommit: z.string().max(128).nullable().default(null),
  candidateCommit: z.string().max(128).nullable().default(null),
  resultingCommit: z.string().max(128).nullable().default(null),
}).strict();

export const RunResultSchema = z.object({
  status: z.enum(["succeeded", "failed", "timed_out", "cancelled", "blocked"]),
  error: StructuredErrorSchema.nullable(),
  backend: BackendIdSchema,
  output: z.string().max(270_000),
  stderr: z.string().max(270_000),
  diagnostics: ParserDiagnosticsSchema,
  exitCode: z.number().int().nullable(),
  signal: z.string().max(64).nullable(),
  usage: TokenUsageSchema,
  cost: CostAttributionSchema,
  containment: ContainmentEvidenceSchema,
  durationMs: z.number().int().nonnegative(),
  sessionId: IdentifierSchema.nullable(),
  jobId: IdentifierSchema.nullable(),
  diff: RunDiffSchema.nullable(),
  commit: z.object({
    base: z.string().max(128).nullable(),
    candidate: z.string().max(128).nullable(),
    result: z.string().max(128).nullable(),
    merged: z.boolean(),
  }).strict().nullable(),
  truncation: z.object({
    stdout: z.boolean(),
    stderr: z.boolean(),
    output: z.boolean(),
    events: z.boolean(),
    artifacts: z.boolean(),
    diff: z.boolean(),
  }).strict(),
}).strict();

export type RunResult = z.infer<typeof RunResultSchema>;

const EventEnvelopeSchema = z.object({
  version: z.literal(2),
  eventId: IdentifierSchema,
  jobId: IdentifierSchema,
  sessionId: IdentifierSchema.nullable(),
  sequence: z.number().int().nonnegative(),
  timestamp: z.number().int().nonnegative(),
  redacted: z.literal(true),
});

const chunk = EventEnvelopeSchema.extend({
  kind: z.enum(["stdout", "stderr"]),
  text: z.string().max(65_536),
  truncated: z.boolean(),
});

const lifecycle = EventEnvelopeSchema.extend({
  kind: z.literal("lifecycle"),
  state: z.enum(["queued", "preparing", "running", "cancelling", "succeeded", "failed", "timed_out", "cancelled", "blocked"]),
  detail: z.string().max(4_096).optional(),
});

const usage = EventEnvelopeSchema.extend({
  kind: z.literal("usage"),
  usage: TokenUsageSchema,
  cost: CostAttributionSchema,
});

const tool = EventEnvelopeSchema.extend({
  kind: z.literal("tool"),
  name: z.string().max(256),
  phase: z.enum(["started", "completed", "failed"]),
  summary: z.string().max(16_384),
});

const policy = EventEnvelopeSchema.extend({
  kind: z.literal("policy"),
  decision: z.enum(["allowed", "denied", "deferred"]),
  rule: z.string().max(256),
  reason: z.string().max(16_384),
});

const artifact = EventEnvelopeSchema.extend({
  kind: z.literal("artifact"),
  artifactId: IdentifierSchema,
  artifactKind: z.string().max(128),
  summary: z.string().max(16_384),
  truncated: z.boolean(),
});

const completion = EventEnvelopeSchema.extend({
  kind: z.literal("completion"),
  result: RunResultSchema,
});

export const RunEventSchema = z.discriminatedUnion("kind", [
  lifecycle,
  chunk,
  usage,
  tool,
  policy,
  artifact,
  completion,
]);

export type RunEvent = z.infer<typeof RunEventSchema>;
