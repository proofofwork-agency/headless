import { z } from "zod";
import {
  BackendIdSchema,
  ContainmentRequirementSchema,
  IdentifierSchema,
  PositiveTimeoutSchema,
  PrincipalIdSchema,
  ProjectIdSchema,
  RunModeSchema,
  StructuredErrorSchema,
} from "./common";
import { ApprovalPolicySchema, AuthModeSchema } from "./native";
import { ContainmentEvidenceSchema, CostAttributionSchema, RunResultSchema, TokenUsageSchema } from "./run";
import { FinalityDecisionSchema, GrantSchema } from "./durable";

/** Lowercase hex SHA-256 digest. Shared by the receipt self-digest, section digests, and ledger anchor. */
export const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Upper bound on a redacted preview embedded in a receipt (the full bytes live in the run stores, not here). */
export const RECEIPT_PREVIEW_MAX = 4_096;
/** Upper bound on one redacted policy reason retained in a receipt. */
export const RECEIPT_POLICY_REASON_MAX = 16_384;
/** Upper bound on one redacted budget reason retained in a receipt. */
export const RECEIPT_BUDGET_REASON_MAX = 4_096;
/** Upper bound on retained policy-decision entries so a chatty run cannot unbound the receipt. */
export const RECEIPT_POLICY_TRAIL_MAX = 256;
/** Upper bound on gate-manifest entries retained in a receipt. */
export const RECEIPT_GATE_MANIFEST_MAX = 64;

/**
 * A content-addressed stand-in for a large or sensitive blob (prompt, output).
 * The receipt carries the exact-bytes digest + size + a bounded redacted
 * preview, never the full payload — so a receipt stays small and safe to share,
 * while anyone holding the original bytes recomputes the digest and matches.
 */
const ReceiptBlobSchema = z.object({
  digest: Sha256HexSchema,
  bytes: z.number().int().nonnegative(),
  preview: z.string().max(RECEIPT_PREVIEW_MAX),
}).strict();

/** Write-mode diff proof: the patch is anchored by digest; file list + commit SHAs stay in the clear. */
const ReceiptDiffSchema = z.object({
  digest: Sha256HexSchema,
  bytes: z.number().int().nonnegative(),
  files: z.array(z.string().max(2_048)).max(256),
  baseCommit: z.string().max(128).nullable(),
  candidateCommit: z.string().max(128).nullable(),
  resultingCommit: z.string().max(128).nullable(),
}).strict();

/** Echo of the authority/policy INPUTS that authorized the run (from the request), plus the prompt digest. */
const ReceiptRequestSchema = z.object({
  backend: BackendIdSchema,
  mode: RunModeSchema,
  model: z.string().max(256).nullable(),
  agent: z.string().max(256).nullable(),
  timeoutMs: PositiveTimeoutSchema,
  containment: ContainmentRequirementSchema,
  authMode: AuthModeSchema,
  approvalPolicy: ApprovalPolicySchema,
  prompt: ReceiptBlobSchema,
}).strict();

/** The run outcome — existing sub-schemas reused verbatim; output/diff replaced by digests. */
const ReceiptResultSchema = z.object({
  status: RunResultSchema.shape.status,
  error: StructuredErrorSchema.nullable(),
  exitCode: z.number().int().nullable(),
  signal: z.string().max(64).nullable(),
  usage: TokenUsageSchema,
  cost: CostAttributionSchema,
  containment: ContainmentEvidenceSchema,
  durationMs: z.number().int().nonnegative(),
  truncation: RunResultSchema.shape.truncation,
  output: ReceiptBlobSchema,
  diff: ReceiptDiffSchema.nullable(),
}).strict();

/** A single policy decision captured from the run's `kind:"policy"` events, embedded so it survives compaction. */
const ReceiptPolicyEntrySchema = z.object({
  decision: z.enum(["allowed", "denied", "deferred"]),
  rule: z.string().max(256),
  reason: z.string().max(RECEIPT_POLICY_REASON_MAX),
}).strict();

