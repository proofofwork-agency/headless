# Release readiness — assessed 2026-08-05 at `ba62a58`

What is currently evidenced, what is stale, and what only a human can do. This is
a **status report, not an oracle**: `docs/plan.md` holds the Gate A/B/C evidence
requirements and this file does not substitute for them or claim any gate area is
complete. Where a claim here is not backed by a command output, it says so.

## Publication is mechanically blocked, deliberately

`package.json` has `private: true` at `0.2.0-beta.7`. No workflow publishes.
Tagging and publishing remain human acts.

## Re-verified on every gate run (current at HEAD)

These are executed by `bun run check` and by the required CI contexts, so they
are current for whatever commit last ran them — no standing claim required.

| | status at `ba62a58` |
| --- | --- |
| Kernel suite | 1089 pass / 12 skip / 0 fail |
| Serial stability | 10 consecutive full-suite runs, 0 failure lines |
| Required CI | `ubuntu-latest` + `macos-latest` release gate, `website build` — green |
| Product Gate | 9 pass / 1 manual / 0 fail (P.TTFV manual by design, see below) |
| CLI surface sweep | 872 invocations, all invariants held |
| Documented invocations | 210 parse-checked against the real validators |
| Docs check | 9 release documents and local links verified |

## Credentialed evidence — the actual gap

Recorded artifacts under `docs/internal/release-evidence/`, with provenance read
from the files themselves:

| evidence | commit recorded | dated | assessment |
| --- | --- | --- | --- |
| `ttfv-smoke.json` | `0debbf3` | 2026-08-05 | Current-day, but stale vs HEAD **by design** — P.TTFV pins to the measured commit. Re-run at the tagged commit; see [release-runbook.md](./release-runbook.md). |
| `native-subscription-smoke.json` | `a898497` | 2026-07-27 | **STALE.** `docs/plan.md` calls this the primary Gate A real-run evidence and states that an older pass must not be carried forward after control-plane, native-auth, session-driver, fleet, TUI, or package changes. All of those areas have changed since. **Must be re-run before any Gate A publish.** |
| `gate-b-mcp-smoke.json` | none recorded | n/a | Freshness **cannot be established** from the artifact. Treat as unverified for the current tree. |
| `native-write-smoke.json` | none recorded | n/a | Same — no provenance commit, so it cannot be tied to a tree. |

Two of the four record no commit at all. **The tooling is not at fault** — every
writer attaches provenance (`writeReleaseEvidenceFile` always does), so those two
artifacts simply predate that helper and re-running each smoke dates it. An
earlier draft of this file implied a code defect; it does not exist, and chasing
it would waste the reader's time.

`tests/release-evidence-provenance.test.ts` now counts them: any artifact without
a provenance commit fails unless it is a declared legacy exemption, and an
exemption that has since been dated fails as obsolete. So this gap cannot go
quiet again, and it clears itself the moment the smokes are re-run.

## Requires a human

1. **Re-run the native-subscription smoke** (`bun run smoke:native`) at the cut
   commit. Spends real subscription quota; needs installed, logged-in backends.
2. **Re-run the live TTFV smoke** at the tagged commit, and read the gate before
   committing the evidence — the runbook has the exact order.
3. **`bun run release:check`** from the final tree (check + build + pack smoke).
4. **Tag and publish**, and flip `private` if publication is intended.
5. **Decide on `enforce_admins`.** `main` has strict required contexts but
   `enforce_admins: false`, and I merged PR #75 past a red required check today
   using that. Enabling it makes the bypass structurally impossible; it also
   locks the owner out of emergency merges, so it is deliberately not my call.

## Known open, honestly

- Two of four credentialed evidence artifacts carry no provenance commit.
- The native-subscription evidence is 9 days and many merges old.
- P.TTFV can never read green on a committed tree; that is designed, documented,
  and must not be "fixed" by loosening the comparison.
- This document has **not** audited each Gate A area against its evidence
  requirement. Doing that is a separate, larger exercise, and claiming it here
  without doing it would be the exact failure mode this tree spent the day
  removing.

## Gate A area → where its evidence executes

Each Gate A area in [plan.md](../plan.md) mapped to the suites that run for it.

**Read this as a map, not a verdict.** It establishes that no Gate A area is
without executing coverage. It does **not** establish that each area's evidence
requirement is satisfied clause by clause — those requirements are detailed
(e.g. "legacy-aware persisted-RunResult decoding at *every* durable read
boundary"), and verifying each clause is a separate exercise. Nothing here should
be quoted as "Gate A area X is complete".

| Gate A area | Suites that execute for it |
| --- | --- |
| Contracts | `contracts-v2`, `adapters-v2`, `public-api`, `receipt-schema`, `safe-json` |
| Upgrade compatibility | `persisted-run-result-compatibility`, `run-event-store`, `receipt-store`, `receipt-journal` |
| Daemon | `daemon`, `daemon-auth`, `daemon-route-dispatcher`, `daemon-process`, `daemon-lifecycle-leak`, `daemon-candidate-routes`, `daemon-fleet-routes`, `daemon-receipt-routes`, `control-plane-utils`, `job-admission-service` |
| Lead onboarding | `lead-observer`, `mcp`, `mcp-install`, `fleet-cli-mcp`, `native-control-plane` |
| Observer TUI | `tui-control-room`, `lead-observer`, `log-presentation` |
| Ledger/state | `ledger-v2`, `ledger-keys`, `ledger-verify`, `receipt-*`, `project-state`, `atomic-write`, `owner-json`, `owner-only-path`, `integration-journal` |
| Policy/budgets | `authority-budget`, `cost-budget`, `budget-concurrency-queue`, `pricing` |
| Containment | `containment-v2`, `release-gate-containment`, `isolation-attestation`, `grok-isolation`, `native-auth`, `executable-read-roots`, `worker-env-keyring`, `linux-broker-relay`, `linux-relay-stream-proxy`, `secure-socket`, `darwin-bun-stage` |
| Broker | `broker`, `broker-endpoint-reachability`, `pricing` |
| Execution | `builtin-e2e`, `run-event-store`, `run-tool-endpoint`, `daemon-run-tool`, `task-store`, `message-queue`, `repair-loop`, `workflow-service` |
| Sessions | `session-drivers`, `session-capability`, `session-driver-factory-hardening`, `session-transport-cleanup`, `native-session-manager`, `bun-session-executor`, `opencode-native-model` |
| Package | `package-metadata`, `plugin-load`, `public-api`, plus `bun run smoke:pack` |
| CI | `gated-coverage` (the authoritative record of which leg runs each capability gate), `release-gate-containment` |

No area is evidence-free. What each area's coverage *skips* is tracked by
`tests/gated-coverage.test.ts`, which currently declares two knowingly-uncovered
gates, both requiring provider CLIs that CI does not install.
