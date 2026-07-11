import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { PrincipalIdSchema, ProjectIdSchema, TimestampSchema } from "../contracts/common";
import { atomicWriteFile } from "./atomic-write";
import { ensureOwnerOnlyFile, ensureProjectStateDirectories, type ProjectStatePaths } from "./project-state";
import { readOwnerOnlyJson, writeOwnerOnlyJson } from "./owner-json";
import { HeadlessError } from "./headless-error";

export const CredentialScopeSchema = z.enum([
  "admin",
  "run",
  "task",
  "ledger:read",
  "ledger:write",
  "messages",
  "council",
  "gate",
  "orchestrator",
  "session",
]);
export type CredentialScope = z.infer<typeof CredentialScopeSchema>;

export const DEFAULT_INTEGRATION_SCOPES: CredentialScope[] = [
  "run",
  "task",
  "ledger:read",
  "ledger:write",
  "messages",
  "council",
  "gate",
  "session",
];

const CredentialRecordSchema = z.object({
  id: z.string().min(1).max(128),
  principal: PrincipalIdSchema,
  kind: z.enum(["root", "integration"]),
  tokenDigest: z.string().regex(/^[a-f0-9]{64}$/),
  scopes: z.array(CredentialScopeSchema).min(1).max(32),
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema.nullable(),
  revokedAt: TimestampSchema.nullable(),
}).strict();

const CredentialStateSchema = z.object({
  version: z.literal(2),
  projectId: ProjectIdSchema,
  credentials: z.array(CredentialRecordSchema).max(256),
  updatedAt: TimestampSchema,
}).strict();

export type CredentialRecord = z.infer<typeof CredentialRecordSchema>;
export type AuthenticatedCredential = Omit<CredentialRecord, "tokenDigest">;

export class CredentialStore {
  private state: z.infer<typeof CredentialStateSchema>;

  constructor(
    private readonly paths: ProjectStatePaths,
    root: { token: string; principal: string },
    private readonly now: () => number = Date.now,
  ) {
    ensureProjectStateDirectories(paths);
    const existing = readOwnerOnlyJson(paths.credentialsPath, CredentialStateSchema);
    this.state = existing ?? {
      version: 2,
      projectId: ProjectIdSchema.parse(paths.projectId),
      credentials: [],
      updatedAt: this.now(),
    };
    if (this.state.projectId !== paths.projectId) throw new Error("Credential registry project mismatch.");
    this.upsertRoot(root.token, root.principal);
  }

  authenticate(token: string): AuthenticatedCredential | null {
    const digest = tokenDigest(token);
    const now = this.now();
    for (const record of this.state.credentials) {
      if (!safeDigestEqual(record.tokenDigest, digest)) continue;
      if (record.revokedAt !== null || (record.expiresAt !== null && record.expiresAt <= now)) return null;
      const { tokenDigest: _tokenDigest, ...authenticated } = record;
      return structuredClone(authenticated);
    }
    return null;
  }

