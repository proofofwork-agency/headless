import { createHash, randomUUID } from "node:crypto";
import { getHeadSha, runGitStrict } from "./git";
import type { IntegrationJournal } from "./integration-journal";
import { redactAndTruncate } from "./redaction";
import {
  captureWorktreeDiff,
  createWriteWorktree,
  planWriteWorktree,
  removeWriteWorktree,
  type WorktreeLeaseHooks,
  type WriteDiff,
  type WriteWorktreePlan,
} from "./worktree";
import type {
  WriteAuthorizationCheckpoint,
  WriteExecutionSummary,
  WriteGateContext,
  WriteGateDecision,
} from "./write-integration";

export type PreservedCandidateIntegrationOutcome =
  | "merged_fast_forward"
  | "merged_advanced"
  | "blocked_dirty_primary"
  | "blocked_conflict"
  | "blocked_integration_gates"
  | "blocked_primary_advanced"
  | "unauthorized"
  | "cancelled";

export type PreservedCandidateIntegrationResult = {
  outcome: PreservedCandidateIntegrationOutcome;
  merged: boolean;
  baseCommit: string;
  candidateCommit: string;
  expectedPrimaryHead: string | null;
  targetCommit: string | null;
  resultingCommit: string | null;
  reason: string;
  evidence: string[];
  gate: WriteGateDecision | null;
  journalState: "none" | "prepared" | "applied";
};

export type PreservedCandidateGitIntegrationOptions = {
  primaryRoot: string;
  candidateId: string;
  sessionId: string | null;
  actor: string;
  grantId: string | null;
  currentGrantId?: () => string | null;
  baseCommit: string;
  candidateCommit: string;
  execution: WriteExecutionSummary;
  journal: IntegrationJournal;
  signal?: AbortSignal;
  worktreeLease?: WorktreeLeaseHooks;
  /** Force isolated gates even when primary still equals the candidate base. */
  requireIntegrationGates?: boolean;
  reauthorize: (checkpoint: WriteAuthorizationCheckpoint) => Promise<{ allowed: boolean; reason: string }> | { allowed: boolean; reason: string };
  evaluateIntegrationGates: (context: WriteGateContext) => Promise<WriteGateDecision>;
};

/**
 * Integrate an already-committed candidate. Advanced primary heads are merged
 * and gated only in a daemon-owned linked worktree; primary is touched once,
 * after a durable journal intent and a final authority check.
 */
export async function integratePreservedCandidateCommit(
  options: PreservedCandidateGitIntegrationOptions,
): Promise<PreservedCandidateIntegrationResult> {
  const primary = readPrimaryState(options.primaryRoot);
  if (!primary.ok || primary.dirty || !primary.head) {
    return result(options, "blocked_dirty_primary", "Primary checkout is dirty or could not be verified.", {
      expectedPrimaryHead: primary.head,
      evidence: [primary.evidence],
    });
  }
  if (options.signal?.aborted) {
    return result(options, "cancelled", "Candidate integration was cancelled before primary preparation.", {
      expectedPrimaryHead: primary.head,
    });
  }
  if (primary.head === options.baseCommit && !options.requireIntegrationGates) return integrateFastForward(options, primary.head);
  return integrateAdvanced(options, primary.head);
}

async function integrateFastForward(options: PreservedCandidateGitIntegrationOptions, expectedHead: string) {
  const authorization = await authorize(options, "primary-mutation");
  if (!authorization.allowed) {
    return result(options, "unauthorized", authorization.reason, { expectedPrimaryHead: expectedHead });
  }
  const prepared = prepareJournal(options, {
    phase: "candidate",
    outcome: "merged_fast_forward",
    expectedPrimaryHead: expectedHead,
    targetCommit: options.candidateCommit,
  });
  if (!prepared.ok) {
    return result(options, "blocked_primary_advanced", prepared.reason, { expectedPrimaryHead: expectedHead });
  }
  if (options.signal?.aborted) {
    const abandonEvidence = abandonJournal(options, expectedHead);
    return result(options, "cancelled", "Candidate integration was cancelled before primary mutation.", {
      expectedPrimaryHead: expectedHead,
      targetCommit: options.candidateCommit,
      evidence: abandonEvidence ? [abandonEvidence] : [],
      journalState: "prepared",
    });
  }
  const finalAuthorization = await authorize(options, "primary-mutation");
  if (!finalAuthorization.allowed) {
    const abandonEvidence = abandonJournal(options, expectedHead);
    return result(options, "unauthorized", finalAuthorization.reason, {
      expectedPrimaryHead: expectedHead,
      targetCommit: options.candidateCommit,
      evidence: abandonEvidence ? [abandonEvidence] : [],
      journalState: "prepared",
    });
  }
  const updated = fastForwardPrimary(options.primaryRoot, options.candidateCommit, expectedHead);
  if (!updated.ok) {
    const abandonEvidence = abandonJournalIfSafe(options, expectedHead);
    return result(options, "blocked_primary_advanced", "Primary changed before the candidate fast-forward completed.", {
      expectedPrimaryHead: expectedHead,
      targetCommit: options.candidateCommit,
      resultingCommit: updated.head,
      evidence: [updated.evidence, ...(abandonEvidence ? [abandonEvidence] : [])],
      journalState: "prepared",
    });
  }
  const journalEvidence = markJournalApplied(options, updated.head);
  return result(options, "merged_fast_forward", "Candidate was fast-forwarded into the unchanged primary checkout.", {
    merged: true,
    expectedPrimaryHead: expectedHead,
    targetCommit: options.candidateCommit,
    resultingCommit: updated.head,
    evidence: journalEvidence ? [journalEvidence] : [],
    journalState: journalEvidence ? "prepared" : "applied",
  });
}

