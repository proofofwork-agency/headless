---
sidebar_position: 2
title: CLI-first operations and the observer TUI
description: Configure one foreground lead, run contained workers, and observe durable state.
---

# CLI-first operations and the observer TUI

> Unreleased Beta 1. Use disposable projects and bounded spend until the release gate is green.

## Operating model

```text
externally launched provider CLI (foreground lead)
                    │ attach + heartbeat
                    ▼
       authenticated Headless project daemon
          ├─ contained workers and sessions
          ├─ goals, workflows, councils, loops
          ├─ approvals, candidates, budgets
          └─ verified ledger and communication
                    │ read-only projection
                    ▼
                 observer TUI
```

There is exactly one configured foreground lead per project and no automatic election. A goal’s sticky synthesizer is only a worker role; health failover never changes foreground authority. Headless never launches or controls the provider CLI used as the lead.

The CLI is the complete control surface. The TUI is observation only. It has no prompt, command palette, provider login, run dispatch, goal/workflow activation, approval resolution, candidate integration, policy mutation, or provider cancellation.

## Isolate a development fixture

```bash
PROJECT="$(mktemp -d)"
STATE="$(mktemp -d)"
RUNTIME="$(mktemp -d /tmp/headless-runtime.XXXXXX)"

export HEADLESS_STATE_HOME="$STATE"
export HEADLESS_RUNTIME_HOME="$RUNTIME"

git -C "$PROJECT" init
headless init --cwd "$PROJECT"
headless doctor --cwd "$PROJECT"
```

External state is keyed by the canonical project path. `init` must not edit the checkout or `.gitignore`.

## Configure and attach the foreground lead

For Codex:

```bash
headless lead use codex --cwd "$PROJECT"
headless mcp install codex --cwd "$PROJECT"
headless lead status --cwd "$PROJECT"
```

For OpenCode, use `opencode` in both commands; its packaged plugin attaches with that host identity. Other registered hosts use the same binding contract.

`lead use` rotates a generation-specific credential. Switching hosts explicitly invalidates the previous generation but preserves all project work. `lead release` removes the binding without cancelling jobs or deleting state. A host that stops heartbeating becomes `disconnected`; Headless does not elect or launch a replacement.

## Run contained workers

Broker mode is the default:

```bash
headless exec --cwd "$PROJECT" \
  --backend opencode \
  --model openai/your-model \
  --timeout-ms 60000 \
  --json -- "Inspect the request schema."
```

Read-only execution is the default. Required containment uses Seatbelt on macOS and bubblewrap/seccomp on Linux. A prompt beginning with `-` belongs after `--`.

Native login requires project trust and an explicit acknowledgement that native provider egress is unrestricted:

```bash
headless project trust grant --allow-native-direct-unrestricted --cwd "$PROJECT"
headless exec --cwd "$PROJECT" --backend codex --auth-mode native-login --json -- "Inspect only."
```

Provider login is always performed in the provider’s own externally launched CLI. Headless does not capture credentials or start an interactive login process.

## Durable work and communication

Advanced commands live under `headless experimental`:

```bash
headless experimental fleet profile list --cwd "$PROJECT"
headless experimental fleet health --cwd "$PROJECT"
headless experimental goal start --cwd "$PROJECT" --detach -- "Analyze the fixture."
headless experimental goal list --cwd "$PROJECT"
headless experimental approval list --cwd "$PROJECT"
headless experimental candidate inspect --cwd "$PROJECT" --candidate-id <id>
```

Automatic worker selection avoids the active lead backend. To intentionally create a separate worker using the same provider, name that backend or per-goal synthesizer explicitly.

Directed messages, queues, task claims, handoffs, artifacts, votes, and finality remain in Headless’s existing stores and verified ledger. Headless does not ingest or replay ContextRelay runtime state.

## Integration authority

Candidate integration is human-controlled by default:

```bash
headless experimental candidate integrate --cwd "$PROJECT" --candidate-id <id>
```

The lead-facing MCP/plugin surface can list approvals and inspect candidates but cannot resolve or integrate them. A finite grant may enable direct integration only while every project, principal, backend, operation, cost, expiry, and iteration bound matches. Root CLI recovery remains available and attributable.

## Observer TUI

```bash
headless tui --cwd "$PROJECT"
```

The TUI may start the Headless daemon if it is absent. It cannot start providers or jobs. It authenticates with a dedicated observer credential and reads only `observer.snapshot` and `observer.events`; the daemon rejects every mutation attempted with that credential.

Navigation:

- `Tab` / `Shift-Tab`, number keys, arrows, and mouse select views and rows.
- Event filters, grouping, compact/verbose/strict presentation, redaction, layout, and reconnect behavior remain local presentation features.
- `?` shows observer guidance; `q` or Ctrl-C exits the client without stopping detached work.

The Config view renders project trust, lead binding, budgets, backend readiness, and daemon state from the same observer snapshot. It labels exact root-CLI commands as “run from your shell”; the TUI never runs them. Approvals and candidates likewise display CLI guidance, and provider health may display the provider’s login command without launching it.

## Migration behavior

On first daemon ownership after this private-alpha break, Headless:

- archives Core/operator/proposal metadata without executing pending proposals;
- preserves the underlying worker sessions that were referenced by Core metadata;
- migrates goal `leaderAgentId` to `synthesizerAgentId`;
- removes fleet coordinator-selection fields;
- revokes shared generic integration credentials;
- leaves ledger bytes, worktrees, jobs, tasks, artifacts, messages, approvals, candidates, grants, budgets, identifiers, and provenance intact;
- intentionally leaves any external ContextRelay state untouched.

The migration manifest records that the verified ledger was not modified.

## Verification

```bash
bun run check
bun run build
bun run smoke:pack
```

Installed-provider smoke is opt-in. OpenCode and Grok release status must not be upgraded without real installed CLI evidence. Grok remains read-only under required containment.
