import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { z } from "zod";
import { HeadlessError } from "../runtime/headless-error";
import { redactAndTruncate } from "../runtime/redaction";
import { calculateModelPricedCost, listPricing } from "../runtime/pricing";
import { recordRuntimeDiagnostic } from "../runtime/diagnostics";
import { linkedProviderOperationIds } from "../runtime/linked-provider-ids";
import { getProvider, type ProviderDefinition } from "./providers";
import { secureBunUnixServe } from "../runtime/secure-socket";

const DEFAULT_BODY_LIMIT = 4_000_000;
const DEFAULT_STREAM_LIMIT_MS = 300_000;
const DEFAULT_LEASE_CONCURRENCY = 4;
const DEFAULT_LEASE_BODY_MEMORY_LIMIT = 16_000_000;
const DEFAULT_BROKER_CONCURRENCY = 32;
const DEFAULT_BROKER_BODY_MEMORY_LIMIT = 64_000_000;
const MAX_RETAINED_LEASES = 10_000;
const MAX_RETAINED_BUDGET_QUOTAS = 10_000;
const MAX_RETAINED_LINKED_OPERATIONS = 10_000;
/**
 * Synthetic loopback port embedded in lease baseUrl when the broker is Unix-socket-only.
 * Host TCP is not listening on this port; Linux workers reach the broker via the
 * in-netns relay (linux-relay) which binds 127.0.0.1:<port> inside the private netns
 * and forwards to the host AF_UNIX socket. Keep aligned with linux-relay defaults.
 */
export const BROKER_UNIX_ONLY_RELAY_PORT = 38_471;

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const nullableLinkedAmount = z.number().nonnegative().finite().nullable();

export const BrokerLinkedAllocationSchema = z.object({
  requests: z.number().int().positive().max(100_000),
  inputTokens: z.number().int().nonnegative().safe().nullable(),
  outputTokens: z.number().int().nonnegative().safe().nullable(),
  costUsd: nullableLinkedAmount,
}).strict();

export const BrokerLinkedUnusedSchema = z.object({
  requests: z.number().int().nonnegative().max(100_000),
  inputTokens: z.number().int().nonnegative().safe().nullable(),
  outputTokens: z.number().int().nonnegative().safe().nullable(),
  costUsd: nullableLinkedAmount,
}).strict();

export const BrokerBudgetQuotaSchema = z.object({
  id: z.string().trim().min(1).max(160),
  maxRequests: z.number().int().positive().nullable(),
  usedRequests: z.number().int().nonnegative(),
  maxInputTokens: z.number().int().positive().nullable(),
  usedInputTokens: z.number().int().nonnegative(),
  maxOutputTokens: z.number().int().positive().nullable(),
  usedOutputTokens: z.number().int().nonnegative(),
  maxCostUsd: z.number().nonnegative().nullable().default(null),
  usedCostUsd: z.number().nonnegative().default(0),
}).strict();

export type BrokerBudgetQuota = z.infer<typeof BrokerBudgetQuotaSchema>;

export const BrokerLeaseScopeSchema = z.object({
  runId: z.string().min(1).max(160),
  provider: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  models: z.array(z.string().min(1).max(256)).min(1).max(128),
  endpointClasses: z.array(z.enum(["chat", "responses", "messages", "embeddings", "models", "generate"])).min(1),
  expiresAt: z.number().int().positive(),
  maxRequests: z.number().int().positive().max(100_000),
  maxBodyBytes: z.number().int().positive().max(64_000_000).default(DEFAULT_BODY_LIMIT),
  maxConcurrentRequests: z.number().int().positive().max(1_024).default(DEFAULT_LEASE_CONCURRENCY),
  maxInFlightBodyBytes: z.number().int().positive().max(256_000_000).default(DEFAULT_LEASE_BODY_MEMORY_LIMIT),
  maxStreamMs: z.number().int().positive().max(3_600_000).default(DEFAULT_STREAM_LIMIT_MS),
  maxCostUsd: z.number().nonnegative().nullable().default(null),
  budgetQuotas: z.array(BrokerBudgetQuotaSchema).max(256).default([]),
}).strict().superRefine((scope, context) => {
  if (scope.maxInFlightBodyBytes < scope.maxBodyBytes) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["maxInFlightBodyBytes"],
      message: "Broker in-flight body memory must accommodate one maximum-sized request.",
    });
  }
  const ids = new Set<string>();
  for (const [index, quota] of scope.budgetQuotas.entries()) {
    if (ids.has(quota.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["budgetQuotas", index, "id"], message: `Duplicate broker budget quota: ${quota.id}` });
    ids.add(quota.id);
  }
});

export type BrokerLeaseScope = z.infer<typeof BrokerLeaseScopeSchema>;

export const BrokerLinkedTargetScopeSchema = z.object({
  provider: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  models: z.array(z.string().min(1).max(256)).min(1).max(128),
  endpointClasses: z.array(z.enum(["chat", "responses", "messages", "embeddings", "models", "generate"])).min(1),
  expiresAt: z.number().int().positive(),
  childDeadlineAt: z.number().int().positive(),
  replyMarginMs: z.number().int().nonnegative().max(60_000),
  maxRequests: z.number().int().positive().max(100_000),
  maxInputTokens: z.number().int().positive().safe().nullable(),
  maxOutputTokens: z.number().int().positive().safe().nullable(),
  maxBodyBytes: z.number().int().positive().max(64_000_000).default(DEFAULT_BODY_LIMIT),
  maxConcurrentRequests: z.number().int().positive().max(1_024).default(DEFAULT_LEASE_CONCURRENCY),
  maxInFlightBodyBytes: z.number().int().positive().max(256_000_000).default(DEFAULT_LEASE_BODY_MEMORY_LIMIT),
  maxStreamMs: z.number().int().positive().max(3_600_000).default(DEFAULT_STREAM_LIMIT_MS),
  maxCostUsd: z.number().nonnegative().nullable().default(null),
  budgetQuotas: z.array(BrokerBudgetQuotaSchema).max(255).default([]),
}).strict().superRefine((scope, context) => {
  if (scope.maxInFlightBodyBytes < scope.maxBodyBytes) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["maxInFlightBodyBytes"],
      message: "Broker in-flight body memory must accommodate one maximum-sized request.",
    });
  }
  const ids = new Set<string>();
  for (const [index, quota] of scope.budgetQuotas.entries()) {
    if (ids.has(quota.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["budgetQuotas", index, "id"], message: `Duplicate broker budget quota: ${quota.id}` });
    ids.add(quota.id);
  }
});

export type BrokerLinkedTargetScope = z.infer<typeof BrokerLinkedTargetScopeSchema>;

type Lease = BrokerLeaseScope & {
  id: string;
  tokenHash: Buffer;
  requests: number;
  forwardedRequests: number;
  observedCostUsd: number;
  accountedCostUsd: number;
  accountedInputTokens: number;
  accountedOutputTokens: number;
  activeRequests: number;
  inFlightBodyBytes: number;
  revoked: boolean;
};

type AggregateBudgetQuota = BrokerBudgetQuota;

export type BrokerRequestLog = {
  id: string;
  runId: string | null;
  provider: string | null;
  route: string;
  method: string;
  status: number;
  requestBytes: number;
  durationMs: number;
  error: string | null;
};

export type BrokerLeaseCarve = {
  id: string;
  parentLeaseId: string;
  runId: string;
  requests: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  settled: boolean;
};

const BrokerLeaseCarveSchema = z.object({
  id: z.string().trim().min(1).max(160),
  parentLeaseId: z.string().trim().min(1).max(160),
  runId: z.string().trim().min(1).max(160),
  requests: z.number().int().positive().max(100_000),
  inputTokens: z.number().int().nonnegative().safe().nullable(),
  outputTokens: z.number().int().nonnegative().safe().nullable(),
  costUsd: nullableLinkedAmount,
  settled: z.boolean(),
}).strict();

export const BrokerLinkedTargetObservationSchema = z.object({
  leaseId: z.string().trim().min(1).max(160),
  requests: z.number().int().nonnegative(),
  forwardedRequests: z.number().int().nonnegative(),
  observedCostUsd: z.number().nonnegative().finite(),
  accountedCostUsd: z.number().nonnegative().finite(),
  accountedInputTokens: z.number().int().nonnegative(),
  accountedOutputTokens: z.number().int().nonnegative(),
  activeRequests: z.number().int().nonnegative(),
  revoked: z.boolean(),
  expiresAt: z.number().int().positive(),
}).strict();

const BrokerLinkedParentOperationSchema = z.object({
  kind: z.literal("parent"),
  operationId: z.string().trim().min(1).max(160),
  linkId: digest,
  parentRunId: z.string().trim().min(1).max(160),
  allocation: BrokerLinkedAllocationSchema,
  phase: z.enum(["prepared", "applied", "settled"]),
  carve: BrokerLeaseCarveSchema,
  unused: BrokerLinkedUnusedSchema.nullable(),
  expiresAt: z.number().int().positive(),
  updatedAt: z.number().int().nonnegative(),
}).strict().superRefine((operation, context) => {
  if ((operation.phase === "settled") !== (operation.unused !== null) || operation.carve.settled !== (operation.phase === "settled")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Linked parent settlement state is inconsistent." });
  }
  if (operation.unused) addUnusedIssues(operation.allocation, operation.unused, context);
});

