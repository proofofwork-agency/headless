---
id: building-apps
title: Building apps with Headless
sidebar_position: 3
description: Layered playbook from the Beta 1 kernel through fleets, goals, candidates, repair loops, and workflows.
---

# Building apps with Headless

A user-facing playbook for turning Headless from a one-shot contained runner
into a full multi-agent application loop — without skipping the safety and
audit rails that make the product honest.

Read this top-down. Each layer assumes the previous one works. Do not start at
Layer E (writes) on a project that has not completed Layer A (kernel).

:::note Private beta
Headless is an unpublished private beta (`0.2.0-beta.7`). Prefer disposable
projects, bounded spend, and human-in-the-loop approvals. Advanced surfaces
below live under `headless experimental` and carry **no stability promise**.
:::

## Prerequisites

Before the layered path:

1. **Private beta build.** Install and build from source — packages are not on
   npm. See [Installation](../getting-started/installation.md).
2. **Disposable project (recommended).** Use a throwaway git repo until you
   trust the write path end-to-end. Primary never mutates ambiently; still,
   practice on something you can discard.
3. **At least two coder CLIs for multi-backend work.** Goals, councils, and
   fleets need more than one ready servant. Sign in to the official CLIs first
   (`codex login`, `opencode auth login`, Claude setup-token on macOS, etc.).
   Grok is read-only for writes today — keep at least one write-capable backend
   (Codex, OpenCode, or Claude) available when you need candidates.

Confirm readiness with:

```bash
PROJECT="${PROJECT:-$(pwd)}"
headless doctor --cwd "$PROJECT"
```

## Layer A — Kernel first

Make the Beta 1 golden path rock-solid before any orchestration.

```bash
PROJECT="${PROJECT:-$(pwd)}"

# 1) External per-project state, CLI inventory, next-command hints
headless setup --cwd "$PROJECT"

# 2) Native subscription path needs unrestricted-egress acknowledgement
headless project trust grant \
  --allow-native-direct-unrestricted \
  --cwd "$PROJECT"

# 3) Contained read-only exec with a profile (collapses auth/mode/containment)
headless exec \
  --backend codex \
  --auth-mode native-login \
  --profile read-only-native \
  --cwd "$PROJECT" \
  -- "Explain this repository."

# 4) Verify the ledger chain
headless verify --cwd "$PROJECT"
```

Expected: setup prints next commands; trust grant records native consent
outside the checkout; exec returns model output under required OS containment;
`verify` prints `✓ intact` and exits 0.

Noninteractive setup+grant:

```bash
headless setup --yes --allow-native-direct-unrestricted --cwd "$PROJECT"
```

Optional lead at setup time: `headless setup --lead codex --cwd "$PROJECT"`.
Lead install does **not** grant trust, write authority, or approval bypass.

Kernel commands in the Beta 1 set include `setup`, `exec`/`run`, `project`,
`init`, `lead`, `daemon`, `status`, `doctor`, `mcp`, `tui`, and `verify`.
Everything after Layer A is experimental unless noted.

## Layer B — Bind a lead

The lead is an externally launched provider CLI you can see. Headless never
launches, elects, or kills it; it binds over generation-bound MCP.

```bash
# One-shot init + MCP install + lead bind
headless init --lead codex --cwd "$PROJECT"

# Or rotate later
headless lead use opencode --cwd "$PROJECT"
headless lead status --cwd "$PROJECT"
# headless mcp install codex --cwd "$PROJECT"  # explicit install when needed
```

Expected: `Configured <host> as the foreground lead…` (or equivalent JSON from
`lead status`). Valid hosts: `codex`, `claude`, `opencode`, `grok`.

There is exactly one foreground lead per project. Switching hosts invalidates
the previous generation without deleting durable work. Details:
[Leads and the fleet](../concepts/leads-and-fleet.md).

## Layer C — Fleet profile

Describe the servants the lead (and goals) may dispatch.

