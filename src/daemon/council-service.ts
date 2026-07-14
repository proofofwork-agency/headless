import { randomUUID } from "node:crypto";
import type { BackendDefinition } from "../backends/registry";
import type { FinalityDecision, Job } from "../contracts/durable";
import { CouncilRunParamsSchema } from "./protocol";
import { HeadlessError } from "../runtime/headless-error";
import { recordRuntimeDiagnostic } from "../runtime/diagnostics";
import { redactAndTruncate } from "../runtime/redaction";
import { safeJsonParse } from "../runtime/safe-json";
import {
  CouncilStore,
  CouncilVoteSchema,
  type CouncilRecord,
} from "../runtime/council-store";
import type {
  FinalityEvaluation,
} from "../runtime/finality-store";
import type { AuthorizationRequest, AuthorizationDecision } from "../runtime/authority-store";

export type CouncilSubmitOptions = {
  mergePolicy?: Job["mergePolicy"];
  maxAttempts: number;
  councilId: string;
  councilSlot: string;
};

export type CouncilJobStore = {
  get(id: string): Job | null;
  list(): Job[];
  request(id: string): { timeoutMs: number } | null;
};

export type CouncilServiceOptions = {
  projectId: string;
  councils: CouncilStore;
  jobs: CouncilJobStore;
  submit: (params: Record<string, unknown>, principal: string, options: CouncilSubmitOptions) => Job;
  wait: (jobId: string, timeoutMs: number) => Promise<Job>;
  authorize: (request: AuthorizationRequest) => Pick<AuthorizationDecision, "allowed" | "reason">;
  resolveBackend: (backend: string) => string;
  getBackend: (backend: string) => Pick<BackendDefinition, "capabilities"> | null;
  latestFinality: (jobId: string) => FinalityDecision | null;
  listFinality: () => FinalityDecision[];
  evaluateFinality: (input: FinalityEvaluation) => FinalityDecision;
  isStopping?: () => boolean;
  trackExecution?: (execution: Promise<void>) => void;
};

type CouncilJobField = "proposalJobs" | "executionJobs" | "reviewJobs" | "voteJobs";

type CouncilJobSpecification = {
  backend: string;
  params: Record<string, unknown>;
  options?: { mergePolicy?: Job["mergePolicy"] };
};

/**
 * Durable proposal -> execution -> review -> vote council orchestration.
 *
 * The daemon owns job admission and execution. This service owns only the
 * council state machine and binds every phase slot to a durable daemon job so
 * startup recovery can adopt work created immediately before a crash.
 */
export class CouncilService {
  private readonly active = new Map<string, Promise<CouncilRecord>>();

  constructor(private readonly options: CouncilServiceOptions) {}

  async run(params: Record<string, unknown>, principal: string) {
    const input = CouncilRunParamsSchema.parse(params);
    const agents = input.agents ?? ["opencode", "claude-code", "codex"];
    if (agents.length < 2) throw new HeadlessError("INVALID_REQUEST", "A council requires at least two participants.");
    if (input.containment === "unsafe") throw new HeadlessError("POLICY_DENIED", "Councils prohibit unsafe containment.");

    const participants = agents.map((agent) => this.options.resolveBackend(agent));
    if (new Set(participants).size !== participants.length) {
      throw new HeadlessError("INVALID_REQUEST", "Council participants must be distinct attributable adapters.");
    }
    for (const backend of participants) {
      const authorization = this.options.authorize({
        projectId: this.options.projectId,
        principal,
        operation: "council",
        backend,
        estimatedCostUsd: 0,
        merge: false,
      });
      if (!authorization.allowed) throw new HeadlessError("POLICY_DENIED", authorization.reason);
    }

    const record = this.options.councils.create(input.question, participants, principal, {
      mode: input.mode,
      timeoutMs: input.timeoutMs,
      authMode: input.authMode,
      approvalPolicy: input.approvalPolicy,
    });
    return this.launch(record.council.id);
  }

  launch(councilId: string) {
    const active = this.active.get(councilId);
    if (active) return active;
    if (this.options.isStopping?.()) return Promise.resolve(this.require(councilId));

    const execution = this.execute(councilId)
      .catch((error) => this.fail(councilId, error))
      .finally(() => this.active.delete(councilId));
    this.active.set(councilId, execution);
    this.options.trackExecution?.(execution.then(() => undefined));
    return execution;
  }

  recover() {
    return this.options.councils.list()
      .filter((record) => record.decision === null)
      .map((record) => this.launch(record.council.id));
  }

  async waitForIdle() {
    await Promise.all([...this.active.values()]);
  }

  require(councilId: string) {
    const record = this.options.councils.get(councilId);
    if (!record) throw new HeadlessError("INVALID_REQUEST", `Unknown council: ${councilId}`);
    return record;
  }

