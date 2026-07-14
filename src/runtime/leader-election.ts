import { createHash } from "node:crypto";
import { z } from "zod";
import { IdentifierSchema, TimestampSchema } from "../contracts/common";
import {
  LeaderCandidateSchema,
  LeaderCandidateScoreSchema,
  scoreLeaderCandidate,
  type LeaderCandidateScore,
} from "./leader-selector";

const CapabilitySchema = z.string().trim().min(1).max(128);
const EvidenceSchema = z.string().trim().min(1).max(1_024);

export const CouncilLeaderElectionInputSchema = z.object({
  electionId: IdentifierSchema,
  now: TimestampSchema,
  requiredCapabilities: z.array(CapabilitySchema).max(64).default([]),
  candidates: z.array(LeaderCandidateSchema).min(1).max(64),
  participatingVoterIds: z.array(IdentifierSchema).max(64).optional(),
}).strict().superRefine((input, context) => {
  requireUnique(input.candidates.map((candidate) => candidate.agentId), context, ["candidates"], "candidate id");
  requireUnique(input.requiredCapabilities, context, ["requiredCapabilities"], "required capability");
  if (input.participatingVoterIds) {
    requireUnique(input.participatingVoterIds, context, ["participatingVoterIds"], "participating voter id");
  }
});

export const CouncilElectionRankingSchema = z.object({
  candidateId: IdentifierSchema,
  score: z.number().int(),
  evidence: z.array(EvidenceSchema).min(1).max(32),
}).strict();

export const CouncilElectionBallotSchema = z.object({
  id: IdentifierSchema,
  electionId: IdentifierSchema,
  voterId: IdentifierSchema,
  voterEvidence: LeaderCandidateScoreSchema,
  rankings: z.array(CouncilElectionRankingSchema).min(1).max(63),
  rationale: EvidenceSchema,
  createdAt: TimestampSchema,
}).strict().superRefine((ballot, context) => {
  requireUnique(ballot.rankings.map((ranking) => ranking.candidateId), context, ["rankings"], "ranked candidate id");
});

export const CouncilElectionRoundSchema = z.object({
  round: z.number().int().positive().max(64),
  activeCandidateIds: z.array(IdentifierSchema).min(1).max(64),
  voteCounts: z.array(z.object({
    candidateId: IdentifierSchema,
    votes: z.number().int().nonnegative().max(64),
  }).strict()).min(1).max(64),
  continuingBallots: z.number().int().nonnegative().max(64),
  exhaustedBallots: z.number().int().nonnegative().max(64),
  strictMajority: z.number().int().positive().max(64),
  winnerId: IdentifierSchema.nullable(),
  eliminatedCandidateId: IdentifierSchema.nullable(),
  evidence: z.array(EvidenceSchema).min(1).max(16),
}).strict();

