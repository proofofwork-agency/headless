import type { AuthenticatedCredential } from "../runtime/credential-store";
import type { AuthorizationRequest, AuthorizationDecision } from "../runtime/authority-store";
import type { FinalityEvaluation } from "../runtime/finality-store";
import type { ProjectStatePaths } from "../runtime/project-state";
import { HeadlessError } from "../runtime/headless-error";
import { redactAndTruncate } from "../runtime/redaction";
import { WorkflowStore } from "../runtime/workflow-store";
import { RunRequestSchema, type SerializedRunRequest } from "../contracts/run";
import type { FinalityDecision, Job, Workflow } from "../contracts/durable";
import { getAdapter, resolveAdapterId } from "../backends/registry";
import { assertPrincipalOwns } from "./auth";
import { WorkflowRunParamsSchema } from "./protocol";
import {
  isTerminalWorkflow,
  requireWorkflowStep,
  updateWorkflowStep,
  validWorkflowVotes,
  workflowStepPrompt,
  workflowStepState,
} from "./workflow-logic";

export type WorkflowSubmitOptions = {
  mergePolicy: Job["mergePolicy"];
  workflowId: string;
  retryNumber: number;
};

export type WorkflowResourceEstimate = {
  cost: { amountUsd: number | null };
};

export type WorkflowServiceOptions = {
  paths: ProjectStatePaths;
  projectRoot: string;
  isStopping: () => boolean;
  assertSessionOwnership: (sessionId: string, credential: AuthenticatedCredential) => void;
  estimate: (request: SerializedRunRequest) => WorkflowResourceEstimate;
  authorize: (request: AuthorizationRequest) => AuthorizationDecision;
  submit: (params: Record<string, unknown>, principal: string, options: WorkflowSubmitOptions) => Job;
  getJob: (jobId: string) => Job | null;
  getJobRequest: (jobId: string) => SerializedRunRequest | null;
  waitJob: (jobId: string, timeoutMs: number) => Promise<Job>;
  cancelJob: (jobId: string) => void;
  evaluateFinality: (evaluation: FinalityEvaluation) => FinalityDecision;
  trackExecution?: (execution: Promise<void>) => void;
  diagnostic?: (message: string, error: unknown) => void;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

/** Durable workflow admission, DAG execution, recovery, cancellation, and finality. */
export class WorkflowService {
  readonly store: WorkflowStore;
  private readonly activeWorkflowIds = new Set<string>();
  private readonly activeExecutions = new Set<Promise<void>>();
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: WorkflowServiceOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? Bun.sleep;
    this.store = new WorkflowStore(options.paths, this.now);
  }

  create(params: Record<string, unknown>, credential: AuthenticatedCredential) {
    if (this.options.isStopping()) {
      throw new HeadlessError("DAEMON_UNAVAILABLE", "Daemon is shutting down and cannot accept workflows.");
    }
    const parsed = WorkflowRunParamsSchema.parse(params);
    if (parsed.sessionId) this.options.assertSessionOwnership(parsed.sessionId, credential);
    const steps = parsed.steps.map((step) => {
      const backend = resolveAdapterId(step.backend);
      const adapter = getAdapter(backend);
      if (!adapter) throw new HeadlessError("INVALID_REQUEST", `Unknown workflow backend: ${step.backend}`);
      if (step.mode === "write" && !adapter.capabilities.write) {
        throw new HeadlessError("BACKEND_UNSUPPORTED", `Workflow backend ${backend} does not support write mode.`);
      }
      const authMode = step.authMode ?? parsed.authMode;
      const approvalPolicy = step.approvalPolicy ?? parsed.approvalPolicy;
      const request = RunRequestSchema.parse({
        backend,
        prompt: step.prompt,
        projectRoot: this.options.projectRoot,
        mode: step.mode,
        authMode,
        approvalPolicy,
        model: step.model ?? undefined,
        agent: step.agent ?? undefined,
        timeoutMs: step.timeoutMs,
        sessionId: parsed.sessionId ?? undefined,
        containment: "required",
      });
      const authorization = this.options.authorize({
        projectId: this.options.paths.projectId,
        principal: credential.principal,
        operation: "workflow",
        backend,
        estimatedCostUsd: this.options.estimate(request).cost.amountUsd,
        merge: false,
      });
      if (!authorization.allowed) throw new HeadlessError("POLICY_DENIED", authorization.reason);
      return { ...step, backend, authMode, approvalPolicy };
    });
    const workflow = this.store.create({
      id: parsed.id,
      principal: credential.principal,
      sessionId: parsed.sessionId,
      authMode: parsed.authMode,
      approvalPolicy: parsed.approvalPolicy,
      steps,
      requirements: parsed.requirements,
    });
    this.launch(workflow.id);
    return workflow;
  }

  recover() {
    let recovered = 0;
    for (const workflow of this.store.list()) {
      if (isTerminalWorkflow(workflow)) continue;
      if (this.launch(workflow.id)) recovered += 1;
    }
    return recovered;
  }

  launch(workflowId: string) {
    if (this.activeWorkflowIds.has(workflowId) || this.options.isStopping()) return null;
    this.activeWorkflowIds.add(workflowId);
    const execution = this.execute(workflowId)
      .then(() => undefined, (error) => { this.fail(workflowId, error); })
      .finally(() => {
        this.activeWorkflowIds.delete(workflowId);
        this.activeExecutions.delete(execution);
      });
    this.activeExecutions.add(execution);
    this.options.trackExecution?.(execution);
    void execution.catch((error) => this.diagnostic(`Unable to persist terminal workflow state for ${workflowId}.`, error));
    return execution;
  }

  get(id: string) {
    return this.store.get(id);
  }

  list() {
    return this.store.list();
  }

  require(id: string) {
    const workflow = this.store.get(id);
    if (!workflow) throw new HeadlessError("INVALID_REQUEST", `Unknown workflow: ${id}`);
    return workflow;
  }

  requireFor(id: string, credential: AuthenticatedCredential) {
    const workflow = this.require(id);
    assertPrincipalOwns(credential, workflow.principal, "Workflow");
    return workflow;
  }

  cancel(id: string) {
    const workflow = this.require(id);
    if (isTerminalWorkflow(workflow)) return workflow;
    const cancelling = this.store.update(id, (current) => ({ ...current, state: "cancelling" }));
    for (const step of cancelling.steps) {
      if (!step.lastJobId) continue;
      const job = this.options.getJob(step.lastJobId);
      if (job && !job.result) this.options.cancelJob(job.id);
    }
    this.launch(id);
    return cancelling;
  }

  async wait(id: string, timeoutMs: number) {
    const deadline = this.now() + timeoutMs;
    for (;;) {
      const workflow = this.require(id);
      if (isTerminalWorkflow(workflow)) return workflow;
      if (this.now() >= deadline) throw new HeadlessError("TIMED_OUT", "Timed out waiting for the workflow.");
      await this.sleep(Math.min(25, Math.max(1, deadline - this.now())));
    }
  }

  async waitForIdle() {
    await Promise.allSettled([...this.activeExecutions]);
  }

  private async execute(workflowId: string) {
    let workflow = this.require(workflowId);
    if (isTerminalWorkflow(workflow)) return workflow;
    if (workflow.state === "queued") {
      workflow = this.store.update(workflowId, (current) => ({ ...current, state: "running" }));
    }

    while (!this.options.isStopping()) {
      workflow = this.require(workflowId);
      if (isTerminalWorkflow(workflow)) return workflow;
      if (workflow.state === "cancelling") return this.finishCancellation(workflow);

      const actions: Array<Promise<void>> = [];
      let stateChanged = false;
      for (const step of workflow.steps) {
        if ((step.state === "queued" || step.state === "running") && step.lastJobId) {
          actions.push(this.resumeStep(workflowId, step.id, step.lastJobId));
          continue;
        }
        if (step.state !== "pending") continue;
        const dependencies = step.dependsOn.map((id) => workflow.steps.find((candidate) => candidate.id === id)!);
        if (dependencies.some((dependency) => ["failed", "blocked", "cancelled"].includes(dependency.state))) {
          this.store.update(workflowId, (current) => updateWorkflowStep(current, step.id, {
            state: "blocked",
            updatedAt: this.now(),
          }));
          stateChanged = true;
          continue;
        }
        if (dependencies.every((dependency) => dependency.state === "succeeded")) {
          actions.push(this.runStep(workflowId, step.id));
        }
      }

      if (actions.length > 0) {
        await Promise.all(actions);
        continue;
      }
      if (stateChanged) continue;

      workflow = this.require(workflowId);
      if (workflow.steps.some((step) => step.state === "pending" || step.state === "queued" || step.state === "running")) {
        throw new Error("Workflow has no runnable step; dependency state is inconsistent.");
      }
      return this.finalize(workflow);
    }
    return this.require(workflowId);
  }

  private async runStep(workflowId: string, stepId: string) {
    let workflow = this.require(workflowId);
    const step = requireWorkflowStep(workflow, stepId);
    if (step.state !== "pending") return;
    const prompt = workflowStepPrompt(workflow, step);
    workflow = this.store.update(workflowId, (current) => updateWorkflowStep(current, stepId, {
      state: "queued",
      attempt: step.attempt + 1,
      updatedAt: this.now(),
    }));
    const queued = requireWorkflowStep(workflow, stepId);
    const job = this.options.submit({
      backend: queued.backend,
      prompt,
      mode: queued.mode,
      model: queued.model ?? undefined,
      agent: queued.agent ?? undefined,
      timeoutMs: queued.timeoutMs,
      sessionId: workflow.sessionId ?? undefined,
      containment: "required",
      authMode: queued.authMode,
      approvalPolicy: queued.approvalPolicy,
    }, workflow.principal, {
      mergePolicy: queued.mode === "write" ? "preserve" : "authorized",
      workflowId,
      retryNumber: Math.max(0, queued.attempt - 1),
    });
    this.store.update(workflowId, (current) => updateWorkflowStep(current, stepId, {
      state: job.result ? workflowStepState(job) : "running",
      jobIds: [...requireWorkflowStep(current, stepId).jobIds, job.id],
      lastJobId: job.id,
      result: job.result,
      updatedAt: this.now(),
    }));
    if (job.result) return this.afterStep(workflowId, stepId, job);
    await this.resumeStep(workflowId, stepId, job.id);
  }

  private async resumeStep(workflowId: string, stepId: string, jobId: string) {
    const existing = this.requireJob(jobId);
    const requestTimeout = this.options.getJobRequest(jobId)?.timeoutMs ?? 180_000;
    const job = existing.result ? existing : await this.options.waitJob(jobId, Math.max(1, requestTimeout + 10_000));
    this.afterStep(workflowId, stepId, job);
  }

  private afterStep(workflowId: string, stepId: string, job: Job) {
    const workflow = this.require(workflowId);
    const step = requireWorkflowStep(workflow, stepId);
    if (job.workflowId !== workflowId || step.lastJobId !== job.id) {
      throw new Error(`Workflow job ${job.id} is not bound to step ${stepId}.`);
    }
    if (!job.result) throw new Error(`Workflow job ${job.id} became terminal without a result.`);
    const canRetry = (job.result.error?.retryable === true || job.result.status === "failed" || job.result.status === "timed_out")
      && step.attempt < step.maxAttempts
      && workflow.state !== "cancelling";
    this.store.update(workflowId, (current) => updateWorkflowStep(current, stepId, {
      state: canRetry ? "pending" : workflowStepState(job),
      result: job.result,
      updatedAt: this.now(),
    }));
  }

  private finalize(workflow: Workflow) {
    const failed = workflow.steps.filter((step) => step.state !== "succeeded");
    if (failed.length > 0) {
      const blocked = failed.some((step) => step.state === "blocked");
      return this.store.update(workflow.id, (current) => ({
        ...current,
        state: blocked ? "blocked" : "failed",
        error: {
          code: blocked ? "GATE_FAILED" : "PROCESS_ERROR",
          message: `Workflow failed in step(s): ${failed.map((step) => step.id).join(", ")}.`,
          retryable: false,
        },
      }));
    }
    const hasSucceeded = (kind: Workflow["steps"][number]["kind"]) => workflow.steps.some((step) => step.kind === kind && step.state === "succeeded");
    const finality = this.options.evaluateFinality({
      projectId: this.options.paths.projectId,
      jobId: workflow.id,
      decidedBy: workflow.principal,
      requirements: workflow.requirements,
      gates: {
        policyPassed: workflow.steps.every((step) => step.result?.error?.code !== "POLICY_DENIED"),
        budgetPassed: workflow.steps.every((step) => step.result?.error?.code !== "BUDGET_EXCEEDED"),
        testsPassed: hasSucceeded("test"),
        reviewPassed: hasSucceeded("review"),
        votePassed: validWorkflowVotes(workflow),
      },
    });
    return this.store.update(workflow.id, (current) => ({
      ...current,
      state: finality.allowed ? "succeeded" : "blocked",
      finality,
      error: finality.allowed ? null : { code: "GATE_FAILED", message: finality.reasons.join(" "), retryable: false },
    }));
  }

  private finishCancellation(workflow: Workflow) {
    return this.store.update(workflow.id, (current) => ({
      ...current,
      state: "cancelled",
      steps: current.steps.map((step) => ["pending", "queued", "running"].includes(step.state)
        ? { ...step, state: "cancelled" as const, updatedAt: this.now() }
        : step),
      error: { code: "CANCELLED", message: "Workflow was cancelled.", retryable: false },
    }));
  }

  private fail(id: string, error: unknown) {
    const workflow = this.store.get(id);
    if (!workflow || isTerminalWorkflow(workflow)) return workflow;
    return this.store.update(id, (current) => ({
      ...current,
      state: "failed",
      error: { code: "INTERNAL_ERROR", message: redactAndTruncate(messageOf(error), 16_384).text, retryable: true },
    }));
  }

  private requireJob(id: string) {
    const job = this.options.getJob(id);
    if (!job) throw new HeadlessError("INVALID_REQUEST", `Unknown job: ${id}`);
    return job;
  }

  private diagnostic(message: string, error: unknown) {
    if (this.options.diagnostic) return this.options.diagnostic(message, error);
    console.error(redactAndTruncate(`${message} ${messageOf(error)}`, 2_048).text);
  }
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
