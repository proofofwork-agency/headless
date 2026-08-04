# Changelog

## Unreleased

### Breaking

- **Ledger HMAC keys used to sign new records must be at least 32 bytes and pass an entropy floor.** Shorter or low-entropy keys (repeated characters, pure digits, common password shapes) are refused at the signing boundary: `append` and ledger tail repair fail closed, naming the key id and the variable that supplied it. A human-memorable 16-character secret provides false tamper-evidence, so it is rejected rather than accepted. **Rotate**: generate with `openssl rand -base64 32`, keep the old key in `HEADLESS_LEDGER_KEYS` so historical records stay verifiable, and point `HEADLESS_LEDGER_ACTIVE_KEY_ID` at the new one.
- **Unix control sockets are created `0o700`, not `0o600`.** They are bound under `umask 0o077` instead of being chmod-ed after `listen`, which closes the window where the socket existed at the ambient umask. Owner-only either way; only the observed mode changed.
- **The whole `HEADLESS_LEDGER_*` family is denied to worker environments**, by prefix rather than by name. A worker that could read the keyring could forge ledger entries, which is the property the HMAC exists to provide.

### Fixed

- The ledger key floor no longer blocks reading an existing chain. It was enforced while parsing `HEADLESS_LEDGER_KEY` / `HEADLESS_LEDGER_KEYS`, so an operator holding a 16–31 byte key could not start a daemon at all and `headless verify` failed with `Timed out waiting for the detached Headless daemon` instead of anything about keys. Verification now proceeds and reports the weak key in the verdict (`weakKeys`, printed by `headless verify`); only signing is refused. A weak key kept solely for verifying history no longer blocks a strong active key, which is what makes the documented rotation possible.
- A weak singular `HEADLESS_LEDGER_KEY` no longer reports `HEADLESS_LEDGER_KEYS` as the offending variable. The refusal names the key id and the variable that actually supplied it.
- Ledger key failures no longer embed the first four characters of the key. That preview reached the `headless verify` verdict, which is printed and routinely pasted into bug reports; keys are now identified only by id.
- Restored Unix-socket bind exclusivity. The bind helper cleared the socket path before every bind, so `listen()` could never raise `EADDRINUSE` — the kernel backstop that made each caller's check-then-bind safe. Stale-socket policy belongs to the caller, and every caller already implements it.
- Concurrent socket binds no longer corrupt the process umask. The window is reference-counted and await-spanning binds are serialized, so the baseline is restored exactly once.
- A Bun listener refused by post-bind ownership verification is now disposed instead of leaked; the caller never receives that handle and so cannot close it.
- `process.getuid` is guarded and fails closed where unavailable. The uid comparison is the only defence against a foreign-owned socket, so an unverifiable platform refuses rather than skipping the check.
- The offline linked-hold lock now binds through the same verified helper as every other socket.

## 0.2.0-beta.6 — 2026-07-31

Package publication remains blocked. Both package manifests are private at `0.2.0-beta.6`; npm publication and repository visibility remain separate human-authority decisions. This tree is an unpublished private beta (not alpha).

### Added

- Product Gate P and opportunity solution tree (`docs/product-gate.md`, `docs/product-ost.md`) with `bun scripts/product-gate.ts` / `bun run check:product` wired into `check`.
- MCP **lead-core toolset** (default): ten round-trip tools are advertised/callable unless `HEADLESS_MCP_TOOLSET=full` restores the complete registry. Core includes context read/note, message receive/send, and completion proposal pairs while remaining a subset of existing scopes. Enforced on both `tools/list` and `tools/call` (and the OpenCode plugin).
- Dual native-login validator: `bun run validate:dual-native` (codex + opencode).
- Golden-path `headless setup` wizard: init, CLI inventory, optional native trust grant, printed next commands.
- Exec `--profile read-only-native|broker-readonly` presets that collapse auth/mode/containment flags without weakening required containment.
- CLI remedy matrix (`src/cli/remedy.ts`) so top structured failures print a copy-paste next command.
- Artifact-first `exec` footer: job id plus `verify` and experimental `receipt show` one-liners.
- TUI authority ladder and richer Overview next-actions (trust, native consent, lead, first exec).
- `headless doctor --json` readiness panel: trust, backend PATH + native capsule presence (no secret reads), broker env flags, copy-paste next actions.
- Setup/doctor surface Claude setup-token remedy on macOS when the capsule is missing.
- `exec --json` embeds `next.verify` / `next.receipt` for scripted golden paths.
- TTFV smoke: `bun run smoke:ttfv` (ceremony) and `bun run smoke:ttfv:live` (real native turn), evidence at `docs/internal/release-evidence/ttfv-smoke.json`.
- Live validators now own bounded daemon shutdown, interrupt handling, and temporary-root cleanup; exact requested model output is required for live TTFV and dual-native success.

