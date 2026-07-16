---
id: claude
title: Claude Code
sidebar_position: 1
---

# Claude Code under Headless

## What it is

Claude Code is Anthropic's official CLI coder. Headless runs it as a contained worker: the daemon launches `claude` inside required OS containment (a default-deny Seatbelt profile on macOS, bubblewrap plus seccomp on Linux) with an isolated `HOME`, a read-only project mount, and project configuration, hooks, MCP servers, and skills disabled. In native-login mode Headless reuses your existing Claude subscription login through a minimal, audited auth capsule — no separate `ANTHROPIC_API_KEY` is required. The backend id is `claude-code` (alias: `claude`), and the prompt is delivered over stdin. See the [safety model](../concepts/safety-model.md) for the full containment contract.

## Sign up / log in

### macOS: mint the setup-token (Keychain limitation)

On macOS, the installed Claude CLI commonly keeps its working login **only in the login Keychain**. That state is not discoverable from Headless's isolated `HOME` under the required default-deny Seatbelt profile, and Headless deliberately does not export the Keychain item, expose the real home, or inherit an ambient OAuth token. Instead, mint Claude Code's long-lived inference token and store the command's output at Headless's exact allowlisted path — the `>` redirect writes the token straight into the file so it is never displayed in your terminal:

```bash
umask 077
mkdir -p "$HOME/.claude"
claude setup-token > "$HOME/.claude/.headless-setup-token"
chmod 600 "$HOME/.claude/.headless-setup-token"
```

The trimmed file must be no larger than 4 KiB, match the `sk-ant-oat…` setup-token format, and be a canonical, owner-owned, single-link regular file with no group or other permissions (mode `0600`). A present but empty, malformed, oversized, symlinked, hardlinked, or non-owner-only file returns `NATIVE_AUTH_UNAVAILABLE` — Headless never silently falls back to `.credentials.json` after you deliberately install a setup-token.

When valid, the setup-token takes exclusive precedence. It is hashed into the native-auth fingerprint and injected as `CLAUDE_CODE_OAUTH_TOKEN` only into the contained Claude native-login process, after the scrubbed baseline environment has been built. It is never copied into the worker filesystem, daemon environment, persisted state, logs, ledger, or results. This is a long-lived subscription bearer: protect the source file like a password, rotate it with Claude when necessary, and delete the file to return to the legacy `.credentials.json` path. Do not paste a setup-token into `.credentials.json`; Headless treats the two sources as different credential contracts. Minting is always the operator's act: Headless never runs `claude setup-token` or stores the token on your behalf, so the file must exist before Claude can pass a live contained subscription run.

### Linux: a normal file login

On Linux, a normal Claude login stores credentials in the exact file Headless already allowlists:

```bash
claude auth login
test -f "$HOME/.claude/.credentials.json"
```

The file must be a non-symlinked, single-link regular file no larger than 2 MiB. Headless copies it owner-only into the isolated worker's `$HOME/.claude/.credentials.json`; it never mounts your real home. A custom `CLAUDE_CONFIG_DIR` is not an allowlisted source. (Windows execution currently returns `UNSUPPORTED_PLATFORM`.)

### Grant consent and confirm readiness

Native login requires project trust plus explicit acknowledgement that native provider egress is unrestricted:

```bash
PROJECT="/absolute/path/to/your/project"
headless project trust grant --allow-native-direct-unrestricted --cwd "$PROJECT"
headless experimental fleet health --cwd "$PROJECT"
```

Fleet health should report the backend as ready (the observer TUI shows this as `Ready` in its Fleet tab). If Claude alone stays unavailable, the setup-token file is missing or invalid — see [Fleet says "login required"](../troubleshooting/login-required.md).

## How to run it

One bounded, read-only contained run on your subscription:

```bash
headless exec --cwd "$PROJECT" \
  --backend claude-code \
  --auth-mode native-login \
  --approval-policy ask \
  --timeout-ms 60000 \
  --json -- "Reply with OK only. Do not use tools."
```

- `--backend claude` is an accepted alias for `claude-code`.
- Read-only execution is the default. `--mode write` is supported: the mutating turn runs in a daemon-leased worktree (never primary) and passes secret scanning, gates, finality, and an authorized integration decision.
- `--model` is optional; omission uses the Claude CLI's configured default.
- Claude rejects the `--agent` option rather than silently ignoring it (named backend agents exist only for OpenCode and Grok).
- A prompt beginning with `-` belongs after `--`.

Without `--json`, a completed run prints the coder's final text output (redacted and bounded), plus a `cost / tokens / time` summary line on stderr when the provider reported usage; the exit code is `0` on `succeeded`, `1` otherwise. With `--json` you get the full structured `RunResult`, including `network: "native-direct-unrestricted"`, `credential: backend-native` evidence, and `amountUsd: null` unless the CLI reported a real charge.

