import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { FinalityDecisionSchema, type FinalityDecision } from "../contracts/durable";
import { IdentifierSchema, PrincipalIdSchema, ProjectIdSchema, TimestampSchema } from "../contracts/common";
import { ensureProjectStateDirectories, type ProjectStatePaths } from "./project-state";
import { readOwnerOnlyJson, writeOwnerOnlyJson } from "./owner-json";

export const FinalityRequirementsSchema = z.object({
  policy: z.boolean().default(true),
  tests: z.boolean().default(true),
  review: z.boolean().default(true),
  vote: z.boolean().default(true),
  budget: z.boolean().default(true),
}).strict();

export const FinalityGateStateSchema = z.object({
  policyPassed: z.boolean().default(false),
  testsPassed: z.boolean().default(false),
  reviewPassed: z.boolean().default(false),
  votePassed: z.boolean().default(false),
  budgetPassed: z.boolean().default(false),
}).strict();

const FinalityEvaluationSchema = z.object({
  id: IdentifierSchema.optional(),
  projectId: ProjectIdSchema,
  jobId: IdentifierSchema,
  decidedBy: PrincipalIdSchema,
  requirements: FinalityRequirementsSchema.default({}),
  gates: FinalityGateStateSchema.default({}),
}).strict();

const FinalityRecordSchema = z.object({
  requirements: FinalityRequirementsSchema,
  decision: FinalityDecisionSchema,
}).strict();

const FinalityStoreStateSchema = z.object({
  version: z.literal(2),
  projectId: ProjectIdSchema,
  records: z.array(FinalityRecordSchema),
  updatedAt: TimestampSchema,
}).strict();

export type FinalityRequirements = z.input<typeof FinalityRequirementsSchema>;
export type FinalityGateState = z.input<typeof FinalityGateStateSchema>;
export type FinalityEvaluation = z.input<typeof FinalityEvaluationSchema>;
export type FinalityRecord = z.infer<typeof FinalityRecordSchema>;

export type FinalityStoreOptions = {
  now?: () => number;
  id?: () => string;
};

export class FinalityStore {
  readonly projectId: string;
  readonly path: string;
  private readonly now: () => number;
  private readonly id: () => string;
  private state: z.infer<typeof FinalityStoreStateSchema>;

  constructor(paths: ProjectStatePaths, options: FinalityStoreOptions = {}) {
    ensureProjectStateDirectories(paths);
    this.projectId = ProjectIdSchema.parse(paths.projectId);
    this.path = join(paths.projectDir, "finality.json");
    this.now = options.now ?? Date.now;
    this.id = options.id ?? (() => `finality_${randomUUID()}`);

    const existing = readOwnerOnlyJson(this.path, FinalityStoreStateSchema);
    if (existing) {
      if (existing.projectId !== this.projectId) {
        throw new Error(`Finality project mismatch: expected ${this.projectId}, got ${existing.projectId}`);
      }
      this.state = existing;
      return;
    }

    this.state = FinalityStoreStateSchema.parse({
      version: 2,
      projectId: this.projectId,
      records: [],
      updatedAt: this.now(),
    });
    this.persist();
  }

  evaluate(value: FinalityEvaluation) {
    const evaluation = FinalityEvaluationSchema.parse(value);
    if (evaluation.projectId !== this.projectId) {
      throw new Error(`Finality project mismatch: expected ${this.projectId}, got ${evaluation.projectId}`);
    }

    const reasons: string[] = [];
    if (evaluation.requirements.policy && !evaluation.gates.policyPassed) reasons.push("Required policy gate has not passed.");
    if (evaluation.requirements.tests && !evaluation.gates.testsPassed) reasons.push("Required test gate has not passed.");
    if (evaluation.requirements.review && !evaluation.gates.reviewPassed) reasons.push("Required review gate has not passed.");
    if (evaluation.requirements.vote && !evaluation.gates.votePassed) reasons.push("Required vote gate has not passed.");
    if (evaluation.requirements.budget && !evaluation.gates.budgetPassed) reasons.push("Required budget gate has not passed.");

    const decision = FinalityDecisionSchema.parse({
      id: evaluation.id ?? this.id(),
      projectId: this.projectId,
      jobId: evaluation.jobId,
      allowed: reasons.length === 0,
      policyPassed: evaluation.gates.policyPassed,
      budgetPassed: evaluation.gates.budgetPassed,
      testsPassed: evaluation.gates.testsPassed,
      reviewPassed: evaluation.gates.reviewPassed,
      votePassed: evaluation.gates.votePassed,
      reasons,
      decidedBy: evaluation.decidedBy,
      createdAt: this.now(),
    });

    if (this.state.records.some((record) => record.decision.id === decision.id)) {
      throw new Error(`Finality decision already exists: ${decision.id}`);
    }
    const record = FinalityRecordSchema.parse({ requirements: evaluation.requirements, decision });
    this.state.records.push(record);
    this.state.updatedAt = this.now();
    this.persist();
    return FinalityDecisionSchema.parse(decision);
  }

  latest(jobId: string): FinalityDecision | null {
    const id = IdentifierSchema.parse(jobId);
    for (let index = this.state.records.length - 1; index >= 0; index -= 1) {
      const record = this.state.records[index];
      if (record.decision.jobId === id) return FinalityDecisionSchema.parse(record.decision);
    }
    return null;
  }

  list() {
    return this.state.records.map((record) => FinalityRecordSchema.parse(record));
  }

  private persist() {
    this.state = FinalityStoreStateSchema.parse(this.state);
    writeOwnerOnlyJson(this.path, this.state);
  }
}
