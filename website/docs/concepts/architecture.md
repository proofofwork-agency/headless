---
id: architecture
title: Architecture and Data Flow
sidebar_position: 1
description: How one authenticated project daemon owns policy, execution, broker egress, durable state, and recovery.
---

# Architecture and data flow

Headless is a local control plane, not a collection of independent CLI wrappers. For each canonical project root, exactly one authenticated daemon owns admission, authority, budgets, queues, worker launch, broker leases, durable state, and recovery. CLI processes, the attached MCP lead, and the TUI are clients of that authority; none of them writes the project state stores directly.

```text
root CLI        foreground MCP lead        observer TUI
   │                    │                       │
   │ authenticated RPC  │ generation-bound RPC │ observer-only RPC
   └────────────────────┴───────────┬───────────┘
                                    ▼
                         one project daemon
                    policy → budget → FIFO queue
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
          contained worker process        finite provider broker
          isolated HOME + worktree         daemon-held credentials
                    │                               │
                    └──────── result / usage ───────┘
                                    │
                                    ▼
                 jobs + events + hash-chained ledger
                         + execution receipts
                                    │
                                    ▼
                         boot reconciliation
```

The visible provider lead remains an ordinary process launched by the operator. Headless binds it over a generation-specific MCP credential; it does not inject into, elect, restart, or kill that provider process. Workers are separate processes launched by the daemon under the [selected modes](./modes.md) and [required containment](./containment.md).

## Component responsibilities

| Component | Owns | Does not own |
| --- | --- | --- |
| Root CLI | Explicit operator requests, trust and budget administration, approval resolution, candidate decisions | Durable truth or direct worker execution |
| Foreground MCP lead | Bounded delegation, deliberation, fleet and goal operations allowed by its generation-bound credential | Root trust, credential administration, approval resolution, or provider lifecycle |
| Observer TUI | `observer.snapshot` and `observer.events`, navigation, copyable root-CLI guidance | Any mutation, provider login, run dispatch, approval, cancellation, or integration |
| Project daemon | Authentication, authorization, policy, budgets, queueing, sessions, skills, workflows, worker and broker lifecycle, durable projections | Provider account ownership or the operator's primary shell |
| Worker | One admitted backend turn inside its isolated runtime and readable project view | Daemon state, ambient credentials, or primary-checkout integration |
| Provider broker | Finite lease validation, route/model/body/token/cost enforcement, provider authentication | General worker networking or durable run authority |
| Ledger and receipt stores | Append-only attributable events and per-run verifiable evidence | Prevention of a same-user host compromise; see [the safety model](./safety-model.md) |

## One owner per project

The project root is canonicalized before use. Its SHA-256 digest becomes the project ID and namespaces every durable store. The daemon binds an owner-only Unix socket for that project; a second daemon that can reach the live socket receives `DAEMON_ALREADY_RUNNING`. A stale, unreachable socket may be removed, but mutable stores are not opened until the new process has successfully won socket ownership.

The socket itself lives under a short owner-only runtime directory (by default `/tmp/headless-<uid>`) because Unix socket paths are tightly bounded on macOS. Durable state lives elsewhere:

| Platform | Default state home |
| --- | --- |
| macOS | `~/Library/Application Support/Headless` |
| Linux with XDG | `$XDG_STATE_HOME/headless` |
| Linux fallback | `~/.local/state/headless` |

`HEADLESS_STATE_HOME` and `HEADLESS_RUNTIME_HOME` can override those roots. Under the state home, the daemon uses `projects/<sha256-of-canonical-project>/...` for jobs, sessions, receipts, budgets, goals, workflows, skills, the ledger, and recovery journals. Directories are repaired to mode `0700` and files to `0600`; symlinked state paths fail closed. Headless does not create a repository-local `.headless` directory or edit `.gitignore`.

:::warning Same-user boundary
Owner-only modes protect state from other OS users. They do not protect it from malware already running as the same user, from a compromised daemon, or from a compromised Bun/Git/OS toolchain.
:::

## Request path

1. A client connects to the project socket and presents a root, observer, integration, run-scoped, or generation-bound credential.
2. The daemon authorizes the route before accepting its parameters. Observer credentials are limited to observer operations; client-supplied principals and project roots are ignored or rejected.
3. A run request is normalized, bound to any persisted session, and checked against backend capability, project trust, approval policy, budgets, queue capacity, and total deadline.
4. The durable job is created before execution. The FIFO scheduler admits it only when the project and scoped concurrency limits permit.
5. The daemon creates an isolated worker environment and, for writes, a leased Git worktree. It launches the backend under the platform sandbox.
6. Broker-auth workers reach only the finite broker path; native-login workers receive only that backend's allowlisted capsule and provider-direct IP egress.
7. Results, usage, policy events, artifacts, and terminal state are persisted and redacted at trusted boundaries. Authorized terminal runs produce [execution receipts](./receipts.md) anchored to the hash/HMAC-chained ledger.

For the exact operator surface, use the generated [command reference](https://github.com/proofofwork-agency/headless/blob/main/docs/command-reference.md). The [CLI guide](../guides/cli.md) and [TUI guide](../guides/tui.md) show the same architecture from the two user-facing clients.

## Startup and crash reconciliation

Durability is not just serialization. After binding the socket, startup reconstructs authority in a deliberate order: it restores manual linked-hold decisions, starts the broker, reconciles worktree leases and candidate integration journals, recovers interrupted jobs, repairs terminal run events, rebuilds missing receipts from their write-ahead journal, completes terminal persistent sessions and skill invocations, and recovers task and orchestration projections. Ambiguous budget, worktree, integration, or linked-hold state fails closed instead of returning authority that may have been spent.

Receipt recovery is deliberately non-fatal to daemon availability: one malformed receipt marker is diagnosed and left for repair while unrelated state becomes ready. By contrast, an ambiguous primary-checkout integration journal can block readiness because continuing could mutate the wrong Git state.

## Build and restart boundary

The daemon has no hot-reload path. Backend definitions, extension manifests, pricing, policy services, and runtime code are fixed when the process starts. After rebuilding or changing a trusted startup extension, restart the project daemon:

```bash
bun run build
headless daemon stop --cwd "$PROJECT"
headless daemon status --cwd "$PROJECT"
```

Expected: `stop` terminates the authenticated socket owner. The next daemon-backed command starts the rebuilt daemon; `status` confirms the active runtime. Never infer that a running daemon picked up new files merely because `dist/` changed.

## Related

- [Modes](./modes.md) — the four independent policy axes attached to a run.
- [Containment](./containment.md) — Seatbelt, bubblewrap, seccomp, and the run-tool relay.
- [Persistent sessions](./sessions.md) — multi-turn state and native resume.
- [Portable skills](./skills.md) — immutable instruction bundles with durable invocation evidence.
- [Leads and the fleet](./leads-and-fleet.md) — the visible lead and contained servants.
