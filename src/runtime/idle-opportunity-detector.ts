import { createHash } from "node:crypto";
import { z } from "zod";
import { IdentifierSchema, TimestampSchema } from "../contracts/common";
import { readOwnerOnlyJson, writeOwnerOnlyJson } from "./owner-json";

export const IDLE_QUIESCENCE_DEBOUNCE_MS = 8_000;
export const DEFAULT_STALLED_WORK_MS = 60_000;
export const DEFAULT_IDLE_WORKER_MS = 8_000;
export const MAX_IDLE_FINGERPRINTS = 4_096;

export const IdleOpportunityKindSchema = z.enum([
  "failed_gate_without_follow_up",
  "unverified_completion",
  "stalled_work",
  "unresolved_candidate",
  "idle_worker",
]);

const GoalInputSchema = z.object({
  id: IdentifierSchema,
  state: z.enum(["active", "waiting", "terminal"]),
  autonomous: z.boolean(),
}).strict();

const FailedGateInputSchema = z.object({
  id: IdentifierSchema,
  failedAt: TimestampSchema,
  followedUpAt: TimestampSchema.nullable(),
}).strict();

const CompletionInputSchema = z.object({
  id: IdentifierSchema,
  completedAt: TimestampSchema,
  verifiedAt: TimestampSchema.nullable(),
}).strict();

const WorkInputSchema = z.object({
  id: IdentifierSchema,
  state: z.enum(["queued", "active", "retrying", "blocked", "terminal"]),
  lastProgressAt: TimestampSchema,
}).strict();

const CandidateInputSchema = z.object({
  id: IdentifierSchema,
  state: z.enum(["pending", "reviewing", "ready", "integrated", "rejected"]),
  updatedAt: TimestampSchema,
  decisionAt: TimestampSchema.nullable(),
}).strict();

const WorkerInputSchema = z.object({
  id: IdentifierSchema,
  state: z.enum(["idle", "busy", "offline"]),
  lastActiveAt: TimestampSchema,
}).strict();

export const IdleOpportunityScanInputSchema = z.object({
  now: TimestampSchema,
  quiescentSince: TimestampSchema,
  goal: GoalInputSchema,
  failedGates: z.array(FailedGateInputSchema).max(1_024).default([]),
  completions: z.array(CompletionInputSchema).max(1_024).default([]),
  workItems: z.array(WorkInputSchema).max(1_024).default([]),
  candidates: z.array(CandidateInputSchema).max(1_024).default([]),
  workers: z.array(WorkerInputSchema).max(1_024).default([]),
  stalledWorkMs: z.number().int().positive().max(86_400_000).default(DEFAULT_STALLED_WORK_MS),
  idleWorkerMs: z.number().int().nonnegative().max(86_400_000).default(DEFAULT_IDLE_WORKER_MS),
  persistedFingerprints: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(MAX_IDLE_FINGERPRINTS).default([]),
}).strict().superRefine((input, context) => {
  if (input.quiescentSince > input.now) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "quiescentSince cannot be in the future.", path: ["quiescentSince"] });
  }
  if (new Set(input.persistedFingerprints).size !== input.persistedFingerprints.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Persisted idle fingerprints must be unique.", path: ["persistedFingerprints"] });
  }
});

export const IdleOpportunitySchema = z.object({
  kind: IdleOpportunityKindSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  goalId: IdentifierSchema,
  subjectId: IdentifierSchema,
  observedAt: TimestampSchema,
  detectedAt: TimestampSchema,
  detail: z.string().min(1).max(4_096),
}).strict();

export type IdleOpportunityKind = z.infer<typeof IdleOpportunityKindSchema>;
export type IdleOpportunityScanInput = z.infer<typeof IdleOpportunityScanInputSchema>;
export type IdleOpportunity = z.infer<typeof IdleOpportunitySchema>;

const FingerprintRecordSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  seenAt: TimestampSchema,
}).strict();

const DetectorSnapshotSchema = z.object({
  version: z.literal(1),
  fingerprints: z.array(FingerprintRecordSchema).max(MAX_IDLE_FINGERPRINTS),
}).strict().superRefine((snapshot, context) => {
  const values = snapshot.fingerprints.map((entry) => entry.fingerprint);
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Idle opportunity fingerprints must be unique.", path: ["fingerprints"] });
  }
});

export type IdleOpportunityDetectorSnapshot = z.infer<typeof DetectorSnapshotSchema>;

