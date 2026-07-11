# Fleet Analysis: 30-Agent Code Review (v2 / Delta)

**Date:** 2026-07-11 (follow-up run)
**Scope:** Headless vs ContextRelay / Claw Orchestrator / Codex Plugin CC
**Method:** Re-execution of verification commands (`bun run` hygiene + targeted key tests), git delta inspection, direct source reads of changed files (daemon, runtime, backends, tests), and a focused delta subagent comparing current state against the baseline in the original `fleet-analysis-30-agents.md`. Parallel tool use + real test execution.

This is a **follow-up** to the prior 30-agent analysis. It focuses on **improvements vs. regressions** since that snapshot.

---

## Executive Summary (Delta View)

| Area | Prior Snapshot (original MD) | Current (v2) | Delta |
|------|------------------------------|--------------|-------|
| Hygiene (lint/format/typecheck) | Passed | Passes cleanly (240 files) | **Stable / slight improvement** (more files, still green) |
| Key Orchestrator Tests (daemon councils, workflows, write/grants) | ~48 pass, 0 fail in targeted | 55 pass + 7 skip, **15-16 fail** (in daemon.test + workflow.test) | **Regression** |
| Architecture / Modularity | God classes noted (daemon/server.ts ~2.6k lines monolithic; cli dispatch) | daemon/server.ts ~1k lines (thin + services: CouncilService, WorkflowService, JobAdmission, RunExecution, etc.); duplication centralized in `validation.ts` | **Clear improvement** |
| Containment | Strong multi-layer (Seatbelt/bwrap + probes) | os-sandbox.ts grown to ~1000 lines, more robust profiles + executable-read-roots | **Improvement / maturation** |
| Overall Quality | Strong spine; debt in god classes + some duplication | Hygiene top-tier; god classes reduced; new focused services | **Net architecture/quality up** |
| Project Verdict | Headless best "engine"; CR best "cockpit" | Unchanged | Stable |

**Net:** **Architectural and code-quality improvements** (refactoring toward AGENTS.md small-files, centralization, containment hardening). **Targeted regression** in high-level orchestrator test coverage under required containment (exactly the fleets/workflows/councils area).

---

## Current Health Snapshot

- `bun run typecheck` / `lint` / `format:check`: **All pass**.
- `bun test tests/` (key files): 486 pass / 10 skip / 16 fail overall. The failing cluster is in integrated orchestrator paths.
- Containment/ledger/redaction/worktree lower-level + write-integration unit tests remain solid.
- Many source changes (big insertions in os-sandbox, read-model, redaction, session, worktree; new MCP; refactors; old monolithic test deleted).

---

## Key Regressions

**Orchestrator / Council / Workflow / Write Integration tests now failing (15-16 fails vs. prior 0 in targeted runs)**

Failing areas (from `tests/daemon.test.ts` and `tests/workflow.test.ts`):
- Typed council phases over actual candidate/review outputs (votes.length=0 instead of expected).
- Write councils preserve candidates until after review+vote.
- Cannot substitute candidate preservation for failed test gate.
- Daemon startup resume of nonterminal council to durable decision.
- Strict majority for even council (no tie approval).
- Coordinator write jobs, grants, concurrent worktree, pre-merge ledger, revoke/expire grants, fast-forward/merge.
- Durable workflows: actual dep results through DAG, enforce finality gates, resume from external state after restart.

**Root cause (delta analysis):**
- During containment maturation (larger os-sandbox, `executable-read-roots.ts`, stricter darwin profiles + runtimeReadRoots), test fixtures (shims installed via PATH with `#!/usr/bin/env bun`) no longer execute successfully under "required" containment.
- Darwin sandbox does not reliably include the bun interpreter binary (or its parent) for shebangs in fixtures (Linux handling in `simple.ts` is more explicit).
- Result: jobs return "noAssistantOutput" / "failed" → no real outputs/votes/diffs → councils get 0 votes, workflows get "blocked"/"failed", gates fail, grant tests fail.
- Lower primitives (write-integration.test, containment-v2, worktree, ledger) still pass because they use different execution surfaces or mocks.

This is a **regression in observable correctness of the "universal orchestrator + fleets" layer** introduced while hardening containment.

Other minor:
- Grok security metadata remains the outlier (`disablesProjectConfig/Hooks/...: false` vs. hardenedSecurity() used by others). Still triggers required-containment gaps.

---

## Key Improvements

**1. Major refactoring toward "small focused files" (AGENTS.md alignment)**
- `src/daemon/server.ts`: Dramatically smaller (~1074 lines vs. prior god-class reports of 2.6k+). Now thin coordinator delegating to:
  - `CouncilService`, `WorkflowService`
  - `JobAdmissionService` (pump + budgets)
  - `RunExecutionService` (run + gates + finality)
  - Route dispatcher + handlers
  - `daemon-extensions.ts` (trusted bootstrap)
- Many new focused modules in `src/daemon/`.
- `safeOption` / validation helpers centralized in `src/runtime/validation.ts` (no more 3x copy-paste in backends).
- Result normalizer and other helpers extracted.

This directly addresses prior recommendations ("split daemon/server.ts", reduce god objects).

