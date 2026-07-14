import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getHeadSha, runGitStrict } from "./git";
import { redactAndTruncate } from "./redaction";
import {
  createWriteWorktree,
  captureWorktreeDiff,
  planWriteWorktree,
  removeWriteWorktree,
  type WriteDiff,
  type WriteWorktreePlan,
  type WorktreeLeaseHooks,
} from "./worktree";

const EVIDENCE_LIMIT = 64_000;
const RAW_DIFF_LIMIT_BYTES = 8_000_000;
const RAW_STATUS_LIMIT_BYTES = 1_000_000;
const RAW_FILE_COUNT_LIMIT = 50_000;
const RAW_FILE_PATH_LIMIT_BYTES = 4_096;
const RAW_FILE_LIST_LIMIT_BYTES = 8_000_000;
const DAEMON_GIT_NAME = "Headless Daemon";
const DAEMON_GIT_EMAIL = "headless@localhost";

export type WriteGatePhase = "candidate" | "integration";

export type WriteGateDecision = {
  policyPassed: boolean;
  testsPassed: boolean;
  reviewPassed: boolean;
  votePassed: boolean;
  budgetPassed: boolean;
  reasons?: string[];
  evidence?: string[];
};

export type WriteGateContext = {
  phase: WriteGatePhase;
  cwd: string;
  baseCommit: string;
  candidateCommit: string | null;
  diff: WriteDiff;
  signal?: AbortSignal;
  execution: WriteExecutionSummary;
};

export type WriteExecutionSummary = {
  succeeded: boolean;
  status: "succeeded" | "failed" | "timed_out" | "cancelled" | "blocked";
  /** Only OUTPUT_OVERFLOW may be recovered through candidate gates. */
  failureCode?: string | null;
  usage: {
    input: number | null;
    output: number | null;
    reasoning: number | null;
    cached: number | null;
    providerTotal: number | null;
  };
  costUsd: number | null;
};

export type WriteAuthorizationCheckpoint = "candidate-gates" | "integration-gates" | "primary-mutation";

export type WriteAuthorizationDecision = {
  allowed: boolean;
  reason: string;
};

export type WritePrimaryUpdate = {
  phase: WriteGatePhase;
  outcome: "merged_fast_forward" | "merged_advanced";
  baseCommit: string;
  candidateCommit: string;
  expectedPrimaryHead: string;
  targetCommit: string;
};

export type WriteIntegrationPolicy = {
  actor: string;
  grantId: string | null;
  autoMerge: boolean;
  commitMessage?: string;
  signal?: AbortSignal;
  /** Re-check durable authority at every write/merge time-of-use boundary. */
  reauthorize: (checkpoint: WriteAuthorizationCheckpoint) => Promise<WriteAuthorizationDecision> | WriteAuthorizationDecision;
  /** Durable write-ahead record created before the irreversible primary update. */
  preparePrimaryUpdate?: (update: WritePrimaryUpdate) => Promise<void> | void;
  /** Best-effort applied marker; the prepared record remains recoverable if this fails. */
  recordPrimaryUpdate?: (update: WritePrimaryUpdate & { resultingCommit: string }) => Promise<void> | void;
  /** Durable checkout manifests for advanced-head integration worktrees. */
  worktreeLease?: WorktreeLeaseHooks;
  evaluateGates: (context: WriteGateContext) => Promise<WriteGateDecision>;
};

export type WriteMergeOutcome =
  | "no_changes"
  | "merged_fast_forward"
  | "merged_advanced"
  | "preserved_execution_failure"
  | "preserved_no_merge_authority"
  | "blocked_candidate_gates"
  | "blocked_integration_gates"
  | "blocked_dirty_primary"
  | "blocked_conflict"
  | "blocked_primary_advanced"
  | "commit_failed";

export type WriteIntegrationResult = {
  outcome: WriteMergeOutcome;
  merged: boolean;
  baseCommit: string;
  candidateCommit: string | null;
  resultingCommit: string | null;
  branch: string;
  grantId: string | null;
  actor: string;
  gates: Array<{ phase: WriteGatePhase; decision: WriteGateDecision }>;
  reason: string;
  evidence: string[];
};