  private async execute(councilId: string) {
    let record = this.require(councilId);
    if (record.decision) return record;
    const { participants } = record.council;
    const { question, mode, timeoutMs } = record;
    const { authMode, approvalPolicy } = record.council;
    const proposals = await this.ensureJobs(councilId, "proposalJobs", participants.map((backend) => ({
      backend,
      params: {
        backend,
        prompt: `COUNCIL PROPOSAL PHASE\nQuestion: ${question}\nReturn a concrete proposal with risks, checks, and the next executable action. Do not echo the question.`,
        mode: "read-only",
        containment: "required",
        authMode,
        approvalPolicy,
        timeoutMs,
      },
    })));
    record = this.options.councils.update(councilId, "execution", { proposalJobs: proposals.map((job) => job.id) });

    const proposalContext = boundedJobContext(proposals);
    const executors = mode === "write"
      ? participants.filter((backend) => this.options.getBackend(backend)?.capabilities.write)
      : participants;
    if (executors.length === 0) {
      return this.options.councils.update(councilId, "decision", {
        decision: { approved: false, reason: "No authorized write-capable council participant is available." },
      });
    }
    const executions = await this.ensureJobs(councilId, "executionJobs", executors.map((backend) => ({
      backend,
      params: {
        backend,
        prompt: `COUNCIL EXECUTION PHASE\nQuestion: ${question}\nActual proposals:\n${proposalContext}\nExecute or validate the strongest proposal. Report concrete output and evidence.`,
        mode,
        containment: "required",
        authMode,
        approvalPolicy,
        timeoutMs,
      },
      options: { mergePolicy: mode === "write" ? "preserve" as const : "authorized" as const },
    })));
    record = this.options.councils.update(councilId, "review", {
      executionJobs: executions.map((job) => job.id),
      testJobs: mode === "write" ? executions.map((job) => job.id) : [],
    });

    const candidateContext = boundedJobContext(executions, true);
    const reviews = await this.ensureJobs(councilId, "reviewJobs", participants.map((backend) => ({
      backend,
      params: {
        backend,
        prompt: `COUNCIL REVIEW PHASE\nQuestion: ${question}\nReview these actual candidate results and diffs, not the original prompt:\n${candidateContext}\nIdentify specific correctness, containment, budget, and test failures.`,
        mode: "read-only",
        containment: "required",
        authMode,
        approvalPolicy,
        timeoutMs,
      },
    })));
    record = this.options.councils.update(councilId, "vote", { reviewJobs: reviews.map((job) => job.id) });

    const reviewContext = boundedJobContext(reviews);
    const voteJobs = await this.ensureJobs(councilId, "voteJobs", participants.map((backend, index) => ({
      backend,
      params: {
        backend,
        prompt: `COUNCIL VOTE PHASE\nQuestion: ${question}\nCandidate job IDs: ${executions.map((job) => job.id).join(", ")}\nEligible review job IDs (another participant only): ${reviews.filter((_, reviewIndex) => reviewIndex !== index).map((job) => job.id).join(", ")}\nActual reviews:\n${reviewContext}\nReturn only JSON: {"vote":"approve|reject","references":["review-job-id"],"rationale":"..."}. References must name an eligible review above and must not name your own review.`,
        mode: "read-only",
        containment: "required",
        authMode,
        approvalPolicy,
        timeoutMs,
      },
    })));
    let votes = record.votes;
    if (votes.length !== participants.length) {
      votes = [];
      voteJobs.forEach((job, index) => {
        const vote = parseCouncilVote(
          job,
          participants[index],
          reviews.filter((_, reviewIndex) => reviewIndex !== index).map((review) => review.id),
        );
        if (vote) votes.push(vote);
      });
      record = this.options.councils.update(councilId, "vote", { voteJobs: voteJobs.map((job) => job.id), votes });
    }

    const allJobs = [...proposals, ...executions, ...reviews, ...voteJobs];
    const proposalsPassed = proposals.every((job) => job.result?.status === "succeeded");
    const approvals = votes.filter((vote) => vote.vote === "approve").length;
    const candidatesPreserved = mode !== "write" || executions.every((job) => !!job.result?.commit?.candidate && !job.result.commit.merged);
    const finalityDecisions = this.options.listFinality();
    const testsPassed = mode !== "write" || executions.every((job) => finalityDecisions.some((decision) => (
      decision.jobId === job.id
      && decision.policyPassed
      && decision.testsPassed
      && decision.reviewPassed
      && decision.budgetPassed
    )));
    const executionPassed = mode === "write"
      ? candidatesPreserved && testsPassed
      : executions.every((job) => job.result?.status === "succeeded");
    const reviewPassed = reviews.every((job) => job.result?.status === "succeeded");
    const votePassed = executionPassed
      && reviewPassed
      && votes.length === participants.length
      && approvals > participants.length / 2;
    const policyPassed = proposalsPassed && allJobs.every((job) => {
      if (job.result?.error?.code !== "POLICY_DENIED") return true;
      return mode === "write"
        && executions.some((execution) => execution.id === job.id)
        && job.mergePolicy === "preserve"
        && !!job.result.commit?.candidate
        && !job.result.commit.merged;
    });
    const budgetPassed = allJobs.every((job) => job.result?.error?.code !== "BUDGET_EXCEEDED");
    const councilFinality = this.options.latestFinality(record.council.jobId) ?? this.options.evaluateFinality({
      projectId: this.options.projectId,
      jobId: record.council.jobId,
      decidedBy: record.council.principal,
      requirements: { policy: true, tests: mode === "write", review: true, vote: true, budget: true },
      gates: { policyPassed, testsPassed, reviewPassed, votePassed, budgetPassed },
    });
    return this.options.councils.update(councilId, "decision", {
      voteJobs: voteJobs.map((job) => job.id),
      votes,
      decision: {
        approved: councilFinality.allowed,
        reason: councilFinality.allowed
          ? `${approvals}/${participants.length} attributable votes approved the reviewed candidate${mode === "write" ? "; configured candidate tests passed and candidate commits remain preserved for an explicit coordinator integration choice" : ""}.`
          : `Council finality failed: ${councilFinality.reasons.join(" ")} (${approvals} approvals, ${votes.length}/${participants.length} valid votes).`,
      },
    });
  }

