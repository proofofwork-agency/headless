---
title: Lead and contained servants
sidebar_position: 1
description: How one foreground lead uses contained workers through run, deliberate, council, and depth-one delegation.
---

# Lead and contained servants

One externally launched CLI is the foreground lead. Its MCP client attaches to
the project daemon with a generation-specific credential and heartbeats while
connected. Switching hosts rotates the generation; Headless never elects,
launches, injects into, or kills the lead process.

The lead can use several orchestration shapes:

- **Run** submits one bounded contained worker and returns its full structured
  result.
- **Deliberate** fans a read-only question out to multiple workers and returns
  attributable outputs for synthesis.
- **Council** persists proposal, execution, review, vote, and decision phases;
  votes cite real artifacts and require a strict majority.
- **Goal and workflow** coordinate durable tasks and DAG steps with messages,
  budgets, approvals, finality, and restart recovery.

Automatic routing excludes the active lead backend. The lead may inspect
approvals and candidates, but it cannot resolve its own approval, grant trust,
administer budgets, or directly integrate a candidate through MCP.

## Depth-one `run.delegate`

An eligible depth-zero worker may ask the daemon for one bounded sibling job
through its authenticated run-tool endpoint. This is not an ambient nested
process and not a root CLI command. The daemon creates the child independently,
records `delegationOf`, and returns success or failure as structured tool data;
the parent can continue either way.

V1 limits are intentionally strict:

- one admitted child per parent and no delegation operation on the child;
- read-only mode and required containment for both jobs;
- broker authentication or a credential-free backend, never native login;
- a different target backend on the same provider, excluding the active lead;
- immediate capacity admission, so the child cannot queue behind its parent;
- a 25% default budget carve with a hard 50% cap across every bounded
  dimension;
- the parent deadline as the ceiling, with cancellation cascading to the child;
- approval composition of `ask → ask`, `auto → auto`, and `bypass → auto`.

The carve is transferred atomically from the parent's remaining reservation.
It is not a second project-wide reservation. Provably unused allocation returns
once; crash-unknown allocation is exhausted. Cross-provider delegation remains
denied until linked target-provider holds can preserve the same accounting
guarantee.

These orchestration surfaces remain experimental until their release gate is
complete, even though their contracts and contained end-to-end paths are tested.
