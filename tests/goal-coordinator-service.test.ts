import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunResult } from "../src/contracts/run";
import { DirectedMailbox } from "../src/runtime/directed-mailbox";
import { FleetProfileStore } from "../src/runtime/fleet-profile-store";
import { GoalCoordinatorService } from "../src/runtime/goal-coordinator-service";
import { GoalStore } from "../src/runtime/goal-store";
import { HeadlessError } from "../src/runtime/headless-error";
import { ensureProjectStateDirectories, getProjectStatePaths } from "../src/runtime/project-state";
import { schedulingWindow, setTestTimeout } from "./support/timing";

setTestTimeout(2_000);

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("adaptive durable goal coordinator", () => {
  test("a disposed coordinator stops running further turns", async () => {
    // CHARACTERISATION, not a bug fix. I predicted from source that an
    // executePipeline already in flight would carry on past dispose() — the
    // chain is not cancellable and the entry guard is before the first await —
    // and that this was the origin of the `Unknown goal: …` background leakage
    // in docs/internal/hosted-linux-relay-follow-up.md.
    //
    // That prediction was WRONG, and this test is what disproved it: it passes
    // against unmodified code, because dispose() calls delegations.dispose()
    // and the worker turns never launch. The leak comes from somewhere else.
    //
    // Kept because the property is worth holding: no turn may run for a
    // disposed coordinator. It pins current correct behaviour rather than
    // proving a fix, and it is deliberately labelled that way so nobody later
    // reads it as evidence that the goal-ownership leak was addressed.
    const fixture = createFixture();
    const turns: string[] = [];
    let releasePlanning: (() => void) | undefined;
    const service = new GoalCoordinatorService({
      ...fixture,
      now: () => 1_000,
      id: () => "id-1",
      availability: () => healthy(),
      cancelJob: () => {},
      diagnostic: () => {},
      executeTurn: ({ role }) => {
        turns.push(role);
        return {
          jobId: `job-${turns.length}`,
          sessionId: `session-${turns.length}`,
          artifactIds: [],
          completion: role === "planning"
            // Held open so dispose() lands mid-pipeline, which is the state
            // under test. Anything settling before dispose proves nothing.
            ? new Promise((resolve) => {
              releasePlanning = () => resolve(result(
                plan([{ id: "inspect", task: "Inspect the current behavior and report concrete evidence." }]),
                "succeeded",
                "job-1",
                null,
              ));
            })
            : Promise.resolve(result("worker output", "succeeded", `job-${turns.length}`, null)),
        };
      },
    });

    service.start({ principal: "coordinator", objective: "teardown probe", fleetProfileId: fixture.profileId });
    await Bun.sleep(20);
    expect(turns, "the planning turn should be in flight before dispose").toEqual(["planning"]);

    service.dispose();
    releasePlanning?.();
    await Bun.sleep(150);

    expect(turns, "no turn may run after dispose").toEqual(["planning"]);
  });

  test("selects a leader, delivers actual output to a reviewer, revises, gates, and persists", async () => {
    const fixture = createFixture();
    const prompts: Array<{ agent: string; role: string; prompt: string; timeoutMs: number }> = [];
    let job = 0;
    let id = 0;
    const service = new GoalCoordinatorService({
      ...fixture,
      now: () => 1_000,
      id: () => `id-${++id}`,
      availability: () => healthy(),
      cancelJob: () => {},
      executeTurn: ({ agent, role, prompt, timeoutMs }) => {
        prompts.push({ agent: agent.id, role, prompt, timeoutMs });
        const jobId = `job-${++job}`;
        const candidateId = /Your second line must be exactly "EVIDENCE: ([^"]+)"\./.exec(prompt)?.[1];
        const output = role === "planning"
          ? plan([{ id: "inspect", task: "Inspect the current behavior and report concrete evidence." }])
          : role === "worker" ? "worker inspected the implementation and found a missing regression test"
            : role === "candidate" ? "candidate-v1"
              : role === "revision" ? "candidate-v2"
                : prompt.includes("candidate-v2")
                  ? `VERDICT: APPROVE\nEVIDENCE: ${candidateId}\nThe candidate-v2 diff adds the missing regression test and is ready.`
                  : `VERDICT: REQUEST_CHANGES\nEVIDENCE: ${candidateId}\nThe candidate-v1 diff omits a regression test.`;
        const candidateDiff = role === "candidate"
          ? runDiff("diff-v1")
          : role === "revision" ? runDiff("diff-v2") : null;
        return {
          jobId,
          sessionId: `session-${job}`,
          artifactIds: [`evidence-${job}`],
          completion: Promise.resolve(result(output, "succeeded", jobId, candidateDiff)),
        };
      },
    });

    const started = service.start({ principal: "owner", objective: "Produce a verified result." });
    expect(started.leaderDecision.leaderId).toBe("leader");
    await service.wait(started.record.goal.id);

    const record = service.status(started.record.goal.id, "owner");
    expect(record.goal.state).toBe("succeeded");
    expect(record.turns.map((turn) => turn.agentId)).toEqual(["leader", "reviewer", "leader", "reviewer", "leader", "reviewer"]);
    expect(prompts.map((entry) => entry.role)).toEqual(["planning", "worker", "candidate", "review", "revision", "review"]);
    expect(prompts.map((entry) => entry.timeoutMs)).toEqual([180_000, 180_000, 900_000, 180_000, 900_000, 180_000]);
    expect(record.turns.map((turn) => turn.artifactIds)).toEqual([
      ["job-1", "evidence-1"],
      ["job-2", "evidence-2"],
      ["job-3", "evidence-3"],
      ["job-4", "evidence-4"],
      ["job-5", "evidence-5"],
      ["job-6", "evidence-6"],
    ]);
    expect(prompts[0]?.prompt).toContain("HEADLESS_PLAN_V1");
    expect(prompts[2]?.prompt).toContain("worker inspected the implementation");
    expect(prompts[2]?.prompt).toContain("job-2");
    expect(prompts[3]?.prompt).toContain("candidate-v1");
    expect(prompts[3]?.prompt).toContain("diff-v1");
    expect(prompts[3]?.prompt).toContain("EVIDENCE: job-3");
    expect(prompts[4]?.prompt).toContain("omits a regression test");
    expect(prompts[4]?.prompt).toContain("diff-v1");
    expect(prompts[5]?.prompt).toContain("candidate-v2");
    expect(prompts[5]?.prompt).toContain("diff-v2");
    expect(record.reviews).toMatchObject([
      {
        candidateId: "job-3",
        verdict: "request_changes",
        citedTurnIds: [record.turns[2]!.id],
        citedArtifactIds: ["job-3", "evidence-3"],
      },
      {
        candidateId: "job-5",
        verdict: "approve",
        citedTurnIds: [record.turns[4]!.id],
        citedArtifactIds: ["job-5", "evidence-5"],
      },
    ]);
    expect(record.votes).toMatchObject([
      {
        candidateId: "job-3",
        voterId: "reviewer",
        choice: "revise",
        citedTurnIds: [record.turns[2]!.id],
        citedArtifactIds: ["job-3", "evidence-3"],
      },
      {
        candidateId: "job-5",
        voterId: "reviewer",
        choice: "approve",
        citedTurnIds: [record.turns[4]!.id],
        citedArtifactIds: ["job-5", "evidence-5"],
      },
    ]);
    expect(record.candidateDecisions[0]).toMatchObject({
      candidateId: "job-5",
      decision: "integrate",
      reviewIds: [record.reviews[1]!.id],
      voteIds: [record.votes[1]!.id],
      citedTurnIds: record.turns.map((turn) => turn.id),
      citedArtifactIds: ["job-1", "evidence-1", "job-2", "evidence-2", "job-3", "evidence-3", "job-4", "evidence-4", "job-5", "evidence-5", "job-6", "evidence-6"],
      gates: [
        { id: "turn-completion", status: "passed" },
        { id: "candidate-grounding", status: "passed", evidenceArtifactIds: ["job-5", "evidence-5"] },
        { id: "review-evidence", status: "passed" },
        { id: "vote-evidence", status: "passed", evidenceArtifactIds: ["job-5", "evidence-5"] },
      ],
    });
    expect(record.result).toMatchObject({
      status: "succeeded",
      summary: "candidate-v2",
      artifactIds: ["job-5", "evidence-5"],
    });
    expect(record.delegations).toHaveLength(6);
    expect(record.delegations.every((delegation) => delegation.state === "succeeded")).toBe(true);
    expect(record.turns.every((turn) => turn.delegationId !== null)).toBe(true);
    for (const delegation of record.delegations) {
      expect(record.turns.some((turn) => turn.id === delegation.resultTurnId && turn.delegationId === delegation.id)).toBe(true);
    }

    const reopened = new GoalStore(fixture.paths).get(record.goal.id);
    expect(reopened?.result?.summary).toBe("candidate-v2");
    const messages = fixture.mailbox.snapshot().messages.filter((message) => message.collaborationId === record.goal.id);
    expect(messages.some((message) =>
      message.kind === "completion"
      && message.content === "candidate-v2"
      && message.artifactIds.includes("job-5"))).toBe(true);
    expect(messages.filter((message) => message.kind === "review").every((message) => message.artifactIds.length >= 2)).toBe(true);
    expect(messages.filter((message) => message.kind === "vote").map((message) => message.artifactIds)).toEqual([
      ["job-3", "evidence-3"],
      ["job-5", "evidence-5"],
    ]);
  });

  test("fails read-only planning over to a distinct backend without changing the sticky write leader", async () => {
    const fixture = createFixture({
      maxAttemptsPerDelegation: 2,
      agents: [
        { id: "leader", backend: "codex", name: "Leader", priority: 10 },
        { id: "planner", backend: "opencode", name: "Planner", priority: 5 },
      ],
    });
    const calls: Array<{ agent: string; role: string }> = [];
    let job = 0;
    const service = new GoalCoordinatorService({
      ...fixture,
      now: () => 1_000,
      availability: () => healthy(),
      cancelJob: () => {},
      executeTurn: ({ agent, role, prompt }) => {
        calls.push({ agent: agent.id, role });
        const jobId = `planning-failover-${++job}`;
        const candidateId = /Your second line must be exactly "EVIDENCE: ([^"]+)"\./.exec(prompt)?.[1];
        const output = role === "planning"
          ? agent.id === "leader" ? "provider disconnected" : plan([{ id: "inspect", task: "Inspect the fixture." }])
          : role === "worker" ? "The dependency-only fixture needs a complete app implementation."
            : role === "candidate" ? "verified candidate"
              : `VERDICT: APPROVE\nEVIDENCE: ${candidateId}\nThe candidate is grounded in the worker evidence and ready.`;
        const status = role === "planning" && agent.id === "leader" ? "failed" : "succeeded";
        return { jobId, sessionId: `session-${job}`, completion: Promise.resolve(result(output, status, jobId)) };
      },
    });

    const started = service.start({
      principal: "owner",
      objective: "Recover planning without replacing the leader.",
      synthesizer: { kind: "agent", agentId: "leader" },
      mode: "write",
    });
    await service.wait(started.goal.id);

    const record = service.status(started.goal.id, "owner");
    expect(record.goal.synthesizerAgentId).toBe("leader");
    expect(calls.filter((call) => call.role === "planning")).toEqual([
      { agent: "leader", role: "planning" },
      { agent: "leader", role: "planning" },
      { agent: "planner", role: "planning" },
    ]);
    expect(record.turns.some((turn) => turn.agentId === "planner" && turn.state === "succeeded")).toBe(true);
  });

  test("recovers candidate execution on a write-ready backend without changing the sticky leader or allowing self-review", async () => {
    const fixture = createFixture({
      maxAttemptsPerDelegation: 2,
      agents: [
        { id: "leader", backend: "codex", name: "Leader", priority: 10 },
        { id: "recovery", backend: "opencode", name: "Recovery", priority: 5 },
        { id: "reviewer", backend: "grok-build", name: "Reviewer", priority: 1 },
      ],
    });
    const calls: Array<{ agent: string; role: string }> = [];
    let job = 0;
    const service = new GoalCoordinatorService({
      ...fixture,
      now: () => 1_000,
      availability: () => healthy(),
      cancelJob: () => {},
      integrateCandidate: async ({ candidateId }) => ({
        merged: true,
        resultingCommit: "b".repeat(40),
        summary: "Recovered candidate integrated.",
        artifactIds: [candidateId],
      }),
      executeTurn: ({ agent, role, prompt }) => {
        calls.push({ agent: agent.id, role });
        const jobId = `candidate-failover-${++job}`;
        const candidateId = /Your second line must be exactly "EVIDENCE: ([^"]+)"\./.exec(prompt)?.[1];
        if (role === "planning") {
          return { jobId, sessionId: `session-${job}`, completion: Promise.resolve(result(plan([{ id: "inspect", task: "Inspect the fixture." }]), "succeeded", jobId)) };
        }
        if (role === "candidate" && agent.id === "leader") {
          return {
            jobId,
            sessionId: `session-${job}`,
            completion: Promise.resolve({
              ...result("provider disconnected", "failed", jobId),
              error: { code: "PROCESS_ERROR" as const, message: "provider disconnected", retryable: true },
            }),
          };
        }
        const output = role === "worker"
          ? "Grounded fixture findings."
          : role === "candidate"
            ? "Recovered tested candidate."
            : `VERDICT: APPROVE\nEVIDENCE: ${candidateId}\nIndependent candidate review passed.`;
        return { jobId, sessionId: `session-${job}`, completion: Promise.resolve(result(output, "succeeded", jobId)) };
      },
    });

    const started = service.start({
      principal: "owner",
      objective: "Recover candidate execution without transferring leadership.",
      synthesizer: { kind: "agent", agentId: "leader" },
      mode: "write",
    });
    await service.wait(started.goal.id);

    const record = service.status(started.goal.id, "owner");
    expect(record.goal.state).toBe("succeeded");
    expect(record.goal.synthesizerAgentId).toBe("leader");
    expect(calls.filter((call) => call.role === "candidate")).toEqual([
      { agent: "leader", role: "candidate" },
      { agent: "leader", role: "candidate" },
      { agent: "recovery", role: "candidate" },
    ]);
    expect(calls.filter((call) => call.role === "review")).toEqual([{ agent: "reviewer", role: "review" }]);
    expect(record.result?.artifactIds).toContain(record.candidateDecisions[0]?.candidateId ?? "");
    expect(fixture.mailbox.snapshot().messages).toContainEqual(expect.objectContaining({
      kind: "lifecycle",
      content: expect.stringContaining("Candidate execution recovered on recovery (opencode); leader remains the sticky goal leader"),
    }));
  });

  test("blocks prompt echoes instead of treating them as attributable review consensus", async () => {
    const fixture = createFixture();
    let job = 0;
    const service = new GoalCoordinatorService({
      ...fixture,
      now: () => 1_000,
      availability: () => healthy(),
      cancelJob: () => {},
      executeTurn: ({ agent, prompt }) => {
        const jobId = `job-echo-${++job}`;
        return {
          jobId,
          sessionId: `session-echo-${job}`,
          completion: Promise.resolve(result(agent.id === "leader" ? "real candidate" : prompt, "succeeded", jobId)),
        };
      },
    });

    const started = service.start({ principal: "owner", objective: "Do not accept echoed review text." });
    await service.wait(started.goal.id);

    const record = service.status(started.goal.id, "owner");
    expect(record.goal.state).toBe("failed");
    expect(record.reviews).toEqual([]);
    expect(record.votes).toEqual([]);
    expect(record.candidateDecisions).toMatchObject([{
      candidateId: "job-echo-3",
      decision: "blocked",
      reviewIds: [],
      citedArtifactIds: ["job-echo-1", "job-echo-2", "job-echo-3", "job-echo-4"],
      gates: [
        { id: "turn-completion", status: "passed" },
        { id: "candidate-grounding", status: "passed" },
        { id: "review-evidence", status: "failed" },
        { id: "vote-evidence", status: "failed" },
      ],
    }]);
    expect(record.result?.summary).toContain("merely echoed supplied candidate material");
  });

  test("bounds and redacts candidate output and diff evidence before reviewer delivery", async () => {
    const fixture = createFixture();
    let reviewerPrompt = "";
    let job = 0;
    const service = new GoalCoordinatorService({
      ...fixture,
      now: () => 1_000,
      availability: () => healthy(),
      cancelJob: () => {},
      executeTurn: ({ role, prompt }) => {
        const jobId = `job-bounded-${++job}`;
        if (role === "planning") {
          return {
            jobId,
            sessionId: `session-bounded-${job}`,
            completion: Promise.resolve(result(plan([{ id: "inspect", task: "Inspect bounded evidence." }]), "succeeded", jobId)),
          };
        }
        if (role === "worker") {
          return {
            jobId,
            sessionId: `session-bounded-${job}`,
            completion: Promise.resolve(result("bounded worker evidence", "succeeded", jobId)),
          };
        }
        if (role === "review") {
          reviewerPrompt = prompt;
          const candidateId = /Your second line must be exactly "EVIDENCE: ([^"]+)"\./.exec(prompt)?.[1];
          return {
            jobId,
            sessionId: `session-bounded-${job}`,
            completion: Promise.resolve(result(
              `VERDICT: APPROVE\nEVIDENCE: ${candidateId}\nThe bounded diff has concrete verification evidence.`,
              "succeeded",
              jobId,
            )),
          };
        }
        return {
          jobId,
          sessionId: `session-bounded-${job}`,
          completion: Promise.resolve(result(
            `candidate sk-abcdefghijklmnop ${"é".repeat(40_000)}`,
            "succeeded",
            jobId,
            { ...runDiff("bounded"), patch: `PATCH-START\n${"🔥".repeat(50_000)}` },
          )),
        };
      },
    });

    const started = service.start({ principal: "owner", objective: "Review bounded evidence." });
    await service.wait(started.goal.id);

    const record = service.status(started.goal.id, "owner");
    expect(record.goal.state).toBe("succeeded");
    expect(reviewerPrompt.length).toBeLessThanOrEqual(32_768);
    expect(Buffer.byteLength(reviewerPrompt)).toBeLessThanOrEqual(65_536);
    expect(reviewerPrompt).toContain("read-only workspace therefore remains unchanged by design");
    expect(reviewerPrompt).toContain("missing raw terminal logs alone is not a reason to reject");
    expect(reviewerPrompt).toContain("PATCH-START");
    expect(reviewerPrompt).toContain("[REDACTED_OPENAI_KEY]");
    expect(reviewerPrompt).not.toContain("sk-abcdefghijklmnop");
  });

  test("keeps automatic leadership sticky, supports explicit transfer, and enforces ownership", async () => {
    const fixture = createFixture();
    let resolveTurn!: (result: RunResult) => void;
    const completion = new Promise<RunResult>((resolve) => { resolveTurn = resolve; });
    const cancelled: string[] = [];
    const service = new GoalCoordinatorService({
      ...fixture,
      now: () => 1_000,
      availability: () => healthy(),
      cancelJob: (jobId) => cancelled.push(jobId),
      executeTurn: () => ({ jobId: "job-active", sessionId: "session-active", completion }),
    });
    const started = service.start({ principal: "owner", objective: "Wait for cancellation." });
    await Promise.resolve();
    await Promise.resolve();
    expect(() => service.status(started.record.goal.id, "intruder")).toThrow("another authenticated principal");
    expect(service.transferSynthesizer(started.record.goal.id, "reviewer", "admin").synthesizerAgentId).toBe("reviewer");
    expect(service.cancel(started.record.goal.id, "owner").state).toBe("cancelled");
    expect(cancelled).toEqual(["job-active"]);
    resolveTurn(result("late", "cancelled"));
    await service.wait(started.record.goal.id);
    expect(service.result(started.record.goal.id, "owner")?.status).toBe("cancelled");
  });

  test("fails closed when no authenticated fleet leader is available", () => {
    const fixture = createFixture();
    const service = new GoalCoordinatorService({
      ...fixture,
      availability: () => ({ ...healthy(), authenticated: false, health: "unhealthy" }),
      cancelJob: () => {},
      executeTurn: () => { throw new Error("unreachable"); },
    });
    expect(() => service.start({ principal: "owner", objective: "Cannot run." })).toThrow("No authenticated, healthy fleet agent");
    expect(fixture.goals.list()).toEqual([]);
  });

  test("excludes the foreground lead backend from automatic synthesis but permits an explicit same-provider worker", () => {
    const fixture = createFixture({ agents: [
      { id: "foreground-provider-worker", backend: "codex", name: "Codex worker", priority: 20 },
      { id: "automatic-worker", backend: "opencode", name: "OpenCode worker", priority: 10 },
    ] });
    const completion = new Promise<never>(() => {});
    const service = new GoalCoordinatorService({
      ...fixture,
      activeLeadBackend: () => "codex",
      availability: () => healthy(),
      cancelJob: () => {},
      executeTurn: () => ({ jobId: "routing", sessionId: "routing", completion }),
    });

    expect(service.start({ principal: "owner", objective: "Route automatically." }).goal.synthesizerAgentId).toBe("automatic-worker");
    expect(service.start({
      principal: "owner",
      objective: "Use an explicit separate worker.",
      synthesizer: { kind: "agent", agentId: "foreground-provider-worker" },
    }).goal.synthesizerAgentId).toBe("foreground-provider-worker");
    service.dispose();
  });

  test("defaults goal security controls from its fleet and persists explicit per-goal overrides", () => {
    const fixture = createFixture();
    const completion = new Promise<never>(() => {});
    const service = new GoalCoordinatorService({
      ...fixture,
      now: () => 1_000,
      availability: () => healthy(),
      cancelJob: () => {},
      executeTurn: () => ({ jobId: "job-security", sessionId: "session-security", completion }),
    });

    const defaults = service.start({
      principal: "owner",
      objective: "Use fleet defaults.",
      synthesizer: { kind: "automatic" },
    });
    expect(defaults.goal).toMatchObject({ authMode: "broker", approvalPolicy: "ask" });

    const overridden = service.start({
      principal: "owner",
      objective: "Use explicit controls.",
      synthesizer: { kind: "automatic" },
      authMode: "broker",
      approvalPolicy: "bypass",
    });
    expect(overridden.goal).toMatchObject({ authMode: "broker", approvalPolicy: "bypass" });
    expect(new GoalStore(fixture.paths).status(overridden.goal.id)).toMatchObject({
      authMode: "broker",
      approvalPolicy: "bypass",
    });
    service.dispose();
  });

  test("turns provider retry-after evidence into bounded durable delegation attempts", async () => {
    const fixture = createFixture();
    let now = 1_000;
    let attempt = 0;
    const service = new GoalCoordinatorService({
      ...fixture,
      now: () => now,
      availability: (agent) => agent.id === "leader"
        ? healthy()
        : { ...healthy(), authenticated: false, health: "unhealthy" },
      cancelJob: () => {},
      executeTurn: () => {
        attempt += 1;
        return {
          jobId: `job-${attempt}`,
          sessionId: `session-${attempt}`,
          completion: Promise.resolve(attempt === 1
            ? rateLimitedResult(5, "HTTP 429 retry-after=5")
            : result("recovered candidate")),
        };
      },
    });

    const started = service.start({ principal: "owner", objective: "Recover after provider throttling." });
    await settleUntil(() => service.delegations.scheduler.list("queued")[0]?.attempt === 1);
    expect(attempt).toBe(1);
    now = 1_005;
    service.pumpDelegations();
    await service.wait(started.goal.id);

    const record = service.status(started.goal.id, "owner");
    expect(record.result).toMatchObject({ status: "succeeded", summary: "recovered candidate" });
    expect(record.turns.map((turn) => [turn.state, turn.nativeSessionId])).toEqual([
      ["failed", "session-1"],
      ["succeeded", "session-2"],
      ["succeeded", "session-3"],
      ["succeeded", "session-4"],
    ]);
    expect(new Set(record.turns.map((turn) => turn.delegationId)).size).toBe(3);
    expect(record.delegations[0]).toMatchObject({
      state: "succeeded",
      attempt: 2,
      maxAttempts: 2,
      resultTurnId: record.turns[1]!.id,
      nativeSessionId: "session-2",
      rateLimit: { retryAfterMs: 5, evidence: "HTTP 429 retry-after=5" },
    });
  });

  test("uses per-goal security controls for agent availability and worker turns", async () => {
    const fixture = createFixture();
    const observed: Array<{ authMode: string; approvalPolicy: string }> = [];
    const service = new GoalCoordinatorService({
      ...fixture,
      now: () => 1_000,
      availability: (agent, security) => {
        observed.push(security);
        return agent.id === "leader"
          ? healthy()
          : { ...healthy(), authenticated: false, health: "unhealthy" };
      },
      cancelJob: () => {},
      executeTurn: ({ goal }) => {
        expect(goal).toMatchObject({ authMode: "broker", approvalPolicy: "auto" });
        return { jobId: "broker-job", sessionId: "broker-session", completion: Promise.resolve(result("broker result")) };
      },
    });

    const started = service.start({
      principal: "owner",
      objective: "Run this goal through the broker.",
      authMode: "broker",
      approvalPolicy: "auto",
    });
    await service.wait(started.goal.id);

    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every((security) => security.authMode === "broker" && security.approvalPolicy === "auto")).toBe(true);
    const turns = service.status(started.goal.id, "owner").turns;
    expect(turns).toHaveLength(3);
    expect(turns.every((turn) => turn.authMode === "broker"
      && turn.nativeSessionId === "broker-session"
      && turn.state === "succeeded")).toBe(true);
  });

  test("integrates a grounded write candidate only after collaboration gates pass", async () => {
    const fixture = createFixture();
    const integrations: Array<{ candidateId: string; decisionId: string }> = [];
    const service = new GoalCoordinatorService({
      ...fixture,
      now: () => 1_000,
      availability: (agent) => agent.id === "leader"
        ? healthy()
        : { ...healthy(), authenticated: false, health: "unhealthy" },
      cancelJob: () => {},
      executeTurn: () => ({
        jobId: "write-candidate-job",
        sessionId: "write-candidate-session",
        completion: Promise.resolve(result("contained candidate", "succeeded", "write-candidate-job", runDiff("write"))),
      }),
      integrateCandidate: async ({ candidateId, decisionId }) => {
        integrations.push({ candidateId, decisionId });
        return {
          merged: true,
          resultingCommit: "a".repeat(40),
          summary: "Candidate integrated after all gates.",
          artifactIds: [candidateId],
        };
      },
    });

    const started = service.start({ principal: "owner", objective: "Apply a contained change.", mode: "write" });
    await service.wait(started.goal.id);

    const record = service.status(started.goal.id, "owner");
    expect(record.goal).toMatchObject({ mode: "write", state: "succeeded" });
    expect(integrations).toEqual([{
      candidateId: "write-candidate-job",
      decisionId: record.candidateDecisions[0]!.id,
    }]);
    expect(record.transitions.map((transition) => transition.to)).toContain("integrating");
    expect(record.result).toMatchObject({
      status: "succeeded",
      artifactIds: ["write-candidate-job"],
      candidateDecisionId: record.candidateDecisions[0]!.id,
    });
  });

  test("pauses ask-mode write integration and resumes the same candidate after approval", async () => {
    const fixture = createFixture();
    let integrationAttempts = 0;
    const service = new GoalCoordinatorService({
      ...fixture,
      now: () => 1_000,
      availability: (agent) => agent.id === "leader"
        ? healthy()
        : { ...healthy(), authenticated: false, health: "unhealthy" },
      cancelJob: () => {},
      executeTurn: () => ({
        jobId: "ask-candidate-job",
        sessionId: "ask-candidate-session",
        completion: Promise.resolve(result("ask candidate", "succeeded", "ask-candidate-job", runDiff("ask"))),
      }),
      integrateCandidate: async ({ candidateId }) => {
        integrationAttempts += 1;
        if (integrationAttempts === 1) throw new HeadlessError("APPROVAL_REQUIRED", `Approve candidate ${candidateId}.`);
        return {
          merged: true,
          resultingCommit: "b".repeat(40),
          summary: "Approved candidate integrated.",
          artifactIds: [candidateId],
        };
      },
    });

    const started = service.start({
      principal: "owner",
      objective: "Wait for merge approval.",
      mode: "write",
      approvalPolicy: "ask",
    });
    await service.wait(started.goal.id);
    expect(service.status(started.goal.id, "owner").goal.state).toBe("waiting_approval");
    expect(service.result(started.goal.id, "owner")).toBeNull();

    expect(service.handleApprovalResolution({
      id: "approval-ask-candidate",
      collaborationId: "ask-candidate-job",
      requestedBy: "owner",
      assignedTo: "owner",
      kind: "merge",
      status: "approved",
      summary: "Approve merge.",
      details: { candidateId: "ask-candidate-job" },
      artifactIds: ["ask-candidate-job"],
      resolvedBy: "owner",
      resolution: "Reviewed and approved.",
      expiresAt: 2_000,
      resolvedAt: 1_100,
      createdAt: 1_000,
      updatedAt: 1_100,
    })).toBe(started.goal.id);
    await service.wait(started.goal.id);

    expect(integrationAttempts).toBe(2);
    expect(service.status(started.goal.id, "owner").goal.state).toBe("succeeded");
    expect(service.status(started.goal.id, "owner").turns).toHaveLength(3);
  });

  test("runs a strict plan through bounded concurrent workers and delivers every actual artifact to synthesis", async () => {
    const fixture = createFixture({
      maxActiveWorkers: 2,
      agents: [
        { id: "leader", backend: "codex", name: "Leader", priority: 10 },
        { id: "worker-a", backend: "claude-code", name: "Worker A" },
        { id: "worker-b", backend: "opencode", name: "Worker B" },
        { id: "worker-c", backend: "grok", name: "Worker C" },
      ],
    });
    const pending = new Map<string, { resolve: (value: RunResult) => void; completion: Promise<RunResult> }>();
    const roles: Array<{ agentId: string; role: string }> = [];
    let activeWorkers = 0;
    let maxActiveWorkers = 0;
    let synthesisPromptSeen = "";
    let job = 0;
    const service = new GoalCoordinatorService({
      ...fixture,
      now: () => 1_000,
      availability: () => healthy(),
      cancelJob: () => {},
      executeTurn: ({ agent, role, prompt }) => {
        roles.push({ agentId: agent.id, role });
        const jobId = `parallel-job-${++job}`;
        if (role === "planning") {
          return {
            jobId,
            sessionId: "parallel-plan-session",
            artifactIds: ["parallel-plan-artifact"],
            completion: Promise.resolve(result(plan([
              { id: "inspect-a", task: "Inspect subsystem A." },
              { id: "inspect-b", task: "Inspect subsystem B." },
              { id: "inspect-c", task: "Inspect subsystem C." },
            ]), "succeeded", jobId)),
          };
        }
        if (role === "worker") {
          activeWorkers += 1;
          maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);
          let resolve!: (value: RunResult) => void;
          const completion = new Promise<RunResult>((done) => { resolve = done; }).finally(() => { activeWorkers -= 1; });
          pending.set(agent.id, { resolve, completion });
          return { jobId, sessionId: `parallel-${agent.id}`, artifactIds: [`artifact-${agent.id}`], completion };
        }
        if (role === "candidate") {
          synthesisPromptSeen = prompt;
          return { jobId, sessionId: "parallel-leader", completion: Promise.resolve(result("parallel synthesis", "succeeded", jobId, runDiff("synthesis"))) };
        }
        const candidateId = /Your second line must be exactly "EVIDENCE: ([^"]+)"\./.exec(prompt)?.[1];
        return {
          jobId,
          sessionId: `parallel-review-${agent.id}`,
          completion: Promise.resolve(result(
            `VERDICT: APPROVE\nEVIDENCE: ${candidateId}\nReviewer ${agent.id} independently verified both worker artifacts.`,
            "succeeded",
            jobId,
          )),
        };
      },
    });

    const started = service.start({ principal: "owner", objective: "Combine independent evidence." });
    await settleUntil(() => pending.size === 2);
    expect([...pending.keys()].sort()).toEqual(["worker-a", "worker-b"]);
    expect(maxActiveWorkers).toBe(2);
    pending.get("worker-a")!.resolve(result(
      "worker-a-output\nQUESTION: Should synthesis reconcile subsystem A?",
      "succeeded",
      "parallel-job-2",
      runDiff("worker-a-diff"),
    ));
    pending.get("worker-b")!.resolve(result("worker-b-output", "succeeded", "parallel-job-3", runDiff("worker-b-diff")));
    await service.wait(started.goal.id);

    const record = service.status(started.goal.id, "owner");
    expect(record.goal.state).toBe("succeeded");
    expect(roles.filter((entry) => entry.role === "worker")).toHaveLength(2);
    expect(roles.some((entry) => entry.agentId === "worker-c" && entry.role === "worker")).toBe(false);
    expect(record.turns[0]).toMatchObject({ agentId: "leader", artifactIds: ["parallel-job-1", "parallel-plan-artifact"] });
    expect(record.turns[0]!.output).toStartWith("HEADLESS_PLAN_V1\n");
    expect(synthesisPromptSeen).toContain("worker-a-output");
    expect(synthesisPromptSeen).toContain("worker-b-output");
    expect(synthesisPromptSeen).toContain("worker-a-diff patch");
    expect(synthesisPromptSeen).toContain("worker-b-diff patch");
    expect(synthesisPromptSeen).toContain("artifact-worker-a");
    expect(synthesisPromptSeen).toContain("artifact-worker-b");
    const messages = fixture.mailbox.snapshot().messages.filter((message) => message.collaborationId === started.goal.id);
    expect(messages.filter((message) => message.kind === "delegation")).toHaveLength(3);
    expect(messages).toContainEqual(expect.objectContaining({
      senderId: "worker-a",
      recipientId: "leader",
      kind: "question",
      artifactIds: ["parallel-job-2", "artifact-worker-a"],
    }));
    expect(messages.filter((message) => message.kind === "report" && message.recipientId === "leader").length).toBeGreaterThanOrEqual(2);
  });

  test("keeps leadership sticky while healthy and fails over before synthesis when health changes", async () => {
    const fixture = createFixture({
      agents: [
        { id: "leader", backend: "codex", name: "Leader", priority: 10 },
        { id: "backup", backend: "claude-code", name: "Backup", priority: 5 },
        { id: "reviewer", backend: "opencode", name: "Reviewer" },
      ],
    });
    let leaderHealthy = true;
    const roles: Array<{ agentId: string; role: string }> = [];
    let job = 0;
    const service = new GoalCoordinatorService({
      ...fixture,
      now: () => 1_000,
      availability: (agent) => agent.id === "leader" && !leaderHealthy
        ? { ...healthy(), health: "unhealthy" }
        : healthy(),
      cancelJob: () => {},
      executeTurn: ({ agent, role, prompt }) => {
        roles.push({ agentId: agent.id, role });
        const jobId = `failover-job-${++job}`;
        if (role === "planning") {
          return { jobId, sessionId: "leader-session", completion: Promise.resolve(result(plan([{ id: "inspect", task: "Inspect before failover." }]), "succeeded", jobId)) };
        }
        if (role === "worker") {
          return {
            jobId,
            sessionId: `${agent.id}-session`,
            completion: Promise.resolve(result("worker evidence before failover", "succeeded", jobId)).then((value) => {
              leaderHealthy = false;
              return value;
            }),
          };
        }
        if (role === "candidate") {
          return { jobId, sessionId: `${agent.id}-session`, completion: Promise.resolve(result("backup synthesis", "succeeded", jobId)) };
        }
        const candidateId = /Your second line must be exactly "EVIDENCE: ([^"]+)"\./.exec(prompt)?.[1];
        return {
          jobId,
          sessionId: `${agent.id}-session`,
          completion: Promise.resolve(result(`VERDICT: APPROVE\nEVIDENCE: ${candidateId}\nFailover candidate retained grounded worker evidence.`, "succeeded", jobId)),
        };
      },
    });

    const started = service.start({ principal: "owner", objective: "Survive leader health loss." });
    await service.wait(started.goal.id);
    const record = service.status(started.goal.id, "owner");
    expect(record.goal).toMatchObject({ state: "succeeded", synthesizerAgentId: "backup" });
    expect(roles[0]).toEqual({ agentId: "leader", role: "planning" });
    expect(roles.find((entry) => entry.role === "candidate")).toEqual({ agentId: "backup", role: "candidate" });
    expect(record.transitions.some((transition) => transition.reason?.includes("Health-based failover"))).toBe(true);
    expect(fixture.mailbox.snapshot().messages).toContainEqual(expect.objectContaining({
      recipientId: "backup",
      kind: "lifecycle",
      content: expect.stringContaining("Sticky leadership transferred"),
    }));
  });

  test("reassigns a prematurely inferred worker delegation to a distinct healthy backend and preserves failure evidence", async () => {
    const fixture = createFixture({
      maxAttemptsPerDelegation: 1,
      agents: [
        { id: "leader", backend: "codex", name: "Leader", priority: 10 },
        { id: "worker-a", backend: "claude-code", name: "Worker A", priority: 5 },
        { id: "worker-b", backend: "opencode", name: "Worker B", priority: 4 },
      ],
    });
    const workerCalls: string[] = [];
    let job = 0;
    const service = new GoalCoordinatorService({
      ...fixture,
      now: () => 1_000,
      availability: () => healthy(),
      cancelJob: () => {},
      executeTurn: ({ agent, role, prompt }) => {
        const jobId = `worker-failover-job-${++job}`;
        if (role === "planning") {
          return { jobId, sessionId: "plan-session", completion: Promise.resolve(result(plan([{ id: "build", task: "Build one verified unit." }]), "succeeded", jobId)) };
        }
        if (role === "worker") {
          workerCalls.push(agent.id);
          const completion = agent.id === "worker-a"
            ? {
                ...result("I'll inspect the fixture before reporting concrete evidence.", "succeeded", jobId),
                diagnostics: {
                  format: "native-session:opencode-session",
                  malformedEvents: 0,
                  ignoredEvents: 0,
                  messages: ["Completion was inferred from stable backend lifecycle evidence."],
                },
              }
            : result(`Recovered worker evidence with concrete file findings and verification. ${"bounded evidence ".repeat(40)}`, "timed_out", jobId);
          return { jobId, sessionId: `${agent.id}-session`, completion: Promise.resolve(completion) };
        }
        if (role === "candidate") {
          return { jobId, sessionId: "candidate-session", completion: Promise.resolve(result("candidate from recovered evidence", "succeeded", jobId)) };
        }
        const candidateId = /Your second line must be exactly "EVIDENCE: ([^"]+)"\./.exec(prompt)?.[1];
        return {
          jobId,
          sessionId: `${agent.id}-review-session`,
          completion: Promise.resolve(result(`VERDICT: APPROVE\nEVIDENCE: ${candidateId}\nRecovered evidence is concrete and completes the planned task.`, "succeeded", jobId)),
        };
      },
    });

    const started = service.start({ principal: "owner", objective: "Survive one worker provider failure." });
    await service.wait(started.goal.id);
    const record = service.status(started.goal.id, "owner");
    expect(record.goal.state).toBe("succeeded");
    expect(workerCalls).toEqual(["worker-a", "worker-b"]);
    expect(record.turns).toContainEqual(expect.objectContaining({
      agentId: "worker-a",
      state: "failed",
      output: expect.stringContaining("planning preamble without concrete findings"),
    }));
    expect(record.turns).toContainEqual(expect.objectContaining({
      agentId: "worker-b",
      state: "succeeded",
      output: expect.stringContaining("preserving the bounded report for synthesis"),
    }));
    expect(fixture.mailbox.snapshot().messages).toContainEqual(expect.objectContaining({
      kind: "lifecycle",
      content: expect.stringContaining("recovered on worker-b (opencode)"),
    }));
  });

  test("cancels every active worker in a concurrent plan", async () => {
    const fixture = createFixture({
      maxActiveWorkers: 2,
      agents: [
        { id: "leader", backend: "codex", name: "Leader", priority: 10 },
        { id: "worker-a", backend: "claude-code", name: "Worker A" },
        { id: "worker-b", backend: "opencode", name: "Worker B" },
      ],
    });
    const pending = new Map<string, { resolve: (value: RunResult) => void; completion: Promise<RunResult> }>();
    const cancelled: string[] = [];
    let job = 0;
    const service = new GoalCoordinatorService({
      ...fixture,
      now: () => 1_000,
      availability: () => healthy(),
      cancelJob: (jobId) => cancelled.push(jobId),
      executeTurn: ({ agent, role }) => {
        const jobId = `cancel-job-${++job}`;
        if (role === "planning") {
          return {
            jobId,
            sessionId: "cancel-plan-session",
            completion: Promise.resolve(result(plan([
              { id: "work-a", task: "Wait in worker A." },
              { id: "work-b", task: "Wait in worker B." },
            ]), "succeeded", jobId)),
          };
        }
        let resolve!: (value: RunResult) => void;
        const completion = new Promise<RunResult>((done) => { resolve = done; });
        pending.set(agent.id, { resolve, completion });
        return { jobId, sessionId: `cancel-${agent.id}`, completion };
      },
    });

    const started = service.start({ principal: "owner", objective: "Cancel bounded concurrent work." });
    await settleUntil(() => pending.size === 2);
    expect(service.cancel(started.goal.id, "owner").state).toBe("cancelled");
    expect(cancelled.sort()).toEqual(["cancel-job-2", "cancel-job-3"]);
    await service.wait(started.goal.id);
    expect(service.result(started.goal.id, "owner")?.status).toBe("cancelled");
    for (const item of pending.values()) item.resolve(result("cancelled", "cancelled"));
    await Promise.resolve();
  });
});

