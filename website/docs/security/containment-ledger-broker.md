---
title: Containment, broker, and ledger
sidebar_position: 1
description: The OS boundary, default broker authority, native-login exception, durable ledger, and observer-only TUI.
---

# Containment, broker, and ledger

Headless assumes every backend can be prompt-injected or malicious. Tool-deny
flags are defense in depth; the security boundary is the authenticated daemon,
its policy and budgets, operating-system containment, scoped credentials, and
durable verification.

## Required containment

Every required worker gets isolated HOME, XDG, runtime, cache, and temporary
roots. The project is read-only unless a daemon-leased write worktree is
explicitly admitted. The real home, sibling-provider credentials, ambient API
keys, Git/SSH state, shell startup files, host agent sockets, project `.env`
files, and project-controlled backend plugins are withheld.

macOS uses a probed default-deny Seatbelt profile. Linux uses bubblewrap,
namespaces, a loopback relay where needed, and an architecture-checked seccomp
filter. Missing boundary capabilities fail with `CONTAINMENT_UNAVAILABLE`; an
optional cooperation-helper failure never silently weakens the sandbox.

## Broker by default

Broker workers receive an opaque run-scoped lease rather than a provider key.
The daemon validates provider, model, endpoint, request body, duration, request
count, input/output tokens, and priced cost before forwarding. Aggregate limits
are shared across every lease for the reservation, and crash-unknown usage is
exhausted rather than reused.

Native login is an explicit exception. It requires project trust plus
`--allow-native-direct-unrestricted`, copies only a backend allowlist of bounded
regular files, and reports `native-direct-unrestricted` with unknown cost unless
the CLI supplies a real charge. Keychain-only Claude login on macOS remains
unsupported under required Seatbelt containment; Headless will not expose the
real home or forward an ambient token to make it work.

Native one-shots and sessions run the same backend environment-preparation hook
after isolation. Codex receives read-only system CA bundle paths so TLS works
without widening Seatbelt; the hook is tested not to restore credentials or
host control paths.

## Durable state and observer authority

Project state lives outside the checkout and is keyed by the canonical-root
hash. Jobs reach a durable terminal result before completion events are
projected. Protected records retain hash-chain verification, and known schema
evolution is decoded only at durable read boundaries; new writes and RPC remain
strict.

The TUI has a dedicated observer credential limited to `ping` and
`observer.*`. Its Config pane reads the same snapshots as its log views and
only generates root-CLI commands. It cannot dispatch work, resolve approvals,
change trust or budgets, integrate candidates, or control provider processes.

For the complete threat model and limitations, read the repository's
[SECURITY.md](https://github.com/proofofwork-agency/headless/blob/main/SECURITY.md).
