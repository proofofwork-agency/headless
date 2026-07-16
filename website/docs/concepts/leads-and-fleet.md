---
id: leads-and-fleet
title: Leads and the Fleet
sidebar_position: 3
---

# Leads and the fleet

Headless turns any supported CLI coder into the visible **foreground lead**, while the others run as contained servants behind one local, auditable control plane. Claude Code, Codex, OpenCode, and Grok Build all use the same admission, containment, budget, approval, result, and ledger contracts — so the coder you talk to and the coders it delegates to are governed identically.

```text
externally launched lead CLI
          │ generation-bound MCP attach
          ▼
authenticated project daemon
          │ trust → authority → budget → queue
          ▼
contained Claude / Codex / OpenCode / Grok workers
          │
          └─ structured result → durable ledger → observer TUI
```

## The foreground lead

The lead is a provider CLI you launch yourself, in the foreground, where you can see it. Headless never launches, injects into, elects, or kills it. Instead, the daemon binds it over a generation-bound MCP connection and gives it a bounded tool surface for dispatching contained work.

```bash
headless lead use codex --cwd "$PROJECT"     # bind a host: codex | grok | claude | opencode
headless lead status --cwd "$PROJECT"        # inspect the binding and connection
headless lead release --cwd "$PROJECT"       # remove the binding
```

Or do it at initialization time in one step:

```bash
headless init --lead codex --cwd "$PROJECT"
```

`init --lead` initializes external per-project state, installs that host's MCP registration, and binds the lead. It does **not** grant project trust, native egress, write authority, or approval bypass — those remain separate, explicit decisions. The equivalent explicit sequence is `headless init`, then `headless mcp install codex`, then `headless lead use codex`.

**Single occupancy, by construction.** There is exactly one configured foreground lead per project and no automatic election. `lead use` rotates a generation-specific credential: switching hosts invalidates state-changing access from the previous generation without deleting durable project history. `lead release` removes the binding without cancelling jobs or deleting state. The lead attaches and heartbeats; a host that stops heartbeating becomes `disconnected`, and Headless does not elect or launch a replacement.

Once bound, the lead's MCP surface includes `headless_run` for one bounded servant, `headless_deliberate` for attributable read-only fan-out, `council_deliberate` for persisted council phases, and fleet, goal, workflow, collaboration, approval-inspection, candidate, ledger, and observer tools. The lead may *inspect* approvals and candidates, but root authority retains trust, credentials, budgets, recovery, approval resolution, and emergency integration. Automatic worker routing excludes the active lead's backend, so the lead never quietly delegates to itself.

## Fleet profiles

A fleet profile describes the servants: worker backends, optional models, authentication and approval modes, bounds, and idle-autonomy policy. Profiles are managed through the experimental CLI:

```bash
headless experimental fleet profile upsert --file profile.json --activate --cwd "$PROJECT"
headless experimental fleet profile upsert --profile-id subs --auth-mode native-login --approval-policy ask --cwd "$PROJECT"
headless experimental fleet profile list --cwd "$PROJECT"
headless experimental fleet profile get --profile-id subs --cwd "$PROJECT"
headless experimental fleet profile remove --profile-id subs --cwd "$PROJECT"
```

`--auth-mode` selects `native-login` or `broker` for the profile, `--approval-policy` selects `ask`, `auto`, or `bypass`, and `--activate`/`--no-activate` controls whether the upserted profile becomes the active one.

A complete `profile.json` names each agent and may override the bounds explicitly — for subscription-backed workers, set `native-login` at the top level **and on every agent** (a top-level native profile does not rewrite an agent explicitly left in broker mode):

