# Product Gate P

Product quality oracle for Headless weak-point closure. **Not** a substitute for security Gate A/B/C in `docs/plan.md`. A green Product Gate means the golden path and progressive disclosure are acceptable; it does not authorize npm publication or weakening containment.

## Rules

1. The gate is the oracle. Claims of “UX improved” without a green (or improved) gate are insufficient.
2. Kernel safety never regresses: `bun run check` / containment tests remain required (`P.KERNEL`).
3. Intentional friction stays on irreversible axes (native egress trust, write/merge). Defaults remain required containment and broker.
4. New **stable** public commands require Product Gate owner acknowledgement and an outcome link in this document or `docs/product-ost.md`.

## Checks

| ID | Metric | Pass criterion |
| --- | --- | --- |
| P.TTFV | Time-to-first-value | Current-commit live golden path ≤ 5 min with exact model output, required containment, setup→doctor→exec→verify steps, and strict provenance; warm ceremony is advisory |
| P.STEPS | Ceremony step count | ≤ 4 operator decisions for first read-only native exec after CLIs are installed: `setup` → trust grant → `exec --profile read-only-native` → optional `verify` |
| P.HELP | Default help | ≤ 12 primary command lines; experimental only under `headless experimental --help` |
| P.REMEDY | Error remedies | Top failure codes include copy-pasteable next command (see `src/cli/remedy.ts`) |
| P.AHA | Artifact-first | Successful non-JSON `exec` prints job id + verify/receipt one-liners when `jobId` is present |
| P.GOLDEN | Golden path contract | `setup` / profile / help / remedy unit tests green |
| P.SCOPE | Surface freeze | Stable set is only `STABLE_COMMAND_NAMES` in `command-specs.ts` |
| P.DOCS | One-path docs | README + quickstart lead with one golden path |
| P.TUI | Observer clarity | Overview `nextActions` answers trust / lead / native consent / first exec |
| P.KERNEL | Safety non-regression | Outer `bun run check` green; Product Gate cannot self-certify this from script existence |

## Baseline (Loop 0 — 2026-07-30)

| Check | Status | Evidence |
| --- | --- | --- |
| P.TTFV | red | Quickstart required init + per-CLI login + trust grant + multi-flag exec; cold path multi-minute and multi-decision |
| P.STEPS | red | ~5–7 decisions before first native run |
| P.HELP | green | Default help lists 10 stable commands (≤ 12) |
| P.REMEDY | yellow | Fleet/TUI presentation had recovery strings; CLI errors incomplete |
| P.AHA | red | `printRunResult` printed output/cost only |
| P.GOLDEN | red | No `setup` / profile / product-gate script |
| P.SCOPE | green | `STABLE_COMMAND_NAMES` already enforces beta surface |
| P.DOCS | red | Quickstart multi-path; advanced interleaved |
| P.TUI | yellow | Next actions partial (lead/trust) missing native-consent + first-exec |
| P.KERNEL | green | Release gate tests present |

## After improvement loops (2026-07-30)

| Check | Status | Evidence |
| --- | --- | --- |
| P.TTFV | pass at the measured commit | Live run 2026-08-05 at `0debbf3`: 5465ms against a 300000ms budget, `exec` and `verify` both exit 0, strict provenance recorded (claude-code 2.1.222, codex-cli 0.146.0, opencode 1.18.13, grok 0.2.118). Product gate read **10 pass / 0 manual / 0 fail** at that commit. See the pinning note below for why it does not stay green. |
| P.STEPS | green | Golden path is setup → trust grant → `exec --profile` → verify (≤ 4); product-gate + tests lock it |
| P.HELP | green | 11 stable commands + golden-path banner |
| P.REMEDY | green | `src/cli/remedy.ts` covers 12 codes; CLI prints Next: lines |
| P.AHA | green | `printRunResult` emits verify + receipt when `jobId` present |
| P.GOLDEN | green | `setup`, profiles, product-gate script + unit tests |
| P.SCOPE | green | `setup` added with Product Gate note in AGENTS.md |
| P.DOCS | green | README + website quickstart one path |
| P.TUI | green | Authority ladder + native consent + first-exec |
| P.KERNEL | green when outer gate passes | `bun run check` runs daemon hygiene, static/docs checks, and all tests before invoking Product Gate with kernel verification. Standalone `check:product` reports this item as manual. |

