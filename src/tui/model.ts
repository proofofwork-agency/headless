import type { ApprovalRequest, DirectedMessage, FleetProfile, Goal, Turn } from "../contracts/collaboration";
import type { Task } from "../contracts/durable";
import type { RunEvent } from "../contracts/run";
import type { TaskState } from "../runtime/read-model";
import { redactAndTruncate } from "../runtime/redaction";

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

export type ControlRoomView = {
  narrow: boolean;
  compact: boolean;
  eventRows: number;
  title: string;
  projectLine: string;
  fleetLines: string[];
  goalLines: string[];
  approvalLines: string[];
  candidateLines: string[];
  activityLines: string[];
  queueLine: string;
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

export function mergeRunEvents(current: readonly RunEvent[], incoming: readonly RunEvent[], limit = 240) {
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

export function buildControlRoomView(state: TuiControlRoomState, width: number, height: number): ControlRoomView {
  const columns = boundedDimension(width, 96);
  const rows = boundedDimension(height, 28);
  const narrow = columns < 82;
  const compact = rows < 24 || columns < 58;
  const contentWidth = Math.max(16, narrow ? columns - 6 : Math.floor(columns / 2) - 7);
  const activeFleet = state.fleetProfiles.find((profile) => profile.id === state.activeFleetProfileId)
    ?? state.fleetProfiles[0]
    ?? null;
  const activeGoal = state.goals.find((goal) => goal.id === state.activeGoalId) ?? null;
  const pendingApprovals = state.approvals.filter((approval) => approval.status === "pending");
  const feedWidth = Math.max(16, columns - 6);

  const healthById = new Map(state.fleetHealth.map((entry) => [entry.id, entry]));
  const fleetLines = activeFleet?.agents.slice(0, compact ? 2 : 4).map((agent) => {
    const health = healthById.get(agent.id);
    const marker = health?.rateLimited ? "⏳" : health?.healthy === false ? "×" : health?.authenticated === false ? "!" : "•";
    const auth = health?.authenticated === true ? "auth" : health?.authenticated === false ? "login?" : agent.authMode;
    const load = health?.load === null || health?.load === undefined ? "" : ` load:${health.load}`;
    return truncateDisplay(`${marker} ${agent.name} · ${agent.backend} · ${auth}${load}`, contentWidth);
  }) ?? [truncateDisplay("No fleet profile configured", contentWidth)];

  const goalLines = activeGoal
    ? [
        truncateDisplay(`${activeGoal.state} · ${activeGoal.objective}`, contentWidth),
        truncateDisplay(`leader ${activeGoal.leaderAgentId ?? coordinatorLabel(activeGoal)} · ${state.turns.length} turns · ${state.messages.length} messages`, contentWidth),
      ]
    : [truncateDisplay("No active goal · enter free text to start one", contentWidth)];

  const approvalLines = pendingApprovals.length === 0
    ? [truncateDisplay("No pending approvals", contentWidth)]
    : pendingApprovals.slice(0, compact ? 1 : 3).map((approval) => truncateDisplay(
      `! ${approval.id} · ${approval.kind} · ${approval.summary}`,
      contentWidth,
    ));

  const candidateLines = state.candidate
    ? [
        truncateDisplay(`${state.candidate.id} · ${state.candidate.status}`, contentWidth),
        truncateDisplay(state.candidate.summary || "Candidate details loaded", contentWidth),
        ...(state.candidate.files.length > 0
          ? [truncateDisplay(`files ${state.candidate.files.join(", ")}`, contentWidth)]
          : []),
        ...(state.candidate.patchPreview
          ? [truncateDisplay(`diff ${state.candidate.patchPreview}`, contentWidth)]
          : []),
        truncateDisplay(state.candidate.gates.map((gate) => `${gate.id}:${gate.status}`).join(" ") || "no gates reported", contentWidth),
      ]
    : [truncateDisplay("No candidate selected · /candidate <id>", contentWidth)];

  const trust = state.projectTrust.nativeLoginAllowed ? "native✓" : "native–";
  const bypass = state.projectTrust.bypassAllowed ? "bypass✓" : "bypass–";
  const feedRows = Math.max(3, Math.min(14, rows - (narrow ? 18 : 13)));
  const activityLines = recentActivityLines(state, compact ? 2 : 4)
    .map((line) => truncateDisplay(line, feedWidth));
  return {
    narrow,
    compact,
    eventRows: Math.max(1, feedRows - activityLines.length),
    title: `HEADLESS · ${state.connection.toUpperCase()} · ${state.orchestration.enabled ? "AUTO" : "MANUAL"}`,
    projectLine: truncateDisplay(`${state.projectRoot} · ${trust} · ${bypass}`, Math.max(16, columns - 6)),
    fleetLines,
    goalLines,
    approvalLines,
    candidateLines,
    activityLines,
    queueLine: truncateDisplay(
      `queue ${state.orchestration.queuedJobs} · active ${state.orchestration.activeJobs} · tasks ${state.durableTasks.filter((task) => task.state === "pending").length} · approvals ${pendingApprovals.length} · policy ${activeFleet?.approvalPolicy ?? "ask"}`,
      Math.max(16, columns - 6),
    ),
  };
}

export function recentActivityLines(state: Pick<TuiControlRoomState, "messages" | "turns">, limit = 4) {
  const entries = [
    ...state.turns.map((turn) => ({
      at: turn.completedAt ?? turn.startedAt ?? turn.updatedAt,
      order: turn.sequence,
      kind: 0,
      line: `T${turn.sequence} ${turn.agentId} · ${turn.state} · ${safeInline(turn.output ?? turn.input)}`,
    })),
    ...state.messages.map((message) => ({
      at: message.createdAt,
      order: message.sequence,
      kind: 1,
      line: `${message.acknowledgedAt === null ? "○" : "✓"} ${message.id} · ${message.senderId}→${message.recipientId} · ${message.kind} · ${safeInline(message.content)}`,
    })),
  ];
  return entries
    .sort((left, right) => left.at - right.at || left.order - right.order || left.kind - right.kind)
    .slice(-Math.max(1, Math.min(16, Math.floor(limit))))
    .map((entry) => entry.line);
}

export function truncateDisplay(value: string, width: number) {
  const max = Math.max(1, Math.floor(width));
  if (value.length <= max) return value;
  if (max === 1) return "…";
  return `${value.slice(0, max - 1)}…`;
}

function boundedDimension(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function coordinatorLabel(goal: Goal) {
  if (goal.coordinator.kind === "human") return "human";
  if (goal.coordinator.kind === "agent") return goal.coordinator.agentId;
  return goal.coordinator.kind;
}

function safeInline(value: string) {
  return redactAndTruncate(value, 512).text
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "(empty)";
}
