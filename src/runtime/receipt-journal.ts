import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { IdentifierSchema, PrincipalIdSchema, ProjectIdSchema, TimestampSchema } from "../contracts/common";
import { ReceiptBodySchema } from "../contracts/receipt";
import { atomicWriteFile } from "./atomic-write";
import { ensureOwnerOnlyDirectory, ensureOwnerOnlyFile, type ProjectStatePaths } from "./project-state";
import { safeJsonParse } from "./safe-json";

const ReceiptJournalProvenanceSchema = ReceiptBodySchema.shape.provenance.omit({
  startedAt: true,
  endedAt: true,
});
const ReceiptJournalBudgetSchema = ReceiptBodySchema.shape.budget.extend({
  // Preserve the assembly input so replay applies the receipt's exact bounded
  // redaction once, rather than journaling an already-transformed reason.
  reasons: z.array(z.string().max(20_000)).max(128),
});

export const ReceiptJournalRecordSchema = z.object({
  version: z.literal(1),
  projectId: ProjectIdSchema,
  jobId: IdentifierSchema,
  sessionId: IdentifierSchema.nullable(),
  principal: PrincipalIdSchema,
  state: z.enum(["pending", "completed", "gap"]),
  startedAt: TimestampSchema.nullable(),
  authorization: ReceiptBodySchema.shape.authorization.nullable(),
  brokerLease: ReceiptBodySchema.shape.brokerLease,
  gates: ReceiptBodySchema.shape.gates,
  budget: ReceiptJournalBudgetSchema,
  provenance: ReceiptJournalProvenanceSchema,
  captureFailure: z.string().min(1).max(2_048).nullable(),
  gapReason: z.string().min(1).max(2_048).nullable(),
  createdAt: TimestampSchema,
  completedAt: TimestampSchema.nullable(),
}).strict().superRefine((record, context) => {
  if (record.state === "pending" && (record.completedAt !== null || record.gapReason !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Pending receipt journals cannot carry completion metadata." });
  }
  if (record.state === "completed" && (record.completedAt === null || record.gapReason !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Completed receipt journals require a completion timestamp and no gap reason." });
  }
  if (record.state === "gap" && (record.completedAt === null || record.gapReason === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Receipt gaps require a completion timestamp and bounded reason." });
  }
});

export type ReceiptJournalRecord = z.infer<typeof ReceiptJournalRecordSchema>;
export type ReceiptJournalIntent = Omit<
  ReceiptJournalRecord,
  "version" | "projectId" | "state" | "gapReason" | "createdAt" | "completedAt"
>;

/**
 * Durable pre-terminal receipt inputs. A pending record is fsynced before the
 * terminal job write so startup can finish the evidence projection without
 * making receipt availability part of run authority or completion.
 */
export class ReceiptJournal {
  readonly directory: string;

  constructor(private readonly paths: ProjectStatePaths, private readonly now: () => number = Date.now) {
    this.directory = ensureOwnerOnlyDirectory(join(paths.projectDir, "receipt-journal"));
  }

  pending(intent: ReceiptJournalIntent) {
    const path = this.pathFor(intent.jobId);
    if (existsSync(path)) {
      const existing = this.read(path);
      const expected = pendingRecord(this.paths.projectId, intent, existing.createdAt);
      if (JSON.stringify(journalIntent(existing)) === JSON.stringify(journalIntent(expected))) return existing;
      throw new Error(`Receipt journal already contains different inputs for job ${intent.jobId}.`);
    }
    const record = pendingRecord(this.paths.projectId, intent, this.now());
    this.write(record);
    return record;
  }

  markCompleted(jobId: string) {
    const record = this.require(jobId);
    if (record.state === "completed") return record;
    if (record.state === "gap") throw new Error(`Receipt journal ${jobId} is already an explicit gap.`);
    const next = ReceiptJournalRecordSchema.parse({
      ...record,
      state: "completed",
      completedAt: this.now(),
    });
    this.write(next);
    return next;
  }

  markGap(jobId: string, reason: string) {
    const record = this.require(jobId);
    if (record.state === "gap") return record;
    if (record.state === "completed") throw new Error(`Receipt journal ${jobId} is already completed.`);
    const next = ReceiptJournalRecordSchema.parse({
      ...record,
      state: "gap",
      gapReason: reason,
      completedAt: this.now(),
    });
    this.write(next);
    return next;
  }

  get(jobId: string) {
    const path = this.pathFor(jobId);
    return existsSync(path) ? this.read(path) : null;
  }

  /** Invalid records are reported one-by-one and left untouched for repair. */
  listOpen(onError?: (path: string, error: unknown) => void) {
    const records: ReceiptJournalRecord[] = [];
    for (const name of readdirSync(this.directory).filter((candidate) => candidate.endsWith(".json")).sort()) {
      const path = join(this.directory, name);
      try {
        const record = this.read(path);
        if (record.state === "pending") records.push(record);
      } catch (error) {
        if (!onError) throw error;
        onError(path, error);
      }
    }
    return records.sort((left, right) => left.createdAt - right.createdAt);
  }

  private require(jobId: string) {
    const record = this.get(jobId);
    if (!record) throw new Error(`Unknown receipt journal record: ${jobId}`);
    return record;
  }

  private read(path: string) {
    ensureOwnerOnlyFile(path);
    const record = ReceiptJournalRecordSchema.parse(safeJsonParse(readFileSync(path, "utf8")));
    if (record.projectId !== this.paths.projectId) throw new Error("Receipt journal project mismatch.");
    return record;
  }

  private write(record: ReceiptJournalRecord) {
    const path = this.pathFor(record.jobId);
    atomicWriteFile(path, `${JSON.stringify(ReceiptJournalRecordSchema.parse(record))}\n`, { mode: 0o600 });
    ensureOwnerOnlyFile(path);
  }

  private pathFor(jobId: string) {
    return join(this.directory, `${IdentifierSchema.parse(jobId)}.json`);
  }
}

function pendingRecord(projectId: string, intent: ReceiptJournalIntent, createdAt: number) {
  return ReceiptJournalRecordSchema.parse({
    ...intent,
    version: 1,
    projectId,
    state: "pending",
    gapReason: null,
    createdAt,
    completedAt: null,
  });
}

function journalIntent(record: ReceiptJournalRecord): ReceiptJournalIntent {
  return {
    jobId: record.jobId,
    sessionId: record.sessionId,
    principal: record.principal,
    startedAt: record.startedAt,
    authorization: record.authorization,
    brokerLease: record.brokerLease,
    gates: record.gates,
    budget: record.budget,
    provenance: record.provenance,
    captureFailure: record.captureFailure,
  };
}
