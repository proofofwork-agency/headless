import type { ApprovalRequest, DirectedMessage, FleetProfile, Goal, Turn } from "../contracts/collaboration";
import type { Task } from "../contracts/durable";
import type { RunEvent } from "../contracts/run";
import type { TaskState } from "../runtime/read-model";
import { redactAndTruncate } from "../runtime/redaction";
import { eventTone, goalStateGlyph, ACCENT, BLUE, CHROME, ERR, MUTED, OK, WARN } from "./theme";

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";

export type FleetHealthAgent = {
  id: string;
  backend: string;
  authenticated: boolean | null;
  healthy: boolean | null;
  rateLimited: boolean;
  load: number | null;
  detail: string | null;
};

export type CandidateView = {
  id: string;
  status: string;
  summary: string;
  files: string[];
  patchPreview: string | null;
  gates: Array<{ id: string; status: string }>;
};

export type OrchestrationView = {
  enabled: boolean;
  activeJobs: number;
  queuedJobs: number;
  mode: string;
};

export type ProjectTrustView = {
  trusted: boolean;
  nativeLoginAllowed: boolean;
  bypassAllowed: boolean;
};

export type TuiControlRoomState = {
  projectRoot: string;
  projectId: string | null;
  principal: string | null;
  connection: ConnectionState;
  status: string;
  events: RunEvent[];
  taskState: TaskState | null;
  durableTasks: Task[];
  orchestration: OrchestrationView;
  projectTrust: ProjectTrustView;
  fleetProfiles: FleetProfile[];
  activeFleetProfileId: string | null;
  fleetHealth: FleetHealthAgent[];
  goals: Goal[];
  activeGoalId: string | null;
  turns: Turn[];
  messages: DirectedMessage[];
  approvals: ApprovalRequest[];
  candidate: CandidateView | null;
};

const TERMINAL_GOAL_STATES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

export function initialControlRoomState(projectRoot: string): TuiControlRoomState {
  return {
    projectRoot,
    projectId: null,
    principal: null,
    connection: "connecting",
    status: "Connecting to the authenticated project daemon…",
    events: [],
    taskState: null,
    durableTasks: [],
    orchestration: { enabled: false, activeJobs: 0, queuedJobs: 0, mode: "manual" },
    projectTrust: { trusted: false, nativeLoginAllowed: false, bypassAllowed: false },
    fleetProfiles: [],
    activeFleetProfileId: null,
    fleetHealth: [],
    goals: [],
    activeGoalId: null,
    turns: [],
    messages: [],
    approvals: [],
    candidate: null,
  };
}

export function mergeRunEvents(current: readonly RunEvent[], incoming: readonly RunEvent[], limit = 480) {
  const byId = new Map(current.map((event) => [event.eventId, event]));
  for (const event of incoming) byId.set(event.eventId, event);
  return [...byId.values()]
    .sort((left, right) => left.timestamp - right.timestamp || left.sequence - right.sequence)
    .slice(-Math.max(1, limit));
}

export function selectActiveGoal(goals: readonly Goal[], preferred: string | null) {
  const usable = goals.filter((goal) => !TERMINAL_GOAL_STATES.has(goal.state));
  if (preferred && usable.some((goal) => goal.id === preferred)) return preferred;
  return [...usable].sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)[0]?.id ?? null;
}

export function activeFleetProfile(state: Pick<TuiControlRoomState, "fleetProfiles" | "activeFleetProfileId">) {
  return state.fleetProfiles.find((profile) => profile.id === state.activeFleetProfileId)
    ?? state.fleetProfiles[0]
    ?? null;
}

export function activeGoal(state: Pick<TuiControlRoomState, "goals" | "activeGoalId">) {
  return state.goals.find((goal) => goal.id === state.activeGoalId) ?? null;
}

export function pendingApprovals(state: Pick<TuiControlRoomState, "approvals">) {
  return state.approvals.filter((approval) => approval.status === "pending");
}

// ── Presentation model ──────────────────────────────────────────────────────
// Pure builders consumed by the Ink views; kept renderer-free so they stay
// unit-testable without a terminal.

export type EventLine = {
  id: string;
  time: string;
  tag: string;
  tone: string;
  text: string;
};

export function formatEventLine(event: RunEvent): EventLine {
  const detail = event.kind === "policy"
    ? event.decision
    : event.kind === "completion"
      ? event.result.status
      : event.kind === "lifecycle"
        ? event.state
        : undefined;
  return {
    id: event.eventId,
    time: new Date(event.timestamp).toLocaleTimeString(undefined, { hour12: false }),
    tag: event.kind === "lifecycle" ? event.state : event.kind,
    tone: eventTone(event.kind, detail),
    text: safeInline(eventSummary(event)),
  };
}

export function eventSummary(event: RunEvent): string {
  if (event.kind === "stdout" || event.kind === "stderr") return event.text;
  if (event.kind === "lifecycle") return event.detail ?? "";
  if (event.kind === "policy") return `${event.decision}: ${event.reason}`;
  if (event.kind === "tool") return `${event.name}: ${event.summary}`;
  if (event.kind === "artifact") return `${event.artifactKind}: ${event.summary}`;
  if (event.kind === "usage") {
    return `in ${event.usage.input ?? "?"} · out ${event.usage.output ?? "?"} · $${event.cost.amountUsd ?? "?"}`;
  }
  if (event.kind === "completion") return `${event.result.status}: ${event.result.output}`;
  return "";
}

export type AgentRow = {
  id: string;
  name: string;
  backend: string;
  glyph: string;
  tone: string;
  auth: string;
  authTone: string;
  load: string;
  detail: string;
  enabled: boolean;
};