**2. Containment & runtime hardening**
- `os-sandbox.ts` grown significantly (~1000 lines) with more complete darwin profiles, linux bwrap+seccomp+x32, `executable-read-roots`, runtimeReadRoots injection.
- Worker env, redaction, session, read-model all show growth/maturation (more robust roots, streaming redaction, persistent sessions).
- Matches "containment 3→~7+" trajectory from prior review.

**3. Hygiene & anti-pattern cleanup**
- Lint/format still 100% clean on 240 files.
- Many prior anti-patterns reduced or eliminated in src (fewer `Object.assign(new Error, {code})`, swallowed catches, bare `any` in hot paths).
- `process.kill("SIGKILL")` dead-code bug from prior reports appears addressed (proper process-tree killing now).

**4. Other**
- MCP surface stable and complete.
- Write-integration, ledger-v2, worktree-leases, atomic-write remain strong (or improved).
- Stores/services follow small-file discipline better.
- Overall source hygiene and modularity visibly progressed even as some high-level tests broke.

---

## Code Quality / Duplication / Style Update (Delta)

- **God classes reduced**: Primary win. daemon/server and cli dispatch improved.
- **Duplication**: Lower (centralized validation). Parser assembly still has some per-backend repetition (acceptable).
- **Bun lock-in**: Still strong (intentional); no new portability regression.
- **Long functions/nesting**: Better in daemon after extraction; still present in complex paths (write-integration, os-sandbox profiles) — justified by domain.
- **Hygiene**: Remains best-in-class. No TODOs, no random, strict enforcement.
- **Style**: Continues to track opencode/AGENTS.md spirit (Bun, inference, focused modules) while evolving from CR patterns.

Previous code-quality subagent recommendations (split gods, centralize helpers) are being actively followed.

---

## Project Comparisons (Unchanged Verdict)

The relative positioning from the prior synthesis holds:
- **Headless**: Best universal safe contained runner + durable orchestrator (multi-backend, ledger-v2, required OS containment, DAG workflows + councils with finality + budgets + write safety).
- **ContextRelay**: Best for live Claude↔Codex pair collaboration + rich coordination surfaces.
- **Claw**: Best for persistent sessions + autoloop + rich multi-agent UX/pipelines.
- **Codex Plugin**: Best narrow official delegation inside Claude Code.

Headless remains the strongest "engine" candidate and the natural substrate the others can layer on (as previously recommended).

---

## Net Assessment: Improvement or Regression?

**Overall: Mixed, leaning improvement in fundamentals with a visible regression in test coverage for the orchestrator layer.**

- **Improvements dominate the engineering quality**:
  - Refactoring reduced god classes and duplication.
  - Containment and runtime primitives matured.
  - Hygiene and modularity advanced.
  - Code is cleaner and more aligned with AGENTS.md "small focused files" in the daemon/runtime.

- **Regression**:
  - 15-16 key tests now failing in exactly the areas (councils, workflows, write integration, grants, daemon recovery) that the prior analysis described as solid.
  - Caused by the containment hardening itself (good direction) interacting poorly with test fixture setup on darwin.
  - Temporarily weakens confidence in "rock-solid exec + fleets/workflows" claims until fixed.

**Long-term**: The refactor + containment work is a net positive. The test breakage is a classic "stricter enforcement exposes fixture gaps" situation and should be straightforward to resolve (ensure bun interpreter + shims are in darwin runtimeReadRoots / profile allows for test fixtures, or use fully resolved commands).

---

## Recommendations (Updated)

1. **Immediate (test regression)**: Fix darwin sandbox fixture support — resolve and inject the bun binary (and its parent dir) into runtimeReadRoots / darwin profiles for test shims. Make sure shebang resolution works under required containment. Re-run the full daemon + workflow test suite.
2. **Continue extraction**: Keep splitting remaining hot paths in daemon (admission/execution/finalty coordination). Good progress already visible.
3. **Grok**: Either harden its security metadata (like the others) or explicitly document why it remains different.
4. **Centralize more**: Parser result assembly helper, any remaining repeated guards.
5. **Re-verify**: After the sandbox fixture fix, run the full `bun run check` + the previously passing containment/ledger/worktree tests + the orchestrator suite. Update this doc or produce v3.
6. **Compatibility**: Keep the intentional alignment with ContextRelay ledger/worktree/policy shapes while the headless engine hardens.

---

## Evidence Sources (this run)
- Direct `bun test` output on `tests/daemon.test.ts`, `workflow.test.ts`, `containment-v2.test.ts`, `write-integration.test.ts`, etc.
- Source reads of `src/daemon/server.ts`, `src/daemon/*-service.ts`, `src/runtime/os-sandbox.ts`, `validation.ts`, `worktree*.ts`, `read-model.ts`, `redaction.ts`, `backends/registry.ts`.
- Git delta + file sizes vs. prior analysis snapshot.
- Hygiene commands (`typecheck`/`lint`/`format:check`).
- Prior `fleet-analysis-30-agents.md` as baseline.

**File note**: This is v2 (different filename) to allow side-by-side comparison with the original.

*Re-analysis complete. Hygiene solid; orchestrator tests need immediate attention after recent containment/refactor work.*