/**
 * Turn the already-contained worker worktree into an auditable candidate and,
 * only after all supplied gates pass, integrate it into the primary checkout.
 *
 * The candidate branch is deliberately retained for every blocked outcome.
 * Worktree directories are always released after the terminal decision.
 */
export async function integrateWriteCandidate(input: {
  plan: WriteWorktreePlan;
  diff: WriteDiff;
  execution: WriteExecutionSummary;
  policy: WriteIntegrationPolicy;
}): Promise<WriteIntegrationResult> {
  const { plan, diff, execution, policy } = input;
  const recoverableOutputOverflow = !execution.succeeded && execution.failureCode === "OUTPUT_OVERFLOW";
  const gates: WriteIntegrationResult["gates"] = [];
  let preserveCandidate = true;
  let candidateCommit: string | null = null;
  let terminalResult: WriteIntegrationResult | null = null;

  const finish = (
    outcome: WriteMergeOutcome,
    reason: string,
    resultingCommit: string | null = getHeadSha(plan.primaryRoot),
    evidence: string[] = [],
  ): WriteIntegrationResult => {
    terminalResult = {
      outcome,
      merged: outcome === "merged_fast_forward" || outcome === "merged_advanced",
      baseCommit: plan.baseSha,
      candidateCommit,
      resultingCommit,
      branch: plan.branch,
      grantId: policy.grantId,
      actor: policy.actor,
      gates,
      reason: safeEvidence(reason),
      evidence: evidence.map(safeEvidence).slice(0, 64),
    };
    return terminalResult;
  };

  try {
    if (diff.files.length === 0 && !diff.status.trim() && !diff.diff.trim()) {
      preserveCandidate = false;
      candidateCommit = plan.baseSha;
      return finish("no_changes", "The worker produced no repository changes.");
    }

    const safety = inspectCandidateSafety(diff);
    if (!safety.passed) {
      preserveCandidate = false;
      const decision = failedGate(safety.reason);
      gates.push({ phase: "candidate", decision });
      return finish("blocked_candidate_gates", safety.reason, getHeadSha(plan.primaryRoot), safety.evidence);
    }
    const attributes = inspectCandidateAttributes(plan.worktreePath, diff.files);
    if (!attributes.passed) {
      preserveCandidate = false;
      const decision = failedGate(attributes.reason);
      gates.push({ phase: "candidate", decision });
      return finish("blocked_candidate_gates", attributes.reason, getHeadSha(plan.primaryRoot), attributes.evidence);
    }

    const beforeCandidateGate = snapshotWorktree(plan.worktreePath, plan.baseSha);
    if (!beforeCandidateGate.ok) {
      preserveCandidate = false;
      const decision = failedGate("Candidate state could not be fingerprinted before gates.");
      gates.push({ phase: "candidate", decision });
      return finish("blocked_candidate_gates", "Candidate state could not be verified before gates; no candidate object was created.", getHeadSha(plan.primaryRoot), [beforeCandidateGate.evidence]);
    }

    const candidateAuthorization = await authorizeSafely(policy, "candidate-gates");
    let candidateGate: WriteGateDecision;
    if (!candidateAuthorization.allowed) {
      candidateGate = failedGate(candidateAuthorization.reason);
    } else if (!execution.succeeded && !recoverableOutputOverflow) {
      candidateGate = failedGate(`Worker execution ended as ${execution.status}; integration gates were not eligible to pass.`);
    } else if (policy.signal?.aborted) {
      candidateGate = failedGate("Write integration was cancelled before candidate gates ran.");
    } else {
      candidateGate = await evaluateSafely(policy, {
        phase: "candidate",
        cwd: plan.worktreePath,
        baseCommit: plan.baseSha,
        candidateCommit: null,
        diff,
        signal: policy.signal,
        execution,
      });
    }
    const afterCandidateGate = snapshotWorktree(plan.worktreePath, plan.baseSha);
    if (!afterCandidateGate.ok || afterCandidateGate.fingerprint !== beforeCandidateGate.fingerprint) {
      preserveCandidate = false;
      candidateGate = failedGate("Candidate gate commands changed the leased worktree or index; their side effects were rejected.");
    }
    gates.push({ phase: "candidate", decision: candidateGate });

    if (!afterCandidateGate.ok || afterCandidateGate.fingerprint !== beforeCandidateGate.fingerprint) {
      return finish("blocked_candidate_gates", gateReason("Candidate state changed during gate execution; no candidate object was created.", candidateGate), getHeadSha(plan.primaryRoot), [afterCandidateGate.evidence]);
    }

    const committed = commitCandidate(plan, policy.commitMessage);
    if (!committed.ok) {
      return finish("commit_failed", "The candidate could not be committed; primary was not modified.", getHeadSha(plan.primaryRoot), [committed.stderr]);
    }
    candidateCommit = committed.sha;

    if (!execution.succeeded && !recoverableOutputOverflow) {
      return finish("preserved_execution_failure", `Candidate commit preserved because worker execution ended as ${execution.status}.`);
    }
    if (!gatePassed(candidateGate)) {
      return finish("blocked_candidate_gates", gateReason("Candidate gates failed.", candidateGate));
    }
    if (!policy.autoMerge || recoverableOutputOverflow) {
      return finish(
        "preserved_no_merge_authority",
        recoverableOutputOverflow
          ? "Output-overflow candidate passed gates and was preserved for explicit review; it was not auto-integrated."
          : "Candidate commit preserved because this principal has no merge authority.",
      );
    }
    if (policy.signal?.aborted) {
      return finish("preserved_execution_failure", "Candidate commit preserved because integration was cancelled.");
    }

    const primaryState = readPrimaryState(plan.primaryRoot);
    if (!primaryState.ok || primaryState.dirty) {
      return finish("blocked_dirty_primary", "Primary checkout changed or became dirty while the worker ran; primary was not modified.", primaryState.head, [primaryState.evidence]);
    }

    if (primaryState.head === plan.baseSha) {
      const mergeAuthorization = await authorizeSafely(policy, "primary-mutation");
      if (!mergeAuthorization.allowed) {
        return finish("preserved_no_merge_authority", mergeAuthorization.reason, primaryState.head);
      }
      const update: WritePrimaryUpdate = {
        phase: "candidate",
        outcome: "merged_fast_forward",
        baseCommit: plan.baseSha,
        candidateCommit,
        expectedPrimaryHead: plan.baseSha,
        targetCommit: candidateCommit,
      };
      const prepared = await preparePrimaryUpdateSafely(policy, update);
      if (!prepared.ok) {
        return finish("blocked_primary_advanced", prepared.reason, primaryState.head);
      }
      const finalAuthorization = await authorizeSafely(policy, "primary-mutation");
      if (!finalAuthorization.allowed) {
        return finish("preserved_no_merge_authority", finalAuthorization.reason, primaryState.head);
      }
      const merged = fastForwardPrimary(plan.primaryRoot, candidateCommit, plan.baseSha);
      if (!merged.ok) {
        return finish("blocked_primary_advanced", "Primary moved before the fast-forward could be completed; candidate commit was preserved.", getHeadSha(plan.primaryRoot), [merged.stderr]);
      }
      preserveCandidate = false;
      const journalEvidence = await recordPrimaryUpdateSafely(policy, update, merged.sha);
      return finish("merged_fast_forward", "Candidate was fast-forwarded into the unchanged primary checkout.", merged.sha, journalEvidence ? [journalEvidence] : []);
    }

    return await integrateAdvancedPrimary({ plan, diff, execution, policy, gates, candidateCommit, finish, releaseCandidate: () => { preserveCandidate = false; } });
  } finally {
    // A commit makes forced cleanup safe. Blocked candidates keep their branch;
    // successful/no-op candidates are pruned after their terminal decision.
    if (preserveCandidate && candidateCommit) {
      const retained = retainCandidateBranch(plan);
      const completed = terminalResult as WriteIntegrationResult | null;
      if (retained) {
        if (completed) completed.branch = retained;
      } else if (completed) {
        completed.evidence.push("Candidate branch could not be moved to the retained namespace; its commit hash remains in the result.");
      }
    }
    removeWriteWorktree(plan, { force: true, pruneBranch: !preserveCandidate });
  }
}