async function integrateAdvanced(options: PreservedCandidateGitIntegrationOptions, expectedHead: string) {
  let plan: WriteWorktreePlan | null = null;
  let gate: WriteGateDecision | null = null;
  let terminal: PreservedCandidateIntegrationResult | null = null;
  const finish = (
    outcome: PreservedCandidateIntegrationOutcome,
    reason: string,
    patch: Partial<PreservedCandidateIntegrationResult> = {},
  ) => {
    terminal = result(options, outcome, reason, {
      expectedPrimaryHead: expectedHead,
      gate,
      ...patch,
    });
    return terminal;
  };

  try {
    plan = planWriteWorktree({
      primaryRoot: options.primaryRoot,
      label: `candidate-integration-${randomUUID().slice(0, 8)}`,
      tempBase: options.worktreeLease?.tempBase,
    });
    options.worktreeLease?.onPlanned(plan, "integration");
    createWriteWorktree(plan);
    options.worktreeLease?.onCreated(plan, "integration");
    if (plan.baseSha !== expectedHead) {
      return finish("blocked_primary_advanced", "Primary advanced while the isolated integration worktree was being created.");
    }

    const mergedTree = gitWithIdentity(["merge", "--no-ff", "--no-commit", options.candidateCommit], plan.worktreePath);
    if (!mergedTree.ok) {
      const status = runGitStrict(["status", "--porcelain=v1"], plan.worktreePath);
      runGitStrict(["merge", "--abort"], plan.worktreePath);
      return finish("blocked_conflict", "Candidate conflicts with the advanced primary; primary was not modified.", {
        evidence: [mergedTree.stderr, status.stdout],
      });
    }

    const before = snapshot(plan.worktreePath, expectedHead);
    if (!before.ok) {
      runGitStrict(["merge", "--abort"], plan.worktreePath);
      return finish("blocked_integration_gates", "The advanced candidate state could not be fingerprinted before gates.", {
        evidence: [before.evidence],
      });
    }
    const gateAuthorization = await authorize(options, "integration-gates");
    if (!gateAuthorization.allowed) {
      gate = failedGate(gateAuthorization.reason);
    } else if (options.signal?.aborted) {
      gate = failedGate("Candidate integration was cancelled before advanced-head gates.");
    } else {
      try {
        gate = normalizeGate(await options.evaluateIntegrationGates({
          phase: "integration",
          cwd: plan.worktreePath,
          baseCommit: expectedHead,
          candidateCommit: options.candidateCommit,
          diff: before.diff,
          signal: options.signal,
          execution: options.execution,
        }));
      } catch (error) {
        gate = failedGate(`Advanced-head gate evaluation failed: ${messageOf(error)}`);
      }
    }
    const after = snapshot(plan.worktreePath, expectedHead);
    if (!after.ok || after.fingerprint !== before.fingerprint) {
      gate = failedGate("Integration gate commands changed the isolated worktree or index; side effects were rejected.");
    }
    if (!gatePassed(gate)) {
      runGitStrict(["merge", "--abort"], plan.worktreePath);
      return finish("blocked_integration_gates", gateReason(gate), {
        evidence: [...(gate.evidence ?? []), ...(after.ok ? [] : [after.evidence])],
      });
    }
    if (options.signal?.aborted) {
      runGitStrict(["merge", "--abort"], plan.worktreePath);
      return finish("cancelled", "Candidate integration was cancelled after advanced-head gates.");
    }

    const committed = gitWithIdentity(
      ["commit", "--no-gpg-sign", "-m", "headless: integrate preserved candidate"],
      plan.worktreePath,
    );
    if (!committed.ok) {
      return finish("blocked_primary_advanced", "The isolated advanced-head merge commit failed.", {
        evidence: [committed.stderr],
      });
    }
    const targetCommit = getHeadSha(plan.worktreePath);
    if (!targetCommit) return finish("blocked_primary_advanced", "The isolated integration result could not be resolved.");

    const primary = readPrimaryState(options.primaryRoot);
    if (!primary.ok || primary.dirty || primary.head !== expectedHead) {
      return finish("blocked_primary_advanced", "Primary changed while advanced-head gates ran; primary was not modified.", {
        resultingCommit: primary.head,
        targetCommit,
        evidence: [primary.evidence],
      });
    }
    const authorization = await authorize(options, "primary-mutation");
    if (!authorization.allowed) return finish("unauthorized", authorization.reason, { targetCommit });
    const prepared = prepareJournal(options, {
      phase: "integration",
      outcome: "merged_advanced",
      expectedPrimaryHead: expectedHead,
      targetCommit,
    });
    if (!prepared.ok) return finish("blocked_primary_advanced", prepared.reason, { targetCommit });
    if (options.signal?.aborted) {
      const abandonEvidence = abandonJournal(options, expectedHead);
      return finish("cancelled", "Candidate integration was cancelled before primary mutation.", {
        targetCommit,
        evidence: abandonEvidence ? [abandonEvidence] : [],
        journalState: "prepared",
      });
    }
    const finalAuthorization = await authorize(options, "primary-mutation");
    if (!finalAuthorization.allowed) {
      const abandonEvidence = abandonJournal(options, expectedHead);
      return finish("unauthorized", finalAuthorization.reason, {
        targetCommit,
        evidence: abandonEvidence ? [abandonEvidence] : [],
        journalState: "prepared",
      });
    }
    const updated = fastForwardPrimary(options.primaryRoot, targetCommit, expectedHead);
    if (!updated.ok) {
      const abandonEvidence = abandonJournalIfSafe(options, expectedHead);
      return finish("blocked_primary_advanced", "Primary could not be atomically fast-forwarded to the isolated integration result.", {
        targetCommit,
        resultingCommit: updated.head,
        evidence: [updated.evidence, ...(abandonEvidence ? [abandonEvidence] : [])],
        journalState: "prepared",
      });
    }
    const journalEvidence = markJournalApplied(options, updated.head);
    return finish("merged_advanced", "Candidate was merged and re-gated in an isolated worktree before primary was updated.", {
      merged: true,
      targetCommit,
      resultingCommit: updated.head,
      evidence: journalEvidence ? [journalEvidence] : [],
      journalState: journalEvidence ? "prepared" : "applied",
    });
  } catch (error) {
    return finish("blocked_primary_advanced", `Isolated candidate integration failed: ${messageOf(error)}`);
  } finally {
    if (plan) {
      const completed = terminal as PreservedCandidateIntegrationResult | null;
      try {
        removeWriteWorktree(plan, { force: true, pruneBranch: true });
      } catch (error) {
        completed?.evidence.push(safeEvidence(`Integration worktree cleanup failed: ${messageOf(error)}`));
      }
      try {
        options.worktreeLease?.onTerminal(plan, completed?.outcome ?? "blocked_primary_advanced", completed?.evidence);
      } catch (error) {
        completed?.evidence.push(safeEvidence(`Integration worktree lease transition failed: ${messageOf(error)}`));
      }
    }
  }
}