export const CouncilLeaderElectionDecisionSchema = z.object({
  electionId: IdentifierSchema,
  status: z.enum([
    "elected",
    "quorum_not_met",
    "no_eligible_candidate",
    "insufficient_council",
    "no_strict_winner",
  ]),
  leaderId: IdentifierSchema.nullable(),
  quorum: z.number().int().positive().max(64),
  turnout: z.number().int().nonnegative().max(64),
  eligibleVoterIds: z.array(IdentifierSchema).max(64),
  candidateScores: z.array(LeaderCandidateScoreSchema).max(64),
  ballots: z.array(CouncilElectionBallotSchema).max(64),
  rounds: z.array(CouncilElectionRoundSchema).max(64),
  evidence: z.array(EvidenceSchema).min(1).max(128),
}).strict().superRefine((decision, context) => {
  if ((decision.status === "elected") !== (decision.leaderId !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Only an elected decision may identify a leader.", path: ["leaderId"] });
  }
});

export type CouncilLeaderElectionInput = z.input<typeof CouncilLeaderElectionInputSchema>;
export type CouncilElectionBallot = z.infer<typeof CouncilElectionBallotSchema>;
export type CouncilElectionRound = z.infer<typeof CouncilElectionRoundSchema>;
export type CouncilLeaderElectionDecision = z.infer<typeof CouncilLeaderElectionDecisionSchema>;

export type LeaderElectionErrorCode =
  | "DUPLICATE_VOTER"
  | "ELECTION_MISMATCH"
  | "INELIGIBLE_VOTER"
  | "INVALID_BALLOT"
  | "SELF_ONLY_BALLOT";

export class LeaderElectionError extends Error {
  constructor(readonly code: LeaderElectionErrorCode, message: string) {
    super(message);
    this.name = "LeaderElectionError";
  }
}

/**
 * Produces a policy ballot, not a model opinion. The voter attribution says which
 * eligible council member participated; every ranking is derived from the same
 * recorded health/capability/priority/load/failure score snapshot.
 */
export function createCouncilLeaderBallot(
  input: CouncilLeaderElectionInput,
  voterId: string,
): CouncilElectionBallot {
  const context = electionContext(input);
  const parsedVoterId = IdentifierSchema.parse(voterId);
  if (!context.allowedVoterIds.has(parsedVoterId)) {
    throw new LeaderElectionError("INELIGIBLE_VOTER", `Agent ${parsedVoterId} is not an eligible participant in this election.`);
  }
  const voterEvidence = context.scoreByAgent.get(parsedVoterId);
  if (!voterEvidence?.eligible) {
    throw new LeaderElectionError("INELIGIBLE_VOTER", `Agent ${parsedVoterId} is not eligible to vote in this election.`);
  }
  const rankings = context.eligibleScores
    .filter((score) => score.agentId !== parsedVoterId)
    .map((score) => ({
      candidateId: score.agentId,
      score: score.score,
      evidence: score.evidence,
    }));
  if (rankings.length === 0) {
    throw new LeaderElectionError("SELF_ONLY_BALLOT", "A council election requires at least one eligible non-self candidate.");
  }
  return CouncilElectionBallotSchema.parse({
    id: ballotId(context.input.electionId, parsedVoterId),
    electionId: context.input.electionId,
    voterId: parsedVoterId,
    voterEvidence,
    rankings,
    rationale: "Deterministic policy ranking: score descending, then agent id ascending; self voting is excluded.",
    createdAt: context.input.now,
  });
}

/**
 * Validates attributable policy ballots and performs a bounded instant-runoff.
 * Tied elimination uses score ascending, then agent id descending. This makes a
 * tie reproducible while the eventual winner must still obtain a strict majority
 * of continuing ballots.
 */
export function tallyCouncilLeaderElection(
  input: CouncilLeaderElectionInput,
  ballots: readonly CouncilElectionBallot[],
): CouncilLeaderElectionDecision {
  const context = electionContext(input);
  const validated = validateBallots(context, ballots);
  return decide(context, validated);
}

/** Generates one canonical ballot per requested eligible participant and tallies it. */
export function runCouncilLeaderElection(input: CouncilLeaderElectionInput): CouncilLeaderElectionDecision {
  const context = electionContext(input);
  if (context.eligibleScores.length < 2) return decide(context, []);
  const voterIds = [...context.allowedVoterIds].sort();
  const ballots = voterIds.map((voterId) => createCouncilLeaderBallot(context.input, voterId));
  return decide(context, ballots);
}

type ElectionContext = ReturnType<typeof electionContext>;

function electionContext(input: CouncilLeaderElectionInput) {
  const parsed = CouncilLeaderElectionInputSchema.parse(input);
  const candidateScores = parsed.candidates
    .map((candidate) => scoreLeaderCandidate(candidate, {
      now: parsed.now,
      requiredCapabilities: parsed.requiredCapabilities,
    }))
    .sort(compareScores);
  const eligibleScores = candidateScores.filter((score) => score.eligible);
  const eligibleIds = new Set(eligibleScores.map((score) => score.agentId));
  const requestedVoters = parsed.participatingVoterIds ?? [...eligibleIds];
  for (const voterId of requestedVoters) {
    if (!eligibleIds.has(voterId)) {
      throw new LeaderElectionError("INELIGIBLE_VOTER", `Agent ${voterId} is not eligible to participate in this election.`);
    }
  }
  return {
    input: parsed,
    candidateScores,
    eligibleScores,
    scoreByAgent: new Map(candidateScores.map((score) => [score.agentId, score])),
    allowedVoterIds: new Set(requestedVoters),
    quorum: Math.floor(eligibleScores.length / 2) + 1,
  };
}

function validateBallots(context: ElectionContext, ballots: readonly CouncilElectionBallot[]) {
  const validated: CouncilElectionBallot[] = [];
  const voterIds = new Set<string>();
  for (const value of ballots) {
    let ballot: CouncilElectionBallot;
    try {
      ballot = CouncilElectionBallotSchema.parse(value);
    } catch (error) {
      throw new LeaderElectionError("INVALID_BALLOT", `Election ballot failed schema validation: ${errorMessage(error)}`);
    }
    if (ballot.electionId !== context.input.electionId) {
      throw new LeaderElectionError("ELECTION_MISMATCH", `Ballot ${ballot.id} belongs to a different election.`);
    }
    if (voterIds.has(ballot.voterId)) {
      throw new LeaderElectionError("DUPLICATE_VOTER", `Agent ${ballot.voterId} submitted more than one ballot.`);
    }
    if (!context.allowedVoterIds.has(ballot.voterId) || !context.scoreByAgent.get(ballot.voterId)?.eligible) {
      throw new LeaderElectionError("INELIGIBLE_VOTER", `Agent ${ballot.voterId} is not an eligible participant in this election.`);
    }
    if (ballot.rankings.every((ranking) => ranking.candidateId === ballot.voterId)) {
      throw new LeaderElectionError("SELF_ONLY_BALLOT", `Agent ${ballot.voterId} submitted a self-only ballot.`);
    }
    if (ballot.rankings.some((ranking) => ranking.candidateId === ballot.voterId)) {
      throw new LeaderElectionError("INVALID_BALLOT", `Ballot ${ballot.id} includes a self ranking.`);
    }
    const expected = createCouncilLeaderBallot(context.input, ballot.voterId);
    if (JSON.stringify(ballot) !== JSON.stringify(expected)) {
      throw new LeaderElectionError(
        "INVALID_BALLOT",
        `Ballot ${ballot.id} does not match the attributable score snapshot for voter ${ballot.voterId}.`,
      );
    }
    voterIds.add(ballot.voterId);
    validated.push(ballot);
  }
  return validated.sort((left, right) => left.voterId.localeCompare(right.voterId));
}

function decide(context: ElectionContext, ballots: CouncilElectionBallot[]) {
  const base = {
    electionId: context.input.electionId,
    leaderId: null,
    quorum: context.quorum,
    turnout: ballots.length,
    eligibleVoterIds: context.eligibleScores.map((score) => score.agentId).sort(),
    candidateScores: context.candidateScores,
    ballots,
    rounds: [] as CouncilElectionRound[],
  };
  if (context.eligibleScores.length === 0) {
    return CouncilLeaderElectionDecisionSchema.parse({
      ...base,
      status: "no_eligible_candidate",
      evidence: ["No candidate passed authentication, health, capability, rate-limit, and capacity eligibility checks."],
    });
  }
  if (context.eligibleScores.length === 1) {
    return CouncilLeaderElectionDecisionSchema.parse({
      ...base,
      status: "insufficient_council",
      evidence: ["Only one eligible agent is available; an attributable non-self council ballot cannot be formed."],
    });
  }
  if (ballots.length < context.quorum) {
    return CouncilLeaderElectionDecisionSchema.parse({
      ...base,
      status: "quorum_not_met",
      evidence: [
        `Election turnout ${ballots.length}/${context.eligibleScores.length} did not meet strict-majority quorum ${context.quorum}.`,
      ],
    });
  }

  const activeCandidateIds = new Set(context.eligibleScores.map((score) => score.agentId));
  const rounds: CouncilElectionRound[] = [];
  while (activeCandidateIds.size > 0 && rounds.length < context.eligibleScores.length) {
    const counts = new Map([...activeCandidateIds].map((candidateId) => [candidateId, 0]));
    let exhaustedBallots = 0;
    for (const ballot of ballots) {
      const choice = ballot.rankings.find((ranking) => activeCandidateIds.has(ranking.candidateId));
      if (!choice) exhaustedBallots++;
      else counts.set(choice.candidateId, counts.get(choice.candidateId)! + 1);
    }
    const continuingBallots = ballots.length - exhaustedBallots;
    const strictMajority = Math.floor(continuingBallots / 2) + 1;
    const voteCounts = [...counts]
      .map(([candidateId, votes]) => ({ candidateId, votes }))
      .sort((left, right) => right.votes - left.votes || left.candidateId.localeCompare(right.candidateId));
    const winner = continuingBallots > 0 && voteCounts[0]!.votes >= strictMajority
      ? voteCounts[0]!.candidateId
      : null;
    if (winner) {
      rounds.push(CouncilElectionRoundSchema.parse({
        round: rounds.length + 1,
        activeCandidateIds: [...activeCandidateIds].sort(),
        voteCounts,
        continuingBallots,
        exhaustedBallots,
        strictMajority,
        winnerId: winner,
        eliminatedCandidateId: null,
        evidence: [`${winner} received ${voteCounts[0]!.votes}/${continuingBallots} continuing ballots; strict majority was ${strictMajority}.`],
      }));
      return CouncilLeaderElectionDecisionSchema.parse({
        ...base,
        status: "elected",
        leaderId: winner,
        rounds,
        evidence: [
          `Strict-majority quorum met with ${ballots.length}/${context.eligibleScores.length} eligible voters.`,
          `${winner} won a bounded deterministic runoff in ${rounds.length} round(s).`,
          "Ballots are policy-derived score evaluations, not model-authored opinions or model consensus.",
        ],
      });
    }

    const minimumVotes = Math.min(...voteCounts.map((entry) => entry.votes));
    const eliminationPool = voteCounts
      .filter((entry) => entry.votes === minimumVotes)
      .sort((left, right) => compareElimination(context, left.candidateId, right.candidateId));
    const eliminated = eliminationPool[0]!.candidateId;
    const score = context.scoreByAgent.get(eliminated)!;
    const tie = eliminationPool.length > 1;
    rounds.push(CouncilElectionRoundSchema.parse({
      round: rounds.length + 1,
      activeCandidateIds: [...activeCandidateIds].sort(),
      voteCounts,
      continuingBallots,
      exhaustedBallots,
      strictMajority,
      winnerId: null,
      eliminatedCandidateId: eliminated,
      evidence: [tie
        ? `Vote tie at ${minimumVotes}; eliminated ${eliminated} by lower policy score (${score.score}), then agent id descending.`
        : `Eliminated ${eliminated} with the fewest first-available votes (${minimumVotes}).`],
    }));
    activeCandidateIds.delete(eliminated);
  }

  return CouncilLeaderElectionDecisionSchema.parse({
    ...base,
    status: "no_strict_winner",
    rounds,
    evidence: ["The bounded runoff exhausted its candidates without a strict majority of continuing ballots."],
  });
}

function compareScores(left: LeaderCandidateScore, right: LeaderCandidateScore) {
  return Number(right.eligible) - Number(left.eligible)
    || right.score - left.score
    || left.agentId.localeCompare(right.agentId);
}

function compareElimination(context: ElectionContext, leftId: string, rightId: string) {
  const left = context.scoreByAgent.get(leftId)!;
  const right = context.scoreByAgent.get(rightId)!;
  return left.score - right.score || right.agentId.localeCompare(left.agentId);
}

function ballotId(electionId: string, voterId: string) {
  const digest = createHash("sha256").update(electionId).update("\0").update(voterId).digest("hex").slice(0, 32);
  return `election_ballot_${digest}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function requireUnique(values: readonly string[], context: z.RefinementCtx, path: string[], label: string) {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate ${label}.`, path });
  }
}
