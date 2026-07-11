import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { IdentifierSchema, PrincipalIdSchema, ProjectIdSchema } from "../contracts/common";
import { TaskSchema, type Task } from "../contracts/durable";
import { atomicWriteFile } from "../runtime/atomic-write";
import { HeadlessError } from "../runtime/headless-error";
import { ensureOwnerOnlyDirectory, ensureOwnerOnlyFile } from "../runtime/project-state";
import { safeJsonParse } from "../runtime/safe-json";

export const MAX_TASK_LEASE_MS = 86_400_000;

const CreateTaskInputSchema = z.object({
  jobId: IdentifierSchema,
  projectId: ProjectIdSchema,
  capability: z.string().trim().min(1).max(128),
}).strict();

const AuthenticatedTaskActorSchema = z.object({
  /** Must come from the daemon's authenticated connection, never client params. */
  principal: PrincipalIdSchema,
}).strict();

const ClaimTaskInputSchema = AuthenticatedTaskActorSchema.extend({
  taskId: IdentifierSchema,
  leaseMs: z.number().int().positive().max(MAX_TASK_LEASE_MS),
}).strict();

const CompleteTaskInputSchema = AuthenticatedTaskActorSchema.extend({
  taskId: IdentifierSchema,
  outcome: z.enum(["completed", "failed"]).default("completed"),
}).strict();

const CancelTaskInputSchema = AuthenticatedTaskActorSchema.extend({
  taskId: IdentifierSchema,
}).strict();

export type AuthenticatedTaskActor = z.infer<typeof AuthenticatedTaskActorSchema>;
export type CreateTaskInput = z.input<typeof CreateTaskInputSchema>;
export type ClaimTaskInput = z.input<typeof ClaimTaskInputSchema>;
export type CompleteTaskInput = z.input<typeof CompleteTaskInputSchema>;
export type CancelTaskInput = z.input<typeof CancelTaskInputSchema>;

export type TaskStoreOptions = {
  now?: () => number;
  createId?: () => string;
  /** Disable until the daemon has won the canonical project socket. */
  recoverOnOpen?: boolean;
};

/** Durable project-scoped task claims. A single authenticated daemon owns writes. */
export class TaskStore {
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(private readonly tasksDir: string, options: TaskStoreOptions = {}) {
    ensureOwnerOnlyDirectory(tasksDir);
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    if (options.recoverOnOpen ?? true) this.recoverStaleLeases();
  }

  create(input: CreateTaskInput) {
    const parsed = CreateTaskInputSchema.parse(input);
    const now = checkedTimestamp(this.now());
    const task = TaskSchema.parse({
      id: IdentifierSchema.parse(this.createId()),
      jobId: parsed.jobId,
      projectId: parsed.projectId,
      capability: parsed.capability,
      state: "pending",
      claimedBy: null,
      leaseExpiresAt: null,
      createdAt: now,
      updatedAt: now,
    });
    if (existsSync(this.taskPath(task.id))) throw new Error(`Task id already exists: ${task.id}`);
    this.write(task);
    return task;
  }

  get(id: string) {
    const path = this.taskPath(IdentifierSchema.parse(id));
    if (!existsSync(path)) return null;
    ensureOwnerOnlyFile(path);
    return TaskSchema.parse(safeJsonParse(readFileSync(path, "utf8")));
  }

  list(filter: { jobId?: string; state?: Task["state"] } = {}) {
    const jobId = filter.jobId === undefined ? undefined : IdentifierSchema.parse(filter.jobId);
    const state = filter.state;
    const tasks = readdirSync(this.tasksDir)
      .filter((name) => name.endsWith(".task.json"))
      .map((name) => {
        const path = join(this.tasksDir, name);
        ensureOwnerOnlyFile(path);
        return TaskSchema.parse(safeJsonParse(readFileSync(path, "utf8")));
      });
    return tasks
      .filter((task) => jobId === undefined || task.jobId === jobId)
      .filter((task) => state === undefined || task.state === state)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  }

  claim(input: ClaimTaskInput) {
    const parsed = ClaimTaskInputSchema.parse(input);
    const now = checkedTimestamp(this.now());
    const task = this.releaseIfStale(this.require(parsed.taskId), now);
    if (task.state !== "pending") {
      throw conflict(`Task ${task.id} is ${task.state} and cannot be claimed.`);
    }
    return this.update(task, {
      state: "claimed",
      claimedBy: parsed.principal,
      leaseExpiresAt: checkedTimestamp(now + parsed.leaseMs),
      updatedAt: now,
    });
  }