### Changed

- Default help banner documents the golden path; `setup` joins the Beta 1 stable command set.
- README and website quickstart lead with one path instead of multi-flag ceremony.
- Product Gate treats kernel verification and stale/ceremony TTFV evidence as manual instead of self-certifying them green.
- Operator docs (root README, SECURITY, CLI/TUI guide, native-login, MCP, plan, plugin README) synced to `0.2.0-beta.6`: stable surface includes `setup` and `daemon serve|status|stop|reap`; cross-provider `run.delegate` linked holds documented as implemented; MCP lead-core default and auth-default split (MCP tools vs CLI/daemon) corrected; Grok disposable capsules strip `refresh_token`.
- Version bump to `0.2.0-beta.6` in `src/version.ts`, root `package.json`, and plugin package/peer.

## 0.2.0-beta.5 — 2026-07-27

Package publication remains blocked. Both package manifests are private at `0.2.0-beta.5`; npm publication and repository visibility remain separate human-authority decisions.

All four advertised backends now complete a real native-subscription turn. Grok was previously refused for every ordinary project.

### Added

- A gate-driven repair loop that treats the release gate as the oracle: it compiles a repair graph from the failing checks, runs the repairs, and re-gates until the project is green, its cost or deadline cap is spent, or it stops making progress. Repair steps chain serially so each one sees the previous one's work, and the verifier runs on a contrasting backend.
- Convergence for a repair loop under `preserve`. Each iteration bases its candidate on the previous candidate commit rather than primary HEAD, so a loop accumulates work and re-gates the accumulated tip while the operator's checkout stays byte-identical. The final candidate is a single integrable commit.
- `optionalDependsOn` on workflow steps: dependencies that must settle but need not succeed, so one failed node no longer silences a verifier that could still report on the work that landed.
- Process-table daemon discovery (`runtime/daemon-inventory.ts`) and `headless experimental daemon reap`, which reclaim daemons whose own state homes have been discarded. Metadata-based discovery cannot find these, because a leaked daemon carries its metadata inside the home that went away.

### Fixed

- Attest isolation once. `native-session-manager.ts` carried a strict-only reimplementation of the trust attestation, so the two-phase canary fallback added in `0.2.0-beta.4` reached only the runner and never the path that Grok subscription logins use. A project with no trust-gated control surface reports a vacuous `projectTrusted: true` that the strict validator must reject, so Grok failed closed on every ordinary project. Both the policy and the bounded-result normalization now live in `runtime/isolation-attestation.ts`; a launch path supplies only how to run an inspection, never when to accept it.
- Stopped a Grok worker revoking the operator's own login. The capsule copy carries no refresh token, which makes the entry non-refreshable in Grok's own auth model, so a disposable worker can no longer rotate a credential it cannot persist. `GROK_AUTH_EARLY_INVALIDATION_SECS` only ever removed the proactive buffer; it never prevented a refresh on 401.
- Stopped a torn-down goal store failing the process. Delegations execute fire-and-forget, so a store discarded while an attempt was in flight let the persistence error escape an unobserved promise and left the awaiting caller unsettled. Settlement, the deadline timer, and disposal are now guarded.
- Corrected the secret scanner's call lookahead so a member expression assigned to an auth-named field is no longer redacted as a credential. The scanner is fail-closed, so this false positive rejected valid agent writes outright.
- Stopped the TUI footer colliding: key hints now win the available width, the caption yields whole rather than truncating, and hints are dropped intact instead of being clipped mid-token. Overview chrome is trimmed.
- Moved `get_messages` into the `headless_` tool namespace, so an agent told to use Headless no longer reaches a similarly named tool from an unrelated MCP server.
- Bound Codex's `CODEX_HOME` to the isolated worker capsule and pinned project discovery to the requested working root for one-shot and persistent native sessions, preventing unrelated ancestor markers from exposing the operator's real `~/.codex/config.toml` to the contained CLI.
- Made Grok OIDC readiness expiry-aware for each bounded turn. Headless now requests a fresh login before a disposable capsule can rotate a refresh token that cannot be persisted, and classifies the CLI's `Not signed in` response as native authentication loss instead of a generic process failure.
- Wired `check:daemons` into `bun run check`. The hygiene gate existed but sat outside the release check, so a gate could pass on a machine the gate itself would reject — and, worse, fail on one and blame the code. It now runs first, before three minutes of work.
- Scaled the per-test ceiling for the deterministic redaction boundary test. It re-scans every secret at every split offset, so a loaded suite pushed it past Bun's 5s default and reported a timeout that read exactly like a redaction regression.

