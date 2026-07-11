import { type Plugin, type ToolContext, tool } from "@opencode-ai/plugin";
import {
  connectOrStartDaemon,
  getCooperationInstructions,
  MAX_DAEMON_TRANSPORT_TIMEOUT_MS,
  splitList,
  type HeadlessDaemonClient,
  type Job,
} from "@proofofwork-agency/headless";

export const id = "headless";

export const server: Plugin = async () => ({
  tool: {
    headless_run: tool({
      description: "Submit a daemon-owned contained run and return its complete structured result.",
      args: runArgs(),
      async execute(args, context) {
        const client = await daemon(context);
        const submitted = await client.call<Job>("run.submit", {
          backend: args.backend,
          prompt: args.prompt,
          mode: args.mode,
          model: args.model,
          agent: args.agent,
          timeoutMs: args.timeoutMs,
          sessionId: runtimeSessionId(context),
          containment: args.containment,
          authMode: args.authMode,
          approvalPolicy: args.approvalPolicy,
        });
        const waits = runWaitTimeouts(args.timeoutMs ?? 180_000);
        const completed = submitted.result ? submitted : await client.call<Job>("run.wait", { jobId: submitted.id, timeoutMs: waits.server }, waits.transport);
        return result("headless_run", { jobId: completed.id, sessionId: completed.sessionId, result: completed.result });
      },
    }),
    headless_append_note: tool({
      description: "Append a note through the authenticated project daemon.",
      args: { text: tool.schema.string(), handlesHandoffId: tool.schema.string().optional() },
      async execute(args, context) {
        return result("headless_append_note", await call(context, "ledger.note", { ...args, sessionId: runtimeSessionId(context) }));
      },
    }),
    headless_record_artifact: tool({
      description: "Record a structured artifact through the project daemon.",
      args: artifactArgs(),
      async execute(args, context) {
        return result("headless_record_artifact", await call(context, "ledger.artifact", { ...args, evidence: splitList(args.evidence), sessionId: runtimeSessionId(context) }));
      },
    }),
    headless_read_context: tool({
      description: "Read the daemon-maintained verified ledger projection.",
      args: { view: tool.schema.enum(["summary", "recent", "raw"]).optional().default("summary"), limit: tool.schema.number().int().positive().optional() },
      async execute(args, context) {
        return result("headless_read_context", await call(context, "ledger.context", { ...args, sessionId: runtimeSessionId(context) }));
      },
    }),
    headless_task_state: tool({
      description: "List durable daemon tasks and their claim/lease state.",
      args: {
        jobId: tool.schema.string().optional(),
        state: tool.schema.enum(["pending", "claimed", "completed", "failed", "cancelled"]).optional(),
      },
      async execute(args, context) {
        return result("headless_task_state", await call(context, "task.list", args));
      },
    }),
    headless_propose_final: tool({
      description: "Record a finality proposal for later enforced decision.",
      args: {
        summary: tool.schema.string(),
        evidence: tool.schema.string(),
        remainingRisk: tool.schema.string().optional(),
        handlesHandoffIds: tool.schema.string().optional(),
      },
      async execute(args, context) {
        return result("headless_propose_final", await call(context, "ledger.proposeFinal", { ...args, handlesHandoffIds: splitList(args.handlesHandoffIds), sessionId: runtimeSessionId(context) }));
      },
    }),
    headless_deliberate: tool({
      description: "Run a bounded daemon fan-out and return every structured result.",
      args: {
        question: tool.schema.string(),
        backends: tool.schema.string().optional(),
        contextRefs: tool.schema.string().optional(),
        timeoutMs: tool.schema.number().int().positive().max(86_400_000).optional(),
        mode: tool.schema.enum(["read-only", "write"]).optional().default("read-only"),
        authMode: authModeSchema(),
        approvalPolicy: approvalPolicySchema(),
      },
      async execute(args, context) {
        if (args.mode === "write") throw new Error("Use council_deliberate for reviewed write deliberation.");
        const client = await daemon(context);
        const prompt = `${args.question}${args.contextRefs ? `\n\nContext refs:\n${args.contextRefs}` : ""}`;
        const jobs = await Promise.all((splitList(args.backends) ?? ["opencode"]).map((backend) => client.call<Job>("run.submit", { backend, prompt, mode: "read-only", containment: "required", authMode: args.authMode, approvalPolicy: args.approvalPolicy, timeoutMs: args.timeoutMs, sessionId: runtimeSessionId(context) })));
        const waits = runWaitTimeouts(args.timeoutMs ?? 180_000);
        const completed = await Promise.all(jobs.map((job) => job.result ? job : client.call<Job>("run.wait", { jobId: job.id, timeoutMs: waits.server }, waits.transport)));
        return result("headless_deliberate", { jobs: completed });
      },
    }),
    headless_project_trust: projectTrustTool(),
    headless_fleet_profile: fleetProfileTool(),
    headless_fleet_health: fleetHealthTool(),
    headless_goal: goalTool(),
    headless_collaboration: collaborationTool(),
    headless_approval: approvalTool(),
    headless_candidate: candidateTool(),
    ask_for_work: cooperationTool("ask_for_work"),
    headless_ask_for_work: cooperationTool("headless_ask_for_work"),
    ask_for_more_work: cooperationTool("ask_for_more_work"),
    ask_for_backup: tool({
      description: "Ask the authenticated fleet for bounded backup help.",
      args: { problem: tool.schema.string(), neededStrength: tool.schema.string().optional() },
      async execute(args, context) {
        return result("ask_for_backup", await event(context, "ask_for_backup", { content: args.problem, meta: { neededStrength: args.neededStrength } }));
      },
    }),
    headless_record_task_claim: tool({
      description: "Claim a durable daemon task under the authenticated principal.",
      args: {
        taskId: tool.schema.string(),
        leaseMs: tool.schema.number().int().positive().max(86_400_000).optional().default(300_000),
      },
      async execute(args, context) {
        return result("headless_record_task_claim", await call(context, "task.claim", args));
      },
    }),
    headless_record_consensus_vote: tool({
      description: "Record an attributable consensus vote.",
      args: { proposal: tool.schema.string(), vote: tool.schema.enum(["yes", "no", "consensus"]), rationale: tool.schema.string().optional() },
      async execute(args, context) {
        return result("headless_record_consensus_vote", await event(context, "consensus_vote", { content: `${args.vote}: ${args.proposal}`, meta: args }));
      },
    }),
    send_message: tool({
      description: "Send a redacted structured message through the daemon ledger.",
      args: { to: tool.schema.string(), content: tool.schema.string() },
      async execute(args, context) {
        return result("send_message", await event(context, "message", { content: args.content, message: { to: args.to, content: args.content, kind: "direct" } }));
      },
    }),
    wait_for_handoff: tool({
      description: "Wait for a daemon-ledger event that handles a handoff.",
      args: { handoffId: tool.schema.string(), timeoutMs: tool.schema.number().int().positive().optional() },
      async execute(args, context) {
        return result("wait_for_handoff", await waitForHandoff(context, args.handoffId, args.timeoutMs ?? 90_000));
      },
    }),
    get_messages: tool({
      description: "Pull redacted messages for this OpenCode session.",
      args: { limit: tool.schema.number().int().positive().optional() },
      async execute(args, context) {
        const { messages } = await call<{ messages: Array<{ id: string; chatId: string; content: string; createdAt: number }> }>(
          context,
          "messages.pull",
          { chatId: runtimeSessionId(context), limit: Math.min(args.limit ?? 20, 50) },
        );
        return result("get_messages", { messages });
      },
    }),
    council_deliberate: tool({
      description: "Run typed proposal, execution, review, vote, and decision phases through the daemon.",
      args: {
        question: tool.schema.string(),
        agents: tool.schema.string().optional(),
        mode: tool.schema.enum(["read-only", "write"]).optional().default("read-only"),
        authMode: authModeSchema(),
        approvalPolicy: approvalPolicySchema(),
        timeoutMs: tool.schema.number().int().positive().max(86_400_000).optional(),
      },
      async execute(args, context) {
        return result("council_deliberate", await call(context, "council.run", { question: args.question, agents: splitList(args.agents), mode: args.mode, containment: "required", authMode: args.authMode, approvalPolicy: args.approvalPolicy, timeoutMs: args.timeoutMs }, boundedTransportTimeout((args.timeoutMs ?? 180_000) * 4 + 90_000)));
      },
    }),
    headless_workflow_run: tool({
      description: "Start a durable required-containment workflow DAG from a v0.2 JSON definition.",
      args: { definition: tool.schema.string() },
      async execute(args, context) {
        return result("headless_workflow_run", await call(context, "workflow.run", workflowDefinition(args.definition)));
      },
    }),
    headless_workflow_status: tool({
      description: "List, inspect, wait for, or cancel a durable workflow.",
      args: {
        action: tool.schema.enum(["list", "status", "wait", "cancel"]),
        workflowId: tool.schema.string().optional(),
        timeoutMs: tool.schema.number().int().positive().max(86_400_000).optional(),
      },
      async execute(args, context) {
        if (args.action === "list") return result("headless_workflow_status", await call(context, "workflow.list", {}));
        if (!args.workflowId) throw new Error("workflowId is required for status, wait, and cancel.");
        const method = args.action === "wait" ? "workflow.wait" : args.action === "cancel" ? "workflow.cancel" : "workflow.status";
        return result("headless_workflow_status", await call(
          context,
          method,
          { workflowId: args.workflowId, timeoutMs: args.timeoutMs },
          args.action === "wait" ? boundedTransportTimeout((args.timeoutMs ?? 180_000) + 5_000) : undefined,
        ));
      },
    }),
    headless_record_idle_action: tool({
      description: "Record a structured autonomous action result.",
      args: artifactArgs(),
      async execute(args, context) {
        return result("headless_record_idle_action", await event(context, "idle_action_result", { content: args.summary, artifact: { ...args, evidence: splitList(args.evidence) } }));
      },
    }),
    headless_record_release_gate: tool({
      description: "Record a release gate artifact.",
      args: { summary: tool.schema.string(), status: tool.schema.enum(["passed", "failed", "blocked", "unknown", "skipped", "timed_out"]).optional(), evidence: tool.schema.string().optional() },
      async execute(args, context) {
        return result("headless_record_release_gate", await call(context, "ledger.artifact", { kind: "release_gate", title: "Release gate", summary: args.summary, status: args.status ?? "unknown", evidence: splitList(args.evidence), sessionId: runtimeSessionId(context) }));
      },
    }),
    headless_gate: tool({
      description: "Run bounded release checks through the project daemon.",
      args: { checks: tool.schema.array(tool.schema.string()).optional(), timeoutMs: tool.schema.number().int().positive().max(86_400_000).optional() },
      async execute(args, context) {
        return result("headless_gate", await call(context, "gate.run", { checks: args.checks, timeoutMs: args.timeoutMs, sessionId: runtimeSessionId(context) }, boundedTransportTimeout((args.timeoutMs ?? 120_000) + 10_000)));
      },
    }),
    headless_get_cooperation_instructions: tool({
      description: "Return the fleet cooperation contract.",
      args: {},
      async execute() {
        return result("headless_get_cooperation_instructions", getCooperationInstructions("opencode"));
      },
    }),
  },
});

