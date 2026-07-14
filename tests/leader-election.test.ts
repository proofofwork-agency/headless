import { describe, expect, test } from "bun:test";
import {
  LeaderElectionError,
  createCouncilLeaderBallot,
  runCouncilLeaderElection,
  tallyCouncilLeaderElection,
  type CouncilLeaderElectionInput,
} from "../src/runtime/leader-election";

describe("deterministic council leader election", () => {
  test("produces attributable score ballots and elects a strict winner", () => {
    const input = electionInput([
      candidate("agent-a", { priority: 100 }),
      candidate("agent-b", { priority: 20 }),
      candidate("agent-c"),
      candidate("agent-d", { recentFailures: 2 }),
    ]);

    const decision = runCouncilLeaderElection(input);

    expect(decision).toMatchObject({
      status: "elected",
      leaderId: "agent-a",
      quorum: 3,
      turnout: 4,
    });
    expect(decision.ballots.map((ballot) => ballot.voterId)).toEqual([
      "agent-a",
      "agent-b",
      "agent-c",
      "agent-d",
    ]);
    expect(decision.ballots.every((ballot) => ballot.rankings.every((ranking) => ranking.candidateId !== ballot.voterId))).toBe(true);
    expect(decision.ballots[1]!.rankings[0]!.candidateId).toBe("agent-a");
    expect(decision.ballots[1]!.rankings[0]!.evidence).toEqual(expect.arrayContaining([
      "authenticated:+500",
      "health-healthy:+400",
      "capabilities:1/1",
      "rate-limit-available:+200",
      "priority:+1000",
      "load:-0",
      "recent-failures:-0",
    ]));
    expect(decision.rounds[0]).toMatchObject({
      winnerId: "agent-a",
      continuingBallots: 4,
      strictMajority: 3,
    });
    expect(decision.evidence.at(-1)).toContain("not model-authored opinions");
  });

  test("fails closed when strict-majority turnout quorum is absent", () => {
    const decision = runCouncilLeaderElection({
      ...electionInput([
        candidate("agent-a"),
        candidate("agent-b"),
        candidate("agent-c"),
        candidate("agent-d"),
      ]),
      participatingVoterIds: ["agent-a", "agent-b"],
    });

    expect(decision).toMatchObject({
      status: "quorum_not_met",
      leaderId: null,
      quorum: 3,
      turnout: 2,
      rounds: [],
    });
    expect(decision.evidence[0]).toContain("2/4");
  });

  test("uses a deterministic runoff tie-break before requiring a strict winner", () => {
    const input = electionInput([candidate("agent-z"), candidate("agent-a")]);

    const first = runCouncilLeaderElection(input);
    const reordered = runCouncilLeaderElection({ ...input, candidates: [...input.candidates].reverse() });

    expect(first).toEqual(reordered);
    expect(first).toMatchObject({ status: "elected", leaderId: "agent-a", quorum: 2, turnout: 2 });
    expect(first.rounds).toHaveLength(2);
    expect(first.rounds[0]).toMatchObject({
      winnerId: null,
      eliminatedCandidateId: "agent-z",
      voteCounts: [
        { candidateId: "agent-a", votes: 1 },
        { candidateId: "agent-z", votes: 1 },
      ],
    });
    expect(first.rounds[0]!.evidence[0]).toContain("Vote tie");
    expect(first.rounds[1]).toMatchObject({ winnerId: "agent-a", strictMajority: 1 });
  });

  test("rejects self-only, duplicate, ineligible, and score-tampered ballots", () => {
    const input = electionInput([candidate("agent-a"), candidate("agent-b"), candidate("agent-c")]);
    const ballotA = createCouncilLeaderBallot(input, "agent-a");
    const ballotB = createCouncilLeaderBallot(input, "agent-b");
    const selfOnly = {
      ...ballotA,
      rankings: [{ ...ballotA.rankings[0]!, candidateId: "agent-a" }],
    };
    expectElectionError(() => tallyCouncilLeaderElection(input, [selfOnly]), "SELF_ONLY_BALLOT");
    expectElectionError(() => tallyCouncilLeaderElection(input, [ballotA, ballotA]), "DUPLICATE_VOTER");

    const restricted = { ...input, participatingVoterIds: ["agent-a", "agent-c"] };
    expectElectionError(() => tallyCouncilLeaderElection(restricted, [ballotB]), "INELIGIBLE_VOTER");

    const tampered = {
      ...ballotA,
      rankings: ballotA.rankings.map((ranking, index) => index === 0 ? { ...ranking, score: ranking.score + 1 } : ranking),
    };
    expectElectionError(() => tallyCouncilLeaderElection(input, [tampered]), "INVALID_BALLOT");
  });

  test("reports when health or capability eligibility cannot form a real council", () => {
    const none = runCouncilLeaderElection(electionInput([
      candidate("offline", { health: "offline" }),
      candidate("missing-write", { capabilities: ["review"] }),
    ]));
    expect(none).toMatchObject({
      status: "no_eligible_candidate",
      leaderId: null,
      eligibleVoterIds: [],
      ballots: [],
    });

    const one = runCouncilLeaderElection(electionInput([
      candidate("healthy"),
      candidate("busy", { activeTurns: 1 }),
      candidate("rate-limited", { rateLimitedUntil: 11_000 }),
    ]));
    expect(one).toMatchObject({
      status: "insufficient_council",
      leaderId: null,
      eligibleVoterIds: ["healthy"],
      ballots: [],
    });
    expect(one.evidence[0]).toContain("non-self council ballot");
  });
});

function electionInput(candidates: ReturnType<typeof candidate>[]): CouncilLeaderElectionInput {
  return {
    electionId: "election-one",
    now: 10_000,
    requiredCapabilities: ["write"],
    candidates,
  };
}

function candidate(agentId: string, overrides: Partial<{
  enabled: boolean;
  authenticated: boolean;
  health: "healthy" | "degraded" | "unhealthy" | "offline";
  capabilities: string[];
  rateLimitedUntil: number | null;
  priority: number;
  activeTurns: number;
  maxConcurrentTurns: number;
  recentFailures: number;
}> = {}) {
  return {
    agentId,
    enabled: true,
    authenticated: true,
    health: "healthy" as const,
    capabilities: ["write", "review"],
    rateLimitedUntil: null,
    priority: 0,
    activeTurns: 0,
    maxConcurrentTurns: 1,
    recentFailures: 0,
    ...overrides,
  };
}

function expectElectionError(action: () => unknown, code: LeaderElectionError["code"]) {
  try {
    action();
    throw new Error("Expected election to reject the ballot.");
  } catch (error) {
    expect(error).toBeInstanceOf(LeaderElectionError);
    expect((error as LeaderElectionError).code).toBe(code);
  }
}

