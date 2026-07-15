---
title: What is Headless?
sidebar_position: 1
slug: /
description: One foreground CLI coder leads a contained, auditable fleet of Claude, Codex, OpenCode, and Grok workers.
---

# What is Headless?

<div className="hero-panel">
  <h2>One visible lead. A contained fleet behind it.</h2>
  <p>
    Headless turns Claude Code, Codex, OpenCode, or Grok into the foreground
    lead while the other CLI coders run as bounded servants behind one local,
    durable control plane.
  </p>
</div>

Headless is a universal runner and orchestration layer for coding CLIs. It does
not replace those CLIs and it does not hide the foreground lead. Instead, it
gives every worker the same admission, containment, budget, approval, result,
and audit contract.

```text
externally launched lead CLI
          │ generation-bound MCP attach
          ▼
authenticated project daemon
          │ trust → authority → budget → queue
          ▼
contained Claude / Codex / OpenCode / Grok workers
          │
          └─ structured result → durable ledger → observer TUI
```

<div className="proof-grid">
  <div className="proof-card">
    <strong>Any supported lead</strong>
    Claude, Codex, OpenCode, and Grok use the same compiled MCP server and
    generation-bound lead contract.
  </div>
  <div className="proof-card">
    <strong>Contained servants</strong>
    Seatbelt on macOS and bubblewrap plus seccomp on Linux bound worker files,
    credentials, processes, and network authority.
  </div>
  <div className="proof-card">
    <strong>Durable orchestration</strong>
    Runs, deliberations, councils, fleets, goals, workflows, approvals, and
    depth-one delegation retain attributable state across restarts.
  </div>
  <div className="proof-card">
    <strong>Gated writes</strong>
    Write workers operate in leased worktrees. Secret scanning, project gates,
    finality, and an authorized integration decision protect primary.
  </div>
</div>

## The operating model

One host is explicitly bound as the foreground lead. Its MCP connection can
submit a bounded run, fan out a deliberation, convene a multi-phase council,
or coordinate a durable fleet goal. Automatic worker selection excludes the
active lead backend, so “ask another agent” means another contained process,
not a hidden copy of the lead.

The TUI is the observer pane. It reads snapshots and events, shows logs and
configuration state, and generates exact root-CLI commands. It cannot execute
mutations, resolve approvals, integrate candidates, grant trust, or hold
provider credentials.

## What is proven, and what is published

The current tree has green kernel evidence and recorded live orchestration and
write evidence. A Codex-led fleet built and integrated a complete single-file
Breakout game; a rotating-lead tournament then had Claude, Codex, and OpenCode
lead the same gated build through different worker backends.

<div className="status-strip">
  <strong>No release gate has been published yet.</strong> The packages remain
  private at a beta-candidate version. Evidence in this repository demonstrates the
  paths; it is not an npm availability claim or permission for unattended use.
</div>

Continue with the [subscription quickstart](../getting-started/init-a-lead.md),
the [security model](../security/containment-ledger-broker.md), and the
[recorded case studies](../case-studies/proven-runs.md).