export default { id, server };

function runArgs() {
  return {
    backend: tool.schema.string().default("opencode"),
    prompt: tool.schema.string(),
    mode: tool.schema.enum(["read-only", "write"]).optional().default("read-only"),
    model: tool.schema.string().optional(),
    agent: tool.schema.string().optional(),
    timeoutMs: tool.schema.number().int().positive().max(86_400_000).optional(),
    containment: tool.schema.enum(["required", "unsafe"]).optional().default("required"),
    authMode: authModeSchema(),
    approvalPolicy: approvalPolicySchema(),
  };
}

function projectTrustTool() {
  return tool({
    description: "Inspect, grant, or revoke native-login trust for the daemon-owned project.",
    args: {
      action: tool.schema.enum(["status", "grant", "revoke"]),
      nativeLoginAllowed: tool.schema.boolean().optional().default(true),
      bypassAllowed: tool.schema.boolean().optional().default(false),
    },
    async execute(args, context) {
      if (args.action === "status") return result("headless_project_trust", await call(context, "project.trust.status", {}));
      if (args.action === "revoke") return result("headless_project_trust", await call(context, "project.trust.revoke", {}));
      return result("headless_project_trust", await call(context, "project.trust.grant", {
        nativeLoginAllowed: args.nativeLoginAllowed,
        bypassAllowed: args.bypassAllowed,
      }));
    },
  });
}

