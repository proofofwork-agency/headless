---
id: intro
title: Introduction
slug: /
---

# Headless

Headless is a local, project-scoped control plane for running AI coding CLIs and
collaborative fleets. It normalizes **OpenCode, Claude Code, Codex, and Grok
Build** behind one structured result, keeps their processes hidden behind a
daemon-owned control plane, contains workers at the operating-system boundary,
and records activity in an external hash-chained ledger.

Version 0.2 is intentionally breaking. **Required containment is the default;**
an unavailable sandbox is an error, never an automatic downgrade.

## The model in one minute

- **One daemon per project.** Every client — the CLI, the [control-room
  TUI](./control-room.md), the MCP server, and the OpenCode plugin — talks to a
  single authenticated daemon that owns the canonical project root. Clients
  cannot self-declare their identity or point the daemon at a different root.
- **Trust is explicit and one-time.** `headless project trust grant` records
  consent for a project root before any native login is used.
- **Native login by default.** Workers run under the backend CLI's existing
  subscription via a minimal, allowlisted auth capsule — no ambient home,
  keychain, API keys, or unrelated credentials. API-key **broker** mode is an
  explicit opt-in.
- **Containment is mandatory.** Each worker gets an isolated filesystem and
  environment under macOS Seatbelt or Linux bubblewrap + seccomp. `--unsafe-no-sandbox`
  is the only local escape hatch and is visibly marked.
- **Everything is durable and auditable.** Jobs, sessions, goals, workflows,
  approvals, and candidates live in an external, hash-chained ledger keyed by
  the project root — never inside your checkout.

## Install

```bash
bun add -g @proofofwork-agency/headless@0.2.0
headless --version
```

Requirements: **Bun 1.1+**, macOS with `/usr/bin/sandbox-exec` or Linux with a
working `bubblewrap`, and a supported backend CLI on `PATH` with an established
native login. Windows returns the stable `UNSUPPORTED_PLATFORM` result before a
backend is launched.

## Quick start

```bash
# One-time, explicit trust for the canonical project root.
headless project trust grant --cwd .

# Required containment and native login are implicit. Omitting --model uses the
# backend CLI's configured default.
headless exec --backend opencode --json "Summarize this project"

# Open the live control room.
headless tui
```

## Where to go next

- **[Control room (TUI)](./control-room.md)** — the live terminal UI: views,
  keybindings, and the command palette.
- **[CLI reference](./cli-reference.md)** — every command, grouped by area.
- **[Backends and authentication](./backends-and-auth.md)** — native login vs.
  broker, per-backend behavior, approvals, and trust.
- **[Containment](./containment.md)** — how workers are isolated on each platform.
- **[Architecture](./architecture.md)** — how it is built: the daemon, the
  ledger, durable execution, goals and fleets, and gated writes.
