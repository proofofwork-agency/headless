#!/usr/bin/env bun
/**
 * Headless MCP Server + Claude Channel Adapter (CR supersede)
 *
 * - Advertises "claude/channel"
 * - Real sendChannelPush with notifications/claude/channel when client supports
 * - get_messages pull fallback through the authenticated daemon queue
 * - All the universal headless_* tools
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { randomUUID } from "node:crypto";

import {
  splitList,
} from "../index";
import { redactAndTruncate } from "../runtime/redaction";
import { connectOrStartDaemon } from "../daemon/connect";
import type { Job } from "../contracts/durable";
import { RunRequestObjectSchema } from "../contracts/run";
import { backendAgentSelectionRefinement } from "../contracts/agent-name";
import { MAX_DAEMON_TRANSPORT_TIMEOUT_MS, type HeadlessDaemonClient } from "../daemon/client";
import {
  ApprovalListParamsSchema,
  ApprovalResolveParamsSchema,
  CandidateIdParamsSchema,
  CollaborationAcknowledgeParamsSchema,
  CollaborationListParamsSchema,
  CollaborationTransferLeaderParamsSchema,
  FleetProfileIdParamsSchema,
  FleetProfileUpsertParamsSchema,
  GoalIdParamsSchema,
  GoalSendParamsSchema,
  GoalStartParamsSchema,
  ProjectTrustGrantParamsSchema,
} from "../daemon/protocol";

export const MCP_VERSION = "0.2.0";

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
    capabilities: {
      tools: {},
      experimental: { "claude/channel": {} },
    },
    instructions: "Universal headless orchestrator. Use tools + ledger for cooperation across Claude/Codex/OpenCode/Grok. Supports claude/channel push.",
  }
);

let resolvedPushMode: "push" | "pull" = "push"; // default optimistic: always attempt real channel notification; refined by client caps
let supportsChannel = true;

async function pushViaChannel(content: string, meta: Record<string, unknown> = {}) {
  const msgId = `hls_${randomUUID()}`;
  await server.notification({
    method: "notifications/claude/channel",
    params: {
      content,
      meta: { chat_id: "headless", message_id: msgId, user: "Headless", ts: new Date().toISOString(), ...meta },
    },
  });
}

export async function sendChannelPush(message: string, source = "headless", meta?: Record<string, unknown>) {
  // Real implementation: always attempt MCP notification "notifications/claude/channel"
  // (primary push path for supported clients) + durable append + queue (pull fallback).
  // Queue is always populated for get_messages pull; push is the real-time notification attempt.
  // markPushed on successful notification.
  const safe = redactAndTruncate(message, 65_536).text;
  const chatId = typeof meta?.sessionId === "string" ? meta.sessionId : typeof meta?.chat_id === "string" ? meta.chat_id : "headless_default";
  const client = await connectOrStartDaemon({ projectRoot: process.env.HEADLESS_PROJECT_ROOT || process.cwd(), credential: { integration: "mcp" }, bootstrapIntegration: true });
  const enqueued = await client.call<{ id: string }>("messages.push", {
    chatId,
    content: safe,
    to: "claude",
    meta: { requestedSource: source, ...(meta || {}) },
  });
  try {
    await pushViaChannel(safe, { source, chat_id: chatId, ...(meta || {}) });
    await client.call("messages.markPushed", { messageId: enqueued.id });
  } catch {
    // The daemon queue remains the durable pull fallback.
  }
  console.error(`[mcp] channel-push via notifications/claude/channel (${resolvedPushMode}): ${safe.slice(0, 70)}`);
  return enqueued;
}

const McpRunSchema = RunRequestObjectSchema.omit({ projectRoot: true })
  .partial({ backend: true, mode: true, timeoutMs: true, containment: true })
  .superRefine(backendAgentSelectionRefinement);

const McpProjectTrustSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  ProjectTrustGrantParamsSchema.extend({ action: z.literal("grant") }).strict(),
  z.object({ action: z.literal("revoke") }).strict(),
]);
const McpFleetProfileSchema = z.discriminatedUnion("action", [
  FleetProfileUpsertParamsSchema.extend({ action: z.literal("upsert") }).strict(),
  FleetProfileIdParamsSchema.extend({ action: z.literal("get") }).strict(),
  z.object({ action: z.literal("list") }).strict(),
  FleetProfileIdParamsSchema.extend({ action: z.literal("remove") }).strict(),
]);
const McpFleetHealthSchema = z.object({ profileId: z.string().trim().min(1).max(160).optional() }).strict();
const McpGoalSchema = z.discriminatedUnion("action", [
  GoalStartParamsSchema.extend({ action: z.literal("start") }).strict(),
  GoalSendParamsSchema.extend({ action: z.literal("send") }).strict(),
  GoalIdParamsSchema.extend({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("list") }).strict(),
  GoalIdParamsSchema.extend({ action: z.literal("cancel") }).strict(),
  GoalIdParamsSchema.extend({ action: z.literal("result") }).strict(),
]);
const McpCollaborationSchema = z.discriminatedUnion("action", [
  CollaborationListParamsSchema.extend({ action: z.literal("turns") }).strict(),
  CollaborationListParamsSchema.extend({ action: z.literal("messages") }).strict(),
  CollaborationAcknowledgeParamsSchema.extend({ action: z.literal("acknowledge") }).strict(),
  CollaborationTransferLeaderParamsSchema.extend({ action: z.literal("transferLeader") }).strict(),
]);
const McpApprovalSchema = z.discriminatedUnion("action", [
  ApprovalListParamsSchema.extend({ action: z.literal("list") }).strict(),
  ApprovalResolveParamsSchema.extend({ action: z.literal("resolve") }).strict(),
]);
const McpCandidateSchema = z.discriminatedUnion("action", [
  CandidateIdParamsSchema.extend({ action: z.literal("inspect") }).strict(),
  CandidateIdParamsSchema.extend({ action: z.literal("integrate") }).strict(),
  CandidateIdParamsSchema.extend({ action: z.literal("reject") }).strict(),
]);

const TOOL_DEFINITIONS = [
  { name: "headless_run", description: "Submit one daemon-owned contained job and return its complete structured result.", inputSchema: zodToJsonSchema(McpRunSchema, { target: "openApi3" }) },
  { name: "headless_deliberate", description: "Fan out a read-only question to multiple daemon-owned backends and return every structured result.", inputSchema: { type: "object", properties: { question: { type: "string" }, backends: { type: "string", description: "Comma-separated backend IDs." }, authMode: { type: "string", enum: ["native-login", "broker"] }, approvalPolicy: { type: "string", enum: ["ask", "auto", "bypass"] }, timeoutMs: { type: "integer", minimum: 1, maximum: 86_400_000 }, sessionId: { type: "string" } }, required: ["question"] } },
  { name: "headless_project_trust", description: "Inspect, grant, or revoke native-login trust for the daemon-owned project. Mutations require admin scope.", inputSchema: zodToJsonSchema(McpProjectTrustSchema, { target: "openApi3" }) },
  { name: "headless_fleet_profile", description: "Create, inspect, list, or remove durable collaborative fleet profiles.", inputSchema: zodToJsonSchema(McpFleetProfileSchema, { target: "openApi3" }) },
  { name: "headless_fleet_health", description: "Inspect backend login, health, rate-limit, load, and failover state for a fleet profile.", inputSchema: zodToJsonSchema(McpFleetHealthSchema, { target: "openApi3" }) },
  { name: "headless_goal", description: "Start, message, inspect, list, cancel, or retrieve the result of a durable collaborative goal.", inputSchema: zodToJsonSchema(McpGoalSchema, { target: "openApi3" }) },
  { name: "headless_collaboration", description: "Read goal turns or addressed messages, acknowledge consumed messages, or transfer sticky leadership.", inputSchema: zodToJsonSchema(McpCollaborationSchema, { target: "openApi3" }) },
  { name: "headless_approval", description: "List approval requests or resolve one with an attributable decision.", inputSchema: zodToJsonSchema(McpApprovalSchema, { target: "openApi3" }) },
  { name: "headless_candidate", description: "Inspect, integrate, or reject a gated candidate decision.", inputSchema: zodToJsonSchema(McpCandidateSchema, { target: "openApi3" }) },
  { name: "headless_append_note", description: "Append note to shared ledger.", inputSchema: { type: "object", properties: { text: { type: "string" }, sessionId: { type: "string" } }, required: ["text"] } },
  { name: "headless_record_artifact", description: "Record a bounded structured artifact in the authenticated project ledger.", inputSchema: { type: "object", properties: { kind: { type: "string" }, title: { type: "string" }, summary: { type: "string" }, status: { type: "string", enum: ["passed", "failed", "blocked", "unknown", "skipped", "timed_out"] }, evidence: { type: "array", items: { type: "string" } }, sessionId: { type: "string" } }, required: ["kind","title","summary"] } },
  { name: "headless_read_context", description: "Read the daemon-maintained verified ledger projection.", inputSchema: { type: "object", properties: { view: { type: "string", enum: ["summary", "recent", "raw"] }, limit: { type: "integer", minimum: 1 }, sessionId: { type: "string" } } } },
  { name: "headless_task_state", description: "List durable daemon tasks and their claim/lease state.", inputSchema: { type: "object", properties: { jobId: { type: "string" }, state: { type: "string", enum: ["pending", "claimed", "completed", "failed", "cancelled"] } } } },
  { name: "headless_propose_final", description: "Record a completion proposal for an enforced finality decision.", inputSchema: { type: "object", properties: { summary: { type: "string" }, evidence: { type: "string" }, remainingRisk: { type: "string" }, handlesHandoffIds: { type: "array", items: { type: "string" } }, sessionId: { type: "string" } }, required: ["summary","evidence"] } },
  { name: "headless_ask_for_work", description: "Tell the fleet you are idle/ready. Identity comes from the authenticated MCP credential.", inputSchema: { type: "object", properties: { completed: { type: "string" }, reason: { type: "string" }, sessionId: { type: "string" } } } },
  { name: "ask_for_more_work", description: "Proactively ask for the next task when finished or idle. Identity comes from authentication.", inputSchema: { type: "object", properties: { completed: { type: "string" }, reason: { type: "string" }, sessionId: { type: "string" } } } },
  { name: "ask_for_work", description: "Signal idle/ready for work to the coordinator.", inputSchema: { type: "object", properties: { to: { type: "string" }, reason: { type: "string" }, sessionId: { type: "string" } } } },
  { name: "ask_for_backup", description: "Ask another agent for bounded help when stuck.", inputSchema: { type: "object", properties: { problem: { type: "string" }, neededStrength: { type: "string" }, sessionId: { type: "string" } }, required: ["problem"] } },
  { name: "headless_record_task_claim", description: "Claim a durable daemon task under the authenticated principal.", inputSchema: { type: "object", properties: { taskId: { type: "string" }, leaseMs: { type: "integer", minimum: 1, maximum: 86_400_000 } }, required: ["taskId"] } },
  { name: "headless_record_consensus_vote", description: "Record an attributable consensus vote under the authenticated principal.", inputSchema: { type: "object", properties: { proposal: { type: "string" }, vote: { type: "string", enum: ["yes", "no", "consensus"] }, rationale: { type: "string" }, sessionId: { type: "string" } }, required: ["proposal", "vote"] } },
  { name: "headless_record_idle_action", description: "Record autonomous action result.", inputSchema: { type: "object", properties: { kind: { type: "string" }, title: { type: "string" }, summary: { type: "string" } }, required: ["kind","title","summary"] } },
  { name: "headless_record_release_gate", description: "Record a gate evaluation.", inputSchema: { type: "object", properties: { summary: { type: "string" }, status: { type: "string" } }, required: ["summary"] } },
  { name: "headless_gate", description: "Run configured contained release-gate checks in the daemon-owned project.", inputSchema: { type: "object", properties: { checks: { type: "array", items: { type: "string" } }, timeoutMs: { type: "integer", minimum: 1, maximum: 86_400_000 }, sessionId: { type: "string" } } } },
  { name: "headless_get_cooperation_instructions", description: "Fleet cooperation rules.", inputSchema: { type: "object", properties: {} } },
  { name: "send_message", description: "Send an attributable direct message via the daemon ledger.", inputSchema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" }, sessionId: { type: "string" } }, required: ["to","content"] } },
  { name: "wait_for_handoff", description: "Wait (with subscription + timeout) for handoff results. Returns handling events for the given handoffId.", inputSchema: { type: "object", properties: { handoffId: { type: "string" }, timeoutMs: { type: "number" }, sessionId: { type: "string" } } } },
  { name: "get_messages", description: "Pull session-scoped channel messages (claude/channel fallback).", inputSchema: { type: "object", properties: { limit: { type: "number" }, sessionId: { type: "string" } } } },
  { name: "council_deliberate", description: "Run daemon-owned proposal, execution, review, vote, and decision phases over actual candidate outputs.", inputSchema: { type: "object", properties: { question: { type: "string" }, agents: { type: "string", description: "Comma-separated backend IDs." }, mode: { type: "string", enum: ["read-only", "write"] }, authMode: { type: "string", enum: ["native-login", "broker"] }, approvalPolicy: { type: "string", enum: ["ask", "auto", "bypass"] }, timeoutMs: { type: "integer", minimum: 1, maximum: 86_400_000 }, sessionId: { type: "string" } }, required: ["question"] } },
  { name: "headless_workflow_run", description: "Start a durable required-containment workflow DAG from a v0.2 JSON definition.", inputSchema: { type: "object", properties: { definition: { type: "string", maxLength: 2500000, description: "JSON object with steps and optional finality requirements." } }, required: ["definition"] } },
  { name: "headless_workflow_status", description: "List, inspect, wait for, or cancel an authenticated principal's durable workflow.", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["list", "status", "wait", "cancel"] }, workflowId: { type: "string" }, timeoutMs: { type: "integer", minimum: 1, maximum: 86400000 } }, required: ["action"] } },
];

async function handleListTools() {
  return { tools: TOOL_DEFINITIONS };
}

async function handleCallTool(req: { params: { name: string; arguments?: Record<string, unknown> } }) {
  const name = req.params.name;
  const rawArgs = (req.params.arguments || {}) as Record<string, unknown>;
  // MCP is bound to the configured daemon project. Client-provided cwd/source/actor fields are ignored.
  const safeCwd = process.env.HEADLESS_PROJECT_ROOT || process.cwd();
  const a = rawArgs as Record<string, unknown>; // downstream calls accept loose (MCP input is dynamic)
  // Safe extractors for dynamic MCP args (prevents unknown->string TS errors at trust boundary)
  const s = (v: unknown, d?: string) => (v == null ? d : String(v));
  const n = (v: unknown, d?: number) => (v == null ? d : (typeof v === "number" ? v : Number(v)));
  const arr = (v: unknown): string[] | undefined => splitList(typeof v === "string" ? v : (Array.isArray(v) ? v.join(",") : undefined));
  try {
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
        authMode: a.authMode,
        approvalPolicy: a.approvalPolicy,
      });
      const client = await daemonClient(safeCwd);
      const submitted = await client.call<Job>("run.submit", parsed);
      const waits = runWaitTimeouts(parsed.timeoutMs ?? 180_000);
      const completed = submitted.result ? submitted : await client.call<Job>("run.wait", { jobId: submitted.id, timeoutMs: waits.server }, waits.transport);
      return toolText(JSON.stringify({ sessionId: completed.sessionId, jobId: completed.id, result: completed.result }, null, 2));
    }
    if (name === "headless_deliberate") {
      const q = s(a.question) || "";
      const client = await daemonClient(safeCwd);
      const selected = arr(a.backends) ?? ["opencode", "claude-code", "codex"];
      const authMode = a.authMode === "broker" ? "broker" : "native-login";
      const approvalPolicy = a.approvalPolicy === "auto" || a.approvalPolicy === "bypass" ? a.approvalPolicy : "ask";
      const jobs = await Promise.all(selected.map((backend) => client.call<Job>("run.submit", { backend, prompt: q, mode: "read-only", containment: "required", authMode, approvalPolicy, timeoutMs: n(a.timeoutMs, 180_000), sessionId: s(a.sessionId) })));
      const waits = runWaitTimeouts(n(a.timeoutMs, 180_000)!);
      const results = await Promise.all(jobs.map((job) => job.result ? job : client.call<Job>("run.wait", { jobId: job.id, timeoutMs: waits.server }, waits.transport)));
      return toolText(JSON.stringify({ jobs: results.map((job) => ({ jobId: job.id, backend: job.backend, result: job.result })) }, null, 2));
    }
    if (name === "headless_project_trust") {
      const parsed = McpProjectTrustSchema.parse(a);
      const client = await daemonClient(safeCwd);
      if (parsed.action === "status") return toolJson(await client.call("project.trust.status"));
      if (parsed.action === "revoke") return toolJson(await client.call("project.trust.revoke"));
      const { action: _, ...params } = parsed;
      return toolJson(await client.call("project.trust.grant", params));
    }
    if (name === "headless_fleet_profile") {
      const parsed = McpFleetProfileSchema.parse(a);
      const client = await daemonClient(safeCwd);
      if (parsed.action === "list") return toolJson(await client.call("fleet.profile.list"));
      if (parsed.action === "get") return toolJson(await client.call("fleet.profile.get", { profileId: parsed.profileId }));
      if (parsed.action === "remove") return toolJson(await client.call("fleet.profile.remove", { profileId: parsed.profileId }));
      const { action: _, ...params } = parsed;
      return toolJson(await client.call("fleet.profile.upsert", params));
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
      const parsed = McpCollaborationSchema.parse(a);
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
      return toolJson(await client.call("collaboration.transferLeader", { goalId: parsed.goalId, agentId: parsed.agentId }));
    }
    if (name === "headless_approval") {
      const parsed = McpApprovalSchema.parse(a);
      const client = await daemonClient(safeCwd);
      if (parsed.action === "list") {
        return toolJson(await client.call("approval.list", compact({ goalId: parsed.goalId, status: parsed.status })));
      }
      return toolJson(await client.call("approval.resolve", { approvalId: parsed.approvalId, decision: parsed.decision, resolution: parsed.resolution }));
    }
    if (name === "headless_candidate") {
      const parsed = McpCandidateSchema.parse(a);
      const client = await daemonClient(safeCwd);
      const params = { candidateId: parsed.candidateId };
      if (parsed.action === "inspect") return toolJson(await client.call("candidate.inspect", params));
      if (parsed.action === "integrate") return toolJson(await client.call("candidate.integrate", params));
      return toolJson(await client.call("candidate.reject", params));
    }
    if (name === "headless_append_note") { const client = await daemonClient(safeCwd); return toolText(JSON.stringify(await client.call("ledger.note", { text: s(a.text) || "", sessionId: s(a.sessionId) }))); }
    if (name === "headless_record_artifact") { const client = await daemonClient(safeCwd); return toolText(JSON.stringify(await client.call("ledger.artifact", { kind: s(a.kind) || "note", title: s(a.title) || "", summary: s(a.summary) || "", status: s(a.status), evidence: arr(a.evidence), sessionId: s(a.sessionId) }))); }
    if (name === "headless_read_context") { const client = await daemonClient(safeCwd); return toolText(JSON.stringify(await client.call("ledger.context", { view: s(a.view), limit: n(a.limit), sessionId: s(a.sessionId) }))); }
    if (name === "headless_task_state") { const client = await daemonClient(safeCwd); return toolText(JSON.stringify(await client.call("task.list", { jobId: s(a.jobId), state: s(a.state) }))); }
    if (name === "headless_propose_final") { const client = await daemonClient(safeCwd); return toolText(JSON.stringify(await client.call("ledger.proposeFinal", { summary: s(a.summary) || "", evidence: s(a.evidence) || "", remainingRisk: s(a.remainingRisk), handlesHandoffIds: arr(a.handlesHandoffIds), sessionId: s(a.sessionId) }))); }
    if (name === "headless_ask_for_work" || name === "ask_for_more_work") {
      const client = await daemonClient(safeCwd);
      return toolText(JSON.stringify(await client.call("ledger.event", { type: "ask_for_more_work", sessionId: s(a.sessionId), payload: { content: s(a.reason) || "Ready for more work.", meta: { completed: s(a.completed), to: s(a.to) } } })));
    }
    if (name === "ask_for_work") {
      const client = await daemonClient(safeCwd);
      return toolText(JSON.stringify(await client.call("ledger.event", { type: "ask_for_more_work", sessionId: s(a.sessionId), payload: { content: s(a.reason) || "Ready for work.", meta: { to: s(a.to) } } })));
    }
    if (name === "ask_for_backup") {
      const client = await daemonClient(safeCwd);
      return toolText(JSON.stringify(await client.call("ledger.event", { type: "ask_for_backup", sessionId: s(a.sessionId), payload: { content: s(a.problem) || s(a.reason) || "Backup requested.", meta: { to: s(a.to), neededStrength: s(a.neededStrength) } } })));
    }
    if (name === "headless_record_task_claim") {
      const client = await daemonClient(safeCwd);
      return toolText(JSON.stringify(await client.call("task.claim", { taskId: s(a.taskId) || "", leaseMs: n(a.leaseMs, 300_000) })));
    }
    if (name === "headless_record_consensus_vote") {
      const v = s(a.vote) as "yes" | "no" | "consensus" | undefined;
      const client = await daemonClient(safeCwd);
      return toolText(JSON.stringify(await client.call("ledger.event", { type: "consensus_vote", sessionId: s(a.sessionId), payload: { content: `${v || "yes"}: ${s(a.proposal) || ""}`, meta: { proposal: s(a.proposal), vote: v || "yes", rationale: s(a.rationale) } } })));
    }
    if (name === "headless_record_idle_action") { const client = await daemonClient(safeCwd); return toolText(JSON.stringify(await client.call("ledger.event", { type: "idle_action_result", sessionId: s(a.sessionId), payload: { content: s(a.summary) || "", artifact: { kind: s(a.kind) || "note", title: s(a.title) || "", summary: s(a.summary) || "", status: "unknown" } } }))); }
    if (name === "headless_record_release_gate") { const client = await daemonClient(safeCwd); return toolText(JSON.stringify(await client.call("ledger.artifact", { kind: "release_gate", title: "Release gate", summary: s(a.summary) || "", status: s(a.status) || "unknown", evidence: arr(a.evidence), sessionId: s(a.sessionId) }))); }
    if (name === "headless_gate") {
      const client = await daemonClient(safeCwd);
      const gateReport = await client.call("gate.run", { checks: Array.isArray(a.checks) ? a.checks : arr(a.checks), timeoutMs: n(a.timeoutMs), sessionId: s(a.sessionId) }, boundedTransportTimeout((n(a.timeoutMs, 120_000) ?? 120_000) + 10_000));
      return toolText(JSON.stringify(gateReport));
    }
    if (name === "headless_get_cooperation_instructions") { const { getCooperationInstructions } = await import("../index"); return toolText(getCooperationInstructions("headless")); }
    if (name === "send_message") { const client = await daemonClient(safeCwd); return toolText(JSON.stringify(await client.call("ledger.event", { type: "message", sessionId: s(a.sessionId), payload: { content: s(a.content) || "", message: { to: s(a.to) || "", content: s(a.content) || "", kind: "direct" } } }))); }
    if (name === "wait_for_handoff") {
      const client = await daemonClient(safeCwd);
      const res = await waitForDaemonHandoff(client, s(a.handoffId) || "", n(a.timeoutMs, 90_000)!, s(a.sessionId));
      return toolText(JSON.stringify(res));
    }
    if (name === "get_messages") {
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
        authMode: a.authMode === "broker" ? "broker" : "native-login",
        approvalPolicy: a.approvalPolicy === "auto" || a.approvalPolicy === "bypass" ? a.approvalPolicy : "ask",
        timeoutMs: n(a.timeoutMs, 180_000),
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

function daemonClient(projectRoot: string) {
  return connectOrStartDaemon({ projectRoot, credential: { integration: "mcp" }, bootstrapIntegration: true });
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

server.oninitialized = () => {
  try {
    const srv = server as { getClientCapabilities?: () => Record<string, unknown> };
    const caps: Record<string, unknown> = srv.getClientCapabilities?.() || {};
    const exp = (caps.experimental ?? {}) as Record<string, unknown>;
    supportsChannel = !!exp["claude/channel"];
    resolvedPushMode = supportsChannel ? "push" : "pull";
  } catch { /* keep prior (optimistic push) */ }
  console.error(`[mcp] channel capability: ${supportsChannel}`);
};

export async function startMcpServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function main() {
  const shutdown = async () => {
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  await startMcpServer();
}
if (import.meta.main) main().catch((error) => {
  console.error(redactAndTruncate(error instanceof Error ? error.message : String(error), 16_384).text);
  process.exit(1);
});

export { server, TOOL_DEFINITIONS as mcpToolDefinitions }; // sendChannelPush is exported via its declaration above; mcpToolDefinitions for parity verification

// Test-only export to drive full internal tool handler paths + error branches + wait + get_messages + council for coverage of mcp/server.ts
export const __handleCallToolForTest = handleCallTool;
