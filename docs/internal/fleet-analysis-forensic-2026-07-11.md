# Fleet-analysis forensic record — 2026-07-11

Status: internal historical evidence. This is not release documentation and its
test observations must not be treated as current.

## Scope

This record consolidates the original 30-agent comparison and nine same-day
rechecks that previously lived as ten maintained documents. The archival WIP
snapshot preserves the verbatim source reports. This file retains the useful
chronology, conclusions, and cautions without presenting stale counts as a
release claim.

The reviews compared Headless and ContextRelay, inspected execution,
containment, daemon, ledger, orchestration, and collaboration code, and reran
selected hygiene and test commands during a period of heavy refactoring.

## Chronology

| Report | Observation at that point in time |
| --- | --- |
| Original | Headless had the stronger execution/security architecture; ContextRelay had the more mature collaboration/operator experience. Large classes, duplicated policy, silent failure paths, and release immaturity were the main risks. |
| v2 delta | Service extraction and hygiene improved, but orchestration tests regressed during the refactor. The verdict was mixed, leaning positive in fundamentals. |
| first recheck | The then-current check completed successfully; earlier orchestration failures were no longer reproduced. |
| v3 | Confirmed the v2 failures were transient and reported no new regression. |
| v4 | Reconfirmed a net-positive transition from broad internal refactoring to a clean scoped validation run. |
| v5 | Repeated scoped checks remained clean. |
| v6 | Repeated the same conclusion with no material new evidence. |
| v7 | Repeated the same conclusion with no material new evidence. |
| v8 | Repeated the same conclusion with no material new evidence. |
| v9 | Repeated the same conclusion; noted that report proliferation itself was creating formatting noise. |

## Durable findings

- The project’s most valuable core was the contained execution boundary:
  isolated worker state, explicit sandbox evidence, structured outcomes, and
  accounting tied to durable jobs.
- ContextRelay compatibility was useful for ledger/worktree collaboration, but
  orchestration breadth should not enlarge the execution security boundary.
- Backend-specific policy duplication and large daemon/runner classes were the
  clearest architectural debt.
- Secure defaults needed to be truthful at every public surface: brokered
  credentials, explicit native-direct consent, bounded streams, redaction, and
  fail-closed unsupported versions.
- Passing local tests were never sufficient publication evidence. Packaging,
  both supported operating systems, installed backend versions, protected
  provider smoke, clean commits, and external-user installation remained
  separate gates.

## Superseding Beta 1 interpretation

The Beta 1 recovery work supersedes the reports’ optimistic readiness language.
The reports sampled a moving private-alpha workspace and did not prove a clean,
committed release tree. Current release decisions must use the release gate and
fresh CI/registry evidence, never a count or verdict copied from these reviews.

The actionable interpretation is therefore:

1. Keep one stable one-shot execution contract.
2. Centralize backend metadata and supervised containment.
3. Isolate sessions, orchestration, MCP/plugin extensions, skills, fleets, TUI,
   and autonomy behind experimental surfaces.
4. Treat security, durability, accounting, package installation, and
   cross-platform evidence as blocking gates.

## Provenance

Consolidated sources:

- `fleet-analysis-30-agents.md`
- `fleet-analysis-30-agents-v2.md` through `fleet-analysis-30-agents-v9.md`
- `fleet-analysis-30-agents-2026-07-11-recheck.md`

The verbatim files remain recoverable from the archival WIP snapshot created
before release-branch reconstruction. They are intentionally not maintained as
parallel documentation.
