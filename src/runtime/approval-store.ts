import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApprovalRequestSchema, type ApprovalRequest } from "../contracts/collaboration";
import { IdentifierSchema, PrincipalIdSchema, ProjectIdSchema, TimestampSchema } from "../contracts/common";
import { readOwnerOnlyJson, writeOwnerOnlyJson } from "./owner-json";
import { ensureProjectStateDirectories, type ProjectStatePaths } from "./project-state";

const ApprovalStoreStateSchema = z.object({
  version: z.literal(1),
  projectId: ProjectIdSchema,
  requests: z.array(ApprovalRequestSchema).max(8_192),
  updatedAt: TimestampSchema,
}).strict().superRefine((state, context) => {
  const ids = state.requests.map((request) => request.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Approval request ids must be unique.", path: ["requests"] });
  }
});

export type ApprovalStoreState = z.infer<typeof ApprovalStoreStateSchema>;
export type ApprovalCreateInput = Pick<ApprovalRequest,
  "collaborationId" | "requestedBy" | "assignedTo" | "kind" | "summary" | "expiresAt"
> & Partial<Pick<ApprovalRequest, "id" | "details" | "artifactIds">>;

export class ApprovalStore {
  readonly projectId: string;
  readonly path: string;
  private state: ApprovalStoreState;
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly expiryActor: string;

  constructor(
    private readonly paths: ProjectStatePaths,
    options: { now?: () => number; id?: () => string; expiryActor?: string } = {},
  ) {
    ensureProjectStateDirectories(paths);
    this.projectId = ProjectIdSchema.parse(paths.projectId);
    this.path = paths.approvalsPath;
    this.now = options.now ?? Date.now;
    this.id = options.id ?? (() => `approval_${randomUUID()}`);
    this.expiryActor = PrincipalIdSchema.parse(options.expiryActor ?? "headless-daemon");
    const existing = readOwnerOnlyJson(this.path, ApprovalStoreStateSchema);
    if (existing) {
      if (existing.projectId !== this.projectId) {
        throw new Error(`Approval store project mismatch: expected ${this.projectId}, got ${existing.projectId}`);
      }
      this.state = existing;
      return;
    }
    this.state = ApprovalStoreStateSchema.parse({
      version: 1,
      projectId: this.projectId,
      requests: [],
      updatedAt: this.now(),
    });
    this.persist();
  }

  create(input: ApprovalCreateInput) {
    const at = this.now();
    if (input.expiresAt <= at) throw new Error("Approval request expiry must be in the future.");
    const request = ApprovalRequestSchema.parse({
      id: input.id ?? this.id(),
      collaborationId: input.collaborationId,
      requestedBy: input.requestedBy,
      assignedTo: input.assignedTo,
      kind: input.kind,
      status: "pending",
      summary: input.summary,
      details: input.details ?? {},
      artifactIds: input.artifactIds ?? [],
      resolvedBy: null,
      resolution: null,
      expiresAt: input.expiresAt,
      resolvedAt: null,
      createdAt: at,
      updatedAt: at,
    });
    if (this.state.requests.some((candidate) => candidate.id === request.id)) {
      throw new Error(`Approval request already exists: ${request.id}`);
    }
    this.state.requests.push(request);
    this.state.updatedAt = at;
    this.persist();
    return cloneRequest(request);
  }

  get(id: string, at = this.now()) {
    this.expirePending(at);
    const request = this.state.requests.find((candidate) => candidate.id === IdentifierSchema.parse(id));
    return request ? cloneRequest(request) : null;
  }

  list(filters: {
    status?: ApprovalRequest["status"];
    assignedTo?: string;
    collaborationId?: string;
    at?: number;
  } = {}) {
    this.expirePending(filters.at ?? this.now());
    const assignedTo = filters.assignedTo === undefined ? undefined : PrincipalIdSchema.parse(filters.assignedTo);
    const collaborationId = filters.collaborationId === undefined ? undefined : IdentifierSchema.parse(filters.collaborationId);
    return this.state.requests
      .filter((request) => filters.status === undefined || request.status === filters.status)
      .filter((request) => assignedTo === undefined || request.assignedTo === assignedTo)
      .filter((request) => collaborationId === undefined || request.collaborationId === collaborationId)
      .map(cloneRequest)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  }