async function integrateAdvancedPrimary(input: {
  plan: WriteWorktreePlan;
  diff: WriteDiff;
  execution: WriteExecutionSummary;
  policy: WriteIntegrationPolicy;
  gates: WriteIntegrationResult["gates"];
  candidateCommit: string;
  finish: (outcome: WriteMergeOutcome, reason: string, resultingCommit?: string | null, evidence?: string[]) => WriteIntegrationResult;
  releaseCandidate: () => void;
}) {
  const { plan, diff, execution, policy, gates, candidateCommit, finish, releaseCandidate } = input;
  let integrationPlan: WriteWorktreePlan | null = null;
  let integrationLeasePrepared = false;
  try {
    const state = readPrimaryState(plan.primaryRoot);
    if (!state.ok || state.dirty || !state.head) {
      return finish("blocked_dirty_primary", "Primary checkout could not be safely prepared for advanced-head integration.", state.head, [state.evidence]);
    }

    integrationPlan = planWriteWorktree({
      primaryRoot: plan.primaryRoot,
      label: `integration-${randomUUID().slice(0, 8)}`,
      tempBase: policy.worktreeLease?.tempBase,
    });
    policy.worktreeLease?.onPlanned(integrationPlan, "integration");
    integrationLeasePrepared = !!policy.worktreeLease;
    createWriteWorktree(integrationPlan);
    policy.worktreeLease?.onCreated(integrationPlan, "integration");
    if (integrationPlan.baseSha !== state.head) {
      return finish("blocked_primary_advanced", "Primary advanced while the integration worktree was being leased.", getHeadSha(plan.primaryRoot));
    }

    const mergedTree = gitWithIdentity(
      ["merge", "--no-ff", "--no-commit", candidateCommit],
      integrationPlan.worktreePath,
    );
    if (!mergedTree.ok) {
      const status = runGitStrict(["status", "--porcelain=v1"], integrationPlan.worktreePath);
      runGitStrict(["merge", "--abort"], integrationPlan.worktreePath);
      return finish("blocked_conflict", "Candidate conflicts with the advanced primary; primary was not modified.", state.head, [mergedTree.stderr, status.stdout]);
    }

    const beforeIntegrationGate = snapshotWorktree(integrationPlan.worktreePath, state.head);
    if (!beforeIntegrationGate.ok) {
      runGitStrict(["merge", "--abort"], integrationPlan.worktreePath);
      return finish("blocked_integration_gates", "Integration state could not be verified before re-running gates.", state.head, [beforeIntegrationGate.evidence]);
    }

    const integrationAuthorization = await authorizeSafely(policy, "integration-gates");
    const integrationGate = integrationAuthorization.allowed
      ? await evaluateSafely(policy, {
          phase: "integration",
          cwd: integrationPlan.worktreePath,
          baseCommit: state.head,
          candidateCommit,
          diff,
          signal: policy.signal,
          execution,
        })
      : failedGate(integrationAuthorization.reason);
    const afterIntegrationGate = snapshotWorktree(integrationPlan.worktreePath, state.head);
    const verifiedIntegrationGate = !afterIntegrationGate.ok || afterIntegrationGate.fingerprint !== beforeIntegrationGate.fingerprint
      ? failedGate("Integration gate commands changed the leased worktree or index; their side effects were rejected.")
      : integrationGate;
    gates.push({ phase: "integration", decision: verifiedIntegrationGate });
    if (!gatePassed(verifiedIntegrationGate)) {
      runGitStrict(["merge", "--abort"], integrationPlan.worktreePath);
      return finish("blocked_integration_gates", gateReason("Advanced-head integration gates failed.", verifiedIntegrationGate), state.head, afterIntegrationGate.ok ? [] : [afterIntegrationGate.evidence]);
    }

    const committed = gitWithIdentity(
      ["commit", "--no-gpg-sign", "-m", "headless: integrate candidate after primary advanced"],
      integrationPlan.worktreePath,
    );
    if (!committed.ok) {
      return finish("commit_failed", "The advanced-head integration commit failed; primary was not modified.", state.head, [committed.stderr]);
    }
    const integrationCommit = getHeadSha(integrationPlan.worktreePath);
    if (!integrationCommit) {
      return finish("commit_failed", "The advanced-head integration commit could not be resolved; primary was not modified.", state.head);
    }

    const finalState = readPrimaryState(plan.primaryRoot);
    if (!finalState.ok || finalState.dirty || finalState.head !== state.head) {
      return finish("blocked_primary_advanced", "Primary changed again while integration gates ran; primary was not modified.", finalState.head, [finalState.evidence]);
    }
    const mergeAuthorization = await authorizeSafely(policy, "primary-mutation");
    if (!mergeAuthorization.allowed) {
      return finish("preserved_no_merge_authority", mergeAuthorization.reason, finalState.head);
    }
    const update: WritePrimaryUpdate = {
      phase: "integration",
      outcome: "merged_advanced",
      baseCommit: plan.baseSha,
      candidateCommit,
      expectedPrimaryHead: state.head,
      targetCommit: integrationCommit,
    };
    const prepared = await preparePrimaryUpdateSafely(policy, update);
    if (!prepared.ok) {
      return finish("blocked_primary_advanced", prepared.reason, finalState.head);
    }
    const finalAuthorization = await authorizeSafely(policy, "primary-mutation");
    if (!finalAuthorization.allowed) {
      return finish("preserved_no_merge_authority", finalAuthorization.reason, finalState.head);
    }
    const updated = fastForwardPrimary(plan.primaryRoot, integrationCommit, state.head);
    if (!updated.ok) {
      return finish("blocked_primary_advanced", "Primary could not be atomically fast-forwarded to the integration result.", getHeadSha(plan.primaryRoot), [updated.stderr]);
    }

    releaseCandidate();
    const journalEvidence = await recordPrimaryUpdateSafely(policy, update, updated.sha);
    return finish("merged_advanced", "Candidate was integrated in a separate worktree and the re-gated result was fast-forwarded into primary.", updated.sha, journalEvidence ? [journalEvidence] : []);
  } finally {
    if (integrationPlan) {
      try {
        removeWriteWorktree(integrationPlan, { force: true, pruneBranch: true });
      } finally {
        if (integrationLeasePrepared) policy.worktreeLease!.onTerminal(integrationPlan, "integration_terminal");
      }
    }
  }
}