  private async ensureJobs(
    councilId: string,
    field: CouncilJobField,
    specifications: CouncilJobSpecification[],
  ) {
    let record = this.require(councilId);
    if (record[field].length > specifications.length) {
      throw new HeadlessError("INTERNAL_ERROR", `Council ${field} contains too many durable jobs.`);
    }
    for (let index = record[field].length; index < specifications.length; index += 1) {
      const specification = specifications[index];
      const slot = `${field}:${index}`;
      const reconciled = this.options.jobs.list().find((job) => job.councilId === councilId && job.councilSlot === slot);
      const job = reconciled ?? this.options.submit(specification.params, record.council.principal, {
        ...specification.options,
        maxAttempts: 2,
        councilId,
        councilSlot: slot,
      });
      record = this.options.councils.appendJob(councilId, field, job.id);
    }
    const jobs = record[field].map((jobId, index) => {
      const job = this.options.jobs.get(jobId);
      const slot = `${field}:${index}`;
      if (
        !job
        || job.projectId !== this.options.projectId
        || job.principal !== record.council.principal
        || job.backend !== specifications[index]?.backend
        || (job.councilId !== null && (job.councilId !== councilId || job.councilSlot !== slot))
      ) {
        throw new HeadlessError("INTERNAL_ERROR", `Council ${field} has an invalid durable job binding.`);
      }
      return job;
    });
    return Promise.all(jobs.map((job) => {
      if (job.result) return job;
      const timeoutMs = this.options.jobs.request(job.id)?.timeoutMs ?? record.timeoutMs;
      return this.options.wait(job.id, timeoutMs + 10_000);
    }));
  }

  private fail(councilId: string, error: unknown) {
    const record = this.options.councils.get(councilId);
    if (!record) {
      if (error instanceof Error) throw error;
      throw new HeadlessError("INTERNAL_ERROR", "Council execution failed before durable state was available.");
    }
    if (record.decision) return record;
    const reason = redactAndTruncate(messageOf(error), 16_000).text;
    return this.options.councils.update(councilId, "decision", {
      decision: { approved: false, reason: `Council execution failed: ${reason}` },
    });
  }
}

function boundedJobContext(jobs: Job[], includeDiff = false) {
  const context = jobs.map((job) => ({
    jobId: job.id,
    backend: job.backend,
    status: job.state,
    output: job.result?.output.slice(0, 50_000) ?? "",
    diff: includeDiff ? job.result?.diff?.patch.slice(0, 100_000) ?? null : undefined,
    error: job.result?.error ?? null,
  }));
  return redactAndTruncate(JSON.stringify(context), 500_000).text;
}

function parseCouncilVote(job: Job, agent: string, allowedReferences: string[]) {
  if (!job.result || job.result.status !== "succeeded") return null;
  const match = job.result.output.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const value = safeJsonParse<Record<string, unknown>>(match[0]);
    const references = Array.isArray(value.references)
      ? value.references.filter((entry): entry is string => typeof entry === "string")
      : [];
    if (references.length === 0 || references.some((reference) => !allowedReferences.includes(reference))) return null;
    return CouncilVoteSchema.parse({
      id: randomUUID(),
      agent,
      vote: value.vote,
      references,
      rationale: value.rationale,
      jobId: job.id,
    });
  } catch (error) {
    recordRuntimeDiagnostic("state", "council-vote-parse", error, "warning");
    return null;
  }
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
