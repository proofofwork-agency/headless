---
id: architecture
title: Architecture
---

# Architecture — how it is built

Headless is a **daemon-owned control plane**. Clients are thin; all authority,
state, and containment live in one authenticated daemon per project root.

## Daemon and external state

One authenticated daemon owns each canonical project root. Its Unix socket and
token are owner-only, and clients cannot replace the daemon's project root or
self-declare their principal or coordinator identity. Any client
(`connectOrStartDaemon`) starts an embedded daemon when none is live.

State lives **outside the repository**, keyed by `sha256(canonical project root)`:

- Linux: `${XDG_STATE_HOME:-~/.local/state}/headless/projects/<project-id>`
- macOS: `~/Library/Application Support/Headless/projects/<project-id>`
- Managed/tests: `HEADLESS_STATE_HOME/projects/<project-id>`

It holds the ledger and read projections, jobs, tasks, workflows, sessions,
policy and grants, budgets, worktree leases, integration journals, artifacts, and
daemon metadata. A normal read-only run never creates `.headless` or edits
`.gitignore` in your checkout.

## Ledger v2

The ledger is an append-only, hash-chained log. The daemon assigns immutable
envelope fields — version, sequence, timestamp, project id, authenticated
principal, event id, previous hash, and hash/HMAC metadata — and payloads cannot
override them. Reads verify the chain incrementally with partial-line buffering,
exact event-id duplicate suppression, and a digest-bound, size-bounded persisted
read projection. Set `HEADLESS_LEDGER_KEY` to use HMAC-SHA256 rather than an
unkeyed hash. All event, output, and diff paths are deeply redacted and
size-bounded before callbacks, terminal output, ledger writes, MCP/plugin
responses, and TUI updates — including stateful redaction of secrets split across
stream chunks.

On first v0.2 open, a valid v1 `.headless` ledger is verified and imported into
external state through a crash-idempotent write-ahead import; the original file
is not changed.

## Structured contracts

The package exports shared [Zod](https://zod.dev) schemas for requests, results,
events, adapters, jobs, tasks, sessions, workflows and steps, grants, budgets,
councils, fleet profiles, goals, turns, delegations, directed messages, reviews,
votes, approvals, candidates, and finality decisions. Every daemon boundary
validates against them, so malformed input fails closed with a structured error.

```ts
import { RunRequestSchema, exec } from "@proofofwork-agency/headless";

const request = RunRequestSchema.parse({
  backend: "codex",
  prompt: "Review the parser",
  projectRoot: process.cwd(),
  containment: "required",
  authMode: "native-login",
});
```

## Durable execution

Runs have a durable lifecycle with a total creation-to-exit deadline, bounded
FIFO queueing with overflow evidence, complete descendant cancellation with
TERM-to-KILL escalation, and bounded, redacted streams, artifacts, and diffs.
Malformed backend output is classified into a structured terminal result, and
stream/subscriber/mailbox backpressure is bounded.

## Goals, fleets, and collaboration

A **fleet profile** is a persisted set of agents, each carrying its own backend,
model, auth mode, approval policy, priority, and capabilities. When none exists,
the daemon auto-provisions a `fleet-default` from the installed backends.

A **goal** runs a bounded, durable plan → delegate → execute → critique → revise
→ gate → decide → integrate loop over a fleet, with a coordinator chosen as
`human`, `automatic`, `election`, or a specific `agent:<id>`. Goals are read-only
by default; a write goal is explicit and gated. Collaboration is addressed and
acknowledged: turns and directed messages are durable, bounded, and redacted, and
the mailbox prunes acknowledged entries by default to relieve backpressure.

## Councils and workflows

**Councils** run several agents through a proposal → execution → review →
strict-majority vote to a terminal decision. **Workflows** are persisted,
restartable DAGs of steps with real dependency results and diffs, bounded
budget-checked retries, and terminal cancellation recovery. Both always require
containment and reject unsafe execution.

## Writes and finality

A write run requires Git and a clean primary checkout. Headless durably records a
**preparing lease** before asking Git to create an ephemeral worktree from the
recorded primary `HEAD`, then activates the lease only after creation succeeds —
the primary checkout is never the worker's writable directory. Daemon-owned
integration uses a sanitized Git environment and daemon identity and records the
base, candidate, resulting commit, gates, actor, grant, and outcome. Auto-merge
requires merge authority and passing policy/test/review/vote/budget gates. An
unchanged clean primary fast-forwards; an advanced primary is re-gated in a
separate worktree. Crashed worktrees are retained as evidence and a fsynced
integration journal reconciles a crash after the primary update.

## Clients

All clients are daemon clients with no independent authority:

- **CLI** (`headless` / `hless`) — see the [CLI reference](./cli-reference.md).
- **Control room (TUI)** — the live [terminal UI](./control-room.md).
- **MCP server** (`headless-mcp` / `headless mcp serve`) — exposes Headless to
  MCP hosts; it cannot select arbitrary roots or principals.
- **OpenCode plugin** — drives the same daemon authority from within OpenCode.

Extension adapters, providers, and pricing load only from an explicit **trusted
startup config**; executable paths are never accepted in any daemon RPC, and one
process cannot host daemons with different extension registries.
