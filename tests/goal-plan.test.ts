import { describe, expect, test } from "bun:test";
import { GOAL_PLAN_HEADER, MAX_GOAL_PLAN_DELEGATIONS, parseGoalPlan } from "../src/runtime/goal-plan";

describe("strict bounded goal plans", () => {
  test("accepts only the versioned delegation envelope", () => {
    expect(parseGoalPlan(`${GOAL_PLAN_HEADER}\n${JSON.stringify({
      delegations: [
        { id: "inspect", task: "Inspect the durable state.", capabilities: ["analysis"] },
        { id: "verify", task: "Verify the reported evidence.", capabilities: [] },
      ],
    })}`, "fallback")).toEqual({
      source: "planner",
      reason: null,
      delegations: [
        { id: "inspect", task: "Inspect the durable state.", capabilities: ["analysis"] },
        { id: "verify", task: "Verify the reported evidence.", capabilities: [] },
      ],
    });
  });

  test("falls back deterministically for malformed, unknown-field, duplicate, or oversized plans", () => {
    const invalid = [
      "not-json",
      `${GOAL_PLAN_HEADER}\n{"delegations":[{"id":"a","task":"x","capabilities":[],"authority":"admin"}]}`,
      `${GOAL_PLAN_HEADER}\n{"delegations":[{"id":"a","task":"x","capabilities":[]},{"id":"a","task":"y","capabilities":[]}]}`,
      `${GOAL_PLAN_HEADER}\n${JSON.stringify({
        delegations: Array.from({ length: MAX_GOAL_PLAN_DELEGATIONS + 1 }, (_, index) => ({
          id: `work-${index}`,
          task: "bounded",
          capabilities: [],
        })),
      })}`,
    ];
    for (const output of invalid) {
      const parsed = parseGoalPlan(output, "safe deterministic fallback");
      expect(parsed.source).toBe("fallback");
      expect(parsed.delegations).toEqual([{
        id: "fallback-1",
        task: "safe deterministic fallback",
        capabilities: [],
      }]);
      expect(parsed.reason).not.toBeNull();
    }
  });

  test("accepts one valid envelope when a provider replays the same planner header", () => {
    const envelope = `${GOAL_PLAN_HEADER}\n${JSON.stringify({ delegations: [{ id: "build", task: "Build the game.", capabilities: [] }] })}`;
    expect(parseGoalPlan(`${envelope}\n${envelope}`, "fallback")).toMatchObject({
      source: "planner",
      delegations: [{ id: "build", task: "Build the game.", capabilities: [] }],
    });
  });

});
