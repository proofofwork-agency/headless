---
title: What is Headless?
sidebar_position: 1
slug: /
description: A local control plane for bounded, contained AI coding workers behind one externally launched lead.
---

# What is Headless?

Headless is a local execution boundary and orchestration control plane for AI
coding CLIs. You keep one supported CLI open as the **foreground lead**.
Headless runs OpenCode, Claude Code, Codex, and experimental Grok workers behind
an authenticated project daemon, then returns structured results with policy,
usage, cost, containment, and durable audit evidence.

Headless does not replace the provider CLIs or own the visible lead process. It
provides the common substrate around them:

- required macOS Seatbelt or Linux bubblewrap/seccomp containment;
- brokered credentials and bounded provider requests by default;
- explicit, narrowly scoped native-login capsules when an operator opts in;
- durable jobs, budgets, events, messages, artifacts, and ledger attribution;
- one generation-bound MCP lead plus a read-only observer TUI;
- experimental deliberation, councils, goals, workflows, and depth-one worker
  delegation.

```text
externally launched lead CLI
          │ MCP attach + heartbeat
          ▼
authenticated project daemon
          │ policy → budget → queue
          ▼
independently contained workers
          │
          └─ structured result → durable ledger → observer TUI
```

:::caution Private alpha
The npm package is not published and the credentialed release gates remain
open. Build from source, use disposable projects, and do not entrust Headless
with sensitive source, valuable native credentials, or unattended spend yet.
:::

Start with [Initialize a foreground lead](../getting-started/init-a-lead.md),
then read the [security model](../security/containment-ledger-broker.md).