function fleetProfileTool() {
  const coordinator = tool.schema.object({
    kind: tool.schema.enum(["human", "agent", "automatic", "election"]),
    agentId: tool.schema.string().optional(),
  });
  const agent = tool.schema.object({
    id: tool.schema.string(),
    backend: tool.schema.string(),
    name: tool.schema.string(),
    model: tool.schema.string().optional(),
    authMode: authModeSchema(),
    approvalPolicy: approvalPolicySchema(),
    enabled: tool.schema.boolean().optional().default(true),
    priority: tool.schema.number().int().min(-100).max(100).optional().default(0),
    capabilities: tool.schema.array(tool.schema.string()).optional().default([]),
    maxConcurrentTurns: tool.schema.number().int().positive().max(32).optional().default(1),
  });
  return tool({
    description: "Create, inspect, list, or remove a durable collaborative fleet profile.",
    args: {
      action: tool.schema.enum(["upsert", "get", "list", "remove"]),
      profileId: tool.schema.string().optional(),
      id: tool.schema.string().optional(),
      name: tool.schema.string().optional(),
      authMode: authModeSchema(),
      approvalPolicy: approvalPolicySchema(),
      coordinator: coordinator.optional(),
      agents: tool.schema.array(agent).optional(),
      maxActiveWorkers: tool.schema.number().int().positive().max(64).optional(),
      maxQueuedDelegations: tool.schema.number().int().positive().max(1_024).optional(),
      maxDeliberationRounds: tool.schema.number().int().positive().max(64).optional(),
      maxAttemptsPerDelegation: tool.schema.number().int().positive().max(8).optional(),
      goalTimeoutMs: tool.schema.number().int().positive().max(86_400_000).optional(),
      idleAutonomy: tool.schema.enum(["off", "suggest", "read-only", "write"]).optional(),
      activate: tool.schema.boolean().optional().default(true),
    },
    async execute(args, context) {
      if (args.action === "list") return result("headless_fleet_profile", await call(context, "fleet.profile.list", {}));
      if (args.action === "get" || args.action === "remove") {
        const profileId = required(args.profileId, "profileId");
        const method = args.action === "get" ? "fleet.profile.get" : "fleet.profile.remove";
        return result("headless_fleet_profile", await call(context, method, { profileId }));
      }
      return result("headless_fleet_profile", await call(context, "fleet.profile.upsert", compact({
        id: required(args.id, "id"),
        name: required(args.name, "name"),
        authMode: args.authMode,
        approvalPolicy: args.approvalPolicy,
        coordinator: args.coordinator,
        agents: required(args.agents, "agents"),
        maxActiveWorkers: args.maxActiveWorkers,
        maxQueuedDelegations: args.maxQueuedDelegations,
        maxDeliberationRounds: args.maxDeliberationRounds,
        maxAttemptsPerDelegation: args.maxAttemptsPerDelegation,
        goalTimeoutMs: args.goalTimeoutMs,
        idleAutonomy: args.idleAutonomy,
        activate: args.activate,
      })));
    },
  });
}

