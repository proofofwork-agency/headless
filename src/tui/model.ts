import type { ApprovalRequest, DirectedMessage, FleetProfile, Goal, Turn } from "../contracts/collaboration";
import type { Task } from "../contracts/durable";
import type { RunEvent } from "../contracts/run";
import type { TaskState } from "../runtime/read-model";
import { redactAndTruncate } from "../runtime/redaction";
import { eventTone, goalStateGlyph, ACCENT, BLUE, CHROME, ERR, MUTED, OK, WARN } from "./theme";
import { selectLogEvents, type LogDisplayMode } from "../runtime/log-presentation";

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
  lead: {
    host: string;
    backendId: string;
    generation: number;
    status: "configured" | "connected" | "disconnected";
  } | null;
  logMode: LogDisplayMode;
};

const TERMINAL_GOAL_STATES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

export type OperatorStatus = "Ready" | "Login required" | "Blocked by containment" | "Provider unavailable" | "Rate limited" | "Disabled" | "Running" | "Waiting for approval" | "Succeeded" | "Failed";

export type HumanFailure = { title: string; explanation: string; nextAction: string; diagnostic?: string };

export function providerReadiness(agent: FleetHealthAgent, enabled = true): OperatorStatus {
  if (!enabled) return "Disabled";
  if (agent.rateLimited) return "Rate limited";
  if (agent.authenticated === false) return "Login required";
  if (agent.healthy === true) return "Ready";
  if (/contain|safety controls|unsupported|project (?:hooks|configuration)|mcp|skills/i.test(agent.detail ?? "")) return "Blocked by containment";
  return "Provider unavailable";
}

export function humanizeFailure(value: string, backend?: string): HumanFailure {
  const diagnostic = safeInline(value);
  if (/keychain-only|regular-file.*login|native.?auth.*unavailable|not logged in|login required/i.test(diagnostic)) return {
    title: "Login required",
    explanation: backend === "claude-code" || /claude/i.test(diagnostic)
      ? "Supported login file not found."
      : "Headless could not find supported provider login state.",
    nextAction: "Log in again with the provider CLI, or choose broker mode when supported.",
    diagnostic,
  };
  if (/stream disconnected|error sending request|provider endpoint|connection ended/i.test(diagnostic)) return {
    title: "Provider unavailable",
    explanation: "The provider connection ended before completion.",
    nextAction: "Check provider connectivity, refresh health, and retry.",
    diagnostic,
  };
  if (/contain|safety controls|does not disable|project configuration|startup hooks|mcp|skills/i.test(diagnostic)) return {
    title: "Blocked by containment",
    explanation: "This backend cannot satisfy the required project-safety controls.",
    nextAction: "Use a compatible backend; do not weaken containment for this run.",
    diagnostic,
  };
  if (/rate.?limit|too many requests|429/i.test(diagnostic)) return {
    title: "Rate limited", explanation: "The provider is temporarily refusing new work.", nextAction: "Wait, then refresh health and retry.", diagnostic,
  };
  return { title: "Failed", explanation: "The operation did not complete.", nextAction: "Open Events for details, correct the cause, and retry.", diagnostic };
}

export function controlSummary(state: TuiControlRoomState) {
  const goal = activeGoal(state);
  const profile = activeFleetProfile(state);
  return {
    connection: state.connection,
    project: safeInline(state.projectId ?? state.projectRoot),
    interface: "observer",
    orchestrator: state.orchestration.mode || (state.orchestration.enabled ? "auto" : "manual"),
    core: "external",
    fleet: profile?.name ?? "none",
    lead: state.lead ? `${state.lead.host}:${state.lead.status}` : "not configured",
  };
}

export function healthSummary(state: TuiControlRoomState) {
  const profile = activeFleetProfile(state);
  const enabled = new Map(profile?.agents.map((agent) => [agent.id, agent.enabled]) ?? []);
  const statuses = state.fleetHealth.map((agent) => providerReadiness(agent, enabled.get(agent.id) ?? true));
  return {
    daemon: state.connection === "connected" ? "Ready" as const : "Provider unavailable" as const,
    trust: state.projectTrust.trusted,
    ready: statuses.filter((status) => status === "Ready").length,
    loginRequired: statuses.filter((status) => status === "Login required").length,
    blocked: statuses.filter((status) => status === "Blocked by containment" || status === "Provider unavailable" || status === "Rate limited").length,
    queue: state.orchestration.queuedJobs,
    approvals: pendingApprovals(state).length,
  };
}

export function goalSummary(state: TuiControlRoomState) {
  const goal = activeGoal(state);
  if (!goal) return null;
  return { id: goal.id, objective: safeInline(goal.objective), mode: goal.mode, lead: goal.synthesizerAgentId ?? goal.synthesizer.kind, stage: goal.state, status: TERMINAL_GOAL_STATES.has(goal.state) ? (goal.state === "succeeded" ? "Succeeded" : "Failed") : "Running" };
}

