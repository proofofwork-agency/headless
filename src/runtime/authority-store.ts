import { z } from "zod";
import { GrantSchema, type Grant } from "../contracts/durable";
import { BackendIdSchema, PrincipalIdSchema, ProjectIdSchema, TimestampSchema } from "../contracts/common";
import { ensureProjectStateDirectories, type ProjectStatePaths } from "./project-state";
import { readOwnerOnlyJson, writeOwnerOnlyJson } from "./owner-json";

export const GrantOperationSchema = z.enum(["run", "write", "merge", "council", "workflow", "admin"]);
export type GrantOperation = z.infer<typeof GrantOperationSchema>;

const AuthorityStateSchema = z.object({
  version: z.literal(3),
  projectId: ProjectIdSchema,
  rootPrincipal: PrincipalIdSchema,
  grants: z.array(GrantSchema),
  iterationUses: z.array(z.object({
    grantId: z.string().min(1).max(160),
    iterationId: z.string().min(1).max(160),
    usedAt: TimestampSchema,
  }).strict()).max(100_000),
  updatedAt: TimestampSchema,
}).strict();

const LegacyAuthorityStateSchema = z.object({
  version: z.literal(2),
  projectId: ProjectIdSchema,
  coordinator: PrincipalIdSchema,
  grants: z.array(GrantSchema),
  updatedAt: TimestampSchema,
}).strict();

const AuthorizationRequestSchema = z.object({
  projectId: ProjectIdSchema,
  principal: PrincipalIdSchema,
  operation: GrantOperationSchema,
  backend: BackendIdSchema,
  estimatedCostUsd: z.number().nonnegative().nullable().default(null),
  merge: z.boolean().default(false),
  at: TimestampSchema.optional(),
}).strict();

export type AuthorityState = z.infer<typeof AuthorityStateSchema>;
export type AuthorizationRequest = z.input<typeof AuthorizationRequestSchema>;
export type AuthorizationDecision = {
  allowed: boolean;
  root: boolean;
  grantId: string | null;
  mergeAllowed: boolean;
  maxCostUsd: number | null;
  reason: string;
};

export type AuthorityStoreOptions = {
  rootPrincipal?: string;
  coordinator?: string;
  foregroundLead?: () => string | null;
  now?: () => number;
};

export class AuthorityStore {
  readonly projectId: string;
  private readonly now: () => number;
  private state: AuthorityState;

  constructor(private readonly paths: ProjectStatePaths, private readonly options: AuthorityStoreOptions = {}) {
    ensureProjectStateDirectories(paths);
    this.projectId = ProjectIdSchema.parse(paths.projectId);
    this.now = options.now ?? Date.now;

    const persisted = readOwnerOnlyJson(paths.policyPath, z.union([AuthorityStateSchema, LegacyAuthorityStateSchema]));
    const existing = persisted?.version === 2 ? AuthorityStateSchema.parse({
      version: 3,
      projectId: persisted.projectId,
      rootPrincipal: persisted.coordinator,
      grants: persisted.grants,
      iterationUses: [],
      updatedAt: persisted.updatedAt,
    }) : persisted;
    if (existing) {
      if (existing.projectId !== this.projectId) {
        throw new Error(`Policy project mismatch: expected ${this.projectId}, got ${existing.projectId}`);
      }
      const rootPrincipal = options.rootPrincipal ?? options.coordinator;
      if (rootPrincipal && rootPrincipal !== existing.rootPrincipal) {
        throw new Error(`Configured root principal does not match persisted root ${existing.rootPrincipal}.`);
      }
      this.state = existing;
      this.persist();
      return;
    }

    const rootPrincipal = PrincipalIdSchema.parse(options.rootPrincipal ?? options.coordinator);
    this.state = AuthorityStateSchema.parse({
      version: 3,
      projectId: this.projectId,
      rootPrincipal,
      grants: [],
      iterationUses: [],
      updatedAt: this.now(),
    });
    this.persist();
  }

  getState() {
    return AuthorityStateSchema.parse(this.state);
  }

