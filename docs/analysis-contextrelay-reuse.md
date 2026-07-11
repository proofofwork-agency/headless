# ContextRelay Reuse Analysis

**Date**: 2026-07-09
**Source**: `../agenttalk/contextrelay` (and the livetest copy). The most mature local coordination + headless runtime in the ecosystem.

## What ContextRelay Already Solves (Goldmine for Headless)

ContextRelay is **not** "just a bridge". It is a full local control plane:

- Durable append-only **ledger** (`.contextrelay/sessions/*.jsonl`) for messages, handoffs, artifacts (`headless_result`, `release_gate`, `test_report`, ...), decisions.
- **Named sessions** + git **worktree** binding + validation.
- **Coordinator policy** (who may write to the main tree).
- **Permissions** surface (act:write gates, read-only default).
- **Headless one-shot runners** (`headless_run` MCP + `ctxrelay headless run`): fresh-context contained reviewers.
- **Idle autonomy** machinery (scanner, ask-for-work, eval, dispatch, budgets).
- Live pairing (Claude <-> Codex) with queues, handoffs, deliberate.
- TUI + read-only web viewer ("Command Deck").
- MCP tools for Codex + slash commands + hooks for Claude.
- Release gates + evidence.
- Usage control, compaction, recovery.

**For the new Headless project**:
- We should **depend on or extract** the ledger + worktree + policy + headless runner cores.
- Or treat CR as the "coordinator" and Headless as the "engine fleet provider".
- The existing `headless_run` primitive + adapter registry is *exactly* the starting point for multi-backend support.

## Headless Runner Implementation (src/backup/*) — Primary Reuse Target

Files:
- `src/backup/adapters.ts`
  - `HeadlessAdapter` interface (id, promptDelivery, buildCommand, buildEnv, prepareRun?, parseOutput, credentialPrefixes, containment, defaultMode, groundingPrompt?).
  - Registry + registration.
  - Built-ins: `codexHeadlessAdapter`, `claudeHeadlessAdapter`.
  - `opencodeHeadlessAdapter` (conditional on macOS + sandbox probe + binary).
  - `buildWorkspaceWriteCommand` (for future act:write).
  - `validateContainedHeadlessTarget`, `containedHeadlessAdapterIds`, etc.
- `src/backup/runner.ts`
  - `BackupRunRequest`, `BackupRunResult`.
  - `buildBackupCommand`, env, `runBackupAgent` logic (spawns, timeout, kill, cleanup, output collection).
  - Mode: "read-only" | "write".
- `src/backup/opencode-adapter.ts` (very relevant)
  - `OPENCODE_GROUNDING_PROMPT` (read-only discipline text).
  - `OPENCODE_CONFIG_CONTENT` (denies almost everything except read/glob/grep/list).
  - `buildOpencodeCommand`, `buildOpencodeEnv`.
  - `parseOpencodeJsonl` (handles step_finish, cost, tokens).
  - `prepareOpencodeRun` (temp HOME/TMP, auth copy, Darwin sandbox profile generation via `os-sandbox.ts`).
  - Cleanup.
- `src/backup/headless.ts` + `headless-pool.ts`
  - Shared result → artifact helpers (`headlessResultArtifact`, `headlessResultMeta`).
  - Timeout defaults, status mapping.
- `src/backup/os-sandbox.ts` + `triggers.ts`

**Immediate value**: The adapter abstraction + runner + opencode implementation can be the seed for the unified `Engine` + containment layer in Headless. We can generalize "HeadlessAdapter" → broader `Engine` that also supports live/attached sessions.

## Worktree & Session Isolation (src/session/)

- `worktree.ts`, `git-helpers.ts` — create, validate, capture diffs, bind to sessions, cleanup.
- `session-registry.ts`, `session-worktree.ts`.
- Named sessions with separate worktrees for parallel experiments.
- Write authorization that routes through coordinator or explicit gates.

**Reuse**: These are production-grade and already handle the "each agent in its own tree" pattern that Conductor etc. reinvent.

## Ledger, Artifacts, Handoffs, Deliberation

Core durable state lives in JSONL + some SQLite (for Codex queue).
Artifacts are typed (`kind`, `status`, `title`, `summary`, `evidence`, `meta`).
Handoffs, notes, finality, release gates are first-class.

Headless results are recorded uniformly so a "fleet review" produces auditable evidence.

## Autonomy & Loops

- Idle opportunity scanner + gates + evaluation harness.
- Ask-for-work nudges.
- Act:write (contained, worktree, budget, single-flight).
- These are advanced "loop" primitives we can lift into the new orchestrator.

## MCP / Plugin Surface

Codex gets rich tools (`headless_run`, `handoff_to_claude`, `deliberate_with_claude`, `read_context`, `record_artifact`, `propose_final`, ...).
Claude gets symmetric slash commands + MCP tools via the plugin.

This pattern is how "any agent" can drive the fleet.

## Test & Safety Patterns Worth Copying

- Containment adversarial tests.
- Smoke tests that require real binaries (`claude`, `codex`, `opencode`).
- Unit tests for parsers, adapters, runner.
- Release-gate + evidence collection before publish.
- Threat model doc.

## Current Limitations (from our perspective, at time of analysis 2026-07-09)

- OpenCode adapter is Darwin-only for full OS sandbox enforcement (config deny works everywhere). *(Headless v0.2 later added required Linux bubblewrap containment; it does not claim Landlock rules.)*
- Primarily read-only headless today (write mode is Codex workspace-write for now). *(Headless now has full write worktrees + agent worktrees for all.)*
- Tight coupling to Claude + Codex live pairing; the headless piece is more general but still lives inside the CR package. *(Headless extracted to standalone; now multi-backend + MCP universal.)*
- No first-class "multi-backend fleet" or "workflow DAG" executor on top of the primitive. *(Headless added 4 backends, autonomy, council, TUI, channels.)*

## Recommendation for Headless Project

**Preferred**: Make Headless a **separate, focused package** (`@proofofwork-agency/headless` or local) that:

- Exports a clean `Engine` / runner interface + built-in adapters for claude / codex / opencode / grok.
- Re-exports or depends on CR's ledger types + worktree helpers for compatibility.
- Can be used by ContextRelay (improve its adapters), Claw, a new director, or standalone.
- Adds the missing pieces: cross-platform containment options, live session management, structured capability flags, superpower grounding, workflow runtime.

**Alternative (fast)**: Start by forking/extracting `src/backup/**` + worktree + minimal ledger bits into `headless/src/engines` and iterate, then propose upstream improvements.

Either way, **do not duplicate** the battle-tested containment, parsing, and isolation logic.

## Specific Symbols / Modules to Study or Import First

- `HeadlessAdapter` + registry
- `opencodeHeadlessAdapter` + all its helpers (`OPENCODE_*`, parse, prepare, grounding)
- `runBackupAgent` / runner core
- `src/session/worktree.ts`
- Artifact helpers and ledger append patterns
- `headless_run` MCP/CLI implementations (for user-facing surface inspiration)

See also the extensive tests under `src/unit-test/backup*.test.ts`, `opencode-sandbox.test.ts`, `headless*.test.ts`.

This analysis + the OpenCode analysis + the approved plan give a clear path for Phase 1/2 implementation.
