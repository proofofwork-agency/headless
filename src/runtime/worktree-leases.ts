import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { getHeadSha, runGitStrict } from "./git";
import { getProcessStartIdentity } from "./ledger-v2";
import { readOwnerOnlyJson, writeOwnerOnlyJson } from "./owner-json";
import { ensureOwnerOnlyDirectory } from "./project-state";
import { redactAndTruncate } from "./redaction";
import type { WorktreeLeaseHooks, WriteWorktreePlan } from "./worktree";

const OwnerSchema = z.object({
  pid: z.number().int().positive(),
  processStart: z.string().min(1).max(256),
  host: z.string().min(1).max(256),
  nonce: z.string().uuid(),
}).strict();

export const WorktreeLeaseSchema = z.object({
  version: z.literal(2),
  id: z.string().uuid(),
  jobId: z.string().min(1).max(160),
  projectId: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(["candidate", "integration"]),
  state: z.enum(["preparing", "active", "released", "crashed", "preserved"]),
  primaryRoot: z.string().min(1).max(4_096),
  worktreePath: z.string().min(1).max(4_096),
  branch: z.string().min(1).max(512),
  baseSha: z.string().min(1).max(128),
  owner: OwnerSchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  terminalOutcome: z.string().max(256).nullable(),
  evidence: z.array(z.string().max(4_096)).max(32),
}).strict();

export type WorktreeLease = z.infer<typeof WorktreeLeaseSchema>;

type WorktreeLeaseStoreOptions = {
  owner?: z.infer<typeof OwnerSchema>;
  now?: () => number;
  checkoutBase?: string;
};

/** Durable manifests for every daemon-owned write/integration checkout. */
export class WorktreeLeaseStore {
  readonly checkoutRoot: string;
  readonly manifestsRoot: string;
  private readonly owner: z.infer<typeof OwnerSchema>;
  private readonly now: () => number;

  constructor(
    root: string,
    private readonly projectId: string,
    options: WorktreeLeaseStoreOptions = {},
  ) {
    this.checkoutRoot = ensureOwnerOnlyDirectory(options.checkoutBase ?? join(root, "checkouts"));
    this.manifestsRoot = ensureOwnerOnlyDirectory(join(root, "leases"));
    this.owner = OwnerSchema.parse(options.owner ?? {
      pid: process.pid,
      processStart: getProcessStartIdentity(),
      host: hostname(),
      nonce: randomUUID(),
    });
    this.now = options.now ?? Date.now;
  }

  acquire(jobId: string, plan: WriteWorktreePlan, kind: "candidate" | "integration" = "candidate") {
    const now = this.now();
    const lease = WorktreeLeaseSchema.parse({
      version: 2,
      id: randomUUID(),
      jobId,
      projectId: this.projectId,
      kind,
      state: "preparing",
      primaryRoot: plan.primaryRoot,
      worktreePath: plan.worktreePath,
      branch: plan.branch,
      baseSha: plan.baseSha,
      owner: this.owner,
      createdAt: now,
      updatedAt: now,
      terminalOutcome: null,
      evidence: [],
    });
    writeOwnerOnlyJson(this.path(lease.id), lease);
    return lease;
  }

  activate(id: string, plan: WriteWorktreePlan) {
    const lease = this.require(id);
    if (lease.worktreePath !== plan.worktreePath || lease.branch !== plan.branch || lease.baseSha !== plan.baseSha) {
      throw new Error(`Worktree lease ${id} does not match the created checkout.`);
    }
    if (lease.state === "active") return lease;
    if (lease.state !== "preparing") throw new Error(`Worktree lease ${id} is ${lease.state} and cannot be activated.`);
    const next = WorktreeLeaseSchema.parse({ ...lease, state: "active", updatedAt: this.now() });
    writeOwnerOnlyJson(this.path(id), next);
    return next;
  }

  finish(id: string, input: { outcome: string; evidence?: string[] }) {
    const lease = this.require(id);
    if (lease.state !== "active" && lease.state !== "preparing") return lease;
    const present = existsSync(lease.worktreePath);
    const next = WorktreeLeaseSchema.parse({
      ...lease,
      state: present ? "preserved" : "released",
      updatedAt: this.now(),
      terminalOutcome: input.outcome,
      evidence: safeEvidence([
        ...(input.evidence ?? []),
        present ? "Terminal checkout still exists and was preserved for inspection." : "Terminal checkout was released.",
      ]),
    });
    writeOwnerOnlyJson(this.path(id), next);
    return next;
  }