function createFixture(options: {
  maxActiveWorkers?: number;
  maxAttemptsPerDelegation?: number;
  agents?: Array<{ id: string; backend: string; name: string; priority?: number }>;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "headless-goal-service-"));
  const runtime = join("/tmp", `hgs-${process.pid}-${roots.length}`);
  const project = join(root, "project");
  mkdirSync(project);
  roots.push(root);
  roots.push(runtime);
  const paths = ensureProjectStateDirectories(getProjectStatePaths(project, {
    env: { ...process.env, HEADLESS_STATE_HOME: join(root, "state"), HEADLESS_RUNTIME_HOME: runtime },
  }));
  const fleets = new FleetProfileStore(paths, { now: () => 900, id: () => "fleet-main" });
  fleets.create({
    name: "Main",
    maxActiveWorkers: options.maxActiveWorkers,
    maxAttemptsPerDelegation: options.maxAttemptsPerDelegation,
    agents: options.agents ?? [
      { id: "leader", backend: "codex", name: "Leader", priority: 10 },
      { id: "reviewer", backend: "claude-code", name: "Reviewer" },
    ],
  });
  const goals = new GoalStore(paths, { now: () => 1_000 });
  const mailbox = new DirectedMailbox({ statePath: join(paths.projectDir, "directed-mailbox.json") });
  return { paths, fleets, goals, mailbox };
}

