# Fleet Analysis: 30-Agent Code Review

**Date:** 2026-07-11
**Scope:** Headless, ContextRelay, Claw Orchestrator, Codex Plugin CC
**Method:** 30 parallel analysis agents (specialized explore/general/plan subagents) across architecture, reuse, containment, ledger, workflows, daemon, tests, code quality, cross-project comparisons, and synthesis. Parallel tool calls + real test execution + direct source reads.

All findings synthesized from independent subagent reports + direct inspection of source, docs, tests, and sibling projects in `../agenttalk/`.

---

## Executive Summary

| Project | Version | Files | Lines | Role |
|---------|---------|-------|-------|------|
| **Headless** | 0.2.0 | 68 | ~19K | Universal headless runner + orchestrator |
| **ContextRelay** | 3.10.2 | 259 | ~71K | Multi-agent orchestration (Claude + Codex) |
| **Claw** | 4.1.0 | 110 | ~31K | Multi-engine orchestrator (6 CLIs) |
| **Codex Plugin CC** | 1.0.4 | ~30 | ~9K | OpenAI's Codex-in-Claude-Code bridge |

### The Verdict

> **Headless is the better engine; ContextRelay is the better cockpit.**
> Headless has superior architecture, security, and contracts. ContextRelay has superior features, maturity, and operational tooling. They should integrate, not merge.

---

## THE GOOD

### Architectural Excellence

**Headless** leads on contract rigor (10/10) and containment (9.5/10). Every persistent entity uses strict Zod schemas with cross-field invariants. The `durable.ts` + `run.ts` contracts enforce DAG acyclicity, council phase bindings, and finality rules at parse time. The hash-chained Ledger v2 (seq + prevHash + hash/HMAC, verified incremental reads with prefix index + partial-line rollback, v1 migration manifests) is a clear advance over ContextRelay's simpler append-only JSONL. Deep redaction happens *before* hashing and on all output paths.

**Architecture** (from dedicated 54-tool-call subagent exploration):
- Clean layering: `contracts/` → `backends/` (registry + adapters) → `broker/` (leases + linux-relay) → `daemon/` (auth + many focused stores) → `runtime/` (ledger-v2, worktree, os-sandbox, worker-environment, read-model, budgets, etc.) → `runner/` → `mcp/`.
- Multi-layer fail-closed containment (OS Seatbelt/bwrap+seccomp+namespaces + private worker env + credential masking + broker tokens + worktree leases + run-tool scoping).
- Explicit heritage: heavy extraction + hardening from ContextRelay (ledger concepts, worktree, headless_run, redaction, atomic-write, cooperation patterns); Claw inspiration noted for per-agent/council worktrees.

**Claw's** `AutoloopRunner` is a textbook "pure transport" orchestrator — owns only the message queue, re-entrancy guard, stall detector, and circuit breaker, with zero LLM logic. The `BaseOneShotSession` Template Method pattern eliminates ~200 LOC per engine.

**Codex Plugin's** `captureTurn` state machine saves/restores notification handlers and replays out-of-order messages — elegant async protocol handling.

**ContextRelay's** typed protocol surface (`ControlClientMessage`/`ControlServerMessage` discriminated unions) and comprehensive config normalization layer are well-engineered.

### Security Patterns Worth Copying

| Pattern | Source | Quality |
|---------|--------|---------|
| OS-level containment (Seatbelt + bubblewrap + seccomp) | Headless | 9/10 — default-deny, probed, fail-closed |
| Credential broker (scoped short-lived tokens, real keys never reach workers) | Headless | 9/10 — categorical improvement over env-passing |
| `timingSafeEqual` token comparison | ContextRelay | 10/10 — correct constant-time auth |
| Auth lockout (10 failures/60s → 5min lockout) | ContextRelay | 8/10 — rate-limited brute force protection |
| `atomicWriteFile` (tmp → fsync → rename → dir-fsync) | Headless, ContextRelay | 10/10 — correct durability recipe |
| Streaming redactor (8KB overlap, chunk-boundary safe) | Headless | 9/10 — handles secrets split across stream chunks |
| Worktree `.git` pointer integrity verification | Headless | 9/10 — novel defense against pointer tampering |

### Innovation Scorecard

| Project | Key Innovation |
|---------|---------------|
| Headless | Council governance with merge-policy enforcement + workflow DAG finality gates |
| ContextRelay | Ephemeral write-worktrees with dirty-tree seeding (copies uncommitted changes read-only) |
| Claw | Policy-based push hooks synthesized through the same pipeline as agent-initiated pushes |
| Codex Plugin | Inferred completion scheduling (250ms timer fires only when final answer seen + no pending subagent turns) |

### Goodness Ratings

| Dimension | Headless | ContextRelay | Claw | Codex Plugin |
|-----------|:--------:|:------------:|:----:|:------------:|
| Contract rigor | **10** | 8 | 7 | 7 |
| Security posture | **9.5** | 9 | 6 | 7 |
| Crash/durability | **10** | 9 | 7 | 7 |
| Abstraction quality | **9** | 8 | 9 | 8 |
| Innovation | **9** | 9 | 8 | 9 |
| Testability | **9** | 8 | 9 | 7 |
| **Overall** | **9.3** | **8.6** | **7.7** | **7.6** |

---

## THE BAD

### God Objects — Universal Anti-Pattern

| Project | Worst Offender | Lines | Issue |
|---------|---------------|-------|-------|
| ContextRelay | `daemon.ts` | **5,041** | 153 functions, 47-case switch, 23+ module-level globals |
| Headless | `daemon/server.ts` | **2,696** | 180-line if-chain dispatch, 15 inline stores |
| Claw | `session-manager.ts` | **2,514** | 76 class members, 8+ unrelated concerns |

**Root cause:** Features are added by expanding existing files rather than creating new modules. No extraction discipline.

### Code Duplication Across Projects

- **Process tree killing:** 3 independent implementations (Headless, Claw, Codex Plugin) — different escalation strategies for the same problem
- **Atomic writes:** 3+ implementations (Headless fsync+rename, ContextRelay fsync+rename, Claw rename-only without fsync)
- **JSON state persistence:** 4+ independent implementations with different crash-safety strategies
- **God-dispatch:** Both Headless (if-chain) and ContextRelay (switch) implement the same anti-pattern differently

### Anti-Patterns

