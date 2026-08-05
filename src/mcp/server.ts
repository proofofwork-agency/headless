#!/usr/bin/env bun
/** Provider-neutral foreground-lead MCP tools over the authenticated daemon. */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { resolve, sep } from "node:path";
import { z } from "zod";
import type { CredentialScope } from "../runtime/credential-store";

import { splitList } from "../utils/list";
import { redactAndTruncate } from "../runtime/redaction";
import { LeadDaemonClientPool, lapsedLeadAttachment } from "../daemon/connect";
import { resolveLeadProjectRoot } from "../runtime/lead-project-root";
import type { Job } from "../contracts/durable";
import { RunRequestObjectSchema } from "../contracts/run";
import { backendAgentSelectionRefinement } from "../contracts/agent-name";
import { MAX_DAEMON_TRANSPORT_TIMEOUT_MS, type HeadlessDaemonClient } from "../daemon/client";
import {
  ApprovalListParamsSchema,
  CandidateIdParamsSchema,
  CollaborationAcknowledgeParamsSchema,
  CollaborationListParamsSchema,
  FleetProfileIdParamsSchema,
  GoalIdParamsSchema,
  GoalSendParamsSchema,
  GoalStartParamsSchema,
} from "../daemon/protocol";

import { HEADLESS_VERSION } from "../version";
import {
  DEFAULT_DELIBERATION_BACKENDS,
  DEFAULT_TASK_LEASE_MS,
  DEFAULT_TOOL_APPROVAL_POLICY,
  DEFAULT_TOOL_AUTH_MODE,
  HEADLESS_TOOL_REGISTRY,
  assertMcpToolAllowed,
  filterToolsByMcpToolset,
  resolveMcpToolset,
  type HeadlessMcpToolset,
} from "../contracts/tool-registry";