### Verification

- Full release gate: 857 tests, 11 documented platform skips, zero failures, on macOS and Linux CI.
- Native subscription smoke run against installed CLIs: `grok-build` now **passes** through the `grok-resume` driver under required native-direct-unrestricted containment, alongside `opencode`. `claude-code` and `codex` reported structured `RATE_LIMITED` from repeated same-day runs, which the gate classifies as transient. Evidence regenerated from that run; Grok is no longer recorded as an accepted limitation.
- The repair loop was verified end to end with real agents on a project with two seeded defects: the gate went green on the accumulated candidate while primary HEAD stayed unmoved.

## 0.2.0-beta.4 — 2026-07-16

Package publication remains blocked. Both package manifests are private at `0.2.0-beta.4`; this release is limited to the protected repository PR and annotated source tag.

### Fixed

- Preserved the daemon's structured Fleet readiness presentation through the observer controller. Missing native egress acknowledgement now renders as `Trust required` with the daemon-provided acknowledgement command, while genuine native-login and broker credential failures remain `Login required`; trust-gated agents count as blocked rather than logged out.
- Added a height-aware content inset across all seven TUI views from 24 terminal rows upward, retained the dense layout below that threshold, and aligned Fleet, Goals, and Approvals list windows and mouse hit zones in both wide and compact header modes. Overview adds section gaps only when every group and at least one Recent Activity row fit.
- Corrected Overview health wording so project trust without complete native consent is reported as `native consent required` rather than fully ready.

### Verification

- Added focused model, controller, layout, mouse, and Ink rendering coverage for trust/login distinctions; heights 20, 23, 24, and 32; wide and compact tab rows; and a bounded 60×20 frame with visible status and footer.
- The full release gate passed with 764 tests, 11 documented platform skips, and zero failures. The built-artifact CLI audit passed all 35 exhaustive registry, lifecycle, parser, fleet, and receipt cases; root/plugin/TUI builds, package smoke, and the frozen Docusaurus production build also passed.

## 0.2.0-beta.3 — 2026-07-16

Package publication remains blocked. Both package manifests are private at `0.2.0-beta.3`; npm publication and repository visibility remain separate human-authority decisions. Documentation deployment is authorized separately through the public GitHub Pages workflow.

### Fixed

- Replaced expiring session and skill completion watchers with durable terminal-job reconciliation. Long-running turns no longer orphan sessions after three minutes; shutdown drains outstanding waiter timers; startup reconciles terminal sessions and skill invocations; session completion is idempotent by job ID.
- Added crash recovery for the post-terminal receipt window. A write-ahead receipt journal persists assembly inputs before job completion, daemon startup deterministically repairs missing receipts or dangling anchors, and unrecoverable evidence becomes an explicit non-anchor `execution_receipt_gap` instead of silent loss.
- Made fleet authentication health truthful per selected mode. Broker agents name the missing daemon credential variable; native-login agents surface the bounded capsule/setup-token reason; health, admission, lease issuance, and broker egress use the same injected daemon environment. Broker remains the execution-contract default.
- Unified session and one-shot security arguments. Claude sessions now retain the shared denied-tool set, and every Codex transport delegates nested macOS sandboxing to Headless's outer Seatbelt profile without changing one-shot bypass semantics.
- Added durable principal-scoped `run.submit` idempotency, fail-closed conflict detection, encoded and double-encoded broker path-traversal rejection, route-segment boundaries, and complete injected-environment parity across admission and execution.