  createHooks(jobId: string): WorktreeLeaseHooks {
    const ids = new Map<string, string>();
    return {
      tempBase: this.checkoutRoot,
      onPlanned: (plan, kind) => {
        const lease = this.acquire(jobId, plan, kind);
        ids.set(plan.worktreePath, lease.id);
      },
      onCreated: (plan) => {
        const id = ids.get(plan.worktreePath);
        if (!id) throw new Error(`No prepared durable worktree lease exists for ${plan.worktreePath}.`);
        this.activate(id, plan);
      },
      onTerminal: (plan, outcome, evidence) => {
        const id = ids.get(plan.worktreePath);
        if (!id) throw new Error(`No durable worktree lease exists for ${plan.worktreePath}.`);
        this.finish(id, { outcome, evidence });
      },
    };
  }

  list() {
    const glob = new Bun.Glob("*.json");
    const leases: WorktreeLease[] = [];
    for (const name of glob.scanSync({ cwd: this.manifestsRoot, onlyFiles: true })) {
      const lease = readOwnerOnlyJson(join(this.manifestsRoot, name), WorktreeLeaseSchema);
      if (lease) leases.push(lease);
    }
    return leases.sort((left, right) => left.createdAt - right.createdAt);
  }

  /**
   * Mark dead-owner leases as preserved crash evidence. Foreign or verified
   * live owners block takeover. This method never removes a checkout or branch.
   */
  reconcile() {
    const reconciled: WorktreeLease[] = [];
    for (const lease of this.list()) {
      if (lease.state !== "active" && lease.state !== "preparing") continue;
      if (lease.owner.host !== hostname()) {
        throw new Error(`Active worktree lease ${lease.id} belongs to unverifiable host ${lease.owner.host}; refusing daemon takeover.`);
      }
      if (processMatches(lease.owner.pid, lease.owner.processStart)) {
        if (lease.owner.nonce === this.owner.nonce) continue;
        throw new Error(`Active worktree lease ${lease.id} is owned by live process ${lease.owner.pid}; refusing daemon takeover.`);
      }
      const evidence = inspectLeaseEvidence(lease);
      const next = WorktreeLeaseSchema.parse({
        ...lease,
        state: "crashed",
        updatedAt: this.now(),
        terminalOutcome: "daemon_owner_crashed",
        evidence: safeEvidence([
          "Owning process is no longer live; checkout and branch preserved after daemon restart.",
          ...evidence,
        ]),
      });
      writeOwnerOnlyJson(this.path(lease.id), next);
      reconciled.push(next);
    }
    return reconciled;
  }

  private require(id: string) {
    const lease = readOwnerOnlyJson(this.path(z.string().uuid().parse(id)), WorktreeLeaseSchema);
    if (!lease) throw new Error(`Worktree lease not found: ${id}`);
    return lease;
  }

  private path(id: string) {
    return join(this.manifestsRoot, `${id}.json`);
  }
}

function processMatches(pid: number, start: string) {
  try { process.kill(pid, 0); } catch { return false; }
  return getProcessStartIdentity(pid) === start;
}

function inspectLeaseEvidence(lease: WorktreeLease) {
  if (!existsSync(lease.worktreePath)) {
    return [`checkout:missing`, `branch:${branchExists(lease) ? "present" : "missing"}`];
  }
  const status = runGitStrict(["status", "--porcelain=v1", "--untracked-files=all"], lease.worktreePath);
  const head = getHeadSha(lease.worktreePath);
  return [
    "checkout:present",
    `branch:${branchExists(lease) ? "present" : "missing"}`,
    `head:${head ?? "unknown"}`,
    status.ok ? `status:${status.stdout.trim() || "clean"}` : `status-error:${status.stderr}`,
  ];
}

function branchExists(lease: WorktreeLease) {
  return runGitStrict(["rev-parse", "--verify", "--quiet", `refs/heads/${lease.branch}`], lease.primaryRoot).ok;
}

function safeEvidence(values: string[]) {
  return values.slice(0, 32).map((value) => redactAndTruncate(value, 4_096).text);
}
