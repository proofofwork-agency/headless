---
id: grok
title: Grok Build
sidebar_position: 4
---

# Grok Build under Headless

## What it is

Grok Build is xAI's CLI coder (open-sourced as `xai-org/grok-build`). It is the **experimental** backend in Headless: supported for contained read-only work, excluded from the required Gate A backends, and blocked outright when its containment cannot be proven. Headless runs it as a contained worker inside required OS containment (Seatbelt on macOS, bubblewrap plus seccomp on Linux) with an isolated `GROK_HOME`, a Headless-owned configuration, and a bespoke isolation layer that must pass a contained inspection attestation before any provider access. In native-login mode Headless reuses your existing Grok subscription login through a minimal auth capsule — no separate `XAI_API_KEY` is required. The backend id is `grok-build` (alias: `grok`). See the [safety model](../concepts/safety-model.md) for the containment contract.

## Sign up / log in

Log in once with the official CLI — browser OAuth by default, or device auth on a display-less host:

```bash
grok login
# or, on a host without a display:
grok login --device-auth
```

Grok reads credentials **only** from `$GROK_HOME/auth.json` — by default `~/.grok/auth.json` — with no XDG fallback (confirmed against the open-sourced grok-build source). Headless accepts only that file: a canonical, non-symlinked, single-link regular file no larger than 2 MiB, copied owner-only (`0600`) into the isolated worker's `$HOME/.grok/auth.json` and fingerprinted. The copy is disposable: Headless sets `GROK_AUTH_EARLY_INVALIDATION_SECS=0` inside the worker so proactive token refresh cannot silently rotate your real `~/.grok/auth.json` out from under you; reactive 401 refresh-and-retry still covers bounded runs.

### Grant consent and confirm readiness

Native login requires project trust plus explicit acknowledgement that native provider egress is unrestricted:

```bash
PROJECT="/absolute/path/to/your/project"
headless project trust grant --allow-native-direct-unrestricted --cwd "$PROJECT"
headless experimental fleet health --cwd "$PROJECT"
```

Fleet health should report the backend as ready (the observer TUI shows this as `Ready` in its Fleet tab). If Grok reports blocked, its contained isolation attestation did not prove the required isolation — do not try to bypass it. For credential and trust diagnoses, see [Understand "login required"](../troubleshooting/login-required.md).

### What the attestation gate does

Grok's installed CLI can load repo-local configuration (MCP servers, hooks, plugins) gated behind folder trust, and it can report a project with no such files as vacuously trusted. Headless does not take its word for it:

- The worker gets a Headless-owned `config.toml` in its isolated `GROK_HOME`, environment-level disables for every Cursor/Claude/Codex compatibility cell, no memory, subagents, web fetch, auto-update, or telemetry, a Headless system-prompt override, and startup-snapshot masks over project control paths that existed at launch.
- Before any provider access, a contained, **network-denied** `grok inspect --json` must attest that project instructions, hooks, skills, plugins, MCP, LSP, permission sources, and every compatibility cell are disabled.
- When the project is vacuously trusted (no gated control files exist), Headless creates a worker-owned canary project containing one inert MCP control file and requires the same strict inspection to report `projectTrusted: false` there — proving the trust gate is actually active.

A missing, failed, or contradictory attestation blocks the run with a structured failure. It is never bypassed, and Grok stays blocked when the installed version cannot produce the evidence.

## How to run it

One bounded, read-only contained run on your subscription:

```bash
headless exec --cwd "$PROJECT" \
  --backend grok-build \
  --auth-mode native-login \
  --approval-policy ask \
  --timeout-ms 60000 \
  --json -- "Reply with OK only. Do not use tools."
```

- `--backend grok` is an accepted alias for `grok-build`.
- **Read-only only.** Grok's `canWrite` is `false`: `--mode write` fails closed with `Backend grok-build does not support write mode in Headless yet.` Direct Grok write execution remains blocked until its write gate is complete.
- The admitted built-in tool set is deliberately limited: read-only runs allow `read_file`, `grep`, and `list_dir` — shell execution is removed from the admitted tool surface entirely.
- `--model` is optional; omission uses the Grok CLI's configured default.
- Grok supports named backend agents: `--agent <name>` must be an agent **name** — definition-file paths and flag-like values are rejected at admission.
- A prompt beginning with `-` belongs after `--`.

Without `--json`, a completed run prints the coder's final text output (redacted and bounded), plus a `cost / tokens / time` summary line on stderr when the provider reported usage; the exit code is `0` on `succeeded`, `1` otherwise. With `--json` you get the full structured `RunResult`, including `network: "native-direct-unrestricted"`, `credential: backend-native` evidence, and `amountUsd: null` unless the CLI reported a real charge.

Persistent sessions are an experimental surface (disabled by default in Beta 1; the `headless experimental session` commands opt in explicitly). Grok's driver is experimental structured execution after the contained compatibility attestation, recovering with `--resume <session-id>`, and the agent choice is persisted across create/resume:

```bash
headless experimental session create --backend grok-build --auth-mode native-login --cwd "$PROJECT"
headless experimental session send --session-id <session-id> --cwd "$PROJECT" -- "Continue: list the modules you inspected."
headless experimental session status --session-id <session-id> --cwd "$PROJECT"
```

Broker mode remains available with `XAI_API_KEY` in the daemon environment (omit `--auth-mode`; broker is the default).

## How to become lead

The foreground lead is the interactive provider CLI **you** launch and drive; Headless never launches or controls it. `lead use` binds that host to the project daemon with a generation-specific MCP credential, giving your visible Grok session daemon authority (dispatching bounded servants, deliberations, goals) while every worker stays contained. Grok installs its Headless MCP entry through its native MCP installer. Note the asymmetry: the lead role is about your interactive session holding daemon authority — contained Grok *workers* remain read-only regardless of who leads.

```bash
headless init --lead grok --cwd "$PROJECT"
headless lead status --cwd "$PROJECT"
```

Or the equivalent explicit sequence:

```bash
headless init --cwd "$PROJECT"
headless mcp install grok --cwd "$PROJECT"
headless lead use grok --cwd "$PROJECT"
```

`init --lead` creates external per-project state, installs the host's MCP entry, and binds the lead — it does **not** grant project trust, native egress, write authority, or approval bypass. The bound host attaches and heartbeats; one that stops heartbeating becomes `disconnected`, and Headless does not elect or launch a replacement. Switching hosts with `lead use` rotates the credential generation and invalidates the previous one while preserving all project work; `headless lead release --cwd "$PROJECT"` removes the binding without cancelling jobs or deleting state. Automatic worker routing excludes the active lead backend, so a Grok lead is served by non-Grok workers unless you name `grok-build` explicitly.

## How to track it in the TUI

```bash
headless tui --cwd "$PROJECT"
```

The TUI is a strictly read-only observer over `observer.snapshot` and `observer.events` — watch it, never expect it to interfere. It cannot dispatch runs, resolve approvals, or launch providers.

- **Fleet (key `2`)** — Grok's readiness (`Ready`, `Login required`, `Blocked by containment`, …) and auth mode. Grok renders in its stable identity color (violet) wherever it is named. When readiness is `Login required`, the detail pane displays the login command (`grok login` / `grok login --device-auth`) for you to run externally; a blocked attestation surfaces as a blocked readiness with recovery guidance.
- **Events (key `5`)** — the live run-event feed for your Grok jobs, with `e` (errors), `a` (activity), and `v` (compact/verbose/strict) filters.
- **Goals (key `3`) / Approvals (key `4`)** — goal stages and pending approvals when Grok participates in orchestration; the Approvals view prints the exact `headless experimental approval resolve …` command to run from your shell.
- **Config (key `6`)** — project trust, lead binding, budgets, backend readiness, and daemon state.

Navigate with `Tab`/`Shift-Tab`, number keys `1`–`7`, arrows, `PgUp`/`PgDn`, and the mouse (click tabs and rows, wheel scrolls); `r` refreshes, `q` or `Ctrl-C` exits without stopping detached work. The complete walkthrough is in the [TUI guide](../guides/tui.md).

## Capabilities and limits

| Property | Value |
| --- | --- |
| Backend id / aliases | `grok-build` / `grok` |
| Status | **Experimental** — excluded from the required Gate A backends; blocked without a passing attestation |
| Read (`--mode read-only`) | Yes (default), with a limited tool allowlist: `read_file`, `grep`, `list_dir` (no shell) |
| Write (`--mode write`) | **No** — fail-closed (`canWrite: false`); direct write execution remains blocked |
| Native resume | Yes (structured resume via `--resume <session-id>` after attestation) |
| Streaming / structured output | Yes / Yes |
| Cancellation | Yes (bounded process-tree termination) |
| Effort control | No |
| Named `--agent` | Supported (names only; persisted across session create/resume) |
| Broker compatible | Yes (`XAI_API_KEY` in the daemon environment) |
| Prompt delivery | native |
| Default timeout | 180000 ms |
| Minimum probed CLI version | 0.2.99 |
| Containment notes | Bespoke isolation: Headless-owned `config.toml` in isolated `GROK_HOME`; every Cursor/Claude/Codex compatibility cell disabled; no memory, subagents, web fetch, auto-update, or telemetry; Headless system-prompt override; startup-snapshot masks over project control paths; contained network-denied `grok inspect --json` attestation plus trust-canary check required before provider access; credential source `~/.grok/auth.json` only, with in-worker proactive token refresh disabled |

Full credential contract: the canonical [native-login.md](https://github.com/proofofwork-agency/headless/blob/main/docs/native-login.md) in the repository.