### Added

- Added an independent always-run website CI job with a frozen, script-disabled Bun install and Docusaurus production build. Added direct tests for depth-bounded JSON parsing, atomic write/append durability, owner-only JSON permission repair, and every built-in session event decoder.
- Added comprehensive concept documentation for daemon architecture and recovery, the four independent run-mode axes, macOS/Linux containment and relays, persistent sessions, and portable immutable skills. Updated receipts, safety, fleet-login troubleshooting, CLI/TUI guidance, and release-facing version references for the six stabilization lanes.

### Verification

- The six-lane stabilization merged through PR #27 after the website, Ubuntu, and macOS release-gate jobs passed. The final pre-merge local gate reported 761 passing tests, 11 documented platform skips, zero failures, green root/plugin/TUI builds, a green Docusaurus build, and a green package smoke.

## 0.2.0-beta.2 — 2026-07-16

Publication remains blocked. Both package manifests are private at `0.2.0-beta.2`; the staged Gate A, B, and C evidence in `docs/plan.md` is an acceptance checklist, not a completion claim.

### Changed

- Hardened the disposable run-tool helper with defense-in-depth: it now refuses an operation absent from its credential's allowlist before any transport (exit 2), and fails closed on a response-less connection close — both with immediate `process.exit` so completion never depends on relay teardown. The daemon-side endpoint and `JobAdmissionService` remain the authorities (an over-permissive endpoint still cannot admit a grandchild delegation). Also canonicalized the native-auth test fixtures to remove an order-dependent macOS realpath flake.
- Grounded the Grok adapter in the newly open-sourced grok-build source (Apache-2.0, `xai-org/grok-build`): decode the `max_turns_reached` terminal event and `cache_read_input_tokens` usage field, fail completions on `Refusal`/`ContentFilter`/`Cancelled`/`ModelContextWindowExceeded` stop reasons, record the real login commands (`grok login`, `grok login --device-auth`), drop the never-read `~/.config/grok/auth.json` capsule path (the CLI reads only `$GROK_HOME/auth.json`), and disable proactive in-capsule token refresh (`GROK_AUTH_EARLY_INVALIDATION_SECS=0`) so a disposable worker cannot silently rotate the operator's OAuth token.
- Unified the MCP server and OpenCode plugin on one shared advertised tool registry, including names, schemas, and defaults. Direct lead tools now consistently default to native-login, deliberation consistently seats OpenCode and Codex, task claims consistently default to a 300-second lease, and goal-level auth remains unset so the selected fleet profile can supply it.
- Documented that core ships without provider list prices and emits one bounded daemon warning when a broker cost cap is active without extension-supplied trusted pricing. Unknown USD attribution remains null and cost ceilings continue to fail closed rather than treating unknown spend as zero.
- Reframed the native-subscription smoke as the **primary Gate A real-run evidence** and made its release gate per-backend. Required backends are Claude, Codex, and OpenCode; Grok is experimental and excluded; macOS keychain-only Claude login is a documented, platform-gated accepted limitation that no longer fails the gate. At least one required backend must complete a real native turn, and a missing required backend or a changed checkout still fails. The gate evaluation moved into a pure, unit-tested `evaluateNativeSmokeGate`/`nativeSmokeAcceptedLimitation` helper.
- Marked the credentialed broker **provider-smoke as optional/deferred** — it exercises broker mode against real provider API keys and is not required for the native-login subscription beta, which uses the CLIs' existing logins and no separate API keys. The broker remains proven by fake-upstream unit tests.

### Fixed

