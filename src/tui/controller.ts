import type { ApprovalRequest, DirectedMessage, FleetProfile, Goal, Turn } from "../contracts/collaboration";
import type { Job, Task } from "../contracts/durable";
import type { RunEvent } from "../contracts/run";
import type { HeadlessDaemonClient } from "../daemon/client";
import type { DaemonMethod } from "../daemon/protocol";
import type { TaskState } from "../runtime/read-model";
import {
  mergeRunEvents,
  selectActiveGoal,
  type CandidateView,
  type FleetHealthAgent,
  type OrchestrationView,
  type ProjectTrustView,
  type TuiControlRoomState,
} from "./model";

export type ControlRoomClient = Pick<HeadlessDaemonClient, "call">;

export type ControllerHooks = {
  getState: () => TuiControlRoomState;
  patchState: (patch: Partial<TuiControlRoomState>) => void;
  setStatus: (status: string) => void;
  exit: () => void;
};

type RefreshResult = {
  patch: Partial<TuiControlRoomState>;
  unavailable: string[];
};

export class TuiController {
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(
    private readonly client: ControlRoomClient,
    private readonly hooks: ControllerHooks,
  ) {}

  /** Dispatches immediately and intentionally never blocks Ink input handling. */
  execute(rawCommand: string) {
    const command = rawCommand.trim();
    if (!command) return;
    const lower = command.toLowerCase();

    if (lower === "q" || lower === "/quit") {
      this.hooks.exit();
      return;
    }
    if (lower === "/help" || lower === "?") {
      this.hooks.setStatus("/goal /goal-write /use-goal /cancel-goal /leader /ack-message <id> [more ids] [--retain] /fleet /use-fleet /trust /policy ask|auto|bypass /approvals /approve /deny /candidate /integrate /reject-candidate /autonomy /dispatch /gate /quit");
      return;
    }
    if (lower === "/status" || lower === "s" || lower === "/fleet" || lower === "/goals" || lower === "/approvals") {
      this.schedule("Refreshing daemon state", async () => this.refresh());
      return;
    }
    if (lower.startsWith("/goal-write ")) {
      this.startGoal(command.slice(12).trim(), "write");
      return;
    }
    if (lower.startsWith("/goal ")) {
      this.startGoal(command.slice(6).trim(), "read-only");
      return;
    }
    if (lower.startsWith("/use-goal ")) {
      const goalId = command.slice(10).trim();
      if (!goalId) return this.hooks.setStatus("Usage: /use-goal <goal-id>");
      if (!this.hooks.getState().goals.some((goal) => goal.id === goalId)) {
        return this.hooks.setStatus(`Unknown goal ${goalId}. Use /goals to refresh.`);
      }
      this.hooks.patchState({ activeGoalId: goalId, turns: [], messages: [] });
      this.schedule(`Loading ${goalId}`, async () => this.refresh());
      return;
    }
    if (lower.startsWith("/use-fleet ")) {
      const profileId = command.slice(11).trim();
      const profile = this.hooks.getState().fleetProfiles.find((candidate) => candidate.id === profileId);
      if (!profile) return this.hooks.setStatus(`Unknown fleet ${profileId || "(empty)"}. Use /fleet to refresh.`);
      this.schedule(`Activating fleet ${profileId}`, async () => {
        await this.client.call("fleet.profile.upsert", fleetProfileParams(profile));
        await this.refresh();
      });
      return;
    }
    if (lower === "/cancel-goal" || lower.startsWith("/cancel-goal ")) {
      const goalId = command.slice(12).trim() || this.activeGoalId();
      if (!goalId) return this.hooks.setStatus("No active goal to cancel.");
      this.schedule(`Cancelling ${goalId}`, async () => {
        await this.client.call("goal.cancel", { goalId });
        await this.refresh();
      });
      return;
    }
    if (lower.startsWith("/leader ")) {
      const agentId = command.slice(8).trim();
      const goalId = this.activeGoalId();
      if (!goalId || !agentId) return this.hooks.setStatus("Usage: /leader <agent-id> with an active goal.");
      this.schedule(`Transferring leadership to ${agentId}`, async () => {
        await this.client.call("collaboration.transferLeader", { goalId, agentId });
        await this.refresh();
      });
      return;
    }
    if (lower.startsWith("/send ")) {
      this.sendToCoordinator(command.slice(6).trim());
      return;
    }
    if (lower === "/ack-message" || lower.startsWith("/ack-message ")) {
      const goalId = this.activeGoalId();
      if (!goalId) return this.hooks.setStatus("No active goal has collaboration messages to acknowledge.");
      const parts = command.slice(12).trim().split(/\s+/).filter(Boolean);
      const options = parts.filter((part) => part.startsWith("--"));
      if (options.some((option) => option.toLowerCase() !== "--retain")
        || options.filter((option) => option.toLowerCase() === "--retain").length > 1) {
        return this.hooks.setStatus("Usage: /ack-message <id> [more ids] [--retain]");
      }
      const messageIds = parts.filter((part) => !part.startsWith("--"));
      if (messageIds.length === 0 || new Set(messageIds).size !== messageIds.length) {
        return this.hooks.setStatus("Usage: /ack-message <id> [more unique ids] [--retain]");
      }
      const prune = !options.some((option) => option.toLowerCase() === "--retain");
      this.schedule(`Acknowledging ${messageIds.length} message${messageIds.length === 1 ? "" : "s"}`, async () => {
        const response = await this.client.call<{
          acknowledgedMessageIds: string[];
          pruned: number;
        }>("collaboration.messages.acknowledge", { goalId, messageIds, prune });
        await this.refresh();
        const acknowledged = new Set(response.acknowledgedMessageIds);
        const messages = prune
          ? this.hooks.getState().messages.filter((message) => !acknowledged.has(message.id))
          : this.hooks.getState().messages.map((message) => acknowledged.has(message.id)
            ? { ...message, acknowledgedAt: message.acknowledgedAt ?? Math.max(Date.now(), message.createdAt) }
            : message);
        this.hooks.patchState({ messages });
        this.hooks.setStatus(`${acknowledged.size} message${acknowledged.size === 1 ? "" : "s"} acknowledged${prune ? `; ${response.pruned} pruned.` : " and retained."}`);
      }, false);
      return;
    }
    if (lower === "/trust" || lower === "/trust status") {
      this.schedule("Refreshing project trust", async () => this.refresh());
      return;
    }
    if (lower.startsWith("/trust ")) {
      const [, action, ...options] = lower.split(/\s+/);
      if (action === "revoke" && options.length === 0) {
        this.schedule("Revoking project trust", async () => {
          await this.client.call("project.trust.revoke");
          await this.refresh();
        });
        return;
      }
      if (action === "grant" && options.every((option) => option === "bypass" || option === "no-native")) {
        this.schedule("Granting project trust", async () => {
          await this.client.call("project.trust.grant", {
            nativeLoginAllowed: !options.includes("no-native"),
            bypassAllowed: options.includes("bypass"),
          });
          await this.refresh();
        });
        return;
      }
      this.hooks.setStatus("Usage: /trust status|grant [bypass] [no-native]|revoke");
      return;
    }
    if (lower.startsWith("/policy ")) {
      const approvalPolicy = lower.slice(8).trim();
      if (approvalPolicy !== "ask" && approvalPolicy !== "auto" && approvalPolicy !== "bypass") {
        return this.hooks.setStatus("Usage: /policy ask|auto|bypass");
      }
      const profile = activeFleetProfile(this.hooks.getState());
      if (!profile) return this.hooks.setStatus("No active fleet profile to update.");
      this.schedule(`Setting fleet approval policy to ${approvalPolicy}`, async () => {
        await this.client.call("fleet.profile.upsert", fleetProfileParams(profile, approvalPolicy));
        await this.refresh();
      });
      return;
    }
    if (lower.startsWith("/approve ") || lower.startsWith("/deny ")) {
      const approved = lower.startsWith("/approve ");
      const rest = command.slice(approved ? 9 : 6).trim();
      const [approvalId, ...reasonParts] = rest.split(/\s+/);
      if (!approvalId) return this.hooks.setStatus(`Usage: /${approved ? "approve" : "deny"} <approval-id> [reason]`);
      const resolution = reasonParts.join(" ") || (approved ? "Approved from the Headless TUI." : "Rejected from the Headless TUI.");
      this.schedule(`${approved ? "Approving" : "Rejecting"} ${approvalId}`, async () => {
        await this.client.call("approval.resolve", { approvalId, decision: approved ? "approved" : "rejected", resolution });
        await this.refresh();
      });
      return;
    }
    if (lower.startsWith("/candidate ")) {
      const candidateId = command.slice(11).trim();
      if (!candidateId) return this.hooks.setStatus("Usage: /candidate <candidate-id>");
      this.schedule(`Inspecting ${candidateId}`, async () => {
        const candidate = await this.client.call<unknown>("candidate.inspect", { candidateId });
        this.hooks.patchState({ candidate: normalizeCandidate(candidate, candidateId) });
      });
      return;
    }
    if (lower.startsWith("/integrate ") || lower.startsWith("/reject-candidate ")) {
      const integrating = lower.startsWith("/integrate ");
      const candidateId = command.slice(integrating ? 11 : 18).trim();
      if (!candidateId) return this.hooks.setStatus(`Usage: /${integrating ? "integrate" : "reject-candidate"} <candidate-id>`);
      this.schedule(`${integrating ? "Integrating" : "Rejecting"} ${candidateId}`, async () => {
        const result = await this.client.call<unknown>(integrating ? "candidate.integrate" : "candidate.reject", { candidateId });
        this.hooks.patchState({ candidate: normalizeCandidate(result, candidateId) });
        await this.refresh();
      });
      return;
    }
    if (lower.startsWith("/autonomy ")) {
      const value = lower.slice(10).trim();
      if (value !== "on" && value !== "off") return this.hooks.setStatus("Usage: /autonomy on|off");
      this.schedule(`Turning autonomy ${value}`, async () => {
        await this.client.call(value === "on" ? "orchestrator.start" : "orchestrator.stop");
        await this.refresh();
      });
      return;
    }
    if (lower === "/ask" || lower === "a") {
      this.schedule("Asking the coordinator for work", () => this.client.call("ledger.event", {
        type: "ask_for_more_work",
        payload: { content: "Manual ask from TUI", meta: { requestedFrom: "tui" } },
      }));
      return;
    }
    if (lower === "/backup" || lower === "/helpme") {
      this.schedule("Requesting fleet backup", () => this.client.call("ledger.event", {
        type: "ask_for_backup",
        payload: { content: "User requested backup via TUI", meta: { neededStrength: "review" } },
      }));
      return;
    }
    if (lower.startsWith("/council ")) {
      const question = command.slice(9).trim();
      this.schedule("Council running in background", () => this.client.call("council.run", { question, containment: "required" }, 750_000));
      return;
    }
    if (lower.startsWith("/workflow ")) {
      const workflowId = command.slice(10).trim();
      this.schedule(`Loading workflow ${workflowId}`, async () => {
        const workflow = await this.client.call<{ state: string; steps: Array<{ state: string }> }>("workflow.status", { workflowId });
        const terminal = workflow.steps.filter((step) => ["succeeded", "failed", "blocked", "cancelled"].includes(step.state)).length;
        this.hooks.setStatus(`Workflow ${workflowId}: ${workflow.state} (${terminal}/${workflow.steps.length} terminal)`);
      }, false);
      return;
    }
    if (lower.startsWith("/dispatch ")) {
      const [backend = "opencode", ...promptParts] = command.slice(10).trim().split(/\s+/);
      const prompt = promptParts.join(" ") || "Take the next safe step and report evidence.";
      this.schedule(`Queueing ${backend}`, async () => {
        const job = await this.client.call<Job>("run.submit", { backend, prompt, mode: "read-only", containment: "required" });
        this.hooks.setStatus(`Queued ${backend} as ${job.id}.`);
      }, false);
      return;
    }
    if (lower === "/gate" || lower === "/release") {
      this.schedule("Release gate running in background", async () => {
        const report = await this.client.call<{ ok: boolean }>("gate.run", {}, 750_000);
        this.hooks.setStatus(`Gate ${report.ok ? "passed" : "failed"}; evidence is in the event stream.`);
      }, false);
      return;
    }
    if (lower.startsWith("/claim ")) {
      const taskId = command.slice(7).trim();
      this.schedule(`Claiming ${taskId}`, async () => {
        const task = await this.client.call<Task>("task.claim", { taskId, leaseMs: 300_000 });
        this.hooks.setStatus(`Claimed ${task.id} until ${new Date(task.leaseExpiresAt ?? 0).toLocaleTimeString()}.`);
      }, false);
      return;
    }
    if (lower === "/pair") {
      const pending = this.hooks.getState().durableTasks.find((task) => task.state === "pending");
      if (!pending) return this.hooks.setStatus("No pending durable task is available to claim.");
      this.execute(`/claim ${pending.id}`);
      return;
    }
    if (lower === "/doctor") {
      const state = this.hooks.getState();
      this.hooks.setStatus(`Daemon ${state.connection}; ${state.fleetHealth.length} agents, ${state.goals.length} goals, ${state.approvals.filter((item) => item.status === "pending").length} approvals.`);
      return;
    }

    if (command.startsWith("/")) {
      this.hooks.setStatus(`Unknown command ${command.split(/\s+/)[0]}; use /help.`);
      return;
    }
    this.sendToCoordinator(command);
  }