Persistent sessions are an experimental surface (disabled by default in Beta 1; the `headless experimental session` commands opt in explicitly). Claude's session driver is `claude -p` with a durable session ID, recovering via `--resume <session-id>`:

```bash
headless experimental session create --backend claude-code --auth-mode native-login --cwd "$PROJECT"
headless experimental session send --session-id <session-id> --cwd "$PROJECT" -- "Summarize the repository layout."
headless experimental session status --session-id <session-id> --cwd "$PROJECT"
```

Broker mode remains available when the setup-token path is unsuitable: start the daemon with `ANTHROPIC_API_KEY` in its environment and run with `--auth-mode broker --model <anthropic-model-id>` (the model must have trusted pricing or receive the normal explicit approval).

## How to become lead

The foreground lead is the interactive provider CLI **you** launch and drive; Headless never launches or controls it. `lead use` binds that host to the project daemon with a generation-specific MCP credential, giving your visible Claude session daemon authority (dispatching bounded servants, deliberations, goals) while every worker stays contained. Claude installs its Headless MCP entry through its native MCP installer.

```bash
headless init --lead claude --cwd "$PROJECT"
headless lead status --cwd "$PROJECT"
```

Or the equivalent explicit sequence:

```bash
headless init --cwd "$PROJECT"
headless mcp install claude --cwd "$PROJECT"
headless lead use claude --cwd "$PROJECT"
```

`init --lead` creates external per-project state, installs the host's MCP entry, and binds the lead — it does **not** grant project trust, native egress, write authority, or approval bypass. The bound host attaches and heartbeats; one that stops heartbeating becomes `disconnected`, and Headless does not elect or launch a replacement. Switching hosts with `lead use` rotates the credential generation and invalidates the previous one while preserving all project work; `headless lead release --cwd "$PROJECT"` removes the binding without cancelling jobs or deleting state. Automatic worker routing excludes the active lead backend, so a Claude lead is served by non-Claude workers unless you name `claude-code` explicitly.

## How to track it in the TUI

```bash
headless tui --cwd "$PROJECT"
```

The TUI is a strictly read-only observer over `observer.snapshot` and `observer.events` — watch it, never expect it to interfere. It cannot dispatch runs, resolve approvals, or launch providers.

- **Fleet (key `2`)** — Claude's readiness (`Ready`, `Login required`, `Blocked by containment`, …) and auth mode. Claude renders in its stable identity color (orange) wherever it is named. When readiness is `Login required`, the detail pane displays the login command (`claude auth login`) for you to run externally.
- **Events (key `5`)** — the live run-event feed for your Claude jobs, with `e` (errors), `a` (activity), and `v` (compact/verbose/strict) filters.
- **Goals (key `3`) / Approvals (key `4`)** — goal stages and pending approvals when Claude participates in orchestration; the Approvals view prints the exact `headless experimental approval resolve …` command to run from your shell.
- **Config (key `6`)** — project trust, lead binding, budgets, backend readiness, and daemon state.

Navigate with `Tab`/`Shift-Tab`, number keys `1`–`7`, arrows, `PgUp`/`PgDn`, and the mouse (click tabs and rows, wheel scrolls); `r` refreshes, `q` or `Ctrl-C` exits without stopping detached work. The complete walkthrough is in the [TUI guide](../guides/tui.md).

## Capabilities and limits

| Property | Value |
| --- | --- |
| Backend id / aliases | `claude-code` / `claude` |
| Read (`--mode read-only`) | Yes (default) |
| Write (`--mode write`) | Yes — leased worktree, gates, and authorized integration |
| Native resume | No (`nativeResume: false`; experimental sessions use `claude -p` + `--resume` driver recovery) |
| Streaming / structured output | Yes / Yes |
| Cancellation | Yes (bounded process-tree termination) |
| Effort control | Yes |
| Named `--agent` | Rejected |
| Broker compatible | Yes (`ANTHROPIC_API_KEY` in the daemon environment) |
| Prompt delivery | stdin |
| Default timeout | 180000 ms |
| Minimum probed CLI version | 2.1.206 |
| Containment notes | Hardened profile: project config, hooks, MCP, and skills disabled; setup-token injected as a validated environment capsule (`CLAUDE_CODE_OAUTH_TOKEN`) only for contained native-login launches; macOS Keychain-only login fails closed without the setup-token |

Full credential contract: the canonical [native-login.md](https://github.com/proofofwork-agency/headless/blob/main/docs/native-login.md) in the repository.