- Receipt assembly now hard-bounds every redacted preview and reason (prompt/output previews, policy-trail reasons, budget reasons), so runs whose prompt or output exceeds the 4 KB preview bound anchor a receipt instead of silently skipping receipt and ledger anchor; offline receipt verification additionally authenticates the per-section digests even when the body self-digest matches, so a doctored `sectionDigests` field no longer verifies clean.
- The live ledger read path now refuses an unsigned SHA record appearing after HMAC history — the same downgrade refusal the batch verifier already enforced — including across persisted read-cache loads and rebuilds, so a forged unkeyed record is rejected at runtime instead of only during offline verification.
- Daemon sockets install error listeners, drop oversized pre-authentication requests safely, and answer exactly one request per connection; previously an oversized or pipelined request could raise an unhandled socket error and crash the entire multi-client daemon. Run-tool endpoint sockets share the same error defense.
- One-shot Grok runs now fail closed on `Refusal`, `Cancelled`, and `MaxTokens` stop reasons through a stop-reason mapping shared with the session decoder, so a refused turn is no longer recorded — in the ledger and its receipt — as a success. `--help`/`--version` detection now respects the documented `--` prompt escape, so `headless exec -- "--help"` executes the prompt instead of printing help.
- Moved the hosted-Ubuntu run-tool cooperation lifecycle coverage off GitHub-hosted Linux entirely. The hosted runner — privileged container step included; one was tried and hit the same hang — can leave bwrap relay children alive after a completed tool response, so the hosted job loudly skips exactly four daemon-cooperation cases and one late-socket relay case while macOS CI, local Linux, and the documented local privileged Docker command continue to execute them. The underlying hosted-runner relay hang and unrelated `Unknown goal` background-error leakage remain explicitly tracked in `docs/internal/hosted-linux-relay-follow-up.md`.
- Applied every backend's containment-safe `prepareEnvironment` hook to persistent native-session launches as well as one-shots. Codex now receives the system CA bundle paths inside its isolated home without widening the Seatbelt network profile; tests prove the hooks do not restore ambient credentials or host control paths. Keychain-only Claude login on macOS remains an explicit fail-closed limitation rather than being papered over with real-home or token forwarding.
- Added one legacy-aware durable RunResult decoder for the superseded `provider-direct` value. Run-event projections, protected archives, jobs, sessions, and workflow steps now return canonical `native-direct-unrestricted`; protected archive hashes are verified before normalization, historical bytes remain unchanged, and malformed or unknown values still fail closed.
- Restored daemon and `doctor` startup for upgraded real project state instead of allowing strict current-write validation to brick the daemon on its own pre-rename history.
- Separated Linux run-tool feature health from containment integrity. The loopback relay round-trip probe remains a fresh CI/test diagnostic but no longer denies unrelated contained runs or caches a transient failure process-wide; actual helper failures remain bounded and explicit.
- Added the clamped `HEADLESS_RUN_TOOL_TIMEOUT_MS` operability control (1,000–60,000 ms, 5,000 ms default) to the helper and daemon endpoint for slow hosts without weakening OS containment.
- Corrected the GitHub Actions workflow so macOS and Linux release-gate jobs are instantiated and exercise real platform checks. A workflow run is still evidence to inspect, not a release claim.

### Added