const BrokerLinkedTargetOperationSchema = z.object({
  kind: z.literal("target"),
  operationId: z.string().trim().min(1).max(160),
  linkId: digest,
  childRunId: z.string().trim().min(1).max(160),
  requestedScope: BrokerLinkedTargetScopeSchema,
  targetLeaseId: z.string().trim().min(1).max(160),
  targetTokenHash: digest.nullable(),
  targetIssuedAt: z.number().int().nonnegative().nullable(),
  targetQuotaScope: BrokerLeaseScopeSchema,
  targetExpiresAt: z.number().int().positive(),
  phase: z.enum(["prepared", "issued", "revoked"]),
  observation: BrokerLinkedTargetObservationSchema,
  updatedAt: z.number().int().nonnegative(),
}).strict().superRefine((operation, context) => {
  if ((operation.phase === "prepared") !== (operation.targetIssuedAt === null && operation.targetTokenHash === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Linked target issuance state is inconsistent." });
  }
  if ((operation.phase === "revoked") !== operation.observation.revoked) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Linked target revocation state is inconsistent." });
  }
});

export const BrokerLinkedOperationSchema = z.union([
  BrokerLinkedParentOperationSchema,
  BrokerLinkedTargetOperationSchema,
]);

export type BrokerLinkedOperation = z.infer<typeof BrokerLinkedOperationSchema>;

export type ProviderBrokerOptions = {
  credentials?: Record<string, string | undefined>;
  /** Environment used for broker policy flags; defaults to the process environment. */
  env?: Readonly<NodeJS.ProcessEnv>;
  upstreams?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  maxLogEntries?: number;
  unixSocketPath?: string;
  /**
   * When a Unix socket is configured, loopback TCP remains on by default so
   * every lease baseUrl has a host owner and explicit unsafe runs keep working.
   * Set false (or HEADLESS_BROKER_ALLOW_LOOPBACK_TCP=0) for AF_UNIX-only mode;
   * only required-contained Linux workers can consume those leases.
   */
  allowLoopbackTcp?: boolean;
  maxConcurrentRequests?: number;
  maxInFlightBodyBytes?: number;
  initialBudgetQuotas?: BrokerBudgetQuota[];
  persistBudgetQuota?: (quota: BrokerBudgetQuota, expiresAt?: number) => void;
  initialLinkedOperations?: BrokerLinkedOperation[];
  persistLinkedOperation?: (operation: BrokerLinkedOperation) => void;
  warning?: (message: string) => void;
};

export class ProviderBroker {
  private readonly leases = new Map<string, Lease>();
  private readonly budgetQuotas = new Map<string, AggregateBudgetQuota>();
  private readonly credentials: Record<string, string | undefined>;
  private readonly upstreams: Record<string, string | undefined>;
  private readonly fetcher: typeof fetch;
  private readonly maxLogEntries: number;
  private readonly maxConcurrentRequests: number;
  private readonly maxInFlightBodyBytes: number;
  private readonly persistBudgetQuota?: ProviderBrokerOptions["persistBudgetQuota"];
  private readonly linkedOperations = new Map<string, BrokerLinkedOperation>();
  private readonly persistLinkedOperation?: ProviderBrokerOptions["persistLinkedOperation"];
  private readonly warning?: ProviderBrokerOptions["warning"];
  private readonly logs: BrokerRequestLog[] = [];
  private activeRequests = 0;
  private inFlightBodyBytes = 0;
  private pricingWarningEmitted = false;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private unixServer: ReturnType<typeof Bun.serve> | null = null;
  readonly unixSocketPath: string | null;
  /** Explicit or env-derived policy for 127.0.0.1 TCP when a Unix socket is configured. */
  readonly allowLoopbackTcp: boolean;

  constructor(options: ProviderBrokerOptions = {}) {
    this.credentials = options.credentials ?? process.env;
    this.upstreams = options.upstreams ?? {};
    this.fetcher = options.fetch ?? fetch;
    this.maxLogEntries = options.maxLogEntries ?? 1_000;
    this.maxConcurrentRequests = boundedPositive(options.maxConcurrentRequests ?? DEFAULT_BROKER_CONCURRENCY, 1_024, "Broker concurrency limit");
    this.maxInFlightBodyBytes = boundedPositive(options.maxInFlightBodyBytes ?? DEFAULT_BROKER_BODY_MEMORY_LIMIT, 1_024_000_000, "Broker body memory limit");
    this.persistBudgetQuota = options.persistBudgetQuota;
    for (const quota of options.initialBudgetQuotas ?? []) {
      const parsed = BrokerBudgetQuotaSchema.parse(quota);
      this.budgetQuotas.set(parsed.id, parsed);
    }
    this.persistLinkedOperation = options.persistLinkedOperation;
    this.warning = options.warning;
    for (const operation of options.initialLinkedOperations ?? []) {
      const parsed = BrokerLinkedOperationSchema.parse(operation);
      if (this.linkedOperations.has(parsed.operationId)) throw new Error(`Duplicate linked broker operation: ${parsed.operationId}`);
      this.linkedOperations.set(parsed.operationId, parsed);
    }
    this.unixSocketPath = options.unixSocketPath ?? null;
    this.allowLoopbackTcp = resolveAllowLoopbackTcp(options.allowLoopbackTcp, options.env ?? process.env);
  }

  /**
   * Start the broker edge(s).
   *
   * - No unixSocketPath: bind loopback TCP only.
   * - unixSocketPath with allowLoopbackTcp disabled: Unix socket only — no host TCP listener.
   *   Lease baseUrl still carries a synthetic 127.0.0.1 port so Linux in-netns relays
   *   and worker env wiring keep working; unixSocket on the worker config is authoritative.
   * - unixSocketPath without an explicit opt-out: bind both edges. The TCP listener
   *   owns the lease baseUrl for host-side and explicit unsafe execution, while
   *   required-contained Linux workers still relay through the owner-only Unix socket.
   */
  start(port = 0) {
    if (this.server || this.unixServer) return this.endpoint;
    const wantTcp = !this.unixSocketPath || this.allowLoopbackTcp;
    try {
      if (wantTcp) {
        this.server = Bun.serve({
          hostname: "127.0.0.1",
          port,
          maxRequestBodySize: 64_000_000,
          fetch: (request) => this.handle(request),
        });
      }
      if (this.unixSocketPath) {
        if (existsSync(this.unixSocketPath)) throw new Error(`Provider broker socket already exists: ${this.unixSocketPath}`);
        this.unixServer = secureBunUnixServe(this.unixSocketPath, () =>
          Bun.serve({ unix: this.unixSocketPath as string, maxRequestBodySize: 64_000_000, fetch: (request) => this.handle(request) }),
        );
      }
      if (!this.server && !this.unixServer) {
        throw new Error("Provider broker start requires a TCP listener or a Unix socket path.");
      }
    } catch (error) {
      this.server?.stop(true);
      this.unixServer?.stop(true);
      this.server = null;
      this.unixServer = null;
      if (this.unixSocketPath) rmSync(this.unixSocketPath, { force: true });
      throw error;
    }
    return this.endpoint;
  }

  stop() {
    this.server?.stop(true);
    this.unixServer?.stop(true);
    this.server = null;
    this.unixServer = null;
    if (this.unixSocketPath) rmSync(this.unixSocketPath, { force: true });
  }

  /**
   * True when a host-side 127.0.0.1 TCP listener is active.
   *
   * Callers that hand a lease to a worker must propagate this, because it is the
   * only place that knows whether `endpoint` names a real host listener or the
   * synthetic relay port (see BrokerWorkerAccess.hostLoopbackListener).
   */
  get tcpListening(): boolean {
    return this.server !== null;
  }

  get endpoint() {
    if (this.server) return `http://127.0.0.1:${this.server.port}`;
    // Unix-socket-only mode: baseUrl stays a loopback HTTP URL for worker env /
    // Linux relay port selection. Host TCP is not bound; dial via unixSocket.
    // Nothing on the host owns this port, so it is inert outside a Linux
    // contained worker whose in-namespace relay binds it; the runner refuses to
    // hand it to any other worker (assertBrokerEndpointIsServed).
    if (this.unixServer) return `http://127.0.0.1:${BROKER_UNIX_ONLY_RELAY_PORT}`;
    throw new Error("Provider broker is not running.");
  }

  issueLease(input: z.input<typeof BrokerLeaseScopeSchema>) {
    return this.issueLeaseWithId(randomUUID(), input);
  }