function commitCandidate(plan: WriteWorktreePlan, message = "headless: apply contained worker changes") {
  const staged = runGitStrict(["add", "--all"], plan.worktreePath);
  if (!staged.ok) return { ok: false as const, sha: null, stderr: staged.stderr };
  const committed = gitWithIdentity(["commit", "--no-gpg-sign", "-m", boundedCommitMessage(message)], plan.worktreePath);
  if (!committed.ok) return { ok: false as const, sha: null, stderr: committed.stderr };
  const sha = getHeadSha(plan.worktreePath);
  if (!sha) return { ok: false as const, sha: null, stderr: "git commit succeeded but candidate HEAD could not be resolved" };
  return { ok: true as const, sha, stderr: "" };
}

function fastForwardPrimary(primaryRoot: string, commit: string, expectedHead: string) {
  const before = readPrimaryState(primaryRoot);
  if (!before.ok || before.dirty || before.head !== expectedHead) {
    return { ok: false as const, sha: before.head, stderr: before.evidence || "primary changed before fast-forward" };
  }
  const merged = gitWithIdentity(["merge", "--ff-only", commit], primaryRoot);
  if (!merged.ok) return { ok: false as const, sha: getHeadSha(primaryRoot), stderr: merged.stderr };
  const sha = getHeadSha(primaryRoot);
  if (sha !== commit) return { ok: false as const, sha, stderr: `fast-forward produced unexpected HEAD ${sha ?? "unknown"}` };
  return { ok: true as const, sha, stderr: "" };
}

