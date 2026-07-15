---
title: Initialize a foreground lead
sidebar_position: 1
description: Build Headless, initialize external project state, install MCP, and bind one lead without granting trust or native egress.
---

# Initialize a foreground lead

Headless is currently installed from source. These commands build the compiled
binaries, initialize state outside the checkout, install Codex's MCP entry, and
bind Codex as the project's foreground lead:

```bash
git clone https://github.com/proofofwork-agency/headless.git
cd headless
bun install --frozen-lockfile --ignore-scripts
bun run build
./dist/cli.js init --lead codex --cwd .
./dist/cli.js doctor --cwd .
```

Use `claude`, `opencode`, or `grok` instead of `codex` to install and bind a
different host. Headless updates host-global MCP configuration where required;
it never writes host configuration into the project checkout.

`init --lead` performs three operations: create external project state, install
the selected host's MCP registration, and rotate the generation-bound lead
binding. It does **not** grant project trust, native egress, write authority, or
approval bypass.

## Run a brokered worker

Broker mode is the default. Supply the matching provider key to the daemon
environment and use a provider-qualified model:

```bash
: "${OPENAI_API_KEY:?export OPENAI_API_KEY before broker execution}"
./dist/cli.js exec \
  --backend opencode \
  --model openai/gpt-5 \
  --timeout-ms 60000 \
  --json \
  --cwd . \
  -- "Summarize the public execution boundary."
```

## Observe without mutating

```bash
./dist/cli.js tui --cwd .
```

The TUI uses an observer credential limited to snapshots and events. Its Config
view shows trust, lead state, budgets, backend readiness, and daemon state, then
generates exact commands labeled “run from your shell.” It cannot run them.

Native login is a separate opt-in requiring project trust and unrestricted
provider-egress acknowledgement. Read the [security model](../security/containment-ledger-broker.md)
before enabling it.
