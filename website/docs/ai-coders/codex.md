---
id: codex
title: Codex
sidebar_position: 2
---

# Codex under Headless

## What it is

Codex is OpenAI's official CLI coder. Headless runs it as a contained worker: the daemon launches `codex` inside required OS containment (Seatbelt on macOS, bubblewrap plus seccomp on Linux) with an isolated `HOME`, a read-only project mount, and project plugins, hooks, native multi-agent fan-out, apps/browser/computer-use surfaces, and repository skill roots disabled. Codex also self-sandboxes, which Headless treats as defense in depth on top of its own boundary. In native-login mode Headless reuses your existing Codex subscription login through a minimal auth capsule — no separate `OPENAI_API_KEY` is required. The backend id is `codex` (alias: `codex-cli`), and the prompt is delivered over stdin. See the [safety model](../concepts/safety-model.md) for the containment contract.

## Sign up / log in

Log in once with the official CLI:

```bash
codex login
```

That produces the fixed canonical credential file `~/.codex/auth.json`. Headless accepts only that source: it must be a canonical, non-symlinked, single-link regular file no larger than 2 MiB. Headless copies it owner-only (`0600`) into the isolated worker's `$HOME/.codex/auth.json` and fingerprints the exact contents for session-recovery checks — it never mounts your real home, and the worker receives no sibling-provider files, ambient API keys, Git/SSH material, or host sockets. So that TLS validation works from the isolated home on macOS, the contained Codex process additionally receives the read-only system trust-store paths `SSL_CERT_FILE=/etc/ssl/cert.pem` and `SSL_CERT_DIR=/etc/ssl/certs`.

### Grant consent and confirm readiness

Native login requires project trust plus explicit acknowledgement that native provider egress is unrestricted:

```bash
PROJECT="/absolute/path/to/your/project"
headless project trust grant --allow-native-direct-unrestricted --cwd "$PROJECT"
headless experimental fleet health --cwd "$PROJECT"
```

Fleet health should report the backend as ready (the observer TUI shows this as `Ready` in its Fleet tab). If it reports `login_required` even though `codex login` succeeded, the cause is usually missing trust or a broker-default fleet profile — see [Fleet says "login required"](../troubleshooting/login-required.md).

## How to run it

One bounded, read-only contained run on your subscription:

```bash
headless exec --cwd "$PROJECT" --backend codex --auth-mode native-login --json -- "Inspect only."
```

- `--backend codex-cli` is an accepted alias.
- Read-only execution is the default. `--mode write` is supported: the mutating turn runs in a daemon-leased worktree (never primary) and passes secret scanning, gates, finality, and an authorized integration decision.
- `--model` is optional; omission uses the Codex CLI's configured default.
- `--timeout-ms` bounds the run (default 180000 ms); `--approval-policy ask|auto|bypass` selects how mutating tool turns are approved.
- Codex rejects the `--agent` option rather than silently ignoring it (named backend agents exist only for OpenCode and Grok).
- A prompt beginning with `-` belongs after `--`.

Without `--json`, a completed run prints the coder's final text output (redacted and bounded), plus a `cost / tokens / time` summary line on stderr when the provider reported usage; the exit code is `0` on `succeeded`, `1` otherwise. With `--json` you get the full structured `RunResult`, including `network: "native-direct-unrestricted"`, `credential: backend-native` evidence, and `amountUsd: null` unless the CLI reported a real charge.

Persistent sessions are an experimental surface (disabled by default in Beta 1; the `headless experimental session` commands opt in explicitly). Codex has the strongest session story: the preferred driver is the hidden persistent `codex app-server` after a JSON-RPC handshake, with `codex exec resume` as the recovery fallback:

```bash
headless experimental session create --backend codex --auth-mode native-login --cwd "$PROJECT"
headless experimental session send --session-id <session-id> --cwd "$PROJECT" -- "Continue: list the public entry points."
headless experimental session status --session-id <session-id> --cwd "$PROJECT"
```