  private issueLeaseWithId(id: string, input: z.input<typeof BrokerLeaseScopeSchema>) {
    this.pruneLeases();
    if (this.leases.size >= MAX_RETAINED_LEASES) throw new Error("Provider broker lease retention limit is exhausted.");
    if (this.leases.has(id)) throw new Error(`Provider broker lease already exists: ${id}`);
    const scope = BrokerLeaseScopeSchema.parse(input);
    if (scope.expiresAt <= Date.now()) throw new Error("Broker lease expiry must be in the future.");
    this.warnAboutUnpricedCostCap(scope);
    this.registerBudgetQuotas(scope.budgetQuotas, scope.expiresAt);
    const token = `hls_${randomBytes(32).toString("base64url")}`;
    this.leases.set(id, {
      ...scope,
      id,
      tokenHash: digestToken(token),
      requests: 0,
      forwardedRequests: 0,
      observedCostUsd: 0,
      accountedCostUsd: 0,
      accountedInputTokens: 0,
      accountedOutputTokens: 0,
      activeRequests: 0,
      inFlightBodyBytes: 0,
      revoked: false,
    });
    // baseUrl remains populated for backward compat and Linux in-netns relay port
    // selection. When unixSocketPath is set, workers must prefer the Unix socket
    // (run-execution-service / simple.ts already plumb unixSocket authoritatively).
    return {
      id,
      token,
      provider: scope.provider,
      expiresAt: scope.expiresAt,
      baseUrl: `${this.endpoint}/${scope.provider}`,
      ...(this.unixSocketPath ? { unixSocket: this.unixSocketPath } : {}),
    };
  }

  /** Durably identify and synchronously carve one cross-provider parent hold. */
  carveLinkedParent(linkId: string, parentRunId: string, value: z.input<typeof BrokerLinkedAllocationSchema>) {
    const id = linkedOperationId(linkId, "parent");
    const allocation = BrokerLinkedAllocationSchema.parse(value);
    const existing = this.linkedOperations.get(id);
    if (existing) {
      if (existing.kind !== "parent" || linkedParentIdentity(existing.parentRunId, existing.allocation) !== linkedParentIdentity(parentRunId, allocation)) {
        throw linkedConflict("Linked parent operation conflicts with its original allocation.");
      }
      if (existing.phase === "prepared") throw linkedConflict("Linked parent operation is incomplete and requires recovery.");
      return BrokerLeaseCarveSchema.parse(existing.carve);
    }

    const lease = [...this.leases.values()].find((candidate) => candidate.runId === parentRunId && !candidate.revoked);
    if (!lease) throw new Error("Parent broker lease is unavailable for delegation.");
    const prepared = BrokerLinkedOperationSchema.parse({
      kind: "parent",
      operationId: id,
      linkId,
      parentRunId,
      allocation,
      phase: "prepared",
      carve: { id, parentLeaseId: lease.id, runId: parentRunId, ...allocation, settled: false },
      unused: null,
      expiresAt: lease.expiresAt,
      updatedAt: Date.now(),
    });
    this.storeLinkedOperation(prepared);
    const carve = this.carveRunLeaseWithId(id, parentRunId, allocation);
    const applied = BrokerLinkedOperationSchema.parse({
      ...prepared,
      phase: "applied",
      carve,
      updatedAt: Date.now(),
    });
    this.storeLinkedOperation(applied);
    return BrokerLeaseCarveSchema.parse(carve);
  }

  /** Issue one target-provider capability from a durable linked allocation. */
  issueLinkedTarget(linkId: string, childRunId: string, value: z.input<typeof BrokerLinkedTargetScopeSchema>) {
    const id = linkedOperationId(linkId, "target");
    const requestedScope = BrokerLinkedTargetScopeSchema.parse(value);
    const leaseScope = this.reduceLinkedTargetScope(linkedTargetLeaseScope(id, childRunId, requestedScope));
    const existing = this.linkedOperations.get(id);
    if (existing) {
      if (existing.kind !== "target" || linkedTargetIdentity(existing.childRunId, existing.requestedScope) !== linkedTargetIdentity(childRunId, requestedScope)) {
        throw linkedConflict("Linked target operation conflicts with its original provider, model, or allocation.");
      }
      if (existing.phase === "prepared") throw linkedConflict("Linked target operation is incomplete and requires recovery.");
      return { status: "already_leased" as const, evidence: linkedTargetEvidence(existing) };
    }
    if (this.linkedOperations.size >= MAX_RETAINED_LINKED_OPERATIONS) throw new Error("Provider broker linked-operation retention limit is exhausted.");

    const now = Date.now();
    const prepared = BrokerLinkedOperationSchema.parse({
      kind: "target",
      operationId: id,
      linkId,
      childRunId,
      requestedScope,
      targetLeaseId: id,
      targetTokenHash: null,
      targetIssuedAt: null,
      targetQuotaScope: leaseScope,
      targetExpiresAt: leaseScope.expiresAt,
      phase: "prepared",
      observation: emptyLinkedTargetObservation(id, leaseScope.expiresAt),
      updatedAt: now,
    });
    this.storeLinkedOperation(prepared);
    try {
      const issuance = this.issueLeaseWithId(id, leaseScope);
      const lease = this.leases.get(id)!;
      const issued = BrokerLinkedTargetOperationSchema.parse({
        ...prepared,
        phase: "issued",
        targetTokenHash: digestToken(issuance.token).toString("hex"),
        targetIssuedAt: now,
        observation: linkedTargetObservation(lease),
        updatedAt: Date.now(),
      });
      this.storeLinkedOperation(issued);
      return { status: "issued" as const, lease: { ...issuance }, evidence: linkedTargetEvidence(issued) };
    } catch (error) {
      this.revokeLease(id);
      throw error;
    }
  }

  observeLinkedTarget(linkId: string) {
    const id = linkedOperationId(linkId, "target");
    const operation = this.linkedOperations.get(id);
    if (!operation || operation.kind !== "target") return null;
    const lease = this.leases.get(operation.observation.leaseId);
    if (lease) this.syncLinkedTargetObservation(lease);
    const current = this.linkedOperations.get(id);
    return current?.kind === "target" ? BrokerLinkedTargetObservationSchema.parse(current.observation) : null;
  }

  /** Token-free durable evidence used only by startup/offline linked recovery. */
  linkedOperationSnapshot(linkId: string) {
    const ids = linkedProviderOperationIds(digest.parse(linkId));
    const parent = this.linkedOperations.get(ids.parentOperationId);
    const target = this.linkedOperations.get(ids.targetOperationId);
    return {
      parent: parent ? BrokerLinkedOperationSchema.parse(parent) : null,
      target: target ? BrokerLinkedOperationSchema.parse(target) : null,
    };
  }

  /** Revoke a target capability once; exact replays are no-ops. */
  revokeLinkedTarget(linkId: string) {
    const id = linkedOperationId(linkId, "target");
    const operation = this.linkedOperations.get(id);
    if (!operation || operation.kind !== "target") return false;
    if (operation.phase === "revoked") return false;
    const lease = this.leases.get(operation.observation.leaseId);
    if (lease) {
      lease.revoked = true;
      operation.observation = linkedTargetObservation(lease);
      if (lease.activeRequests === 0) this.leases.delete(lease.id);
    } else {
      operation.observation.revoked = true;
      operation.observation.activeRequests = 0;
    }
    operation.phase = "revoked";
    operation.updatedAt = Date.now();
    this.storeLinkedOperation(BrokerLinkedOperationSchema.parse(operation));
    return true;
  }

  /** Record a proven-unused parent allocation before restoring any live authority. */
  settleLinkedParent(linkId: string, value: z.input<typeof BrokerLinkedUnusedSchema>) {
    const id = linkedOperationId(linkId, "parent");
    const operation = this.linkedOperations.get(id);
    if (!operation || operation.kind !== "parent") throw new Error("Unknown linked parent operation.");
    if (operation.phase === "prepared") throw linkedConflict("Linked parent operation is incomplete and requires recovery.");
    const unused = BrokerLinkedUnusedSchema.parse(value);
    assertUnusedFits(operation.allocation, unused);
    if (operation.phase === "settled") {
      if (JSON.stringify(operation.unused) !== JSON.stringify(unused)) {
        throw linkedConflict("Linked parent settlement conflicts with the terminal settlement.");
      }
      return false;
    }

    const settled = BrokerLinkedParentOperationSchema.parse({
      ...operation,
      phase: "settled",
      carve: { ...operation.carve, settled: true },
      unused,
      updatedAt: Date.now(),
    });
    // The once-only marker is write-ahead. A crash may forgo restoration, but
    // it can never replay the same refund and enlarge the parent capability.
    this.storeLinkedOperation(settled);
    try {
      this.restoreRunLeaseCarve(settled.carve, unused);
    } catch (error) {
      const lease = this.leases.get(settled.carve.parentLeaseId);
      if (lease) {
        lease.revoked = true;
        if (lease.activeRequests === 0) this.leases.delete(lease.id);
      }
      throw error;
    }
    return true;
  }

  /**
   * Retire a durable parent carve after restart, when no bearer lease survives.
   * This persists the once-only decision but deliberately cannot restore an
   * in-memory capability that the crashed process destroyed.
   */
  recoverLinkedParentSettlement(linkId: string, value: z.input<typeof BrokerLinkedUnusedSchema>) {
    const id = linkedOperationId(linkId, "parent");
    const operation = this.linkedOperations.get(id);
    if (!operation) return false;
    if (operation.kind !== "parent") throw linkedConflict("Linked parent recovery found a target operation at the parent id.");
    const unused = BrokerLinkedUnusedSchema.parse(value);
    assertUnusedFits(operation.allocation, unused);
    if (operation.phase === "settled") {
      if (JSON.stringify(operation.unused) !== JSON.stringify(unused)) {
        throw linkedConflict("Linked parent recovery conflicts with its recorded settlement.");
      }
      return false;
    }
    if (this.leases.has(operation.carve.parentLeaseId)) {
      throw linkedConflict("Linked parent recovery cannot run while the original bearer lease is live.");
    }
    this.storeLinkedOperation(BrokerLinkedParentOperationSchema.parse({
      ...operation,
      phase: "settled",
      carve: { ...operation.carve, settled: true },
      unused,
      updatedAt: Date.now(),
    }));
    return true;
  }

