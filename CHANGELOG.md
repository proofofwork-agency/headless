# Changelog

## Unreleased — private alpha recovery

- Publication is blocked. Both package manifests are private and use `0.2.0-alpha.0` until the cross-platform, provider, native-login, clean-clone, and npm release gates are satisfied.
- The supported recovery focus is bounded read-only execution through one authenticated project daemon. Advanced orchestration remains experimental; the private-alpha Core/operator/proposal control layer was removed.
- Broker authentication is now the default. Every broker run receives finite request and token ceilings plus a $5 ceiling when trusted pricing exists; unknown pricing requires explicit per-run approval and remains unknown.
- Native login requires project trust plus explicit acknowledgement of arbitrary outbound IP access. Network evidence is reported as `native-direct-unrestricted`.
- Session-backed requests are bound to persisted backend/model/agent/containment/auth/approval values before authorization, pricing, budget reservation, or launch.
- Headless no longer ingests or replays ContextRelay runtime state. Grok requires a contained compatibility attestation before provider access, and terminal jobs/results precede deterministically reconciled completion events.
- One durable foreground lead is configured explicitly per project. MCP/plugin attach and heartbeat without owning the provider process; explicit switching rotates the credential generation.
- The TUI is now a read-only observer over daemon snapshots/events. Prompt, palette, provider lifecycle, mutation, approval, and integration controls were removed.
- The stable SDK returns `RunResult` directly. Legacy execution shapes, persistent sessions, MCP, broker relay internals, and orchestration remain explicit experimental surfaces.
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
