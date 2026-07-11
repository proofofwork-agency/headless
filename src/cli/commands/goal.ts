import type { Goal } from "../../contracts/collaboration";
import type { DaemonMethod } from "../../daemon/protocol";
import type { HeadlessDaemonClient } from "../../daemon/client";
import {
  CliUsageError,
  daemonClient,
  flagArgsBeforeSeparator,
  getArg,
  getApprovalPolicy,
  getAuthMode,
  getMode,
  getPrompt,
  parseIntegerArg,
  requiredArg,
} from "../shared";

export const GOAL_DEFAULT_TIMEOUT_MS = 3_600_000;
export const GOAL_FOLLOW_POLL_MS = 250;
const TERMINAL_GOAL_STATES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

export type GoalCommandCall = {
  action: "start" | "run" | "send" | "follow" | "status" | "list" | "cancel" | "result";
  method: Extract<DaemonMethod, `goal.${string}`>;
  params: Record<string, unknown>;
  timeoutMs?: number;
};

export function parseGoalCommand(args: string[]): GoalCommandCall {
  const action = (args[1] ?? "list") as GoalCommandCall["action"];
  const flags = flagArgsBeforeSeparator(args);
  if (action === "start" || action === "run") {
    const objective = getPrompt(["goal", ...args.slice(2)]);
    if (!objective) throw new CliUsageError(`A goal objective is required for goal ${action}.`);
    const timeoutMs = parseIntegerArg(flags, "--timeout-ms") ?? GOAL_DEFAULT_TIMEOUT_MS;
    return {
      action,
      method: "goal.start",
      params: {
        objective,
        mode: getMode(flags),
        fleetProfileId: getArg(flags, "--fleet-profile-id"),
        coordinator: parseCoordinator(getArg(flags, "--coordinator")),
        authMode: getAuthMode(flags),
        approvalPolicy: getApprovalPolicy(flags),
        autonomous: flags.includes("--autonomous"),
        timeoutMs,
        detach: flags.includes("--detach") || action === "start",
      },
      timeoutMs,
    };
  }
  if (action === "send") {
    const text = getPrompt(["goal", ...args.slice(2)]);
    if (!text) throw new CliUsageError("A coordinator message is required for goal send.");
    return {
      action,
      method: "goal.send",
      params: { goalId: requiredArg(flags, "--goal-id"), text },
    };
  }
  if (action === "list") return { action, method: "goal.list", params: {} };
  if (["follow", "status", "cancel", "result"].includes(action)) {
    const goalId = requiredArg(flags, "--goal-id");
    return {
      action,
      method: action === "follow" ? "goal.status" : `goal.${action}`,
      params: { goalId },
      timeoutMs: action === "follow" ? parseIntegerArg(flags, "--timeout-ms") ?? GOAL_DEFAULT_TIMEOUT_MS : undefined,
    };
  }
  throw new CliUsageError("Usage: headless goal <start|run|send|follow|status|list|cancel|result> [options]");
}

export async function runGoalCommand(args: string[]) {
  const flags = flagArgsBeforeSeparator(args);
  const call = parseGoalCommand(args);
  const client = await daemonClient(getArg(flags, "--cwd") || process.cwd(), flags);

  if (call.action === "follow") {
    const outcome = await followGoal(client, String(call.params.goalId), call.timeoutMs ?? GOAL_DEFAULT_TIMEOUT_MS);
    printGoalOutcome(outcome);
    return;
  }

  const response = await client.call(call.method, compact(call.params));
  if (call.action === "run" && !flags.includes("--detach")) {
    const goalId = goalIdFromResponse(response);
    if (!goalId) throw new Error("goal.start did not return a durable goal id.");
    const goal = goalFromResponse(response);
    if (goal && TERMINAL_GOAL_STATES.has(goal.state)) {
      printGoalOutcome({ goal, result: await client.call("goal.result", { goalId }) });
      return;
    }
    printGoalOutcome(await followGoal(client, goalId, call.timeoutMs ?? GOAL_DEFAULT_TIMEOUT_MS));
    return;
  }

  console.log(JSON.stringify(response, null, 2));
  setGoalExitCode(goalFromResponse(response));
}

export async function followGoal(client: HeadlessDaemonClient, goalId: string, timeoutMs = GOAL_DEFAULT_TIMEOUT_MS) {
  const startedAt = Date.now();
  let latest: Goal | null = null;
  let afterSequence = 0;
  while (Date.now() - startedAt < timeoutMs) {
    latest = await client.call<Goal>("goal.status", { goalId });
    afterSequence = await printNewTurns(client, goalId, afterSequence);
    if (TERMINAL_GOAL_STATES.has(latest.state)) {
      const result = await client.call("goal.result", { goalId });
      return { goal: latest, result };
    }
    await Bun.sleep(GOAL_FOLLOW_POLL_MS);
  }
  throw new CliUsageError(`Timed out after ${timeoutMs}ms waiting for goal ${goalId}. The goal remains durable and can be followed again.`);
}

function parseCoordinator(value?: string) {
  if (!value) return undefined;
  if (value === "human" || value === "automatic" || value === "election") return { kind: value };
  if (value.startsWith("agent:") && value.length > "agent:".length) return { kind: "agent", agentId: value.slice("agent:".length) };
  throw new CliUsageError("Invalid --coordinator. Expected human, automatic, election, or agent:<agent-id>.");
}

async function printNewTurns(client: HeadlessDaemonClient, goalId: string, afterSequence: number) {
  try {
    const response = await client.call<unknown>("collaboration.turns", { goalId, afterSequence, limit: 200 });
    const turns = Array.isArray(response)
      ? response
      : response && typeof response === "object" && "turns" in response && Array.isArray(response.turns)
        ? response.turns
        : [];
    let latest = afterSequence;
    for (const turn of turns) {
      if (!turn || typeof turn !== "object") continue;
      const sequence = "sequence" in turn && typeof turn.sequence === "number" ? turn.sequence : 0;
      if (sequence <= afterSequence) continue;
      latest = Math.max(latest, sequence);
      const agent = "agentId" in turn ? String(turn.agentId) : "agent";
      const state = "state" in turn ? String(turn.state) : "updated";
      const output = "output" in turn && typeof turn.output === "string" ? `: ${turn.output}` : "";
      console.error(`[goal ${goalId}] ${agent} ${state}${output}`);
    }
    return latest;
  } catch {
    // Status polling remains authoritative when turn streaming is unavailable.
    return afterSequence;
  }
}

function goalIdFromResponse(value: unknown): string | null {
  const goal = goalFromResponse(value);
  if (goal) return goal.id;
  if (value && typeof value === "object" && "goalId" in value && typeof value.goalId === "string") return value.goalId;
  if (value && typeof value === "object" && "id" in value && typeof value.id === "string") return value.id;
  return null;
}

function goalFromResponse(value: unknown): Goal | null {
  if (!value || typeof value !== "object") return null;
  if ("goal" in value && value.goal && typeof value.goal === "object") return value.goal as Goal;
  if ("state" in value && "id" in value && typeof value.id === "string") return value as Goal;
  return null;
}

function printGoalOutcome(outcome: unknown) {
  console.log(JSON.stringify(outcome, null, 2));
  const goal = goalFromResponse(outcome);
  setGoalExitCode(goal);
}

function setGoalExitCode(goal: Goal | null) {
  if (goal && TERMINAL_GOAL_STATES.has(goal.state)) process.exitCode = goal.state === "succeeded" ? 0 : 1;
}

function compact(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