  resolve(
    id: string,
    actor: string,
    decision: "approved" | "rejected" | { status: "approved" | "rejected"; resolution?: string },
    resolution?: string,
  ) {
    return this.resolveInternal(id, actor, decision, resolution, false);
  }

  /**
   * Resolve through an already-authorized daemon administrator. Keeping this
   * as a distinct method prevents ordinary integration principals from
   * claiming administrator override authority in store input.
   */
  resolveAsAdministrator(
    id: string,
    actor: string,
    decision: "approved" | "rejected" | { status: "approved" | "rejected"; resolution?: string },
    resolution?: string,
  ) {
    return this.resolveInternal(id, actor, decision, resolution, true);
  }

  private resolveInternal(
    id: string,
    actor: string,
    decision: "approved" | "rejected" | { status: "approved" | "rejected"; resolution?: string },
    resolution: string | undefined,
    administrator: boolean,
  ) {
    const at = this.now();
    this.expirePending(at);
    const request = this.require(id);
    const principal = PrincipalIdSchema.parse(actor);
    if (request.assignedTo !== principal && !administrator) {
      throw new Error(`Only assigned principal ${request.assignedTo} may resolve approval ${request.id}.`);
    }
    const status = typeof decision === "string" ? decision : decision.status;
    const reason = typeof decision === "string" ? resolution : decision.resolution;
    if (request.status !== "pending") {
      if (request.status === status && request.resolvedBy === principal) return cloneRequest(request);
      throw new Error(`Approval ${request.id} is already ${request.status}.`);
    }
    request.status = status;
    request.resolvedBy = principal;
    request.resolution = reason ?? (status === "approved" ? "Approved." : "Rejected.");
    request.resolvedAt = at;
    request.updatedAt = at;
    ApprovalRequestSchema.parse(request);
    this.state.updatedAt = at;
    this.persist();
    return cloneRequest(request);
  }

  cancel(id: string, actor: string, reason = "Approval request cancelled.") {
    const at = this.now();
    this.expirePending(at);
    const request = this.require(id);
    const principal = PrincipalIdSchema.parse(actor);
    if (request.requestedBy !== principal) {
      throw new Error(`Only requester ${request.requestedBy} may cancel approval ${request.id}.`);
    }
    if (request.status === "cancelled" && request.resolvedBy === principal) return cloneRequest(request);
    if (request.status !== "pending") throw new Error(`Approval ${request.id} is already ${request.status}.`);
    request.status = "cancelled";
    request.resolvedBy = principal;
    request.resolution = reason;
    request.resolvedAt = at;
    request.updatedAt = at;
    ApprovalRequestSchema.parse(request);
    this.state.updatedAt = at;
    this.persist();
    return cloneRequest(request);
  }

  expirePending(at = this.now(), actor = this.expiryActor) {
    const now = TimestampSchema.parse(at);
    const principal = PrincipalIdSchema.parse(actor);
    const expired: ApprovalRequest[] = [];
    for (const request of this.state.requests) {
      if (request.status !== "pending" || request.expiresAt > now) continue;
      request.status = "expired";
      request.resolvedBy = principal;
      request.resolution = "Approval request expired before resolution.";
      request.resolvedAt = now;
      request.updatedAt = now;
      ApprovalRequestSchema.parse(request);
      expired.push(cloneRequest(request));
    }
    if (expired.length > 0) {
      this.state.updatedAt = now;
      this.persist();
    }
    return expired;
  }

  snapshot(): ApprovalStoreState {
    return structuredClone(ApprovalStoreStateSchema.parse(this.state));
  }

  private require(id: string) {
    const request = this.state.requests.find((candidate) => candidate.id === IdentifierSchema.parse(id));
    if (!request) throw new Error(`Unknown approval request: ${id}`);
    return request;
  }

  private persist() {
    this.state = ApprovalStoreStateSchema.parse(this.state);
    writeOwnerOnlyJson(this.path, this.state);
  }
}

function cloneRequest(request: ApprovalRequest) {
  return structuredClone(ApprovalRequestSchema.parse(request));
}
