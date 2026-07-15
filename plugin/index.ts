import { type Plugin, type ToolContext, type ToolResult, tool } from "@opencode-ai/plugin";
import {
  LeadDaemonClientPool,
  MAX_DAEMON_TRANSPORT_TIMEOUT_MS,
  type HeadlessDaemonClient,
} from "@proofofwork-agency/headless/daemon";
import {
  DEFAULT_DELIBERATION_BACKENDS,
  getCooperationInstructions,
  headlessToolDefinition,
  splitList,
  type HeadlessToolInput,
  type HeadlessToolName,
  type Job,
} from "@proofofwork-agency/headless/experimental";

export const id = "headless";

export const server: Plugin = async () => ({
  tool: {
    headless_run: registryTool("headless_run", async (args, context) => {
        const client = await daemon(context);
        const submitted = await client.call<Job>("run.submit", {
          backend: args.backend,
          prompt: args.prompt,
          mode: args.mode,
          model: args.model,
          agent: args.agent,
          timeoutMs: args.timeoutMs,
          sessionId: runtimeSessionId(context, args.sessionId),
          containment: args.containment,
          authMode: args.authMode,
          approvalPolicy: args.approvalPolicy,
        });
        const waits = runWaitTimeouts(args.timeoutMs ?? 180_000);
        const completed = submitted.result ? submitted : await client.call<Job>("run.wait", { jobId: submitted.id, timeoutMs: waits.server }, waits.transport);
        return result("headless_run", { jobId: completed.id, sessionId: completed.sessionId, result: completed.result });
    }),
    headless_append_note: registryTool("headless_append_note", async (args, context) => {
        return result("headless_append_note", await call(context, "ledger.note", { ...args, sessionId: runtimeSessionId(context, args.sessionId) }));
    }),
    headless_record_artifact: registryTool("headless_record_artifact", async (args, context) => {
        return result("headless_record_artifact", await call(context, "ledger.artifact", { ...args, evidence: splitList(args.evidence), sessionId: runtimeSessionId(context, args.sessionId) }));
    }),
    headless_read_context: registryTool("headless_read_context", async (args, context) => {
        return result("headless_read_context", await call(context, "ledger.context", { ...args, sessionId: runtimeSessionId(context, args.sessionId) }));
    }),
    headless_task_state: registryTool("headless_task_state", async (args, context) => {
        return result("headless_task_state", await call(context, "task.list", args));
    }),
    headless_propose_final: registryTool("headless_propose_final", async (args, context) => {
        return result("headless_propose_final", await call(context, "ledger.proposeFinal", { ...args, handlesHandoffIds: splitList(args.handlesHandoffIds), sessionId: runtimeSessionId(context, args.sessionId) }));
    }),
    headless_deliberate: registryTool("headless_deliberate", async (args, context) => {
        if (args.mode === "write") throw new Error("Use council_deliberate for reviewed write deliberation.");
        const client = await daemon(context);
        const prompt = `${args.question}${args.contextRefs ? `\n\nContext refs:\n${args.contextRefs}` : ""}`;
        const jobs = await Promise.all((splitList(args.backends) ?? [...DEFAULT_DELIBERATION_BACKENDS]).map((backend) => client.call<Job>("run.submit", { backend, prompt, mode: "read-only", containment: "required", authMode: args.authMode, approvalPolicy: args.approvalPolicy, timeoutMs: args.timeoutMs, sessionId: runtimeSessionId(context, args.sessionId) })));
        const waits = runWaitTimeouts(args.timeoutMs ?? 180_000);
        const completed = await Promise.all(jobs.map((job) => job.result ? job : client.call<Job>("run.wait", { jobId: job.id, timeoutMs: waits.server }, waits.transport)));
        return result("headless_deliberate", { jobs: completed });
    }),
    headless_project_trust: projectTrustTool(),
    headless_fleet_profile: fleetProfileTool(),
    headless_fleet_health: fleetHealthTool(),
    headless_goal: goalTool(),
    headless_collaboration: collaborationTool(),
    headless_approval: approvalTool(),
    headless_candidate: candidateTool(),
    headless_ask_for_work: cooperationTool(),
    ask_for_backup: registryTool("ask_for_backup", async (args, context) => {
        return result("ask_for_backup", await event(context, "ask_for_backup", { content: args.problem, meta: { neededStrength: args.neededStrength } }, args.sessionId));
    }),
    headless_record_task_claim: registryTool("headless_record_task_claim", async (args, context) => {
        return result("headless_record_task_claim", await call(context, "task.claim", args));
    }),
    headless_record_consensus_vote: registryTool("headless_record_consensus_vote", async (args, context) => {
        return result("headless_record_consensus_vote", await event(context, "consensus_vote", { content: `${args.vote}: ${args.proposal}`, meta: args }, args.sessionId));
    }),
    send_message: registryTool("send_message", async (args, context) => {
        return result("send_message", await event(context, "message", { content: args.content, message: { to: args.to, content: args.content, kind: "direct" } }, args.sessionId));
    }),
    wait_for_handoff: registryTool("wait_for_handoff", async (args, context) => {
        return result("wait_for_handoff", await waitForHandoff(context, args.handoffId, args.timeoutMs ?? 90_000, args.sessionId));
    }),
    get_messages: registryTool("get_messages", async (args, context) => {
        const { messages } = await call<{ messages: Array<{ id: string; chatId: string; content: string; createdAt: number }> }>(
          context,
          "messages.pull",
          { chatId: runtimeSessionId(context, args.sessionId), limit: Math.min(args.limit ?? 20, 50) },
        );
        return result("get_messages", { messages });
      }),
    council_deliberate: registryTool("council_deliberate", async (args, context) => {
        return result("council_deliberate", await call(context, "council.run", { question: args.question, agents: splitList(args.agents), mode: args.mode, containment: "required", authMode: args.authMode, approvalPolicy: args.approvalPolicy, timeoutMs: args.timeoutMs, sessionId: runtimeSessionId(context, args.sessionId) }, boundedTransportTimeout((args.timeoutMs ?? 180_000) * 4 + 90_000)));
    }),
    headless_workflow_run: registryTool("headless_workflow_run", async (args, context) => {
        return result("headless_workflow_run", await call(context, "workflow.run", workflowDefinition(args.definition)));
    }),
    headless_workflow_status: registryTool("headless_workflow_status", async (args, context) => {
        if (args.action === "list") return result("headless_workflow_status", await call(context, "workflow.list", {}));
        if (!args.workflowId) throw new Error("workflowId is required for status, wait, and cancel.");
        const method = args.action === "wait" ? "workflow.wait" : args.action === "cancel" ? "workflow.cancel" : "workflow.status";
        return result("headless_workflow_status", await call(
          context,
          method,
          { workflowId: args.workflowId, timeoutMs: args.timeoutMs },
          args.action === "wait" ? boundedTransportTimeout((args.timeoutMs ?? 180_000) + 5_000) : undefined,
        ));
    }),
    headless_record_idle_action: registryTool("headless_record_idle_action", async (args, context) => {
        const { sessionId, ...artifact } = args;
        return result("headless_record_idle_action", await event(context, "idle_action_result", { content: args.summary, artifact: { ...artifact, evidence: splitList(args.evidence) } }, sessionId));
    }),
    headless_record_release_gate: registryTool("headless_record_release_gate", async (args, context) => {
        return result("headless_record_release_gate", await call(context, "ledger.artifact", { kind: "release_gate", title: "Release gate", summary: args.summary, status: args.status ?? "unknown", evidence: splitList(args.evidence), sessionId: runtimeSessionId(context, args.sessionId) }));
    }),
    headless_gate: registryTool("headless_gate", async (args, context) => {
        return result("headless_gate", await call(context, "gate.run", { checks: args.checks, timeoutMs: args.timeoutMs, sessionId: runtimeSessionId(context, args.sessionId) }, boundedTransportTimeout((args.timeoutMs ?? 120_000) + 10_000)));
    }),
    headless_get_cooperation_instructions: registryTool("headless_get_cooperation_instructions", async () => {
        return result("headless_get_cooperation_instructions", getCooperationInstructions("opencode"));
    }),
  },
});