  async refresh() {
    const result = await restoreControlRoom(this.client, this.hooks.getState());
    this.hooks.patchState(result.patch);
    if (result.unavailable.length > 0) {
      this.hooks.setStatus(`Connected; optional views unavailable: ${result.unavailable.join(", ")}.`);
    }
    return result;
  }

  async drain() {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  private activeGoalId() {
    const state = this.hooks.getState();
    return selectActiveGoal(state.goals, state.activeGoalId);
  }

  private startGoal(objective: string, mode: "read-only" | "write") {
    if (!objective) return this.hooks.setStatus(`Usage: /${mode === "write" ? "goal-write" : "goal"} <objective>`);
    this.schedule(`Starting a detached ${mode} collaborative goal`, async () => {
      const response = await this.client.call<unknown>("goal.start", { objective, mode, detach: true });
      const goal = unwrapGoal(response);
      if (goal) {
        const current = this.hooks.getState();
        this.hooks.patchState({
          goals: mergeGoals(current.goals, goal),
          activeGoalId: goal.id,
        });
        this.hooks.setStatus(`Goal ${goal.id} started; free text now goes to its coordinator.`);
      }
      await this.refresh();
    }, false);
  }

  private sendToCoordinator(text: string) {
    if (!text) return;
    this.schedule("Sending turn to the active coordinator", async () => {
      const fallbackDiagnostics: string[] = [];
      const goalId = this.activeGoalId();
      if (goalId) {
        try {
          await this.client.call("goal.send", { goalId, text });
          this.hooks.setStatus(`Turn sent to coordinator for ${goalId}.`);
          return;
        } catch (error) {
          fallbackDiagnostics.push(`goal.send: ${errorMessage(error)}`);
        }
      }
      try {
        const response = await this.client.call<unknown>("goal.start", { objective: text, detach: true });
        const goal = unwrapGoal(response);
        if (goal) {
          this.hooks.patchState({ goals: mergeGoals(this.hooks.getState().goals, goal), activeGoalId: goal.id });
          this.hooks.setStatus(`No active goal existed; started ${goal.id}.`);
          return;
        }
      } catch (error) {
        fallbackDiagnostics.push(`goal.start: ${errorMessage(error)}`);
      }
      await this.client.call("ledger.event", {
        type: "message",
        payload: {
          content: text,
          message: { from: "authenticated-tui", to: "orchestrator", content: text, kind: "direct" },
          meta: { compatibilityFallback: fallbackDiagnostics.slice(0, 2) },
        },
      });
      this.hooks.setStatus(`Coordinator turn preserved through the legacy durable channel (${fallbackDiagnostics.join("; ") || "goal API unavailable"}).`);
    }, false);
  }

  private schedule(label: string, action: () => Promise<unknown>, announceCompletion = true) {
    this.hooks.setStatus(`${label}…`);
    let task: Promise<unknown>;
    task = action()
      .then(() => {
        if (announceCompletion) this.hooks.setStatus(`${label} complete.`);
      })
      .catch((error) => {
        this.hooks.setStatus(`${label} failed: ${errorMessage(error)}`);
      })
      .finally(() => this.inFlight.delete(task));
    this.inFlight.add(task);
  }
}

export async function restoreControlRoom(client: ControlRoomClient, current: TuiControlRoomState): Promise<RefreshResult> {
  const unavailable: string[] = [];
  const call = async <T>(label: string, method: DaemonMethod, params: Record<string, unknown> = {}) => {
    try {
      return await client.call<T>(method, params);
    } catch {
      unavailable.push(label);
      return null;
    }
  };

  const [ping, trust, orchestration, fleetResponse, healthResponse, goalResponse, approvalsResponse, taskState, durableTasks] = await Promise.all([
    client.call<{ projectId: string; projectRoot: string; principal: string }>("ping"),
    call<unknown>("trust", "project.trust.status"),
    call<unknown>("autonomy", "orchestrator.status"),
    call<unknown>("fleet", "fleet.profile.list"),
    call<unknown>("health", "fleet.health"),
    call<unknown>("goals", "goal.list"),
    call<unknown>("approvals", "approval.list", { status: "pending" }),
    call<TaskState>("task state", "ledger.task"),
    call<Task[]>("tasks", "task.list"),
  ]);

  const fleet = normalizeFleetProfiles(fleetResponse);
  const goals = normalizeGoals(goalResponse);
  const activeGoalId = selectActiveGoal(goals, current.activeGoalId);
  const [turnsResponse, messagesResponse] = activeGoalId
    ? await Promise.all([
        call<unknown>("turns", "collaboration.turns", { goalId: activeGoalId, afterSequence: 0, limit: 1_000 }),
        call<unknown>("messages", "collaboration.messages", { goalId: activeGoalId, afterSequence: 0, limit: 1_000 }),
      ])
    : [null, null];

  return {
    unavailable: [...new Set(unavailable)],
    patch: {
      projectRoot: ping.projectRoot,
      projectId: ping.projectId,
      principal: ping.principal,
      connection: "connected",
      projectTrust: normalizeProjectTrust(trust),
      orchestration: normalizeOrchestration(orchestration),
      fleetProfiles: fleet.profiles,
      activeFleetProfileId: fleet.activeProfileId,
      fleetHealth: normalizeFleetHealth(healthResponse),
      goals,
      activeGoalId,
      approvals: normalizeArray<ApprovalRequest>(approvalsResponse, ["approvals", "requests"]),
      taskState: taskState ?? current.taskState,
      durableTasks: Array.isArray(durableTasks) ? durableTasks : current.durableTasks,
      turns: normalizeArray<Turn>(turnsResponse, ["turns"])
        .sort((left, right) => left.sequence - right.sequence)
        .slice(-240),
      messages: normalizeArray<DirectedMessage>(messagesResponse, ["messages"])
        .sort((left, right) => left.createdAt - right.createdAt || left.sequence - right.sequence)
        .slice(-240),
    },
  };
}

export async function subscribeControlRoom(
  client: ControlRoomClient,
  hooks: Pick<ControllerHooks, "getState" | "patchState">,
  shouldStop: () => boolean,
  refresh?: () => Promise<unknown>,
) {
  // Start from the live head so the activity log begins clear on launch instead
  // of replaying the entire (possibly days-old) ledger. The daemon reports the
  // current head as `latestCursor`; a max-cursor snapshot returns zero events
  // (the store clamps the requested cursor to the head), so this is cheap.
  let cursor = 0;
  try {
    const head = await client.call<{ latestCursor?: number; nextCursor?: number }>(
      "events.snapshot",
      { afterCursor: Number.MAX_SAFE_INTEGER, limit: 1 },
      2_500,
    );
    cursor = head.latestCursor ?? head.nextCursor ?? 0;
  } catch {
    // If the head probe fails, fall back to replaying from the beginning.
  }
  let lastRefreshAt = 0;
  while (!shouldStop()) {
    const snapshot = await client.call<{ events: RunEvent[]; nextCursor: number }>(
      "events.wait",
      { afterCursor: cursor, limit: 120, timeoutMs: 1_000 },
      2_500,
    );
    cursor = snapshot.nextCursor;
    if (snapshot.events.length > 0) {
      hooks.patchState({ events: mergeRunEvents(hooks.getState().events, snapshot.events) });
    }
    const now = Date.now();
    if (refresh && (snapshot.events.length > 0 || now - lastRefreshAt >= 5_000)) {
      await refresh();
      lastRefreshAt = now;
    }
  }
}

export async function runReconnectLoop<T>(options: {
  connect: () => Promise<T>;
  consume: (connection: T) => Promise<void>;
  shouldStop: () => boolean;
  onConnecting?: (attempt: number) => void;
  onRetry?: (error: unknown, delayMs: number) => void;
  sleep?: (delayMs: number) => Promise<void>;
  initialDelayMs?: number;
  maximumDelayMs?: number;
}) {
  const sleep = options.sleep ?? Bun.sleep;
  const maximumDelayMs = options.maximumDelayMs ?? 2_000;
  let delayMs = options.initialDelayMs ?? 250;
  let attempt = 0;
  while (!options.shouldStop()) {
    attempt += 1;
    options.onConnecting?.(attempt);
    try {
      const connection = await options.connect();
      delayMs = options.initialDelayMs ?? 250;
      await options.consume(connection);
    } catch (error) {
      if (options.shouldStop()) return;
      options.onRetry?.(error, delayMs);
      await sleep(delayMs);
      delayMs = Math.min(maximumDelayMs, delayMs * 2);
    }
  }
}

function normalizeProjectTrust(value: unknown): ProjectTrustView {
  const record = asRecord(value);
  return {
    trusted: record?.trusted === true,
    nativeLoginAllowed: record?.nativeLoginAllowed === true,
    bypassAllowed: record?.bypassAllowed === true,
  };
}

function normalizeOrchestration(value: unknown): OrchestrationView {
  const record = asRecord(value);
  const activeJobs = nonnegativeNumber(record?.activeJobs);
  const queuedJobs = nonnegativeNumber(record?.queuedJobs);
  const enabled = record?.enabled === true;
  return { enabled, activeJobs, queuedJobs, mode: enabled ? "autonomous" : "manual" };
}

function normalizeFleetProfiles(value: unknown) {
  if (Array.isArray(value)) return { profiles: value as FleetProfile[], activeProfileId: value[0]?.id ?? null };
  const record = asRecord(value);
  const profiles = normalizeArray<FleetProfile>(value, ["profiles", "items"]);
  const active = stringValue(record?.activeProfileId) ?? stringValue(asRecord(record?.activeProfile)?.id);
  return { profiles, activeProfileId: active ?? profiles[0]?.id ?? null };
}

function normalizeGoals(value: unknown) {
  return normalizeArray<Goal>(value, ["goals", "items"])
    .map((entry) => unwrapGoal(entry))
    .filter((entry): entry is Goal => entry !== null);
}

function normalizeFleetHealth(value: unknown): FleetHealthAgent[] {
  return normalizeArray<unknown>(value, ["leaderCandidates", "agents", "health", "items"]).flatMap((item) => {
    const record = asRecord(item);
    if (!record) return [];
    const agent = asRecord(record.agent);
    const id = stringValue(record.agentId) ?? stringValue(record.id) ?? stringValue(agent?.id) ?? stringValue(record.profileId);
    const backend = stringValue(record.backend) ?? stringValue(agent?.backend);
    if (!id || !backend) return [];
    const auth = record.authenticated ?? record.authAvailable ?? record.nativeAuthAvailable;
    const explicitHealth = record.healthy ?? record.available;
    const healthState = stringValue(record.health);
    const healthy = typeof explicitHealth === "boolean"
      ? explicitHealth
      : healthState === "healthy" || healthState === "degraded"
        ? true
        : healthState === "unhealthy" || healthState === "offline"
          ? false
          : null;
    const rateLimit = asRecord(record.rateLimit);
    const rateLimitedUntil = typeof record.rateLimitedUntil === "number" && Number.isFinite(record.rateLimitedUntil)
      ? record.rateLimitedUntil
      : null;
    const activeTurns = typeof record.activeTurns === "number" && Number.isFinite(record.activeTurns)
      ? Math.max(0, Math.floor(record.activeTurns))
      : null;
    return [{
      id,
      backend,
      authenticated: typeof auth === "boolean" ? auth : null,
      healthy,
      rateLimited: record.rateLimited === true || rateLimit?.limited === true || (rateLimitedUntil !== null && rateLimitedUntil > Date.now()),
      load: typeof record.load === "number" && Number.isFinite(record.load) ? record.load : activeTurns,
      detail: stringValue(record.detail) ?? stringValue(record.error) ?? null,
    }];
  });
}

function normalizeCandidate(value: unknown, fallbackId: string): CandidateView {
  const outer = asRecord(value);
  const record = asRecord(outer?.candidate) ?? outer;
  const decision = asRecord(record?.decision);
  const job = asRecord(record?.job);
  const result = asRecord(job?.result);
  const diff = asRecord(result?.diff);
  const finality = asRecord(record?.finality);
  const finalityDecision = asRecord(finality?.decision);
  const requirements = asRecord(finality?.requirements);
  const directGates = normalizeArray<unknown>(record?.gates, ["gates"]).flatMap((gate) => {
    const item = asRecord(gate);
    const id = stringValue(item?.id);
    const status = stringValue(item?.status);
    return id && status ? [{ id, status }] : [];
  });
  const gates = directGates.length > 0 ? directGates : finalityGates(finalityDecision, requirements);
  const files = Array.isArray(diff?.files)
    ? diff.files.filter((file): file is string => typeof file === "string").slice(0, 256)
    : [];
  const patch = stringValue(diff?.patch);
  const reasons = Array.isArray(record?.reasons)
    ? record.reasons.filter((reason): reason is string => typeof reason === "string")
    : [];
  const eligible = typeof record?.eligible === "boolean" ? record.eligible : null;
  return {
    id: stringValue(record?.candidateId) ?? stringValue(record?.id) ?? fallbackId,
    status: stringValue(decision?.status)
      ?? stringValue(record?.status)
      ?? stringValue(record?.state)
      ?? (eligible === null ? "inspected" : eligible ? "eligible" : "blocked"),
    summary: stringValue(record?.summary)
      ?? stringValue(record?.reason)
      ?? reasons[0]
      ?? (files.length > 0 ? `${files.length} changed file${files.length === 1 ? "" : "s"}.` : "Candidate details loaded."),
    files,
    patchPreview: patch ? patch.split(/\r?\n/).find((line) => line.trim())?.trim() ?? null : null,
    gates,
  };
}

function finalityGates(
  decision: Record<string, unknown> | null,
  requirements: Record<string, unknown> | null,
) {
  if (!decision) return [];
  return [
    ["policy", "policyPassed"],
    ["tests", "testsPassed"],
    ["review", "reviewPassed"],
    ["vote", "votePassed"],
    ["budget", "budgetPassed"],
  ].map(([id, field]) => ({
    id: id!,
    status: requirements?.[id!] === false ? "not_required" : decision[field!] === true ? "passed" : "failed",
  }));
}

function normalizeArray<T>(value: unknown, keys: string[]): T[] {
  if (Array.isArray(value)) return value as T[];
  const record = asRecord(value);
  for (const key of keys) if (Array.isArray(record?.[key])) return record[key] as T[];
  return [];
}

function unwrapGoal(value: unknown): Goal | null {
  const record = asRecord(value);
  const candidate = asRecord(record?.goal) ?? record;
  return candidate && typeof candidate.id === "string" && typeof candidate.state === "string" ? candidate as Goal : null;
}

function mergeGoals(goals: readonly Goal[], next: Goal) {
  return [...goals.filter((goal) => goal.id !== next.id), next]
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

function activeFleetProfile(state: TuiControlRoomState) {
  return state.fleetProfiles.find((profile) => profile.id === state.activeFleetProfileId)
    ?? state.fleetProfiles[0]
    ?? null;
}

function fleetProfileParams(profile: FleetProfile, approvalPolicy?: FleetProfile["approvalPolicy"]) {
  return {
    id: profile.id,
    name: profile.name,
    authMode: profile.authMode,
    approvalPolicy: approvalPolicy ?? profile.approvalPolicy,
    coordinator: profile.coordinator,
    agents: profile.agents.map((agent) => ({
      id: agent.id,
      backend: agent.backend,
      name: agent.name,
      ...(agent.model ? { model: agent.model } : {}),
      authMode: agent.authMode,
      approvalPolicy: approvalPolicy ?? agent.approvalPolicy,
      enabled: agent.enabled,
      priority: agent.priority,
      capabilities: agent.capabilities,
      maxConcurrentTurns: agent.maxConcurrentTurns,
    })),
    maxActiveWorkers: profile.maxActiveWorkers,
    maxQueuedDelegations: profile.maxQueuedDelegations,
    maxDeliberationRounds: profile.maxDeliberationRounds,
    maxAttemptsPerDelegation: profile.maxAttemptsPerDelegation,
    goalTimeoutMs: profile.goalTimeoutMs,
    idleAutonomy: profile.idleAutonomy,
    activate: true,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nonnegativeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function summarizeUnknown(value: unknown) {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  return stringValue(record?.summary) ?? stringValue(record?.status);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
