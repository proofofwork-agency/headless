import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Interactive tools prefer existing provider login state; this intentionally
// differs from the broker-isolated execution contract default.
export const DEFAULT_TOOL_AUTH_MODE = "native-login" as const;
export const DEFAULT_TOOL_APPROVAL_POLICY = "ask" as const;
export const DEFAULT_DELIBERATION_BACKENDS = ["opencode", "codex"] as const;
export const DEFAULT_TASK_LEASE_MS = 300_000;

const timeout = z.number().int().positive().max(86_400_000);
const status = z.enum(["passed", "failed", "blocked", "unknown", "skipped", "timed_out"]);
const authMode = z.enum(["native-login", "broker"]);
const approvalPolicy = z.enum(["ask", "auto", "bypass"]);
const mode = z.enum(["read-only", "write"]);
const artifact = {
  kind: z.string(),
  title: z.string(),
  summary: z.string(),
  status: status.default("unknown"),
  evidence: z.string().optional(),
};

const inputSchemas = {
  headless_run: z.object({
    backend: z.string().default("opencode"),
    prompt: z.string(),
    mode: mode.default("read-only"),
    model: z.string().optional(),
    agent: z.string().optional(),
    timeoutMs: timeout.default(180_000),
    sessionId: z.string().optional(),
    containment: z.enum(["required", "unsafe"]).default("required"),
    authMode: authMode.default(DEFAULT_TOOL_AUTH_MODE),
    approvalPolicy: approvalPolicy.default(DEFAULT_TOOL_APPROVAL_POLICY),
  }).strict(),
  headless_deliberate: z.object({
    question: z.string(),
    backends: z.string().default(DEFAULT_DELIBERATION_BACKENDS.join(",")),
    contextRefs: z.string().optional(),
    timeoutMs: timeout.default(180_000),
    sessionId: z.string().optional(),
    mode: mode.default("read-only"),
    authMode: authMode.default(DEFAULT_TOOL_AUTH_MODE),
    approvalPolicy: approvalPolicy.default(DEFAULT_TOOL_APPROVAL_POLICY),
  }).strict(),
  headless_project_trust: z.object({ action: z.literal("status") }).strict(),
  headless_fleet_profile: z.object({
    action: z.enum(["get", "list"]),
    profileId: z.string().optional(),
  }).strict(),
  headless_fleet_health: z.object({ profileId: z.string().optional() }).strict(),
  headless_goal: z.object({
    action: z.enum(["start", "send", "status", "list", "cancel", "result"]),
    goalId: z.string().optional(),
    objective: z.string().optional(),
    mode: mode.default("read-only"),
    fleetProfileId: z.string().optional(),
    synthesizer: z.object({
      kind: z.enum(["agent", "automatic", "election"]),
      agentId: z.string().optional(),
    }).strict().optional(),
    // Deliberately optional: goal security inherits the selected fleet profile.
    authMode: authMode.optional(),
    approvalPolicy: approvalPolicy.optional(),
    autonomous: z.boolean().default(false),
    timeoutMs: timeout.default(3_600_000),
    detach: z.boolean().default(false),
    text: z.string().optional(),
  }).strict(),
  headless_collaboration: z.object({
    action: z.enum(["turns", "messages", "acknowledge"]),
    goalId: z.string(),
    afterSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
    limit: z.number().int().positive().max(1_000).default(200),
    messageIds: z.array(z.string()).optional(),
    prune: z.boolean().default(true),
  }).strict(),
  headless_approval: z.object({
    action: z.literal("list"),
    goalId: z.string().optional(),
    status: z.enum(["pending", "approved", "rejected", "cancelled", "expired"]).optional(),
  }).strict(),
  headless_candidate: z.object({ action: z.literal("inspect"), candidateId: z.string() }).strict(),
  headless_append_note: z.object({
    text: z.string(),
    handlesHandoffId: z.string().optional(),
    sessionId: z.string().optional(),
  }).strict(),
  headless_record_artifact: z.object({ ...artifact, sessionId: z.string().optional() }).strict(),
  headless_read_context: z.object({
    view: z.enum(["summary", "recent", "raw"]).default("summary"),
    limit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(200),
    sessionId: z.string().optional(),
  }).strict(),
  headless_task_state: z.object({
    jobId: z.string().optional(),
    state: z.enum(["pending", "claimed", "completed", "failed", "cancelled"]).optional(),
  }).strict(),
  headless_propose_final: z.object({
    summary: z.string(),
    evidence: z.string(),
    remainingRisk: z.string().optional(),
    handlesHandoffIds: z.string().optional(),
    sessionId: z.string().optional(),
  }).strict(),
  headless_ask_for_work: z.object({
    completed: z.string().optional(),
    reason: z.string().optional(),
    sessionId: z.string().optional(),
  }).strict(),
  ask_for_backup: z.object({
    problem: z.string(),
    neededStrength: z.string().optional(),
    sessionId: z.string().optional(),
  }).strict(),
  headless_record_task_claim: z.object({
    taskId: z.string(),
    leaseMs: timeout.default(DEFAULT_TASK_LEASE_MS),
  }).strict(),
  headless_record_consensus_vote: z.object({
    proposal: z.string(),
    vote: z.enum(["yes", "no", "consensus"]),
    rationale: z.string().optional(),
    sessionId: z.string().optional(),
  }).strict(),
  headless_record_idle_action: z.object({ ...artifact, sessionId: z.string().optional() }).strict(),
  headless_record_release_gate: z.object({
    summary: z.string(),
    status: status.default("unknown"),
    evidence: z.string().optional(),
    sessionId: z.string().optional(),
  }).strict(),
  headless_gate: z.object({
    checks: z.array(z.string()).optional(),
    timeoutMs: timeout.default(120_000),
    sessionId: z.string().optional(),
  }).strict(),
  headless_get_cooperation_instructions: z.object({}).strict(),
  send_message: z.object({ to: z.string(), content: z.string(), sessionId: z.string().optional() }).strict(),
  wait_for_handoff: z.object({
    handoffId: z.string(),
    timeoutMs: z.number().int().positive().max(300_000).default(90_000),
    sessionId: z.string().optional(),
  }).strict(),
  headless_get_messages: z.object({
    limit: z.number().int().positive().max(50).default(20),
    sessionId: z.string().optional(),
  }).strict(),
  council_deliberate: z.object({
    question: z.string(),
    agents: z.string().optional(),
    mode: mode.default("read-only"),
    authMode: authMode.default(DEFAULT_TOOL_AUTH_MODE),
    approvalPolicy: approvalPolicy.default(DEFAULT_TOOL_APPROVAL_POLICY),
    timeoutMs: timeout.default(180_000),
    sessionId: z.string().optional(),
  }).strict(),
  headless_workflow_run: z.object({ definition: z.string().max(2_500_000) }).strict(),
  headless_workflow_status: z.object({
    action: z.enum(["list", "status", "wait", "cancel"]),
    workflowId: z.string().optional(),
    timeoutMs: timeout.default(180_000),
  }).strict(),
} as const;

