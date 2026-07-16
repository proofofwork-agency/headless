import type { ApprovalRequest, DirectedMessage, FleetProfile, Goal, Turn } from "../contracts/collaboration";
import type { Budget, Job, Task } from "../contracts/durable";
import type { RunEvent } from "../contracts/run";
import type { HeadlessDaemonClient } from "../daemon/client";
import {
  mergeRunEvents,
  selectActiveGoal,
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

type ObserverSnapshot = {
  observedAt?: number;
  projectId: string;
  projectRoot: string;
  lead: TuiControlRoomState["lead"];
  projectTrust: Omit<ProjectTrustView, "nativeDirectUnrestrictedAcknowledged"> & { nativeDirectUnrestrictedAcknowledged?: boolean };
  fleetProfiles: FleetProfile[];
  activeFleetProfileId: string | null;
  fleetHealth: {
    leaderCandidates: Array<{
      agent: { id: string; backend: string };
      authenticated: boolean;
      health: string;
      rateLimitedUntil: number | null;
      activeTurns: number;
      detail: string;
      presentation?: {
        code: string;
        reason: string;
        recovery: string;
      };
    }>;
  } | null;
  goals: Goal[];
  goalTurns: Record<string, Turn[]>;
  goalMessages: Record<string, DirectedMessage[]>;
  approvals: ApprovalRequest[];
  budgets?: Budget[];
  jobs: Job[];
  delegations?: TuiControlRoomState["delegations"];
  tasks: Task[];
  orchestration: Partial<OrchestrationView> & { enabled: boolean };
};

type ObserverEvents = {
  events: RunEvent[];
  nextCursor: number;
  cursorExpired: boolean;
};

export class TuiController {
  constructor(
    private readonly client: ControlRoomClient,
    private readonly hooks: ControllerHooks,
  ) {}

  /** The observer accepts navigation-only commands; it never dispatches work. */
  execute(rawCommand: string) {
    const command = rawCommand.trim().toLowerCase();
    if (command === "q" || command === "/quit") return this.hooks.exit();
    if (command === "/help" || command === "?") {
      this.hooks.setStatus("Observer only · use the Headless CLI or attached foreground lead for mutations.");
      return;
    }
    if (command === "/status" || command === "s" || command === "/refresh") {
      void this.refresh();
      return;
    }
    if (command.startsWith("/logs ")) {
      const mode = command.slice(6).trim();
      if (mode === "compact" || mode === "verbose" || mode === "strict") {
        this.hooks.patchState({ logMode: mode });
        this.hooks.setStatus(`Event display: ${mode}.`);
        return;
      }
    }
    this.hooks.setStatus("The TUI is read-only. Use tabs, arrows, event filters, or the Headless CLI.");
  }

  async refresh() {
    try {
      const result = await restoreControlRoom(this.client, this.hooks.getState());
      this.hooks.patchState(result.patch);
      this.hooks.setStatus("Observer snapshot refreshed.");
    } catch (error) {
      this.hooks.setStatus(`Observer refresh failed: ${messageOf(error)}`);
      throw error;
    }
  }
}

export async function restoreControlRoom(client: ControlRoomClient, current: TuiControlRoomState) {
  const [ping, snapshot, eventPage] = await Promise.all([
    client.call<{ projectId: string; projectRoot: string; principal: string }>("ping"),
    client.call<ObserverSnapshot>("observer.snapshot"),
    client.call<ObserverEvents>("observer.events", { limit: 480 }),
  ]);
  const activeGoalId = selectActiveGoal(snapshot.goals, current.activeGoalId);
  const jobs = snapshot.jobs ?? [];
  const activeJobs = jobs.filter((job) => job.state === "running").length;
  const queuedJobs = jobs.filter((job) => job.state === "queued").length;
  const orchestration: OrchestrationView = {
    enabled: snapshot.orchestration.enabled,
    activeJobs,
    queuedJobs,
    mode: snapshot.orchestration.mode ?? (snapshot.orchestration.enabled ? "automatic" : "manual"),
  };
  return {
    unavailable: [] as string[],
    patch: {
      projectId: ping.projectId,
      projectRoot: ping.projectRoot,
      principal: ping.principal,
      connection: "connected" as const,
      lead: snapshot.lead,
      projectTrust: {
        ...snapshot.projectTrust,
        nativeDirectUnrestrictedAcknowledged: snapshot.projectTrust.nativeDirectUnrestrictedAcknowledged ?? false,
      },
      fleetProfiles: snapshot.fleetProfiles,
      activeFleetProfileId: snapshot.activeFleetProfileId,
      fleetHealth: normalizeFleetHealth(snapshot.fleetHealth),
      goals: snapshot.goals,
      activeGoalId,
      turns: activeGoalId ? snapshot.goalTurns[activeGoalId] ?? [] : [],
      messages: activeGoalId ? snapshot.goalMessages[activeGoalId] ?? [] : [],
      approvals: snapshot.approvals,
      budgets: snapshot.budgets ?? [],
      delegations: snapshot.delegations ?? [],
      observedAt: typeof snapshot.observedAt === "number" && Number.isFinite(snapshot.observedAt) ? snapshot.observedAt : null,
      durableTasks: snapshot.tasks,
      orchestration,
      events: mergeRunEvents(current.events, eventPage.events),
    } satisfies Partial<TuiControlRoomState>,
  };
}

export async function subscribeControlRoom(
  client: ControlRoomClient,
  hooks: Pick<ControllerHooks, "getState" | "patchState">,
  signal: AbortSignal,
) {
  let cursor = 0;
  while (!signal.aborted) {
    const page = await client.call<ObserverEvents>("observer.events", { afterCursor: cursor, limit: 200 });
    cursor = page.cursorExpired ? 0 : page.nextCursor;
    if (page.events.length > 0) hooks.patchState({ events: mergeRunEvents(hooks.getState().events, page.events) });
    await abortableDelay(750, signal);
  }
}

export async function runReconnectLoop<T>(options: {
  connect: () => Promise<T>;
  connected: (value: T) => Promise<void>;
  failed?: (error: unknown, attempt: number) => void;
  signal: AbortSignal;
  delays?: readonly number[];
}) {
  const delays = options.delays ?? [0, 250, 1_000, 2_000, 5_000];
  let attempt = 0;
  while (!options.signal.aborted) {
    try {
      const value = await options.connect();
      await options.connected(value);
      return;
    } catch (error) {
      if (options.signal.aborted) return;
      options.failed?.(error, attempt);
      const delay = delays[Math.min(attempt, delays.length - 1)] ?? 5_000;
      attempt += 1;
      await abortableDelay(delay, options.signal);
    }
  }
}

function normalizeFleetHealth(snapshot: ObserverSnapshot["fleetHealth"]): FleetHealthAgent[] {
  return (snapshot?.leaderCandidates ?? []).map((entry) => ({
    id: entry.agent.id,
    backend: entry.agent.backend,
    authenticated: entry.authenticated,
    healthy: entry.health === "healthy" || entry.health === "degraded",
    rateLimited: entry.rateLimitedUntil !== null && entry.rateLimitedUntil > Date.now(),
    load: entry.activeTurns,
    detail: entry.detail,
    presentation: entry.presentation
      ? {
          code: entry.presentation.code,
          reason: entry.presentation.reason,
          recovery: entry.presentation.recovery,
        }
      : null,
  }));
}

function abortableDelay(ms: number, signal: AbortSignal) {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
