# Fleet Analysis: 30-Agent Code Review — v6 Recheck (2026-07-11)

**Date:** 2026-07-11 (sixth iteration)
**Scope:** Headless package, latest delta vs prior v1-v5 reports
**Method:**
- Output from latest background task (tail of full check log + scoped commands).
- Confirmation of full `bun run check` results (from completed task).
- Hygiene quick runs.
- Scoped `bun test tests` summary.
- Comparison for improvement/regression.
- Note on unscoped vs scoped.

Different file: v6.md

---

## Latest Results (from just-completed tasks)

**From full check log tail (background task call-4ad4eb2c...):**
```
 511 pass
 10 skip
 0 fail
 11037 expect() calls
Ran 521 tests across 66 files. [114.51s]
```

Hygiene in that run: typecheck, lint (244 files), format, docs-check all passed before tests.

**Fresh scoped verification (recent command):**
- Hygiene:
  - typecheck: clean
  - lint: passed (246 files)
  - format:check: passed (after cleaning reports)
  - docs-check: passed
- Scoped tests (`bun test tests`):
  - 511 pass
  - 10 skip
  - **0 fail**

**Unscoped `bun test` (from previous reminders):**
- ~1153 pass, 10 skip, ~567 fail
- Fails from vendored opencode/ (UI tests, DOM, i18n, etc.) — irrelevant to this package.

**Key daemon/workflow tests (from check logs):**
Many explicit (pass) for previously concerning areas:
- authenticated project daemon > runs typed council phases over actual candidate and review outputs
- write councils preserve candidates until after attributable review and vote
- write councils cannot substitute candidate preservation for a failed test gate
- an even council requires a strict majority and never approves a tie
- coordinator write jobs pass gates, commit, and fast-forward primary
- ... and many more grant, worktree, ledger, workflow resume tests.

All green in the full run.

---

## Delta: Improvement or Regression?

**Vs v5 and recent rechecks:**
- Identical: 511 pass / 10 skip / 0 fail scoped.
- Hygiene: lint files up to 246/247/248; format now consistently passing on reports after fixes.
- **Stable / no regression.** Full checks confirm clean state repeatedly.

**Vs v2 (failing state snapshot):**
- **Improvement.** The ~17 fails in council, workflow, grant, write paths are resolved. Logs now show explicit passes for those exact tests.
- The state has stabilized to 0 failures in scoped/project tests.

**Vs original:**
- Positive: refactoring validated (tests pass post-extraction), hygiene strong, test volume high, new features covered without breakage.
- No regressions in core (containment, ledger, etc.).

**Overall:**
The project's scoped validation is consistently clean with 0 failures across multiple full check runs. The unscoped noise is vendored and expected. Improvement from the intermediate failing state; stable good health now. No new issues or regressions in headless code.

---

## Summary

- Project tests (`bun test tests`): **511 pass, 0 fail** — clean.
- Hygiene: passes (lint/format/docs).
- Orchestrator layer (previously flagged): now passing in logs.
- Unscoped `bun test`: high fails from opencode/ vendored — ignore for this analysis.
- Net: **Improvement/stabilization**. Full checks green. Ready state.

*Re-run (v6) complete using latest task outputs and verifications. Scoped: clean. Hygiene: good. No regression; improvement vs v2 noted fails.*

**File:** docs/fleet-analysis-30-agents-v6.md (new distinct name).
