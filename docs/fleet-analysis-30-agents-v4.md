# Fleet Analysis: 30-Agent Code Review — v4 Recheck (2026-07-11)

**Date:** 2026-07-11 (fourth iteration)
**Scope:** Headless current state, delta from previous reports (v1, v2, v3/recheck)
**Method:**
- Review of just-completed background tasks:
  - Full `bun run check` (exit 0, scoped `bun test tests`): 511 pass, 10 skip, **0 fail**.
  - Raw `bun test` (unscoped): showed failures, but these are from vendored `opencode/` UI/frontend tests (not part of the @proofofwork-agency/headless package).
- Cross-check against prior reports.
- Hygiene commands confirmation.
- Focus on improvement/regression in project-relevant metrics.

Different filename: `docs/fleet-analysis-30-agents-v4.md`

---

## Current Verification Status

**Authoritative for this project (`bun run check` / `bun test tests`):**
- 511 pass
- 10 skip
- **0 fail**
- Full hygiene gates passed (typecheck, lint 244 files, format, docs-check).
- **Result: Clean / Green**

**Unscoped `bun test` (the background task just completed):**
- 1152 pass
- 10 skip
- 568 fail
- 539 errors
- These failures are almost entirely from the vendored `opencode/` directory (Solid/TSX UI components, titlebar gestures, prompt-input editor DOM, i18n parity, notification handling, etc.).
- **Not relevant** to evaluating the headless package itself. The package's own tests live under `tests/` and are exercised via `bun test tests` or the check script.

---

## Delta Analysis (Improvement or Regression)

### Since v3 / latest recheck
- No change in headline numbers: still 0 failures in scoped tests.
- State is **stable and clean**.
- No regressions introduced in the short time between runs.
- The full check that just completed confirms the positive result from the previous recheck.

### Since v2 (the report that highlighted ~17 orchestrator failures)
- **Major improvement**: The failures in council, workflow, grant, and write-integration paths under required containment have been resolved.
- Current scoped test run: 0 fail (vs. 15-17 noted in v2).
- Hygiene consistently green.
- Test execution volume high and stable.

### Since original analysis
- Structural improvements (daemon refactoring, service extraction, reduced duplication) have held and are now backed by passing tests.
- Containment, ledger, redaction, session, MCP surfaces remain solid.
- Added test coverage in new areas (goals, fleets, native sessions, etc.) without breaking core.
- Overall: net positive evolution. The project has moved through a development phase with temporary test fragility (during heavy internal refactors + sandbox tightening) to a clean, passing state.

---

## Key Observations

- **Scoped vs Unscoped distinction is important**: Always use `bun test tests` or the project's check script for validation of this package. Raw `bun test` at repo root pulls in the entire vendored opencode monorepo tests, which are separate and have their own setup requirements (browser-like environment for UI tests).
- No evidence of new code issues in headless sources.
- The 0-fail result in the just-completed full check is the strongest signal yet that the orchestrator layer is functioning correctly in the current codebase.
- Hygiene metrics are holding steady or slightly expanding (file counts in lint/format).

---

## Updated Verdict

- Hygiene: Excellent (consistent across all iterations).
- Relevant tests (headless package): **Currently passing with 0 failures**.
- Compared to the state captured in v2: **Improvement** (previous test regressions resolved).
- Compared to immediate prior recheck: **Stable** (no regression).
- The architectural work (refactoring, better modularity, containment hardening) appears to have landed successfully.
- Project remains well-positioned as the "universal safe headless runner + orchestrator".

---

## Recommendations

- For future "run it again" checks, always emphasize scoped test commands (`bun test tests`) + full `bun run check` to avoid noise from vendored code.
- If a raw `bun test` is ever needed for the whole tree, it should be interpreted with the context that opencode/ tests are separate.
- Continue to monitor after any changes to daemon services, sandbox, or test fixtures.
- The current state is a good baseline.

---

**File note**: This is v4 with a distinct name. Previous versions (including the 2026-07-11-recheck and v3) remain for historical comparison.

*Analysis re-run complete. Scoped results: clean (0 failures). Unscoped noise from vendored code should be disregarded for this package.*

