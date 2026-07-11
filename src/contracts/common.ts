import { z } from "zod";

export const BackendIdSchema = z.string().trim().min(1).max(64);
export const PrincipalIdSchema = z.string().trim().min(1).max(128);
export const ProjectIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const IdentifierSchema = z.string().trim().min(1).max(160);
export const TimestampSchema = z.number().int().nonnegative();
export const PositiveTimeoutSchema = z.number().int().positive().max(86_400_000);
export const MAX_RUN_PROMPT_BYTES = 500_000;
export const BoundedTextSchema = z.string()
  .max(MAX_RUN_PROMPT_BYTES)
  .refine((value) => Buffer.byteLength(value) <= MAX_RUN_PROMPT_BYTES, `Text must not exceed ${MAX_RUN_PROMPT_BYTES} UTF-8 bytes.`);

export const RunModeSchema = z.enum(["read-only", "write"]);
export const ContainmentRequirementSchema = z.enum(["required", "unsafe"]);

export const RunErrorCodeSchema = z.enum([
  "INVALID_REQUEST",
  "UNSUPPORTED_PLATFORM",
  "CONTAINMENT_UNAVAILABLE",
  "BACKEND_UNAVAILABLE",
  "BACKEND_UNSUPPORTED",
  "AUTH_UNAVAILABLE",
  "NATIVE_AUTH_UNAVAILABLE",
  "NATIVE_SESSION_LOST",
  "APPROVAL_REQUIRED",
  "RATE_LIMITED",
  "QUEUE_CAPACITY_EXCEEDED",
  "POLICY_DENIED",
  "BUDGET_EXCEEDED",
  "CANCELLED",
  "TIMED_OUT",
  "OUTPUT_OVERFLOW",
  "PARSE_ERROR",
  "PROCESS_ERROR",
  "DAEMON_UNAVAILABLE",
  "DAEMON_ALREADY_RUNNING",
  "DAEMON_SHUTDOWN_INCOMPLETE",
  "EXTENSION_CONFIG_MISMATCH",
  "DAEMON_AUTH_FAILED",
  "CREDENTIAL_MISSING",
  "CREDENTIAL_REVOKED",
  "CONFLICT",
  "GATE_FAILED",
  "INTERNAL_ERROR",
]);

export const MAX_ERROR_MESSAGE_LENGTH = 16_384;
export const MAX_ERROR_DETAILS_BYTES = 131_072;

const ErrorDetailsSchema = z.record(z.unknown()).refine((value) => {
  try {
    return Buffer.byteLength(JSON.stringify(value)) <= MAX_ERROR_DETAILS_BYTES;
  } catch {
    return false;
  }
}, "Error details exceed the serialized byte limit.");

export const StructuredErrorSchema = z.object({
  code: RunErrorCodeSchema,
  message: z.string().min(1).max(MAX_ERROR_MESSAGE_LENGTH),
  retryable: z.boolean().default(false),
  details: ErrorDetailsSchema.optional(),
});

export type RunErrorCode = z.infer<typeof RunErrorCodeSchema>;
export type StructuredError = z.infer<typeof StructuredErrorSchema>;
