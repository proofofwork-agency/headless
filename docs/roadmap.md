# Roadmap — finishing the foreground lead

Open work, in the order it should be done. Phase 1 shipped in `0.2.0-beta.8`; phases 2–7
are not started.

## What this is

Headless is meant to be steerable from **one external harness** — "it wouldn't matter what
harness, but that harness would take the lead." That is the **foreground lead**: an
externally launched coding CLI (codex, claude, opencode, grok, or in principle any
MCP-capable harness) attaches over MCP stdio and steers the project, while the daemon owns
orchestration, containment and the ledger.

It is far more built than it looks. The binding is a real auth primitive enforced per
request, there are 28 MCP tools with a deliberate core/full split, installers for four
hosts, and live Gate B evidence of a Codex lead fanning out to three backends and surviving
a daemon restart.

## Why it drifted — the thing to keep in mind

**Nothing in the product's UX oracle ever measured it.** Product Gate P's live oracle is
hard-coded to `setup`/`doctor`/`exec`/`verify` (`scripts/product-gate.ts`), and
`docs/product-ost.md` contains zero occurrences of "lead". So the CLI funnel got measured
and polished while the lead funnel accumulated promise-breaking defects, and its deepest
document (`docs/mcp-integration.md`) ended up linked from zero markdown files in the repo.

Phase 6 exists to close that hole permanently. Until it lands, every other phase here is
protected only by tests someone remembered to write.

## Decisions already taken

1. **Positioning — co-equal second funnel.** The quickstart forks into "drive it yourself
   (CLI)" and "let your coding CLI drive it (lead)". `P.TTFV` is left untouched so committed
   TTFV evidence stays valid; a new `P.LEAD` measures the lead funnel.
2. **Rotation — successor inherits control.** Authorship is immutable in the ledger; control
   — reading context, cancelling prior jobs, draining the prior inbox — transfers to the
   successor. `--no-inherit` opts out.
3. **Scope — everything**: the remaining defects, async run control and verification over
   MCP, generic any-harness support, `P.LEAD` wired into `bun run check`, and the docs
   promotion.

## Phase 1 — done (`0.2.0-beta.8`)

Re-attach after an idle lapse, project-root resolution, MCP startup ordering, precise denial
classification, real shutdown hooks, strict selected-state reads. See the CHANGELOG entry.

---

## Phase 2 — the lead can talk to its workers

The queue is keyed `(principal, chat_id)` with **no recipient dimension**. `to` is accepted
by `messages.push` but recorded only in the ledger event, never in the queue row. So
switching `send_message` from `ledger.event` to `messages.push` is necessary but **not
sufficient**: lead and worker would share one undrained bucket and drain each other's mail,
whoever polls first.

Add a `recipient` column. Three corrections that a naive migration gets wrong, each of which
fails silently:

1. **Do not default to `''`.** Legacy rows would match neither `lead` nor `worker` —
   undrained forever, invisible to *both* sides. Backfill to **`'lead'`**: the only path that
   ever queued was worker→lead, so it is both historically correct and conservative.
   Use **one atomic statement** — `ALTER TABLE messages ADD COLUMN recipient TEXT NOT NULL
   DEFAULT 'lead'`. SQLite applies that default to every existing row as part of the atomic
   schema change. **Never** add-nullable-then-`UPDATE`: each statement autocommits
   separately, so a crash between them leaves half the mail backfilled and the rest invisible.
2. **The existing index is not partial.** It is a plain composite index whose *name* says
   "pending". Editing its column list under the same `CREATE INDEX IF NOT EXISTS` name
   **silently does not migrate an existing database**. Use a new name
   (`messages_pending_v2`, partial on `drained_at IS NULL`) and `DROP` the old one explicitly.
3. **Recipient must thread through all nine role-sensitive statements**, not just the list
   query: enqueue, both count calls, the eviction SELECT, the INSERT, the list SELECT,
   `countUndrained`, `markDrained`, `markPushed`. Miss one and a recipient can drain, mark,
   count against or **evict** the other's mail — eviction being worst, since it deletes.

Also: `getCooperationInstructions` needs a `role` parameter. The current text tells its
reader to use three tools that are outside the core toolset, so a core-toolset lead
following its own onboarding contract hits three consecutive errors in its first minute.

Order the migration ADD → CREATE v2 → DROP v1, so every intermediate state stays usable and
the next open completes it.