export function detectIdleOpportunities(input: IdleOpportunityScanInput): IdleOpportunity[] {
  const parsed = IdleOpportunityScanInputSchema.parse(input);
  if (parsed.goal.state !== "active" || !parsed.goal.autonomous) return [];
  if (parsed.now - parsed.quiescentSince < IDLE_QUIESCENCE_DEBOUNCE_MS) return [];
  const seen = new Set(parsed.persistedFingerprints);
  const opportunities: IdleOpportunity[] = [];

  for (const gate of parsed.failedGates) {
    if (gate.followedUpAt !== null && gate.followedUpAt >= gate.failedAt) continue;
    pushOpportunity(opportunities, seen, {
      kind: "failed_gate_without_follow_up",
      goalId: parsed.goal.id,
      subjectId: gate.id,
      observedAt: gate.failedAt,
      detectedAt: parsed.now,
      detail: "A failed gate has no later follow-up.",
    });
  }
  for (const completion of parsed.completions) {
    if (completion.verifiedAt !== null && completion.verifiedAt >= completion.completedAt) continue;
    pushOpportunity(opportunities, seen, {
      kind: "unverified_completion",
      goalId: parsed.goal.id,
      subjectId: completion.id,
      observedAt: completion.completedAt,
      detectedAt: parsed.now,
      detail: "A reported completion has not been verified.",
    });
  }
  for (const work of parsed.workItems) {
    if (!["queued", "active", "retrying"].includes(work.state)) continue;
    if (parsed.now - work.lastProgressAt < parsed.stalledWorkMs) continue;
    pushOpportunity(opportunities, seen, {
      kind: "stalled_work",
      goalId: parsed.goal.id,
      subjectId: work.id,
      observedAt: work.lastProgressAt,
      detectedAt: parsed.now,
      detail: `Work has made no progress for at least ${parsed.stalledWorkMs}ms.`,
    });
  }
  for (const candidate of parsed.candidates) {
    if (!["pending", "reviewing", "ready"].includes(candidate.state) || candidate.decisionAt !== null) continue;
    pushOpportunity(opportunities, seen, {
      kind: "unresolved_candidate",
      goalId: parsed.goal.id,
      subjectId: candidate.id,
      observedAt: candidate.updatedAt,
      detectedAt: parsed.now,
      detail: "A candidate is awaiting a durable decision.",
    });
  }
  for (const worker of parsed.workers) {
    if (worker.state !== "idle" || parsed.now - worker.lastActiveAt < parsed.idleWorkerMs) continue;
    pushOpportunity(opportunities, seen, {
      kind: "idle_worker",
      goalId: parsed.goal.id,
      subjectId: worker.id,
      observedAt: worker.lastActiveAt,
      detectedAt: parsed.now,
      detail: "An available worker is idle while the autonomous goal remains active.",
    });
  }

  const order = new Map<IdleOpportunityKind, number>([
    ["failed_gate_without_follow_up", 0],
    ["unverified_completion", 1],
    ["stalled_work", 2],
    ["unresolved_candidate", 3],
    ["idle_worker", 4],
  ]);
  return opportunities.sort((left, right) =>
    order.get(left.kind)! - order.get(right.kind)!
    || left.subjectId.localeCompare(right.subjectId)
    || left.fingerprint.localeCompare(right.fingerprint));
}

export class DeterministicIdleOpportunityDetector {
  private state: IdleOpportunityDetectorSnapshot;
  private readonly statePath?: string;

  constructor(options: { statePath?: string; snapshot?: IdleOpportunityDetectorSnapshot } = {}) {
    this.statePath = options.statePath;
    const persisted = options.snapshot
      ?? (this.statePath ? readOwnerOnlyJson(this.statePath, DetectorSnapshotSchema) : null);
    if (persisted && options.snapshot && this.statePath) {
      throw new TypeError("Pass either an idle detector snapshot or statePath, not both.");
    }
    this.state = DetectorSnapshotSchema.parse(persisted ?? { version: 1, fingerprints: [] });
  }

  scan(input: Omit<IdleOpportunityScanInput, "persistedFingerprints"> & { persistedFingerprints?: string[] }) {
    const opportunities = this.preview(input);
    this.remember(opportunities.map((opportunity) => opportunity.fingerprint), input.now);
    return opportunities;
  }

  /**
   * Detect without committing fingerprints. Durable orchestrators use this to
   * publish an idempotent visible lane before suppressing future scans.
   */
  preview(input: Omit<IdleOpportunityScanInput, "persistedFingerprints"> & { persistedFingerprints?: string[] }) {
    const fingerprints = new Set([
      ...this.state.fingerprints.map((entry) => entry.fingerprint),
      ...(input.persistedFingerprints ?? []),
    ]);
    return detectIdleOpportunities({ ...input, persistedFingerprints: [...fingerprints] });
  }

  remember(fingerprints: string[], at: number) {
    const parsed = z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(MAX_IDLE_FINGERPRINTS).parse(fingerprints);
    const seenAt = TimestampSchema.parse(at);
    const existing = new Set(this.state.fingerprints.map((entry) => entry.fingerprint));
    let changed = false;
    for (const fingerprint of parsed) {
      if (existing.has(fingerprint)) continue;
      this.state.fingerprints.push({ fingerprint, seenAt });
      existing.add(fingerprint);
      changed = true;
    }
    if (!changed) return;
    this.state.fingerprints = this.state.fingerprints.slice(-MAX_IDLE_FINGERPRINTS);
    this.persist();
  }

  snapshot(): IdleOpportunityDetectorSnapshot {
    return structuredClone(DetectorSnapshotSchema.parse(this.state));
  }

  private persist() {
    this.state = DetectorSnapshotSchema.parse(this.state);
    if (this.statePath) writeOwnerOnlyJson(this.statePath, this.state);
  }
}

function pushOpportunity(
  output: IdleOpportunity[],
  seen: Set<string>,
  value: Omit<IdleOpportunity, "fingerprint">,
) {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([value.kind, value.goalId, value.subjectId, value.observedAt]))
    .digest("hex");
  if (seen.has(fingerprint)) return;
  seen.add(fingerprint);
  output.push(IdleOpportunitySchema.parse({ ...value, fingerprint }));
}