  provisionIntegration(actor: AuthenticatedCredential, name: string, scopes = DEFAULT_INTEGRATION_SCOPES) {
    this.assertAdmin(actor);
    const normalized = integrationName(name);
    const tokenPath = integrationTokenPath(this.paths, normalized);
    const normalizedScopes = [...new Set(scopes.map((scope) => CredentialScopeSchema.parse(scope)))];
    const revoked = this.state.credentials.find((record) => record.id === `integration:${normalized}` && record.revokedAt !== null);
    if (revoked) {
      throw new HeadlessError("CREDENTIAL_REVOKED", `Integration credential ${revoked.id} was revoked and cannot be reprovisioned implicitly.`);
    }
    const existing = this.state.credentials.find((record) => record.id === `integration:${normalized}` && record.revokedAt === null);
    if (existing && existsSync(tokenPath)) {
      ensureOwnerOnlyFile(tokenPath);
      const token = readFileSync(tokenPath, "utf8").trim();
      if (safeDigestEqual(existing.tokenDigest, tokenDigest(token))) {
        if (!sameScopes(existing.scopes, normalizedScopes)) {
          existing.scopes = normalizedScopes;
          this.persist();
        }
        return { credential: publicRecord(existing), tokenPath };
      }
    }

    const token = randomBytes(48).toString("base64url");
    const now = this.now();
    const record = CredentialRecordSchema.parse({
      id: `integration:${normalized}`,
      principal: `integration:${normalized}`,
      kind: "integration",
      tokenDigest: tokenDigest(token),
      scopes: normalizedScopes,
      createdAt: now,
      expiresAt: null,
      revokedAt: null,
    });
    this.state.credentials = this.state.credentials.filter((candidate) => candidate.id !== record.id);
    this.state.credentials.push(record);
    atomicWriteFile(tokenPath, `${token}\n`, { mode: 0o600 });
    ensureOwnerOnlyFile(tokenPath);
    this.persist();
    return { credential: publicRecord(record), tokenPath };
  }

  revoke(actor: AuthenticatedCredential, id: string) {
    this.assertAdmin(actor);
    const record = this.state.credentials.find((candidate) => candidate.id === id && candidate.kind !== "root");
    if (!record) throw new Error(`Unknown revocable credential: ${id}`);
    if (record.revokedAt === null) record.revokedAt = this.now();
    this.persist();
    return publicRecord(record);
  }

  authorize(credential: AuthenticatedCredential, scope: CredentialScope) {
    return credential.scopes.includes("admin") || credential.scopes.includes(scope);
  }

  list(actor: AuthenticatedCredential) {
    this.assertAdmin(actor);
    return this.state.credentials.map(publicRecord);
  }

  private upsertRoot(token: string, principal: string) {
    const parsedPrincipal = PrincipalIdSchema.parse(principal);
    const now = this.now();
    const existing = this.state.credentials.find((record) => record.kind === "root");
    if (existing) {
      existing.principal = parsedPrincipal;
      existing.tokenDigest = tokenDigest(token);
      existing.scopes = ["admin"];
      existing.revokedAt = null;
    } else {
      this.state.credentials.push(CredentialRecordSchema.parse({
        id: "root",
        principal: parsedPrincipal,
        kind: "root",
        tokenDigest: tokenDigest(token),
        scopes: ["admin"],
        createdAt: now,
        expiresAt: null,
        revokedAt: null,
      }));
    }
    this.persist();
  }

  private assertAdmin(actor: AuthenticatedCredential) {
    if (!actor.scopes.includes("admin")) throw new HeadlessError("POLICY_DENIED", "Credential administration requires the root credential.");
  }

  private persist() {
    this.state.updatedAt = this.now();
    this.state = CredentialStateSchema.parse(this.state);
    writeOwnerOnlyJson(this.paths.credentialsPath, this.state);
  }
}

export function integrationTokenPath(paths: ProjectStatePaths, name: string) {
  return join(paths.integrationsDir, `${integrationName(name)}.token`);
}

export function readIntegrationToken(paths: ProjectStatePaths, name: string) {
  const path = integrationTokenPath(paths, name);
  ensureOwnerOnlyFile(path);
  return readFileSync(path, "utf8").trim();
}

function integrationName(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) throw new TypeError("Integration credential name is invalid.");
  return normalized;
}

function tokenDigest(token: string) {
  if (typeof token !== "string" || token.length < 32 || token.length > 512) return "0".repeat(64);
  return createHash("sha256").update(token).digest("hex");
}

function safeDigestEqual(left: string, right: string) {
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function publicRecord(record: CredentialRecord): AuthenticatedCredential {
  const { tokenDigest: _tokenDigest, ...value } = record;
  return structuredClone(value);
}

function sameScopes(left: CredentialScope[], right: CredentialScope[]) {
  return left.length === right.length && left.every((scope) => right.includes(scope));
}
