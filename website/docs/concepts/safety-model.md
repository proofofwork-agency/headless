---
id: safety-model
title: The Safety Model
sidebar_position: 1
---

# The safety model

Headless assumes the worst about the thing it runs: a coding-agent backend may be prompt-injected, compromised, or intentionally malicious. Safety therefore rests on operating-system containment and credential isolation enforced from outside the backend — not on a backend's own tool-deny rules, which remain defence in depth only.

Everything below is fail-closed: when a control cannot be proven, Headless refuses to run rather than degrading silently.

## Required OS containment, by default

Every worker launches inside a probed OS sandbox:

- **macOS** uses probed, default-deny Seatbelt profiles. Broker workers may reach only the selected loopback broker port; native-login workers may make outbound provider connections, but network *binding* stays denied. Only isolated worker storage — and, for writes, the leased worktree — is writable, with explicit read denials over repository credential files.
- **Linux** requires successful bubblewrap write-denial and backend-seccomp probes. The host and primary checkout are read-only; PID, IPC, and UTS namespaces are isolated; broker workers additionally unshare the network namespace. The seccomp filter denies `AF_UNIX` socket creation, and on x86-64 rejects x32-tagged syscall numbers before native dispatch.
- **Windows** returns `UNSUPPORTED_PLATFORM` before launch.

Missing or degraded capability returns `CONTAINMENT_UNAVAILABLE`. There is no silent fallback to a weaker sandbox.

:::warning
`--unsafe-no-sandbox` is the **only** local containment bypass. Unsafe results and ledger records are visibly marked, and unsafe mode is prohibited for autonomous jobs and councils. The `bypass` *approval policy* is a different thing entirely: it selects the backend's noninteractive tool approval **inside** the outer sandbox and remains subject to project trust, credential scope, budgets, worktree isolation, finality gates, and merge authority.
:::

## Isolated homes and credential capsules

Workers never see your real home directory. Each receives an isolated `HOME`, XDG config/data/cache/runtime roots, and a temporary directory. Ambient API keys, unrelated provider login stores, Git/SSH configuration, shell startup files, keychain exports, and host agent sockets are withheld; repository `.env`, `.env.*`, `.envrc`, and local Git config files are discovered with a bounded fail-closed walk and removed from the worker's readable view.

Native-login workers receive only their **own backend's** allowlisted credential capsule — bounded to 2 MiB per file and 4 MiB total, copied owner-only, and fingerprinted. Symlinks and non-regular files fail closed. The Claude setup-token is stricter still: 4 KiB, format-validated, and injected only as one environment value into the contained Claude process — never copied, persisted, or logged. A Codex worker cannot read Claude's credentials, and no worker can read yours.

## The broker: finite leases, fail-closed budgets

Broker mode is the default authentication mode. Real API keys stay in the daemon; a worker receives only an opaque, short-lived lease scoped to its run, provider, model, endpoint class, request and body limits, duration, and budget. Every run gets finite defaults — 8 requests, 200,000 aggregate input tokens, 32,000 aggregate output tokens, and a $5 cap when trusted pricing exists.

**Unknown price is never zero.** The core pricing registry ships intentionally empty; USD attribution requires trusted dated pricing from a daemon extension. Unknown pricing requires explicit per-run approval and stays reported as unknown — and if any USD ceiling applies while the registry is empty, admission fails closed rather than guessing. Quotas are charged atomically across all concurrent leases, and a daemon crash exhausts crash-unknown allocation instead of making it reusable.

The two authentication modes trade different things away:

| Property | Broker (default) | Native login (explicit) |
| --- | --- | --- |
| Worker credential | Opaque run-scoped lease | The selected backend's bounded auth capsule |
| Network | Broker-only path | Unrestricted outbound provider IP access |
| Request and cost enforcement | Broker request/token/cost caps | Project budgets plus backend-reported evidence |
| Project consent | Normal authority policy | Trust plus explicit unrestricted-egress acknowledgement |

## Writes: leased worktree, candidate, gates, finality

A write worker never mutates your primary checkout. The path is:

1. Write mode requires a **clean** primary worktree; the daemon durably records a preparing lease before `git worktree add` and activates it only after Git succeeds.
2. The backend writes only inside that **leased worktree**, created from a recorded primary `HEAD`.
3. Before a candidate exists, the raw diff, status, and file list are fully bounded and inspected — including a **secret scan**. Any redaction trigger, truncation, or over-limit candidate fails the gate and removes the worktree.
4. Configured `check`/`build`/`test`/`pack` **gates** run in the candidate.
5. Policy, budget, review, and vote requirements produce durable **finality**.
6. An **authorized integration decision** journals through a fsynced write-ahead log and advances primary.

Timeout, cancellation, conflict, secret detection, failed gates, output overflow, and crash ambiguity all preserve the primary checkout. The pattern scan cannot identify every proprietary secret, so retained candidates still deserve normal untrusted-code review.

## The tamper-evident ledger

Runtime state lives outside the repository in an owner-only, project-hashed directory. Ledger entries chain by sequence, previous hash, and SHA-256 — or HMAC-SHA256 when `HEADLESS_LEDGER_KEY` is configured, with key rotation supported and unsigned downgrades rejected. The stable auditor command:

```bash
headless verify
headless verify --evidence
```

exits non-zero at the first sequence, previous-hash, project, digest, key, or HMAC-downgrade break; `--evidence` additionally recomputes each anchored release-evidence file digest. Execution receipts are assembled and ledger-anchored for every terminal run by default — see [Execution receipts](./receipts.md).

Honesty about what the chain proves: an unkeyed chain detects accidental or unaudited modification but can be recomputed by anything that can write the state files. HMAC prevents forgery only while the key stays outside that writer's reach. Neither mode detects deletion of a valid tail without an external head anchor.

## Delegation: depth one, linked holds

An eligible contained worker may ask the daemon — via the run-scoped `run.delegate` operation — to create **at most one** independently contained, read-only child. The child's endpoint omits `run.delegate`, so delegation cannot recurse. The child targets a **different** backend (never the active lead), runs under required containment with a deadline below its parent's and cancellation cascading downward, and composes approval policy conservatively (`ask → ask`, `auto → auto`, `bypass → auto`); a failed child returns a structured error to its parent instead of killing it. The child's budget is carved from the parent's remaining reservation (25% by default, 50% hard maximum), never from new project spend authority. Same-provider children use an atomic sub-reservation; cross-provider children use one crash-atomic linked hold over both provider quotas, with the target bearer minted once and never persisted. Ambiguity after a crash exhausts the affected authority rather than returning it.

## What this does not protect against

The trusted computing base is the local Headless daemon, its configured project and policy, any explicitly configured startup extension modules, the operating system, Bun, Git, bubblewrap or Seatbelt, and — in broker mode — the provider broker. Native-login mode deliberately also trusts the installed official backend CLI with its own minimal scoped account state and outbound provider access.

This is **not** a boundary against an attacker who already controls the same host user, the daemon process, the executable `PATH`, the Bun or Git installation, the OS sandbox itself, or `HEADLESS_LEDGER_KEY`. The same-user operator can read or modify external state and daemon credentials: filesystem modes protect against *other users*, not against malware already running as the owner. Redaction is defence in depth, not a substitute for credential isolation — and a provider request necessarily discloses the selected prompt and context to that provider.

## Trust boundary at a glance

| Surface | Position |
| --- | --- |
| Headless daemon, project policy, configured extension modules | Trusted (review extensions as trusted code) |
| OS, Bun, Git, Seatbelt / bubblewrap | Trusted |
| Provider broker (broker mode) | Trusted |
| Installed official backend CLI (native-login mode) | Trusted with its own scoped account state and provider egress only — outside the filesystem, repository, orchestration, and finality boundaries |
| Backend behaviour, project-controlled agent configuration | Untrusted, always |
| TUI | Observer credential only (`ping` and `observer.*`); no mutation authority |
| Same-user attacker on the host | Out of scope — not a defended boundary |

Read the repository's [SECURITY.md](https://github.com/proofofwork-agency/headless/blob/main/SECURITY.md) for the full model before entrusting Headless with credentials or write mode.
