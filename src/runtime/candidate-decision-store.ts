import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { IdentifierSchema, PrincipalIdSchema, ProjectIdSchema, TimestampSchema } from "../contracts/common";
import { readOwnerOnlyJson, writeOwnerOnlyJson } from "./owner-json";
import { ensureProjectStateDirectories, type ProjectStatePaths } from "./project-state";
import { redactAndTruncate } from "./redaction";

const GitObjectSchema = z.string().regex(/^[a-f0-9]{40,64}$/);

export const CandidateIntegrationOutcomeSchema = z.enum([
  "merged_fast_forward",
  "merged_advanced",
  "blocked_dirty_primary",
  "blocked_conflict",
  "blocked_integration_gates",
  "blocked_primary_advanced",
  "approval_required",
  "unauthorized",
  "cancelled",
  "invalid_candidate",
  "recovered_applied",
  "recovered_abandoned",
]);

export const CandidateIntegrationAttemptSchema = z.object({
  id: IdentifierSchema,
  candidateId: IdentifierSchema,
  actor: PrincipalIdSchema,
  outcome: CandidateIntegrationOutcomeSchema,
  merged: z.boolean(),
  baseCommit: GitObjectSchema.nullable(),
  candidateCommit: GitObjectSchema.nullable(),
  expectedPrimaryHead: GitObjectSchema.nullable(),
  targetCommit: GitObjectSchema.nullable(),
  resultingCommit: GitObjectSchema.nullable(),
  grantId: IdentifierSchema.nullable(),
  approvalId: IdentifierSchema.nullable(),
  finalityId: IdentifierSchema.nullable(),
  reason: z.string().min(1).max(4_096),
  evidence: z.array(z.string().max(4_096)).max(64),
  startedAt: TimestampSchema,
  completedAt: TimestampSchema,
}).strict().superRefine((attempt, context) => {
  if (attempt.completedAt < attempt.startedAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Candidate attempt completion cannot precede its start." });
  }
});

