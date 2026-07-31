---
id: why-headless
title: Why Headless
sidebar_position: 0
description: How Headless differs from a single AI coding session, what it competes on, and when a native CLI alone is enough.
---

# Why Headless

Headless is not another chat window over a coding model. It is a **local control plane**: one admission path, required OS containment, finite budgets, gated writes, and a tamper-evident ledger that turns each authorized run into a verifiable [execution receipt](./receipts.md).

:::note Private beta
Headless is an unpublished private beta. Prefer disposable projects; do not entrust it with sensitive source, valuable credentials, or unattended spend yet. Claims below describe the product shape and the wedge it is building toward — not a published, multi-tenant SaaS guarantee.
:::

## Not a single AI coding session

A single AI coder CLI is excellent for interactive work with one model. Headless sits **around** those CLIs so several backends can run as servants under one policy and one audit trail.

| Axis | Single AI coder CLI | Headless control plane |
| --- | --- | --- |
| **Models / backends** | One vendor session (plus that vendor’s own subagents, if any) | Cross-backend workers — Claude Code, Codex, OpenCode, Grok Build — under one contract |
| **Trust boundary** | Mostly the CLI’s own tool permissions and your judgment | Required outer OS sandbox (Seatbelt / bubblewrap+seccomp), isolated worker `HOME`, fail-closed probes |
| **Credentials** | Live in your environment or that CLI’s login store | Broker leases by default (opaque, run-scoped); native-login only with project trust and a bounded capsule |
| **Writes** | Often direct edits in the checkout you opened | Leased worktrees, secret scan, gates, durable finality, authorized integration — not ambient write on primary |
| **Spend** | Easy to under-account; unknown price often treated as free | Finite defaults; unknown price is unpayable, never zero |
| **Accountability** | Logs and transcripts at best | Hash-chained ledger + portable [receipts](./receipts.md) you can verify online or offline |
| **Failure modes** | Silent tool denials, partial runs, “it said it did X” | Admission refusal when containment, budget, or trust cannot be proven; results and unsafe bypasses are marked |
| **UX** | Interactive coding UI you already know | Observer TUI (watch, don’t drive); authority stays on the attributable root CLI and bound lead |

If you only need one model in one terminal, you may not need Headless. If you need **heterogeneous servants you can budget, contain, and prove**, you do.

## Competitive differentiation

Same-vendor multi-agent tools and OpenCode-only orchestrators are real and useful. Many already offer worktrees, task boards, and subagents **inside one vendor’s stack**. Headless does not try to out-polish that orchestration UI.

The honest wedge:

- **Cross-backend execution** under one admission, containment, budget, and ledger contract — not only one product’s subagents.
- **Tamper-evident ledger + execution receipts**, not merely logs or dashboards. Silent edits break the chain; verification is a command.
- **Required OS containment**, fail-closed: missing Seatbelt or bubblewrap/seccomp capability refuses the run rather than degrading quietly.
- Competition on **safe, auditable heterogeneous execution** — boring infrastructure other orchestrators could sit on — not on Conductor-style visual parity.

Headless is also the **successor shape to ContextRelay-style multi-terminal collaboration**: instead of coordinating agents across ad hoc terminals, a **daemon-authoritative** project control plane owns policy, queues, workers, broker leases, durable state, and recovery. The coder you talk to stays a normal, externally launched process; servants are launched contained.

### Explicit non-goals

From the product opportunity tree, Headless is **not** currently optimizing for:

- Conductor (or similar) **visual / UX parity** as the primary product race
- Matching **same-vendor subagent depth** as the main wedge (depth remains useful; it is not the differentiator)
- **Windows first** (unsupported platform for required containment today)
- **Weakening required containment** for convenience or demo polish

Those may matter later; they are not the bar for private-beta success.

## When to use what

**Native CLI alone may be enough when:**

- You are coding interactively with **one** model and one backend.
- You accept that trust is “the CLI + your review,” without a portable, independently verifiable receipt.
- You do not need cross-backend servants, project budgets, or gated merge into primary.

**Prefer Headless when:**

- You want **multi-model review** or fleets (e.g. one backend implements, another critiques) under shared policy.
- Servants must be **budgeted and OS-contained**, with credentials isolated from your real home and primary checkout.
- Writes must pass **gates and authorized integration**, not land ambiently on primary.
- You need **verifiable runs**: ledger chain checks and [receipt export/verify](./receipts.md) for reviewers, leads, or future audit.
- You want a **single lead** in the foreground and contained servants behind one local daemon — see [leads and the fleet](./leads-and-fleet.md).

The golden path remains small: [setup → trust → contained exec → verify](../getting-started/quickstart.md). Orchestration surfaces stay experimental until that path is solid for you.

## Related

- [Architecture and data flow](./architecture.md) — one-owner daemon, clients, workers, broker, durable state.
- [The safety model](./safety-model.md) — containment, credentials, budgets, gated writes, threat model.
- [Leads and the fleet](./leads-and-fleet.md) — foreground lead, servants, goals, councils.
- [Execution receipts](./receipts.md) — what a receipt proves and how to verify offline.
- [Building apps](../guides/building-apps.md) — embedding Headless as infrastructure, not only a CLI.
- [Repair and recovery](./repair-and-recovery.md) — repair loops, workflow DAGs, and daemon crash recovery.
- [Case studies](../case-studies/proven-runs.md) — recorded multi-backend and write-path examples (illustrative, not a public benchmark).
