import { afterEach, describe, expect, test } from "bun:test";
import { calculatePricedCost, estimateRunCost, registerPricing, resolvePricing, unregisterPricing } from "../src/runtime/pricing";

const ids: string[] = [];

afterEach(() => {
  for (const id of ids.splice(0)) unregisterPricing(id);
});

function add(id: string, overrides: Record<string, unknown> = {}) {
  ids.push(id);
  return registerPricing({
    id,
    provider: "test-provider",
    model: "test-model",
    effectiveFrom: 1_000,
    inputUsdPerMillion: 2,
    outputUsdPerMillion: 8,
    cachedInputUsdPerMillion: 0.5,
    ...overrides,
  });
}

describe("dated model pricing", () => {
  test("selects the newest exact model price effective at the run time", () => {
    add("old", { effectiveTo: 2_000 });
    add("new", { effectiveFrom: 2_000 });
    expect(resolvePricing("test-provider", "test-model", 1_999)?.id).toBe("old");
    expect(resolvePricing("test-provider", "test-model", 2_000)?.id).toBe("new");
  });

  test("prices cached input separately without double-counting token totals", () => {
    add("priced");
    const cost = calculatePricedCost({
      provider: "test-provider",
      model: "test-model",
      usage: { input: 1_000_000, output: 500_000, reasoning: 100_000, cached: 200_000, providerTotal: 1_500_000 },
      at: 1_500,
      observedRequests: 2,
    });
    expect(cost).toEqual({ amountUsd: 5.7, source: "broker", pricingId: "priced", observedRequests: 2 });
  });

  test("never reports zero when pricing or the dimensions needed for pricing are unknown", () => {
    expect(calculatePricedCost({
      provider: "unknown",
      model: "unknown",
      usage: { input: 0, output: 0, reasoning: null, cached: null, providerTotal: 0 },
    }).amountUsd).toBeNull();
    add("incomplete");
    expect(calculatePricedCost({
      provider: "test-provider",
      model: "test-model",
      usage: { input: null, output: 1, reasoning: null, cached: null, providerTotal: null },
      at: 1_500,
    }).amountUsd).toBeNull();
  });

  test("produces a deterministic model-aware run admission estimate", () => {
    add("estimate", { effectiveFrom: 0 });
    expect(estimateRunCost({
      provider: "test-provider",
      model: "test-provider/test-model",
      prompt: "12345678",
      outputTokens: 10,
    })).toEqual({
      inputTokens: 2,
      outputTokens: 10,
      cost: { amountUsd: 0.000084, source: "broker", pricingId: "estimate", observedRequests: 0 },
    });
    expect(estimateRunCost({
      provider: "test-provider",
      model: "missing",
      prompt: "x",
      outputTokens: 1,
    }).cost.amountUsd).toBeNull();
  });

  test("rejects overlapping registration IDs and invalid effective ranges", () => {
    add("unique");
    expect(() => add("unique")).toThrow("already registered");
    expect(() => add("invalid-range", { effectiveFrom: 5, effectiveTo: 5 })).toThrow("effectiveTo");
  });
});