  authorize(input: AuthorizationRequest): AuthorizationDecision {
    const request = AuthorizationRequestSchema.parse(input);
    if (request.projectId !== this.projectId) {
      return denied(`Principal is not authorized for project ${request.projectId}.`);
    }

    if (request.principal === this.state.rootPrincipal) {
      return {
        allowed: true,
        root: true,
        grantId: null,
        mergeAllowed: true,
        maxCostUsd: null,
        reason: "Root CLI authority.",
      };
    }

    const foregroundLead = this.options.foregroundLead?.();
    if (foregroundLead === request.principal && request.operation !== "admin" && request.operation !== "merge" && !request.merge) {
      return {
        allowed: true,
        root: false,
        grantId: null,
        mergeAllowed: false,
        maxCostUsd: null,
        reason: "Active foreground lead authority; primary integration remains human- or grant-controlled.",
      };
    }

    const at = request.at ?? this.now();
    const requiredOperations = new Set<GrantOperation>([request.operation]);
    if (request.merge) requiredOperations.add("merge");

    const grant = this.state.grants.find((candidate) => {
      if (candidate.projectId !== this.projectId || candidate.principal !== request.principal) return false;
      if (candidate.revokedAt !== null || candidate.expiresAt <= at) return false;
      if (!candidate.backends.includes(request.backend)) return false;
      if (![...requiredOperations].every((operation) => candidate.operations.includes(operation))) return false;
      if (candidate.maxCostUsd !== null) {
        if (request.estimatedCostUsd === null || request.estimatedCostUsd > candidate.maxCostUsd) return false;
      }
      if (candidate.maxIterations !== null && candidate.usedIterations >= candidate.maxIterations) return false;
      return true;
    });

    if (!grant) {
      return denied("No active grant covers the requested project, operation, backend, merge authority, and cost.");
    }

    return {
      allowed: true,
      root: false,
      grantId: grant.id,
      mergeAllowed: grant.operations.includes("merge"),
      maxCostUsd: grant.maxCostUsd,
      reason: `Authorized by grant ${grant.id}.`,
    };
  }

  addGrant(actor: string, value: Grant) {
    this.assertCoordinator(actor);
    const grant = GrantSchema.parse(value);
    if (grant.projectId !== this.projectId) {
      throw new Error(`Grant project mismatch: expected ${this.projectId}, got ${grant.projectId}`);
    }
    if (grant.issuedBy !== this.state.rootPrincipal) {
      throw new Error("Grant issuer must be the root principal.");
    }
    if (grant.createdAt > grant.expiresAt) {
      throw new Error("Grant expiry must not precede its creation time.");
    }
    if (this.state.grants.some((candidate) => candidate.id === grant.id)) {
      throw new Error(`Grant already exists: ${grant.id}`);
    }

    this.state.grants.push(grant);
    this.state.updatedAt = this.now();
    this.persist();
    return GrantSchema.parse(grant);
  }

  revokeGrant(actor: string, grantId: string) {
    this.assertCoordinator(actor);
    const grant = this.state.grants.find((candidate) => candidate.id === grantId);
    if (!grant) throw new Error(`Unknown grant: ${grantId}`);
    if (grant.revokedAt === null) grant.revokedAt = this.now();
    this.state.updatedAt = this.now();
    this.persist();
    return GrantSchema.parse(grant);
  }

  consumeIteration(grantId: string | null, iterationId: string) {
    if (!grantId) return null;
    const grant = this.state.grants.find((candidate) => candidate.id === grantId);
    if (!grant || grant.revokedAt !== null || grant.expiresAt <= this.now()) throw new Error(`Grant ${grantId} is unavailable.`);
    const parsedIterationId = z.string().min(1).max(160).parse(iterationId);
    if (this.state.iterationUses.some((use) => use.grantId === grantId && use.iterationId === parsedIterationId)) return GrantSchema.parse(grant);
    if (grant.maxIterations !== null && grant.usedIterations >= grant.maxIterations) throw new Error(`Grant ${grantId} exhausted its iteration limit.`);
    grant.usedIterations += 1;
    this.state.iterationUses.push({ grantId, iterationId: parsedIterationId, usedAt: this.now() });
    this.persist();
    return GrantSchema.parse(grant);
  }

  private assertCoordinator(actor: string) {
    if (PrincipalIdSchema.parse(actor) !== this.state.rootPrincipal) {
      throw new Error("Only the root principal may manage grants.");
    }
  }

  private persist() {
    this.state = AuthorityStateSchema.parse(this.state);
    writeOwnerOnlyJson(this.paths.policyPath, this.state);
  }
}

function denied(reason: string): AuthorizationDecision {
  return {
    allowed: false,
    root: false,
    grantId: null,
    mergeAllowed: false,
    maxCostUsd: null,
    reason,
  };
}
