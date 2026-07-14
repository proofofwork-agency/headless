import { z } from "zod";
import { BackendIdSchema, IdentifierSchema, PrincipalIdSchema, ProjectIdSchema, TimestampSchema } from "./common";

export const AuthModeSchema = z.enum(["native-login", "broker"]);
export const ApprovalPolicySchema = z.enum(["ask", "auto", "bypass"]);
export const CredentialAccessSchema = z.enum(["backend-native", "broker-lease", "none"]);
export const SessionDriverKindSchema = z.enum([
  "codex-app-server",
  "codex-exec-resume",
  "claude-print-resume",
  "opencode-session",
  "grok-resume",
  "transcript-replay",
]);

export const NativeCapabilitySnapshotSchema = z.object({
  nativeResume: z.boolean(),
  persistentTransport: z.boolean(),
  structuredEvents: z.boolean(),
  cancellation: z.boolean(),
  providerDirect: z.boolean(),
  discoveredAt: TimestampSchema,
}).strict();

export const ProjectTrustSchema = z.object({
  version: z.literal(1),
  projectId: ProjectIdSchema,
  trusted: z.boolean(),
  nativeLoginAllowed: z.boolean(),
  nativeDirectUnrestrictedAcknowledged: z.boolean().default(false),
  bypassAllowed: z.boolean(),
  trustedBy: PrincipalIdSchema.nullable(),
  trustedAt: TimestampSchema.nullable(),
  revokedAt: TimestampSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.trusted && (value.trustedBy === null || value.trustedAt === null || value.revokedAt !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Active project trust requires an issuer and timestamp." });
  }
  if (!value.trusted && value.nativeLoginAllowed) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Native login cannot be allowed for an untrusted project." });
  }
  if (!value.trusted && value.nativeDirectUnrestrictedAcknowledged) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Native direct-egress acknowledgement requires project trust." });
  }
});

export const NativeSessionMetadataSchema = z.object({
  driverKind: SessionDriverKindSchema,
  nativeSessionId: z.string().min(1).max(512).nullable(),
  backendVersion: z.string().max(128).nullable(),
  authProfileFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  capabilities: NativeCapabilitySnapshotSchema.nullable(),
  lastTurnId: IdentifierSchema.nullable(),
  rateLimit: z.object({
    limited: z.boolean(),
    retryAfterMs: z.number().int().nonnegative().max(86_400_000).nullable(),
    detectedAt: TimestampSchema.nullable(),
    attempt: z.number().int().nonnegative().max(16),
  }).strict(),
  recovery: z.object({
    state: z.enum(["ready", "reconnecting", "replaying", "lost", "closed"]),
    reason: z.string().max(4_096).nullable(),
    updatedAt: TimestampSchema,
  }).strict(),
}).strict();

export const NativeAuthCapsuleManifestSchema = z.object({
  version: z.literal(1),
  backend: BackendIdSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(z.string().min(1).max(512)).max(32),
  createdAt: TimestampSchema,
}).strict();

export type AuthMode = z.infer<typeof AuthModeSchema>;
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;
export type CredentialAccess = z.infer<typeof CredentialAccessSchema>;
export type PersistedSessionDriverKind = z.infer<typeof SessionDriverKindSchema>;
export type NativeCapabilitySnapshot = z.infer<typeof NativeCapabilitySnapshotSchema>;
export type ProjectTrust = z.infer<typeof ProjectTrustSchema>;
export type NativeSessionMetadata = z.infer<typeof NativeSessionMetadataSchema>;
export type NativeAuthCapsuleManifest = z.infer<typeof NativeAuthCapsuleManifestSchema>;