  revokeLease(id: string) {
    const lease = this.leases.get(id);
    if (!lease) return false;
    lease.revoked = true;
    if (lease.activeRequests === 0) this.leases.delete(id);
    return true;
  }

  revokeRun(runId: string) {
    let count = 0;
    for (const lease of this.leases.values()) {
      if (lease.runId !== runId || lease.revoked) continue;
      lease.revoked = true;
      if (lease.activeRequests === 0) this.leases.delete(lease.id);
      count += 1;
    }
    return count;
  }

  observeCost(leaseId: string, amountUsd: number) {
    if (!Number.isFinite(amountUsd) || amountUsd < 0) throw new TypeError("Observed broker cost must be a finite non-negative number.");
    const lease = this.leases.get(leaseId);
    if (!lease) throw new Error("Unknown broker lease.");
    lease.observedCostUsd += amountUsd;
    if (lease.maxCostUsd !== null && lease.observedCostUsd > lease.maxCostUsd) lease.revoked = true;
    this.syncLinkedTargetObservation(lease);
  }

  getLeaseObservation(leaseId: string) {
    const lease = this.leases.get(leaseId);
    if (!lease) return null;
    return {
      runId: lease.runId,
      provider: lease.provider,
      requests: lease.requests,
      forwardedRequests: lease.forwardedRequests,
      observedCostUsd: lease.observedCostUsd,
      accountedCostUsd: lease.accountedCostUsd,
      accountedInputTokens: lease.accountedInputTokens,
      accountedOutputTokens: lease.accountedOutputTokens,
      activeRequests: lease.activeRequests,
      inFlightBodyBytes: lease.inFlightBodyBytes,
      revoked: lease.revoked,
    };
  }

  /** Synchronously remove a delegated slice from the live parent lease. */
  carveRunLease(runId: string, allocation: Omit<BrokerLeaseCarve, "id" | "parentLeaseId" | "runId" | "settled">) {
    return this.carveRunLeaseWithId(randomUUID(), runId, allocation);
  }

  private carveRunLeaseWithId(id: string, runId: string, allocation: Omit<BrokerLeaseCarve, "id" | "parentLeaseId" | "runId" | "settled">) {
    const lease = [...this.leases.values()].find((candidate) => candidate.runId === runId && !candidate.revoked);
    if (!lease) throw new Error("Parent broker lease is unavailable for delegation.");
    const runQuota = lease.budgetQuotas.find((quota) => quota.id.startsWith("headless-run-"));
    const aggregate = runQuota ? this.budgetQuotas.get(runQuota.id) : null;
    const remainingRequests = lease.maxRequests - lease.requests;
    if (allocation.requests <= 0 || allocation.requests > remainingRequests) throw new Error("Parent broker request remainder cannot fund the delegated slice.");
    assertCarveFits("input token", allocation.inputTokens, runQuota?.maxInputTokens ?? null, aggregate?.usedInputTokens ?? 0);
    assertCarveFits("output token", allocation.outputTokens, runQuota?.maxOutputTokens ?? null, aggregate?.usedOutputTokens ?? 0);
    assertCarveFits("cost", allocation.costUsd, lease.maxCostUsd, Math.max(lease.accountedCostUsd, lease.observedCostUsd));

    lease.maxRequests -= allocation.requests;
    if (allocation.costUsd !== null && lease.maxCostUsd !== null) lease.maxCostUsd -= allocation.costUsd;
    if (runQuota && aggregate) {
      if (runQuota.maxRequests !== null && aggregate.maxRequests !== null) {
        runQuota.maxRequests -= allocation.requests;
        aggregate.maxRequests -= allocation.requests;
      }
      if (allocation.inputTokens !== null && runQuota.maxInputTokens !== null && aggregate.maxInputTokens !== null) {
        runQuota.maxInputTokens -= allocation.inputTokens;
        aggregate.maxInputTokens -= allocation.inputTokens;
      }
      if (allocation.outputTokens !== null && runQuota.maxOutputTokens !== null && aggregate.maxOutputTokens !== null) {
        runQuota.maxOutputTokens -= allocation.outputTokens;
        aggregate.maxOutputTokens -= allocation.outputTokens;
      }
      this.persistBudgetQuota?.(BrokerBudgetQuotaSchema.parse(aggregate), lease.expiresAt);
    }
    return {
      id,
      parentLeaseId: lease.id,
      runId,
      ...allocation,
      settled: false,
    } satisfies BrokerLeaseCarve;
  }

  settleRunLeaseCarve(carve: BrokerLeaseCarve, actual?: { requests?: number; inputTokens?: number | null; outputTokens?: number | null; costUsd?: number | null }) {
    if (carve.settled) return false;
    carve.settled = true;
    const lease = this.leases.get(carve.parentLeaseId);
    if (!lease || lease.revoked || lease.runId !== carve.runId) return false;
    const runQuota = lease.budgetQuotas.find((quota) => quota.id.startsWith("headless-run-"));
    const aggregate = runQuota ? this.budgetQuotas.get(runQuota.id) : null;
    lease.maxRequests += Math.max(0, carve.requests - Math.min(carve.requests, actual?.requests ?? carve.requests));
    const unusedCost = unusedNullable(carve.costUsd, actual?.costUsd);
    if (unusedCost !== null && lease.maxCostUsd !== null) lease.maxCostUsd += unusedCost;
    if (runQuota && aggregate) {
      const unusedRequests = Math.max(0, carve.requests - Math.min(carve.requests, actual?.requests ?? carve.requests));
      if (runQuota.maxRequests !== null && aggregate.maxRequests !== null) {
        runQuota.maxRequests += unusedRequests;
        aggregate.maxRequests += unusedRequests;
      }
      const unusedInput = unusedNullable(carve.inputTokens, actual?.inputTokens);
      const unusedOutput = unusedNullable(carve.outputTokens, actual?.outputTokens);
      if (unusedInput !== null && runQuota.maxInputTokens !== null && aggregate.maxInputTokens !== null) {
        runQuota.maxInputTokens += unusedInput;
        aggregate.maxInputTokens += unusedInput;
      }
      if (unusedOutput !== null && runQuota.maxOutputTokens !== null && aggregate.maxOutputTokens !== null) {
        runQuota.maxOutputTokens += unusedOutput;
        aggregate.maxOutputTokens += unusedOutput;
      }
      this.persistBudgetQuota?.(BrokerBudgetQuotaSchema.parse(aggregate), lease.expiresAt);
    }
    return true;
  }

  getResourceUsage() {
    return {
      leases: this.leases.size,
      activeRequests: this.activeRequests,
      inFlightBodyBytes: this.inFlightBodyBytes,
      budgetQuotas: this.budgetQuotas.size,
    };
  }

  getLogs() {
    return this.logs.map((entry) => ({ ...entry }));
  }

  private storeLinkedOperation(operation: BrokerLinkedOperation) {
    const value = BrokerLinkedOperationSchema.parse(operation);
    if (!this.linkedOperations.has(value.operationId) && this.linkedOperations.size >= MAX_RETAINED_LINKED_OPERATIONS) {
      throw new Error("Provider broker linked-operation retention limit is exhausted.");
    }
    this.persistLinkedOperation?.(value);
    this.linkedOperations.set(value.operationId, value);
  }

  private warnAboutUnpricedCostCap(scope: BrokerLeaseScope) {
    if (
      this.pricingWarningEmitted
      || !this.warning
      || listPricing().length > 0
      || (scope.maxCostUsd === null && scope.budgetQuotas.every((quota) => quota.maxCostUsd === null))
    ) return;
    this.pricingWarningEmitted = true;
    try {
      this.warning("Headless pricing registry is empty while a broker cost cap is active; cost attribution is unavailable and cost-capped requests will fail closed. Register trusted pricing through a daemon extension.");
    } catch (error) {
      recordRuntimeDiagnostic("state", "broker.pricing-warning", error, "warning");
    }
  }

  private syncLinkedTargetObservation(lease: Lease, throwOnFailure = false) {
    const operation = this.linkedOperations.get(lease.id);
    if (!operation || operation.kind !== "target" || operation.phase === "prepared") return;
    const next = BrokerLinkedOperationSchema.parse({
      ...operation,
      phase: lease.revoked ? "revoked" : operation.phase,
      observation: linkedTargetObservation(lease),
      updatedAt: Date.now(),
    });
    try {
      this.storeLinkedOperation(next);
    } catch (error) {
      if (throwOnFailure) throw error;
      recordRuntimeDiagnostic("state", "broker.linked-target-observation", error);
    }
  }

