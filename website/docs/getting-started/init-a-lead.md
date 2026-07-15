---
title: Subscription quickstart
sidebar_position: 1
description: Build Headless, bind a foreground lead, grant explicit native-login trust, and run a contained servant without an API key.
---

# Subscription quickstart

Native login is the primary real-run path: Headless uses the official CLI's
existing subscription login, not a separate provider API key. It still creates
an isolated worker home and a backend-specific auth capsule.

## 1. Build from source

The packages are not published. Build the compiled CLI from this checkout:

```bash
git clone https://github.com/proofofwork-agency/headless.git
cd headless
bun install --frozen-lockfile --ignore-scripts
bun run build

HEADLESS="$PWD/dist/cli.js"
PROJECT="/absolute/path/to/your/project"
```

## 2. Bind the foreground lead

Choose the CLI that remains visible and acts as lead:

```bash
"$HEADLESS" init --lead codex --cwd "$PROJECT"
"$HEADLESS" doctor --cwd "$PROJECT"
```

Replace `codex` with `claude`, `opencode`, or `grok`. `init --lead` creates
external per-project state, installs that host's MCP entry, and rotates the
generation-bound lead binding. It never grants trust, native egress, write
authority, or approval bypass.

## 3. Explicitly allow native subscription login

Native provider traffic is not broker-destination restricted. Grant trust only
to a project you understand, and acknowledge unrestricted outbound provider
egress explicitly:

```bash
"$HEADLESS" project trust grant \
  --allow-native-direct-unrestricted \
  --cwd "$PROJECT"
```

The grant lives outside the checkout and can be revoked:

```bash
"$HEADLESS" project trust revoke --cwd "$PROJECT"
```

## 4. Run a contained servant

The servant may be a different backend from the foreground lead:

```bash
"$HEADLESS" exec \
  --backend opencode \
  --auth-mode native-login \
  --mode read-only \
  --timeout-ms 120000 \
  --json \
  --cwd "$PROJECT" \
  -- "Inspect this project and identify its public entry points."
```

A successful result reports required containment, `backend-native` credential
evidence, and `native-direct-unrestricted` network evidence. That network label
is a truthful warning, not a destination allowlist.

## Backend login preparation

| Backend | Prepare the host login | Additional Headless requirement |
| --- | --- | --- |
| Codex | Log in with the official Codex CLI | Canonical owner-only `~/.codex/auth.json` |
| OpenCode | Log in with OpenCode | Canonical owner-only OpenCode auth plus a safe global default model or an explicit model |
| Claude Code | Log in, then run `claude setup-token` | Store the token at `~/.claude/.headless-setup-token` with mode `0600` |
| Grok Build | Run `grok login --device-code` | Experimental runs must pass Headless's contained trust-canary attestation |

Read [backend authentication](./backend-auth.md) before using Claude or Grok.

## Broker mode alternative

Broker mode remains the default and accepts provider API keys only in the
daemon environment. The worker receives an opaque, finite lease rather than
the key:

```bash
: "${OPENAI_API_KEY:?export OPENAI_API_KEY before broker execution}"
"$HEADLESS" exec \
  --backend opencode \
  --model openai/gpt-5 \
  --mode read-only \
  --json \
  --cwd "$PROJECT" \
  -- "Summarize the public API."
```

Broker mode has tighter network and request authority. Native login avoids a
separate API key but deliberately trades away broker-only destination control.