/**
 * Grant terms echoed at the authorization checkpoint. Only the fields that are
 * immutable post-issuance (operations, backends, expiry, cost/iteration caps) —
 * never the mutable `usedIterations`/`revokedAt`, so the receipt cannot imply
 * remaining authority incorrectly.
 */
const ReceiptGrantTermsSchema = z.object({
  operations: GrantSchema.shape.operations,
  backends: GrantSchema.shape.backends,
  expiresAt: GrantSchema.shape.expiresAt,
  maxCostUsd: GrantSchema.shape.maxCostUsd,
  maxIterations: GrantSchema.shape.maxIterations,
}).strict();

/**
 * Immutable snapshot of the authorization the daemon actually accepted, taken at
 * the authz checkpoint. Source-discriminated so a grant-less receipt is never
 * ambiguous: `grant` carries grantId + grantTerms; `root`/`foreground_lead` carry
 * neither. Mirrors `AuthorizationDecision` (whose `root` is a boolean, folded into
 * `source`) plus the grant terms that `AuthorizationDecision` itself omits.
 */
const ReceiptAuthorizationSchema = z.object({
  source: z.enum(["root", "foreground_lead", "grant"]),
  mergeAllowed: z.boolean(),
  maxCostUsd: z.number().nonnegative().nullable(),
  grantId: IdentifierSchema.nullable(),
  grantTerms: ReceiptGrantTermsSchema.nullable(),
  finality: FinalityDecisionSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  const isGrant = value.source === "grant";
  if (isGrant && value.grantId === null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "grant authorization requires a grantId." });
  if (isGrant && value.grantTerms === null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "grant authorization requires grantTerms." });
  if (!isGrant && value.grantId !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${value.source} authorization must not carry a grantId.` });
  if (!isGrant && value.grantTerms !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${value.source} authorization must not carry grantTerms.` });
});

/** Effective request-time caps of the broker lease for one quota (never usage counters or credentials). */
const ReceiptBrokerQuotaSchema = z.object({
  id: IdentifierSchema,
  maxRequests: z.number().int().nonnegative().nullable(),
  maxInputTokens: z.number().int().nonnegative().nullable(),
  maxOutputTokens: z.number().int().nonnegative().nullable(),
  maxCostUsd: z.number().nonnegative().nullable(),
}).strict();

/**
 * Redacted snapshot of the broker lease scope enforced for a broker-auth run —
 * the request-time envelope the budget OUTCOME alone does not prove. A projection
 * of `BrokerLeaseScope` (src/broker/server.ts) that deliberately EXCLUDES the
 * bearer token, tokenHash, baseUrl, and mutable usage counters. `null` for
 * native-auth runs or runs without a lease.
 */
const ReceiptBrokerLeaseSchema = z.object({
  provider: z.string().min(1).max(128),
  models: z.array(z.string().max(128)).max(128),
  endpointClasses: z.array(z.string().min(1).max(64)).max(16),
  expiresAt: z.number().int().nonnegative(),
  maxRequests: z.number().int().nonnegative().nullable(),
  maxBodyBytes: z.number().int().nonnegative().nullable(),
  maxConcurrentRequests: z.number().int().nonnegative().nullable(),
  maxInFlightBodyBytes: z.number().int().nonnegative().nullable(),
  maxStreamMs: z.number().int().nonnegative().nullable(),
  maxCostUsd: z.number().nonnegative().nullable(),
  quotas: z.array(ReceiptBrokerQuotaSchema).max(256),
  scopeDigest: Sha256HexSchema,
}).strict();

/** One bounded gate-manifest entry: which gate definition ran and its result — not its transcript. */
const ReceiptGateEntrySchema = z.object({
  phase: z.enum(["candidate", "integration"]),
  name: z.string().min(1).max(256),
  status: z.enum(["passed", "failed", "timed_out", "cancelled"]),
  definitionDigest: Sha256HexSchema,
  evidenceDigest: Sha256HexSchema,
}).strict();