const descriptions = {
  headless_run: "Submit one daemon-owned contained job and return its complete structured result.",
  headless_deliberate: "Fan out a bounded read-only question to multiple daemon-owned backends and return every structured result.",
  headless_project_trust: "Inspect native-login trust for the daemon-owned project.",
  headless_fleet_profile: "Inspect or list durable collaborative fleet profiles.",
  headless_fleet_health: "Inspect backend login, health, rate-limit, load, and failover state for a fleet profile.",
  headless_goal: "Start, message, inspect, list, cancel, or retrieve the result of a durable collaborative goal.",
  headless_collaboration: "Read goal turns or addressed messages and acknowledge consumed messages.",
  headless_approval: "List approval requests visible to the authenticated integration.",
  headless_candidate: "Inspect a gated candidate decision.",
  headless_append_note: "Append a note through the authenticated project daemon.",
  headless_record_artifact: "Record a bounded structured artifact in the authenticated project ledger.",
  headless_read_context: "Read the daemon-maintained verified ledger projection.",
  headless_task_state: "List durable daemon tasks and their claim/lease state.",
  headless_propose_final: "Record a completion proposal for an enforced finality decision.",
  headless_ask_for_work: "Tell the fleet the authenticated worker is idle and ready for more work.",
  ask_for_backup: "Ask another agent for bounded help when stuck.",
  headless_record_task_claim: "Claim a durable daemon task under the authenticated principal.",
  headless_record_consensus_vote: "Record an attributable consensus vote under the authenticated principal.",
  headless_record_idle_action: "Record a structured autonomous action result.",
  headless_record_release_gate: "Record a release gate artifact.",
  headless_gate: "Run configured contained release-gate checks in the daemon-owned project.",
  headless_get_cooperation_instructions: "Return the fleet cooperation contract.",
  send_message: "Send an attributable direct message through the daemon ledger.",
  wait_for_handoff: "Wait for a daemon-ledger event that handles a handoff.",
  headless_get_messages: "Pull durable session-scoped messages addressed through Headless.",
  council_deliberate: "Run daemon-owned proposal, execution, review, vote, and decision phases over actual candidate outputs.",
  headless_workflow_run: "Start a durable required-containment workflow DAG from a v0.2 JSON definition.",
  headless_workflow_status: "List, inspect, wait for, or cancel an authenticated principal's durable workflow.",
} satisfies Record<keyof typeof inputSchemas, string>;