function fleetHealthTool() {
  return tool({
    description: "Inspect backend login, health, rate-limit, load, and failover state.",
    args: { profileId: tool.schema.string().optional() },
    async execute(args, context) {
      return result("headless_fleet_health", await call(context, "fleet.health", compact(args)));
    },
  });
}

function goalTool() {
  const coordinator = tool.schema.object({
    kind: tool.schema.enum(["human", "agent", "automatic", "election"]),
    agentId: tool.schema.string().optional(),
  });
  return tool({
    description: "Start, message, inspect, list, cancel, or retrieve a durable collaborative goal.",
    args: {
      action: tool.schema.enum(["start", "send", "status", "list", "cancel", "result"]),
      goalId: tool.schema.string().optional(),
      objective: tool.schema.string().optional(),
      mode: tool.schema.enum(["read-only", "write"]).optional().default("read-only"),
      fleetProfileId: tool.schema.string().optional(),
      coordinator: coordinator.optional(),
      // Goal-level security controls intentionally have no client-side
      // default: omission inherits the selected fleet profile in the daemon.
      authMode: optionalAuthModeSchema(),
      approvalPolicy: optionalApprovalPolicySchema(),
      autonomous: tool.schema.boolean().optional().default(false),
      timeoutMs: tool.schema.number().int().positive().max(86_400_000).optional().default(3_600_000),
      detach: tool.schema.boolean().optional().default(false),
      text: tool.schema.string().optional(),
    },
    async execute(args, context) {
      if (args.action === "list") return result("headless_goal", await call(context, "goal.list", {}));
      if (args.action === "start") {
        return result("headless_goal", await call(context, "goal.start", compact({
          objective: required(args.objective, "objective"),
          mode: args.mode,
          fleetProfileId: args.fleetProfileId,
          coordinator: args.coordinator,
          authMode: args.authMode,
          approvalPolicy: args.approvalPolicy,
          autonomous: args.autonomous,
          timeoutMs: args.timeoutMs,
          detach: args.detach,
        })));
      }
      const goalId = required(args.goalId, "goalId");
      if (args.action === "send") {
        return result("headless_goal", await call(context, "goal.send", { goalId, text: required(args.text, "text") }));
      }
      const method = args.action === "status"
        ? "goal.status"
        : args.action === "cancel"
          ? "goal.cancel"
          : "goal.result";
      return result("headless_goal", await call(context, method, { goalId }));
    },
  });
}

