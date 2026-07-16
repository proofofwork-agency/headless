---
id: opencode
title: OpenCode
sidebar_position: 3
---

# OpenCode under Headless

## What it is

OpenCode is the open-source, multi-provider CLI coder — and Headless's reference backend, with live exec, session, and write evidence in the current tree. Headless runs it as a contained worker: the daemon launches `opencode` inside required OS containment (Seatbelt on macOS, bubblewrap plus seccomp on Linux) with an isolated `HOME`/XDG layout and a read-only project mount, in pure mode with project configuration, default plugins, and external/Claude-Code skills explicitly disabled. In native-login mode Headless reuses your existing OpenCode login through a minimal auth capsule — no separate provider API key is required. The backend id is `opencode` (alias: `headless-opencode`; it is also the default when `--backend` is omitted), and the prompt is delivered as an argument. See the [safety model](../concepts/safety-model.md) for the containment contract.

## Sign up / log in

Log in once with the official CLI:

```bash
opencode auth login
```

That stores credentials at the fixed canonical source `~/.local/share/opencode/auth.json` (the `$XDG_DATA_HOME` location). Headless accepts only that source: a canonical, non-symlinked, single-link regular file no larger than 2 MiB, copied owner-only (`0600`) into the isolated worker at `$XDG_DATA_HOME/opencode/auth.json` and fingerprinted for session-recovery checks. The worker receives none of your host OpenCode plugins, MCP entries, commands, permissions, or agents.

### The model default is fail-closed

OpenCode is the one backend where model omission consults host metadata. If a native run omits `--model`, Headless reads at most 64 KiB from the first present fixed global file — `~/.config/opencode/opencode.json`, then `opencode.jsonc` — and extracts **only** the scalar `model` value, passing it explicitly as `--model`. Host `XDG_CONFIG_HOME`, `OPENCODE_CONFIG`, and alternate config paths are intentionally ignored as untrusted control-plane surfaces. If neither fixed file contains a safe scalar `model` (or the file is malformed, oversized, linked, or non-owner), the run returns `NATIVE_AUTH_UNAVAILABLE` before any OpenCode process launches. Passing an explicit `--model` takes precedence and skips the host read entirely.

### Grant consent and confirm readiness

Native login requires project trust plus explicit acknowledgement that native provider egress is unrestricted:

```bash
PROJECT="/absolute/path/to/your/project"
headless project trust grant --allow-native-direct-unrestricted --cwd "$PROJECT"
headless experimental fleet health --cwd "$PROJECT"
```

Fleet health should report the backend as ready (the observer TUI shows this as `Ready` in its Fleet tab). If it does not, read the mode-specific credential, capsule/model-resolution, or trust reason before changing authentication — see [Understand "login required"](../troubleshooting/login-required.md).

## How to run it

One bounded, read-only contained run on your subscription:

```bash
headless exec \
  --backend opencode \
  --auth-mode native-login \
  --mode read-only \
  --timeout-ms 120000 \
  --json \
  --cwd "$PROJECT" \
  -- "Inspect this project and identify its public entry points."
```

- `--backend headless-opencode` is an accepted alias; omitting `--backend` selects `opencode`.
- Read-only execution is the default. `--mode write` is supported: the mutating turn runs in a daemon-leased worktree (never primary) and passes secret scanning, gates, finality, and an authorized integration decision.
- `--model` is optional in native mode (see the fail-closed default above). In broker mode, name a provider-qualified model such as `--model openai/gpt-5`.
- OpenCode supports named backend agents: `--agent <name>` must be an agent **name** — definition-file paths and flag-like values are rejected at admission.
- A prompt beginning with `-` belongs after `--`.

Without `--json`, a completed run prints the coder's final text output (redacted and bounded), plus a `cost / tokens / time` summary line on stderr when the provider reported usage; the exit code is `0` on `succeeded`, `1` otherwise. With `--json` you get the full structured `RunResult`, including `network: "native-direct-unrestricted"`, `credential: backend-native` evidence, and `amountUsd: null` unless the CLI reported a real charge.

Persistent sessions are an experimental surface (disabled by default in Beta 1; the `headless experimental session` commands opt in explicitly). OpenCode's driver is structured `opencode run`, resuming with `--session <session-id>`, and the agent choice is persisted across create/resume:

```bash
headless experimental session create --backend opencode --auth-mode native-login --cwd "$PROJECT"
headless experimental session send --session-id <session-id> --cwd "$PROJECT" -- "Continue: summarize the request schema."
headless experimental session status --session-id <session-id> --cwd "$PROJECT"
```

One documented quirk: an isolated OpenCode worker may exit successfully after its one-time local database migration without handling the requested turn. Headless recognizes that exact migration evidence and repeats the identical command once in the same worker, inside the same turn deadline — you may notice the extra attempt in the events feed, never a third one.

## How to become lead

The foreground lead is the interactive provider CLI **you** launch and drive; Headless never launches or controls it. `lead use` binds that host to the project daemon with a generation-specific MCP credential, giving your visible OpenCode session daemon authority (dispatching bounded servants, deliberations, goals) while every worker stays contained. For OpenCode the MCP installer safely merges its **global** configuration outside the checkout (with manual fallbacks where automation cannot finish):

```bash
headless init --lead opencode --cwd "$PROJECT"
headless lead status --cwd "$PROJECT"
```

Or the equivalent explicit sequence:

```bash
headless init --cwd "$PROJECT"
headless mcp install opencode --cwd "$PROJECT"
headless lead use opencode --cwd "$PROJECT"
```

`init --lead` creates external per-project state, installs the host's MCP entry, and binds the lead — it does **not** grant project trust, native egress, write authority, or approval bypass. The bound host attaches and heartbeats; one that stops heartbeating becomes `disconnected`, and Headless does not elect or launch a replacement. Switching hosts with `lead use` rotates the credential generation and invalidates the previous one while preserving all project work; `headless lead release --cwd "$PROJECT"` removes the binding without cancelling jobs or deleting state. Automatic worker routing excludes the active lead backend, so an OpenCode lead is served by non-OpenCode workers unless you name `opencode` explicitly.

## How to track it in the TUI

```bash
headless tui --cwd "$PROJECT"
```

The TUI is a strictly read-only observer over `observer.snapshot` and `observer.events` — watch it, never expect it to interfere. It cannot dispatch runs, resolve approvals, or launch providers.

- **Fleet (key `2`)** — OpenCode's readiness (`Ready`, `Login required`, `Blocked by containment`, …) and auth mode. OpenCode renders in its stable identity color (green) wherever it is named. When readiness is `Login required`, the detail pane displays the login command (`opencode auth login`) for you to run externally.
- **Events (key `5`)** — the live run-event feed for your OpenCode jobs, with `e` (errors), `a` (activity), and `v` (compact/verbose/strict) filters.
- **Goals (key `3`) / Approvals (key `4`)** — goal stages and pending approvals when OpenCode participates in orchestration; the Approvals view prints the exact `headless experimental approval resolve …` command to run from your shell.
- **Config (key `6`)** — project trust, lead binding, budgets, backend readiness, and daemon state.

Navigate with `Tab`/`Shift-Tab`, number keys `1`–`7`, arrows, `PgUp`/`PgDn`, and the mouse (click tabs and rows, wheel scrolls); `r` refreshes, `q` or `Ctrl-C` exits without stopping detached work. The complete walkthrough is in the [TUI guide](../guides/tui.md).

## Capabilities and limits

| Property | Value |
| --- | --- |
| Backend id / aliases | `opencode` / `headless-opencode` (default backend for `exec`) |
| Read (`--mode read-only`) | Yes (default) |
| Write (`--mode write`) | Yes — leased worktree, gates, and authorized integration; live write evidence recorded |
| Native resume | Yes (structured `opencode run` + `--session <session-id>`) |
| Streaming / structured output | Yes / Yes |
| Cancellation | Yes (bounded process-tree termination) |
| Effort control | No |
| Named `--agent` | Supported (names only; persisted across session create/resume) |
| Broker compatible | Yes (provider-qualified `--model`, e.g. `openai/gpt-5`) |
| Prompt delivery | argv |
| Default timeout | 180000 ms |
| Max delegation depth | 2 |
| Minimum probed CLI version | 1.15.3 |
| Containment notes | Pure mode with project config, default plugins, and external/Claude-Code skills disabled via environment; capsule source `~/.local/share/opencode/auth.json` only; fail-closed scalar-`model` extraction from the fixed global config; a changed extracted model changes the fingerprint and refuses unsafe native resume |

Full credential contract: the canonical [native-login.md](https://github.com/proofofwork-agency/headless/blob/main/docs/native-login.md) in the repository.
