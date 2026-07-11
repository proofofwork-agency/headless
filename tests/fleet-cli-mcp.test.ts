import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseApprovalCommand } from "../src/cli/commands/approval";
import { parseCandidateCommand } from "../src/cli/commands/candidate";
import { parseCollaborationCommand } from "../src/cli/commands/collaboration";
import { parseFleetCommand } from "../src/cli/commands/fleet";
import { parseGoalCommand } from "../src/cli/commands/goal";
import { parseProjectCommand } from "../src/cli/commands/project";
import {
  CouncilRunParamsSchema,
  FleetProfileUpsertParamsSchema,
  GoalStartParamsSchema,
  RunSubmitParamsSchema,
  SessionCreateParamsSchema,
  WorkflowRunParamsSchema,
} from "../src/daemon/protocol";
import { __handleCallToolForTest, mcpToolDefinitions } from "../src/mcp/server";

describe("fleet CLI protocol parity", () => {
  test("maps project trust actions without allowing a client project root", () => {
    expect(parseProjectCommand(["project", "trust", "status"])).toEqual({
      method: "project.trust.status",
      params: {},
    });
    expect(parseProjectCommand(["project", "trust", "grant", "--allow-bypass"])).toEqual({
      method: "project.trust.grant",
      params: { nativeLoginAllowed: true, bypassAllowed: true },
    });
    expect(parseProjectCommand(["project", "trust", "grant", "--deny-native-login"])).toEqual({
      method: "project.trust.grant",
      params: { nativeLoginAllowed: false, bypassAllowed: false },
    });
    expect(parseProjectCommand(["project", "trust", "revoke"]).method).toBe("project.trust.revoke");
  });

  test("loads fleet profiles from bounded JSON and applies explicit auth policy overrides", async () => {
    const dir = mkdtempSync(join(tmpdir(), "headless-fleet-cli-"));
    const path = join(dir, "fleet.json");
    writeFileSync(path, JSON.stringify({
      id: "default-fleet",
      name: "Default fleet",
      agents: [{ id: "codex-lead", backend: "codex", name: "Codex" }],
    }));
    const call = await parseFleetCommand([
      "fleet", "profile", "upsert", "--file", path,
      "--auth-mode", "broker", "--approval-policy", "auto", "--no-activate",
    ]);
    expect(call.method).toBe("fleet.profile.upsert");
    expect(call.params).toMatchObject({
      id: "default-fleet",
      authMode: "broker",
      approvalPolicy: "auto",
      activate: false,
    });
    expect(await parseFleetCommand(["fleet", "health", "--profile-id", "default-fleet"])).toEqual({
      method: "fleet.health",
      params: { profileId: "default-fleet" },
    });
    expect(await parseFleetCommand(["fleet", "profile", "get", "--profile-id", "default-fleet"])).toEqual({
      method: "fleet.profile.get",
      params: { profileId: "default-fleet" },
    });
  });

  test("maps durable goal start, detached run, coordinator chat, follow, and lifecycle actions", () => {
    expect(parseGoalCommand([
      "goal", "run", "--fleet-profile-id", "fleet-a", "--coordinator", "agent:codex-lead",
      "--mode", "write", "--auth-mode", "broker", "--approval-policy", "auto",
      "--autonomous", "--detach", "--timeout-ms", "5000", "Ship v0.2",
    ])).toEqual({
      action: "run",
      method: "goal.start",
      params: {
        objective: "Ship v0.2",
        mode: "write",
        fleetProfileId: "fleet-a",
        coordinator: { kind: "agent", agentId: "codex-lead" },
        authMode: "broker",
        approvalPolicy: "auto",
        autonomous: true,
        timeoutMs: 5000,
        detach: true,
      },
      timeoutMs: 5000,
    });
    expect(parseGoalCommand(["goal", "send", "--goal-id", "goal-a", "Please revise."])).toMatchObject({
      method: "goal.send",
      params: { goalId: "goal-a", text: "Please revise." },
    });
    expect(parseGoalCommand(["goal", "follow", "--goal-id", "goal-a", "--timeout-ms", "9000"])).toMatchObject({
      method: "goal.status",
      params: { goalId: "goal-a" },
      timeoutMs: 9000,
    });
    for (const action of ["status", "cancel", "result"] as const) {
      expect(parseGoalCommand(["goal", action, "--goal-id", "goal-a"]).method).toBe(`goal.${action}`);
    }
    expect(parseGoalCommand(["goal", "list"])).toMatchObject({ method: "goal.list", params: {} });
    expect(() => parseGoalCommand(["goal", "start", "--coordinator", "self-appointed", "objective"])).toThrow("Invalid --coordinator");
    expect(() => parseGoalCommand(["goal", "start", "--mode", "uncontained", "objective"])).toThrow("Invalid --mode");
  });

  test("maps collaboration, approvals, and gated candidate actions", () => {
    expect(parseCollaborationCommand([
      "collaboration", "messages", "--goal-id", "goal-a", "--after-sequence", "0", "--limit", "10",
    ])).toEqual({
      method: "collaboration.messages",
      params: { goalId: "goal-a", afterSequence: 0, limit: 10 },
    });
    expect(parseCollaborationCommand([
      "collaboration", "transfer-leader", "--goal-id", "goal-a", "--agent-id", "claude-lead",
    ])).toEqual({
      method: "collaboration.transferLeader",
      params: { goalId: "goal-a", agentId: "claude-lead" },
    });
    expect(parseCollaborationCommand([
      "collaboration", "acknowledge", "--goal-id", "goal-a",
      "--message-id", "message-a", "--message-id", "message-b",
    ])).toEqual({
      method: "collaboration.messages.acknowledge",
      params: { goalId: "goal-a", messageIds: ["message-a", "message-b"], prune: true },
    });
    expect(parseApprovalCommand(["approval", "list", "--goal-id", "goal-a", "--status", "pending"])).toEqual({
      method: "approval.list",
      params: { goalId: "goal-a", status: "pending" },
    });
    expect(parseApprovalCommand([
      "approval", "resolve", "--approval-id", "approval-a", "--decision", "approved", "--resolution", "Gates passed.",
    ])).toEqual({
      method: "approval.resolve",
      params: { approvalId: "approval-a", decision: "approved", resolution: "Gates passed." },
    });
    expect(parseCandidateCommand(["candidate", "integrate", "--candidate-id", "candidate-a"])).toEqual({
      method: "candidate.integrate",
      params: { candidateId: "candidate-a" },
    });
  });
});

