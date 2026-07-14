import type { Job, Workflow } from "../contracts/durable";
import { redactAndTruncate } from "../runtime/redaction";

export function isTerminalWorkflow(workflow: Workflow) {
  return workflow.state === "succeeded" || workflow.state === "failed" || workflow.state === "blocked" || workflow.state === "cancelled";
}

export function requireWorkflowStep(workflow: Workflow, stepId: string) {
  const step = workflow.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new Error(`Unknown workflow step ${stepId} in ${workflow.id}.`);
  return step;
}

export function updateWorkflowStep(workflow: Workflow, stepId: string, patch: Partial<Workflow["steps"][number]>): Workflow {
  return {
    ...workflow,
    steps: workflow.steps.map((step) => step.id === stepId ? { ...step, ...patch, id: step.id, createdAt: step.createdAt } : step),
  };
}

export function workflowStepState(job: Job): Workflow["steps"][number]["state"] {
  if (!job.result) return job.state === "queued" ? "queued" : "running";
  if (job.result.status === "succeeded") return "succeeded";
  if (job.result.status === "blocked") return "blocked";
  if (job.result.status === "cancelled") return "cancelled";
  return "failed";
}

export function workflowStepPrompt(workflow: Workflow, step: Workflow["steps"][number]) {
  const dependencies = step.dependsOn.map((dependencyId) => {
    const dependency = requireWorkflowStep(workflow, dependencyId);
    return {
      stepId: dependency.id,
      kind: dependency.kind,
      jobId: dependency.lastJobId,
      backend: dependency.backend,
      status: dependency.state,
      output: dependency.result?.output.slice(0, 80_000) ?? "",
      diff: dependency.result?.diff?.patch.slice(0, 120_000) ?? null,
      error: dependency.result?.error ?? null,
    };
  });
  if (dependencies.length === 0) return step.prompt;
  return redactAndTruncate(
    `${step.prompt}\n\nWORKFLOW DEPENDENCY OUTPUTS (actual durable results; do not replace them with the original workflow prompt):\n${JSON.stringify(dependencies)}`,
    480_000,
  ).text;
}

export function validWorkflowVotes(workflow: Workflow) {
  const votes = workflow.steps.filter((step) => step.kind === "vote");
  if (votes.length === 0) return false;
  return votes.every((vote) => {
    if (vote.state !== "succeeded" || !vote.result?.output) return false;
    const referencedReviews = vote.dependsOn
      .map((id) => workflow.steps.find((step) => step.id === id))
      .filter((step) => step?.kind === "review" && step.lastJobId && step.backend !== vote.backend);
    return referencedReviews.length > 0 && referencedReviews.some((review) => vote.result!.output.includes(review!.lastJobId!));
  });
}