function prepareJournal(
  options: PreservedCandidateGitIntegrationOptions,
  input: {
    phase: "candidate" | "integration";
    outcome: "merged_fast_forward" | "merged_advanced";
    expectedPrimaryHead: string;
    targetCommit: string;
  },
) {
  try {
    options.journal.prepare({
      jobId: options.candidateId,
      sessionId: options.sessionId,
      principal: options.actor,
      grantId: options.currentGrantId?.() ?? options.grantId,
      baseCommit: options.baseCommit,
      candidateCommit: options.candidateCommit,
      ...input,
    });
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, reason: `Integration journal preparation failed: ${messageOf(error)}` };
  }
}

function markJournalApplied(options: PreservedCandidateGitIntegrationOptions, resultingCommit: string) {
  try {
    options.journal.markApplied(options.candidateId, resultingCommit);
    return null;
  } catch (error) {
    return safeEvidence(`Primary was updated but the applied journal marker failed; restart recovery is required: ${messageOf(error)}`);
  }
}

function abandonJournal(options: PreservedCandidateGitIntegrationOptions, observedHead: string) {
  try {
    options.journal.markAbandoned(options.candidateId, observedHead);
  } catch (error) {
    return safeEvidence(`Prepared integration intent could not be abandoned: ${messageOf(error)}`);
  }
  return null;
}