function collaborationTool() {
  return tool({
    description: "Read goal turns or addressed messages, or transfer sticky leadership.",
    args: {
      action: tool.schema.enum(["turns", "messages", "transferLeader"]),
      goalId: tool.schema.string(),
      afterSequence: tool.schema.number().int().nonnegative().optional().default(0),
      limit: tool.schema.number().int().positive().max(1_000).optional().default(200),
      agentId: tool.schema.string().optional(),
    },
    async execute(args, context) {
      if (args.action === "transferLeader") {
        return result("headless_collaboration", await call(context, "collaboration.transferLeader", {
          goalId: args.goalId,
          agentId: required(args.agentId, "agentId"),
        }));
      }
      const method = args.action === "turns" ? "collaboration.turns" : "collaboration.messages";
      return result("headless_collaboration", await call(context, method, {
        goalId: args.goalId,
        afterSequence: args.afterSequence,
        limit: args.limit,
      }));
    },
  });
}

function approvalTool() {
  return tool({
    description: "List approval requests or resolve one with an attributable decision.",
    args: {
      action: tool.schema.enum(["list", "resolve"]),
      goalId: tool.schema.string().optional(),
      status: tool.schema.enum(["pending", "approved", "rejected", "cancelled", "expired"]).optional(),
      approvalId: tool.schema.string().optional(),
      decision: tool.schema.enum(["approved", "rejected"]).optional(),
      resolution: tool.schema.string().optional(),
    },
    async execute(args, context) {
      if (args.action === "list") {
        return result("headless_approval", await call(context, "approval.list", compact({ goalId: args.goalId, status: args.status })));
      }
      return result("headless_approval", await call(context, "approval.resolve", {
        approvalId: required(args.approvalId, "approvalId"),
        decision: required(args.decision, "decision"),
        resolution: required(args.resolution, "resolution"),
      }));
    },
  });
}

