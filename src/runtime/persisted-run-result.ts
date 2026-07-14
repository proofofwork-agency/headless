import { z } from "zod";
import {
  ContainmentEvidenceSchema,
  RunEventSchema,
  RunResultSchema,
  type RunEvent,
  type RunResult,
} from "../contracts/run";

const LegacyContainmentEvidenceSchema = ContainmentEvidenceSchema.extend({
  network: z.literal("provider-direct"),
});

const PersistedRunResultSchema = z.union([
  RunResultSchema,
  RunResultSchema.extend({ containment: LegacyContainmentEvidenceSchema }),
]);

/**
 * Decode durable RunResult data written before the provider-direct rename.
 * The live contract stays strict; only this persisted-state boundary accepts
 * the one known predecessor and returns the current canonical value.
 */
export function decodePersistedRunResult(value: unknown): RunResult {
  const result = PersistedRunResultSchema.parse(value);
  if (result.containment.network !== "provider-direct") return RunResultSchema.parse(result);
  return RunResultSchema.parse({
    ...result,
    containment: {
      ...result.containment,
      network: "native-direct-unrestricted",
    },
  });
}

/** Decode a persisted event while routing completion payloads through the shared RunResult decoder. */
export function decodePersistedRunEvent(value: unknown): RunEvent {
  if (isRecord(value) && value.kind === "completion") {
    return RunEventSchema.parse({
      ...value,
      result: decodePersistedRunResult(value.result),
    });
  }
  return RunEventSchema.parse(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
