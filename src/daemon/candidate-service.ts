import type { WriteDiff } from "../runtime/worktree";
import { CandidateIntegrationService } from "../runtime/candidate-integration-service";
import { runReleaseGate, type GateCheck } from "../runtime/release-gate";
import type { ApprovalStore } from "../runtime/approval-store";
import type { AuthorityStore } from "../runtime/authority-store";
import type { FinalityStore } from "../runtime/finality-store";
import type { IntegrationJournal } from "../runtime/integration-journal";
import type { ProjectStatePaths } from "../runtime/project-state";
import type { WorktreeLeaseStore } from "../runtime/worktree-leases";
import type { JobStore } from "./job-store";

export function createCandidateIntegrationService(options: {
  paths: ProjectStatePaths;
  jobs: JobStore;
  finality: FinalityStore;
  approvals: ApprovalStore;
  authority: AuthorityStore;
  journal: IntegrationJournal;
  worktreeLeases: WorktreeLeaseStore;
  checks: GateCheck[];
}) {
  const { checks, ...dependencies } = options;
  return new CandidateIntegrationService({
    ...dependencies,
    evaluateIntegrationGates: async (context) => {
      const gate = await runReleaseGate({
        checks,
        cwd: context.cwd,
        primaryRoot: options.paths.canonicalProjectRoot,
        timeoutMs: 120_000,
        recordArtifact: false,
      });
      const review = reviewCandidateDiff(context.diff);
      return {
        policyPassed: true,
        testsPassed: gate.ok,
        reviewPassed: review.passed,
        votePassed: false,
        budgetPassed: true,
        reasons: [
          ...(gate.ok ? [] : ["Configured candidate checks failed."]),
          ...review.reasons,
        ],
        evidence: [
          ...gate.checks.map((check) => `${context.phase}:${check.name}:${check.ok ? "PASS" : "FAIL"}`),
          ...review.evidence,
        ],
      };
    },
  });
}

export function reviewCandidateDiff(diff: WriteDiff) {
  const reasons: string[] = [];
  if (diff.files.length === 0 || !diff.diff.trim()) reasons.push("Candidate review found no auditable diff.");
  if (Buffer.byteLength(diff.diff) > 8_000_000) reasons.push("Candidate diff exceeds the review limit.");
  for (const file of diff.files) {
    if (!file || file.startsWith("/") || file.split(/[\\/]/).includes("..") || file === ".git" || file.startsWith(".git/")) {
      reasons.push(`Candidate contains an invalid repository path: ${file || "<empty>"}.`);
    }
  }
  return {
    passed: reasons.length === 0,
    reasons,
    evidence: [`reviewed-files:${diff.files.length}`, `reviewed-bytes:${Buffer.byteLength(diff.diff)}`],
  };
}