  private restoreRunLeaseCarve(carve: BrokerLeaseCarve, unused: z.infer<typeof BrokerLinkedUnusedSchema>) {
    const lease = this.leases.get(carve.parentLeaseId);
    if (!lease || lease.revoked || lease.runId !== carve.runId) return false;
    const runQuota = lease.budgetQuotas.find((quota) => quota.id.startsWith("headless-run-"));
    const aggregate = runQuota ? this.budgetQuotas.get(runQuota.id) : null;
    lease.maxRequests += unused.requests;
    if (unused.costUsd !== null && lease.maxCostUsd !== null) lease.maxCostUsd += unused.costUsd;
    if (runQuota && aggregate) {
      if (runQuota.maxRequests !== null && aggregate.maxRequests !== null) {
        runQuota.maxRequests += unused.requests;
        aggregate.maxRequests += unused.requests;
      }
      if (unused.inputTokens !== null && runQuota.maxInputTokens !== null && aggregate.maxInputTokens !== null) {
        runQuota.maxInputTokens += unused.inputTokens;
        aggregate.maxInputTokens += unused.inputTokens;
      }
      if (unused.outputTokens !== null && runQuota.maxOutputTokens !== null && aggregate.maxOutputTokens !== null) {
        runQuota.maxOutputTokens += unused.outputTokens;
        aggregate.maxOutputTokens += unused.outputTokens;
      }
      this.persistBudgetQuota?.(BrokerBudgetQuotaSchema.parse(aggregate), lease.expiresAt);
    }
    return true;
  }

  private reduceLinkedTargetScope(scope: BrokerLeaseScope) {
    const budgetQuotas = scope.budgetQuotas.map((quota) => {
      const existing = this.budgetQuotas.get(quota.id);
      if (!existing) return quota;
      return BrokerBudgetQuotaSchema.parse({
        id: quota.id,
        maxRequests: minimumNullableLimit(existing.maxRequests, quota.maxRequests),
        usedRequests: Math.max(existing.usedRequests, quota.usedRequests),
        maxInputTokens: minimumNullableLimit(existing.maxInputTokens, quota.maxInputTokens),
        usedInputTokens: Math.max(existing.usedInputTokens, quota.usedInputTokens),
        maxOutputTokens: minimumNullableLimit(existing.maxOutputTokens, quota.maxOutputTokens),
        usedOutputTokens: Math.max(existing.usedOutputTokens, quota.usedOutputTokens),
        maxCostUsd: minimumNullableLimit(existing.maxCostUsd, quota.maxCostUsd),
        usedCostUsd: Math.max(existing.usedCostUsd, quota.usedCostUsd),
      });
    });
    return BrokerLeaseScopeSchema.parse({ ...scope, budgetQuotas });
  }

