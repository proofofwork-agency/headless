---
id: containment
title: Containment
---

# Containment

Every backend is treated as arbitrary code execution. Required containment is
the default, and an unavailable sandbox is an error — never an automatic
downgrade.

## The isolated worker

For a required run, Headless creates a private worker root with a separate
`HOME`, XDG config/data/cache/runtime directories, and temporary directory. The
worker never inherits:

- the real home directory,
- ambient API keys,
- Git or SSH configuration,
- shell startup files,
- keychain exports,
- unrelated provider state, or
- host agent sockets.

Repository `.env`, `.env.*`, `.envrc`, and local/common/linked-worktree Git
config files are discovered recursively with a fail-closed bound, then denied on
macOS and over-mounted on Linux. Ordinary project source stays readable.

## Auth capsule

In native-login mode, Headless copies only the selected backend's minimal
regular-file auth allowlist into the private root. Files are size-bounded, reject
symlinks, use owner-only permissions, and contribute to an auth-profile
fingerprint. In broker mode no native login state enters the worker; the daemon
injects only a short-lived token scoped to the run, provider, model, routes,
duration, and budget.

## Platform mechanisms

### macOS — Seatbelt

Separate default-deny Seatbelt profiles for read and write modes. Project access
is read-only, only a leased write worktree may be writable, its `.git` pointer
stays immutable, and network binding remains denied. Broker runs allow only the
selected loopback broker port; native-login runs permit provider-direct outbound
connections plus narrow TLS service lookups.

### Linux — bubblewrap + seccomp

Requires successful bubblewrap and seccomp capability probes. The host and
primary checkout are read-only, worker storage is writable, the write worktree is
the only writable project view, and PID/IPC/UTS namespaces are isolated. Broker
mode also isolates the network namespace. On x86-64 the filter rejects the x32
syscall ABI before native syscall matching. A non-dumpable supervisor owns
loopback-only broker and run-tool proxies; the backend cannot create Unix sockets
or inspect the supervisor.

## Defense in depth

Native backend restrictions remain even inside the sandbox: OpenCode project
configuration, plugins, and skills are disabled; Claude receives tool
restrictions; Codex combines its native sandbox with explicit disables; and Grok
has isolated-config, prompt/tool, and startup-snapshot hardening (and stays
fail-closed on required runs until late-created project controls can be denied on
both platforms).

## The unsafe escape hatch

`--unsafe-no-sandbox` is a separate, explicit local containment escape hatch. It
is **not** the `bypass` approval policy — bypass stays inside Headless
containment and all fleet/write gates. Unsafe runs are visibly marked in the
result and ledger and are rejected by autonomous orchestration and councils.

## Run-scoped cooperation credential

Every daemon-owned required run receives a separate owner-only Unix endpoint and
an in-memory, short-lived credential bound to the exact project, job, session,
and principal. A disposable `headless-run-tool` helper exposes only bounded
cooperation operations (context, notes, messages, task status, artifacts,
finality proposals). It cannot start runs, choose a filesystem root, change
policy or budgets, grant authority, or merge writes. The daemon destroys the
listener when the run terminates; unsafe runs never receive it.

See [SECURITY.md](https://github.com/proofofwork-agency/headless/blob/main/SECURITY.md)
for the full threat model and exact limits.
