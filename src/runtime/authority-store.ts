import { z } from "zod";
import { GrantSchema, type Grant } from "../contracts/durable";
import { BackendIdSchema, PrincipalIdSchema, ProjectIdSchema, TimestampSchema } from "../contracts/common";
import { ensureProjectStateDirectories, type ProjectStatePaths } from "./project-state";
import { readOwnerOnlyJson, writeOwnerOnlyJson } from "./owner-json";

export const GrantOperationSchema = z.enum(["run", "write", "merge", "council", "workflow", "admin"]);
export type GrantOperation = z.infer<typeof GrantOperationSchema>;

const AuthorityStateSchema = z.object({
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
  coordinator: boolean;
  grantId: string | null;
  mergeAllowed: boolean;
  maxCostUsd: number | null;
  reason: string;
};

export type AuthorityStoreOptions = {
  coordinator?: string;
  now?: () => number;
};

export class AuthorityStore {
  readonly projectId: string;
  private readonly now: () => number;
  private state: AuthorityState;

  constructor(private readonly paths: ProjectStatePaths, options: AuthorityStoreOptions = {}) {
    ensureProjectStateDirectories(paths);
    this.projectId = ProjectIdSchema.parse(paths.projectId);
    this.now = options.now ?? Date.now;

    const existing = readOwnerOnlyJson(paths.policyPath, AuthorityStateSchema);
    if (existing) {
      if (existing.projectId !== this.projectId) {
        throw new Error(`Policy project mismatch: expected ${this.projectId}, got ${existing.projectId}`);
      }
      if (options.coordinator && options.coordinator !== existing.coordinator) {
        throw new Error(`Configured coordinator does not match persisted coordinator ${existing.coordinator}.`);
      }
      this.state = existing;
      return;
    }

    const coordinator = PrincipalIdSchema.parse(options.coordinator);
    this.state = AuthorityStateSchema.parse({
      version: 2,
      projectId: this.projectId,
      coordinator,
      grants: [],
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

    if (request.principal === this.state.coordinator) {
      return {
        allowed: true,
        coordinator: true,
        grantId: null,
        mergeAllowed: true,
        maxCostUsd: null,
        reason: "Configured coordinator authority.",
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
      return true;
    });

    if (!grant) {
      return denied("No active grant covers the requested project, operation, backend, merge authority, and cost.");
    }

    return {
      allowed: true,
      coordinator: false,
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
    if (grant.issuedBy !== this.state.coordinator) {
      throw new Error("Grant issuer must be the configured coordinator.");
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

  private assertCoordinator(actor: string) {
    if (PrincipalIdSchema.parse(actor) !== this.state.coordinator) {
      throw new Error("Only the configured coordinator may manage grants.");
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
    coordinator: false,
    grantId: null,
    mergeAllowed: false,
    maxCostUsd: null,
    reason,
  };
}
