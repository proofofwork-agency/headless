---
id: repair-and-recovery
title: Repair and Recovery
sidebar_position: 9
description: Gate-driven repair loops, restartable workflow DAGs, goal revision, idle autonomy, and ordered daemon crash recovery.
---

# Repair and recovery

Headless can retry work, re-run release gates, and reconstruct authority after a crash — but it does not treat agent self-report as success. The **gate** (configured release-gate checks) is the repair oracle. Durability means ordered boot reconciliation that **fails closed** when authority would be ambiguous.

Everything on this page is **experimental** unless noted otherwise. Prefer the [quickstart golden path](../getting-started/quickstart.md) before unattended loops or idle write posture.

:::note Not Product Gate P
The **Product Gate “loop protocol”** in `docs/product-gate.md` is a *human* product-improvement process (measure → fix → re-measure). It is **not** the same thing as the runtime `headless experimental loop` described here.
:::

## Repair loops (`headless experimental loop`)

A repair loop iterates until the project (or its preserved candidate) is green under the same daemon-owned gate runner used elsewhere — or until a finite stop condition fires.

### Observe, then act

Each iteration:

1. **Run the gate first** against the relevant tree (primary or the loop’s accumulated candidate).
2. If the gate is already green → **succeed without spending an agent turn**.
3. Otherwise compile failing checks into a repair graph, admit work, then **re-gate** after the graph settles.
4. If still failing → backoff → next iteration (subject to budget and stagnation rules).

Agents may claim success; only a subsequent green gate settles the loop.

### Compiled repair graph

`compileRepairGraph` turns a gate report into durable workflow steps:

- Each **failing check** becomes a repair node. Nodes run **serially** so later repairs base on earlier candidates rather than racing on primary HEAD.
- A **verify** step sits after repairs with **`optionalDependsOn`** on every repair node: optional edges must *settle*, but need not *succeed*. One dead repair still feeds evidence into verification instead of silencing the whole iteration.
- Verification prefers a **contrasting backend** from the repair backend so the author model is not the sole judge. The gate remains the real oracle either way.

### Preserve versus integrate

Default CLI repair policy uses **`integrationPolicy: "preserve"`**: repairs accumulate on an isolated **previous candidate commit**; the primary checkout stays unmoved until an authorized integrate path. Auto-integration on green is not the casual default — it is a deliberate, reviewed policy choice (for example via an explicit policy file), still under the daemon’s write gates.

### Stop conditions

A loop leaves the active set when it reaches a terminal state such as:

| Outcome | Meaning |
| --- | --- |
| green / succeeded | Gate (oracle) is clean |
| `budget_exhausted` | Aggregate or per-iteration cost/request bounds hit |
| `deadline_exceeded` | Wall-clock policy deadline passed |
| `no_progress` | Same failure signature repeated for `stagnationLimit` consecutive iterations |
| `cancelled` | Operator or owner cancelled the loop |
| `awaiting_integration` | Work finished under preserve; human/authorized integrate remains |

### Operator surface

Launch requires explicit confirmation-style flags per CLI grammar:

```bash
headless experimental loop start \
  --confirm \
  --repair \
  --check build \
  --check test \
  --backend codex \
  --cwd "$PROJECT"
```

Lifecycle:

```bash
headless experimental loop list --cwd "$PROJECT"
headless experimental loop status --loop-id <id> --cwd "$PROJECT"
headless experimental loop pause --loop-id <id> --cwd "$PROJECT"
headless experimental loop resume --loop-id <id> --cwd "$PROJECT"
headless experimental loop cancel --loop-id <id> --cwd "$PROJECT"
```