export type NextAction = { id: string; label: string; command: string; risk: "safe" | "confirm"; reason: string };
export function nextActions(state: TuiControlRoomState): NextAction[] {
  const actions: NextAction[] = [];
  if (state.connection !== "connected") actions.push({ id: "refresh", label: "Reconnect", command: "automatic", risk: "safe", reason: "The observer is waiting for the daemon." });
  if (!state.lead) actions.push({ id: "lead", label: "Configure a lead", command: "headless lead use <host>", risk: "safe", reason: "No foreground lead is configured." });
  if (pendingApprovals(state)[0]) actions.push({ id: "approval", label: "Review in CLI", command: "headless approval list", risk: "safe", reason: "The observer cannot resolve approvals." });
  if (!state.projectTrust.trusted) actions.push({ id: "trust", label: "Review trust in CLI", command: "headless project trust status", risk: "safe", reason: "The observer cannot change project trust." });
  return actions.slice(0, 4);
}

export type GroupedEvent = { event: RunEvent; count: number };
export type EventFilter = "all" | "errors" | "activity" | "failures" | "lifecycle" | "provider" | "policy" | "goal";
export function filterEvents(events: readonly RunEvent[], filter: EventFilter, goalId?: string | null, goalSessionIds: readonly string[] = [], mode: LogDisplayMode = "verbose") {
  if (filter === "failures") return events.filter((event) => event.kind === "stderr" || event.kind === "completion" && event.result.status !== "succeeded");
  const selected = selectLogEvents(events, mode, filter === "errors" ? "errors" : filter === "activity" ? "activity" : "all");
  if (filter === "all") return selected;
  if (filter === "errors" || filter === "activity") return selected;
  return selected.filter((event) => {
    if (filter === "lifecycle") return event.kind === "lifecycle";
    if (filter === "provider") return event.kind === "stdout" || event.kind === "stderr" || event.kind === "completion";
    if (filter === "policy") return event.kind === "policy";
    if (filter === "goal") return goalId ? (("goalId" in event && event.goalId === goalId) || (event.sessionId !== null && goalSessionIds.includes(event.sessionId))) : false;
    return true;
  });
}
export function groupRepeatedEvents(events: readonly RunEvent[]): GroupedEvent[] {
  return events.reduce<GroupedEvent[]>((groups, event) => {
    const previous = groups.at(-1);
    const line = formatEventLine(event);
    const prior = previous ? formatEventLine(previous.event) : null;
    if (previous && prior?.tag === line.tag && prior.text === line.text) previous.count += 1;
    else groups.push({ event, count: 1 });
    return groups;
  }, []);
}

export type GoalHistoryMode = "recent" | "all" | "grouped";
export function goalHistoryFilter(goals: readonly Goal[], mode: GoalHistoryMode, recentLimit = 8) {
  const sorted = [...goals].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
  if (mode === "all" || mode === "grouped") return mode === "grouped"
    ? sorted.sort((a, b) => Number(TERMINAL_GOAL_STATES.has(a.state)) - Number(TERMINAL_GOAL_STATES.has(b.state)) || a.state.localeCompare(b.state) || b.updatedAt - a.updatedAt)
    : sorted;
  const active = sorted.filter((goal) => !TERMINAL_GOAL_STATES.has(goal.state));
  const recent = sorted.filter((goal) => TERMINAL_GOAL_STATES.has(goal.state)).slice(0, Math.max(0, recentLimit - active.length));
  return [...active, ...recent];
}

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
    lead: null,
    logMode: "compact",
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
    text: humanizeEventText(safeInlineOptional(eventSummary(event)) ?? ""),
  };
}

export function humanizeEventText(text: string): string {
  if (/keychain-only|regular-file.*login|native.?auth.*unavailable/i.test(text)) return "Login unavailable: use supported file-based credentials or broker mode."
  if (/stream disconnected|error sending request|provider endpoint|connection ended before completion/i.test(text)) return "Provider disconnected — retry or reassign."
  if (/does not disable:.*project configuration.*startup hooks.*MCP.*skills/i.test(text)) return "Backend blocked: required safety controls are unsupported."
  return text;
}

export function eventSummary(event: RunEvent): string {
  if (event.kind === "stdout" || event.kind === "stderr") return event.text;
  if (event.kind === "lifecycle") return event.detail ?? "";
  if (event.kind === "policy") return `${event.decision}: ${event.reason}`;
  if (event.kind === "tool") return `${event.name}: ${event.summary}`;
  if (event.kind === "artifact") return `${event.artifactKind}: ${event.summary}`;
  if (event.kind === "usage") {
    const parts = [];
    if (event.usage.input !== null) parts.push(`in ${event.usage.input}`);
    if (event.usage.output !== null) parts.push(`out ${event.usage.output}`);
    if (event.cost.amountUsd !== null) parts.push(`$${event.cost.amountUsd}`);
    return parts.join(" · ");
  }
  if (event.kind === "completion") {
    const detail = event.result.output || event.result.error?.message || "No diagnostic was reported.";
    if (event.result.status === "failed" || event.result.status === "blocked") {
      const failure = humanizeFailure(detail, event.result.backend);
      return `${failure.title}: ${failure.explanation} ${failure.nextAction}`;
    }
    return `${event.result.status}: ${detail}`;
  }
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
  readiness: OperatorStatus;
  recovery: HumanFailure | null;
};