```bash
headless experimental fleet profile create \
  --profile-id assistants \
  --agent codex \
  --agent opencode \
  --auth-mode native-login \
  --approval-policy ask \
  --activate \
  --cwd "$PROJECT"

headless experimental fleet health --cwd "$PROJECT"
```

Expected: the stored profile as JSON (active id set); health reports per-agent
readiness (`ready`, login/trust blocked, with mode-specific remedies).

Notes:

- Repeat `--agent` for each worker backend. Built-in aliases are canonicalized
  (`grok` → `grok-build`).
- Native profiles need project trust **and** `native-login` on the profile and
  every agent that should use a subscription.
- Defaults are bounded (active workers, queue depth, deliberation rounds, goal
  deadline). Overflow fails closed — jobs are not silently dropped.

## Layer D — Plan and review (read-only)

Prefer read-only goals and councils before any write. Read-only is the default.

```bash
# Durable multi-agent goal (detached in the daemon)
headless experimental goal start --detach --cwd "$PROJECT" -- \
  "Analyze the public entry points and list the top risks."

# Multi-agent council: proposal → execution → review → vote → decision
headless experimental council \
  --agent codex \
  --agent opencode \
  --mode read-only \
  --cwd "$PROJECT" -- \
  "Should the parser move to a streaming design?"
```

Expected: `goal start` returns a durable goal id immediately; follow or result
when you need the outcome. Councils return a persisted record covering every
phase and exit 0 only when the decision is approved. Both prohibit
`--unsafe-no-sandbox`.

Useful follow-ups:

```bash
headless experimental goal follow --goal-id <goalId> --cwd "$PROJECT"
headless experimental goal result --goal-id <goalId> --cwd "$PROJECT"
headless experimental events --follow --cwd "$PROJECT"
```

## Layer E — Write goals and candidates

Writes never touch primary ambiently. The path is always: **leased worktree →
secret scan → gates → finality → authorized integrate**.

```bash
# Intentional write goal (mode is explicit)
headless experimental goal start \
  --detach \
  --mode write \
  --cwd "$PROJECT" -- \
  "Add a --version flag to the CLI entry point and keep tests green."

# Or a one-shot write exec for a smaller change
headless exec \
  --backend opencode \
  --auth-mode native-login \
  --mode write \
  --cwd "$PROJECT" -- \
  "Append a usage section to README.md."
```

After a candidate exists (job id / candidate id from the result):

```bash
headless experimental candidate inspect \
  --cwd "$PROJECT" --candidate-id "$CANDIDATE_ID"

# Human integration decision — never automatic from ask-mode defaults
headless experimental candidate integrate \
  --cwd "$PROJECT" --candidate-id "$CANDIDATE_ID"
# or: headless experimental candidate reject ...
```

In `ask` approval policy, mutating turns and the final merge each pause for
attributable approval:

```bash
headless experimental approval list --cwd "$PROJECT" --status pending
# headless experimental approval resolve --cwd "$PROJECT" \
#   --approval-id <id> --decision approved --resolution "Reviewed."
```