function readPrimaryState(primaryRoot: string) {
  const head = getHeadSha(primaryRoot);
  const status = runGitStrict(["status", "--porcelain=v1", "--untracked-files=all"], primaryRoot);
  return {
    ok: status.ok && !!head,
    dirty: !!status.stdout.trim(),
    head,
    evidence: status.ok ? status.stdout : status.stderr,
  };
}

function inspectCandidateSafety(diff: WriteDiff) {
  if (Buffer.byteLength(diff.diff) > RAW_DIFF_LIMIT_BYTES) {
    return unsafeCandidate("Candidate diff exceeds the raw byte limit.", ["raw-diff-limit-exceeded"]);
  }
  if (Buffer.byteLength(diff.status) > RAW_STATUS_LIMIT_BYTES) {
    return unsafeCandidate("Candidate status exceeds the raw byte limit.", ["raw-status-limit-exceeded"]);
  }
  if (diff.files.length > RAW_FILE_COUNT_LIMIT) {
    return unsafeCandidate("Candidate file count exceeds the review limit.", ["raw-file-count-limit-exceeded"]);
  }
  let fileBytes = 0;
  for (const file of diff.files) {
    const bytes = Buffer.byteLength(file);
    fileBytes += bytes;
    if (bytes > RAW_FILE_PATH_LIMIT_BYTES) return unsafeCandidate("Candidate contains an oversized file path.", ["raw-file-path-limit-exceeded"]);
    if (fileBytes > RAW_FILE_LIST_LIMIT_BYTES) return unsafeCandidate("Candidate file list exceeds the raw byte limit.", ["raw-file-list-limit-exceeded"]);
  }
  try {
    const inspected = [
      redactAndTruncate(diff.diff, RAW_DIFF_LIMIT_BYTES),
      redactAndTruncate(diff.status, RAW_STATUS_LIMIT_BYTES),
      ...diff.files.map((file) => redactAndTruncate(file, RAW_FILE_PATH_LIMIT_BYTES)),
    ];
    if (inspected.some((value) => value.redacted)) {
      return unsafeCandidate("Candidate contains secret-like material and was rejected before staging or commit.", ["secret-scan-triggered"]);
    }
    if (inspected.some((value) => value.truncated)) {
      return unsafeCandidate("Candidate could not be completely inspected within raw limits.", ["candidate-scan-truncated"]);
    }
  } catch {
    return unsafeCandidate("Candidate secret inspection failed closed before staging or commit.", ["candidate-scan-failed"]);
  }
  return { passed: true as const, reason: "", evidence: [] as string[] };
}