export function fleetAgentRows(state: Pick<TuiControlRoomState, "fleetProfiles" | "activeFleetProfileId" | "fleetHealth">): AgentRow[] {
  const profile = activeFleetProfile(state);
  if (!profile) return [];
  const healthById = new Map(state.fleetHealth.map((entry) => [entry.id, entry]));
  return profile.agents.map((agent) => {
    const health = healthById.get(agent.id);
    const tone = health?.rateLimited
      ? WARN
      : health?.healthy === false
        ? ERR
        : health?.healthy === true
          ? OK
          : MUTED;
    const glyph = health?.rateLimited ? "◷" : health?.healthy === false ? "✗" : agent.enabled ? "●" : "○";
    const auth = health?.authenticated === true ? "auth ✓" : health?.authenticated === false ? "login?" : agent.authMode;
    return {
      id: agent.id,
      name: agent.name,
      backend: agent.backend,
      glyph,
      tone,
      auth,
      authTone: health?.authenticated === false ? WARN : MUTED,
      load: health?.load === null || health?.load === undefined ? "–" : String(health.load),
      detail: safeInline(health?.detail ?? `priority ${agent.priority} · turns ≤${agent.maxConcurrentTurns}`),
      enabled: agent.enabled,
    };
  });
}

export type GoalRow = {
  id: string;
  glyph: string;
  tone: string;
  state: string;
  mode: string;
  objective: string;
  active: boolean;
};

export function goalRows(state: Pick<TuiControlRoomState, "goals" | "activeGoalId">): GoalRow[] {
  return [...state.goals]
    .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
    .map((goal) => {
      const { glyph, tone } = goalStateGlyph(goal.state);
      return {
        id: goal.id,
        glyph,
        tone,
        state: goal.state,
        mode: goal.mode,
        objective: safeInline(goal.objective),
        active: goal.id === state.activeGoalId,
      };
    });
}

export type ApprovalRow = {
  id: string;
  kind: string;
  summary: string;
  requestedBy: string;
  age: string;
  expiresIn: string | null;
};

export function approvalRows(state: Pick<TuiControlRoomState, "approvals">, now = Date.now()): ApprovalRow[] {
  return pendingApprovals(state).map((approval) => ({
    id: approval.id,
    kind: approval.kind,
    summary: safeInline(approval.summary),
    requestedBy: approval.requestedBy,
    age: formatAge(now - approval.createdAt),
    expiresIn: approval.expiresAt ? formatAge(approval.expiresAt - now) : null,
  }));
}

export type ActivityEntry = {
  id: string;
  glyph: string;
  tone: string;
  text: string;
};

export function activityEntries(state: Pick<TuiControlRoomState, "messages" | "turns">, limit = 6): ActivityEntry[] {
  const entries = [
    ...state.turns.map((turn) => ({
      at: turn.completedAt ?? turn.startedAt ?? turn.updatedAt,
      order: turn.sequence,
      kind: 0,
      entry: {
        id: `turn-${turn.id}`,
        glyph: turn.state === "succeeded" ? "✓" : turn.state === "failed" ? "✗" : turn.state === "running" ? "●" : "○",
        tone: turn.state === "succeeded" ? OK : turn.state === "failed" ? ERR : turn.state === "running" ? ACCENT : MUTED,
        text: `T${turn.sequence} ${turn.agentId} · ${turn.state} · ${safeInline(turn.output ?? turn.input)}`,
      },
    })),
    ...state.messages.map((message) => ({
      at: message.createdAt,
      order: message.sequence,
      kind: 1,
      entry: {
        id: `message-${message.id}`,
        glyph: message.acknowledgedAt === null ? "◦" : "✓",
        tone: message.acknowledgedAt === null ? BLUE : CHROME,
        text: `${message.id} · ${message.senderId}→${message.recipientId} · ${message.kind} · ${safeInline(message.content)}`,
      },
    })),
  ];
  return entries
    .sort((left, right) => left.at - right.at || left.order - right.order || left.kind - right.kind)
    .slice(-Math.max(1, Math.min(32, Math.floor(limit))))
    .map((item) => item.entry);
}

/** Plain-string variant of the activity feed for logs and tests. */
export function recentActivityLines(state: Pick<TuiControlRoomState, "messages" | "turns">, limit = 4) {
  return activityEntries(state, Math.max(1, Math.min(16, Math.floor(limit)))).map((entry) => `${entry.glyph} ${entry.text}`);
}

export function formatAge(ms: number): string {
  if (!Number.isFinite(ms)) return "–";
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  if (total < 3_600) return `${Math.floor(total / 60)}m`;
  if (total < 86_400) return `${Math.floor(total / 3_600)}h${Math.floor((total % 3_600) / 60) > 0 ? ` ${Math.floor((total % 3_600) / 60)}m` : ""}`;
  return `${Math.floor(total / 86_400)}d`;
}

export function shortPath(value: string, max = 38): string {
  const home = process.env.HOME;
  const collapsed = home && value.startsWith(home) ? `~${value.slice(home.length)}` : value;
  if (collapsed.length <= max) return collapsed;
  const parts = collapsed.split("/");
  while (parts.length > 3 && parts.join("/").length > max) parts.splice(1, 1);
  const joined = parts.length < collapsed.split("/").length ? [parts[0], "…", ...parts.slice(1)].join("/") : collapsed;
  return joined.length <= max ? joined : `…${joined.slice(-(max - 1))}`;
}

export function truncateDisplay(value: string, width: number) {
  const max = Math.max(1, Math.floor(width));
  if (value.length <= max) return value;
  if (max === 1) return "…";
  return `${value.slice(0, max - 1)}…`;
}

export function safeInline(value: string) {
  return redactAndTruncate(value, 512).text
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "(empty)";
}