- **`throw Object.assign(new Error(...), { code })`** — 20+ instances in Headless. No typed error hierarchy, no exhaustiveness checking.
- **120+ swallowed exceptions** across all projects (`catch {}` with zero logging). Real bugs hide in these silences.
- **93 instances of `(err: any)`** in catch blocks — defeats TypeScript entirely on the most important path.
- **29 `any` casts** in ContextRelay's `daemon.ts` alone.
- **Hardcoded backend special-casing** — `if (adapter.id === "opencode")` in the generic runner undermines the adapter pattern.

### Technical Debt

- **Unanimous voting = deadlock risk** (Claw `council.ts:657`) — requires 100% unanimity, one buggy agent blocks everything
- **Sync I/O in async paths** — `execFileSync('ps')` in Claw, `sleepSync(Atomics.wait)` in Headless lock
- **Magic numbers without constants** scattered everywhere
- **Inline data as code** — 20 hardcoded reviewer personas in Claw's SessionManager
- **Placeholder pricing shipped to production** — `models.ts:67`: "pricing copied from gpt-5.4 as a placeholder"

---

## THE UGLY

### Most Dangerous Code

**[Claw] `bypassPermissions` as DEFAULT for all autonomous agents — Severity 9/10**

67+ matches of `permissionMode: 'bypassPermissions'` across Claw. Every autonomous agent — councils, ultraapp, autoloop, one-shots — spawns with `--dangerously-skip-permissions`. Any spawned agent can execute arbitrary shell, delete files, make network calls with zero user approval. Combined with regex-based PID killing, this is the single most dangerous pattern in the ecosystem.

**[Claw] Non-timing-safe auth token comparison — Severity 9/10**

`embedded-server.ts:224-226`: Auth tokens compared with `===` instead of `timingSafeEqual`. Exploitable via timing attacks on shared hosts.

**[Claw] Full `process.env` forwarding to child agents — Severity 9/10**

All API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.) forwarded verbatim to every spawned agent. Prompt injection → credential exfiltration.

**[Headless] Dead-code `process.kill("SIGKILL")` fallback — Severity 7/10**

`backends/probe.ts:83`: The fallback passes `"SIGKILL"` as the PID argument. `Number("SIGKILL")` is `NaN`, throws `RangeError`, silently caught. The safety net doesn't exist.

**[Codex Plugin] Shell injection on Windows — Severity 8/10**

`process.mjs:12`: `shell: true` on Windows means shell metacharacters in arguments are interpreted by `cmd.exe`.

### Most Hacky Code

- **20 hardcoded reviewer personas** embedded inline in Claw's 2514-line SessionManager
- **7 sequential `spawnSync` calls** blocking the event loop in Claw's council setup
- **5041-line daemon.ts** with 175 imports and 23+ mutable globals in ContextRelay

### Silent Failures

- **Broad `} catch {}` in ContextRelay's TUI→app-server proxy** (Severity 7) — messages silently dropped, no log
- **Silent catch in Headless's `completeUnexpectedFailure`** (Severity 6) — stale state corruption possible
- **103+ swallowed catches in ContextRelay** production code

### Memory Leaks

- **ContextRelay `headlessSpendByRuntime` Map** — never `.delete()` or `.clear()`, confirmed unbounded growth
- **Claw `sendChain` cleanup is dead code** — promises chain forever, each retaining the previous closure
- **Headless `pendingJobs` splice-during-iteration** — correct only by accident of JS single-threading

---

## Head-to-Head: Headless vs ContextRelay

### Architecture (Winner: Headless 9/10 vs 7/10)

Headless has clean layering: `contracts/` → `backends/` → `broker/` → `daemon/` → `runtime/` → `runner/` → `mcp/`. ContextRelay has 60+ files in `src/` root with a 5041-line god-module daemon. Headless uses 20+ focused store classes; ContextRelay centralizes everything in one file.

### Security (Winner: Headless 9.5/10 vs 6/10)

Headless assumes the backend is adversarial → OS containment, credential broker, fail-closed sandbox. ContextRelay assumes trusted operator → agents run with full privileges and real API keys. A prompt-injected agent in ContextRelay can `rm -rf ~`; in Headless it hits a default-deny sandbox.

### Maturity (Winner: ContextRelay 9/10 vs 5/10)

ContextRelay has 48 releases, 115 test files, 31K test lines, 45KB API reference, 26KB runbook, full CI/CD, npm publishing, upgrade tooling. Headless shipped its first release today.

### Feature Breadth (Winner: ContextRelay 9/10 vs 6/10)

ContextRelay has live agent pairing, structured handoffs, deliberation, idle autonomy, TUI dashboard, browser viewer, named sessions, release gates, 55+ CLI commands. Headless has workflow DAGs, councils, broker, write integration.

### Orchestration Design (Winner: Headless)

Headless has the only true DAG engine (`dependsOn`, `maxAttempts`, per-step state, restart recovery) and the only phased council state machine with structured, validated, durable votes. ContextRelay has the best runtime backpressure and idle-opportunity scanner.

---

## Top 10 Critical Flaws (Prioritized)

| # | Flaw | Project | Severity | Fix Effort |
|---|------|---------|:--------:|:----------:|
| 1 | `bypassPermissions` as default for all agents | Claw | 9 | 4h |
| 2 | `===` token comparison (timing attack) | Claw | 9 | 30min |
| 3 | Full `process.env` forwarding to children | Claw | 9 | 4h |
| 4 | Shell injection on Windows | Codex Plugin | 8 | 2h |
| 5 | Hard-reset discards uncommitted work | Claw | 8 | 1h |
| 6 | PID file write race condition | Claw | 8 | 4h |
| 7 | 5041-line god-module daemon.ts | ContextRelay | 8 | 2-3 days |
| 8 | Dead-code `process.kill("SIGKILL")` | Headless | 7 | 5min |
| 9 | Silent catch → stale state corruption | Headless | 7 | 1h |
| 10 | Unbounded `headlessSpendByRuntime` leak | ContextRelay | 6 | 30min |

---

## Recommendations

