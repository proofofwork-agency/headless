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