- Added the verifiable execution receipt. Every authorized run — read-only included — now assembles a versioned, tamper-evident receipt binding the request digest, a source-discriminated authorization snapshot captured at the authorization checkpoint (`root`/`foreground_lead`/`grant` with echoed grant terms), a token-free broker-lease scope snapshot, a bounded gate manifest, budget outcome, containment evidence, and result digests with bounded redacted previews. The receipt is anchored into the hash/HMAC-chained ledger as a bounded `execution_receipt` artifact and persisted in an owner-only durable store that survives run-event compaction. Verification runs online against the full ledger chain or offline from an exported file, reporting an explicit assurance level (`full-chain`, `embedded-record`, `structural-only`) and localizing tamper to the first failing section. Surfaced as the experimental `headless receipt show|list|export|verify|diff` CLI over new `receipt.get|list|export|verify` daemon RPCs (`ledger:read`-scoped, ownership-gated). Receipt assembly is non-fatal by construction and can never alter a run's status; `HEADLESS_RECEIPTS=off` opts out and is documented as weakening the proof.
- Added stable `headless verify [--evidence]` plus the experimental `ledger verify` namespace alias. The auditor command returns the first ledger-chain break, verifies mixed rotated HMAC key IDs without accepting an unsigned downgrade, and can compare release-evidence files with their latest authenticated ledger anchors. Opt-in smoke evidence now carries generation time, source commit, platform, Headless version, and backend versions before its exact bytes are SHA-256 anchored through the repository daemon.
- Added an explicit Claude subscription setup-token capsule for required containment on macOS and Linux. A user-created owner-only `~/.claude/.headless-setup-token` must match the bounded `sk-ant-oat…` contract; it takes exclusive precedence over stale `.credentials.json`, contributes only a hash to the native-auth fingerprint, and is injected after environment scrubbing into the contained Claude native-login process without entering daemon state, logs, ledger records, or results. Invalid deliberate token files fail closed with a precise remedy.
- Added experimental depth-one worker delegation through `run.delegate`: one parent-deadline-bounded, daemon-attributed read-only child per parent, active-lead exclusion, idempotent replay, non-queueing capacity admission, cancellation/restart recovery, and structured child outcomes that never terminate the parent. Same-provider children use an atomic parent sub-reservation; cross-provider children require different providers and backends plus a strict `broker-api-key` target and use a crash-atomic linked hold over parent and target provider quotas. The target bearer is minted once and never persisted. Both paths use a 25%-default/50%-maximum carve from the parent's remaining reservation, with unused return and crash-unknown exhaustion instead of new project spend authority.
- Promoted `mcp` into the Beta 1 CLI surface. Codex, Claude Code, and Grok installs use their native commands; OpenCode receives a safely merged global configuration outside the checkout, with complete manual fallbacks where automation cannot finish.
- Added `headless init --lead codex|claude|opencode|grok`, which initializes external state, installs that host's MCP entry, and binds the foreground lead without granting project trust or native egress.
- Promoted the observer `tui` into the Beta 1 CLI surface and added a read-only Config view for trust, lead generation/connection, budgets, backend readiness, and daemon state. It generates exact root-CLI commands but cannot execute mutations.
- Added the experimental root-only `budget list|upsert` CLI over the existing bounded durable budget store.
- Reframed the release plan as cumulative Gate A kernel beta, Gate B orchestration beta, and Gate C writes GA, preserving all later-gate evidence instead of treating orchestration as compatibility baggage.

### Documentation

- Added a full Docusaurus site under `website/` — introduction, getting started, the safety model, execution receipts, leads and fleet concepts, per-AI-coder guides (Claude Code, Codex, OpenCode, Grok), CLI and TUI guides, and eight test scenarios. Built separately with `cd website && bun run build`; not yet deployed.
- Consolidated lead onboarding, MCP host behavior, observer authority, budget examples, upgrade compatibility, run-tool timeout/probe behavior, native-login limits, and staged release language across the README, operator guides, security model, generated command reference, and changelog.
- Marked `pair`, `ask`/`ask-for-work`/`ask-for-more-work`, and `coop-proof`/`autonomy-coop-proof` as internal audit fixtures; they remain intentionally hidden from operator help.

### Earlier unreleased recovery changes

- Broker authentication is the default. Every broker run receives finite request and token ceilings plus a $5 ceiling when trusted pricing exists; unknown pricing requires explicit per-run approval and remains unknown.
- Native login requires project trust plus explicit acknowledgement of arbitrary outbound IP access. Network evidence is reported as `native-direct-unrestricted`.
- Session-backed requests are bound to persisted backend/model/agent/containment/auth/approval values before authorization, pricing, budget reservation, or launch.
- Headless no longer ingests or replays ContextRelay runtime state. Grok requires a contained compatibility attestation before provider access, and terminal jobs/results precede deterministically reconciled completion events.
- One durable foreground lead is configured explicitly per project. MCP/plugin attach and heartbeat without owning the provider process; explicit switching rotates the credential generation.
- The TUI is a read-only observer over daemon snapshots/events. Prompt, palette, provider lifecycle, mutation, approval, and integration controls were removed.
- The stable SDK returns `RunResult` directly. Legacy execution shapes, persistent sessions, MCP package internals, broker relay internals, and orchestration remain explicit experimental surfaces.
- Ledger verification supports mixed SHA/HMAC history and declared key rotation; unknown keys fail closed. Partial trailing bytes can be repaired only through an explicit admin command that verifies the prefix and writes a backup/recovery record.

## 0.2.0 — draft, never published