function abandonJournalIfSafe(options: PreservedCandidateGitIntegrationOptions, expectedHead: string) {
  const state = readPrimaryState(options.primaryRoot);
  if (state.ok && !state.dirty && state.head === expectedHead) return abandonJournal(options, expectedHead);
  return safeEvidence("Prepared integration intent remains open because primary changed or became unverifiable; restart reconciliation is required.");
}

function fastForwardPrimary(primaryRoot: string, target: string, expectedHead: string) {
  const before = readPrimaryState(primaryRoot);
  if (!before.ok || before.dirty || before.head !== expectedHead) {
    return { ok: false as const, head: before.head, evidence: before.evidence || "Primary changed before mutation." };
  }
  const merged = gitWithIdentity(["merge", "--ff-only", target], primaryRoot);
  const head = getHeadSha(primaryRoot);
  if (head === target) return { ok: true as const, head: target, evidence: merged.ok ? "" : merged.stderr };
  if (!merged.ok || head !== target) {
    return { ok: false as const, head, evidence: merged.stderr || `Fast-forward produced unexpected HEAD ${head ?? "unknown"}.` };
  }
  return { ok: true as const, head: target, evidence: "" };
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

function snapshot(cwd: string, baseCommit: string) {
  const head = getHeadSha(cwd);
  let diff: WriteDiff;
  try {
    diff = captureWorktreeDiff(cwd, baseCommit);
  } catch (error) {
    return { ok: false as const, evidence: messageOf(error) };
  }
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ head, diff }))
    .digest("hex");
  return { ok: true as const, fingerprint, diff, evidence: "" };
}

function gitWithIdentity(args: string[], cwd: string) {
  return runGitStrict([
    "-c", "user.name=Headless Daemon",
    "-c", "user.email=headless@localhost",
    "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=/dev/null",
    ...args,
  ], cwd, 30_000);
}

async function authorize(options: PreservedCandidateGitIntegrationOptions, checkpoint: WriteAuthorizationCheckpoint) {
  try {
    return await options.reauthorize(checkpoint);
  } catch (error) {
    return { allowed: false, reason: `Authority re-check failed closed: ${messageOf(error)}` };
  }
}

function normalizeGate(value: WriteGateDecision): WriteGateDecision {
  return {
    policyPassed: value.policyPassed === true,
    testsPassed: value.testsPassed === true,
    reviewPassed: value.reviewPassed === true,
    votePassed: value.votePassed === true,
    budgetPassed: value.budgetPassed === true,
    reasons: (value.reasons ?? []).slice(0, 64).map(safeEvidence),
    evidence: (value.evidence ?? []).slice(0, 64).map(safeEvidence),
  };
}

function gatePassed(gate: WriteGateDecision) {
  return gate.policyPassed && gate.testsPassed && gate.reviewPassed && gate.budgetPassed;
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

function gateReason(gate: WriteGateDecision) {
  return gate.reasons?.length
    ? `Advanced-head integration gates failed. ${gate.reasons.join(" ")}`
    : "Advanced-head integration gates failed.";
}

function result(
  options: PreservedCandidateGitIntegrationOptions,
  outcome: PreservedCandidateIntegrationOutcome,
  reason: string,
  patch: Partial<PreservedCandidateIntegrationResult> = {},
): PreservedCandidateIntegrationResult {
  return {
    outcome,
    merged: false,
    baseCommit: options.baseCommit,
    candidateCommit: options.candidateCommit,
    expectedPrimaryHead: null,
    targetCommit: null,
    resultingCommit: getHeadSha(options.primaryRoot),
    reason: safeEvidence(reason),
    gate: null,
    journalState: "none",
    ...patch,
    evidence: (patch.evidence ?? []).filter(Boolean).slice(0, 64).map(safeEvidence),
  };
}

function safeEvidence(value: string) {
  try {
    return redactAndTruncate(value, 4_096).text;
  } catch {
    return "[SUPPRESSED: REDACTION FAILURE]";
  }
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