export const CandidateDecisionRecordSchema = z.object({
  candidateId: IdentifierSchema,
  projectId: ProjectIdSchema,
  status: z.enum(["available", "rejected", "integrated"]),
  rejectedBy: PrincipalIdSchema.nullable(),
  rejectionReason: z.string().max(4_096).nullable(),
  rejectedAt: TimestampSchema.nullable(),
  integratedBy: PrincipalIdSchema.nullable(),
  resultingCommit: GitObjectSchema.nullable(),
  integratedAt: TimestampSchema.nullable(),
  attempts: z.array(CandidateIntegrationAttemptSchema).max(128),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict().superRefine((record, context) => {
  if (record.status === "rejected" && (record.rejectedBy === null || record.rejectionReason === null || record.rejectedAt === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Rejected candidates require attributed rejection state." });
  }
  if (record.status === "integrated" && (record.integratedBy === null || record.resultingCommit === null || record.integratedAt === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Integrated candidates require attributed integration state." });
  }
  if (record.updatedAt < record.createdAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Candidate decision timestamps are inconsistent." });
  }
});

const CandidateDecisionStateSchema = z.object({
  version: z.literal(1),
  projectId: ProjectIdSchema,
  records: z.array(CandidateDecisionRecordSchema).max(8_192),
  updatedAt: TimestampSchema,
}).strict().superRefine((state, context) => {
  if (new Set(state.records.map((record) => record.candidateId)).size !== state.records.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Candidate decision ids must be unique." });
  }
});

export type CandidateIntegrationOutcome = z.infer<typeof CandidateIntegrationOutcomeSchema>;
export type CandidateIntegrationAttempt = z.infer<typeof CandidateIntegrationAttemptSchema>;
export type CandidateDecisionRecord = z.infer<typeof CandidateDecisionRecordSchema>;

export class CandidateDecisionStore {
  readonly path: string;
  private state: z.infer<typeof CandidateDecisionStateSchema>;
  private readonly now: () => number;
  private readonly id: () => string;

  constructor(
    private readonly paths: ProjectStatePaths,
    options: { now?: () => number; id?: () => string } = {},
  ) {
    ensureProjectStateDirectories(paths);
    this.path = join(paths.projectDir, "candidate-decisions.json");
    this.now = options.now ?? Date.now;
    this.id = options.id ?? (() => `candidate_attempt_${randomUUID()}`);
    const existing = readOwnerOnlyJson(this.path, CandidateDecisionStateSchema);
    if (existing && existing.projectId !== paths.projectId) throw new Error("Candidate decision project mismatch.");
    this.state = existing ?? CandidateDecisionStateSchema.parse({
      version: 1,
      projectId: paths.projectId,
      records: [],
      updatedAt: this.now(),
    });
    if (!existing) this.persist();
  }

  get(candidateId: string) {
    const id = IdentifierSchema.parse(candidateId);
    const record = this.state.records.find((candidate) => candidate.candidateId === id);
    return record ? cloneRecord(record) : null;
  }

  list() {
    return this.state.records.map(cloneRecord);
  }

  recordAttempt(input: Omit<CandidateIntegrationAttempt, "id" | "reason" | "evidence"> & {
    id?: string;
    reason: string;
    evidence?: string[];
  }) {
    const at = this.now();
    const attempt = CandidateIntegrationAttemptSchema.parse({
      ...input,
      id: input.id ?? this.id(),
      reason: safeText(input.reason),
      evidence: (input.evidence ?? []).slice(0, 64).map(safeText),
      completedAt: input.completedAt ?? at,
    });
    const record = this.requireOrCreate(attempt.candidateId, at);
    const existing = record.attempts.find((candidate) => candidate.id === attempt.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(attempt)) throw new Error(`Candidate attempt ids are immutable: ${attempt.id}`);
      return structuredClone(existing);
    }
    record.attempts.push(attempt);
    if (record.attempts.length > 128) record.attempts.splice(0, record.attempts.length - 128);
    record.updatedAt = at;
    this.state.updatedAt = at;
    this.persist();
    return structuredClone(attempt);
  }

  reject(candidateId: string, actor: string, reason: string) {
    const at = this.now();
    const record = this.requireOrCreate(candidateId, at);
    if (record.status === "integrated") throw new Error(`Integrated candidate ${candidateId} cannot be rejected.`);
    const principal = PrincipalIdSchema.parse(actor);
    const safeReason = safeText(reason);
    if (record.status === "rejected") {
      if (record.rejectedBy === principal && record.rejectionReason === safeReason) return cloneRecord(record);
      throw new Error(`Candidate ${candidateId} is already rejected.`);
    }
    Object.assign(record, {
      status: "rejected" as const,
      rejectedBy: principal,
      rejectionReason: safeReason,
      rejectedAt: at,
      updatedAt: at,
    });
    this.state.updatedAt = at;
    this.persist();
    return cloneRecord(record);
  }

  markIntegrated(candidateId: string, actor: string, resultingCommit: string) {
    const at = this.now();
    const record = this.requireOrCreate(candidateId, at);
    const principal = PrincipalIdSchema.parse(actor);
    const commit = GitObjectSchema.parse(resultingCommit);
    if (record.status === "rejected") throw new Error(`Rejected candidate ${candidateId} cannot be integrated.`);
    if (record.status === "integrated") {
      if (record.resultingCommit === commit) return cloneRecord(record);
      throw new Error(`Candidate ${candidateId} is already integrated at another commit.`);
    }
    Object.assign(record, {
      status: "integrated" as const,
      integratedBy: principal,
      resultingCommit: commit,
      integratedAt: at,
      updatedAt: at,
    });
    this.state.updatedAt = at;
    this.persist();
    return cloneRecord(record);
  }

  private requireOrCreate(candidateId: string, at: number) {
    const id = IdentifierSchema.parse(candidateId);
    let record = this.state.records.find((candidate) => candidate.candidateId === id);
    if (record) return record;
    record = CandidateDecisionRecordSchema.parse({
      candidateId: id,
      projectId: this.paths.projectId,
      status: "available",
      rejectedBy: null,
      rejectionReason: null,
      rejectedAt: null,
      integratedBy: null,
      resultingCommit: null,
      integratedAt: null,
      attempts: [],
      createdAt: at,
      updatedAt: at,
    });
    this.state.records.push(record);
    return record;
  }

  private persist() {
    this.state = CandidateDecisionStateSchema.parse(this.state);
    writeOwnerOnlyJson(this.path, this.state);
  }
}

function safeText(value: string) {
  try {
    return redactAndTruncate(value, 4_096).text.trim() || "No reason recorded.";
  } catch {
    return "[SUPPRESSED: REDACTION FAILURE]";
  }
}

function cloneRecord(record: CandidateDecisionRecord) {
  return structuredClone(CandidateDecisionRecordSchema.parse(record));
}