  private async handle(request: Request) {
    this.pruneLeases();
    const started = Date.now();
    const url = new URL(request.url);
    const route = url.pathname;
    const match = route.match(/^\/([a-z][a-z0-9_-]{0,63})(\/.*)$/);
    if (!match) return this.failure(null, null, request, route, 404, "Unknown broker route.", started, 0);
    const [, providerId, providerPath] = match;
    const provider = getProvider(providerId);
    if (!provider) return this.failure(null, providerId, request, route, 404, "Unknown provider.", started, 0);

    const token = extractToken(request);
    const lease = token ? this.findLease(token) : null;
    if (!lease) {
      // Reject query-string credentials with a clear header-auth migration hint.
      // Never include the key value in the response or logs (route is pathname-only).
      if (!token && url.searchParams.has("key")) {
        return this.failure(
          null,
          providerId,
          request,
          route,
          400,
          "Broker credentials must be sent via headers (x-goog-api-key, x-api-key, Authorization Bearer, or x-headless-token), not the key query parameter.",
          started,
          0,
        );
      }
      return this.failure(null, providerId, request, route, 401, "Invalid broker token.", started, 0);
    }
    if (lease.provider !== providerId) return this.failure(lease, providerId, request, route, 403, "Broker token is scoped to a different provider.", started, 0);
    if (lease.revoked || lease.expiresAt <= Date.now()) return this.failure(lease, providerId, request, route, 401, "Broker token is expired or revoked.", started, 0);
    if (lease.requests >= lease.maxRequests) return this.failure(lease, providerId, request, route, 429, "Broker request budget exhausted.", started, 0);
    if (/%(?:2f|5c|2e|25)/i.test(providerPath)) {
      return this.failure(lease, providerId, request, route, 400, "Encoded provider path separators, dots, and percent signs are not allowed.", started, 0);
    }
    if (!routeAllowed(provider, providerPath)) return this.failure(lease, providerId, request, route, 403, "Provider route is not allowed.", started, 0);
    const endpointClass = classifyEndpoint(providerPath);
    if (!endpointClass || !lease.endpointClasses.includes(endpointClass)) return this.failure(lease, providerId, request, route, 403, "Endpoint class is outside the lease scope.", started, 0);
    if (!methodAllowed(endpointClass, request.method)) return this.failure(lease, providerId, request, route, 405, "HTTP method is not allowed for this endpoint.", started, 0);

    const declaredLength = Number(request.headers.get("content-length") || 0);
    if (Number.isFinite(declaredLength) && declaredLength > lease.maxBodyBytes) return this.failure(lease, providerId, request, route, 413, "Request body is too large.", started, 0);
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const bodyReservation = hasBody ? lease.maxBodyBytes : 0;
    if (lease.activeRequests >= lease.maxConcurrentRequests) return this.failure(lease, providerId, request, route, 429, "Broker lease concurrency is exhausted.", started, 0);
    if (this.activeRequests >= this.maxConcurrentRequests) return this.failure(lease, providerId, request, route, 503, "Provider broker concurrency is exhausted.", started, 0);
    if (lease.inFlightBodyBytes + bodyReservation > lease.maxInFlightBodyBytes) return this.failure(lease, providerId, request, route, 429, "Broker lease body memory is exhausted.", started, 0);
    if (this.inFlightBodyBytes + bodyReservation > this.maxInFlightBodyBytes) return this.failure(lease, providerId, request, route, 503, "Provider broker body memory is exhausted.", started, 0);
    const aggregateRequestFailure = this.aggregateRequestFailure(lease);
    if (aggregateRequestFailure) return this.failure(lease, providerId, request, route, 429, aggregateRequestFailure, started, 0);
    // Reserve a provider-call slot before the first asynchronous body read.
    // The broker runs on one JS isolate, so this synchronous increment makes
    // maxRequests atomic across concurrent requests sharing a lease. A valid
    // scoped request consumes its slot even when its later body/model is bad.
    lease.requests += 1;
    this.accountAggregateRequest(lease);
    lease.activeRequests += 1;
    lease.inFlightBodyBytes += bodyReservation;
    this.activeRequests += 1;
    this.inFlightBodyBytes += bodyReservation;
    let activeReleased = false;
    let bodyReleased = false;
    const releaseBody = () => {
      if (bodyReleased) return;
      bodyReleased = true;
      lease.inFlightBodyBytes = Math.max(0, lease.inFlightBodyBytes - bodyReservation);
      this.inFlightBodyBytes = Math.max(0, this.inFlightBodyBytes - bodyReservation);
    };
    const releaseActive = () => {
      if (activeReleased) return;
      activeReleased = true;
      releaseBody();
      lease.activeRequests = Math.max(0, lease.activeRequests - 1);
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      this.syncLinkedTargetObservation(lease);
      if (lease.activeRequests === 0 && (lease.revoked || lease.expiresAt <= Date.now())) this.leases.delete(lease.id);
    };
    try {
      this.syncLinkedTargetObservation(lease, true);
    } catch {
      releaseActive();
      return this.failure(lease, providerId, request, route, 503, "Linked broker evidence could not be persisted before request processing.", started, 0);
    }
    let bodyRead: Awaited<ReturnType<typeof readBodyBounded>>;
    try {
      bodyRead = hasBody
        ? await readBodyBounded(request, lease.maxBodyBytes, lease.maxStreamMs)
        : { body: null, bytes: 0, exceeded: false, timedOut: false };
    } catch (error) {
      releaseActive();
      return this.failure(lease, providerId, request, route, request.signal.aborted ? 499 : 400, messageOf(error), started, 0);
    }
    let body = bodyRead.body;
    let requestBytes = bodyRead.bytes;
    if (bodyRead.exceeded || bodyRead.timedOut) {
      releaseActive();
      return this.failure(lease, providerId, request, route, bodyRead.timedOut ? 408 : 413, bodyRead.timedOut ? "Provider request body exceeded its duration limit." : "Request body is too large.", started, requestBytes);
    }
    let parsedBody = parseJsonBody(body);
    if (lease.maxCostUsd !== null && endpointClass !== "models") {
      const normalized = forceStandardServiceTier(providerId, parsedBody);
      if (normalized !== parsedBody) {
        body = Buffer.from(JSON.stringify(normalized));
        requestBytes = body.byteLength;
        parsedBody = normalized;
        if (requestBytes > lease.maxBodyBytes) {
          releaseActive();
          return this.failure(lease, providerId, request, route, 413, "Cost-capped provider request exceeds the body limit after standard-tier normalization.", started, requestBytes);
        }
      }
    }
    const model = extractModel(providerPath, body);
    if (model && !lease.models.includes(model)) {
      releaseActive();
      return this.failure(lease, providerId, request, route, 403, `Model ${model} is outside the lease scope.`, started, requestBytes);
    }
    if (!model && endpointClass !== "models") {
      releaseActive();
      return this.failure(lease, providerId, request, route, 400, "Provider request did not declare a model.", started, requestBytes);
    }
    const requiresBoundedProtocol = lease.maxCostUsd !== null
      || lease.budgetQuotas.some((scoped) => {
        const quota = this.budgetQuotas.get(scoped.id);
        return !!quota && (quota.maxInputTokens !== null || quota.maxOutputTokens !== null);
      });
    if (requiresBoundedProtocol && endpointClass !== "models") {
      let reason: string | null;
      try {
        reason = provider.validateBoundedInput({
          body: parsedBody,
          endpointClass,
          model: model!,
          costCapped: lease.maxCostUsd !== null,
          inputCapped: lease.budgetQuotas.some((scoped) => this.budgetQuotas.get(scoped.id)?.maxInputTokens != null),
          outputCapped: lease.budgetQuotas.some((scoped) => this.budgetQuotas.get(scoped.id)?.maxOutputTokens != null),
        });
      } catch {
        reason = "Provider bounded-input validation failed closed.";
      }
      if (reason) {
        releaseActive();
        return this.failure(lease, providerId, request, route, 429, reason, started, requestBytes);
      }
    }
    const tokenBounds = providerTokenBounds(providerId, endpointClass, body, requestBytes);
    const aggregateTokenFailure = this.aggregateTokenFailure(lease, tokenBounds);
    if (aggregateTokenFailure) {
      releaseActive();
      return this.failure(lease, providerId, request, route, 429, aggregateTokenFailure, started, requestBytes);
    }
    this.accountAggregateTokens(lease, tokenBounds);
    if (lease.maxCostUsd !== null) {
      const estimatedCostUsd = estimateProviderRequestCost(providerId, model, endpointClass, body, requestBytes);
      if (estimatedCostUsd === null) {
        releaseActive();
        return this.failure(lease, providerId, request, route, 429, "Provider request cost cannot be safely bounded under this lease.", started, requestBytes);
      }
      if (Math.max(lease.observedCostUsd, lease.accountedCostUsd + estimatedCostUsd) > lease.maxCostUsd) {
        releaseActive();
        return this.failure(lease, providerId, request, route, 429, "Broker cost budget would be exceeded by this request.", started, requestBytes);
      }
      const aggregateCostFailure = this.aggregateCostFailure(lease, estimatedCostUsd);
      if (aggregateCostFailure) {
        releaseActive();
        return this.failure(lease, providerId, request, route, 429, aggregateCostFailure, started, requestBytes);
      }
      // Charge the conservative request maximum before provider egress. This
      // remains separate from observed cost so final run reconciliation does
      // not count both the reservation and provider-reported usage.
      lease.accountedCostUsd += estimatedCostUsd;
      this.accountAggregateCost(lease, estimatedCostUsd);
    }

    const credential = this.credentials[provider.credentialEnv];
    if (!credential) {
      releaseActive();
      return this.failure(lease, providerId, request, route, 503, `Provider credential ${provider.credentialEnv} is unavailable.`, started, requestBytes);
    }
    let upstream: URL;
    let headers: Headers;
    try {
      upstream = new URL(providerPath + url.search, this.upstreams[providerId] ?? provider.upstream);
      // Never forward client-supplied key query credentials upstream.
      upstream.searchParams.delete("key");
      headers = forwardedHeaders(request.headers);
      provider.authenticate(headers, credential, upstream);
    } catch (error) {
      releaseActive();
      return this.failure(lease, providerId, request, route, 502, messageOf(error), started, requestBytes);
    }

    const upstreamController = new AbortController();
    let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let downstreamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let cleanedUp = false;
    let streamTimedOut = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimeout(timeout);
      request.signal.removeEventListener("abort", abort);
      try {
        upstreamReader?.releaseLock();
      } catch (error) {
        recordRuntimeDiagnostic("cleanup", "broker.upstream-reader-release", error);
      }
      releaseActive();
    };
    const terminateStream = (reason: string, timedOut: boolean) => {
      streamTimedOut ||= timedOut;
      upstreamController.abort(reason);
      void upstreamReader?.cancel(reason).catch(() => {});
      // Headers may already be on the wire, so the HTTP status can no longer
      // change. End the body, revoke its upstream work, and retain explicit
      // terminal evidence in the bounded broker log.
      try {
        downstreamController?.close();
      } catch (error) {
        recordRuntimeDiagnostic("cleanup", "broker.downstream-controller-close", error);
      }
      this.record(
        lease,
        providerId,
        route,
        request.method,
        timedOut ? 504 : 499,
        requestBytes,
        Date.now() - started,
        timedOut ? "Provider stream exceeded its duration limit." : "Provider stream was cancelled.",
      );
      cleanup();
    };
    const remainingStreamMs = Math.max(1, lease.maxStreamMs - (Date.now() - started));
    const timeout = setTimeout(() => terminateStream("broker streaming duration exceeded", true), remainingStreamMs);
    const abort = () => terminateStream("worker request cancelled", false);
    request.signal.addEventListener("abort", abort, { once: true });
    let responseOwnsCleanup = false;
    try {
      lease.forwardedRequests += 1;
      this.syncLinkedTargetObservation(lease, true);
      const response = await this.fetcher(upstream, {
        method: request.method,
        headers,
        body,
        signal: upstreamController.signal,
        redirect: "manual",
      });
      releaseBody();
      const responseHeaders = safeResponseHeaders(response.headers);
      this.record(lease, providerId, route, request.method, response.status, requestBytes, Date.now() - started, null);
      if (!response.body) {
        cleanup();
        return new Response(null, { status: response.status, headers: responseHeaders });
      }
      upstreamReader = response.body.getReader();
      const streamed = new ReadableStream<Uint8Array>({
        async pull(controller) {
          downstreamController = controller;
          try {
            const { done, value } = await upstreamReader!.read();
            if (done) {
              controller.close();
              cleanup();
            } else if (value) {
              controller.enqueue(value);
            }
          } catch {
            if (!cleanedUp) controller.error(new Error(streamTimedOut ? "Provider stream exceeded its duration limit." : "Provider stream failed."));
            cleanup();
          }
        },
        async cancel(reason) {
          upstreamController.abort("worker stopped consuming provider stream");
          await upstreamReader?.cancel(reason).catch(() => {});
          cleanup();
        },
      });
      responseOwnsCleanup = true;
      return new Response(streamed, { status: response.status, headers: responseHeaders });
    } catch (error) {
      const timedOut = streamTimedOut || (upstreamController.signal.aborted && !request.signal.aborted);
      return this.failure(lease, providerId, request, route, timedOut ? 504 : 502, timedOut ? "Provider request exceeded its duration limit." : messageOf(error), started, requestBytes);
    } finally {
      if (!responseOwnsCleanup) cleanup();
    }
  }

  private findLease(token: string) {
    const candidate = digestToken(token);
    for (const lease of this.leases.values()) {
      if (candidate.length === lease.tokenHash.length && timingSafeEqual(candidate, lease.tokenHash)) return lease;
    }
    return null;
  }

  private registerBudgetQuotas(quotas: BrokerBudgetQuota[], expiresAt: number) {
    const newIds = new Set(quotas.filter((quota) => !this.budgetQuotas.has(quota.id)).map((quota) => quota.id));
    if (this.budgetQuotas.size + newIds.size > MAX_RETAINED_BUDGET_QUOTAS) {
      throw new Error("Provider broker budget quota retention limit is exhausted.");
    }
    for (const quota of quotas) {
      const existing = this.budgetQuotas.get(quota.id);
      if (!existing) {
        this.budgetQuotas.set(quota.id, { ...quota });
        this.persistBudgetQuota?.(quota, expiresAt);
        continue;
      }
      existing.maxRequests = quota.maxRequests;
      existing.maxInputTokens = quota.maxInputTokens;
      existing.maxOutputTokens = quota.maxOutputTokens;
      existing.maxCostUsd = quota.maxCostUsd;
      // Durable commits can advance while other leases remain active. Never
      // move a broker-observed counter backwards when synchronizing them.
      existing.usedRequests = Math.max(existing.usedRequests, quota.usedRequests);
      existing.usedInputTokens = Math.max(existing.usedInputTokens, quota.usedInputTokens);
      existing.usedOutputTokens = Math.max(existing.usedOutputTokens, quota.usedOutputTokens);
      existing.usedCostUsd = Math.max(existing.usedCostUsd, quota.usedCostUsd);
      this.persistBudgetQuota?.(existing, expiresAt);
    }
  }

  private aggregateRequestFailure(lease: Lease) {
    for (const scoped of lease.budgetQuotas) {
      const quota = this.budgetQuotas.get(scoped.id);
      if (!quota) return `Broker budget quota ${scoped.id} is unavailable.`;
      if (quota.maxRequests !== null && quota.usedRequests + 1 > quota.maxRequests) {
        return `Broker aggregate request budget ${quota.id} is exhausted.`;
      }
    }
    return null;
  }

  private accountAggregateRequest(lease: Lease) {
    for (const scoped of lease.budgetQuotas) {
      const quota = this.budgetQuotas.get(scoped.id)!;
      quota.usedRequests += 1;
      this.persistBudgetQuota?.(quota);
    }
  }

  private aggregateTokenFailure(lease: Lease, bounds: ProviderTokenBounds) {
    for (const scoped of lease.budgetQuotas) {
      const quota = this.budgetQuotas.get(scoped.id);
      if (!quota) return `Broker budget quota ${scoped.id} is unavailable.`;
      if (quota.maxInputTokens !== null && quota.usedInputTokens + bounds.inputTokens > quota.maxInputTokens) {
        return `Broker aggregate input token budget ${quota.id} would be exceeded by this request.`;
      }
      if (quota.maxOutputTokens !== null) {
        if (bounds.outputTokens === null) {
          return `Provider request output tokens cannot be safely bounded under broker budget ${quota.id}.`;
        }
        if (quota.usedOutputTokens + bounds.outputTokens > quota.maxOutputTokens) {
          return `Broker aggregate output token budget ${quota.id} would be exceeded by this request.`;
        }
      }
    }
    return null;
  }

  private accountAggregateTokens(lease: Lease, bounds: ProviderTokenBounds) {
    const accountsInput = lease.budgetQuotas.some((scoped) => this.budgetQuotas.get(scoped.id)?.maxInputTokens != null);
    const accountsOutput = lease.budgetQuotas.some((scoped) => this.budgetQuotas.get(scoped.id)?.maxOutputTokens != null);
    if (accountsInput) lease.accountedInputTokens += bounds.inputTokens;
    if (accountsOutput) lease.accountedOutputTokens += bounds.outputTokens ?? 0;
    for (const scoped of lease.budgetQuotas) {
      const quota = this.budgetQuotas.get(scoped.id)!;
      if (quota.maxInputTokens !== null) quota.usedInputTokens += bounds.inputTokens;
      if (quota.maxOutputTokens !== null) quota.usedOutputTokens += bounds.outputTokens ?? 0;
      this.persistBudgetQuota?.(quota);
    }
  }

  private aggregateCostFailure(lease: Lease, amountUsd: number) {
    for (const scoped of lease.budgetQuotas) {
      const quota = this.budgetQuotas.get(scoped.id);
      if (!quota) return `Broker budget quota ${scoped.id} is unavailable.`;
      if (quota.maxCostUsd !== null && quota.usedCostUsd + amountUsd > quota.maxCostUsd) {
        return `Broker aggregate cost budget ${quota.id} would be exceeded by this request.`;
      }
    }
    return null;
  }

  private accountAggregateCost(lease: Lease, amountUsd: number) {
    for (const scoped of lease.budgetQuotas) {
      const quota = this.budgetQuotas.get(scoped.id)!;
      if (quota.maxCostUsd !== null) quota.usedCostUsd += amountUsd;
      this.persistBudgetQuota?.(quota);
    }
  }

  private pruneLeases(now = Date.now()) {
    for (const [id, lease] of this.leases) {
      if (lease.activeRequests === 0 && (lease.revoked || lease.expiresAt <= now)) {
        this.leases.delete(id);
      }
    }
  }

  private failure(lease: Lease | null, provider: string | null, request: Request, route: string, status: number, error: string, started: number, bytes: number) {
    const safe = redactAndTruncate(error, 2_048).text;
    this.record(lease, provider, route, request.method, status, bytes, Date.now() - started, safe);
    return Response.json({ error: { code: "BROKER_REJECTED", message: safe } }, { status });
  }

  private record(lease: Lease | null, provider: string | null, route: string, method: string, status: number, requestBytes: number, durationMs: number, error: string | null) {
    this.logs.push({ id: randomUUID(), runId: lease?.runId ?? null, provider, route, method, status, requestBytes, durationMs, error });
    if (this.logs.length > this.maxLogEntries) this.logs.splice(0, this.logs.length - this.maxLogEntries);
  }
}