function inspectCandidateAttributes(cwd: string, files: string[]) {
  if (files.length === 0) return { passed: true as const, reason: "", evidence: [] as string[] };
  const input = `${files.join("\0")}\0`;
  const attributes = runGitStrict(["-c", "core.fsmonitor=false", "check-attr", "-z", "--stdin", "-a"], cwd, 30_000, input);
  if (!attributes.ok) return unsafeCandidate("Candidate Git attributes could not be inspected safely.", ["git-attribute-scan-failed"]);
  const fields = attributes.stdout.split("\0");
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const name = fields[index + 1];
    const value = fields[index + 2];
    if (name === "filter" && value !== "unspecified" && value !== "unset") {
      return unsafeCandidate("Candidate requires a Git clean filter that the daemon will not execute.", ["git-clean-filter-rejected"]);
    }
    if (name === "merge" && !new Set(["unspecified", "unset", "set", "text", "binary", "union"]).has(value)) {
      return unsafeCandidate("Candidate requires a custom Git merge driver that the daemon will not execute.", ["git-merge-driver-rejected"]);
    }
  }
  return { passed: true as const, reason: "", evidence: [] as string[] };
}

function unsafeCandidate(reason: string, evidence: string[]) {
  return { passed: false as const, reason, evidence };
}

function snapshotWorktree(cwd: string, baseCommit: string) {
  const head = getHeadSha(cwd);
  let material: WriteDiff;
  try {
    material = captureWorktreeDiff(cwd, baseCommit);
  } catch (error) {
    return {
      ok: false as const,
      fingerprint: null,
      evidence: safeEvidence(error instanceof Error ? error.message : String(error)),
    };
  }
  if (!head) return { ok: false as const, fingerprint: null, evidence: "candidate HEAD could not be resolved" };
  if (Buffer.byteLength(material.diff) > RAW_DIFF_LIMIT_BYTES || Buffer.byteLength(material.status) > RAW_STATUS_LIMIT_BYTES) {
    return { ok: false as const, fingerprint: null, evidence: "candidate fingerprint exceeds raw limits" };
  }
  const fingerprint = createHash("sha256")
    .update(head)
    .update("\0")
    .update(material.diff)
    .update("\0")
    .update(material.status)
    .update("\0")
    .update(material.files.join("\0"))
    .digest("hex");
  return { ok: true as const, fingerprint, evidence: "" };
}