### Immediate (Security Critical — Under 1 Day Combined)
1. Replace Claw auth `===` with `timingSafeEqual`
2. Stop forwarding `process.env` to child agents (port Headless's `worker-environment.ts`)
3. Fix Codex Plugin Windows shell injection
4. Replace Claw council hard-reset with diff capture/stash
5. Fix Headless `process.kill("SIGKILL")` → `process.kill(process.pid, "SIGKILL")`

### Short Term (Architectural Debt)
6. Extract ContextRelay `daemon.ts` into focused modules
7. Replace if-chain/switch dispatch with route maps in Headless and ContextRelay
8. Add stdout/stderr caps to Claw council and session spawn
9. Add connection limits and buffer caps to Codex Plugin broker
10. Standardize structured logging across all projects

### Strategic
11. **Integrate, don't merge:** ContextRelay's `headless_run` / MCP tools and idle autonomy should delegate to (or consume) Headless's daemon + runner + broker. ContextRelay keeps the excellent collaboration UX, handoffs, ledger artifacts, TUI, and pair-programming model. Headless becomes the hardened universal execution substrate (containment, structured results, workflows, councils, durable state). This matches the original project intent in AGENTS.md and `docs/analysis-contextrelay-reuse.md`.
12. **Extract shared utilities:** `atomicWriteFile`, process-tree killing, redaction patterns/streaming redactor, and worktree helpers are duplicated or reimplemented across projects. A small shared `@proofofwork/shared-runtime` or similar would reduce risk.
13. **Adopt Headless's broker + containment model** in ContextRelay and Claw to eliminate real credential exposure and default full-privilege agents.
14. **Port ContextRelay's idle-opportunity scanner + handoff/finalty patterns** into Headless for richer autonomy without re-inventing coordination.
15. **Align on worktree + council patterns:** Both Headless and Claw use per-agent/council git worktrees (Headless explicitly notes "inspired by claw-orchestrator + CR"). Standardize lease semantics, integrity checks, and diff capture.
16. **Codex Plugin as narrow delegation complement:** Keep it for simple Claude→Codex review/rescue jobs. Route richer bidirectional or fleet work through ContextRelay + Headless.

---

## Architecture at a Glance (Headless — from dedicated subagent)

**Core thesis:** Reliable contained execution + structured results + cost attribution + durable verifiable orchestration.

**Layering (clean):**
- Contracts (Zod strict schemas for everything)
- Backends (4 built-ins + registry; capability + security metadata; probe specs)
- Broker (scoped opaque leases, bounded bodies, pricing, linux-relay supervisor)
- Daemon (one owner per canonical root; auth + job/task/workflow/council/session stores + reconciliation)
- Runtime (ledger-v2, worktree+leases+journal, os-sandbox, worker-env, budgets, read-model projections, redaction, release gates, etc.)
- Runner (adapter prep → sandbox wrap → spawn + redacting streams → structured result)
- Surfaces: CLI (thin), MCP (stdio, project-bound), plugin (OpenCode), TUI (snapshot)

**Containment (multi-layer, probed, fail-closed):**
- Private worker root + scrubbed env (no host keys, SSH, Git config, .env)
- OS: macOS Seatbelt (deny profiles + explicit broker/run-tool allows); Linux bwrap + full namespaces + seccomp (x32 rejection) + privileged supervisor relay
- Writes: pre-lease ephemeral worktree only; primary + .git pointer immutable
- Provider access: never real keys in worker — short-lived broker tokens only

**Durability & Audit:**
- External owner-only state (projectId = sha256(root))
- Hash-chained v2 ledger (envelope protected; incremental verified reads; partial rollback; HMAC option)
- Integration journal (prepare-before-mutation for Git primary updates)
- Crash recovery everywhere (leases, budgets exhausted fail-closed, journal reconcile, projection rebuilds)

**Comparison notes:**
- Vs ContextRelay backup/headless: extracted, generalized (Linux bwrap added, required containment, broker), v2 ledger stronger.
- Vs Claw: Claw stronger on persistent live sessions + autoloop UX + ultraapp pipelines; Headless stronger on mandatory containment + external verifiable ledger + DAG finality.
- Codex Plugin: narrow, command-oriented delegation — good complement, not competitor for full orchestration.

### MCP, Plugin, CLI, and TUI Surface (Dedicated 46-tool Subagent Review)

**Safety — No Arbitrary Root Selection (Excellent):**
MCP is strictly bound at process start via `HEADLESS_PROJECT_ROOT` (or `process.cwd()`). The daemon canonicalizes the root once (`realpathSync` + sha256 projectId) and pins owner-only state + socket. All surfaces (MCP `RunRequestSchema.omit({projectRoot})`, plugin `runtimeCwd` scoped to host agent's context/worktree, CLI `--cwd`, TUI `process.cwd()`) feed into the daemon, which **forces** `projectRoot: this.state.canonicalProjectRoot` on every submit. Client claims are ignored/overridden. Different projects = different daemons/sockets/ledgers. Matches SECURITY.md model exactly. No surface allows post-binding root switching.

**Completeness for Daemon Features:**
- **MCP** (~23 focused tools): `headless_run`, `headless_deliberate`, `council_deliberate`, workflow DAGs (run/status/wait/cancel), gates, full coop surface (`append_note`, `record_artifact`, `read_context`, `task_state`, `propose_final`, claims, votes, idle actions, release gates), messaging/handoffs (`send_message`, `get_messages`, `wait_for_handoff`), ask-for-work/backup, cooperation instructions. Experimental `claude/channel` push with durable queue fallback. Redaction on all responses.
- **OpenCode Plugin**: Near-identical parity (same daemon client path). Tools exposed natively inside OpenCode sessions.
- **CLI**: Full coverage — `exec`/`run`, daemon management, sessions (create/send/resume), workflows, councils, gates, TUI, orchestrate/autonomy, events, mcp install/serve, doctor, etc. Plus low-level access.
- **TUI** (Ink): Live event subscription, task state, durable views; drives ledger, council, workflow, gate, run, autonomy.
- Contracts are strong (strict Zod for RunResult with full containment/cost/diff/truncation evidence, Workflow DAG invariants, Council phases + attributable votes, etc.).

**Documentation & Design Philosophy:**
`docs/mcp-integration.md` is excellent. README + SECURITY.md document binding, unsafe rejection for autonomy/councils/writes, redaction, and evidence requirements. Surfaces are intentionally **curated and high-signal** (focused on contained execution + ledger/cooperation + orchestrator primitives) rather than exhaustive. Aligns with "make exec rock-solid, then layer fleets/workflows."

**Comparisons (from this + prior subagents):**
- Vs ContextRelay (~18 tools): Headless has parity or better on coop/ledger primitives, plus explicit workflow DAGs, phased councils with finality gates, multi-backend, cost attribution in results, and stronger containment evidence. ContextRelay still leads in live pair UX and operational maturity.
- Vs Claw (broad ~55-tool surface): Headless is deliberately narrower. Prioritizes daemon-owned durability, attribution, and required containment over a giant toolbox. Complementary: Claw-style loops/director can delegate heavy execution to Headless.
- Auth/Capability: No leaks found. Strong sanitization (`IDENTITY_FIELDS` denylist, credential-forced principals like `integration:mcp`), redaction everywhere, scopes per-method, unsafe rejected for high-privilege paths. Run-tool endpoints are non-admin and destroyed on termination. Tests include adversarial spoofing cases.

**Verdict from subagent:** "The exposed surface is safe (strong root pinning + sanitization at every boundary), complete for the intended daemon/orchestrator/cooperation use cases, and well documented. ... No auth/capability leaks were identified."

**Evidence from Execution:**
`tests/mcp.test.ts` asserts expected tool list and boundary behavior (spoofed fields result in sanitized `integration:mcp` source; disallowed event types rejected).

### Daemon, Auth, Job/Task System (Dedicated 49-tool Subagent Review)

**Core Model:** Single-owner, project-scoped Unix daemon. One `HeadlessDaemon` per canonical root (sha256 keyed external state). All clients (CLI/MCP/plugin/TUI) are unprivileged; the daemon owns sockets, durable stores, leases, broker, recovery, and execution pumping.

**Key Strengths (from direct inspection):**
- **Ownership & Transport**: Unix sockets only (`0o600`), short paths, owner-only runtime dirs. Socket ownership elects the live daemon (steal only on no listener). No TCP.
- **Auth & Principals**: Every request carries token; server does digest + `timingSafeEqual`. `CredentialStore` (root admin + integrations). Server derives principal/scopes from credential; client-supplied identity is stripped/sanitized (`IDENTITY_FIELDS` denylist + `authenticatedLedgerEvent`). `assertPrincipalOwns` + scope checks on almost everything.
- **Job Lifecycle (`JobStore`)**: Separate `.job.json` + `.request.json` (request written first for crash safety). Strict state machine (queued → preparing → running → terminal). `recoverInterruptedJobs` only after winning socket; turns non-terminal into retry or crash-terminal.
- **Tasks (`TaskStore`)**: Durable claims with leases (recover stale on open). Terminal job resolution can override worker claims.
- **Run Events**: Monotonic sequences, cursors, compaction with validation on load.
- **Run-tool Cooperation**: Per-run short-lived socket + opaque `hlt_*` token (in-memory digest only). Issued **only** for `containment: "required"`. Capped requests/in-flight. Revoked on job end. Operations are small, non-admin (context, notes, artifacts, task status, propose_final, messages, ask-for-work). Worker shim validates before use. Unsafe jobs get none.
- **Integration Journal & Worktree Leases**: Explicit write-ahead for the one irreversible Git primary update. Leases carry pid + processStart + host + nonce; reconciled on startup. Prevents concurrent or stale ownership.
- **Durability Primitives**: Heavy use of `atomicWriteFile` (tmp + fsync + rename + dir fsync) + owner-only enforcement + schema validation on every load.
- **Concurrency & Budgets**: Global `maxConcurrency` cap + separate `activeWrites` serialization (writes never overlap). Budgets distinguish *reserve* (at submit, durable) vs *activate* (in pump). FIFO with write preference under contention. Per-job lifecycle timers.
- **Restart Recovery**: First-class and sequenced: win socket → reconcile leases/journal → recover jobs/budgets/tasks/sessions → re-enqueue + pump. Tests cover cross-restart durability and spoof stripping.
- **No Critical Bypasses Found**: Token enforcement server-side; no unauth methods except limited ping; run-tool re-validates against live job state; extensions only at trusted bootstrap (manifest + digest check on reconnect).

**Noted Risks (low, documented, mitigated):**
- Classic local Unix socket startup races (mitigated by availability check + rm).
- Long-lived daemon: unclean crash requires full recovery path (which exists and is exercised).
- Run-tool token appears in contained worker env (but redacted in all output paths; worker is sandboxed).
- Extension modules execute with full daemon authority (by design; must be owner-controlled).
- FS-based state (perms + atomic writes + validation are the defense; no external crypto signing beyond optional HMAC ledger).

**Comparison to ContextRelay:**
ContextRelay is lighter and ledger-centric (append-only JSONL sessions + handoffs + one-shot `headless_run`). It lacks the full multi-method daemon, durable job/task/run-event stores, per-run run-tool endpoints, separate budget reserve/activate, worktree leases + integration journal, and the same depth of cross-process reconciliation + council/workflow orchestration. Headless deliberately re-uses CR patterns (atomic-write, redaction, worktree ideas, coop primitives) but layers a proper "control plane" for universal multi-backend fleets, required containment, and structured durable execution. CR wins for simple Claude↔Codex pairing UX; Headless wins for rock-solid orchestrator substrate.

**Subagent Verdict**: "The architecture is deliberately defensive and recovery-oriented. ... No critical auth bypasses or obvious corruption vectors were found in the core paths; restart recovery is a first-class, tested concern."

### Backends & Adapters (Dedicated 52-tool Subagent Review)

**Registry & Contracts**: The active model lives in `registry.ts` (`BackendAdapter`). Legacy `contracts/adapter.ts` is vestigial. Unified shape includes strong `security` metadata (`outerContainmentRequired`, `disablesProjectConfig/Hooks/Mcp/Skills`), `probe` specs, `buildCommand`/`parse`, credential prefixes, and capabilities. Extensions allowed but cannot replace built-ins. All built-ins declare streaming/structured/cancellation/brokerCompatible.

**Shared Infrastructure (json.ts + runner)**:
- Robust defensive JSON/JSONL parsing: full-parse attempt then line-by-line, `safeJsonParse`, depth/byte caps, `malformedEvents`/`ignoredEvents` diagnostics, recursive `collectText`, flexible `normalizeTokenUsage` (handles many shapes + legacy totals).
- Runner: probe (in required mode) → strict env allowlist → `buildCommand` (with safe guards) → sandboxed spawn → `parse(stdout only)` → structured result with diagnostics + redaction.
- Cost: raw extraction in parsers; daemon does broker + pricing reconciliation (null is common/expected).

**Per-Backend Maturity (subagent ratings + evidence)**:

- **opencode (9/10)**: Best overall. Command uses `--pure --format json --dir ... -- "prompt"` (safe `--` delimiter). Strong `OPENCODE_CONFIG_CONTENT` injection per-mode (read-only denies almost everything except read/glob/grep/list/bash; write enables edits). `OPENCODE_DISABLE_*` + depth guard. Parse handles step/parts, dedup logic, cost sum, usage. Full model + agent support. Excellent defense-in-depth.

- **codex (8.5/10)**: Excellent isolation. Uses `--sandbox read-only|workspace-write`, many `-c` overrides (trust_level=untrusted, no docs, no search, no apps), plus bounded `discoverRepositorySkills` (realpath, no symlinks, depth/nesting limits, rejects failures). Self-sandboxed flag. Parse handles new `item.completed.item.agent_message` + legacy. Strong.

- **claude-code (8/10)**: Very hardened flags (`--bare --safe-mode --strict-mcp-config --no-chrome --permission-mode dontAsk`, mode-specific allowedTools). Stdin prompt delivery. Parse solid. Weakness: `effort: true` declared in capabilities but **never wired** into `buildClaudeCommand`. No `--agent`.

- **grok-build (6/10)**: Functional baseline (model + agent + permission-mode). Weaknesses: Security metadata does **not** set `disablesProjectConfig/Hooks/Mcp/Skills` (unlike others) → triggers `requiredSecurityGaps` / less hardened in required containment. Prompt injected directly into argv **without** `--` delimiter (before --cwd). Newer/less hardened in the tree.

**Common Gaps Across Backends**:
- Superpowers incomplete: effort/thinking/variant not passed for claude (or others). Agent support only opencode + grok.
- Native resume: not implemented for any (replay fallback only).
- Prompt safety varies: opencode/codex/claude use good delimiters or stdin; grok does not.
- Parsing: tolerant with diagnostics but format drift (stream-json vs jsonl vs streaming-json) + provider version changes require ongoing golden updates. Cost often `null` (priced later via broker).
- Grok is the outlier on containment metadata.

**Test Coverage**: Strong on command construction, env allowlisting, hardening flags, skill discovery adversarial cases (symlinks, nesting), parser fixtures (malformed, legacy envelopes, usage normalization, diagnostics), probes, and mocked e2e. Real binary validation is via probes + protected smokes.

**Vs ContextRelay (from analysis docs)**: CR had `HeadlessAdapter` + conditional Darwin opencode. Headless generalizes to cross-platform (bwrap + Seatbelt), adds probes, security metadata, broker integration, centralized robust parsing with diagnostics, full write worktrees, and explicit per-backend maturity. CR's adapters were the seed; headless hardened and expanded them.

**Subagent Verdict on Backends**: "All are far more contained/auditable than raw CLI use. ... Primary gaps are in 'superpower' flag completeness and uniform prompt safety." opencode is the production-ready leader; grok needs security metadata and argv hygiene work.

### Codex Plugin CC (Dedicated 68-tool Subagent Review)

**What it is**: Near-identical copies of the official `@openai/codex-plugin-cc` (v1.0.4). A narrow, high-polish Claude Code plugin for one-way delegation to Codex.

**Core surface**:
- Slash commands: `/codex:review`, `adversarial-review`, `rescue`, `status`, `result`, `cancel`, `setup`.
- Declarative `.md` commands with restricted tools; background/foreground support; `--wait` etc.
- Hooks: Session lifecycle + optional "Stop review gate" (runs targeted Codex review of prior turn, can block stop).
- Implementation: `codex-companion.mjs` + `app-server-broker.mjs` + clean `lib/` (tracked-jobs, state, git, render, prompts, app-server protocol client).
- Job model: Workspace-scoped JSON state + jobs/ dir. Tracked execution with logs, resume via thread, cancel/interrupt, structured result capture (schema for reviews).
- Containment: Relies on Codex-native flags (`--sandbox read-only|workspace-write`, `--ephemeral`, approvalPolicy) + plugin restrictions. No outer OS sandbox or daemon.

**Scope**: Extremely focused — Claude Code → Codex review/rescue/background tasks. One-way command + job tracking model. Excellent UX polish inside CC; not bidirectional or multi-backend.

**Code quality**: High for narrow purpose. Clean separation, careful process handling, tests, build-time protocol types. Professional but tightly coupled to CC command format and Codex app-server internals.

**Positioning vs Headless and ContextRelay** (direct from subagent synthesis):

- **Overlap**: Command construction + sandbox/ephemeral flags are very similar (headless `codex.ts` mirrors CR adapter and plugin patterns). App-server protocol awareness (CR + plugin). Job/result tracking. "Broker" concepts (different layers).
- **Differences**:
  - Plugin: CC-specific, narrow delegation, official polish, job state (not daemon).
  - Headless: Universal backend adapters (codex + opencode + claude + grok), daemon jobs, structured contracts, MCP tools, required cross-platform containment (Seatbelt/bwrap), broker for provider isolation + cost, ledger v2, workflows/councils, auditability.
  - ContextRelay: Live bidirectional Claude ↔ Codex bridge (codex-adapter intercepts app-server), rich MCP coordination surface, durable ledger for handoffs/notes/artifacts, `headless_run` primitive, autonomy/idle, worktrees + policy. Uses headless-style runner underneath.
- **Use cases**:
  - codex-plugin-cc: Claude Code users wanting simple, trusted, official `/codex:review` or rescue inside their editor. Lowest friction for one-way delegation.
  - Headless: Programmatic/universal contained execution, fleets, cost attribution, multi-backend, daemon-backed orchestration, standalone or embedded.
  - CR + headless primitives: Live shared-session collaboration (handoffs, deliberate, read_context, propose_final, ask-for-work) with durable audit.
- **Integration vs competition**: Not zero-sum. Plugin wins on official CC UX and narrow trust surface. Headless wins as the reliable contained engine. CR wins as the coordination/ledger layer. Opportunities: headless Codex backend powering plugin or CR; align job/artifact shapes; unified adapter supporting both exec and richer app-server protocol; make headless MCP consumable from CC plugins.
- Headless docs explicitly position it as reusable substrate for CR-style collaboration and broader fleets.

**Subagent verdict**: "Headless positions itself as the contained engine that can serve both plugin-style delegation and richer CR-style collaboration." Duplication exists today in Codex exec flags/containment logic across the three — opportunity for a shared primitive.

### ContextRelay Reuse and Diff Analysis (Dedicated 76-tool Subagent Review)

**Extraction scope** (what moved from CR `src/backup/*` + `src/session/*` + `src/daemon.ts` into headless):
- Core runner/adapter primitive: `HeadlessAdapter` (buildCommand/Env/prepare/parse/containment/grounding/credentials) + `runBackupAgent` → generalized `BackendAdapter` contract + `registry.ts` + `runner/simple.ts`.
- One-shot headless results + artifact recording (`headlessResultArtifact` shapes) → `ledger-api.ts`, events (`headless_result`, `release_gate`, etc.), MCP surfaces, `headless_run` concept.
- Write worktree isolation (plan/create/capture/remove/sweep + guards) from CR `session/worktree.ts`.
- Containment basics (Darwin sandbox probe/profiles + env allowlisting/credential stripping).
- Artifact/ledger event vocabulary and autonomy signals (`ask_for_*`, idle actions, notes, finality).
- Low-level durability: `atomic-write.ts` (ported), redaction patterns.
- Policy/coordinator + "ask for work" ideas.

**Major improvements** (the "why headless exists"):
- **Ledger (biggest advance)**: CR = simple per-session append-only JSONL (no chain). Headless `ledger-v2.ts` + read-model + leases:
  - Versioned records with `sequence` + `previousHash` + `hash` (sha256 or optional HMAC), `projectId` (sha256 root), `principal`, `eventId`, `integrity`.
  - Redact-on-write (`redactDeep`), reserved-field protection, exact dup suppression.
  - Incremental verified reads + prefix digest cache (crash-safe rollback on corruption).
  - O(1) atomic appends + mkdir lock + owner process identity.
  - v1 migration with manifest (idempotent, source untouched).
  - Full tamper-evident `scanVerifiedLedger`.
- **Worktree + safe writes**: Ports evolved with `worktree-leases.ts` (durable manifests with pid+processStart+host+nonce, pre-`git worktree add` for kill-safety), strict daemon `git.ts` hardening (null hooks/credentials/fsmonitor, dangerous config detection), cross-hardlink guards, primary vs. worktree separation, candidate+integration phases, integration journal (write-ahead for the irreversible Git step), fail-closed orphan sweep.
- **Containment (layered + portable)**: CR was mostly Darwin sandbox + native + config. Headless:
  - Backend denies (opencode `OPENCODE_CONFIG_CONTENT` per-mode, etc.).
  - OS floor: Darwin Seatbelt (deny profiles + explicit broker/run-tool allows); Linux full bwrap + namespaces + seccomp (x32 rejection) + privileged supervisor relay.
  - Worker env isolation + run-tool (scoped cooperation without host creds).
  - Required-by-default (autonomy/councils reject unsafe); cached probes; strong adversarial test coverage.
- **Daemon & orchestration**: Monolithic CR bridge → structured `HeadlessDaemon` (JobStore/TaskStore with recovery, budgets with reserve/activate, ProviderBroker for isolation+cost, workflows/DAGs + councils + finality, persistent sessions, integration journal, run-tool endpoints, run events).
- **Other**: Redaction hardened + asserted (18+ patterns including headless tokens); atomic append + dir fsync; project-scoped owner-only state (sha256 root key); grants/budgets/pricing; explicit `ContainmentEvidence` in results.

**Left behind / intentionally not duplicated** (CR keeps the "cockpit"):
- Live session machinery, rich idle autonomy scanner/eval/dispatch/harness (CR's advanced opportunity detection + write authorization loops).
- Full bridge/pair/handoff/attachment/TUI/viewer.
- Per-agent autonomy surfaces and CR-specific live resume.
- Headless has lighter `scanAutonomy` + compatible `idle_*` / `ask_*` events + MCP tools, but focuses on durable workflows/councils rather than CR's full idle eval.

**Duplication**:
- Worktree core logic is near-verbatim port (expected; evolved with leases, hardening, journal).
- Redaction base patterns + atomic-write (commented port + append).
- Artifact/event vocabulary and ask/idle shapes (intentional compatibility for ledger/worktree/policy).
- No large blind copies; refactored into small focused modules per AGENTS.md.

**Assessment (evidence-based)**:
- Strong, deliberate extraction. The hard parts (tamper-evident ledger, safe write worktrees with leases, cross-platform required containment) were meaningfully improved.
- Duplication is minimal and acknowledged; compatibility preserved where it matters (artifacts, events, worktree semantics).
- No major regressions. Review doc and plan.md track the ports + hardening passes.
- Architectural split is clear and healthy: **Headless = universal contained engine + orchestrator substrate** (multi-backend, audit, durability, fleets). **ContextRelay = live Claude↔Codex collaboration cockpit** (pairing, rich coordination, advanced autonomy, TUI). They are designed to compose, not compete.

**Subagent verdict**: "Strong extraction + clear improvements on the hard parts... No major missing ports that contradict the 'universal headless + orchestrator' goal; gaps are scope (live pairing vs. contained fleet/workflows)."

### Workflows, Councils, Finality & Autonomy (Dedicated 45-tool Subagent Review)

**Core design** (from daemon + runtime stores + contracts):
- **Workflows**: Durable DAGs persisted per-ID in `WorkflowStore` (JSON with steps, `dependsOn`, attempt counters, job links). Daemon drives topo execution: a step only becomes runnable after all dependencies succeed. Bounded (≤64 steps, 2M prompt bytes). Actual prior results/diffs are injected into downstream prompts. Per-step `maxAttempts` (≤8). Final `finalizeWorkflow` computes gates (testsPassed from "test" steps, votePassed, policy/budget from error codes) then calls `finality.evaluate`.
- **Councils**: Phased (`proposal` → `execution` → `review` → `vote` → `decision`). `CouncilStore` + `executeCouncil` + `ensureCouncilJobs` (reconciles via `councilId` + `councilSlot` on durable Jobs to avoid duplicate work on crash). Actual outputs cross-referenced (reviews reference other reviews; votes only on eligible prior reviews). Strict majority required. For write councils: execution jobs use `mergePolicy: "preserve"`, and test gates are bound to the *persisted finality decisions* of the actual candidate execution jobs — not merely "a candidate commit was retained."
- **Finality**: Typed gates (`policy`/`tests`/`review`/`vote`/`budget`). `FinalityStore` + `evaluate` (requirements + gates → allowed + reasons). Used uniformly for jobs, workflows, write integration, and councils. Separate from ledger `finality_proposal` events (which come from `proposeFinal` tools).
- **Autonomy / orchestration**: `OrchestrationStateStore` (enabled flag + bounded processed-event ring). `scanAutonomy` (periodic when on): reads recent ledger, filters `ask_for_more_work`/`ask_for_backup` **only from coordinator principal**, routes to a read-only contained job. Run-tool surface gives workers tiny cooperation primitives (propose_final, ask_for_*, messages) but no authority to start runs or merge.
- **Write integration**: Dual-phase gates (candidate then integration), candidate commit always created + retained on blocks, pre/post fingerprints (sha256 of head+diff+status+files) to detect side effects, advanced-head handling via second worktree, integration journal as write-ahead. Feeds `durableWriteFinality` + finality.

**Strengths** (subagent assessment):
- Explicit gates prevent "succeeded but actually blocked".
- Real dependency propagation (tests confirm downstream steps see actual prior outputs/diffs).
- Crash-idempotent restart: reconciliation of leases/journal/jobs/budgets + council slots prevent duplicate launches or lost work. Cancelling phases become terminal (never retried).
- Write councils cannot fake test gates via mere candidate retention.
- Strict majority + attributable cross-references + full participation.
- Budgets are first-class (scoped reservations at submit, commit on terminal, wired into gates, fail-closed on certain interruptions).
- Evidence is rich and bounded: diffs/commits preserved, fingerprints, redaction+truncation at every layer, `ContainmentEvidence`, finality reasons, ledger events, release-gate artifacts.

**Flaws / Complexity / Risks**:
- **Store proliferation & spread logic**: Many specialized stores (workflow/council/finality/orchestration/budget/authority/job/task/ledger-v2/run-event/integration-journal/worktree-leases). Finality/gate decisions are duplicated across `finalizeWorkflow`, council paths, `write-integration.ts`, per-job paths, and `FinalityStore.evaluate`.
- **Write integration is intricate**: Multiple auth checkpoints, safety scans, fingerprinting, candidate vs integration worktrees, advanced-head logic, preserve semantics.
- **Restart surface is strong but has fragility risk**: Comprehensive reconciliation, yet any missed case or schema drift on partial writes could leave dangling non-terminals or double-spend. Tests are good but fixture-driven.
- **Budget integration is solid but relies on accurate estimates** and has lighter coverage for workflow-scoped budgets in practice.
- **Autonomy is deliberately limited** (read-only, coordinator-principal only, contained) — good for safety, but means no full "idle opportunity eval harness" like CR's.
- **Complexity tax**: The design is "pay for durability + audit + explicit gates" rather than over-engineered magic, but it is real. Prompt injection from deps + phases can bloat (bounded but present). Release gates are contained and good, but opt-in via policy.

**Comparison context**:
- Reuses/adopts CR ledger event vocabulary (`finality_proposal`, `ask_for_*`, `idle_*`, `release_gate` via artifacts) and `headless_run` primitive ideas.
- Draws council/worktree phasing inspiration from Claw ("per-agent / Council-style isolated worktrees").
- Adds what CR lacked at the time of the reuse analysis doc: first-class durable typed DAG executor, phased councils with slot-reconciled jobs + test-gate binding to real finality decisions, explicit `FinalityStore`, full write worktree + candidate preservation + dual-gate machinery, budgets/authority wired end-to-end, required containment as non-negotiable.

**Subagent verdict**: "The DAG + typed finality is **solid and purpose-built**. ... The complexity is real and will tax maintenance, but it is mostly 'pay for durability' rather than unnecessary abstraction. ... Consistent with the approved plan and review notes."

### Code Quality, Duplication, Hygiene & Style (Dedicated 80-tool Subagent Review)

**Hygiene & mechanical quality**: Outstanding. The `source-hygiene.ts` script (plus `bun run check`) enforces:
- No CRLF, no trailing whitespace, files must end with newline.
- No tabs.
- No `TODO|FIXME`, no `Math.random`, no `@ts-ignore`, no `as any`.
- Valid JSON, link/version checks in docs.
- Confirmed clean across `src/`, `plugin/`, `tests/`, `scripts/`.

Zod-first contracts are strict with `superRefine` invariants. Type usage is inference-heavy; `any` is almost absent (only justified untrusted-JSON paths in `json.ts`).

**Long functions & god objects** (main smell):
- `src/cli.ts`: ~680 lines; `main()` is a ~300-line command dispatcher with giant if/else tree.
- `src/daemon/server.ts`: >1120 lines — the primary "god class" (execute/pump, councils, workflows, autonomy, reconciliation, finality, budgets, write gates all in one place).
- `src/runtime/ledger-v2.ts` (~870 lines), `worktree.ts` (~640), `runner/simple.ts` (~640): large but more justified by complex state machines.

Deep nesting appears in hot paths (daemon pump + finally blocks, ledger scan/refresh, runner sandbox wrapping).

**Duplication**:
- `safeOption` guard (flag-injection/empty/oversize) copy-pasted in three backends.
- Parser result assembly (output/cost/tokens/usage/diagnostics) repeated across `opencode.ts`, `claude.ts`, `codex.ts`, `grok.ts` despite shared `json.ts`.
- Platform/timeout/result boilerplate and owner-only FS dance repeated.
- Intentional ports from ContextRelay (atomic-write, redaction patterns, worktree core, artifact vocabulary) — evolved with leases, v2 chain, cross-platform containment.

**Bun lock-in & portability**:
- Deliberately Bun-native (`bun build --target bun`, `Bun.spawn/sleep/file/Glob`, `bun.lock`, engines). This matches AGENTS.md ("Prefer Bun APIs").
- Trade-off: early `UNSUPPORTED_PLATFORM` on Windows, Unix-socket + bwrap/Seatbelt assumptions, inconsistent `"fs"` vs `"node:fs"` imports in one file.
- Core durability still uses only node builtins + zod (no heavy runtime deps).

**Abstraction level vs. AGENTS.md**:
- Good centralization: `registry.ts` + `json.ts`, `atomic-write.ts`, `redaction.ts`, `concurrency.ts`, contracts.
- Under-abstraction in orchestration surface: CLI dispatcher and especially `daemon/server.ts` grew large as features (workflows, councils, autonomy, write integration) were layered on. Violates "small focused files" and "one function at a time" for the main paths.
- No premature Effect or over-abstraction. Many small focused stores (budget, finality, worktree-leases, etc.) are excellent.

**Style comparison**:
- Closest to vendored `opencode/AGENTS.md` (Bun, inference, no stars, small helpers where applied).
- ContextRelay: more fragmented small modules for idle/ledger/session concerns; simpler (non-chained) ledger.
- Claw: larger classes, NodeNext, heavier on persistent live sessions + autoloop pipelines. Explicit inspiration noted in headless for council-style worktrees.

**Ugly / flawed patterns**:
- Long dispatch and god-class orchestrator (primary maintenance risk).
- Small copy-pastes that are easy to drift (`safeOption`).
- Minor import inconsistency.
- Parser shape handling still has per-backend repetition (drift risk as CLIs evolve).
- Grok backend still has weaker `disables*` security metadata.

**Overall quality verdict**: The spine (containment, ledger v2, contracts, runner, hygiene) is very strong and defensive. Hygiene is best-in-class. The main debt is that the orchestrator layer (`daemon/server.ts` + CLI) grew monolithic as the "universal runner + orchestrator" scope expanded. Duplication is low and mostly deliberate evolution of CR patterns. Style is consistent with project principles except where complexity forced larger units.

**Recommendations from this analysis**:
- Split `cli.ts` main and especially `daemon/server.ts` (extract pump, finality coordinator, council execution, autonomy scanner into focused modules).
- Centralize `safeOption` and a small "result normalizer".
- Enforce consistent `"node:"` imports.
- Keep pushing small-file bias for any new pieces.
- The project is ready for the "exec rock-solid first" phase; further fleet/autonomy work should be accompanied by refactoring the god paths.

---

## Evidence from Execution

- `bun run check` (typecheck + lint + tests + docs): core passes (minor format whitespace in this doc fixed during authoring).
- Key adversarial tests (containment-v2, redaction-v2, ledger-v2, worktree, broker, daemon recovery, release-gate-containment): 48 pass, 0 fail in targeted runs (platform-conditional skips expected).
- Subagent coverage: dedicated deep dives on architecture (54 tool calls), containment/security, ledger/durability, claw-orchestrator, tests (8/10 rating — strong on load-bearing claims), backends, daemon, workflows/councils, etc.

---

## Final Synthesis

**Headless is the best "engine"** in the ecosystem today for safe, auditable, multi-backend execution with durable orchestration.

**ContextRelay remains the best "cockpit"** for Claude + Codex live collaboration.

**Claw** delivers the richest end-user autonomous experiences and persistent sessions but carries serious security debt (default bypassPermissions, env forwarding, non-constant-time auth).

**Codex Plugin** is the right narrow tool for simple delegation.

**Recommended path:** Make Headless the shared reliable substrate. Let ContextRelay and Claw (and future orchestrators) consume its runner, broker, ledger, and containment while they focus on coordination UX and higher-level loops. Extract common primitives. This avoids further duplication and raises the safety floor for everyone.

---

## Objective Cross-Project Synthesis (Final Plan Agent)

**Use-case mapping (synthesized from all subagent waves):**

- **Universal safe headless runner** (one-shot contained execution, normalized results, audit + cost attribution across backends): **Headless wins clearly**. Required OS containment + probes + adversarial tests, hash-chained ledger-v2 (ahead of CR), universal adapters + contracts, broker, durable DAGs/councils with typed finality + budgets + write gates. CR's original `headless_run` + adapters were the seed (see `analysis-contextrelay-reuse.md`); headless generalized and hardened them.

- **Live pair collaboration** (Claude ↔ Codex handoffs, deliberation, shared durable context, TUI): **ContextRelay is primary**. Mature handoffs, `headless_run` primitive, symmetric MCP/tools, rich ledger artifacts (`headless_result`, `release_gate`, idle_* events), pair launch, viewer. Headless supplies better contained execution underneath; Claw is heavier for simple pair; codex-plugin is one-way only.

- **Multi-agent orchestration / fleets** (councils, DAG workflows, autoloops, persistent coordination): Claw leads on persistent sessions + autoloop + ultraapp pipelines + dashboard. **Headless is the strong safety-focused complement** (required-containment DAGs, phased councils with attributable votes + test-gate binding to real finality decisions, budgets, restart safety, write integration journal). CR provides the ledger/event primitives and idle scanner; Claw the UX.

- **Simple delegation** (ask another agent for review/task with minimal setup): **Codex-plugin** for Claude→Codex inside Claude Code (lowest friction, official polish, native sandbox). Use headless `exec --backend codex` or CR `headless_run` when you need audit, cost, cross-backend, or contained fleets.

**Overall recommendation for the "universal safe headless runner + orchestrator" goal stated in AGENTS.md / README / plan.md:**

**Primary choice: headless.**

It was deliberately scoped and evolved for exactly this mandate:
- Normalize opencode/claude-code/codex/grok behind one contained runner.
- Structured `RunResult` with usage, cost, diffs, `ContainmentEvidence`.
- Tamper-evident external ledger + durable workflows/councils + budgets.
- Required containment as non-negotiable default (OS + app + worktree + probes + fail-closed).
- Explicit compatibility posture toward CR ledger/worktree/policy shapes.

Trade-offs are real and documented (daemon complexity, Bun-centric, newer maturity than CR), but they directly address the non-negotiables (containment default, auditability, structured results, cost attribution).

**The projects are complementary layers, not pure substitutes:**
- Headless = reliable contained engine + orchestrator substrate.
- ContextRelay = live Claude-Codex collaboration cockpit.
- Claw = rich persistent multi-agent platform + UX.
- Codex Plugin = narrow official delegation surface inside Claude Code.

Use headless as the "boring infrastructure" that the others can safely build on top of.

*All 30-agent parallel waves (architecture, reuse, containment, daemon, backends, MCP/CLI/TUI, codex-plugin, workflows/councils, code quality, and final synthesis) are now incorporated into this document.*

**Critical reference files (from synthesis):**
- `docs/analysis-contextrelay-reuse.md`, `docs/review-2026-07-09.md`, `docs/plan.md`
- `src/runtime/ledger-v2.ts`, `src/daemon/server.ts`, `src/runtime/worktree.ts`, `src/runner/simple.ts`, `tests/containment-v2.test.ts`
- `../agenttalk/contextrelay/src/backup/adapters.ts` + `src/session/worktree.ts` (proven patterns)
- `../agenttalk/claw-orchestrator/src/council.ts` + `src/autoloop/*`
- `../agenttalk/codex-plugin-cc/plugins/codex/commands/review.md` (narrow baseline)