## Phase 3 — the lead can steer

`headless_run` blocks on `run.wait`, and most MCP harnesses time out long before a long job
returns. There is no status, cancel, events, receipt or ledger-verify tool — every one of
which is already inside the lead's scopes and live as a daemon route. **`P.LEAD`'s oracle,
"drives a job to a verified receipt", is literally inexpressible over MCP today.**

Raise the core toolset cap from 10 to 12 and add two action-dispatch tools: one owning
status/cancel/wait/events, one owning receipt/ledger verification. Drop the worker-shaped
task-state tool; promote the artifact-recording tool, which the Gate B smoke already uses.
Add a `detach` mode to the run tool.

Replace the prose cap with a constant plus a module-load assertion, and a rationale map whose
keys must equal the core set exactly — so no tool slips in unjustified and no removal leaves
a stale entry. Resolve the toolset **once at startup**: today a typo'd env value throws from
inside the list-tools handler and breaks discovery entirely.

The `experimental` namespace is a human-surface budget (it keeps default help under P.HELP's
12-line cap), not a capability gate. Make that intentional: add a declarative `stability`
field to the route table, enforce nothing, and test that every experimental-stability route
reachable under the full toolset is listed in the toolset doc.

## Phase 4 — rotation is a handoff

Today a successor lead sees none of its predecessor's context, cannot cancel its still-running
jobs, and undrained worker→lead messages become permanently unreadable. The docs claim state
"remains intact" — it does, on disk, but invisibly, which is a lie by omission.

Split what `principal` conflates:

- **Authorship** (ledger source, receipt principal, council principal) stays with the
  generation that produced it, never rewritten. That is the tamper-evident record.
- **Control** transfers. The binding gains a bounded `lineage` array, surfaced as
  `inheritedPrincipals` on the per-request credential at the existing authorization choke
  point, with a `principalOwns()` helper replacing raw `===` comparisons at every
  resource-ownership gate.

Constraints that are not obvious:

- **`release` clears transferable lineage.** `use`-over-`use` is a direct handoff and
  inherits; release is an authority boundary, so a lead configured *after* a release must not
  silently acquire historical principals. History still lives in the immutable handoff
  artifacts.
- **Truncation must be visible.** At the 16-entry bound, silently dropping the oldest
  principals re-breaks the same promise. Report lineage depth and whether truncation occurred.
- **The authorization snapshot is deliberate.** A request authenticated as g1 that is already
  in flight when g2 is installed must still complete. `assertCurrent` rejects *newly
  authenticated* requests from a retired credential; it cannot erase one already dispatched.
  The killing mutation is re-running `assertCurrent` after the awaited handler.
- **No queue rewrite.** An earlier design reassigned undrained rows from g1 to g2. That
  breaks running workers: a worker's run-tool scope principal is fixed for the life of its
  job, and it both enqueues and pulls under that exact principal. Rewriting would hide
  pre-rotation mail from the worker it was addressed to, strand anything that worker sends
  *after* the rewrite, and fail to deliver new lead→old-worker mail. Instead the queue
  principal becomes the **mailbox owner** and is never rewritten: the lead reads across
  `[current, ...inherited]`, a worker reads under its own immutable principal, and the lead
  addresses an old session by that session's owner. This removes the last mutable-state
  rewrite from the design.

Not an escalation path: lead rotation requires admin scope, all generations carry identical
scopes, lineage holds only prior lead principals bounded at 16, it is attached only *after*
`assertCurrent` succeeds and consulted only by ownership predicates *after* the ordinary
route-scope checks, and the owner explicitly performed the rotation.

## Phase 5 — any harness

Make `config` an **action on the existing `mcp` command**, not a new top-level command —
`STABLE_COMMAND_NAMES` holds exactly 11 names against P.HELP's cap of 12, and **that last
slot must not be spent here**. It emits the generic stdio JSON any MCP host accepts, with
alternate formats for TOML-style and shell consumers.

The server command must carry `env` (project root and lead host), and all four installers
must emit it. **Do not bet on guessing each host CLI's env flag** — keep the automated
attempt, but make the printed fallback authoritative and byte-identical to the emitted
config, so a wrong flag degrades to "here is the config, paste it."

Real `remove` and `status` for all four hosts: today the OpenCode installer writes a global
config file that its own `remove` cannot undo. And `doctor` must report lead state — the CLI
currently promises "see attach status via lead status / doctor" while doctor never looks.