function linkedOperationId(linkId: string, kind: "parent" | "target") {
  const ids = linkedProviderOperationIds(digest.parse(linkId));
  return kind === "parent" ? ids.parentOperationId : ids.targetOperationId;
}

function linkedTargetRunQuotaId(linkId: string) {
  return linkedProviderOperationIds(digest.parse(linkId)).targetRunQuotaId;
}

function linkedParentIdentity(parentRunId: string, allocation: z.infer<typeof BrokerLinkedAllocationSchema>) {
  return JSON.stringify({ parentRunId, allocation });
}

function linkedTargetIdentity(childRunId: string, scope: BrokerLinkedTargetScope) {
  return JSON.stringify({ childRunId, scope });
}

function linkedConflict(message: string) {
  return new HeadlessError("CONFLICT", message);
}

function linkedTargetLeaseScope(operationId: string, childRunId: string, scope: BrokerLinkedTargetScope) {
  const linkId = operationId.slice(0, 64);
  const runQuotaId = linkedTargetRunQuotaId(linkId);
  if (scope.budgetQuotas.some((quota) => quota.id === runQuotaId)) {
    throw linkedConflict("Linked target scope cannot supply its broker-derived run quota.");
  }
  return BrokerLeaseScopeSchema.parse({
    runId: childRunId,
    provider: scope.provider,
    models: scope.models,
    endpointClasses: scope.endpointClasses,
    expiresAt: Math.min(scope.expiresAt, scope.childDeadlineAt + scope.replyMarginMs),
    maxRequests: scope.maxRequests,
    maxBodyBytes: scope.maxBodyBytes,
    maxConcurrentRequests: scope.maxConcurrentRequests,
    maxInFlightBodyBytes: scope.maxInFlightBodyBytes,
    maxStreamMs: scope.maxStreamMs,
    maxCostUsd: scope.maxCostUsd,
    budgetQuotas: [
      {
        id: runQuotaId,
        maxRequests: scope.maxRequests,
        usedRequests: 0,
        maxInputTokens: scope.maxInputTokens,
        usedInputTokens: 0,
        maxOutputTokens: scope.maxOutputTokens,
        usedOutputTokens: 0,
        maxCostUsd: scope.maxCostUsd,
        usedCostUsd: 0,
      },
      ...scope.budgetQuotas,
    ],
  });
}

function emptyLinkedTargetObservation(leaseId: string, expiresAt: number) {
  return BrokerLinkedTargetObservationSchema.parse({
    leaseId,
    requests: 0,
    forwardedRequests: 0,
    observedCostUsd: 0,
    accountedCostUsd: 0,
    accountedInputTokens: 0,
    accountedOutputTokens: 0,
    activeRequests: 0,
    revoked: false,
    expiresAt,
  });
}

function linkedTargetObservation(lease: Lease) {
  return BrokerLinkedTargetObservationSchema.parse({
    leaseId: lease.id,
    requests: lease.requests,
    forwardedRequests: lease.forwardedRequests,
    observedCostUsd: lease.observedCostUsd,
    accountedCostUsd: lease.accountedCostUsd,
    accountedInputTokens: lease.accountedInputTokens,
    accountedOutputTokens: lease.accountedOutputTokens,
    activeRequests: lease.activeRequests,
    revoked: lease.revoked,
    expiresAt: lease.expiresAt,
  });
}

function linkedTargetEvidence(operation: z.infer<typeof BrokerLinkedTargetOperationSchema>) {
  return {
    targetLeaseId: operation.targetLeaseId,
    targetTokenHash: operation.targetTokenHash!,
    targetIssuedAt: operation.targetIssuedAt!,
    targetQuotaScope: BrokerLeaseScopeSchema.parse(operation.targetQuotaScope),
    targetExpiresAt: operation.targetExpiresAt,
  };
}

function addUnusedIssues(
  allocation: z.infer<typeof BrokerLinkedAllocationSchema>,
  unused: z.infer<typeof BrokerLinkedUnusedSchema>,
  context: z.RefinementCtx,
) {
  if (unused.requests > allocation.requests) context.addIssue({ code: z.ZodIssueCode.custom, path: ["unused", "requests"], message: "Unused linked requests exceed the allocation." });
  addUnusedNullableIssue("inputTokens", allocation.inputTokens, unused.inputTokens, context);
  addUnusedNullableIssue("outputTokens", allocation.outputTokens, unused.outputTokens, context);
  addUnusedNullableIssue("costUsd", allocation.costUsd, unused.costUsd, context);
}

function addUnusedNullableIssue(
  field: "inputTokens" | "outputTokens" | "costUsd",
  allocation: number | null,
  unused: number | null,
  context: z.RefinementCtx,
) {
  if (allocation === null && unused !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["unused", field], message: `Unknown linked ${field} cannot be restored.` });
  } else if (allocation !== null && unused !== null && unused > allocation) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["unused", field], message: `Unused linked ${field} exceeds the allocation.` });
  }
}

function assertUnusedFits(allocation: z.infer<typeof BrokerLinkedAllocationSchema>, unused: z.infer<typeof BrokerLinkedUnusedSchema>) {
  if (unused.requests > allocation.requests) throw new TypeError("Unused linked requests exceed the allocation.");
  assertUnusedNullableFits("inputTokens", allocation.inputTokens, unused.inputTokens);
  assertUnusedNullableFits("outputTokens", allocation.outputTokens, unused.outputTokens);
  assertUnusedNullableFits("costUsd", allocation.costUsd, unused.costUsd);
}