function candidateTool() {
  return tool({
    description: "Inspect, integrate, or reject a gated candidate decision.",
    args: {
      action: tool.schema.enum(["inspect", "integrate", "reject"]),
      candidateId: tool.schema.string(),
    },
    async execute(args, context) {
      const method = args.action === "inspect"
        ? "candidate.inspect"
        : args.action === "integrate"
          ? "candidate.integrate"
          : "candidate.reject";
      return result("headless_candidate", await call(context, method, { candidateId: args.candidateId }));
    },
  });
}

function authModeSchema() {
  return tool.schema.enum(["native-login", "broker"]).optional().default("native-login");
}

function approvalPolicySchema() {
  return tool.schema.enum(["ask", "auto", "bypass"]).optional().default("ask");
}

function optionalAuthModeSchema() {
  return tool.schema.enum(["native-login", "broker"]).optional();
}

function optionalApprovalPolicySchema() {
  return tool.schema.enum(["ask", "auto", "bypass"]).optional();
}

function artifactArgs() {
  return {
    kind: tool.schema.string(),
    title: tool.schema.string(),
    summary: tool.schema.string(),
    status: tool.schema.enum(["passed", "failed", "blocked", "unknown", "skipped", "timed_out"]).optional().default("unknown"),
    evidence: tool.schema.string().optional(),
  };
}

function cooperationTool(name: string) {
  return tool({
    description: "Signal that the authenticated worker is ready for more work.",
    args: { completed: tool.schema.string().optional(), reason: tool.schema.string().optional() },
    async execute(args, context) {
      return result(name, await event(context, "ask_for_more_work", { content: args.reason ?? "Ready for more work.", meta: { completed: args.completed } }));
    },
  });
}

async function daemon(context: ToolContext) {
  return connectOrStartDaemon({
    projectRoot: runtimeCwd(context),
    credential: { integration: "opencode-plugin" },
    bootstrapIntegration: true,
  });
}

function runWaitTimeouts(runTimeoutMs: number) {
  const boundedRun = Math.max(1, Math.min(Math.trunc(runTimeoutMs), 86_400_000));
  const server = Math.min(boundedRun + 10_000, 86_400_000);
  return { server, transport: boundedTransportTimeout(server + 5_000) };
}

function boundedTransportTimeout(value: number) {
  return Math.max(1, Math.min(Math.trunc(value), MAX_DAEMON_TRANSPORT_TIMEOUT_MS));
}

function workflowDefinition(value: string) {
  if (!value || Buffer.byteLength(value) > 2_500_000) throw new Error("A workflow JSON definition no larger than 2500000 bytes is required.");
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Workflow definition root must be an object.");
  return parsed as Record<string, unknown>;
}

async function call<T = unknown>(context: ToolContext, method: Parameters<HeadlessDaemonClient["call"]>[0], params: Record<string, unknown>, timeoutMs?: number) {
  return (await daemon(context)).call<T>(method, params, timeoutMs);
}

function event(context: ToolContext, type: string, payload: Record<string, unknown>) {
  return call(context, "ledger.event", { type, payload, sessionId: runtimeSessionId(context) });
}

async function waitForHandoff(context: ToolContext, handoffId: string, timeoutMs: number) {
  const client = await daemon(context);
  const deadline = Date.now() + Math.min(timeoutMs, 300_000);
  while (Date.now() < deadline) {
    const read = await client.call<{ entries?: Array<Record<string, unknown>> }>("ledger.context", { view: "raw", limit: 200, sessionId: runtimeSessionId(context) });
    const handled = (read.entries ?? []).filter((entry) => entry.handlesHandoffId === handoffId || (Array.isArray(entry.handlesHandoffIds) && entry.handlesHandoffIds.includes(handoffId)));
    if (handled.length) return handled;
    await Bun.sleep(50);
  }
  return [];
}

function runtimeCwd(context: ToolContext) {
  return context.directory || context.worktree || process.cwd();
}

function runtimeSessionId(context: ToolContext) {
  return context.sessionID;
}

function compact(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === null || value === "") throw new Error(`${name} is required for this action.`);
  return value;
}

function result(title: string, value: unknown) {
  return {
    title,
    output: JSON.stringify(value, null, 2),
    metadata: { value },
  };
}
