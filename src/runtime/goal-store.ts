import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  CandidateDecisionSchema,
  DelegationSchema,
  GoalSchema,
  GoalStateSchema,
  ReviewSchema,
  TurnSchema,
  VoteSchema,
  type CandidateDecision,
  type Delegation,
  type Goal,
  type Review,
  type Turn,
  type Vote,
} from "../contracts/collaboration";
import { IdentifierSchema, PrincipalIdSchema, ProjectIdSchema, TimestampSchema } from "../contracts/common";
import { readOwnerOnlyJson, writeOwnerOnlyJson } from "./owner-json";
import { ensureOwnerOnlyDirectory, ensureProjectStateDirectories, type ProjectStatePaths } from "./project-state";

const TerminalGoalStateSchema = z.enum(["succeeded", "failed", "cancelled", "timed_out"]);

export const GoalResultSchema = z.object({
  goalId: IdentifierSchema,
  status: TerminalGoalStateSchema,
  summary: z.string().max(32_768),
  artifactIds: z.array(IdentifierSchema).max(256).default([]),
  candidateDecisionId: IdentifierSchema.nullable().default(null),
  completedBy: PrincipalIdSchema,
  completedAt: TimestampSchema,
}).strict().superRefine((result, context) => {
  if (new Set(result.artifactIds).size !== result.artifactIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Goal result artifact ids must be unique.", path: ["artifactIds"] });
  }
});

export const GoalTransitionSchema = z.object({
  from: GoalStateSchema.nullable(),
  to: GoalStateSchema,
  actor: PrincipalIdSchema,
  reason: z.string().max(16_384).nullable(),
  at: TimestampSchema,
}).strict();