/** Budget outcome for the run. */
const ReceiptBudgetSchema = z.object({
  passed: z.boolean(),
  reasons: z.array(z.string().max(RECEIPT_BUDGET_REASON_MAX)).max(128),
  usage: TokenUsageSchema,
  cost: CostAttributionSchema,
  reservationId: IdentifierSchema.nullable(),
}).strict();

/** Run-scoped provenance envelope (wall-clock window + the toolchain that produced the run). */
const ReceiptProvenanceSchema = z.object({
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  headlessVersion: z.string().min(1).max(128),
  platform: z.string().min(1).max(128),
  commit: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  backendVersion: z.string().max(256).nullable(),
}).strict();

/**
 * The attested content of a receipt. `integrity.selfDigest` is the SHA-256 of
 * `canonicalReceiptJson(body)` and nothing outside `body` is covered, so an
 * external verifier hashes exactly this object — no field-exclusion rules.
 */
export const ReceiptBodySchema = z.object({
  receiptId: IdentifierSchema,
  runId: IdentifierSchema,
  sessionId: IdentifierSchema.nullable(),
  projectId: ProjectIdSchema,
  principal: PrincipalIdSchema,
  request: ReceiptRequestSchema,
  result: ReceiptResultSchema,
  policyTrail: z.array(ReceiptPolicyEntrySchema).max(RECEIPT_POLICY_TRAIL_MAX),
  authorization: ReceiptAuthorizationSchema,
  brokerLease: ReceiptBrokerLeaseSchema.nullable(),
  gates: z.array(ReceiptGateEntrySchema).max(RECEIPT_GATE_MANIFEST_MAX),
  budget: ReceiptBudgetSchema,
  provenance: ReceiptProvenanceSchema,
}).strict();

/** The body sections a section-digest covers, in a stable order. */
export const RECEIPT_SECTIONS = [
  "request",
  "result",
  "policyTrail",
  "authorization",
  "brokerLease",
  "gates",
  "budget",
  "provenance",
] as const;
export type ReceiptSection = (typeof RECEIPT_SECTIONS)[number];

const ReceiptSectionDigestsSchema = z.object({
  request: Sha256HexSchema,
  result: Sha256HexSchema,
  policyTrail: Sha256HexSchema,
  authorization: Sha256HexSchema,
  brokerLease: Sha256HexSchema,
  gates: Sha256HexSchema,
  budget: Sha256HexSchema,
  provenance: Sha256HexSchema,
}).strict();

/** Binds a receipt to a single tamper-evident ledger record. */
export const ReceiptLedgerAnchorSchema = z.object({
  projectId: ProjectIdSchema,
  sequence: z.number().int().positive(),
  hash: Sha256HexSchema,
}).strict();

export const ReceiptSchema = z.object({
  version: z.literal(1),
  body: ReceiptBodySchema,
  sectionDigests: ReceiptSectionDigestsSchema,
  integrity: z.object({
    selfDigest: Sha256HexSchema,
    ledgerAnchor: ReceiptLedgerAnchorSchema,
  }).strict(),
}).strict();

export type Receipt = z.infer<typeof ReceiptSchema>;
export type ReceiptBody = z.infer<typeof ReceiptBodySchema>;
export type ReceiptLedgerAnchor = z.infer<typeof ReceiptLedgerAnchorSchema>;
export type ReceiptSectionDigests = z.infer<typeof ReceiptSectionDigestsSchema>;

/**
 * Decode a persisted receipt across schema versions. The live contract stays
 * strict; only this boundary tolerates known predecessors. v1 is the only
 * version today, so it parses directly — the switch exists so a future
 * `version: 2` stays forward-readable without breaking old files (mirrors
 * `decodePersistedRunResult`).
 */
export function decodePersistedReceipt(value: unknown): Receipt {
  return ReceiptSchema.parse(value);
}