describe("fleet MCP protocol parity", () => {
  test("advertises every new route family and auth/approval controls", () => {
    const byName = new Map(mcpToolDefinitions.map((tool) => [tool.name, tool]));
    for (const name of [
      "headless_project_trust",
      "headless_fleet_profile",
      "headless_fleet_health",
      "headless_goal",
      "headless_collaboration",
      "headless_approval",
      "headless_candidate",
    ]) {
      expect(byName.has(name)).toBe(true);
    }
    const runSchema = JSON.stringify(byName.get("headless_run")?.inputSchema);
    const deliberateSchema = JSON.stringify(byName.get("headless_deliberate")?.inputSchema);
    const goalSchema = JSON.stringify(byName.get("headless_goal")?.inputSchema);
    expect(runSchema).toContain("authMode");
    expect(runSchema).toContain("approvalPolicy");
    expect(deliberateSchema).toContain("native-login");
    expect(deliberateSchema).toContain("bypass");
    expect(goalSchema).toContain("authMode");
    expect(goalSchema).toContain("approvalPolicy");
    expect(goalSchema).toContain("mode");
    expect(goalSchema).toContain("read-only");
    expect(goalSchema).toContain("write");
  });

  test("rejects malformed new MCP actions before connecting to a daemon", async () => {
    const response = await __handleCallToolForTest({
      params: { name: "headless_goal", arguments: { action: "send", goalId: "goal-a" } },
    });
    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toContain("headless_goal failed");
  });
});

describe("native defaults and optional model boundaries", () => {
  test("accepts omitted models across runs, sessions, workflows, and fleet agents", () => {
    const run = RunSubmitParamsSchema.parse({ backend: "codex", prompt: "Use the configured model." });
    const session = SessionCreateParamsSchema.parse({ backend: "claude-code" });
    const workflow = WorkflowRunParamsSchema.parse({
      steps: [{ id: "review", backend: "opencode", prompt: "Review with the configured model." }],
    });
    const fleet = FleetProfileUpsertParamsSchema.parse({
      id: "native-defaults",
      name: "Native defaults",
      agents: [{ id: "grok-reviewer", backend: "grok", name: "Grok reviewer" }],
    });

    expect(run).toMatchObject({ authMode: "native-login", approvalPolicy: "ask" });
    expect(run).not.toHaveProperty("model");
    expect(session).toMatchObject({ authMode: "native-login", approvalPolicy: "ask" });
    expect(session).not.toHaveProperty("model");
    expect(workflow).toMatchObject({ authMode: "native-login", steps: [{ model: null }] });
    expect(fleet.agents[0]).not.toHaveProperty("model");
  });

  test("keeps goal security optional for fleet inheritance while council defaults native", () => {
    const goal = GoalStartParamsSchema.parse({ objective: "Inherit the selected fleet security controls." });
    const council = CouncilRunParamsSchema.parse({ question: "Use native configured defaults." });

    expect(goal).not.toHaveProperty("authMode");
    expect(goal).not.toHaveProperty("approvalPolicy");
    expect(council).toMatchObject({ authMode: "native-login", approvalPolicy: "ask" });
  });
});
