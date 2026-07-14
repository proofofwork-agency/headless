import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JobSchema, type Job } from "../contracts/durable";
import { RunRequestSchema, type RunResult, type SerializedRunRequest } from "../contracts/run";
import { atomicWriteFile } from "../runtime/atomic-write";
import { ensureOwnerOnlyDirectory, ensureOwnerOnlyFile } from "../runtime/project-state";
import { safeJsonParse } from "../runtime/safe-json";
import { decodePersistedRunResult } from "../runtime/persisted-run-result";

const terminalStates = new Set<Job["state"]>(["succeeded", "failed", "timed_out", "cancelled", "blocked"]);
const transitions: Record<Job["state"], Job["state"][]> = {
  queued: ["preparing", "timed_out", "cancelled", "blocked"],
  preparing: ["running", "failed", "cancelled", "blocked"],
  running: ["cancelling", "succeeded", "failed", "timed_out", "cancelled", "blocked"],
  cancelling: ["cancelled", "failed", "timed_out"],
  succeeded: [],
  failed: [],
  timed_out: [],
  cancelled: [],
  blocked: [],
};

export class JobStore {
  constructor(private readonly jobsDir: string) {
    ensureOwnerOnlyDirectory(jobsDir);
  }

  create(input: {
    id?: string;
    projectId: string;
    principal: string;
    request: SerializedRunRequest;
    maxAttempts?: number;
    retryNumber?: number;
    mergePolicy?: Job["mergePolicy"];
    workflowId?: string | null;
    councilId?: string | null;
    councilSlot?: string | null;
  }) {
    const now = Date.now();
    const job = JobSchema.parse({
      id: input.id ?? randomUUID(),
      projectId: input.projectId,
      principal: input.principal,
      sessionId: input.request.sessionId ?? null,
      workflowId: input.workflowId ?? null,
      councilId: input.councilId ?? null,
      councilSlot: input.councilSlot ?? null,
      backend: input.request.backend,
      mode: input.request.mode,
      authMode: input.request.authMode,
      approvalPolicy: input.request.approvalPolicy,
      mergePolicy: input.mergePolicy ?? "authorized",
      state: "queued",
      attempt: 1,
      maxAttempts: input.maxAttempts ?? 1,
      retryNumber: input.retryNumber ?? 0,
      createdAt: now,
      updatedAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
      result: null,
    });
    // The job file is the durable visibility/commit point. Persist its request
    // first so a crash can leave at most an ignored orphan request, never a
    // queued job that has no executable request and cannot be reconciled.
    this.writeRequest(job.id, input.request);
    this.writeJob(job);
    return job;
  }

  get(id: string) {
    const path = this.jobPath(id);
    if (!existsSync(path)) return null;
    return parsePersistedJob(safeJsonParse(readFileSync(path, "utf8")));
  }

  request(id: string) {
    const path = this.requestPath(id);
    if (!existsSync(path)) return null;
    return RunRequestSchema.parse(safeJsonParse(readFileSync(path, "utf8")));
  }

  list() {
    return readdirSync(this.jobsDir)
      .filter((name) => name.endsWith(".job.json"))
      .map((name) => parsePersistedJob(safeJsonParse(readFileSync(join(this.jobsDir, name), "utf8"))))
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  transition(id: string, state: Job["state"], patch: Partial<Pick<Job, "leaseOwner" | "leaseExpiresAt">> = {}) {
    const job = this.require(id);
    if (!transitions[job.state].includes(state)) throw new Error(`Invalid job transition ${job.state} -> ${state}.`);
    const next = JobSchema.parse({ ...job, ...patch, state, updatedAt: Date.now() });
    this.writeJob(next);
    return next;
  }

  claim(id: string, owner: string, leaseMs: number) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new TypeError("Job lease must be a positive safe integer.");
    return this.transition(id, "preparing", { leaseOwner: owner, leaseExpiresAt: Date.now() + leaseMs });
  }

