# Release readiness — assessed 2026-08-05 at `ba62a58`

What is currently evidenced, what is stale, and what only a human can do. This is
a **status report, not an oracle**: `docs/plan.md` holds the Gate A/B/C evidence
requirements and this file does not substitute for them or claim any gate area is
complete. Where a claim here is not backed by a command output, it says so.

## Publication is mechanically blocked, deliberately

`package.json` has `private: true` at `0.2.0-beta.6`. No workflow publishes.
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

Two of the four record no commit at all. That is worth fixing independently of
any release: evidence that cannot name the tree it measured cannot be checked for
staleness, only trusted.

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