export function fleetAgentRows(state: Pick<TuiControlRoomState, "fleetProfiles" | "activeFleetProfileId" | "fleetHealth">): AgentRow[] {
  const profile = activeFleetProfile(state);
  if (!profile) return [];
  const healthById = new Map(state.fleetHealth.map((entry) => [entry.id, entry]));
  return profile.agents.map((agent) => {
    const health = healthById.get(agent.id);
    const readiness = health ? providerReadiness(health, agent.enabled) : agent.enabled ? "Provider unavailable" : "Disabled";
    const tone = health?.rateLimited
      ? WARN
      : health?.healthy === false
        ? ERR
        : health?.healthy === true
          ? OK
          : MUTED;
    const glyph = health?.rateLimited ? "◷" : health?.healthy === false ? "✗" : agent.enabled ? "●" : "○";
    const auth = health?.authenticated === false
      ? "login required"
      : health?.healthy === false
        ? "blocked"
        : health?.authenticated === true ? "login ✓" : agent.authMode;
    return {
      id: agent.id,
      name: agent.name,
      backend: agent.backend,
      glyph,
      tone,
      auth,
      authTone: health?.authenticated === false ? WARN : MUTED,
      load: health?.load === null || health?.load === undefined ? "–" : String(health.load),
      detail: health?.authenticated === false
        ? `Login required: use the ${agent.backend} CLI login, then run /fleet health. ${safeInline(health.detail ?? "")}`
        : safeInline(health?.detail ?? `priority ${agent.priority} · turns ≤${agent.maxConcurrentTurns}`),
      enabled: agent.enabled,
      readiness,
      recovery: readiness === "Ready" || readiness === "Disabled" ? null : humanizeFailure(health?.detail ?? readiness, agent.backend),
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

export function goalRows(state: Pick<TuiControlRoomState, "goals" | "activeGoalId"> & { historyMode?: GoalHistoryMode }): GoalRow[] {
  return goalHistoryFilter(state.goals, state.historyMode ?? "recent")
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
        text: turnActivityText(turn),
      },
    })),
    ...state.messages.filter((message) => !["lifecycle", "delegation", "completion"].includes(message.kind) && safeInlineOptional(message.content) !== null).map((message) => ({
      at: message.createdAt,
      order: message.sequence,
      kind: 1,
      entry: {
        id: `message-${message.id}`,
        glyph: message.acknowledgedAt === null ? "◦" : "✓",
        tone: message.acknowledgedAt === null ? BLUE : CHROME,
        text: `${message.senderId} → ${message.recipientId}: ${safeInlineOptional(message.content)}`,
      },
    })),
  ];
  return entries
    .sort((left, right) => left.at - right.at || left.order - right.order || left.kind - right.kind)
    .slice(-Math.max(1, Math.min(32, Math.floor(limit))))
    .map((item) => item.entry);
}

function turnActivityText(turn: Turn) {
  const role = turnRole(turn.input);
  const subject = `${turn.agentId} ${role}`;
  if (turn.state === "queued") return `${subject} — queued`;
  if (turn.state === "running" || turn.state === "waiting") return `${subject} — ${turn.state}`;
  if (turn.state === "cancelled" || turn.state === "timed_out") return `${subject} — ${turn.state.replace("_", " ")}`;
  const output = safeInlineOptional(turn.output);
  if (turn.state === "failed") {
    const failure = humanizeFailure(output ?? "Turn failed.");
    const outcome = failure.title === "Provider unavailable" ? "Provider disconnected" : failure.title;
    return `${subject} — ${outcome} (failed)`;
  }
  if (role === "planner") return `${subject} — plan ready`;
  return `${subject} — succeeded${output ? ` · ${truncateDisplay(output, 96)}` : ""}`;
}

function turnRole(input: string) {
  if (input.startsWith("You are the sticky task synthesizer planning")) return "planner";
  if (input.startsWith("Execute the assigned independent delegation")) return "worker";
  if (input.startsWith("Act as the sticky task synthesizer")) return "candidate";
  if (input.startsWith("Review the actual candidate output")) return "reviewer";
  if (input.startsWith("Revise candidate")) return "revision";
  return "turn";
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

function safeInlineOptional(value: string | null | undefined) {
  if (!value?.trim()) return null;
  const text = safeInline(value);
  return text === "(empty)" ? null : text;
}
