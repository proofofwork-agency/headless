---
id: quickstart
title: Quickstart
sidebar_position: 2
---

# Quickstart

**One golden path** from a fresh checkout to a verified contained run. Target: under five minutes once a coder CLI is already logged in. Use a disposable project while Headless is in private beta.

Prerequisites: [Headless built and on `PATH`](./installation.md), a Git repository, and at least one of `codex`, `opencode`, `claude`, or `grok` installed and signed in.

## Golden path (four decisions)

### 1. Setup

```bash
PROJECT="${PROJECT:-$(pwd)}"
headless setup --cwd "$PROJECT"
```

`setup` initializes external per-project state (no checkout edits), inventories supported CLIs, recommends a backend, and prints the exact next commands. Pass `--lead codex` (or `claude` / `opencode` / `grok`) to also bind that host as the foreground lead.

Noninteractive native consent in one shot:

```bash
headless setup --yes --allow-native-direct-unrestricted --cwd "$PROJECT"
```

### 2. Grant native trust (if you did not use the flag above)

```bash
headless project trust grant \
  --allow-native-direct-unrestricted \
  --cwd "$PROJECT"
```

This is **intentional friction**: you acknowledge that native-login workers may use unrestricted provider egress. Broker mode needs no native acknowledgement. Check or revoke with `headless project trust status|revoke`.

### 3. Run with a profile

```bash
headless exec \
  --backend codex \
  --auth-mode native-login \
  --profile read-only-native \
  --cwd "$PROJECT" \
  -- "Explain this repository."
```

Use **native-login** (subscription capsules already on the host). `--profile read-only-native` also sets `auth-mode=native-login`, `mode=read-only`, and required containment; spelling `--auth-mode native-login` keeps the path explicit. Use `--auth-mode broker` / `--profile broker-readonly` only when the daemon holds provider API keys.

On success, Headless prints the job id plus copy-paste `verify` and `receipt` commands (artifact-first aha).

### 4. Verify

```bash
headless verify --cwd "$PROJECT"
```

Optional observer: `headless tui --cwd "$PROJECT"` (read-only; generates CLI commands, no mutation authority).

## Sign-in notes (once per machine)

| Backend | Host login |
| --- | --- |
| Codex | `codex login` → `~/.codex/auth.json` |
| OpenCode | `opencode auth login` |
| Claude (Linux) | `claude auth login` |
| Claude (macOS Keychain) | `claude setup-token > ~/.claude/.headless-setup-token` (mode 600) |
| Grok | `grok login` or `grok login --device-auth` |

Details: per-coder native login in the [Claude](../ai-coders/claude.md), [Codex](../ai-coders/codex.md), [OpenCode](../ai-coders/opencode.md), and [Grok](../ai-coders/grok.md) guides.

## What not to do on the golden path

- Do not start with fleets, councils, or workflows — those are `headless experimental …`.
- Do not use `--unsafe-no-sandbox` for demos; required containment is the product.
- Do not point at production repos with valuable credentials until release gates say so.

## Next

- [Architecture](../concepts/architecture.md)
- [Safety model](../concepts/safety-model.md)
- [CLI guide](../guides/cli.md)
- [TUI guide](../guides/tui.md)
- [Release evidence](../release-gates/evidence.md)