export const GoalRecordSchema = z.object({
  version: z.literal(1),
  goal: GoalSchema,
  turns: z.array(TurnSchema).max(4_096),
  delegations: z.array(DelegationSchema).max(4_096),
  reviews: z.array(ReviewSchema).max(2_048),
  votes: z.array(VoteSchema).max(2_048),
  candidateDecisions: z.array(CandidateDecisionSchema).max(2_048),
  transitions: z.array(GoalTransitionSchema).min(1).max(2_048),
  result: GoalResultSchema.nullable(),
}).strict().superRefine((record, context) => {
  for (const [values, path, label] of [
    [record.turns.map((entry) => entry.id), ["turns"], "turn"],
    [record.delegations.map((entry) => entry.id), ["delegations"], "delegation"],
    [record.reviews.map((entry) => entry.id), ["reviews"], "review"],
    [record.votes.map((entry) => entry.id), ["votes"], "vote"],
    [record.candidateDecisions.map((entry) => entry.id), ["candidateDecisions"], "candidate decision"],
  ] as const) {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Goal ${label} ids must be unique.`, path: [...path] });
    }
  }
  if (record.turns.some((entry) => entry.goalId !== record.goal.id)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Every turn must belong to its goal.", path: ["turns"] });
  }
  if (record.delegations.some((entry) => entry.goalId !== record.goal.id)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Every delegation must belong to its goal.", path: ["delegations"] });
  }
  if (record.reviews.some((entry) => entry.collaborationId !== record.goal.id)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Every review must belong to its goal collaboration.", path: ["reviews"] });
  }
  if (record.votes.some((entry) => entry.collaborationId !== record.goal.id)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Every vote must belong to its goal collaboration.", path: ["votes"] });
  }
  if (record.candidateDecisions.some((entry) => entry.collaborationId !== record.goal.id)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Every candidate decision must belong to its goal collaboration.", path: ["candidateDecisions"] });
  }
  const terminal = TerminalGoalStateSchema.safeParse(record.goal.state).success;
  if (terminal !== (record.result !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Terminal goal state and durable result must be recorded together.", path: ["result"] });
  }
  if (record.result && (record.result.goalId !== record.goal.id || record.result.status !== record.goal.state)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Goal result identity and status must match the goal.", path: ["result"] });
  }
  const latestTransition = record.transitions.at(-1);
  if (!latestTransition || latestTransition.to !== record.goal.state) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Latest transition must match current goal state.", path: ["transitions"] });
  }
});

export type GoalResult = z.infer<typeof GoalResultSchema>;
export type GoalTransition = z.infer<typeof GoalTransitionSchema>;
export type GoalRecord = z.infer<typeof GoalRecordSchema>;
export type GoalCreateInput = Omit<
  z.input<typeof GoalSchema>,
  "id" | "projectId" | "state" | "synthesizer" | "synthesizerAgentId" | "createdAt" | "updatedAt"
> & {
  id?: string;
  synthesizer?: z.input<typeof GoalSchema>["synthesizer"];
  synthesizerAgentId?: string | null;
};

export class GoalStore {
  readonly projectId: string;
  readonly directory: string;
  private readonly now: () => number;
  private readonly id: () => string;

  constructor(
    private readonly paths: ProjectStatePaths,
    options: { now?: () => number; id?: () => string } = {},
  ) {
    ensureProjectStateDirectories(paths);
    this.projectId = ProjectIdSchema.parse(paths.projectId);
    this.directory = ensureOwnerOnlyDirectory(paths.goalsDir);
    this.now = options.now ?? Date.now;
    this.id = options.id ?? (() => `goal_${randomUUID()}`);
  }

  create(input: GoalCreateInput): GoalRecord {
    const at = this.now();
    const synthesizer = input.synthesizer ?? { kind: "automatic" as const };
    const goal = GoalSchema.parse({
      ...input,
      id: input.id ?? this.id(),
      projectId: this.projectId,
      state: "queued",
      synthesizerAgentId: input.synthesizerAgentId
        ?? (synthesizer.kind === "agent" ? synthesizer.agentId : null),
      synthesizer,
      createdAt: at,
      updatedAt: at,
    });
    if (existsSync(this.path(goal.id))) throw new Error(`Goal already exists: ${goal.id}`);
    const record = GoalRecordSchema.parse({
      version: 1,
      goal,
      turns: [],
      delegations: [],
      reviews: [],
      votes: [],
      candidateDecisions: [],
      transitions: [{ from: null, to: "queued", actor: goal.principal, reason: "Goal created.", at }],
      result: null,
    });
    this.write(record);
    return cloneRecord(record);
  }

  get(id: string) {
    const path = this.path(id);
    if (!existsSync(path)) return null;
    const record = readOwnerOnlyJson(path, GoalRecordSchema);
    if (!record) return null;
    if (record.goal.projectId !== this.projectId) {
      throw new Error(`Goal project mismatch: expected ${this.projectId}, got ${record.goal.projectId}`);
    }
    if (record.goal.id !== IdentifierSchema.parse(id)) throw new Error("Goal file identity mismatch.");
    return cloneRecord(record);
  }

  list(filters: { state?: Goal["state"]; principal?: string } = {}) {
    const principal = filters.principal === undefined ? undefined : PrincipalIdSchema.parse(filters.principal);
    return this.listRecords()
      .map((record) => record.goal)
      .filter((goal) => filters.state === undefined || goal.state === filters.state)
      .filter((goal) => principal === undefined || goal.principal === principal)
      .map(cloneGoal);
  }

  listRecords() {
    return readdirSync(this.directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.get(name.slice(0, -5)))
      .filter((record): record is GoalRecord => record !== null)
      .sort((left, right) => left.goal.createdAt - right.goal.createdAt || left.goal.id.localeCompare(right.goal.id));
  }

  status(id: string) {
    return cloneGoal(this.require(id).goal);
  }

  result(id: string) {
    const result = this.require(id).result;
    return result ? structuredClone(GoalResultSchema.parse(result)) : null;
  }

  transition(id: string, state: Goal["state"], actor: string, reason: string | null = null) {
    const record = this.require(id);
    const nextState = GoalStateSchema.parse(state);
    const principal = PrincipalIdSchema.parse(actor);
    if (record.goal.state === nextState) return cloneGoal(record.goal);
    if (TerminalGoalStateSchema.safeParse(nextState).success) {
      throw new Error("Terminal goal transitions require setResult or cancel.");
    }
    if (!canTransition(record.goal.state, nextState)) {
      throw new Error(`Invalid goal transition: ${record.goal.state} -> ${nextState}`);
    }
    this.applyTransition(record, nextState, principal, reason);
    this.write(record);
    return cloneGoal(record.goal);
  }

  setResult(
    id: string,
    actor: string,
    input: {
      status: GoalResult["status"];
      summary: string;
      artifactIds?: string[];
      candidateDecisionId?: string | null;
    },
  ) {
    const record = this.require(id);
    if (record.result) throw new Error(`Goal already has a terminal result: ${id}`);
    const principal = PrincipalIdSchema.parse(actor);
    const status = TerminalGoalStateSchema.parse(input.status);
    if (!canTransition(record.goal.state, status)) {
      throw new Error(`Invalid goal transition: ${record.goal.state} -> ${status}`);
    }
    const at = this.now();
    const result = GoalResultSchema.parse({
      goalId: record.goal.id,
      status,
      summary: input.summary,
      artifactIds: input.artifactIds ?? [],
      candidateDecisionId: input.candidateDecisionId ?? null,
      completedBy: principal,
      completedAt: at,
    });
    record.result = result;
    record.goal.state = status;
    record.goal.updatedAt = at;
    record.transitions.push({ from: record.transitions.at(-1)!.to, to: status, actor: principal, reason: input.summary, at });
    this.write(record);
    return structuredClone(result);
  }

  cancel(id: string, actor: string, reason = "Cancelled by request.") {
    const record = this.require(id);
    if (record.goal.state === "cancelled") return cloneGoal(record.goal);
    if (TerminalGoalStateSchema.safeParse(record.goal.state).success) {
      throw new Error(`Cannot cancel terminal goal ${id} in state ${record.goal.state}.`);
    }
    this.setResult(id, actor, { status: "cancelled", summary: reason });
    return this.status(id);
  }

  transferSynthesizer(id: string, agentId: string, actor: string, reason = "Task synthesis transferred.") {
    const record = this.require(id);
    if (TerminalGoalStateSchema.safeParse(record.goal.state).success) {
      throw new Error(`Cannot transfer task synthesis for terminal goal ${id}.`);
    }
    const nextLeader = IdentifierSchema.parse(agentId);
    const principal = PrincipalIdSchema.parse(actor);
    if (record.goal.synthesizerAgentId === nextLeader) return cloneGoal(record.goal);
    record.goal.synthesizerAgentId = nextLeader;
    if (record.goal.synthesizer.kind === "agent") {
      record.goal.synthesizer = { kind: "agent", agentId: nextLeader };
    }
    record.goal.updatedAt = this.now();
    record.transitions.push(GoalTransitionSchema.parse({
      from: record.goal.state,
      to: record.goal.state,
      actor: principal,
      reason,
      at: record.goal.updatedAt,
    }));
    this.write(record);
    return cloneGoal(record.goal);
  }

  putTurn(goalId: string, value: Turn) {
    return this.putMutable(goalId, "turns", TurnSchema.parse(value), assertTurnIdentity);
  }

  addTurn(goalId: string, value: Turn) {
    return this.putTurn(goalId, value);
  }

  putDelegation(goalId: string, value: Delegation) {
    return this.putMutable(goalId, "delegations", DelegationSchema.parse(value), assertDelegationIdentity);
  }

  addDelegation(goalId: string, value: Delegation) {
    return this.putDelegation(goalId, value);
  }

  addReview(goalId: string, value: Review) {
    const review = ReviewSchema.parse(value);
    const record = this.requireRelationship(goalId, review.collaborationId, "review");
    this.assertTurnReferences(record, review.citedTurnIds);
    return this.appendImmutable(record, "reviews", review, ReviewSchema);
  }

  addVote(goalId: string, value: Vote) {
    const vote = VoteSchema.parse(value);
    const record = this.requireRelationship(goalId, vote.collaborationId, "vote");
    this.assertTurnReferences(record, vote.citedTurnIds);
    return this.appendImmutable(record, "votes", vote, VoteSchema);
  }

  addCandidateDecision(goalId: string, value: CandidateDecision) {
    const decision = CandidateDecisionSchema.parse(value);
    const record = this.requireRelationship(goalId, decision.collaborationId, "candidate decision");
    this.assertTurnReferences(record, decision.citedTurnIds);
    for (const reviewId of decision.reviewIds) {
      if (!record.reviews.some((review) => review.id === reviewId)) throw new Error(`Unknown review citation: ${reviewId}`);
    }
    for (const voteId of decision.voteIds) {
      if (!record.votes.some((vote) => vote.id === voteId)) throw new Error(`Unknown vote citation: ${voteId}`);
    }
    return this.appendImmutable(record, "candidateDecisions", decision, CandidateDecisionSchema);
  }

  private putMutable<K extends "turns" | "delegations">(
    goalId: string,
    field: K,
    value: GoalRecord[K][number],
    assertIdentity: (current: GoalRecord[K][number], next: GoalRecord[K][number]) => void,
  ) {
    const relationshipId = "goalId" in value ? value.goalId : "";
    const record = this.requireRelationship(goalId, relationshipId, field.slice(0, -1));
    const entries = record[field] as Array<GoalRecord[K][number]>;
    const index = entries.findIndex((entry) => entry.id === value.id);
    if (index < 0) entries.push(value);
    else {
      assertIdentity(entries[index], value);
      entries[index] = value;
    }
    record.goal.updatedAt = this.now();
    this.write(record);
    return structuredClone(value);
  }

  private appendImmutable<K extends "reviews" | "votes" | "candidateDecisions">(
    record: GoalRecord,
    field: K,
    value: GoalRecord[K][number],
    schema: { parse(input: unknown): GoalRecord[K][number] },
  ) {
    const entries = record[field] as Array<GoalRecord[K][number]>;
    const existing = entries.find((entry) => entry.id === value.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(value)) throw new Error(`${field} records are immutable: ${value.id}`);
      return structuredClone(existing);
    }
    entries.push(schema.parse(value));
    record.goal.updatedAt = this.now();
    this.write(record);
    return structuredClone(value);
  }

  private requireRelationship(goalId: string, relationshipId: string, label: string) {
    const record = this.require(goalId);
    if (relationshipId !== record.goal.id) throw new Error(`${label} belongs to a different goal.`);
    return record;
  }

  private assertTurnReferences(record: GoalRecord, turnIds: string[]) {
    for (const turnId of turnIds) {
      if (!record.turns.some((turn) => turn.id === turnId)) throw new Error(`Unknown turn citation: ${turnId}`);
    }
  }

  private applyTransition(record: GoalRecord, state: Goal["state"], actor: string, reason: string | null) {
    const at = this.now();
    const from = record.goal.state;
    record.goal.state = state;
    record.goal.updatedAt = at;
    record.transitions.push(GoalTransitionSchema.parse({ from, to: state, actor, reason, at }));
  }

  private require(id: string) {
    const record = this.get(id);
    if (!record) throw new Error(`Unknown goal: ${id}`);
    return record;
  }

  private write(record: GoalRecord) {
    const parsed = GoalRecordSchema.parse(record);
    if (parsed.goal.projectId !== this.projectId) {
      throw new Error(`Goal project mismatch: expected ${this.projectId}, got ${parsed.goal.projectId}`);
    }
    writeOwnerOnlyJson(this.path(parsed.goal.id), parsed);
  }

  private path(id: string) {
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error("Invalid goal id.");
    return join(this.directory, `${id}.json`);
  }
}

function canTransition(from: Goal["state"], to: Goal["state"]) {
  if (TerminalGoalStateSchema.safeParse(from).success) return false;
  if (TerminalGoalStateSchema.safeParse(to).success) return true;
  const allowed: Record<Exclude<Goal["state"], GoalResult["status"]>, Goal["state"][]> = {
    queued: ["planning", "delegating", "active"],
    planning: ["delegating", "active"],
    delegating: ["active", "critiquing", "gating"],
    active: ["delegating", "critiquing", "gating", "waiting_approval", "integrating"],
    critiquing: ["delegating", "active", "gating"],
    gating: ["active", "waiting_approval", "integrating"],
    waiting_approval: ["active", "gating", "integrating"],
    integrating: ["active", "gating", "waiting_approval"],
  };
  return allowed[from as keyof typeof allowed]?.includes(to) ?? false;
}

function assertTurnIdentity(current: Turn, next: Turn) {
  const terminal = ["succeeded", "failed", "cancelled", "timed_out"].includes(current.state);
  if (
    current.id !== next.id
    || current.goalId !== next.goalId
    || current.delegationId !== next.delegationId
    || current.agentId !== next.agentId
    || current.sequence !== next.sequence
    || current.input !== next.input
    || current.createdAt !== next.createdAt
  ) throw new Error("Turn identity fields are immutable.");
  if (terminal && (current.state !== next.state || current.nativeSessionId !== next.nativeSessionId)) {
    throw new Error("Terminal turns cannot be reopened.");
  }
}

function assertDelegationIdentity(current: Delegation, next: Delegation) {
  const terminal = ["succeeded", "failed", "cancelled", "expired"].includes(current.state);
  if (
    current.id !== next.id
    || current.goalId !== next.goalId
    || current.fromAgentId !== next.fromAgentId
    || current.toAgentId !== next.toAgentId
    || current.task !== next.task
    || current.createdAt !== next.createdAt
  ) throw new Error("Delegation identity fields are immutable.");
  if (terminal && (current.state !== next.state || current.nativeSessionId !== next.nativeSessionId)) {
    throw new Error("Terminal delegations cannot be reopened.");
  }
}

function cloneGoal(goal: Goal) {
  return structuredClone(GoalSchema.parse(goal));
}

function cloneRecord(record: GoalRecord) {
  return structuredClone(GoalRecordSchema.parse(record));
}
