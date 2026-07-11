import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WorkflowSchema, type Workflow, type WorkflowStep } from "../contracts/durable";
import type { ProjectStatePaths } from "./project-state";
import { atomicWriteFile } from "./atomic-write";
import { ensureOwnerOnlyDirectory, ensureOwnerOnlyFile } from "./project-state";
import { safeJsonParse } from "./safe-json";

export type WorkflowStepInput = Pick<WorkflowStep, "id" | "kind" | "backend" | "prompt" | "mode" | "authMode" | "approvalPolicy" | "model" | "agent" | "timeoutMs" | "dependsOn" | "maxAttempts">;

/** One owner-only file per workflow keeps updates atomic and restart recovery bounded. */
export class WorkflowStore {
  readonly directory: string;

  constructor(private readonly paths: ProjectStatePaths, private readonly now: () => number = Date.now) {
    this.directory = ensureOwnerOnlyDirectory(paths.workflowsDir);
  }

  create(input: {
    id?: string;
    principal: string;
    sessionId: string | null;
    authMode: Workflow["authMode"];
    approvalPolicy: Workflow["approvalPolicy"];
    steps: WorkflowStepInput[];
    requirements: Workflow["requirements"];
  }) {
    const now = this.now();
    const workflow = WorkflowSchema.parse({
      id: input.id ?? `workflow_${randomUUID()}`,
      projectId: this.paths.projectId,
      principal: input.principal,
      sessionId: input.sessionId,
      authMode: input.authMode,
      approvalPolicy: input.approvalPolicy,
      state: "queued",
      steps: input.steps.map((step) => ({
        ...step,
        attempt: 0,
        state: "pending",
        jobIds: [],
        lastJobId: null,
        result: null,
        createdAt: now,
        updatedAt: now,
      })),
      requirements: input.requirements,
      finality: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    });
    if (existsSync(this.path(workflow.id))) throw new Error(`Workflow already exists: ${workflow.id}`);
    this.write(workflow);
    return workflow;
  }

  get(id: string) {
    const path = this.path(id);
    if (!existsSync(path)) return null;
    ensureOwnerOnlyFile(path);
    const workflow = WorkflowSchema.parse(safeJsonParse(readFileSync(path, "utf8")));
    if (workflow.projectId !== this.paths.projectId) throw new Error("Workflow project mismatch.");
    return workflow;
  }

  list() {
    return readdirSync(this.directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.get(name.slice(0, -5)))
      .filter((workflow): workflow is Workflow => workflow !== null)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  update(id: string, mutate: (workflow: Workflow) => Workflow) {
    const current = this.get(id);
    if (!current) throw new Error(`Unknown workflow: ${id}`);
    const next = WorkflowSchema.parse({ ...mutate(structuredClone(current)), updatedAt: this.now() });
    if (next.id !== current.id || next.projectId !== current.projectId || next.principal !== current.principal || next.createdAt !== current.createdAt) {
      throw new Error("Workflow identity fields are immutable.");
    }
    this.write(next);
    return next;
  }

  private write(workflow: Workflow) {
    const parsed = WorkflowSchema.parse(workflow);
    const path = this.path(parsed.id);
    atomicWriteFile(path, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
    ensureOwnerOnlyFile(path);
  }

  private path(id: string) {
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error("Invalid workflow id.");
    return join(this.directory, `${id}.json`);
  }
}
