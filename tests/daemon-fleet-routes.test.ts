import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DirectedMessage, Goal } from "../src/contracts/collaboration";
import { HeadlessDaemonClient } from "../src/daemon/client";
import { HeadlessDaemon } from "../src/daemon/server";
import { registerAdapter, unregisterAdapter, type BackendAdapter } from "../src/backends/registry";
import { GoalStore } from "../src/runtime/goal-store";
import { PersistentSessionStore } from "../src/runtime/persistent-sessions";
import { runGitStrict } from "../src/runtime/git";
import { WorktreeLeaseStore } from "../src/runtime/worktree-leases";
import { CandidateDecisionStore } from "../src/runtime/candidate-decision-store";

const roots: string[] = [];
const daemons: HeadlessDaemon[] = [];
const GOAL_BACKEND = "fixture-goal-coder";

afterEach(async () => {
  unregisterAdapter(GOAL_BACKEND);
  while (daemons.length) await daemons.pop()!.stop();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("daemon fleet and collaboration routes", () => {
  test("persists trusted fleet profiles and a human-coordinated addressed goal without client identity fields", async () => {
    const fixture = createFixture();
    const daemon = await start(fixture);
    const client = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: fixture.token });

    const profiles = await client.call<{ profiles: Array<{ id: string }>; activeProfileId: string }>("fleet.profile.list");
    expect(profiles.profiles.some((profile) => profile.id === "fleet-default")).toBe(true);
    expect(profiles.activeProfileId).toBe("fleet-default");

    const trust = await client.call<{ trusted: boolean; bypassAllowed: boolean }>("project.trust.grant", {
      nativeLoginAllowed: true,
      bypassAllowed: true,
    });
    expect(trust).toMatchObject({ trusted: true, bypassAllowed: true });

    const upserted = await client.call<{ profile: { id: string }; activeProfileId: string }>("fleet.profile.upsert", {
      id: "fleet-human",
      name: "Human control",
      coordinator: { kind: "human" },
      agents: [{ id: "codex-reviewer", backend: "codex", name: "Codex reviewer" }],
      activate: true,
    });
    expect(upserted).toMatchObject({ profile: { id: "fleet-human" }, activeProfileId: "fleet-human" });

    await expect(client.call("goal.start", {
      objective: "spoof",
      principal: "attacker",
      projectRoot: "/tmp/other",
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    const started = await client.call<{ goal: Goal }>("goal.start", {
      objective: "Coordinate this durable goal visibly.",
      fleetProfileId: "fleet-human",
      coordinator: { kind: "human" },
      detach: true,
    });
    expect(started.goal).toMatchObject({ principal: "owner", state: "planning", leaderAgentId: null });
    expect("projectRoot" in started.goal).toBe(false);

    const sent = await client.call<{ goal: Goal; message: DirectedMessage }>("goal.send", {
      goalId: started.goal.id,
      text: "Human coordinator note.",
    });
    expect(sent.message).toMatchObject({
      collaborationId: started.goal.id,
      senderId: "owner",
      recipientId: "owner",
      kind: "chat",
      redacted: true,
    });
    const messages = await client.call<{ messages: DirectedMessage[] }>("collaboration.messages", {
      goalId: started.goal.id,
      afterSequence: 0,
      limit: 10,
    });
    expect(messages.messages.map((message) => message.content)).toEqual(["Human coordinator note."]);
    await client.call("auth.provisionIntegration", { name: "mailbox-reviewer" });
    const foreign = new HeadlessDaemonClient({
      projectRoot: fixture.project,
      state: fixture.state,
      credential: { integration: "mailbox-reviewer" },
    });
    await expect(foreign.call("collaboration.messages.acknowledge", {
      goalId: started.goal.id,
      messageIds: [messages.messages[0]!.id],
    })).rejects.toMatchObject({ code: "POLICY_DENIED" });
    await expect(client.call("collaboration.messages.acknowledge", {
      goalId: started.goal.id,
      messageIds: [messages.messages[0]!.id],
      recipientId: "owner",
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(await client.call("collaboration.messages.acknowledge", {
      goalId: started.goal.id,
      messageIds: [messages.messages[0]!.id],
    })).toEqual({
      goalId: started.goal.id,
      acknowledgedMessageIds: [messages.messages[0]!.id],
      pruned: 1,
    });
    expect((await client.call<{ messages: DirectedMessage[] }>("collaboration.messages", {
      goalId: started.goal.id,
      afterSequence: 0,
      limit: 10,
    })).messages).toEqual([]);
    expect(await client.call<Goal>("goal.status", { goalId: started.goal.id })).toMatchObject({ id: started.goal.id, state: "planning" });

    await daemon.stop();
    daemons.pop();
    const restarted = await start(fixture);
    const recovered = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: fixture.token });
    expect(await recovered.call<Goal>("goal.status", { goalId: started.goal.id })).toMatchObject({ state: "planning" });
    const recoveredMessages = await recovered.call<{ messages: DirectedMessage[] }>("collaboration.messages", {
      goalId: started.goal.id,
      afterSequence: 0,
      limit: 10,
    });
    expect(recoveredMessages.messages).toHaveLength(0);
    expect(statSync(restarted.state.fleetProfilesPath).mode & 0o777).toBe(0o600);
    expect(statSync(restarted.state.projectTrustPath).mode & 0o777).toBe(0o600);
  });

  test("executes an elected broker fleet through leader, real reviewer evidence, revision, and completion gates", async () => {
    const fixture = createFixture();
    const script = join(fixture.project, "goal-coder.sh");
writeFileSync(script, `
case "$1" in
  *"You are the sticky coordinator planning"*)
    printf '%s\n' 'HEADLESS_PLAN_V1' '{"delegations":[{"id":"inspect","task":"Inspect the candidate requirements and report concrete evidence.","capabilities":[]}]}'
    ;;
  *"Execute the assigned independent delegation"*) printf '%s\n' 'worker-evidence-for-synthesis' ;;
  *"Review the actual candidate"*)
    candidate_id=$(printf '%s\n' "$1" | sed -n 's/^Your second line must be exactly "EVIDENCE: \\([^"]*\\)"\\.$/\\1/p')
    if printf '%s\n' "$1" | grep -q 'candidate-v2'; then
      printf '%s\n' 'VERDICT: APPROVE' "EVIDENCE: $candidate_id" 'candidate-v2 includes the requested concrete verification evidence.'
    else
      printf '%s\n' 'VERDICT: REQUEST_CHANGES' "EVIDENCE: $candidate_id" 'candidate-v1 is missing concrete verification evidence.'
    fi
    ;;
  *"Revise candidate"*) printf '%s\n' 'candidate-v2' ;;
  *) printf '%s\n' 'candidate-v1' ;;
esac
`, { mode: 0o700 });
    chmodSync(script, 0o700);
    registerAdapter(goalAdapter(script));
    const daemon = await start(fixture);
    const client = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: fixture.token });
    await client.call("fleet.profile.upsert", {
      id: "fleet-automatic-test",
      name: "Automatic test fleet",
      authMode: "broker",
      approvalPolicy: "auto",
      coordinator: { kind: "election" },
      agents: [
        { id: "leader", backend: GOAL_BACKEND, name: "Leader", authMode: "broker", approvalPolicy: "auto", priority: 10 },
        { id: "reviewer", backend: GOAL_BACKEND, name: "Reviewer", authMode: "broker", approvalPolicy: "auto" },
      ],
      activate: true,
    });
    const started = await client.call<{ goal: Goal }>("goal.start", {
      objective: "Produce and review a deterministic candidate.",
      fleetProfileId: "fleet-automatic-test",
      detach: true,
      timeoutMs: 15_000,
    });

    let goal = started.goal;
    for (let attempt = 0; attempt < 100 && !["succeeded", "failed", "cancelled", "timed_out"].includes(goal.state); attempt += 1) {
      await Bun.sleep(25);
      goal = await client.call<Goal>("goal.status", { goalId: goal.id });
    }
    const result = await client.call<{ status: string; summary: string }>("goal.result", { goalId: goal.id });
    const turns = await client.call<{ turns: Array<{ agentId: string; output: string; nativeSessionId: string; artifactIds: string[] }> }>("collaboration.turns", {
      goalId: goal.id,
      afterSequence: 0,
      limit: 10,
    });
    expect(goal.state, JSON.stringify(new GoalStore(daemon.state).get(goal.id))).toBe("succeeded");
    expect(result).toMatchObject({ status: "succeeded", summary: "candidate-v2" });
    expect(turns.turns.map((turn) => [turn.agentId, turn.output])).toEqual([
      ["leader", expect.stringContaining("HEADLESS_PLAN_V1")],
      ["reviewer", "worker-evidence-for-synthesis"],
      ["leader", "candidate-v1"],
      ["reviewer", expect.stringContaining("VERDICT: REQUEST_CHANGES")],
      ["leader", "candidate-v2"],
      ["reviewer", expect.stringContaining("VERDICT: APPROVE")],
    ]);
    expect(turns.turns[0]!.nativeSessionId).toBe(turns.turns[2]!.nativeSessionId);
    expect(turns.turns[0]!.nativeSessionId).toBe(turns.turns[4]!.nativeSessionId);
    expect(turns.turns[1]!.nativeSessionId).not.toBe(turns.turns[0]!.nativeSessionId);
    expect(turns.turns[1]!.nativeSessionId).toBe(turns.turns[3]!.nativeSessionId);
    expect(turns.turns[1]!.nativeSessionId).toBe(turns.turns[5]!.nativeSessionId);
    expect(turns.turns.every((turn) => turn.artifactIds.length === 1)).toBe(true);
    const goalRecord = new GoalStore(daemon.state).get(goal.id)!;
    expect(goalRecord.candidateDecisions[0]).toMatchObject({
      candidateId: turns.turns[4]!.artifactIds[0],
      decision: "integrate",
      reviewIds: [goalRecord.reviews[1]!.id],
      voteIds: [goalRecord.votes[1]!.id],
    });
    const sessions = new PersistentSessionStore(daemon.state);
    expect(sessions.list()).toHaveLength(2);
    expect(sessions.transcript(turns.turns[0]!.nativeSessionId).map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(sessions.transcript(turns.turns[1]!.nativeSessionId).map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    const scheduler = JSON.parse(readFileSync(daemon.state.delegationSchedulerPath, "utf8")) as {
      delegations: Array<{ nativeSessionId: string | null; state: string }>;
    };
    expect(scheduler.delegations.filter((delegation) => delegation.nativeSessionId === turns.turns[0]!.nativeSessionId))
      .toHaveLength(3);
    expect(scheduler.delegations.filter((delegation) => delegation.nativeSessionId === turns.turns[1]!.nativeSessionId))
      .toHaveLength(3);
    expect(scheduler.delegations.filter((delegation) => delegation.state === "active")).toHaveLength(0);
    const electionMessages = (await client.call<{ messages: DirectedMessage[] }>("collaboration.messages", {
      goalId: goal.id,
      afterSequence: 0,
      limit: 100,
    })).messages.filter((message) => message.kind === "vote" && message.content.startsWith("Leader election"));
    expect(electionMessages).toHaveLength(2);
    expect(electionMessages.every((message) => message.artifactIds.some((id) => id.startsWith("election_")))).toBe(true);
  });

  test("preserves, reviews, votes, and integrates a write-goal candidate through the candidate service", async () => {
    const fixture = createFixture();
    initGitProject(fixture.project);
    const script = join(fixture.project, "write-goal-coder.sh");
    writeFileSync(script, `
case "$1" in
  *"You are the sticky coordinator planning"*)
    printf '%s\n' 'HEADLESS_PLAN_V1' '{"delegations":[{"id":"inspect","task":"Inspect the write goal requirements.","capabilities":[]}]}'
    ;;
  *"Execute the assigned independent delegation"*) printf '%s\n' 'write-goal worker evidence' ;;
  *"Review the actual candidate"*)
    candidate_id=$(printf '%s\n' "$1" | sed -n 's/^Your second line must be exactly "EVIDENCE: \\([^"]*\\)"\\.$/\\1/p')
    printf '%s\n' 'VERDICT: APPROVE' "EVIDENCE: $candidate_id" 'The candidate diff contains the requested file and passed the configured check.'
    ;;
  *)
    printf '%s\n' 'fleet write' > fleet-write.txt
    printf '%s\n' 'candidate created with verification evidence'
    ;;
esac
`, { mode: 0o700 });
    chmodSync(script, 0o700);
    expect(runGitStrict(["add", "write-goal-coder.sh"], fixture.project).ok).toBe(true);
    expect(runGitStrict([
      "-c", "user.name=Test", "-c", "user.email=test@example.test",
      "commit", "--no-gpg-sign", "-m", "add write goal fixture",
    ], fixture.project).ok).toBe(true);
    registerAdapter(goalAdapter(script, true));
    const daemon = new HeadlessDaemon({
      projectRoot: fixture.project,
      state: fixture.state,
      token: fixture.token,
      principal: "owner",
      writeGateChecks: [{ name: "write-goal-pass", command: "bun", args: ["-e", "process.exit(0)"] }],
    });
    daemons.push(daemon);
    await daemon.start();
    const client = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: fixture.token });
    await client.call("project.trust.grant", { nativeLoginAllowed: false, bypassAllowed: false });
    await client.call("fleet.profile.upsert", {
      id: "fleet-write-goal",
      name: "Write goal fleet",
      authMode: "broker",
      approvalPolicy: "auto",
      coordinator: { kind: "automatic" },
      agents: [
        { id: "writer", backend: GOAL_BACKEND, name: "Writer", authMode: "broker", approvalPolicy: "auto", priority: 10 },
        { id: "write-reviewer", backend: GOAL_BACKEND, name: "Reviewer", authMode: "broker", approvalPolicy: "auto" },
      ],
      activate: true,
    });
    const started = await client.call<{ goal: Goal }>("goal.start", {
      objective: "Create fleet-write.txt and verify the candidate.",
      fleetProfileId: "fleet-write-goal",
      mode: "write",
      detach: true,
      timeoutMs: 20_000,
    });

    let goal = started.goal;
    for (let attempt = 0; attempt < 300 && !["succeeded", "failed", "cancelled", "timed_out"].includes(goal.state); attempt += 1) {
      await Bun.sleep(25);
      goal = await client.call<Goal>("goal.status", { goalId: goal.id });
    }
    const record = new GoalStore(daemon.state).get(goal.id)!;
    expect(goal.state, JSON.stringify(record)).toBe("succeeded");
    expect(goal.mode).toBe("write");
    expect(readFileSync(join(fixture.project, "fleet-write.txt"), "utf8")).toBe("fleet write\n");
    expect(runGitStrict(["status", "--porcelain=v1", "--untracked-files=all"], fixture.project).stdout.trim()).toBe("");
    const candidateId = record.candidateDecisions[0]!.candidateId;
    expect(record.candidateDecisions[0]).toMatchObject({ decision: "integrate", citedArtifactIds: expect.arrayContaining([candidateId]) });
    expect(record.reviews[0]).toMatchObject({ candidateId, verdict: "approve", citedArtifactIds: expect.arrayContaining([candidateId]) });
    expect(record.votes[0]).toMatchObject({ candidateId, choice: "approve", citedArtifactIds: expect.arrayContaining([candidateId]) });
    expect(record.result).toMatchObject({ status: "succeeded", artifactIds: expect.arrayContaining([candidateId]) });
    expect(new CandidateDecisionStore(daemon.state).get(candidateId)).toMatchObject({ status: "integrated" });
    expect(daemon.jobs.get(candidateId)).toMatchObject({ mode: "write", mergePolicy: "preserve", result: { commit: { merged: false } } });
    expect(daemon.jobs.list().filter((job) => daemon.jobs.request(job.id)?.mode === "write")).toHaveLength(1);
  }, 30_000);

  test("pauses an ask-mode write goal and resumes the same candidate after merge approval", async () => {
    const fixture = createFixture();
    initGitProject(fixture.project);
    const script = join(fixture.project, "ask-goal-coder.sh");
    writeFileSync(script, `
case "$1" in
  *"You are the sticky coordinator planning"*)
    printf '%s\n' 'HEADLESS_PLAN_V1' '{"delegations":[{"id":"inspect","task":"Inspect the ask-mode write requirements.","capabilities":[]}]}'
    ;;
  *"Execute the assigned independent delegation"*) printf '%s\n' 'ask-mode worker evidence' ;;
  *"Review the actual candidate"*)
    candidate_id=$(printf '%s\n' "$1" | sed -n 's/^Your second line must be exactly "EVIDENCE: \\([^"]*\\)"\\.$/\\1/p')
    printf '%s\n' 'VERDICT: APPROVE' "EVIDENCE: $candidate_id" 'The ask-mode candidate has concrete diff and check evidence.'
    ;;
  *)
    printf '%s\n' 'approved fleet write' > ask-fleet-write.txt
    printf '%s\n' 'ask candidate created'
    ;;
esac
`, { mode: 0o700 });
    chmodSync(script, 0o700);
    expect(runGitStrict(["add", "ask-goal-coder.sh"], fixture.project).ok).toBe(true);
    expect(runGitStrict([
      "-c", "user.name=Test", "-c", "user.email=test@example.test",
      "commit", "--no-gpg-sign", "-m", "add ask goal fixture",
    ], fixture.project).ok).toBe(true);
    registerAdapter(goalAdapter(script, true));
    const daemon = new HeadlessDaemon({
      projectRoot: fixture.project,
      state: fixture.state,
      token: fixture.token,
      principal: "owner",
      writeGateChecks: [{ name: "ask-goal-pass", command: "bun", args: ["-e", "process.exit(0)"] }],
    });
    daemons.push(daemon);
    await daemon.start();
    const client = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: fixture.token });
    await client.call("project.trust.grant", { nativeLoginAllowed: false, bypassAllowed: false });
    await client.call("fleet.profile.upsert", {
      id: "fleet-ask-write-goal",
      name: "Ask write goal fleet",
      authMode: "broker",
      approvalPolicy: "ask",
      coordinator: { kind: "automatic" },
      agents: [
        { id: "ask-writer", backend: GOAL_BACKEND, name: "Writer", authMode: "broker", approvalPolicy: "ask", priority: 10 },
        { id: "ask-reviewer", backend: GOAL_BACKEND, name: "Reviewer", authMode: "broker", approvalPolicy: "ask" },
      ],
      activate: true,
    });
    const started = await client.call<{ goal: Goal }>("goal.start", {
      objective: "Create ask-fleet-write.txt after explicit merge approval.",
      fleetProfileId: "fleet-ask-write-goal",
      mode: "write",
      detach: true,
      timeoutMs: 20_000,
    });

    let goal = started.goal;
    let toolApproval: { id: string; kind: string; status: string; collaborationId: string } | undefined;
    for (let attempt = 0; attempt < 300 && !toolApproval && !["failed", "cancelled", "timed_out"].includes(goal.state); attempt += 1) {
      await Bun.sleep(25);
      goal = await client.call<Goal>("goal.status", { goalId: goal.id });
      const pending = await client.call<Array<{ id: string; kind: string; status: string; collaborationId: string }>>("approval.list", { status: "pending" });
      toolApproval = pending.find((candidate) => candidate.kind === "coder_tool");
    }
    expect(toolApproval).toMatchObject({ kind: "coder_tool", status: "pending" });
    expect(existsSync(join(fixture.project, "ask-fleet-write.txt"))).toBe(false);
    await client.call("approval.resolve", {
      approvalId: toolApproval!.id,
      decision: "approved",
      resolution: "Approved the contained candidate synthesis turn.",
    });

    for (let attempt = 0; attempt < 300 && goal.state !== "waiting_approval" && !["failed", "cancelled", "timed_out"].includes(goal.state); attempt += 1) {
      await Bun.sleep(25);
      goal = await client.call<Goal>("goal.status", { goalId: goal.id });
    }
    const waiting = new GoalStore(daemon.state).get(goal.id)!;
    expect(goal.state, JSON.stringify(waiting)).toBe("waiting_approval");
    expect(existsSync(join(fixture.project, "ask-fleet-write.txt"))).toBe(false);
    const approvals = await client.call<Array<{ id: string; kind: string; status: string; collaborationId: string }>>("approval.list", { status: "pending" });
    const approval = approvals.find((candidate) => candidate.kind === "merge");
    expect(approval).toMatchObject({ status: "pending", collaborationId: waiting.candidateDecisions[0]!.candidateId });
    await client.call("approval.resolve", {
      approvalId: approval!.id,
      decision: "approved",
      resolution: "Reviewed the grounded candidate and approved integration.",
    });

    for (let attempt = 0; attempt < 300 && !["succeeded", "failed", "cancelled", "timed_out"].includes(goal.state); attempt += 1) {
      await Bun.sleep(25);
      goal = await client.call<Goal>("goal.status", { goalId: goal.id });
    }
    const completed = new GoalStore(daemon.state).get(goal.id)!;
    expect(goal.state, JSON.stringify(completed)).toBe("succeeded");
    expect(readFileSync(join(fixture.project, "ask-fleet-write.txt"), "utf8")).toBe("approved fleet write\n");
    expect(completed.turns).toHaveLength(4);
    expect(daemon.jobs.list().filter((job) => daemon.jobs.request(job.id)?.mode === "write")).toHaveLength(1);
  }, 30_000);

  test("publishes idle lanes only after quiescence and deduplicates them across daemon restart", async () => {
    const fixture = createFixture();
    const daemon = await start(fixture);
    const client = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: fixture.token });
    await client.call("fleet.profile.upsert", {
      id: "fleet-idle-test",
      name: "Idle scanner test",
      authMode: "broker",
      approvalPolicy: "auto",
      coordinator: { kind: "human" },
      idleAutonomy: "suggest",
      agents: [{ id: "idle-worker", backend: "codex", name: "Idle worker", authMode: "broker", approvalPolicy: "auto" }],
      activate: true,
    });

    const oldAt = Date.now() - 9_000;
    const oldStore = new GoalStore(daemon.state, { now: () => oldAt, id: () => "goal-old-idle" });
    const oldGoal = oldStore.create({
      principal: "owner",
      fleetProfileId: "fleet-idle-test",
      objective: "Surface deterministic idle work.",
      authMode: "broker",
      approvalPolicy: "auto",
      coordinator: { kind: "human" },
      autonomous: true,
      deadlineAt: Date.now() + 60_000,
    }).goal;
    oldStore.transition(oldGoal.id, "planning", "owner");
    oldStore.transition(oldGoal.id, "delegating", "owner");
    oldStore.transition(oldGoal.id, "active", "owner");

    const freshStore = new GoalStore(daemon.state, { id: () => "goal-fresh-idle" });
    const freshGoal = freshStore.create({
      principal: "owner",
      fleetProfileId: "fleet-idle-test",
      objective: "Remain below the quiescence boundary.",
      authMode: "broker",
      approvalPolicy: "auto",
      coordinator: { kind: "human" },
      autonomous: true,
      deadlineAt: Date.now() + 60_000,
    }).goal;
    freshStore.transition(freshGoal.id, "planning", "owner");
    freshStore.transition(freshGoal.id, "delegating", "owner");
    freshStore.transition(freshGoal.id, "active", "owner");

    await client.call("orchestrator.start");
    let oldMessages: DirectedMessage[] = [];
    for (let attempt = 0; attempt < 50 && oldMessages.length === 0; attempt += 1) {
      await Bun.sleep(25);
      oldMessages = (await client.call<{ messages: DirectedMessage[] }>("collaboration.messages", {
        goalId: oldGoal.id,
        afterSequence: 0,
        limit: 10,
      })).messages;
    }
    expect(oldMessages).toHaveLength(1);
    expect(oldMessages[0]).toMatchObject({ kind: "lifecycle", artifactIds: [expect.stringMatching(/^idle_/)] });
    expect((await client.call<{ messages: DirectedMessage[] }>("collaboration.messages", {
      goalId: freshGoal.id,
      afterSequence: 0,
      limit: 10,
    })).messages).toHaveLength(0);
    expect(existsSync(daemon.state.idleOpportunitiesPath)).toBe(true);
    expect(statSync(daemon.state.idleOpportunitiesPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(daemon.state.idleOpportunitiesPath, "utf8")).fingerprints).toHaveLength(1);

    await daemon.stop();
    daemons.pop();
    await start(fixture);
    await Bun.sleep(100);
    const restartedClient = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: fixture.token });
    const restartedMessages = await restartedClient.call<{ messages: DirectedMessage[] }>("collaboration.messages", {
      goalId: oldGoal.id,
      afterSequence: 0,
      limit: 10,
    });
    expect(restartedMessages.messages).toHaveLength(1);
    expect(JSON.parse(readFileSync(daemon.state.idleOpportunitiesPath, "utf8")).fingerprints).toHaveLength(1);
  });

  test("routes a verified idle write through ordinary worktree, gate, finality, and integration controls", async () => {
    const fixture = createFixture();
    initGitProject(fixture.project);
    const script = join(fixture.project, "idle-coder.sh");
    writeFileSync(script, `
case "$1" in
  *"Perform one read-only verification"*) printf '%s\n' 'HEADLESS_IDLE_STATUS: needs-write verified missing file' ;;
  *"Apply the smallest contained write"*) printf '%s\n' 'idle fix' > idle-fixed.txt; printf '%s\n' 'idle candidate fixed' ;;
  *) printf '%s\n' 'unexpected prompt' ;;
esac
`, { mode: 0o700 });
    chmodSync(script, 0o700);
    expect(runGitStrict(["add", "idle-coder.sh"], fixture.project).ok).toBe(true);
    expect(runGitStrict([
      "-c", "user.name=Test", "-c", "user.email=test@example.test",
      "commit", "--no-gpg-sign", "-m", "add idle fixture",
    ], fixture.project).ok).toBe(true);
    registerAdapter(goalAdapter(script, true));
    const daemon = new HeadlessDaemon({
      projectRoot: fixture.project,
      state: fixture.state,
      token: fixture.token,
      principal: "owner",
      writeGateChecks: [{ name: "idle-fixture-pass", command: "bun", args: ["-e", "process.exit(0)"] }],
    });
    daemons.push(daemon);
    await daemon.start();
    const client = new HeadlessDaemonClient({ projectRoot: fixture.project, state: fixture.state, token: fixture.token });
    await client.call("project.trust.grant", { nativeLoginAllowed: false, bypassAllowed: false });
    await client.call("fleet.profile.upsert", {
      id: "fleet-idle-write",
      name: "Idle write fleet",
      authMode: "broker",
      approvalPolicy: "auto",
      coordinator: { kind: "human" },
      idleAutonomy: "write",
      agents: [{ id: "idle-writer", backend: GOAL_BACKEND, name: "Idle writer", authMode: "broker", approvalPolicy: "auto" }],
      activate: true,
    });

    const oldAt = Date.now() - 9_000;
    const goals = new GoalStore(daemon.state, { now: () => oldAt, id: () => "goal-idle-write" });
    const goal = goals.create({
      principal: "owner",
      fleetProfileId: "fleet-idle-write",
      objective: "Repair the verified idle opportunity.",
      authMode: "broker",
      approvalPolicy: "auto",
      coordinator: { kind: "human" },
      autonomous: true,
      deadlineAt: Date.now() + 60_000,
    }).goal;
    goals.transition(goal.id, "planning", "owner");
    goals.transition(goal.id, "delegating", "owner");
    goals.transition(goal.id, "active", "owner");
    goals.addTurn(goal.id, {
      id: "turn-unverified-idle-write",
      goalId: goal.id,
      delegationId: null,
      agentId: "idle-writer",
      nativeSessionId: null,
      authMode: "broker",
      sequence: 1,
      state: "succeeded",
      input: "Prior work",
      output: "Reported complete without verification.",
      artifactIds: ["prior-job"],
      startedAt: oldAt,
      completedAt: oldAt,
      createdAt: oldAt,
      updatedAt: oldAt,
    });

    await client.call("orchestrator.start");
    for (let attempt = 0; attempt < 200 && !existsSync(join(fixture.project, "idle-fixed.txt")); attempt += 1) {
      await Bun.sleep(25);
    }
    expect(
      existsSync(join(fixture.project, "idle-fixed.txt")),
      JSON.stringify(daemon.jobs.list().map((job) => ({ id: job.id, state: job.state, mode: daemon.jobs.request(job.id)?.mode, error: job.result?.error }))),
    ).toBe(true);
    expect(readFileSync(join(fixture.project, "idle-fixed.txt"), "utf8")).toBe("idle fix\n");
    expect(runGitStrict(["status", "--porcelain=v1", "--untracked-files=all"], fixture.project).stdout.trim()).toBe("");
    const leases = new WorktreeLeaseStore(daemon.state.worktreesDir, daemon.state.projectId).list();
    expect(leases).toContainEqual(expect.objectContaining({ kind: "candidate", state: "released", terminalOutcome: "merged_fast_forward" }));
    const writeJob = daemon.jobs.list().find((job) => daemon.jobs.request(job.id)?.mode === "write");
    expect(writeJob).toMatchObject({ state: "succeeded", result: { commit: { merged: true } } });
  });
});