Broker mode remains the tighter alternative: start the daemon with `OPENAI_API_KEY` in its environment and omit `--auth-mode` (broker is the default); the worker then receives only an opaque, finite lease instead of any key.

## How to become lead

The foreground lead is the interactive provider CLI **you** launch and drive; Headless never launches or controls it. `lead use` binds that host to the project daemon with a generation-specific MCP credential, giving your visible Codex session daemon authority (dispatching bounded servants, deliberations, goals) while every worker stays contained. Codex is the recommended first lead in the docs:

```bash
headless init --lead codex --cwd "$PROJECT"
headless lead status --cwd "$PROJECT"
```

Or the equivalent explicit sequence:

```bash
headless init --cwd "$PROJECT"
headless mcp install codex --cwd "$PROJECT"
headless lead use codex --cwd "$PROJECT"
```

`init --lead` creates external per-project state, installs the host's MCP entry, and binds the lead — it does **not** grant project trust, native egress, write authority, or approval bypass. The bound host attaches and heartbeats; one that stops heartbeating becomes `disconnected`, and Headless does not elect or launch a replacement. Switching hosts with `lead use` rotates the credential generation and invalidates the previous one while preserving all project work; `headless lead release --cwd "$PROJECT"` removes the binding without cancelling jobs or deleting state. Automatic worker routing excludes the active lead backend, so a Codex lead is served by non-Codex workers unless you name `codex` explicitly.

## How to track it in the TUI

```bash
headless tui --cwd "$PROJECT"
```

The TUI is a strictly read-only observer over `observer.snapshot` and `observer.events` — watch it, never expect it to interfere. It cannot dispatch runs, resolve approvals, or launch providers.

- **Fleet (key `2`)** — Codex's readiness (`Ready`, `Login required`, `Blocked by containment`, …) and auth mode. Codex renders in its stable identity color (blue) wherever it is named. When readiness is `Login required`, the detail pane displays the login command (`codex login`) for you to run externally.
- **Events (key `5`)** — the live run-event feed for your Codex jobs, with `e` (errors), `a` (activity), and `v` (compact/verbose/strict) filters.
- **Goals (key `3`) / Approvals (key `4`)** — goal stages and pending approvals when Codex participates in orchestration; the Approvals view prints the exact `headless experimental approval resolve …` command to run from your shell.
- **Config (key `6`)** — project trust, lead binding, budgets, backend readiness, and daemon state.

Navigate with `Tab`/`Shift-Tab`, number keys `1`–`7`, arrows, `PgUp`/`PgDn`, and the mouse (click tabs and rows, wheel scrolls); `r` refreshes, `q` or `Ctrl-C` exits without stopping detached work. The complete walkthrough is in the [TUI guide](../guides/tui.md).

## Capabilities and limits

| Property | Value |
| --- | --- |
| Backend id / aliases | `codex` / `codex-cli` |
| Read (`--mode read-only`) | Yes (default) |
| Write (`--mode write`) | Yes — leased worktree, gates, and authorized integration |
| Native resume | Yes (persistent `codex app-server` driver; `codex exec resume` fallback) |
| Streaming / structured output | Yes / Yes |
| Cancellation | Yes (bounded process-tree termination) |
| Effort control | No |
| Named `--agent` | Rejected |
| Broker compatible | Yes (`OPENAI_API_KEY` in the daemon environment) |
| Prompt delivery | stdin |
| Default timeout | 180000 ms |
| Minimum probed CLI version | 0.144.1 |
| Containment notes | Hardened profile: project config, hooks, MCP, and skills disabled; self-sandboxed on top of required outer containment; capsule source `~/.codex/auth.json` only; system CA bundle paths injected on macOS |

Full credential contract: the canonical [native-login.md](https://github.com/proofofwork-agency/headless/blob/main/docs/native-login.md) in the repository.