async function evaluateSafely(policy: WriteIntegrationPolicy, context: WriteGateContext) {
  try {
    return normalizeGate(await policy.evaluateGates(context));
  } catch (error) {
    return failedGate(`Gate evaluation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function authorizeSafely(policy: WriteIntegrationPolicy, checkpoint: WriteAuthorizationCheckpoint) {
  try {
    const decision = await policy.reauthorize(checkpoint);
    return {
      allowed: decision.allowed === true,
      reason: safeEvidence(decision.reason || (decision.allowed ? "Write authority confirmed." : "Write authority is no longer active.")),
    };
  } catch (error) {
    return {
      allowed: false,
      reason: safeEvidence(`Write authorization check failed: ${error instanceof Error ? error.message : String(error)}`),
    };
  }
}

async function preparePrimaryUpdateSafely(policy: WriteIntegrationPolicy, update: WritePrimaryUpdate) {
  if (!policy.preparePrimaryUpdate) return { ok: true as const, reason: "" };
  try {
    await policy.preparePrimaryUpdate(update);
    return { ok: true as const, reason: "" };
  } catch (error) {
    return {
      ok: false as const,
      reason: safeEvidence(`Primary update journal could not be persisted; primary was not modified: ${error instanceof Error ? error.message : String(error)}`),
    };
  }
}

async function recordPrimaryUpdateSafely(
  policy: WriteIntegrationPolicy,
  update: WritePrimaryUpdate,
  resultingCommit: string,
) {
  if (!policy.recordPrimaryUpdate) return null;
  try {
    await policy.recordPrimaryUpdate({ ...update, resultingCommit });
    return null;
  } catch (error) {
    // The prepared record was already fsynced before mutation. Preserve it for
    // restart reconciliation instead of turning a successful primary update
    // into a misleading failed result.
    return safeEvidence(`Primary update applied marker failed; prepared journal retained for recovery: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeGate(value: WriteGateDecision): WriteGateDecision {
  return {
    policyPassed: value.policyPassed === true,
    testsPassed: value.testsPassed === true,
    reviewPassed: value.reviewPassed === true,
    votePassed: value.votePassed === true,
    budgetPassed: value.budgetPassed === true,
    reasons: (value.reasons ?? []).map(safeEvidence).slice(0, 64),
    evidence: (value.evidence ?? []).map(safeEvidence).slice(0, 64),
  };
}

function failedGate(reason: string): WriteGateDecision {
  return {
    policyPassed: false,
    testsPassed: false,
    reviewPassed: false,
    votePassed: false,
    budgetPassed: false,
    reasons: [safeEvidence(reason)],
    evidence: [],
  };
}

function gatePassed(value: WriteGateDecision) {
  // A vote is a council requirement, not a one-shot write requirement. The
  // caller records it, while policy/tests/review/budget are always enforced.
  return value.policyPassed && value.testsPassed && value.reviewPassed && value.budgetPassed;
}

function gateReason(prefix: string, value: WriteGateDecision) {
  return value.reasons?.length ? `${prefix} ${value.reasons.join(" ")}` : prefix;
}

function gitWithIdentity(args: string[], cwd: string) {
  return runGitStrict([
    "-c", `user.name=${DAEMON_GIT_NAME}`,
    "-c", `user.email=${DAEMON_GIT_EMAIL}`,
    "-c", "commit.gpgsign=false",
    "-c", "tag.gpgsign=false",
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "merge.verifySignatures=false",
    ...args,
  ], cwd, 30_000);
}

function boundedCommitMessage(value: string) {
  const clean = value.replace(/[\r\n\0]+/g, " ").trim().slice(0, 512);
  return clean || "headless: apply contained worker changes";
}

function retainCandidateBranch(plan: WriteWorktreePlan) {
  const suffix = plan.branch.replace(/^headless\/write\//, "");
  const retained = `headless/candidate/${suffix || randomUUID().slice(0, 8)}`;
  const renamed = runGitStrict(["branch", "-m", retained], plan.worktreePath);
  return renamed.ok ? retained : null;
}

function safeEvidence(value: string) {
  try {
    return redactAndTruncate(value, EVIDENCE_LIMIT).text;
  } catch {
    return "[SUPPRESSED: REDACTION FAILURE]";
  }
}

export function candidateBranchExists(primaryRoot: string, branch: string) {
  return existsSync(join(primaryRoot, ".git")) && runGitStrict(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], primaryRoot).ok;
}