```json title="profile.json"
{
  "id": "native-subscriptions",
  "name": "Native subscription fleet",
  "authMode": "native-login",
  "approvalPolicy": "ask",
  "agents": [
    {"id": "codex", "backend": "codex", "name": "Codex", "authMode": "native-login"},
    {"id": "opencode", "backend": "opencode", "name": "OpenCode", "authMode": "native-login"}
  ],
  "maxActiveWorkers": 4,
  "maxQueuedDelegations": 64,
  "maxDeliberationRounds": 8,
  "maxAttemptsPerDelegation": 2,
  "goalTimeoutMs": 3600000,
  "idleAutonomy": "suggest"
}
```

Check readiness with:

```bash
headless experimental fleet health --cwd "$PROJECT"
```

Defaults are deliberately bounded: four active workers, 64 queued delegations per project, one active turn per native session, eight deliberation rounds, two attempts per delegation, and a 60-minute goal deadline. Queue overflow returns `QUEUE_CAPACITY_EXCEEDED` — jobs are never silently dropped.

:::note The "login required" trap
An untrusted project and a broker-default fleet profile can both be reported as `login_required`, even when the official CLIs are already logged in. For the subscription path, grant native trust (`headless project trust grant --allow-native-direct-unrestricted`) **and** upsert a profile whose top level and every agent use `native-login`.
:::

## How goals and councils use the fleet

A **goal** is durable, daemon-scheduled work across the fleet:

```bash
headless experimental goal start --detach --cwd "$PROJECT" -- "Analyze the fixture."
headless experimental goal run --autonomous --detach -- "Analyze the fixture."
headless experimental goal follow --goal-id <id>
headless experimental goal status --goal-id <id>
headless experimental goal list
headless experimental goal cancel --goal-id <id>
headless experimental goal result --goal-id <id>
```

An automatic goal begins with a durable **read-only planning turn**, then assigns work to at most the profile's active-worker count of distinct eligible workers, executing independent tasks concurrently through the durable FIFO scheduler. A sticky **synthesizer** receives a bounded bundle of every admitted worker's actual output, diff, turn ID, and artifact IDs for candidate synthesis. Planning, worker, and review turns remain read-only; only candidate synthesis and revision turns can create a preserved write candidate, and revisions stay bounded by the deliberation-round limit before deterministic gates and integration. Synthesizer failover never changes the configured foreground lead.

Goals are read-only unless `--mode write` is explicit. A write goal preserves the candidate first, sends reviewers its real job ID, output, diff, file list, and commit evidence, requires structured citations and an attributable vote, then integrates through the normal gated candidate path described in [the safety model](./safety-model.md). In `ask` mode, each mutating turn waits on its own approval, and the goal pauses again for a distinct merge approval after the gates.

A **council** runs the same question through persisted proposal, execution, review, vote, and decision phases:

```bash
headless experimental council --agent codex --agent opencode --mode read-only --cwd "$PROJECT" -- "Should we split the parser module?"
```

Failed proposals block finality, attributable votes require a strict majority, and ties reject. For write councils, an approving vote cannot substitute for tests: approval requires the execution jobs' persisted policy, test, review, and budget finality evidence.

Every servant run under a goal or council remains contained, budgeted, and — like all authorized runs — leaves an [execution receipt](./receipts.md).

## Where to watch it

```bash
headless tui --cwd "$PROJECT"
```

The observer TUI's **Fleet** tab shows profile and per-agent readiness at a glance, alongside Overview, Goals, Approvals, Events, Config, and Help views — cycle with `Tab`/`Shift-Tab` or jump with the number keys. It is strictly read-only: it renders daemon snapshots and events and generates exact root-CLI commands for you to run from your shell, but it cannot dispatch work, resolve approvals, or change the fleet.

From the shell, the same state is available as commands: `headless experimental fleet health`, `headless experimental goal follow --goal-id <id>`, and the event stream via `headless experimental events --follow`.

## Related

- [Quickstart](../getting-started/quickstart.md) — initialize a project and bind your first lead.
- [The safety model](./safety-model.md) — the containment, budget, and write gates every servant runs under.
- [Execution receipts](./receipts.md) — the verifiable record each servant run leaves behind.
