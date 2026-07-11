import { redactAndTruncate } from "./redaction";

export const GOAL_PLAN_HEADER = "HEADLESS_PLAN_V1";
export const MAX_GOAL_PLAN_DELEGATIONS = 64;

export type GoalPlanDelegation = {
  id: string;
  task: string;
  capabilities: string[];
};

export type ParsedGoalPlan = {
  source: "planner" | "fallback";
  delegations: GoalPlanDelegation[];
  reason: string | null;
};

export function parseGoalPlan(output: string | null, fallbackTask: string): ParsedGoalPlan {
  const fallback = (reason: string): ParsedGoalPlan => ({
    source: "fallback",
    delegations: [{ id: "fallback-1", task: boundedTask(fallbackTask), capabilities: [] }],
    reason,
  });
  if (!output) return fallback("Planner returned no output.");
  const normalized = output.replaceAll("\r\n", "\n");
  const separator = normalized.indexOf("\n");
  if (separator < 0 || normalized.slice(0, separator).trim() !== GOAL_PLAN_HEADER) {
    return fallback(`Planner omitted the required ${GOAL_PLAN_HEADER} header.`);
  }
  const body = normalized.slice(separator + 1).trim();
  if (!body || Buffer.byteLength(body) > 48_000) return fallback("Planner JSON was empty or exceeded its bound.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return fallback("Planner JSON was malformed.");
  }
  if (!isPlainObject(parsed) || !hasOnlyKeys(parsed, ["delegations"]) || !Array.isArray(parsed.delegations)) {
    return fallback("Planner JSON did not match the strict delegation envelope.");
  }
  if (parsed.delegations.length === 0 || parsed.delegations.length > MAX_GOAL_PLAN_DELEGATIONS) {
    return fallback(`Planner delegation count must be between 1 and ${MAX_GOAL_PLAN_DELEGATIONS}.`);
  }
  const delegations: GoalPlanDelegation[] = [];
  const ids = new Set<string>();
  for (const value of parsed.delegations) {
    if (!isPlainObject(value) || !hasOnlyKeys(value, ["id", "task", "capabilities"])) {
      return fallback("A planner delegation contained unknown or missing fields.");
    }
    if (typeof value.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.id) || ids.has(value.id)) {
      return fallback("Planner delegation ids must be unique bounded identifiers.");
    }
    if (typeof value.task !== "string" || value.task.trim().length === 0 || value.task.length > 8_192 || Buffer.byteLength(value.task) > 16_384) {
      return fallback("A planner delegation task was empty or exceeded its bound.");
    }
    if (!Array.isArray(value.capabilities) || value.capabilities.length > 16) {
      return fallback("A planner delegation capability list exceeded its bound.");
    }
    const capabilities: string[] = [];
    for (const capability of value.capabilities) {
      if (typeof capability !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(capability) || capabilities.includes(capability)) {
        return fallback("Planner capabilities must be unique bounded identifiers.");
      }
      capabilities.push(capability);
    }
    ids.add(value.id);
    delegations.push({ id: value.id, task: boundedTask(value.task), capabilities });
  }
  return { source: "planner", delegations, reason: null };
}

function boundedTask(value: string) {
  return redactAndTruncate(value.trim(), 8_192).text;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, expected: string[]) {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index]);
}
