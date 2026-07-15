---
title: Lead and contained servants
sidebar_position: 1
description: How one foreground lead uses bounded runs, deliberations, councils, and depth-one worker delegation.
---

# Lead and contained servants

One externally launched CLI is the foreground lead. Its MCP client attaches to
the project daemon with a generation-specific credential and heartbeat.
Switching hosts rotates the generation; Headless never elects, launches,
injects into, or kills the visible lead process.

## Lead tools

The compiled MCP server exposes focused tools over daemon authority:

- `headless_run` submits one bounded contained worker and returns its structured
  result.
- `headless_deliberate` fans a read-only question across selected backends for
  synthesis by the lead.
- `council_deliberate` persists proposal, execution, review, vote, and decision
  phases with attributable artifacts.
- Fleet, goal, workflow, collaboration, approval-inspection, candidate, ledger,
  and observer tools expose the corresponding durable projections.

Automatic routing excludes the active lead backend. The lead can inspect
approvals and candidates, but it cannot grant trust, administer budgets, resolve
its own approval, or directly integrate a candidate through MCP.

## Depth-one `run.delegate`

An eligible depth-zero worker may ask the daemon for one bounded child through
its authenticated run-tool endpoint. The daemon independently rechecks the
parent's durable depth, authority, deadline, approval policy, containment,
backend, lead exclusion, capacity, pricing, and budget. A child never receives
`run.delegate`, so nesting stops at depth one.

Shared invariants apply to both delegation paths:

- one admitted child per parent;
- read-only mode, required containment, immediate non-queueing capacity;
- broker authentication or a credential-free target;
- a different target backend, excluding the active lead;
- 25% of remaining parent authority by default, hard-capped at 50%;
- child deadline below the parent deadline, cancellation cascading downward;
- `ask → ask`, `auto → auto`, and `bypass → auto` approval composition;
- structured child failure returned to the parent without killing it.

Same-provider delegation uses the original atomic parent sub-reservation.
Cross-provider delegation uses a linked hold: one atomically replaced budget
envelope records the parent allocation and target-provider reservation before
the broker mints the target bearer. The bearer is returned once and never
persisted. Normal settlement and restart recovery charge each provider exactly
once, return only proven-unused parent authority, and exhaust ambiguity.

## Writes remain root-gated

Workers and leads may propose work, but a write candidate remains isolated in a
leased worktree until secret scanning, project gates, finality, and an authorized
integration decision pass. This separation is why orchestration can be broad
without giving every model mutation authority over primary.

Continue with [fleets, goals, and workflows](./fleets-goals-workflows.md) and
the [live case studies](../case-studies/proven-runs.md).