Version 0.2 is an intentionally breaking security and architecture release.

### Breaking changes

- Required OS containment replaces best-effort sandboxing. Local unsafe execution requires `--unsafe-no-sandbox` and is marked in results/state.
- Runtime state moves out of the repository into an owner-only directory keyed by the canonical project-root hash.
- CLI, MCP, OpenCode plugin, TUI, councils, sessions, and autonomy use a project-scoped authenticated daemon.
- This draft originally described native login as the default. The unreleased recovery changes above supersede it: broker mode is now the default and native login requires explicit unrestricted-egress consent.
- `model` is optional across runs, sessions, goals, workflows, councils, and fleet profiles; omission uses the selected backend CLI's configured default. OpenCode is fail-closed: Headless safely extracts only the scalar `model` from the fixed global `~/.config/opencode/opencode.json` or `opencode.jsonc`, never activates the rest of host configuration, and returns `NATIVE_AUTH_UNAVAILABLE` when no safe default exists.
- Public requests/results/events and durable orchestration objects use runtime-validated v0.2 schemas.
- Windows now returns `UNSUPPORTED_PLATFORM` before backend launch.

### Added

- Backend-specific minimal native-auth capsules for installed Claude, Codex, OpenCode, and Grok subscription logins. Capsules reject symlinks/non-regular and oversized state, use owner-only worker roots, fingerprint exact selected state, and never copy sibling-provider, Git/SSH, shell, host-agent, or real-home material. Keychain-only Claude login on macOS fails closed under required Seatbelt containment; a supported regular-file state or broker mode is required.
- OpenCode model omission uses a bounded canonical owner-file read of `~/.config/opencode/opencode.json` or `opencode.jsonc`; only the validated scalar is passed as `--model`. Host plugins, MCP entries, commands, permissions, custom XDG/config overrides, and all other fields remain inactive, while model changes alter the auth-profile fingerprint and prevent unsafe native resume.
- Native-login workers retain the outer Seatbelt or bubblewrap/seccomp filesystem, process, Unix-socket, worktree, and repository boundaries, but outbound destination IPs are unrestricted and reported as `native-direct-unrestricted`. Native results report backend-native credential access and unknown cost unless the CLI supplies a charge; broker mode remains broker-only and cost-enforced.
- Dedicated native session drivers: capability-handshaken persistent Codex app-server with exec-resume fallback, Claude print/resume, OpenCode session resume, and structured Grok resume. Persisted driver/version/auth/capability/turn/rate-limit/recovery metadata, stable-ID event assembly, reconnect/malformed/out-of-order handling, and bounded redacted replay fallback are included.
- Runtime-validated agent/fleet/goal/turn/delegation/directed-message/review/vote/approval/candidate schemas; durable fleet, goal, and approval stores; sticky health-based leader selection; addressed bounded mailboxes; a four-active/64-queued FIFO delegation scheduler; and a deterministic quiescence/idle-opportunity detector.
- Optional quorum-based leader election with attributable policy ballots, sticky post-election leadership, deterministic failover, and explicit non-model-consensus evidence.
- Explicit read-only or write collaborative goals. Write goals preserve real daemon candidates, deliver bounded output/diff/commit evidence, require artifact-grounded reviews and votes, pause `ask` mode before each mutating coder turn and separately for merge approval, and integrate the same gated candidate through the candidate service.
- An eight-second deterministic idle scanner with durable fingerprint deduplication and visible lanes for failed gates, unverified completion, stalled work, unresolved candidates, and idle workers. Verified idle writes use the ordinary trust, budget, worktree, finality, and integration path.
- Typed daemon route metadata and stable structured native-auth, native-session, approval, rate-limit, and queue-capacity failures, plus shared option/timeout/platform validation and bounded TERM-to-KILL process-tree termination.
- Durable job lifecycle with total queue-to-exit deadlines, process-tree cancellation, concurrency queueing, persistent replay sessions, atomically bound/restart-resumed typed council phases, persisted grants/budgets/finality, and incremental ledger v2 reads. Restart never retries a phase already cancelling; council ties and failed proposals reject, while write-council approval requires the actual candidate jobs' persisted test finality rather than candidate retention alone.
- Durable workflow DAGs with restart recovery, bounded dependency result/diff propagation, per-step retries, cancellation, workflow-scoped budgets, and enforced typed finality.
- Isolated worker homes/config/cache/temp/runtime roots and outer macOS Seatbelt or Linux bubblewrap containment, including recursively discovered primary/worktree masks for repository `.env` variants and local/common/linked-worktree Git config.
- A run-scoped provider broker with built-in OpenAI, Anthropic, Gemini, and xAI/OpenAI-compatible protocols plus a provider extension interface.
- Trusted startup-only daemon extension modules for custom adapters/providers/dated pricing, with trusted-ancestor validation, parent-to-child path/hash manifests, pre-import revalidation, live-daemon digest matching, and installed-package execution coverage.
- A Linux namespace supervisor with loopback-only broker/run-tool proxies and an architecture-checked backend seccomp filter that denies late-created pathname Unix-socket escapes. Broker mode denies direct egress; native-login mode permits unrestricted outbound IP traffic without relaxing the Unix-socket/process/filesystem boundary. x86-64 rejects and probes the shared-architecture x32 syscall ABI before native dispatch.
- A separate authenticated run-scoped daemon tool endpoint for required-contained workers, with a disposable helper, bounded cooperation-only operations, immutable project/job/session/principal scope, and terminal revocation.
- Stateful cross-chunk stream redaction, atomic broker request reservation, incrementally bounded request bodies, response-lifetime stream deadlines, per-lease/global concurrency and body-memory caps, and expired/revoked lease pruning.
- Exact full-prefix event-ID deduplication that cannot double-apply semantic projections, malformed-output diagnostics, separated usage dimensions, dated pricing registration, and explicit truncation evidence.
- Model/provider-aware cost admission, immutable authorization estimates, pre-egress concrete request pricing, positive built-in text-model policies, opaque provider-context/server-search/non-text-output/automatic-tier rejection under caps, deterministic standard-tier injection when cost-capped requests omit a tier, extension-supplied bounded-input validation, grant-constrained broker leases, conservative greatest-limit and multi-candidate handling for protocol output bounds, shared aggregate request/input/output quotas across leases, crash-unknown quota exhaustion, and once-only durable reconciliation.
- Gated write candidates with daemon Git identity, fast-forward/advanced-primary integration, conflict preservation, and pre-commit secret/size inspection.
- Sanitized daemon Git execution, immutable linked-worktree metadata, owner-bound leases persisted before Git worktree creation, and a fsynced integration journal with deterministic crash recovery.
- Digest-bound bounded ledger projections, maintained semantic context/task projections, foreign-host lock refusal, and parent-directory fsync for state-file creation and replacement.
- Deterministic fake-CLI native-session fixtures for all four backends plus required-containment one-shot and replay-session end-to-end fixtures for built-in OpenCode, Claude, and Codex adapters.
- Codex one-shot, exec-resume, and app-server paths share a fail-closed policy that disables project plugins/hooks, native multi-agent fan-out, apps/browser/computer-use surfaces, MCP skill dependencies, and bounded `.agents/skills` plus `.codex/skills` entries. Grok 0.2.99 remains experimental and is blocked unless its contained inspection attests every project and compatibility surface disabled.
- A manually triggered protected provider-smoke workflow for one bounded real broker request each to OpenAI, Anthropic, Gemini, and xAI. Credentialed smoke is separate from local release checks and is not claimed as executed here.
- A fail-safe opt-in installed-CLI smoke harness for real Claude, Codex, OpenCode, and Grok subscription logins without provider API keys or ambient provider tokens, including `CLAUDE_CODE_OAUTH_TOKEN`. It uses compiled artifacts and disposable state, bounds every turn/output, verifies Git remains unchanged, and guarantees daemon cleanup. A skipped, missing, or unsupported login does not satisfy the release gate.
- Compiled `headless`, `hless`, and `headless-mcp` binaries, public daemon/MCP exports, and a separately packed OpenCode plugin.

### Migration

On first open, Headless verifies the active v1 repository ledger before importing it into external state. The v1 file remains unchanged. A source-bound write-ahead manifest is persisted before import records, deterministic event IDs make crash recovery idempotent, and unexpected target activity fails closed. A failed verification stops with recovery guidance.
