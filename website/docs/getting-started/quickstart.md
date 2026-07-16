---
id: quickstart
title: Quickstart
sidebar_position: 2
---

# Quickstart

Ten minutes from a fresh checkout to a verified execution receipt. This walkthrough uses the native-login path: Headless drives the coder CLIs you are already signed in to, with no separate provider API keys.

Prerequisites: [Headless built and on `PATH`](./installation.md), a Git repository to work in, and at least one coder CLI installed. Use a disposable project while Headless is in private beta.

## 1. Initialize the project

```bash
PROJECT="${PROJECT:-$(pwd)}"
headless init --cwd "$PROJECT"
```

`init` creates external per-project state keyed by the canonical project path — it does not edit your checkout or `.gitignore`. Add `--lead codex` (or `claude`, `opencode`, `grok`) to also install that host's MCP registration and bind it as the [foreground lead](../concepts/leads-and-fleet.md) in one step.

## 2. Sign in your coder CLIs natively

Each CLI signs in with its own login flow, once, on the host. Headless imports only that backend's bounded credential capsule into the contained worker — never your real home directory.

**Codex** — sign in; Headless imports `~/.codex/auth.json`:

```bash
codex login
```

**Claude Code** — on Linux, a normal login stores the file Headless allowlists (`~/.claude/.credentials.json`):

```bash
claude auth login
```

On macOS, Claude Code commonly keeps its login in Keychain, which required containment does not import. Mint the long-lived subscription setup-token and store it at Headless's exact allowlisted path:

```bash
umask 077
mkdir -p "$HOME/.claude"
claude setup-token > "$HOME/.claude/.headless-setup-token"
chmod 600 "$HOME/.claude/.headless-setup-token"
```

The token is injected only into the contained Claude worker as `CLAUDE_CODE_OAUTH_TOKEN`; it never enters daemon state, logs, the ledger, or results. Protect the file like a password.

**OpenCode** — sign in with its own flow; Headless imports `~/.local/share/opencode/auth.json`:

```bash
opencode auth login
```

**Grok Build** — browser OAuth, or device auth on a display-less host:

```bash
grok login
grok login --device-auth
```

You only need the backends you intend to use. `headless doctor` shows which CLIs Headless can see.

## 3. Grant native-login consent

```bash
headless project trust grant --allow-native-direct-unrestricted --cwd "$PROJECT"
```

Native login requires explicit per-project trust plus this acknowledgement that native provider egress is unrestricted (the worker's outbound destination IPs are not allowlisted). Trust is stored outside the repository and cannot be supplied by a run request. Check or withdraw it any time with `headless project trust status` and `headless project trust revoke`.

## 4. Run your first contained job

```bash
headless exec --backend codex --auth-mode native-login --json --cwd "$PROJECT" -- "Explain this repo."
```

The worker runs read-only by default inside required OS containment (Seatbelt on macOS, bubblewrap plus seccomp on Linux) with an isolated `HOME` and only the Codex capsule. The `--json` result includes the run ID, status, output, usage, and truthful containment evidence — `network: "native-direct-unrestricted"`, and cost `amountUsd: null` unless the CLI reports a real charge. Swap `--backend` for `claude-code`, `opencode`, or `grok-build` as you like.

## 5. See the receipt

```bash
headless experimental receipt list --cwd "$PROJECT"
headless experimental receipt show <runId> --cwd "$PROJECT"
```

Every authorized run — this read-only one included — produced an [execution receipt](../concepts/receipts.md). `list` prints one line per run with its status, backend, and ledger anchor sequence; `show` prints the full summary: principal, authority source, containment, cost, gates, the anchor, and the receipt's self-digest.

## 6. Verify

```bash
headless verify --cwd "$PROJECT"
headless experimental receipt verify <runId> --cwd "$PROJECT"
```

`headless verify` scans the entire tamper-evident ledger — sequence, previous hash, project binding, digests, key IDs — and exits non-zero at the first break. `receipt verify` proves one run's receipt against that chain and reports `VERIFIED (full-chain)` on success. Both are checks anyone can re-run, not claims you have to take on trust.

## 7. Watch it in the observer TUI

```bash
headless tui --cwd "$PROJECT"
```

The TUI is a read-only observer over daemon snapshots and events: fleet, goals, approvals, events, and configuration. It may start the Headless daemon if absent, but it cannot dispatch runs, resolve approvals, or mutate anything — where an action is needed, it shows you the exact root-CLI command to run from your shell. Press `7` for Help and `q` to exit.

## Where next

- [The safety model](../concepts/safety-model.md) — what contained, fail-closed, and gated actually mean here.
- [Execution receipts](../concepts/receipts.md) — receipt anatomy, offline verification, and honest assurance levels.
- [Leads and the fleet](../concepts/leads-and-fleet.md) — bind a foreground lead and orchestrate contained servants.
