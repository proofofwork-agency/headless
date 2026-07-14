import { z } from "zod";
import type { RunResult } from "../contracts/run";

const rate = z.number().finite().nonnegative();

export const PricingEntrySchema = z.object({
  id: z.string().trim().min(1).max(256),
  provider: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  model: z.string().trim().min(1).max(256),
  source: z.string().trim().min(1).max(1_024).default("operator-supplied"),
  effectiveFrom: z.number().int().nonnegative(),
  effectiveTo: z.number().int().positive().nullable().default(null),
  inputUsdPerMillion: rate,
  outputUsdPerMillion: rate,
  cachedInputUsdPerMillion: rate.nullable().default(null),
  inputIncludesCached: z.boolean().default(true),
}).strict().superRefine((entry, context) => {
  if (entry.effectiveTo !== null && entry.effectiveTo <= entry.effectiveFrom) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["effectiveTo"], message: "effectiveTo must be later than effectiveFrom." });
  }
});

export type PricingEntry = z.infer<typeof PricingEntrySchema>;

const customPricing = new Map<string, PricingEntry>();

/**
 * A run request does not expose a provider-specific output-token switch. Use a
 * stable, deliberately conservative planning value for durable admission;
 * the broker still enforces the concrete per-request maximum before egress.
 */
export const DEFAULT_RUN_OUTPUT_TOKEN_ESTIMATE = 4_096;

export function registerPricing(input: z.input<typeof PricingEntrySchema>) {
  const entry = PricingEntrySchema.parse(input);
  if (customPricing.has(entry.id)) throw new Error(`Pricing entry ${entry.id} is already registered.`);
  customPricing.set(entry.id, entry);
  return { ...entry };
}

export function unregisterPricing(id: string) {
  return customPricing.delete(id);
}

export function listPricing(provider?: string, model?: string) {
  return [...customPricing.values()]
    .filter((entry) => !provider || entry.provider === provider.toLowerCase())
    .filter((entry) => !model || entry.model === model || entry.model === "*")
    .sort((left, right) => left.effectiveFrom - right.effectiveFrom)
    .map((entry) => ({ ...entry }));
}

export function resolvePricing(provider: string, model: string, at = Date.now()) {
  const candidates = listPricing(provider, model)
    .filter((entry) => (entry.model === model || entry.model === "*") && entry.effectiveFrom <= at && (entry.effectiveTo === null || at < entry.effectiveTo))
    .sort((left, right) => {
      if ((left.model === model) !== (right.model === model)) return left.model === model ? -1 : 1;
      return right.effectiveFrom - left.effectiveFrom;
    });
  return candidates[0] ?? null;
}

export function calculatePricedCost(input: {
  provider: string;
  model: string;
  usage: RunResult["usage"];
  at?: number;
  observedRequests?: number;
}): RunResult["cost"] {
  const pricing = resolvePricing(input.provider, input.model, input.at);
  if (!pricing) return unknownCost(input.observedRequests);

  const { usage } = input;
  if (usage.input === null || usage.output === null) {
    return { ...unknownCost(input.observedRequests), pricingId: pricing.id };
  }

  const cached = usage.cached ?? 0;
  if (pricing.inputIncludesCached && cached > usage.input) {
    return { ...unknownCost(input.observedRequests), pricingId: pricing.id };
  }
  const ordinaryInput = pricing.inputIncludesCached ? usage.input - cached : usage.input;
  const cachedRate = pricing.cachedInputUsdPerMillion ?? pricing.inputUsdPerMillion;
  const amountUsd = (
    ordinaryInput * pricing.inputUsdPerMillion
    + cached * cachedRate
    + usage.output * pricing.outputUsdPerMillion
  ) / 1_000_000;

  return {
    amountUsd,
    source: "broker",
    pricingId: pricing.id,
    observedRequests: input.observedRequests ?? 0,
  };
}

export function calculateModelPricedCost(input: {
  provider: string;
  model: string;
  usage: RunResult["usage"];
  at?: number;
  observedRequests?: number;
}) {
  for (const model of pricingModelCandidates(input.provider, input.model)) {
    const cost = calculatePricedCost({ ...input, model });
    if (cost.amountUsd !== null) return cost;
  }
  return unknownCost(input.observedRequests);
}

export function estimateRunCost(input: {
  provider: string | null;
  model: string | undefined;
  prompt: string;
  outputTokens?: number;
  at?: number;
}) {
  const inputTokens = Math.max(1, Math.ceil(Buffer.byteLength(input.prompt) / 4));
  const outputTokens = input.outputTokens ?? DEFAULT_RUN_OUTPUT_TOKEN_ESTIMATE;
  if (!Number.isSafeInteger(outputTokens) || outputTokens < 0) {
    throw new TypeError("Estimated output tokens must be a non-negative safe integer.");
  }
  const cost = input.provider && input.model
    ? calculateModelPricedCost({
        provider: input.provider,
        model: input.model,
        usage: {
          input: inputTokens,
          output: outputTokens,
          reasoning: null,
          cached: 0,
          providerTotal: inputTokens + outputTokens,
        },
        at: input.at,
      })
    : unknownCost();
  return { inputTokens, outputTokens, cost };
}

export function pricingModelCandidates(provider: string, model: string) {
  const candidates = new Set([model]);
  for (const prefix of [`${provider}/`, "google/", "gemini/"]) {
    if (model.startsWith(prefix)) candidates.add(model.slice(prefix.length));
  }
  return [...candidates];
}

function unknownCost(observedRequests = 0): RunResult["cost"] {
  return { amountUsd: null, source: "unknown", pricingId: null, observedRequests };
}