Primary stays clean until integrate succeeds. See the
[safety model](../concepts/safety-model.md) and the
[write-mode scenario](./test-scenarios.md#4-write-mode-candidate-flow-on-a-toy-repo).

:::warning Never ambient primary writes
There is no supported path where a worker edits your checkout in place.
Grok write execution is fail-closed (`canWrite: false`). Prefer Codex,
OpenCode, or Claude for candidate-producing work.
:::

## Layer F — Repair loops and workflow DAGs (optional)

When project gates fail after a change — or you need a multi-step pipeline —
use the experimental loop and workflow surfaces.

### Gate-driven repair

The release gate is the oracle: the loop re-gates until the project is green,
the budget/deadline is spent, or progress stagnates. Default integration is
`preserve` — repairs accumulate on a candidate tip; primary stays unmoved
until you integrate.

```bash
headless experimental loop start \
  --repair \
  --check check \
  --check test \
  --confirm \
  --cwd "$PROJECT"

headless experimental loop status --loop-id <loopId> --cwd "$PROJECT"
```

`--confirm` is required after you have reviewed finite iteration, deadline,
and budget bounds. Details:
[Experimental repair loops](./cli.md#experimental-repair-loops).

### Workflow DAG

A workflow is a validated, restartable DAG with per-step backends, retries,
dependency results, and typed finality:

```bash
headless experimental workflow validate --file workflow.json
headless experimental workflow run --file workflow.json --cwd "$PROJECT"
headless experimental workflow wait --workflow-id <id> --cwd "$PROJECT"
```

Use `optionalDependsOn` when a verifier should still run after a sibling fails
(settle the edge without requiring success). Daemon restart recovers running
workflows without duplicating terminal work. Details:
[Workflows](./cli.md#workflows).

## Where to watch

```bash
headless tui --cwd "$PROJECT"
```

The TUI is **observer only**: fleet, goals, approvals, events, config. It
cannot dispatch work, resolve approvals, integrate candidates, or change
policy. It may print exact root-CLI commands for you to run in your shell.
See [Tracking runs in the TUI](./tui.md).

From the shell, the same state is available as:

```bash
headless experimental fleet health --cwd "$PROJECT"
headless experimental goal follow --goal-id <id> --cwd "$PROJECT"
headless experimental events --follow --cwd "$PROJECT"
headless status --cwd "$PROJECT"
```

## What success looks like

A full application loop is “done” when all of the following hold:

1. **Candidate integrated** (or an intentional reject) with a durable
   integration decision — primary advanced only through the journaled path.
2. **`headless verify --cwd "$PROJECT"`** exits 0; optionally
   `headless verify --evidence --json` for anchored release evidence.
3. **Receipts** exist for terminal runs:

   ```bash
   headless experimental receipt list --cwd "$PROJECT"
   headless experimental receipt show <runId> --cwd "$PROJECT"
   headless experimental receipt verify <runId> --cwd "$PROJECT"
   ```

4. Gates that matter for the project (`check` / `build` / `test` / `pack`)
   are green on the integrated tip — not only in agent chat.

## Honest limits

- **Experimental orchestration.** Goals, fleets, councils, loops, workflows,
  autonomy, and receipts outside `verify` are under `headless experimental`
  with no stability promise until their release gates pass.
- **Not every backend can write.** Grok is read-only in Headless today;
  write goals and repair loops need a write-capable backend.
- **Not safe unattended production.** Default approval is `ask`. Autonomous
  and idle-write modes still require trust, clean primary, leased worktrees,
  budgets, gates, finality, and merge authority — and remain private-beta
  surfaces. Do not point them at production credentials or spend.
- **Not continuous self-host.** Idle autonomy is a bounded scanner with
  durable fingerprints, not a forever self-improving host. Prefer explicit
  goals and human integrate for real product work.

## Related

- [Leads and the fleet](../concepts/leads-and-fleet.md) — lead binding, fleet
  profiles, goals, and councils.
- [The safety model](../concepts/safety-model.md) — containment, credentials,
  budgets, leased writes, finality.
- [Execution commands](./cli.md) — full cookbook, including
  [repair loops](./cli.md#experimental-repair-loops),
  [workflows](./cli.md#workflows), and
  [idle autonomy](./cli.md#idle-autonomy).
- [Proven runs](../case-studies/proven-runs.md) — recorded multi-agent evidence.
- [Why Headless](../concepts/why-headless.md) — single-AI contrast, competitive wedge, when to use what.
- [Repair and recovery](../concepts/repair-and-recovery.md) — repair graphs, workflow DAGs, daemon boot reconciliation.
- [Quickstart](../getting-started/quickstart.md) — five-minute golden path.
- [Architecture](../concepts/architecture.md) — daemon recovery and durable
  state (restart, journals, ledger).
