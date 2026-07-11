import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { CouncilSchema, type Council } from "../contracts/durable";
import { IdentifierSchema } from "../contracts/common";
import type { ProjectStatePaths } from "./project-state";
import { readOwnerOnlyJson, writeOwnerOnlyJson } from "./owner-json";

export const CouncilVoteSchema = z.object({
  id: IdentifierSchema,
  agent: z.string().min(1).max(128),
  vote: z.enum(["approve", "reject"]),
  references: z.array(IdentifierSchema).min(1).max(128),
  rationale: z.string().min(1).max(16_384),
  jobId: IdentifierSchema,
}).strict();

const CouncilRecordSchema = z.object({
  council: CouncilSchema,
  question: z.string().min(1).max(1_000_000),
  mode: z.enum(["read-only", "write"]).default("read-only"),
  timeoutMs: z.number().int().positive().max(86_400_000).default(180_000),
  proposalJobs: z.array(IdentifierSchema),
  executionJobs: z.array(IdentifierSchema),
  testJobs: z.array(IdentifierSchema).default([]),
  reviewJobs: z.array(IdentifierSchema),
  voteJobs: z.array(IdentifierSchema).default([]),
  votes: z.array(CouncilVoteSchema),
  decision: z.object({ approved: z.boolean(), reason: z.string().max(16_384) }).strict().nullable(),
}).strict();

const CouncilStoreSchema = z.object({
  version: z.literal(2),
  projectId: z.string().regex(/^[a-f0-9]{64}$/),
  records: z.array(CouncilRecordSchema),
}).strict();

export type CouncilRecord = z.infer<typeof CouncilRecordSchema>;
export type CouncilVote = z.infer<typeof CouncilVoteSchema>;

export class CouncilStore {
  private readonly path: string;
  private state: z.infer<typeof CouncilStoreSchema>;

  constructor(private readonly paths: ProjectStatePaths) {
    this.path = join(paths.projectDir, "councils.json");
    this.state = readOwnerOnlyJson(this.path, CouncilStoreSchema) ?? { version: 2, projectId: paths.projectId, records: [] };
    if (this.state.projectId !== paths.projectId) throw new Error("Council store project mismatch.");
    this.persist();
  }

  create(
    question: string,
    participants: string[],
    principal: string,
    options: {
      jobId?: string;
      mode?: "read-only" | "write";
      timeoutMs?: number;
      authMode?: Council["authMode"];
      approvalPolicy?: Council["approvalPolicy"];
    } = {},
  ) {
    const now = Date.now();
    const council = CouncilSchema.parse({
      id: randomUUID(),
      projectId: this.paths.projectId,
      principal,
      jobId: options.jobId ?? randomUUID(),
      phase: "proposal",
      authMode: options.authMode ?? "native-login",
      approvalPolicy: options.approvalPolicy ?? "ask",
      participants,
      proposalArtifactIds: [],
      candidateArtifactIds: [],
      reviewArtifactIds: [],
      voteIds: [],
      createdAt: now,
      updatedAt: now,
    });
    const record = CouncilRecordSchema.parse({
      council,
      question,
      mode: options.mode ?? "read-only",
      timeoutMs: options.timeoutMs ?? 180_000,
      proposalJobs: [],
      executionJobs: [],
      testJobs: [],
      reviewJobs: [],
      voteJobs: [],
      votes: [],
      decision: null,
    });
    this.state.records.push(record);
    this.persist();
    return record;
  }

  update(id: string, phase: Council["phase"], patch: Partial<Omit<CouncilRecord, "council" | "question">> = {}) {
    const record = this.state.records.find((entry) => entry.council.id === id);
    if (!record) throw new Error(`Unknown council: ${id}`);
    Object.assign(record, patch);
    record.council.phase = phase;
    record.council.updatedAt = Date.now();
    record.council.proposalArtifactIds = [...record.proposalJobs];
    record.council.candidateArtifactIds = [...record.executionJobs];
    record.council.reviewArtifactIds = [...record.reviewJobs];
    record.council.voteIds = record.votes.map((vote) => vote.id);
    this.persist();
    return CouncilRecordSchema.parse(record);
  }

  get(id: string) {
    const record = this.state.records.find((entry) => entry.council.id === id);
    return record ? CouncilRecordSchema.parse(record) : null;
  }

  list() {
    return this.state.records
      .map((record) => CouncilRecordSchema.parse(record))
      .sort((left, right) => left.council.createdAt - right.council.createdAt);
  }

  appendJob(
    id: string,
    field: "proposalJobs" | "executionJobs" | "testJobs" | "reviewJobs" | "voteJobs",
    jobId: string,
  ) {
    const record = this.get(id);
    if (!record) throw new Error(`Unknown council: ${id}`);
    if (record[field].includes(jobId)) return record;
    const jobs = [...record[field], IdentifierSchema.parse(jobId)];
    if (field === "proposalJobs") return this.update(id, record.council.phase, { proposalJobs: jobs });
    if (field === "executionJobs") return this.update(id, record.council.phase, { executionJobs: jobs });
    if (field === "testJobs") return this.update(id, record.council.phase, { testJobs: jobs });
    if (field === "reviewJobs") return this.update(id, record.council.phase, { reviewJobs: jobs });
    return this.update(id, record.council.phase, { voteJobs: jobs });
  }

  private persist() {
    this.state = CouncilStoreSchema.parse(this.state);
    writeOwnerOnlyJson(this.path, this.state);
  }
}
