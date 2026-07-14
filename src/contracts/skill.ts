import { z } from "zod";
import { BackendIdSchema, IdentifierSchema, PrincipalIdSchema, ProjectIdSchema, TimestampSchema } from "./common";

export const PortableSkillManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdentifierSchema,
  version: z.string().trim().regex(/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/).max(64),
  name: z.string().trim().min(1).max(160),
  license: z.string().trim().min(1).max(128),
  instructions: z.literal("instructions.md"),
  references: z.array(z.string().regex(/^references\/[a-zA-Z0-9._-]+\.(?:md|txt)$/)).max(32).default([]),
  tools: z.array(z.string().trim().min(1).max(128)).max(32).default([]),
  requirements: z.object({ read: z.boolean().default(true), write: z.boolean().default(false), network: z.boolean().default(false), delegation: z.boolean().default(false) }).strict().default({}),
  roles: z.array(z.string().trim().min(1).max(64)).max(32).default([]),
  providers: z.array(BackendIdSchema).max(32).default([]),
  verification: z.array(z.string().trim().min(1).max(256)).max(32).default([]),
}).strict();

export const PortableSkillRecordSchema = z.object({
  schemaVersion: z.literal(1), id: IdentifierSchema, version: z.string().max(64), projectId: ProjectIdSchema,
  source: z.string().max(1_024), contentHash: z.string().regex(/^[a-f0-9]{64}$/), license: z.string().max(128),
  manifest: PortableSkillManifestSchema, state: z.enum(["quarantined", "enabled", "revoked"]),
  importedAt: TimestampSchema, importedBy: PrincipalIdSchema, approvedAt: TimestampSchema.nullable(), approvedBy: PrincipalIdSchema.nullable(), revokedAt: TimestampSchema.nullable(),
}).strict();

export const SkillAuditEntrySchema = z.object({
  id: IdentifierSchema, projectId: ProjectIdSchema, skillId: IdentifierSchema, version: z.string().max(64), contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  arguments: z.string().max(64_000), authority: PrincipalIdSchema, receivers: z.array(z.string().max(128)).max(32), result: z.string().max(16_384), createdAt: TimestampSchema,
}).strict();

export type PortableSkillRecord = z.infer<typeof PortableSkillRecordSchema>;
