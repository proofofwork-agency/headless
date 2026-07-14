import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { IdentifierSchema, PrincipalIdSchema, ProjectIdSchema, TimestampSchema } from "../contracts/common";
import { ensureOwnerOnlyDirectory, ensureOwnerOnlyFile, type ProjectStatePaths } from "./project-state";
import { atomicWriteFile } from "./atomic-write";
import { safeJsonParse } from "./safe-json";

const GitObjectSchema = z.string().regex(/^[a-f0-9]{40,64}$/);

export const IntegrationJournalRecordSchema = z.object({
  version: z.literal(2),
  projectId: ProjectIdSchema,
  jobId: IdentifierSchema,
  sessionId: IdentifierSchema.nullable(),
  principal: PrincipalIdSchema,
  grantId: IdentifierSchema.nullable(),
  phase: z.enum(["candidate", "integration"]),
  outcome: z.enum(["merged_fast_forward", "merged_advanced"]),
  baseCommit: GitObjectSchema,
  candidateCommit: GitObjectSchema,
  expectedPrimaryHead: GitObjectSchema,
  targetCommit: GitObjectSchema,
  resultingCommit: GitObjectSchema.nullable(),
  state: z.enum(["prepared", "applied", "completed", "abandoned"]),
  createdAt: TimestampSchema,
  appliedAt: TimestampSchema.nullable(),
  completedAt: TimestampSchema.nullable(),
}).strict();

export type IntegrationJournalRecord = z.infer<typeof IntegrationJournalRecordSchema>;
export type IntegrationJournalIntent = Omit<
  IntegrationJournalRecord,
  "version" | "projectId" | "resultingCommit" | "state" | "createdAt" | "appliedAt" | "completedAt"
>;

/**
 * A per-job write-ahead journal for the one irreversible step in a write job:
 * updating the primary ref/checkout. The prepared record is fsynced before Git
 * runs, so restart recovery can infer the truth from targetCommit even if the
 * daemon dies after the ref update but before its normal ledger/job writes.
 */
export class IntegrationJournal {
  readonly directory: string;

  constructor(private readonly paths: ProjectStatePaths, private readonly now: () => number = Date.now) {
    this.directory = ensureOwnerOnlyDirectory(join(paths.projectDir, "integration-journal"));
  }

  prepare(intent: IntegrationJournalIntent) {
    const path = this.pathFor(intent.jobId);
    if (existsSync(path)) {
      const existing = this.read(path);
      const comparable = { ...existing, resultingCommit: null, state: "prepared", appliedAt: null, completedAt: null };
      const expected = {
        ...intent,
        version: 2,
        projectId: this.paths.projectId,
        resultingCommit: null,
        state: "prepared",
        createdAt: existing.createdAt,
        appliedAt: null,
        completedAt: null,
      };
      if (JSON.stringify(comparable) === JSON.stringify(expected)) return existing;
      throw new Error(`Integration journal already contains a different intent for job ${intent.jobId}.`);
    }
    const record = IntegrationJournalRecordSchema.parse({
      ...intent,
      version: 2,
      projectId: this.paths.projectId,
      resultingCommit: null,
      state: "prepared",
      createdAt: this.now(),
      appliedAt: null,
      completedAt: null,
    });
    this.write(record);
    return record;
  }

  markApplied(jobId: string, resultingCommit: string) {
    const record = this.require(jobId);
    const result = GitObjectSchema.parse(resultingCommit);
    if (result !== record.targetCommit) throw new Error("Applied integration commit does not match the prepared target.");
    if (record.state === "completed") return record;
    const next = IntegrationJournalRecordSchema.parse({
      ...record,
      resultingCommit: result,
      state: "applied",
      appliedAt: record.appliedAt ?? this.now(),
    });
    this.write(next);
    return next;
  }

  markCompleted(jobId: string, resultingCommit: string) {
    const applied = this.markApplied(jobId, resultingCommit);
    if (applied.state === "completed") return applied;
    const next = IntegrationJournalRecordSchema.parse({
      ...applied,
      state: "completed",
      completedAt: this.now(),
    });
    this.write(next);
    return next;
  }

  markAbandoned(jobId: string, observedPrimaryHead: string) {
    const record = this.require(jobId);
    if (record.state === "completed" || record.state === "abandoned") return record;
    const next = IntegrationJournalRecordSchema.parse({
      ...record,
      resultingCommit: GitObjectSchema.parse(observedPrimaryHead),
      state: "abandoned",
      completedAt: this.now(),
    });
    this.write(next);
    return next;
  }

  get(jobId: string) {
    const path = this.pathFor(jobId);
    return existsSync(path) ? this.read(path) : null;
  }

  listOpen() {
    return readdirSync(this.directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.read(join(this.directory, name)))
      .filter((record) => record.state !== "completed" && record.state !== "abandoned")
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  private require(jobId: string) {
    const record = this.get(jobId);
    if (!record) throw new Error(`Unknown integration journal record: ${jobId}`);
    return record;
  }

  private read(path: string) {
    ensureOwnerOnlyFile(path);
    const record = IntegrationJournalRecordSchema.parse(safeJsonParse(readFileSync(path, "utf8")));
    if (record.projectId !== this.paths.projectId) throw new Error("Integration journal project mismatch.");
    return record;
  }

  private write(record: IntegrationJournalRecord) {
    const path = this.pathFor(record.jobId);
    atomicWriteFile(path, `${JSON.stringify(IntegrationJournalRecordSchema.parse(record))}\n`, { mode: 0o600 });
    ensureOwnerOnlyFile(path);
  }

  private pathFor(jobId: string) {
    const id = IdentifierSchema.parse(jobId);
    return join(this.directory, `${id}.json`);
  }
}