  renew(input: ClaimTaskInput) {
    const parsed = ClaimTaskInputSchema.parse(input);
    const now = checkedTimestamp(this.now());
    const task = this.releaseIfStale(this.require(parsed.taskId), now);
    this.assertClaimOwner(task, parsed.principal);
    return this.update(task, {
      leaseExpiresAt: checkedTimestamp(now + parsed.leaseMs),
      updatedAt: now,
    });
  }

  complete(input: CompleteTaskInput) {
    const parsed = CompleteTaskInputSchema.parse(input);
    const now = checkedTimestamp(this.now());
    const task = this.releaseIfStale(this.require(parsed.taskId), now);
    if (task.state === parsed.outcome && task.claimedBy === parsed.principal) return task;
    this.assertClaimOwner(task, parsed.principal);
    return this.update(task, {
      state: parsed.outcome,
      leaseExpiresAt: null,
      updatedAt: now,
    });
  }

  /** Resolve the task from the owning daemon's terminal job state, regardless of a worker lease. */
  resolveFromDaemon(input: CompleteTaskInput) {
    const parsed = CompleteTaskInputSchema.parse(input);
    const now = checkedTimestamp(this.now());
    const task = this.require(parsed.taskId);
    if (task.state === "completed" || task.state === "failed" || task.state === "cancelled") return task;
    return this.update(task, {
      state: parsed.outcome,
      claimedBy: task.claimedBy ?? parsed.principal,
      leaseExpiresAt: null,
      updatedAt: now,
    });
  }

  cancel(input: CancelTaskInput) {
    const parsed = CancelTaskInputSchema.parse(input);
    const now = checkedTimestamp(this.now());
    const task = this.releaseIfStale(this.require(parsed.taskId), now);
    if (task.state === "cancelled") return task;
    if (task.state === "completed" || task.state === "failed") {
      throw conflict(`Terminal task ${task.id} cannot be cancelled.`);
    }
    return this.update(task, {
      state: "cancelled",
      // Preserve an existing claimant for attribution; otherwise record the
      // authenticated cancelling principal in the only actor field in Task v2.
      claimedBy: task.claimedBy ?? parsed.principal,
      leaseExpiresAt: null,
      updatedAt: now,
    });
  }

  recoverStaleLeases(now = checkedTimestamp(this.now())) {
    const recovered: Task[] = [];
    for (const task of this.list({ state: "claimed" })) {
      if (task.leaseExpiresAt !== null && task.leaseExpiresAt <= now) {
        recovered.push(this.release(task, now));
      }
    }
    return recovered;
  }

  private releaseIfStale(task: Task, now: number) {
    if (task.state !== "claimed" || task.leaseExpiresAt === null || task.leaseExpiresAt > now) return task;
    return this.release(task, now);
  }

  private release(task: Task, now: number) {
    return this.update(task, {
      state: "pending",
      claimedBy: null,
      leaseExpiresAt: null,
      updatedAt: now,
    });
  }

  private assertClaimOwner(task: Task, principal: string) {
    if (task.state !== "claimed") throw conflict(`Task ${task.id} no longer has an active claim.`);
    if (task.claimedBy !== principal) throw policyDenied(`Task ${task.id} is claimed by another authenticated principal.`);
  }

  private require(id: string) {
    const task = this.get(id);
    if (!task) throw invalidRequest(`Unknown task: ${id}`);
    return task;
  }

  private update(task: Task, patch: Partial<Task>) {
    const next = TaskSchema.parse({ ...task, ...patch, id: task.id, jobId: task.jobId, projectId: task.projectId, createdAt: task.createdAt });
    this.write(next);
    return next;
  }

  private write(task: Task) {
    const path = this.taskPath(task.id);
    atomicWriteFile(path, `${JSON.stringify(task)}\n`, { mode: 0o600 });
    ensureOwnerOnlyFile(path);
  }

  private taskPath(id: string) {
    if (!/^[a-zA-Z0-9-]{1,160}$/.test(id)) throw invalidRequest("Invalid task id.");
    return join(this.tasksDir, `${id}.task.json`);
  }
}

function checkedTimestamp(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Task clock must return a non-negative safe integer.");
  return value;
}

function conflict(message: string) {
  return new HeadlessError("CONFLICT", message);
}

function policyDenied(message: string) {
  return new HeadlessError("POLICY_DENIED", message);
}

function invalidRequest(message: string) {
  return new HeadlessError("INVALID_REQUEST", message);
}