function assertUnusedNullableFits(field: string, allocation: number | null, unused: number | null) {
  if (allocation === null && unused !== null) throw new TypeError(`Unknown linked ${field} cannot be restored.`);
  if (allocation !== null && unused !== null && unused > allocation) throw new TypeError(`Unused linked ${field} exceeds the allocation.`);
}

function digestToken(token: string) {
  return createHash("sha256").update(token).digest();
}

function extractToken(request: Request) {
  const explicit = request.headers.get("x-headless-token");
  if (explicit) return explicit;
  const authorization = request.headers.get("authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim();
  // Headers only — never accept lease tokens from ?key= (avoids query-string credential leakage).
  return request.headers.get("x-api-key") ?? request.headers.get("x-goog-api-key");
}

function routeAllowed(provider: ProviderDefinition, path: string) {
  return provider.routePrefixes.some((prefix) => (
    path === prefix
    || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)
    || path.startsWith(`${prefix}:`)
  ));
}

function classifyEndpoint(path: string): BrokerLeaseScope["endpointClasses"][number] | null {
  if (/\/chat\/completions(?:\/|$)/.test(path)) return "chat";
  if (/\/responses(?:\/|$)/.test(path)) return "responses";
  if (/\/messages(?:\/|$)/.test(path)) return "messages";
  if (/\/embeddings(?:\/|$)/.test(path)) return "embeddings";
  if (/\/models\/?$/.test(path)) return "models";
  if (/:generateContent$|:streamGenerateContent$/.test(path)) return "generate";
  return null;
}

function methodAllowed(endpoint: BrokerLeaseScope["endpointClasses"][number], method: string) {
  return endpoint === "models" ? method === "GET" : method === "POST";
}

async function readBodyBounded(request: Request, maxBytes: number, timeoutMs: number) {
  if (!request.body) return { body: null, bytes: 0, exceeded: false, timedOut: false };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel("broker request body duration exceeded").catch(() => {});
  }, timeoutMs);
  timer.unref?.();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel("broker request body limit exceeded").catch(() => {});
        return { body: null, bytes, exceeded: true, timedOut: false };
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch (error) {
      recordRuntimeDiagnostic("cleanup", "broker.request-reader-release", error);
    }
  }
  return { body: timedOut ? null : Buffer.concat(chunks, bytes), bytes, exceeded: false, timedOut };
}

function extractModel(path: string, body: Uint8Array | null) {
  const gemini = path.match(/\/models\/([^/:]+)(?::|\/|$)/)?.[1];
  if (gemini) return decodeURIComponent(gemini);
  if (!body?.byteLength) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body).toString("utf8")) as { model?: unknown };
    return typeof parsed.model === "string" && parsed.model ? parsed.model : null;
  } catch {
    return null;
  }
}

function parseJsonBody(body: Uint8Array | null) {
  if (!body?.byteLength) return null;
  try {
    return JSON.parse(Buffer.from(body).toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

function forceStandardServiceTier(provider: string, body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  if (provider === "openai" || provider === "xai") {
    return record.service_tier === undefined || record.service_tier === null
      ? { ...record, service_tier: "default" }
      : body;
  }
  if (provider === "anthropic") {
    return record.service_tier === undefined || record.service_tier === null
      ? { ...record, service_tier: "standard_only" }
      : body;
  }
  if (provider === "gemini") {
    return record.serviceTier == null && record.service_tier == null
      ? { ...record, serviceTier: "STANDARD" }
      : body;
  }
  return body;
}

type ProviderTokenBounds = {
  inputTokens: number;
  outputTokens: number | null;
};

/**
 * Tokenizers are provider/model-specific and unavailable at the broker trust
 * boundary. One serialized request byte per input token is a conservative
 * upper bound; output is reserved from the provider's explicit maximum.
 */
function providerTokenBounds(
  provider: string,
  endpointClass: BrokerLeaseScope["endpointClasses"][number],
  body: Uint8Array | null,
  requestBytes: number,
): ProviderTokenBounds {
  if (endpointClass === "models") return { inputTokens: 0, outputTokens: 0 };
  if (endpointClass === "embeddings") return { inputTokens: Math.max(1, requestBytes), outputTokens: 0 };
  return {
    inputTokens: Math.max(1, requestBytes),
    outputTokens: extractOutputTokenLimit(provider, body),
  };
}

function estimateProviderRequestCost(
  provider: string,
  model: string | null,
  endpointClass: BrokerLeaseScope["endpointClasses"][number],
  body: Uint8Array | null,
  requestBytes: number,
) {
  if (endpointClass === "models") return 0;
  if (!model) return null;
  const outputTokens = endpointClass === "embeddings" ? 0 : extractOutputTokenLimit(provider, body);
  if (outputTokens === null) return null;
  // A provider token cannot encode less than one byte of the serialized
  // request. Charging every request byte as an input token is conservative
  // while remaining protocol- and tokenizer-independent.
  const inputTokens = Math.max(1, requestBytes);
  const cost = calculateModelPricedCost({
    provider,
    model,
    usage: {
      input: inputTokens,
      output: outputTokens,
      reasoning: null,
      cached: 0,
      providerTotal: inputTokens + outputTokens,
    },
  });
  return cost.amountUsd;
}

function extractOutputTokenLimit(provider: string, body: Uint8Array | null) {
  if (!body?.byteLength) return null;
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(Buffer.from(body).toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    parsed = value as Record<string, unknown>;
  } catch {
    return null;
  }
  const generation = parsed.generationConfig;
  const generationSnake = parsed.generation_config;
  const candidates = provider === "gemini"
    ? [
        objectNumber(generation, "maxOutputTokens"),
        objectNumber(generationSnake, "max_output_tokens"),
      ]
    : provider === "anthropic"
      ? [numberValue(parsed.max_tokens)]
      : [
          numberValue(parsed.max_output_tokens),
          numberValue(parsed.max_completion_tokens),
          numberValue(parsed.max_tokens),
        ];
  const declared = candidates.filter((value): value is number => value !== null);
  if (declared.length === 0) return null;
  const rawMultipliers = provider === "gemini"
    ? [
        objectField(generation, "candidateCount"),
        objectField(generationSnake, "candidate_count"),
      ]
    : provider === "anthropic"
      ? []
      : [parsed.n, parsed.best_of];
  const presentMultipliers = rawMultipliers.filter((value) => value !== undefined && value !== null);
  if (presentMultipliers.some((value) => !isPositiveSafeInteger(value))) return null;
  const multiplier = presentMultipliers.length > 0 ? Math.max(...presentMultipliers as number[]) : 1;
  const total = Math.max(...declared) * multiplier;
  return Number.isSafeInteger(total) ? total : null;
}

function objectNumber(value: unknown, key: string) {
  return numberValue(objectField(value, key));
}

function objectField(value: unknown, key: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

function numberValue(value: unknown) {
  return isPositiveSafeInteger(value) ? value : null;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function forwardedHeaders(source: Headers) {
  const headers = new Headers(source);
  for (const key of ["authorization", "x-api-key", "x-goog-api-key", "x-headless-token", "host", "cookie", "proxy-authorization", "content-length"]) {
    headers.delete(key);
  }
  return headers;
}

function safeResponseHeaders(source: Headers) {
  const headers = new Headers();
  for (const key of ["content-type", "cache-control", "x-request-id", "openai-processing-ms", "anthropic-ratelimit-requests-remaining"]) {
    const value = source.get(key);
    if (value) headers.set(key, value);
  }
  return headers;
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function resolveAllowLoopbackTcp(explicit: boolean | undefined, sourceEnv: Readonly<NodeJS.ProcessEnv>): boolean {
  if (explicit === true) return true;
  if (explicit === false) return false;
  const env = sourceEnv.HEADLESS_BROKER_ALLOW_LOOPBACK_TCP?.trim().toLowerCase();
  // Explicit env opt-out honored on all platforms (operators who accept AF_UNIX-only breakage).
  if (env === "0" || env === "false" || env === "no" || env === "off") return false;
  if (env === "1" || env === "true" || env === "yes" || env === "on") return true;
  if (env) {
    throw new TypeError("HEADLESS_BROKER_ALLOW_LOOPBACK_TCP must be one of: 0, 1, false, true, no, yes, off, on.");
  }
  // Default to a real loopback owner on every platform. Required-contained Linux
  // workers still use the AF_UNIX relay, but host-side and explicit unsafe runs
  // consume baseUrl directly and must never receive the synthetic unowned port.
  return true;
}

function boundedPositive(value: number, maximum: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new TypeError(`${label} must be a positive bounded integer.`);
  return value;
}

function assertCarveFits(label: string, allocation: number | null, maximum: number | null, used: number) {
  if (allocation === null) {
    if (maximum !== null) throw new Error(`Delegated ${label} allocation is unknown under a finite parent lease.`);
    return;
  }
  if (maximum === null) return;
  if (allocation > Math.max(0, maximum - used)) throw new Error(`Parent broker ${label} remainder cannot fund the delegated slice.`);
}

function unusedNullable(allocated: number | null, actual: number | null | undefined) {
  if (allocated === null || actual === null || actual === undefined) return null;
  return Math.max(0, allocated - actual);
}

function minimumNullableLimit(left: number | null, right: number | null) {
  if (left === null) return right;
  if (right === null) return left;
  return Math.min(left, right);
}
