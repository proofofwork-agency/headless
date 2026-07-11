# Fleet Analysis: 30-Agent Code Review - Recheck (2026-07-11)

**Date:** 2026-07-11 (recheck iteration)
**Scope:** Headless project state vs previous analyses (original + v2 delta)
**Method:** Fresh execution of `bun run check`, targeted test runs, hygiene verification, log inspection, and delta comparison against prior reports (`fleet-analysis-30-agents.md` and `fleet-analysis-30-agents-v2.md`). Focused on detecting improvements or regressions since the last re-analysis.

This is a follow-up recheck using a distinct filename as requested.

---

## Executive Summary

**Latest `bun run check` result:**
- 511 pass
- 10 skip
- **0 fail**
- 11037 expect() calls
- Ran 521 tests across 66 files
- **Overall: PASSED** (exit code 0 for the check components; full suite completed successfully)

**Hygiene (non-test parts):**
- Typecheck: clean
- Plugin typecheck: clean
- Lint: passed (244 files)
- Format: passed (244 files)
- Docs check: passed (6 release documents verified)

**Key Delta vs Prior States:**
- **Vs original analysis:** Significant progress. God classes refactored (daemon/server.ts extracted into services). Duplication reduced. Containment hardened. Tests were solid in baseline; now even more tests (521 vs prior counts) with full green.
- **Vs v2 (which noted 15-17 failing orchestrator tests):** **Clear improvement**. The 17 failures in council phases, write councils, grants, workflows, and daemon recovery have been resolved. 0 failures now. The refactoring paid off, and fixture/sandbox issues appear addressed in the current state.
- No new regressions observed in the recheck. Hygiene remains excellent. Orchestrator layer (workflows, councils, finality, autonomy) now passing under required containment.

**Net:** Improvement in test stability and code structure. The project has moved from an intermediate state with test breakage (during heavy refactoring/containment work) back to (and beyond) a clean, passing state.

---

## Current Health

- **Full check:** Successful. All hygiene gates pass. Test suite green with 0 failures.
- **Orchestrator-specific (daemon.test.ts + workflow.test.ts):** All previously failing tests now pass, including:
  - Typed council phases over actual outputs
  - Write councils preserve candidates + test gate binding
  - Strict majority rules
  - Grants, concurrent worktree, ledger pre-merge, revoke/expire scenarios
  - Durable workflows DAG dep results, finality gates, resume after restart
- **Containment & primitives:** Continue to hold (many passes in containment-v2, worktree, ledger-v2, redaction, broker, etc.).
- **Newer surfaces (MCP, goal runtime, native sessions, etc.):** Passing as listed in the run.
- More tests executed than in some prior snapshots (521 tests / 66 files).

---

## Improvements Observed

1. **Test regressions fixed:** The 15-17 failures noted in the v2 delta (concentrated in authenticated project daemon councils/grants/write paths and durable workflows) are gone. Full green run.
2. **Structural improvements persist and are validated:** The daemon refactoring (smaller server.ts + service extraction) is now exercised by passing tests. Validation centralization and hygiene enforcement confirmed.
3. **Increased test coverage/execution:** Higher number of tests ran and passed compared to some intermediate counts.
4. **Hygiene stability:** Lint, format, typecheck, docs all clean (numbers slightly higher: 244 files).
5. **Orchestrator robustness:** Workflows, councils, finality, autonomy, write integration, and grant paths now reliably passing even with required containment and real daemon restart scenarios.
6. **Overall maturity:** The project demonstrates resilience — heavy changes (refactors, containment enhancements) temporarily impacted tests but the suite recovered to clean.

---

## No Major Regressions Detected

- No new failure categories.
- Hygiene gates remain strong.
- Core areas (ledger, containment, backends, broker, sessions, MCP, etc.) continue to pass.
- The "pay for durability" complexity in orchestrator is now backed by passing tests.

---

## Comparison to Prior Analyses

- **Original fleet-analysis-30-agents.md:** Baseline praised strong architecture but noted god classes and some duplication. Tests were reported passing at that snapshot. Current state shows the recommended refactors landed, duplication cleaned, and tests still (now confirmed) green.
- **v2 delta:** Highlighted temporary regression (15-17 fails) during active development + stricter sandbox. This recheck shows recovery: 0 fails. The "architecture up, tests temporarily down" has flipped to both improved.
- **Project positioning:** Unchanged from prior syntheses — Headless remains the strongest for universal contained runner + orchestrator. Complementary to ContextRelay (pairing) and Claw (persistent UX).

---

## Recommendations

- Continue monitoring after any future large refactors (e.g., re-run full check + key orchestrator tests).
- The current state validates the direction: refactoring + containment hardening is net positive.
- If any intermittent flakiness appears (e.g., on Linux CI for skipped bwrap tests), consider stabilizing fixtures further.
- Good time to build on the clean base for new features (fleets, more superpowers).

---

## Evidence

- Full `bun run check` log (hygiene + 511/0/10 pass/fail/skip).
- Tail of test output confirming 0 fails and specific passing orchestrator tests.
- Cross-reference with v2 doc's noted failures (now resolved).
- Source structure shows continued evolution toward small focused modules.

*Recheck complete. Hygiene clean. Tests green. Clear improvement since the v2 intermediate state.*

**File:** This report uses a distinct name (`docs/fleet-analysis-30-agents-2026-07-11-recheck.md`) per request for side-by-side tracking.


