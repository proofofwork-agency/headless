---
title: Capstone and rotating leads
sidebar_position: 3
description: Two recorded example runs — the Neon Breakout fleet build and the same-spec rotating-lead tournament — and what they do and do not demonstrate.
---

# Capstone and rotating leads

Two recorded example runs from Headless development, described here as worked
illustrations of the orchestration and write paths. Both used installed
provider CLIs, real native subscription sessions, required containment,
external daemon state, project gates, approvals, candidate worktrees, and
durable ledger traces. The specific outcomes below are what those single
recorded sessions produced — treat them as examples of expected behavior, not
as a reproducible benchmark or a published, independently verifiable dataset.

## Neon Breakout capstone

A bound Codex foreground lead orchestrated a multi-backend fleet to build a
self-contained browser game without hand-editing primary.

- OpenCode authored the main game candidate.
- Codex handled a separate accessibility subtask.
- Claude returned the then-documented `NATIVE_AUTH_UNAVAILABLE` limitation and
  Grok returned its experimental `BACKEND_UNSUPPORTED` attestation result;
  neither failure was hidden or allowed to block the successful path.
- Timed-out write candidates failed their release gates and could not integrate.
- The accepted candidate passed the project's self-contained-file checks,
  reached allowed durable finality, received explicit merge approval, and was
  integrated by a journaled fast-forward.

The recorded run produced an **893-line, 29,844-byte** single `index.html` with
no external dependencies: a complete Breakout state machine, physics, paddle
and brick collisions, levels, scoring, lives, particles, keyboard,
pointer/touch input, pause, restart, win, and game-over flows.

## Rotating-lead tournament

Claude, Codex, and OpenCode each led the same task: build a two-file Bun/TypeScript
word-frequency CLI with case folding, punctuation handling, `--top`, `--json`,
errors, tests, and a real build gate. Every lead delegated implementation to a
backend different from itself instead of hand-writing the artifact.

| Lead | Worker path | Build outcome | Review score (internal) |
| --- | --- | --- | ---: |
| OpenCode | Codex worker, first successful write attempt | 5 tests / 12 assertions, gate green | **8.9** |
| Codex | OpenCode worker after an initially missed approval window | 9 tests / 15 assertions, gate green | **8.1** |
| Claude | OpenCode worker after a secret-gate rejection and prompt repair | 6 tests / 7 assertions, gate green | **7.8** |

The scores come from a single internal artifact-only review of these recorded
runs — they judged the artifacts, not the model names, and a re-run would
produce different numbers. OpenCode-lead's result won on compact structure,
strict CLI parsing, and real subprocess assertions. The Codex-lead review
explicitly found its own argument-parser weakness. The Claude-lead run
demonstrated that a secret-like test fixture is rejected before integration
and can be repaired without bypassing the gate.

## What these runs demonstrate

In the recorded sessions, lead choice behaved as a routing decision rather than
a separate product; contained workers created real artifacts; and approvals and
gates remained authoritative under timeouts, backend limitations, and prompt
mistakes. These examples do not demonstrate package publication, every
backend's write enablement, or safe unattended use.

## Dogfood posture

Partial, recorded dogfood — not continuous self-host of Headless development.

**What these case studies (and related private-beta evidence) do dogfood**

- Recorded cross-backend deliberate and council paths with real native
  subscription sessions
- Native-subscription smokes on the platform-aware required set
- Neon Breakout and rotating-lead write paths: leased candidates, gates,
  approvals, rejection, and authorized integration
- Product Gate P contrast verify (automated tests plus manual dogfood of the
  golden path)

**What we do not claim**

- Continuous self-host of day-to-day Headless monorepo development
- Unattended production operation
- That Headless fully builds this monorepo as routine practice

Case studies exercise orchestration and write **kernels** under required
containment and durable ledger traces. They are not a full product bootstrap
or a claim that the private beta (`0.2.0-beta.6`) is published.

**Two different “loop” systems**

| System | What it is |
| --- | --- |
| Runtime `experimental loop --repair` | Automation: a repair loop whose oracle is a named project gate report |
| Product Gate P “loop protocol” | Human UX process: measure → fix → contrast verify → re-measure |

Do not conflate them. Repair automation does not replace Product Gate P, and a
green Product Gate does not mean Headless is continuously developing itself.
