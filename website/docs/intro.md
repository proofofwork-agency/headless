---
id: intro
title: "Headless: Proof of Work for AI Agents"
slug: /docs
sidebar_position: 1
---

# Headless

Headless is a local, provider-neutral runner and control plane for AI coding CLIs. It executes Claude Code, Codex, OpenCode, and Grok Build under required operating-system containment — Seatbelt on macOS, bubblewrap plus seccomp on Linux — behind fail-closed policy, finite budgets, and gated Git writes.

And it does one thing no plain runner does: it turns every run into an **execution receipt** — a portable, tamper-evident, independently verifiable record binding *who* authorized the run, *under what* policy, budget, and containment, and *what it produced*.

Literally: proof of work for AI agents.

:::note Private beta
Headless is an unpublished private beta (`0.2.0-beta.7`). Packages are not on npm; build from source, use disposable projects, and do not entrust it with sensitive source, valuable credentials, or unattended spend yet.
:::

## The problem: you can't trust what you can't verify

AI coding agents now write real code, run real commands, and spend real money. But ask what an agent actually did last Tuesday, and the honest answer today is *logs, at best* — mutable text files that the agent itself could have written, with no binding between the prompt, the policy that admitted it, the credentials it could reach, the money it spent, and the diff it left behind.

That gap matters the moment more than one party cares about the answer: a reviewer accepting an agent-authored change, a team lead accounting for spend, an auditor asking whether the sandbox was actually on. Trust built on unverifiable logs is trust built on nothing.

## The answer: receipts anchored to a tamper-evident ledger

Headless assembles an execution receipt for every authorized run — read-only runs included. Each receipt carries the request echo with a prompt digest, the result with output and diff digests, the policy decision trail, an authorization snapshot, the broker-lease scope, the gate manifest, the budget outcome, and provenance — all covered by per-section SHA-256 digests and a single self-digest.

That self-digest is then **anchored** as an `execution_receipt` artifact into Headless's ledger: an append-only chain in which every record binds its sequence, previous hash, and SHA-256 or HMAC-SHA256 metadata. Silent edits break the chain.

Verification is a command, not a promise:

```bash
headless verify                                        # full ledger-chain scan; non-zero on the first break
headless experimental receipt verify <runId>           # full-chain proof for one run
headless experimental receipt verify --file export.json  # offline, from a portable export — no daemon needed
```

Anyone holding an exported receipt can check it offline; anyone holding the ledger too can upgrade that check to full-chain proof. See [Execution receipts](./concepts/receipts.md) for exactly what is proven at each level — and what is honestly not.

## At a glance: setup → run → receipt → verify

The golden path after a coder CLI is already logged in (target: under five minutes):

1. **Setup.** Initialize external project state and grant native trust when using subscription logins:

   ```bash
   headless setup --cwd "$PROJECT"
   headless project trust grant --allow-native-direct-unrestricted --cwd "$PROJECT"
   ```

2. **Run.** One contained job with a profile (collapses auth, mode, and containment):

   ```bash
   headless exec \
     --backend codex \
     --auth-mode native-login \
     --profile read-only-native \
     --cwd "$PROJECT" \
     -- "Explain this repository."
   ```

3. **Receipt.** At terminal state, Headless assembles the execution receipt — digests, authorization, containment evidence, cost, gates:

   ```bash
   headless experimental receipt show <runId>
   ```

4. **Anchor.** The receipt's self-digest is written into the hash-chained ledger automatically; `receipt list` shows each run's anchor sequence.

5. **Verify.** Independently re-check the chain and the receipt — online, or offline from an export:

   ```bash
   headless verify --cwd "$PROJECT"
   headless experimental receipt verify <runId>
   ```

## The posture

**Contained by default, fail-closed everywhere.** Every worker runs inside a probed OS sandbox with an isolated `HOME`; missing containment capability refuses to run rather than degrading silently. `--unsafe-no-sandbox` is the only bypass, and results that use it are visibly marked. Budgets treat unknown price as unpayable, never as zero. Writes never touch your primary checkout directly — they flow through leased worktrees, secret scanning, gates, and an authorized integration step. The details are in [the safety model](./concepts/safety-model.md).

**Subscription-native.** Headless drives the official CLIs you already have — `claude`, `codex`, `opencode`, `grok` — using their own logins. No separate provider API keys are required for the native-login path; broker mode remains the tighter alternative, where the daemon holds a key and workers receive only finite, opaque leases.

**Observer-only TUI: watch, don't drive.** `headless tui` authenticates with a dedicated observer credential that the daemon limits to snapshots and events. It shows the fleet, goals, approvals, and configuration — and it can generate the exact root-CLI command for an action — but it cannot submit work, resolve approvals, or mutate anything. Authority stays in the CLI, where it is attributable.

**One visible lead, contained servants.** Your foreground coding CLI stays a normal, externally launched process that you can see. Headless binds it as the project's single [lead](./concepts/leads-and-fleet.md) over MCP, and every servant it dispatches runs contained, budgeted, and receipted.

For the comparison with a single AI coding session, the competitive wedge (cross-backend containment and receipts vs same-vendor orchestration polish), and when a native CLI alone is enough, see [Why Headless](./concepts/why-headless.md).

## Where next

- [Why Headless](./concepts/why-headless.md) — not a single coding session; when to use what.
- [Installation](./getting-started/installation.md) — requirements and building from source.
- [Quickstart](./getting-started/quickstart.md) — golden path from setup to verified receipt in under five minutes once a coder CLI is logged in.
- [Building apps](./guides/building-apps.md) — using Headless as embeddable infrastructure.
- [Repair and recovery](./concepts/repair-and-recovery.md) — repair loops, workflow DAGs, and daemon crash recovery.
- [Architecture and data flow](./concepts/architecture.md) — the one-owner daemon, authenticated clients, workers, broker, durable state, and recovery.
- [Modes and policy axes](./concepts/modes.md) — read/write, broker/native, required/unsafe, and ask/auto/bypass without conflating them.
- [Operating-system containment](./concepts/containment.md) — exact Seatbelt and bubblewrap/seccomp boundaries and probes.
- [The safety model](./concepts/safety-model.md) — containment, credentials, budgets, gated writes, and the honest threat model.
- [Persistent sessions](./concepts/sessions.md) — native multi-turn resume with bounded replay and durable recovery.
- [Portable skills](./concepts/skills.md) — immutable reviewed instruction bundles and invocation evidence.
- [Execution receipts](./concepts/receipts.md) — what a receipt proves, and how to verify one offline.
- [Leads and the fleet](./concepts/leads-and-fleet.md) — the foreground lead, fleet profiles, goals, and councils.