## Phase 6 — `P.LEAD`

**Oracle:** after a one-time lead setup, an external MCP client drives a job to a verified
receipt with **zero CLI invocations after attach**.

The one-time CLI step is not a weakening: lead setup requires admin scope, and an unattached
MCP client bootstrapping its own credential would be the security hole. The gate measures
`cliInvocationsAfterAttach === 0`, which is the honest, strictly measurable form.

**It runs unattended, inside `bun run check`.** This is the important call. Gate B is
credentialed and commit-pinned, so it reads manual/stale by design; a `P.LEAD` built that way
would be a check that never runs red. Instead reuse the **stub backend binaries already
installed on PATH** by the builtin e2e tests. The harness is a real MCP client over a real
stdio transport against the real server — only the *backends* are deterministic substitutes.
`P.LEAD` measures product shape; Gate B keeps measuring real providers.

What keeps it from going decorative: a **per-run nonce** the stub must echo exactly, evidence
the backend process actually executed (not merely that the daemon reported success),
cryptographic receipt *and* ledger verification, a fresh fixture per run, strictly serial
execution, and an **assertion counter** — `assertionsExecuted === EXPECTED_LEAD_ASSERTIONS`.
Without that last row an early return reports "0 fail".

`P.TTFV` stays untouched; `P.STEPS` gains a lead clause.

## Phase 7 — docs and promotion

Fork the quickstart at the top into the two funnels and delete the anti-orchestration steer.
Give the website a real lead-harness guide (today `docs/mcp-integration.md` is linked from
**zero** repo markdown files). Register it in the sidebar — broken links are fatal.

The assertions that make it permanent, in `docs-check`:

1. README matches the install command **and** links the integration doc.
2. Quickstart matches both the lead-setup and MCP-install commands.
3. The new guide exists and names the project-root env var and the server binary.
4. `docs/mcp-integration.md` is referenced by ≥1 other repo markdown file — a real graph
   assertion, not a self-match.
5. **Highest value:** import the core tool-name constant and assert the guide's tool table
   lists **exactly** that set. Change the core set without touching docs → red. Add a fake
   row → red. Rename a tool → red. This check has no hardcoded copy of the truth, so it
   cannot rot.

**Ordering constraint:** every `headless …` line in every `.md`/`.mdx` in the repo is
validated against the real CLI validators, and an unrecognized command **fails the suite**.
So Phase 5's new action must exist *before* any doc shows it. Docs merge after Phase 5, never
with it.

---

## Sequencing

Phases 2 and 3 can run alongside each other. Phase 4 overlaps only in disjoint regions of the
daemon server. Phase 5 depends on 1 (root resolution) and 3 (core list). Phase 6 depends on
1–4 and lands last of the code phases, because its whole value is seeing every fix at once.
Phase 7 can be drafted early but cannot merge until 5 and 3 are in.

## Known gaps carried forward

- **No test for an inaccessible parent directory** in the owner-only absence path. It could
  not be built as a reliable non-root case on macOS, and a flaky or vacuous test would be
  worse than an honest gap.
- **Six stores bypass the new absence oracle** — workflow-draft, project-trust, goal,
  skill-registry, persistent-sessions and loop all preflight with their own `existsSync`, so
  a dangling symlink still reads as absent there. Not a regression; the oracle is simply not
  global yet.
- **Orphan nested state shadows a parent lead.** Root resolution stops at the nearest project
  boundary, so an empty state directory left behind by the old wrong-root behaviour will now
  hide a legitimate lead above it. Crossing the boundary automatically would be worse — it
  would bleed authority across projects — so this needs a migration or an actionable remedy,
  not a silent fix.

## Ground rules

- `bun run check` is `check:kernel` then `check:product`.
- **Every new check must be mutation-proven with red output in its PR body.** The dominant
  defect class in this repo is gates that report green while verifying nothing; `0 fail` must
  never mean "everything skipped".
- Any `docs/command-reference.md` change must come from the generator, or the byte-compare
  fails.
- New website pages must be registered in the sidebar.
- **Do not add a stable top-level command.** One slot remains under P.HELP's cap of 12.
- Committed credentialed evidence goes stale against HEAD by design — do not "fix" it.
- Feature branches and PRs; no direct pushes to `main`.