Full flags and finite policy options: generated [command reference](https://github.com/proofofwork-agency/headless/blob/main/docs/command-reference.md).

## Workflow DAGs

Durable, restartable DAGs live under `headless experimental workflow`. Each step keeps dependencies, backend selection, bounded retries, approval policy, terminal state, and **actual** dependency results/diffs (not re-prompted fiction).

```bash
headless experimental workflow validate --file workflow.json
headless experimental workflow run --file workflow.json
headless experimental workflow status --workflow-id <id>
headless experimental workflow pause --workflow-id <id>
headless experimental workflow resume --workflow-id <id>
headless experimental workflow cancel --workflow-id <id>
```

### `dependsOn` vs `optionalDependsOn`

- **`dependsOn`**: required. A failed required dependency **blocks** the dependent step.
- **`optionalDependsOn`**: the dependency must reach a terminal state, but **need not succeed**. The dependent step still runs and receives failure evidence — how repair verify stays informative when one sibling dies.

On daemon boot, `recover()` re-launches **non-terminal** workflows so pause/resume/cancel and mid-flight steps survive restarts under the same admission rules as live creation.

## Goal revision

Fleet **goals** already use a bounded collaboration shape (see [Leads and the fleet](./leads-and-fleet.md)):

```text
plan → workers → synthesis → revision (bounded by maxDeliberationRounds)
```

Write goals add candidate preservation, attributable review votes, deterministic gates, and gated integrate. Revision rounds stop at the profile’s `maxDeliberationRounds` rather than thrashing forever. Repair loops and goals are complementary: goals coordinate multi-agent work; repair loops drive gate-oracle convergence on a fixed check set.

## Idle autonomy

Fleet profiles carry `idleAutonomy`: `off` | `suggest` | `read-only` | `write`. The default posture is often **`suggest`** — a deterministic idle scanner publishes visible opportunity lanes; it is **not** unattended full write of the Headless product tree.

Operator CLI:

```bash
headless experimental autonomy status --cwd "$PROJECT"
# also: start | stop | ask | backup
```

Details and operator expectations: [Idle autonomy](./leads-and-fleet.md#idle-autonomy) in Leads and the fleet. Idle autonomy is **not** continuous self-host of Headless product development.

## Daemon recovery

After the project socket is won, startup reconstructs authority in a deliberate order (high level):

1. Linked-hold / cross-provider recovery decisions  
2. Broker start  
3. Worktree leases and candidate **integration journals**  
4. Interrupted jobs and terminal run events  
5. Receipt write-ahead journal → durable receipts  
6. Persistent sessions and skill invocations  
7. Tasks and orchestration projections (workflows, councils, goals, loops)

Ambiguous budget, worktree, integration, or linked-hold state **fails closed** (`recovery_required` and similar) rather than inventing spent authority.

Receipt recovery is deliberately **non-fatal** to daemon availability: gaps and malformed markers become explicit diagnostics / non-anchor artifacts while unrelated state becomes ready. By contrast, an ambiguous primary-checkout integration journal can **block readiness** because continuing could mutate the wrong Git state.

Sessions use **native resume** when fingerprints still match, with a **bounded redacted replay** fallback when the provider thread is lost — see [Persistent sessions](./sessions.md).

The architecture overview of this order lives in [Startup and crash reconciliation](./architecture.md#startup-and-crash-reconciliation).

## What this is not

- Not a substitute for [Product Gate P](https://github.com/proofofwork-agency/headless/blob/main/docs/product-gate.md) as a human release/UX process.  
- Not ambient write access: candidates, budgets, containment, and merge authority still apply.  
- Not a promise that a green agent transcript equals a green gate.

## Related

- [Architecture](./architecture.md) — one daemon per project and boot reconciliation order.
- [Leads and the fleet](./leads-and-fleet.md) — goals, councils, idle autonomy.
- [Persistent sessions](./sessions.md) — native resume and bounded replay.
- [The safety model](./safety-model.md) — containment, budgets, write gates.
- [Execution receipts](./receipts.md) — evidence every authorized run leaves behind.
- [Command reference](https://github.com/proofofwork-agency/headless/blob/main/docs/command-reference.md) — full experimental CLI grammar.