export const MCP_VERSION = HEADLESS_VERSION;

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function toolText(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function toolError(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

const server = new Server(
  { name: "headless", version: MCP_VERSION },
  {
    capabilities: { tools: {} },
    instructions: "Provider-neutral Headless foreground-lead tools. The daemon owns orchestration; provider lifecycle remains external.",
  }
);

const McpRunSchema = RunRequestObjectSchema.omit({ projectRoot: true })
  .partial({ backend: true, mode: true, timeoutMs: true, containment: true })
  .superRefine(backendAgentSelectionRefinement);

const McpFleetHealthSchema = z.object({ profileId: z.string().trim().min(1).max(160).optional() }).strict();
const McpGoalSchema = z.discriminatedUnion("action", [
  GoalStartParamsSchema.extend({ action: z.literal("start") }).strict(),
  GoalSendParamsSchema.extend({ action: z.literal("send") }).strict(),
  GoalIdParamsSchema.extend({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("list") }).strict(),
  GoalIdParamsSchema.extend({ action: z.literal("cancel") }).strict(),
  GoalIdParamsSchema.extend({ action: z.literal("result") }).strict(),
]);
const McpProjectTrustAdvertisedSchema = z.object({ action: z.literal("status") }).strict();
const McpFleetProfileAdvertisedSchema = z.discriminatedUnion("action", [
  FleetProfileIdParamsSchema.extend({ action: z.literal("get") }).strict(),
  z.object({ action: z.literal("list") }).strict(),
]);
const McpCollaborationAdvertisedSchema = z.discriminatedUnion("action", [
  CollaborationListParamsSchema.extend({ action: z.literal("turns") }).strict(),
  CollaborationListParamsSchema.extend({ action: z.literal("messages") }).strict(),
  CollaborationAcknowledgeParamsSchema.extend({ action: z.literal("acknowledge") }).strict(),
]);
const McpApprovalAdvertisedSchema = ApprovalListParamsSchema.extend({ action: z.literal("list") }).strict();
const McpCandidateAdvertisedSchema = CandidateIdParamsSchema.extend({ action: z.literal("inspect") }).strict();

const TOOL_DEFINITIONS = HEADLESS_TOOL_REGISTRY.map((tool) => ({
  ...tool,
  inputSchema: mcpObjectInputSchema(tool.inputSchema),
}));

function mcpObjectInputSchema(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MCP tool input schema must be an object schema.");
  }
  const schema = value as Record<string, unknown>;
  if (schema.type !== undefined && schema.type !== "object") {
    throw new Error("MCP tool input schema cannot advertise a non-object root.");
  }
  for (const keyword of ["anyOf", "oneOf"] as const) {
    if (schema[keyword] === undefined) continue;
    if (!Array.isArray(schema[keyword]) || schema[keyword].some((branch) => (
      !branch
      || typeof branch !== "object"
      || Array.isArray(branch)
      || (branch as Record<string, unknown>).type !== "object"
    ))) {
      throw new Error(`MCP tool ${keyword} branches must all be object schemas before root normalization.`);
    }
  }
  return { ...schema, type: "object" as const };
}

const TOOL_REQUIRED_SCOPES: Partial<Record<typeof TOOL_DEFINITIONS[number]["name"], CredentialScope[]>> = {
  headless_run: ["run"],
  headless_deliberate: ["run"],
  headless_project_trust: ["run"],
  headless_fleet_profile: ["run"],
  headless_fleet_health: ["run"],
  headless_goal: ["session"],
  headless_collaboration: ["session", "messages"],
  headless_approval: ["session"],
  headless_candidate: ["run"],
  headless_append_note: ["ledger:write"],
  headless_record_artifact: ["ledger:write"],
  headless_read_context: ["ledger:read"],
  headless_task_state: ["task"],
  headless_propose_final: ["ledger:write"],
  headless_ask_for_work: ["ledger:write"],
  ask_for_backup: ["ledger:write"],
  headless_record_task_claim: ["task"],
  headless_record_consensus_vote: ["ledger:write"],
  headless_record_idle_action: ["ledger:write"],
  headless_record_release_gate: ["ledger:write"],
  headless_gate: ["gate"],
  send_message: ["ledger:write"],
  wait_for_handoff: ["ledger:read"],
  headless_get_messages: ["messages"],
  council_deliberate: ["council"],
  headless_workflow_run: ["run"],
  headless_workflow_status: ["run"],
};

export function mcpToolsForScopes(
  scopes: readonly CredentialScope[],
  toolset: HeadlessMcpToolset = resolveMcpToolset(),
) {
  const scoped = scopes.includes("admin")
    ? [...TOOL_DEFINITIONS]
    : TOOL_DEFINITIONS.filter((tool) => (TOOL_REQUIRED_SCOPES[tool.name] ?? []).every((scope) => scopes.includes(scope)));
  // Admin scopes still respect the lead-core toolset advertisement unless full.
  return filterToolsByMcpToolset(scoped, toolset);
}

async function handleListTools() {
  try {
    const client = await daemonClient(leadProjectRoot());
    const identity = await client.call<{ scopes: CredentialScope[] }>("ping");
    startupError = null;
    return { tools: mcpToolsForScopes(identity.scopes) };
  } catch (error) {
    // Advertise the static toolset instead of failing discovery. A harness that
    // cannot even list tools shows the operator nothing actionable; a listed
    // tool can at least answer with the remedy when it is called.
    startupError = isLeadBindingFailure(error) ? leadRemedy() : messageOf(error);
    return { tools: filterToolsByMcpToolset(TOOL_DEFINITIONS, resolveMcpToolset()) };
  }
}

async function handleCallTool(req: { params: { name: string; arguments?: Record<string, unknown> } }) {
  const name = req.params.name;
  const rawArgs = (req.params.arguments || {}) as Record<string, unknown>;
  // MCP is bound to the configured daemon project. Client-provided cwd/source/actor fields are ignored.
  const safeCwd = leadProjectRoot();
  const a = rawArgs as Record<string, unknown>; // downstream calls accept loose (MCP input is dynamic)
  // Safe extractors for dynamic MCP args (prevents unknown->string TS errors at trust boundary)
  const s = (v: unknown, d?: string) => (v == null ? d : String(v));
  const n = (v: unknown, d?: number) => (v == null ? d : (typeof v === "number" ? v : Number(v)));
  const arr = (v: unknown): string[] | undefined => splitList(typeof v === "string" ? v : (Array.isArray(v) ? v.join(",") : undefined));
  try {
    // Advertise and call both gated: non-core tools fail closed under toolset=core.
    assertMcpToolAllowed(name);
    if (name === "headless_run") {
      const parsed = McpRunSchema.parse({
        backend: a.backend ?? "opencode",
        prompt: a.prompt,
        mode: a.mode ?? "read-only",
        model: a.model,
        agent: a.agent,
        timeoutMs: a.timeoutMs ?? 180_000,
        sessionId: a.sessionId,
        containment: a.containment ?? "required",
        authMode: a.authMode ?? DEFAULT_TOOL_AUTH_MODE,
        approvalPolicy: a.approvalPolicy ?? DEFAULT_TOOL_APPROVAL_POLICY,
      });
      const client = await daemonClient(safeCwd);
      const submitted = await client.call<Job>("run.submit", parsed);
      const waits = runWaitTimeouts(parsed.timeoutMs ?? 180_000);
      const completed = submitted.result ? submitted : await client.call<Job>("run.wait", { jobId: submitted.id, timeoutMs: waits.server }, waits.transport);
      return toolText(JSON.stringify({ sessionId: completed.sessionId, jobId: completed.id, result: completed.result }, null, 2));
    }
    if (name === "headless_deliberate") {
      if (a.mode === "write") throw new Error("Use council_deliberate for reviewed write deliberation.");
      const q = `${s(a.question) || ""}${a.contextRefs ? `\n\nContext refs:\n${s(a.contextRefs)}` : ""}`;
      const client = await daemonClient(safeCwd);
      const selected = arr(a.backends) ?? [...DEFAULT_DELIBERATION_BACKENDS];
      const authMode = a.authMode === "broker" ? "broker" : DEFAULT_TOOL_AUTH_MODE;
      const approvalPolicy = a.approvalPolicy === "auto" || a.approvalPolicy === "bypass" ? a.approvalPolicy : "ask";
      const jobs = await Promise.all(selected.map((backend) => client.call<Job>("run.submit", { backend, prompt: q, mode: "read-only", containment: "required", authMode, approvalPolicy, timeoutMs: n(a.timeoutMs, 180_000), sessionId: s(a.sessionId) })));
      const waits = runWaitTimeouts(n(a.timeoutMs, 180_000)!);
      const results = await Promise.all(jobs.map((job) => job.result ? job : client.call<Job>("run.wait", { jobId: job.id, timeoutMs: waits.server }, waits.transport)));
      return toolText(JSON.stringify({ jobs: results.map((job) => ({ jobId: job.id, backend: job.backend, result: job.result })) }, null, 2));
    }
    if (name === "headless_project_trust") {
      const parsed = McpProjectTrustAdvertisedSchema.parse(a);
      const client = await daemonClient(safeCwd);
      return toolJson(await client.call("project.trust.status"));
    }
    if (name === "headless_fleet_profile") {
      const parsed = McpFleetProfileAdvertisedSchema.parse(a);
      const client = await daemonClient(safeCwd);
      if (parsed.action === "list") return toolJson(await client.call("fleet.profile.list"));
      return toolJson(await client.call("fleet.profile.get", { profileId: parsed.profileId }));
    }
    if (name === "headless_fleet_health") {
      const parsed = McpFleetHealthSchema.parse(a);
      const client = await daemonClient(safeCwd);
      return toolJson(await client.call("fleet.health", parsed));
    }
    if (name === "headless_goal") {
      const parsed = McpGoalSchema.parse(a);
      const client = await daemonClient(safeCwd);
      if (parsed.action === "list") return toolJson(await client.call("goal.list"));
      if (parsed.action === "send") return toolJson(await client.call("goal.send", { goalId: parsed.goalId, text: parsed.text }));
      if (parsed.action === "status") return toolJson(await client.call("goal.status", { goalId: parsed.goalId }));
      if (parsed.action === "cancel") return toolJson(await client.call("goal.cancel", { goalId: parsed.goalId }));
      if (parsed.action === "result") return toolJson(await client.call("goal.result", { goalId: parsed.goalId }));
      const { action: _, ...params } = parsed;
      return toolJson(await client.call("goal.start", params));
    }
    if (name === "headless_collaboration") {
      const parsed = McpCollaborationAdvertisedSchema.parse(a);
      const client = await daemonClient(safeCwd);
      if (parsed.action === "turns") {
        return toolJson(await client.call("collaboration.turns", { goalId: parsed.goalId, afterSequence: parsed.afterSequence, limit: parsed.limit }));
      }
      if (parsed.action === "messages") {
        return toolJson(await client.call("collaboration.messages", { goalId: parsed.goalId, afterSequence: parsed.afterSequence, limit: parsed.limit }));
      }
      if (parsed.action === "acknowledge") {
        return toolJson(await client.call("collaboration.messages.acknowledge", {
          goalId: parsed.goalId,
          messageIds: parsed.messageIds,
          prune: parsed.prune,
        }));
      }
      throw new Error("Unsupported collaboration action.");
    }
    if (name === "headless_approval") {
      const parsed = McpApprovalAdvertisedSchema.parse(a);
      const client = await daemonClient(safeCwd);
      return toolJson(await client.call("approval.list", compact({ goalId: parsed.goalId, status: parsed.status })));
    }
    if (name === "headless_candidate") {
      const parsed = McpCandidateAdvertisedSchema.parse(a);
      const client = await daemonClient(safeCwd);
      const params = { candidateId: parsed.candidateId };
      return toolJson(await client.call("candidate.inspect", params));
    }
    if (name === "headless_append_note") { const client = await daemonClient(safeCwd); return toolText(JSON.stringify(await client.call("ledger.note", { text: s(a.text) || "", handlesHandoffId: s(a.handlesHandoffId), sessionId: s(a.sessionId) }))); }
    if (name === "headless_record_artifact") { const client = await daemonClient(safeCwd); return toolText(JSON.stringify(await client.call("ledger.artifact", { kind: s(a.kind) || "note", title: s(a.title) || "", summary: s(a.summary) || "", status: s(a.status), evidence: arr(a.evidence), sessionId: s(a.sessionId) }))); }
    if (name === "headless_read_context") { const client = await daemonClient(safeCwd); return toolText(JSON.stringify(await client.call("ledger.context", { view: s(a.view), limit: n(a.limit), sessionId: s(a.sessionId) }))); }
    if (name === "headless_task_state") { const client = await daemonClient(safeCwd); return toolText(JSON.stringify(await client.call("task.list", { jobId: s(a.jobId), state: s(a.state) }))); }
    if (name === "headless_propose_final") { const client = await daemonClient(safeCwd); return toolText(JSON.stringify(await client.call("ledger.proposeFinal", { summary: s(a.summary) || "", evidence: s(a.evidence) || "", remainingRisk: s(a.remainingRisk), handlesHandoffIds: arr(a.handlesHandoffIds), sessionId: s(a.sessionId) }))); }
    if (name === "headless_ask_for_work") {
      const client = await daemonClient(safeCwd);
      return toolText(JSON.stringify(await client.call("ledger.event", { type: "ask_for_more_work", sessionId: s(a.sessionId), payload: { content: s(a.reason) || "Ready for more work.", meta: { completed: s(a.completed), to: s(a.to) } } })));
    }
    if (name === "ask_for_backup") {
      const client = await daemonClient(safeCwd);
      return toolText(JSON.stringify(await client.call("ledger.event", { type: "ask_for_backup", sessionId: s(a.sessionId), payload: { content: s(a.problem) || s(a.reason) || "Backup requested.", meta: { to: s(a.to), neededStrength: s(a.neededStrength) } } })));
    }
    if (name === "headless_record_task_claim") {
      const client = await daemonClient(safeCwd);
      return toolText(JSON.stringify(await client.call("task.claim", { taskId: s(a.taskId) || "", leaseMs: n(a.leaseMs, DEFAULT_TASK_LEASE_MS) })));
    }
    if (name === "headless_record_consensus_vote") {
      const v = s(a.vote) as "yes" | "no" | "consensus" | undefined;
      const client = await daemonClient(safeCwd);
      return toolText(JSON.stringify(await client.call("ledger.event", { type: "consensus_vote", sessionId: s(a.sessionId), payload: { content: `${v || "yes"}: ${s(a.proposal) || ""}`, meta: { proposal: s(a.proposal), vote: v || "yes", rationale: s(a.rationale) } } })));
    }
    if (name === "headless_record_idle_action") { const client = await daemonClient(safeCwd); return toolText(JSON.stringify(await client.call("ledger.event", { type: "idle_action_result", sessionId: s(a.sessionId), payload: { content: s(a.summary) || "", artifact: { kind: s(a.kind) || "note", title: s(a.title) || "", summary: s(a.summary) || "", status: s(a.status) || "unknown", evidence: arr(a.evidence) } } }))); }
    if (name === "headless_record_release_gate") { const client = await daemonClient(safeCwd); return toolText(JSON.stringify(await client.call("ledger.artifact", { kind: "release_gate", title: "Release gate", summary: s(a.summary) || "", status: s(a.status) || "unknown", evidence: arr(a.evidence), sessionId: s(a.sessionId) }))); }
    if (name === "headless_gate") {
      const client = await daemonClient(safeCwd);
      const gateReport = await client.call("gate.run", { checks: Array.isArray(a.checks) ? a.checks : arr(a.checks), timeoutMs: n(a.timeoutMs), sessionId: s(a.sessionId) }, boundedTransportTimeout((n(a.timeoutMs, 120_000) ?? 120_000) + 10_000));
      return toolText(JSON.stringify(gateReport));
    }
    if (name === "headless_get_cooperation_instructions") { const { getCooperationInstructions } = await import("../runtime/cooperation"); return toolText(getCooperationInstructions("headless")); }
    if (name === "send_message") { const client = await daemonClient(safeCwd); return toolText(JSON.stringify(await client.call("ledger.event", { type: "message", sessionId: s(a.sessionId), payload: { content: s(a.content) || "", message: { to: s(a.to) || "", content: s(a.content) || "", kind: "direct" } } }))); }
    if (name === "wait_for_handoff") {
      const client = await daemonClient(safeCwd);
      const res = await waitForDaemonHandoff(client, s(a.handoffId) || "", n(a.timeoutMs, 90_000)!, s(a.sessionId));
      return toolText(JSON.stringify(res));
    }
    if (name === "headless_get_messages") {
      const limit = Math.min(50, n(a.limit, 20)!);
      const chatId = s(a.sessionId, "headless_default")!;
      const client = await daemonClient(safeCwd);
      const { messages: msgs } = await client.call<{ messages: Array<{ content: string }> }>("messages.pull", { chatId, limit });
      return toolText(msgs.length ? msgs.map(m => m.content).join("\n---\n") : "no messages");
    }
    if (name === "council_deliberate") {
      const client = await daemonClient(safeCwd);
      const res = await client.call("council.run", {
        question: s(a.question) || "",
        agents: arr(a.agents),
        mode: a.mode === "write" ? "write" : "read-only",
        containment: "required",
        authMode: a.authMode === "broker" ? "broker" : DEFAULT_TOOL_AUTH_MODE,
        approvalPolicy: a.approvalPolicy === "auto" || a.approvalPolicy === "bypass" ? a.approvalPolicy : "ask",
        timeoutMs: n(a.timeoutMs, 180_000),
        sessionId: s(a.sessionId),
      }, boundedTransportTimeout(n(a.timeoutMs, 180_000)! * 4 + 90_000));
      return toolText(JSON.stringify(res, null, 2));
    }
    if (name === "headless_workflow_run") {
      const client = await daemonClient(safeCwd);
      const definition = workflowDefinition(s(a.definition));
      return toolText(JSON.stringify(await client.call("workflow.run", definition), null, 2));
    }
    if (name === "headless_workflow_status") {
      const client = await daemonClient(safeCwd);
      const action = s(a.action) ?? "status";
      if (action === "list") return toolText(JSON.stringify(await client.call("workflow.list"), null, 2));
      const workflowId = s(a.workflowId);
      if (!workflowId) throw new Error("workflowId is required for status, wait, and cancel.");
      const method = action === "wait" ? "workflow.wait" : action === "cancel" ? "workflow.cancel" : "workflow.status";
      const timeoutMs = n(a.timeoutMs, 180_000);
      return toolText(JSON.stringify(await client.call(method, { workflowId, timeoutMs }, action === "wait" ? boundedTransportTimeout(timeoutMs! + 5_000) : undefined), null, 2));
    }
    return toolError("unknown tool " + name);
  } catch (e: unknown) {
    const msg = redactAndTruncate(e instanceof Error ? e.message : String(e), 16_384).text;
    if (isLeadBindingFailure(e)) return toolError(`${name} failed: ${msg} ${leadRemedy()}`);
    return toolError(name + " failed: " + msg);
  }
}

async function waitForDaemonHandoff(client: HeadlessDaemonClient, handoffId: string, timeoutMs: number, sessionId?: string) {
  if (!handoffId) throw new Error("handoffId is required.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) throw new Error("timeoutMs must be between 1 and 300000.");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const context = await client.call<{ entries?: Array<Record<string, unknown>> }>("ledger.context", { view: "raw", limit: 200, sessionId });
    const handled = (context.entries ?? []).filter((entry) =>
      entry.handlesHandoffId === handoffId || (Array.isArray(entry.handlesHandoffIds) && entry.handlesHandoffIds.includes(handoffId)),
    );
    if (handled.length > 0) return handled;
    await Bun.sleep(50);
  }
  return [];
}

const leadClients = new LeadDaemonClientPool();
let configuredHost: string | null = null;
let resolvedProjectRoot: string | null = null;
let startupError: string | null = null;

function daemonClient(projectRoot: string) {
  const host = configuredHost ?? leadHostFromProcess();
  return leadClients.client({ projectRoot, host });
}

/**
 * An explicit `HEADLESS_PROJECT_ROOT` is authoritative on EVERY call and must
 * never be shadowed by a memoized answer — caching it broke the invariant that
 * setting the variable selects the project. Only the ancestor walk, which is
 * filesystem work with a stable result for a given process, is memoized.
 */
function leadProjectRoot() {
  const explicit = process.env.HEADLESS_PROJECT_ROOT?.trim();
  if (explicit) return resolve(explicit);
  return resolvedProjectRoot ?? (resolvedProjectRoot = resolveLeadProjectRoot());
}

/**
 * Every lead failure an operator can actually fix has the same shape: this
 * process is running, but no live binding connects it to a project. Say which
 * project it looked at and the exact command that repairs it — a bare
 * POLICY_DENIED or CREDENTIAL_MISSING sends people to the wrong layer.
 */
function leadRemedy() {
  const host = configuredHost ?? "<host>";
  return `No live ${host} foreground lead for ${leadProjectRoot()}.`
    + ` Run \`headless lead use ${host} --cwd ${leadProjectRoot()}\` and retry;`
    + " set HEADLESS_PROJECT_ROOT if that is the wrong project.";
}

/**
 * A missing or lapsed binding — NOT any authorization failure. Matching bare
 * POLICY_DENIED told operators to run `headless lead use` when the real answer
 * was "that route is admin-only", sending them to fix something that was never
 * broken.
 */
function isLeadBindingFailure(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "CREDENTIAL_MISSING" || code === "CREDENTIAL_REVOKED" || lapsedLeadAttachment(error);
}

function runWaitTimeouts(runTimeoutMs: number) {
  const boundedRun = Math.max(1, Math.min(Math.trunc(runTimeoutMs), 86_400_000));
  const server = Math.min(boundedRun + 10_000, 86_400_000);
  return { server, transport: boundedTransportTimeout(server + 5_000) };
}

function boundedTransportTimeout(value: number) {
  return Math.max(1, Math.min(Math.trunc(value), MAX_DAEMON_TRANSPORT_TIMEOUT_MS));
}

function toolJson(value: unknown) {
  return toolText(JSON.stringify(value, null, 2));
}

function compact(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function workflowDefinition(value?: string) {
  if (!value || Buffer.byteLength(value) > 2_500_000) throw new Error("A workflow JSON definition no larger than 2500000 bytes is required.");
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Workflow definition root must be an object.");
  return parsed as Record<string, unknown>;
}

server.setRequestHandler(ListToolsRequestSchema, async () => handleListTools());
server.setRequestHandler(CallToolRequestSchema, async (r) => handleCallTool(r));

export async function startMcpServer(options: { host?: string } = {}) {
  configuredHost = normalizeLeadHost(options.host ?? leadHostFromProcess());
  resolvedProjectRoot = resolveLeadProjectRoot();
  // Connect the stdio transport BEFORE attaching.
  //
  // Attaching first meant that a missing, rotated or revoked lead binding threw
  // out of `main()` and exited the process, so the harness could report only
  // "server exited" — the single failure mode an operator cannot act on. The
  // server now comes up either way and each tool answers with the exact remedy.
  // It also repairs itself: a failed connection is evicted from the pool, so the
  // next call after `headless lead use` succeeds without restarting the harness.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  try {
    await daemonClient(resolvedProjectRoot);
    startupError = null;
  } catch (error) {
    // Stay alive ONLY for the recoverable case: there is no live binding yet, and
    // the operator can create one without restarting the harness. Anything else —
    // unreadable state, a corrupt project, a daemon that cannot start — is fatal,
    // and a live-but-inert server would hide it behind tool errors forever.
    if (!isLeadBindingFailure(error)) throw error;
    startupError = leadRemedy();
  }
}

function messageOf(error: unknown) {
  return redactAndTruncate(error instanceof Error ? error.message : String(error), 16_384).text;
}

async function main() {
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await leadClients.disconnectAll().catch(() => {});
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  // A host that simply closes stdin and lets this child exit sends no signal, so
  // signal handlers alone left the binding `connected` until the 45s window
  // lapsed — and the operator's next attach raced their own stale attachment.
  // This process owns its own lifecycle, so it may hook EOF; the guest plugin
  // cannot, and uses OpenCode's `dispose` hook instead.
  process.stdin.once("end", () => void shutdown());
  process.stdin.once("close", () => void shutdown());
  await startMcpServer();
}

/**
 * Auto-start only for the dedicated MCP entrypoint (`dist/mcp/server.js` /
 * `headless-mcp`). The CLI bundle also embeds this module for
 * `headless mcp serve`, where `import.meta.main` is true for the whole
 * bundle — auto-starting there double-connects the stdio transport.
 */
function isDirectMcpEntrypoint() {
  if (!import.meta.main) return false;
  const entry = String(process.argv[1] ?? "");
  return /(?:^|[/\\])(?:mcp[/\\]server\.(?:js|ts)|headless-mcp)$/.test(entry)
    || entry.endsWith(`${sep}mcp${sep}server.js`)
    || entry.endsWith(`${sep}mcp${sep}server.ts`);
}

if (isDirectMcpEntrypoint()) {
  main().catch((error) => {
    console.error(redactAndTruncate(error instanceof Error ? error.message : String(error), 16_384).text);
    process.exit(1);
  });
}

export { server, TOOL_DEFINITIONS as mcpToolDefinitions };

// Test-only export to drive full internal tool handler paths + error branches + wait + get_messages + council for coverage of mcp/server.ts
export const __handleCallToolForTest = handleCallTool;
export const __handleListToolsForTest = handleListTools;
export const __normalizeMcpInputSchemaForTest = mcpObjectInputSchema;
/** Startup attach outcome: null once attached, otherwise the operator remedy. */
export const __startupErrorForTest = () => startupError;

function leadHostFromProcess() {
  const index = process.argv.indexOf("--host");
  return normalizeLeadHost(index >= 0 ? process.argv[index + 1] : process.env.HEADLESS_LEAD_HOST);
}

function normalizeLeadHost(value: string | undefined) {
  const host = value?.trim().toLowerCase();
  if (!host || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(host)) {
    throw new Error("A foreground lead host is required. Pass --host <host> after `headless lead use <host>`. ");
  }
  return host;
}