export default { id, server };

function projectTrustTool() {
  return registryTool("headless_project_trust", async (_args, context) => {
      return result("headless_project_trust", await call(context, "project.trust.status", {}));
  });
}

function fleetProfileTool() {
  return registryTool("headless_fleet_profile", async (args, context) => {
      if (args.action === "list") return result("headless_fleet_profile", await call(context, "fleet.profile.list", {}));
      return result("headless_fleet_profile", await call(context, "fleet.profile.get", { profileId: required(args.profileId, "profileId") }));
  });
}

function fleetHealthTool() {
  return registryTool("headless_fleet_health", async (args, context) => {
      return result("headless_fleet_health", await call(context, "fleet.health", compact(args)));
  });
}

function goalTool() {
  return registryTool("headless_goal", async (args, context) => {
      if (args.action === "list") return result("headless_goal", await call(context, "goal.list", {}));
      if (args.action === "start") {
        return result("headless_goal", await call(context, "goal.start", compact({
          objective: required(args.objective, "objective"),
          mode: args.mode,
          fleetProfileId: args.fleetProfileId,
          synthesizer: args.synthesizer,
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
  });
}

function collaborationTool() {
  return registryTool("headless_collaboration", async (args, context) => {
      if (args.action === "acknowledge") {
        return result("headless_collaboration", await call(context, "collaboration.messages.acknowledge", {
          goalId: args.goalId,
          messageIds: required(args.messageIds, "messageIds"),
          prune: args.prune,
        }));
      }
      const method = args.action === "turns" ? "collaboration.turns" : "collaboration.messages";
      return result("headless_collaboration", await call(context, method, {
        goalId: args.goalId,
        afterSequence: args.afterSequence,
        limit: args.limit,
      }));
  });
}

function approvalTool() {
  return registryTool("headless_approval", async (args, context) => {
      return result("headless_approval", await call(context, "approval.list", compact({ goalId: args.goalId, status: args.status })));
  });
}

function candidateTool() {
  return registryTool("headless_candidate", async (args, context) => {
      return result("headless_candidate", await call(context, "candidate.inspect", { candidateId: args.candidateId }));
  });
}
function cooperationTool() {
  return registryTool("headless_ask_for_work", async (args, context) => {
    return result("headless_ask_for_work", await event(context, "ask_for_more_work", { content: args.reason ?? "Ready for more work.", meta: { completed: args.completed } }, args.sessionId));
  });
}

type PluginShape = NonNullable<Parameters<typeof tool.schema.object>[0]>;
type PluginSchema = PluginShape[string];

function registryTool<Name extends HeadlessToolName>(
  name: Name,
  execute: (args: HeadlessToolInput<Name>, context: ToolContext) => Promise<ToolResult>,
) {
  const definition = headlessToolDefinition(name);
  return tool({
    description: definition.description,
    args: pluginToolArgs(definition.inputSchema),
    async execute(args, context) {
      return execute(args as HeadlessToolInput<Name>, context);
    },
  });
}

function pluginToolArgs(inputSchema: Record<string, unknown>): PluginShape {
  const properties = recordValue(inputSchema.properties, "Headless tool schema properties");
  const required = new Set(Array.isArray(inputSchema.required) ? inputSchema.required.filter((value): value is string => typeof value === "string") : []);
  return Object.fromEntries(Object.entries(properties).map(([name, schema]) => [
    name,
    pluginValueSchema(recordValue(schema, `Headless tool property ${name}`), required.has(name)),
  ])) as PluginShape;
}

function pluginValueSchema(value: Record<string, unknown>, required: boolean): PluginSchema {
  let schema: PluginSchema;
  if (value.const !== undefined) {
    if (typeof value.const !== "string") throw new Error("Headless plugin supports only string literal tool fields.");
    schema = tool.schema.literal(value.const);
  } else if (Array.isArray(value.enum)) {
    const values = value.enum.filter((entry): entry is string => typeof entry === "string");
    if (values.length !== value.enum.length || values.length === 0) throw new Error("Headless plugin tool enums must contain strings.");
    schema = tool.schema.enum(values as [string, ...string[]]);
  } else if (value.type === "string") {
    let text = tool.schema.string();
    if (typeof value.minLength === "number") text = text.min(value.minLength);
    if (typeof value.maxLength === "number") text = text.max(value.maxLength);
    if (typeof value.pattern === "string") text = text.regex(new RegExp(value.pattern));
    schema = text;
  } else if (value.type === "number" || value.type === "integer") {
    let number = tool.schema.number();
    if (value.type === "integer") number = number.int();
    if (typeof value.minimum === "number") number = number.min(value.minimum);
    if (typeof value.exclusiveMinimum === "number") number = number.gt(value.exclusiveMinimum);
    if (typeof value.maximum === "number") number = number.max(value.maximum);
    if (typeof value.exclusiveMaximum === "number") number = number.lt(value.exclusiveMaximum);
    schema = number;
  } else if (value.type === "boolean") {
    schema = tool.schema.boolean();
  } else if (value.type === "array") {
    const items = recordValue(value.items, "Headless plugin array items");
    let array = tool.schema.array(pluginValueSchema(items, true));
    if (typeof value.minItems === "number") array = array.min(value.minItems);
    if (typeof value.maxItems === "number") array = array.max(value.maxItems);
    schema = array;
  } else if (value.type === "object") {
    schema = tool.schema.object(pluginToolArgs(value));
  } else {
    throw new Error(`Unsupported Headless plugin tool field schema type: ${String(value.type)}`);
  }
  if (value.default !== undefined) return schema.default(value.default);
  return required ? schema : schema.optional();
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

const leadClients = new LeadDaemonClientPool();

async function daemon(context: ToolContext) {
  const projectRoot = runtimeCwd(context);
  return leadClients.client({ projectRoot, host: "opencode" });
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

function event(context: ToolContext, type: string, payload: Record<string, unknown>, sessionId?: string) {
  return call(context, "ledger.event", { type, payload, sessionId: runtimeSessionId(context, sessionId) });
}

async function waitForHandoff(context: ToolContext, handoffId: string, timeoutMs: number, sessionId?: string) {
  const client = await daemon(context);
  const deadline = Date.now() + Math.min(timeoutMs, 300_000);
  while (Date.now() < deadline) {
    const read = await client.call<{ entries?: Array<Record<string, unknown>> }>("ledger.context", { view: "raw", limit: 200, sessionId: runtimeSessionId(context, sessionId) });
    const handled = (read.entries ?? []).filter((entry) => entry.handlesHandoffId === handoffId || (Array.isArray(entry.handlesHandoffIds) && entry.handlesHandoffIds.includes(handoffId)));
    if (handled.length) return handled;
    await Bun.sleep(50);
  }
  return [];
}

function runtimeCwd(context: ToolContext) {
  return context.directory || context.worktree || process.cwd();
}

function runtimeSessionId(context: ToolContext, requested?: string) {
  return requested ?? context.sessionID;
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