function healthy() {
  return {
    authenticated: true,
    health: "healthy" as const,
    rateLimitedUntil: null,
    activeTurns: 0,
    recentFailures: 0,
  };
}

function result(
  output: string,
  status: RunResult["status"] = "succeeded",
  jobId = "job",
  diff: RunResult["diff"] = null,
): RunResult {
  return {
    status,
    error: status === "succeeded" ? null : { code: "CANCELLED", message: "Cancelled.", retryable: false },
    backend: "fake",
    output,
    stderr: "",
    diagnostics: { format: "fake", malformedEvents: 0, ignoredEvents: 0, messages: [] },
    exitCode: status === "succeeded" ? 0 : null,
    signal: status === "cancelled" ? "SIGTERM" : null,
    usage: { input: 1, output: 1, reasoning: 0, cached: 0, providerTotal: 2 },
    cost: { amountUsd: null, source: "unknown", pricingId: null, observedRequests: 0 },
    containment: {
      requirement: "required",
      enforced: true,
      platform: "linux",
      mechanism: "fake",
      probe: "fake",
      isolatedHome: true,
      credentialsIsolated: true,
      network: "native-direct-unrestricted",
      credentialAccess: "backend-native",
      unsafe: false,
    },
    durationMs: 1,
    sessionId: null,
    jobId,
    diff,
    commit: null,
    truncation: { stdout: false, stderr: false, output: false, events: false, artifacts: false, diff: false },
  };
}

function runDiff(label: string): NonNullable<RunResult["diff"]> {
  return {
    patch: `${label} patch`,
    status: `${label} status`,
    files: [`${label}.ts`],
    baseCommit: "base",
    candidateCommit: label,
    resultingCommit: null,
  };
}

function plan(delegations: Array<{ id: string; task: string; capabilities?: string[] }>) {
  return `HEADLESS_PLAN_V1\n${JSON.stringify({
    delegations: delegations.map((delegation) => ({ ...delegation, capabilities: delegation.capabilities ?? [] })),
  })}`;
}

function rateLimitedResult(retryAfterMs: number, evidence: string): RunResult {
  return {
    ...result("", "failed"),
    error: {
      code: "RATE_LIMITED",
      message: "Provider rate limit.",
      retryable: true,
      details: { retryAfterMs, evidence },
    },
  };
}

async function settleUntil(predicate: () => boolean) {
  const deadline = Date.now() + schedulingWindow(2_000);
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("Expected goal coordinator state did not settle.");
}
