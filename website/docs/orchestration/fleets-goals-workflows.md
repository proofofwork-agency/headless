---
title: Fleets, goals, and workflows
sidebar_position: 2
description: Durable multi-backend profiles, collaborative goals, restartable workflows, councils, and approval-aware finality.
---

# Fleets, goals, and workflows

The orchestration surfaces are experimental, but they use the same daemon,
containment, budget, approval, and ledger contracts as a one-shot run.

## Fleet profiles

A fleet profile names bounded agents and records each backend, auth mode,
approval policy, priority, capabilities, and concurrency. Profiles also cap
active workers, queued delegations, deliberation rounds, attempts, total goal
time, and idle-autonomy mode.

For subscription-backed workers, set `native-login` on the profile **and every
agent**. A top-level native profile does not rewrite an agent explicitly left in
broker mode.

```json title="/tmp/headless-native-fleet.json"
{
  "id": "native-subscriptions",
  "name": "Native subscription fleet",
  "authMode": "native-login",
  "approvalPolicy": "ask",
  "agents": [
    {"id": "codex", "backend": "codex", "name": "Codex", "authMode": "native-login"},
    {"id": "opencode", "backend": "opencode", "name": "OpenCode", "authMode": "native-login"},
    {"id": "claude", "backend": "claude-code", "name": "Claude", "authMode": "native-login"},
    {"id": "grok", "backend": "grok-build", "name": "Grok", "authMode": "native-login"}
  ],
  "maxActiveWorkers": 4,
  "maxQueuedDelegations": 64,
  "maxDeliberationRounds": 8,
  "maxAttemptsPerDelegation": 2,
  "goalTimeoutMs": 3600000,
  "idleAutonomy": "suggest"
}
```

```bash
headless experimental fleet profile upsert \
  --file /tmp/headless-native-fleet.json \
  --auth-mode native-login \
  --cwd "$PROJECT"

headless experimental fleet health \
  --profile-id native-subscriptions \
  --cwd "$PROJECT"
```

## Goals and collaboration

A goal binds an objective, fleet profile, execution mode, auth and approval
policy, synthesizer selection, and deadline. Planning turns produce bounded
delegations; worker turns produce actual results and diffs; review and critique
turns cite durable artifacts. Addressed messages are acknowledged explicitly,
and restart recovery resumes from persisted state rather than replaying a
completed provider turn.

```bash
headless experimental goal run \
  --fleet-profile-id native-subscriptions \
  --auth-mode native-login \
  --mode read-only \
  --timeout-ms 600000 \
  --cwd "$PROJECT" \
  -- "Compare the public API against the documented examples."
```

Write goals add leased worktrees, coder-tool approval, candidate gates,
finality, and integration authority; the goal itself does not bypass them.

## Councils

A council is a persisted phase machine: proposal, execution, review, voting,
and decision. Votes are attributable, cross-reference actual evidence, and use
a strict majority. A child timeout or provider failure is evidence, not a
reason to fabricate a successful decision.

```bash
headless experimental council \
  --agent codex \
  --agent opencode \
  --auth-mode native-login \
  --mode read-only \
  --cwd "$PROJECT" \
  -- "Should this parser contract be changed?"
```

## Workflows

Workflows are validated, restartable DAGs. Each step retains dependencies,
backend selection, bounded retries, approval policy, terminal state, and actual
result evidence. Drafts can be validated before launch; running workflows can
be inspected, paused, resumed, waited, or cancelled through authenticated
daemon routes.

The [CLI reference](../reference/cli.md) links to the generated command table.
