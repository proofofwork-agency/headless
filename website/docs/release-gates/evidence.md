---
title: Gates A, B, and C
sidebar_position: 2
description: What each cumulative release gate requires, what has been proven live, and why no package is published yet.
---

# Gates A, B, and C

The release plan is cumulative. Evidence may be green before the corresponding
package is published; a live demonstration is not an npm release.

| Gate | Scope | Current evidence | Publication |
| --- | --- | --- | --- |
| A — kernel beta | Contained exec, daemon, trust, lead onboarding, MCP, observer TUI | Full macOS/Linux checks and the required native-subscription backend evidence are green in the current tree | Not published |
| B — orchestration beta | Deliberation, councils, fleets, goals, workflows, delegation | A real native multi-backend matrix reached council finality; the Codex-led capstone exercised lead-to-fleet orchestration with a durable ledger trace | Not published |
| C — writes GA | Leased worktrees, secret and project gates, candidate finality, authorized integration | The capstone and rotating-lead tournament exercised rejection, approval, gate, and integration paths against real CLI workers | Not published |

## Gate A: bounded execution

Gate A requires strict contracts, upgrade compatibility, required containment,
bounded credential handling, broker and native-login paths, durable result and
event recovery, budget and policy checks, lead binding, MCP onboarding, the
observer-only TUI, package verification, and real macOS/Linux CI.

The current working evidence is green for the platform-aware required native
set. Claude's setup-token capsule is implemented and fixture-proven, but a local
operator must mint the real token before that machine can produce Claude live
evidence. Grok remains experimental and is excluded from the published Gate A
required set.

## Gate B: orchestration

Gate B adds durable collaboration contracts and real multi-agent behavior. The
live matrix proved native OpenCode and Codex execution plus a two-backend council
that reached an approved decision with votes from both participants. The
Breakout capstone then proved that a bound Codex lead could coordinate contained
workers, approvals, gates, and ledger evidence through one real task.

## Gate C: gated writes

Gate C requires ambiguity never to mutate primary. The capstone exercised
leased candidate worktrees, fail-closed timed-out candidates, a meaningful
project gate, explicit coder-tool and merge approvals, durable finality, and a
journaled fast-forward integration. The rotating-lead tournament repeated the
same build spec under multiple lead/worker pairings and retained every failure
and intervention rather than reporting them as green.

## Why publication remains blocked

The root and plugin packages are still private at `0.2.0-beta.1`. No gate is
released until its full current-tree checklist is re-run, no P0/P1 security or
data-integrity issue remains, clean package artifacts install, and the authorized
release resolves through the public registry. The canonical checklist is
[`docs/plan.md`](https://github.com/proofofwork-agency/headless/blob/main/docs/plan.md).
