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
| P.TTFV | Time-to-first-value | Cold golden path ≤ 5 min (manual dogfood); warm setup→status ≤ 90 s automated where possible |
| P.STEPS | Ceremony step count | ≤ 4 operator decisions for first read-only native exec after CLIs are installed: `setup` → trust grant → `exec --profile read-only-native` → optional `verify` |
| P.HELP | Default help | ≤ 12 primary command lines; experimental only under `headless experimental --help` |
| P.REMEDY | Error remedies | Top failure codes include copy-pasteable next command (see `src/cli/remedy.ts`) |
| P.AHA | Artifact-first | Successful non-JSON `exec` prints job id + verify/receipt one-liners when `jobId` is present |
| P.GOLDEN | Golden path contract | `setup` / profile / help / remedy unit tests green |
| P.SCOPE | Surface freeze | Stable set is only `STABLE_COMMAND_NAMES` in `command-specs.ts` |
| P.DOCS | One-path docs | README + quickstart lead with one golden path |
| P.TUI | Observer clarity | Overview `nextActions` answers trust / lead / native consent / first exec |
| P.KERNEL | Safety non-regression | `bun run check` green; no new unsafe defaults |

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
| P.TTFV | green | Live evidence: `ttfv-smoke.json` (~6s setup→trust→exec→verify on this host); re-run `bun run smoke:ttfv:live` after UX changes |
| P.STEPS | green | Golden path is setup → trust grant → `exec --profile` → verify (≤ 4); product-gate + tests lock it |
| P.HELP | green | 11 stable commands + golden-path banner |
| P.REMEDY | green | `src/cli/remedy.ts` covers 12 codes; CLI prints Next: lines |
| P.AHA | green | `printRunResult` emits verify + receipt when `jobId` present |
| P.GOLDEN | green | `setup`, profiles, product-gate script + unit tests |
| P.SCOPE | green | `setup` added with Product Gate note in AGENTS.md |
| P.DOCS | green | README + website quickstart one path |
| P.TUI | green | Authority ladder + native consent + first-exec |
| P.KERNEL | green | `check:product` wired into `bun run check` |

Publish remains a **human** decision separate from Product Gate P.

## Automation

Run:

```bash
bun scripts/product-gate.ts
```

Emits a machine-readable summary. Failing automated checks exit non-zero. Manual dogfood items are reported as `manual` when not evaluated.

## Loop protocol

```text
measure Product Gate P → compile failing checks → fix in parallel/serial
→ contrast verify (tests + dogfood) → re-measure → ship or stagnate escalate
```

Stagnation: identical failure signature after two full loops without metric movement → replan OST, do not thrash.