  complete(id: string, result: RunResult) {
    const job = this.require(id);
    const state: Job["state"] = result.status;
    if (!transitions[job.state].includes(state)) throw new Error(`Invalid job completion ${job.state} -> ${state}.`);
    const next = JobSchema.parse({
      ...job,
      state,
      result,
      updatedAt: Date.now(),
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    this.writeJob(next);
    return next;
  }

  isTerminal(id: string) {
    const job = this.get(id);
    return !!job && terminalStates.has(job.state);
  }

  /**
   * Recover work whose owning daemon is gone. `force` is only safe after the
   * caller has won the project socket, which proves no other daemon can still
   * own an otherwise-unexpired lease.
   */
  recoverInterruptedJobs(force = false) {
    const now = Date.now();
    const recovered: Job[] = [];
    for (const job of this.list()) {
      if (terminalStates.has(job.state)) continue;
      if (job.state === "queued") continue;
      if (!force && job.leaseExpiresAt !== null && job.leaseExpiresAt > now) continue;
      if (job.state === "cancelling") {
        const next = JobSchema.parse({
          ...job,
          state: "cancelled",
          updatedAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          result: cancellationRecoveryResult(job),
        });
        this.writeJob(next);
        recovered.push(next);
        continue;
      }
      const retry = job.attempt < job.maxAttempts;
      const next = JobSchema.parse({
        ...job,
        state: retry ? "queued" : "failed",
        attempt: retry ? job.attempt + 1 : job.attempt,
        updatedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        result: retry ? null : crashResult(job),
      });
      this.writeJob(next);
      recovered.push(next);
    }
    return recovered;
  }

  /**
   * Reconcile the truth established by a durable primary-update journal. This
   * may repair an earlier generic crash result, but it never overwrites an
   * independently successful terminal job.
   */
  recoverAppliedIntegration(id: string, result: RunResult) {
    if (!result.commit?.merged || !result.commit.result || result.status !== "succeeded") {
      throw new Error("Applied integration recovery requires a merged successful result.");
    }
    const job = this.require(id);
    if (job.state === "succeeded") return job;
    if (terminalStates.has(job.state) && job.result?.error?.message !== "Daemon stopped while the job lease was active.") {
      throw new Error(`Cannot replace terminal job ${id} (${job.state}) from the integration journal.`);
    }
    const next = JobSchema.parse({
      ...job,
      state: "succeeded",
      result,
      updatedAt: Date.now(),
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    this.writeJob(next);
    return next;
  }

  private require(id: string) {
    const job = this.get(id);
    if (!job) throw new Error(`Unknown job: ${id}`);
    return job;
  }

  private writeJob(job: Job) {
    const path = this.jobPath(job.id);
    atomicWriteFile(path, `${JSON.stringify(job)}\n`, { mode: 0o600 });
    ensureOwnerOnlyFile(path);
  }

  private writeRequest(id: string, request: SerializedRunRequest) {
    const path = this.requestPath(id);
    atomicWriteFile(path, `${JSON.stringify(request)}\n`, { mode: 0o600 });
    ensureOwnerOnlyFile(path);
  }

  private jobPath(id: string) {
    return join(this.jobsDir, `${safeId(id)}.job.json`);
  }

  private requestPath(id: string) {
    return join(this.jobsDir, `${safeId(id)}.request.json`);
  }
}

function parsePersistedJob(value: unknown) {
  if (!isRecord(value)) return JobSchema.parse(value);
  return JobSchema.parse({
    ...value,
    result: value.result === null ? null : decodePersistedRunResult(value.result),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeId(id: string) {
  if (!/^[a-zA-Z0-9-]{1,160}$/.test(id)) throw new Error("Invalid job id.");
  return id;
}

function crashResult(job: Job): RunResult {
  return {
    status: "failed",
    error: { code: "PROCESS_ERROR", message: "Daemon stopped while the job lease was active.", retryable: true },
    backend: job.backend,
    output: "Daemon stopped while the job lease was active.",
    stderr: "",
    diagnostics: { format: "daemon", malformedEvents: 0, ignoredEvents: 0, messages: [] },
    exitCode: null,
    signal: null,
    usage: { input: null, output: null, reasoning: null, cached: null, providerTotal: null },
    cost: { amountUsd: null, source: "unknown", pricingId: null, observedRequests: 0 },
    containment: { requirement: "required", enforced: false, platform: platform(), mechanism: null, probe: null, isolatedHome: false, credentialsIsolated: false, network: "denied", credentialAccess: "none", unsafe: false },
    durationMs: 0,
    sessionId: job.sessionId,
    jobId: job.id,
    diff: null,
    commit: null,
    truncation: { stdout: false, stderr: false, output: false, events: false, artifacts: false, diff: false },
  };
}

function cancellationRecoveryResult(job: Job): RunResult {
  return {
    ...crashResult(job),
    status: "cancelled",
    error: {
      code: "CANCELLED",
      message: "Daemon stopped while cancellation was in progress; the job will not be retried.",
      retryable: false,
    },
    output: "Daemon stopped while cancellation was in progress; the job will not be retried.",
  };
}

function platform(): RunResult["containment"]["platform"] {
  if (process.platform === "darwin" || process.platform === "linux" || process.platform === "win32") return process.platform;
  return "other";
}
