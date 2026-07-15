---
title: Security model
sidebar_position: 1
description: Required OS containment, bounded authentication, broker leases, approvals, gated worktrees, durable evidence, and observer-only access.
---

# Security model

Headless assumes every backend can be prompt-injected, buggy, or malicious.
Backend flags are defense in depth. The actual boundary is the authenticated
daemon, strict runtime contracts, OS containment, finite authority, durable
state, and fail-closed recovery.

## Required containment

Every worker receives isolated HOME, XDG, runtime, cache, and temporary roots.
The project is read-only unless the daemon admits a leased write worktree.
Ambient API keys, sibling-provider logins, Git and SSH credentials, shell
startup files, keychain exports, host agent sockets, repository `.env` files,
and project-controlled backend plugins are withheld.

- **macOS:** a probed, default-deny Seatbelt profile limits file, process,
  socket, signal, and network operations.
- **Linux:** bubblewrap namespaces and an architecture-checked seccomp filter
  provide the boundary; broker and run-tool relays are explicit capabilities.
- **Windows:** execution fails before launch with `UNSUPPORTED_PLATFORM`.

Missing required boundary capabilities return `CONTAINMENT_UNAVAILABLE`.
Headless does not silently fall back to an unsafe worker.

## Two authentication modes

| Property | Broker, default | Native login, explicit |
| --- | --- | --- |
| Worker credential | Opaque run-scoped lease | Selected backend's bounded auth capsule |
| Network | Broker-only path | Unrestricted outbound provider IP access |
| Request and cost enforcement | Broker request/token/cost caps | Project budgets plus backend-reported evidence |
| Project consent | Normal authority policy | Trust plus explicit unrestricted-egress acknowledgement |

Auth capsules accept only canonical, single-link regular files from fixed
locations. Claude's setup-token is a special environment capsule: a validated,
owner-only `~/.claude/.headless-setup-token` is fingerprinted and injected only
into the contained Claude native-login process. The raw token never enters
daemon state, logs, results, or the ledger.

Grok remains experimental. Headless creates a worker-owned inert trust canary
and requires a network-denied `grok inspect --json` to prove that project
instructions, hooks, skills, plugins, MCP, LSP, permissions, and compatibility
surfaces remain disabled before provider access.

## Approval and write boundaries

Read-only is the default. A contained write turn requires a one-turn coder-tool
approval. Work then occurs in a daemon-leased worktree—not primary—and the
candidate must pass bounded diff inspection, secret scanning, configured
project gates, budget and policy finality, and a separate authorized integration
decision. A timeout, conflict, unknown state, or failed gate leaves primary
unchanged.

The live Breakout capstone demonstrated this boundary: timed-out candidates
were refused, a passing candidate waited for explicit approval, and only then
did a journaled fast-forward advance primary.

## Durable evidence and fail-closed recovery

Terminal results are durable before completion events. Protected records carry
hash-chain evidence. Schema evolution is accepted only at explicit durable read
boundaries; unknown values fail closed. Crash-unknown broker or delegation
authority is exhausted rather than reused.

Cross-provider depth-one delegation uses an atomic linked hold across parent
and target provider quotas. Recovery replays exact token-free observations and
settlement digests. A contradictory hold blocks readiness until an admin
inspects and quarantines one exact link with its expected digest; there is no
automatic bulk discard.

## Observer-only TUI

The TUI credential is limited to `ping` and `observer.*`. The log and Config
views can read snapshots/events and generate copy-paste root commands. They
cannot submit work, resolve approvals, integrate candidates, change trust or
budgets, or control provider processes.

Read the complete [SECURITY.md](https://github.com/proofofwork-agency/headless/blob/main/SECURITY.md)
before using native credentials or write mode.
