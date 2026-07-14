import { z } from "zod";
import { IdentifierSchema, TimestampSchema } from "../contracts/common";

const CapabilitySchema = z.string().trim().min(1).max(128);

export const LeaderCandidateSchema = z.object({
  agentId: IdentifierSchema,
  enabled: z.boolean().default(true),
  authenticated: z.boolean(),
  health: z.enum(["healthy", "degraded", "unhealthy", "offline"]),
  capabilities: z.array(CapabilitySchema).max(64).default([]),
  rateLimitedUntil: TimestampSchema.nullable(),
  priority: z.number().int().min(-100).max(100).default(0),
  activeTurns: z.number().int().nonnegative().max(1_000),
  maxConcurrentTurns: z.number().int().positive().max(1_000),
  recentFailures: z.number().int().nonnegative().max(1_000),
}).strict().superRefine((candidate, context) => {
  if (new Set(candidate.capabilities).size !== candidate.capabilities.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Leader candidate capabilities must be unique.", path: ["capabilities"] });
  }
});

export const StickyLeaderSelectionInputSchema = z.object({
  now: TimestampSchema,
  currentLeaderId: IdentifierSchema.nullable().default(null),
  requiredCapabilities: z.array(CapabilitySchema).max(64).default([]),
  candidates: z.array(LeaderCandidateSchema).min(1).max(64),
}).strict().superRefine((input, context) => {
  const ids = input.candidates.map((candidate) => candidate.agentId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Leader candidate ids must be unique.", path: ["candidates"] });
  }
  if (new Set(input.requiredCapabilities).size !== input.requiredCapabilities.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Required leader capabilities must be unique.", path: ["requiredCapabilities"] });
  }
});

export const LeaderCandidateScoreSchema = z.object({
  agentId: IdentifierSchema,
  eligible: z.boolean(),
  score: z.number().int(),
  evidence: z.array(z.string().min(1).max(256)).max(32),
}).strict();

export const StickyLeaderDecisionSchema = z.object({
  leaderId: IdentifierSchema.nullable(),
  keptCurrent: z.boolean(),
  reason: z.enum(["sticky", "selected", "failover", "no_eligible_candidate"]),
  scores: z.array(LeaderCandidateScoreSchema).max(64),
}).strict();

export type LeaderCandidate = z.infer<typeof LeaderCandidateSchema>;
export type StickyLeaderSelectionInput = z.infer<typeof StickyLeaderSelectionInputSchema>;
export type LeaderCandidateScore = z.infer<typeof LeaderCandidateScoreSchema>;
export type StickyLeaderDecision = z.infer<typeof StickyLeaderDecisionSchema>;

export function scoreLeaderCandidate(
  candidate: LeaderCandidate,
  options: { now: number; requiredCapabilities?: string[] },
): LeaderCandidateScore {
  const parsedCandidate = LeaderCandidateSchema.parse(candidate);
  const now = TimestampSchema.parse(options.now);
  const requiredCapabilities = z.array(CapabilitySchema).max(64).parse(options.requiredCapabilities ?? []);
  const evidence: string[] = [];
  let score = 0;
  let eligible = true;

  if (parsedCandidate.enabled) {
    score += 100;
    evidence.push("enabled:+100");
  } else {
    score -= 2_000;
    eligible = false;
    evidence.push("disabled:-2000");
  }
  if (parsedCandidate.authenticated) {
    score += 500;
    evidence.push("authenticated:+500");
  } else {
    score -= 2_000;
    eligible = false;
    evidence.push("authentication-unavailable:-2000");
  }

  const healthScores = { healthy: 400, degraded: 100, unhealthy: -1_000, offline: -2_000 } as const;
  score += healthScores[parsedCandidate.health];
  evidence.push(`health-${parsedCandidate.health}:${signed(healthScores[parsedCandidate.health])}`);
  if (parsedCandidate.health === "unhealthy" || parsedCandidate.health === "offline") eligible = false;

  const availableCapabilities = new Set(parsedCandidate.capabilities);
  const missingCapabilities = requiredCapabilities.filter((capability) => !availableCapabilities.has(capability));
  score += (requiredCapabilities.length - missingCapabilities.length) * 75;
  score -= missingCapabilities.length * 500;
  if (requiredCapabilities.length > 0) evidence.push(`capabilities:${requiredCapabilities.length - missingCapabilities.length}/${requiredCapabilities.length}`);
  if (missingCapabilities.length > 0) eligible = false;

  const rateLimitAvailable = parsedCandidate.rateLimitedUntil === null || parsedCandidate.rateLimitedUntil <= now;
  if (rateLimitAvailable) {
    score += 200;
    evidence.push("rate-limit-available:+200");
  } else {
    score -= 1_000;
    eligible = false;
    evidence.push("rate-limited:-1000");
  }

  score += parsedCandidate.priority * 10;
  evidence.push(`priority:${signed(parsedCandidate.priority * 10)}`);
  const loadPenalty = Math.round((parsedCandidate.activeTurns / parsedCandidate.maxConcurrentTurns) * 300);
  score -= loadPenalty;
  evidence.push(`load:-${loadPenalty}`);
  if (parsedCandidate.activeTurns >= parsedCandidate.maxConcurrentTurns) eligible = false;

  const failurePenalty = Math.min(parsedCandidate.recentFailures, 20) * 75;
  score -= failurePenalty;
  evidence.push(`recent-failures:-${failurePenalty}`);

  return LeaderCandidateScoreSchema.parse({ agentId: parsedCandidate.agentId, eligible, score, evidence });
}

export function selectStickyLeader(input: StickyLeaderSelectionInput): StickyLeaderDecision {
  const parsed = StickyLeaderSelectionInputSchema.parse(input);
  const scores = parsed.candidates.map((candidate) => scoreLeaderCandidate(candidate, {
    now: parsed.now,
    requiredCapabilities: parsed.requiredCapabilities,
  })).sort((left, right) => right.score - left.score || left.agentId.localeCompare(right.agentId));
  const current = parsed.currentLeaderId === null
    ? null
    : scores.find((candidate) => candidate.agentId === parsed.currentLeaderId) ?? null;
  if (current?.eligible) {
    return StickyLeaderDecisionSchema.parse({
      leaderId: current.agentId,
      keptCurrent: true,
      reason: "sticky",
      scores,
    });
  }
  const selected = scores.find((candidate) => candidate.eligible) ?? null;
  if (!selected) {
    return StickyLeaderDecisionSchema.parse({
      leaderId: null,
      keptCurrent: false,
      reason: "no_eligible_candidate",
      scores,
    });
  }
  return StickyLeaderDecisionSchema.parse({
    leaderId: selected.agentId,
    keptCurrent: false,
    reason: parsed.currentLeaderId === null ? "selected" : "failover",
    scores,
  });
}

function signed(value: number) {
  return value >= 0 ? `+${value}` : String(value);
}