export type HeadlessToolName = keyof typeof inputSchemas;
export type HeadlessToolInput<Name extends HeadlessToolName> = z.infer<(typeof inputSchemas)[Name]>;

export type HeadlessToolDefinition = {
  name: HeadlessToolName;
  description: string;
  inputSchema: Record<string, unknown>;
};

export const HEADLESS_TOOL_REGISTRY = Object.freeze(
  (Object.keys(inputSchemas) as HeadlessToolName[]).map((name) => Object.freeze({
    name,
    description: descriptions[name],
    inputSchema: Object.freeze(advertisedSchema(zodToJsonSchema(inputSchemas[name], { target: "jsonSchema7" }))),
  })),
);

export function headlessToolDefinition<Name extends HeadlessToolName>(name: Name) {
  const definition = HEADLESS_TOOL_REGISTRY.find((entry) => entry.name === name);
  if (!definition) throw new Error(`Unknown Headless tool definition: ${name}`);
  return definition;
}

/**
 * Lead-core MCP/plugin advertisement. Default is `core` so a foreground lead
 * is not buried under 28 orchestration tools. Set HEADLESS_MCP_TOOLSET=full
 * for the complete registry. Core is a subset only — never elevates daemon scopes.
 */
export const HEADLESS_MCP_TOOLSET_ENV = "HEADLESS_MCP_TOOLSET";
export type HeadlessMcpToolset = "core" | "full";

/** Hard-capped lead-facing core surface (must stay ≤ 10 and support round trips). */
export const CORE_MCP_TOOL_NAMES = Object.freeze([
  "headless_run",
  "headless_deliberate",
  "headless_project_trust",
  "headless_read_context",
  "headless_append_note",
  "headless_task_state",
  "headless_propose_final",
  "send_message",
  "headless_get_messages",
  "headless_get_cooperation_instructions",
] as const satisfies readonly HeadlessToolName[]);

export const CORE_MCP_TOOL_NAME_SET = new Set<string>(CORE_MCP_TOOL_NAMES);

export function resolveMcpToolset(value: string | undefined = process.env[HEADLESS_MCP_TOOLSET_ENV]): HeadlessMcpToolset {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "core") return "core";
  if (normalized === "full") return "full";
  throw new Error(`${HEADLESS_MCP_TOOLSET_ENV} must be "core" or "full" (got ${JSON.stringify(value)}).`);
}

export function isCoreMcpToolName(name: string) {
  return CORE_MCP_TOOL_NAME_SET.has(name);
}

export function filterToolsByMcpToolset<T extends { name: string }>(
  tools: readonly T[],
  toolset: HeadlessMcpToolset = resolveMcpToolset(),
): T[] {
  if (toolset === "full") return [...tools];
  return tools.filter((tool) => isCoreMcpToolName(tool.name));
}

export function assertMcpToolAllowed(
  name: string,
  toolset: HeadlessMcpToolset = resolveMcpToolset(),
) {
  if (toolset === "full" || isCoreMcpToolName(name)) return;
  throw new Error(
    `Tool ${name} is outside the lead-core MCP toolset. Set ${HEADLESS_MCP_TOOLSET_ENV}=full to enable the full registry.`,
  );
}

function advertisedSchema(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Headless tool input schema must be an object.");
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key, entry]) => key !== "$schema" && !(key === "additionalProperties" && entry === false))
    .map(([key, entry]) => [key, advertisedSchemaValue(entry)]));
}

function advertisedSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(advertisedSchemaValue);
  if (!value || typeof value !== "object") return value;
  return advertisedSchema(value);
}