Publish remains a **human** decision separate from Product Gate P.

## Automation

Run:

```bash
bun scripts/product-gate.ts
```

Emits a machine-readable summary. Failing automated checks exit non-zero. Manual dogfood items are reported as `manual` when not evaluated. Run `bun run check` for the aggregate gate; the standalone Product Gate deliberately cannot claim that its caller already ran the kernel suite.

## Loop protocol

```text
measure Product Gate P → compile failing checks → fix in parallel/serial
→ contrast verify (tests + dogfood) → re-measure → ship or stagnate escalate
```

Stagnation: identical failure signature after two full loops without metric movement → replan OST, do not thrash.

## Dogfood posture

Product Gate P dogfood is **partial and deliberate** — not continuous self-host of Headless development.

**In scope for dogfood / contrast verify**

- Recorded cross-backend deliberate and council paths with real native subscription sessions
- Native-subscription smokes on the platform-aware required set
- Neon Breakout and rotating-lead write paths (orchestration + gated candidate kernels)
- Product Gate contrast verify: automated checks plus manual golden-path dogfood

**Out of scope — do not claim**

- Continuous self-host of day-to-day Headless monorepo development
- Unattended production operation
- That Headless fully builds this monorepo as routine practice

Case studies and Gate B/C evidence dogfood orchestration and write **kernels**, not full product bootstrap. Private beta remains unpublished (`0.2.0-beta.7`); a green Product Gate does not publish the package.

### Product Gate loops vs runtime repair loops

These are different systems. Do not treat one as proof of the other.

| | Product Gate P “loop protocol” | Runtime `experimental loop --repair` |
| --- | --- | --- |
| Owner | Human / release process | Headless runtime automation |
| Oracle | This document’s checks (`P.*`) + manual dogfood | Named project gate report against a candidate worktree |
| Purpose | UX / golden-path quality until ship or replan | Automated repair of a failing gate within containment and policy |
| Claims | Teachable setup → trust → profile exec → verify | Structured repair attempts under required containment |

Contrast verify in the Product Gate protocol means re-running tests and manual dogfood after changes. It is not the same mechanism as a runtime repair graph driven by `experimental loop --repair`.

## P.TTFV is commit-pinned — read this before a release

`scripts/product-gate.ts` passes P.TTFV only when
`docs/internal/release-evidence/ttfv-smoke.json` has `mode: "live"` **and**
`provenance.commit` equals `git rev-parse HEAD`.

The evidence file is tracked, so **committing it moves HEAD past the commit it
names and P.TTFV immediately reverts to `manual — "Live evidence is stale"`**.
There is no committed state in which P.TTFV is green. That is intended: live
evidence only describes the tree it measured. It is not a defect, and it is not
something to "fix" by loosening the comparison.

Consequences, in order:

1. **Settle HEAD first.** Land every other change, then run the live smoke.
   Running it earlier is wasted the moment anything else merges.
2. **10 pass / 0 manual is only observable in the working tree at the measured
   commit.** The committed JSON is a durable record, not a standing pass, and CI
   will always report P.TTFV as `manual` for this reason.
3. **At release, re-run `bun run smoke:ttfv:live` at the exact commit being
   tagged, and read the gate before committing the evidence.** A tag whose
   evidence names an earlier commit has not been validated.

The smoke performs a real read-only provider exec against the operator's native
logins and therefore spends their quota. It requires explicit human
authorization each time; it is never run unattended.

Measured 2026-08-05: 10 pass / 0 manual / 0 fail at `0debbf3`, then 9 pass /
1 manual at `8fd3dc1` — the only difference being the commit that stored the
evidence. Nothing regressed between those two states.