async function start(fixture: ReturnType<typeof createFixture>) {
  const daemon = new HeadlessDaemon({
    projectRoot: fixture.project,
    state: fixture.state,
    token: fixture.token,
    principal: "owner",
  });
  daemons.push(daemon);
  await daemon.start();
  return daemon;
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "headless-daemon-fleet-"));
  const runtime = mkdtempSync("/tmp/hdf-");
  const project = join(root, "project");
  mkdirSync(project);
  roots.push(root, runtime);
  return {
    root,
    project,
    token: "f".repeat(48),
    state: {
      env: { ...process.env, HEADLESS_STATE_HOME: join(root, "state"), HEADLESS_RUNTIME_HOME: runtime },
      homeDir: root,
    },
  };
}

function goalAdapter(script: string, write = false): BackendAdapter {
  return {
    id: GOAL_BACKEND,
    metadata: { id: GOAL_BACKEND, aliases: [], promptDelivery: "argv", timeoutMs: 10_000, maxDepth: null, canRead: true, canWrite: write },
    capabilities: { write, streaming: true, structuredOutput: true, nativeResume: false, cancellation: true, tools: false, effort: false, brokerCompatible: true },
    security: { outerContainmentRequired: true, strictAuth: "credential-free", disablesProjectConfig: true, disablesHooks: true, disablesMcp: true, disablesSkills: true },
    probe: { versionCommand: ["/usr/bin/true"], helpCommand: ["/usr/bin/true"], requiredHelpFragments: [], timeoutMs: 1_000, maxOutputBytes: 1_024 },
    stdinPrompt: false,
    credentialPrefixes: [],
    buildCommand: (options) => ["/bin/sh", script, options.prompt],
    parse: (stdout) => ({
      output: stdout.trim(),
      error: null,
      cost: null,
      tokens: 2,
      usage: { input: 1, output: 1, reasoning: null, cached: null, providerTotal: 2 },
      diagnostics: { format: "fixture", malformedEvents: 0, ignoredEvents: 0, messages: [] },
    }),
  };
}

function initGitProject(project: string) {
  expect(runGitStrict(["init", "-b", "main"], project).ok).toBe(true);
  writeFileSync(join(project, "README.md"), "base\n");
  expect(runGitStrict(["add", "--all"], project).ok).toBe(true);
  expect(runGitStrict([
    "-c", "user.name=Test", "-c", "user.email=test@example.test",
    "commit", "--no-gpg-sign", "-m", "initial",
  ], project).ok).toBe(true);
}
