# Security model

> **Unpublished private beta (`0.2.0-beta.6`).** This document describes intended and implemented controls, not a release attestation. Do not use Headless with sensitive source, valuable native credentials, or unattended spend until the release gates pass.

Headless assumes a coding-agent backend may be prompt-injected, compromised, or intentionally malicious. Required mode therefore depends on operating-system containment and credential isolation, not on a backend’s tool-deny rules.

## Security boundary

The trusted computing base is the local Headless daemon, its configured project/policy, any explicitly configured startup extension modules, the operating system, Bun, Git, bubblewrap or Seatbelt, and—in broker mode—the provider broker. Native-login mode deliberately also trusts the installed official backend CLI with that backend's minimal scoped account state and outbound provider access. The backend CLI remains outside Headless's filesystem, repository, orchestration, and finality trust boundaries. Project-controlled agent configuration is always untrusted. Extension config/module paths are startup-only, canonicalized, bounded, content-fingerprinted, and owner-controlled through their ancestor chain. Detached children receive the parent's exact path/hash manifest and revalidate it before import; modules still execute with daemon authority and must be reviewed as trusted code.

The daemon canonicalizes one project root at startup and owns an authenticated, owner-only Unix socket. It derives the principal from server configuration and the authenticated connection. Client `cwd`, `source`, actor, coordinator, and ownership claims do not establish authority.

The TUI receives a dedicated observer credential limited to `ping` and `observer.*`. Its Config view is a read-only projection that generates copy-paste root-CLI commands; it does not receive mutation routes or root, lead, budget, trust, approval, or candidate authority.

This is not a boundary against an attacker who already controls the same host user, daemon process, executable `PATH`, Bun/Git installation, operating-system sandbox, or `HEADLESS_LEDGER_KEY`.

## Required containment

Required containment is the default.

- Every worker receives an isolated `HOME`, XDG config/data/cache/runtime roots, and temporary directory.
- The real home, ambient API keys, unrelated provider login stores, Git/SSH configuration, shell startup files, keychain exports, and host agent sockets are not placed in the worker environment. Existing repository `.env`, `.env.*`, `.envrc`, and local/common/linked-worktree Git config files are recursively discovered with a bounded fail-closed walk and removed from the worker's readable view while ordinary source remains available.
- Native-login workers receive only the selected backend's allowlisted capsule, bounded to 2 MiB per ordinary file and 4 MiB total, copied with owner-only permissions and fingerprinted. Symlinks and non-regular files fail closed. For Keychain-backed Claude subscriptions, the explicit `~/.claude/.headless-setup-token` source is separately bounded to 4 KiB, owner-only, format-validated, fingerprinted, and injected only into the contained Claude native-login process as `CLAUDE_CODE_OAUTH_TOKEN`; it is never copied, inherited ambiently, persisted, or logged. Headless does not export the Keychain item or expose the real home as a fallback.
- macOS workers use probed, default-deny Seatbelt profiles. Broker network is limited to the selected loopback port. Native-login workers permit outbound provider traffic and narrowly scoped TLS service lookups, while network binding remains denied. In both modes, only isolated worker storage and, for writes, the leased worktree are writable. Explicit read denials cover repository credential files in both the primary and worktree views. The linked-worktree `.git` pointer remains read-only, and signal delivery is restricted to the worker and its descendants.
- Linux workers require successful bubblewrap write-denial and backend-seccomp probes. The host and primary checkout are read-only, worker storage is explicitly mounted writable, PID/IPC/UTS namespaces are isolated, and only a leased write worktree is writable. Broker workers also unshare the network namespace; native-login workers retain outbound IP networking. Repository credential files are over-mounted after broader primary/worktree binds, the linked-worktree `.git` pointer is over-mounted read-only, visible host pathname Unix sockets are masked, and the backend's seccomp filter denies `AF_UNIX` socket creation even for a host socket created after the mount snapshot. On x86-64 it rejects x32-tagged syscall numbers before native dispatch, and required-mode probing verifies that alternate-ABI denial.
- Backend-native restrictions remain defense in depth. OpenCode project configuration/plugins/skills are disabled; Claude receives allowed/disallowed tool restrictions; Codex retains its native sandbox while explicitly disabling project plugins, hooks, apps, browsers, hidden subagents, MCP skill dependencies, and both repository skill roots. Grok is experimental and must pass a contained, network-denied `inspect --json` attestation proving native and Cursor/Claude/Codex compatibility surfaces disabled before any provider access. Disposable Grok capsules strip `refresh_token` so a worker cannot rotate the operator login; `EARLY_INVALIDATION` alone does not protect operator credentials.
- Windows returns `UNSUPPORTED_PLATFORM` before launch.

Missing/degraded containment capabilities return `CONTAINMENT_UNAVAILABLE`. Headless does not silently fall back to a weaker sandbox. Cooperation-helper transport health is a separate feature-health signal and is not used as evidence that the OS boundary succeeded or failed.

`--unsafe-no-sandbox` is the only local containment bypass. The `bypass` approval policy is different: it selects a backend's noninteractive tool approval inside the outer sandbox and remains subject to project trust, credential scope, budgets, clean-primary checks, worktree isolation, finality gates, and merge authority. Unsafe results and ledger records are marked, and unsafe mode is prohibited for autonomous jobs and councils.

## Authentication modes

Broker mode is the default. Real API keys remain in the daemon. Every run receives finite defaults of 8 requests, 200,000 aggregate input tokens, 32,000 aggregate output tokens, and a $5 cap when trusted pricing exists. The core pricing registry is intentionally empty: USD cost attribution requires trusted dated pricing registered by a daemon extension. Unknown pricing requires explicit per-run approval and remains reported as unknown; if any USD cost ceiling applies while the registry is empty, admission or broker egress fails closed rather than treating unknown cost as zero. The daemon emits one bounded warning when it first issues such a cost-capped lease.

A broker worker receives an opaque, short-lived token scoped to its run, provider, model, endpoint class, request/body limits, duration, and budget. The loopback broker validates those constraints before forwarding and deeply redacts bounded logs/errors. Request slots are reserved atomically, bodies are bounded while they are read, and the stream-duration deadline remains active until the response body terminates. Per-lease and broker-global concurrent-request and in-flight-body-memory caps apply before asynchronous body reads. Durable budget request/input/output quotas are registered as shared broker counters and charged atomically across all current and subsequently issued leases, preventing concurrent leases from reusing the same remainder. If a daemon crash destroys exact broker observations, recovery preserves unknown attribution and exhausts affected bounded dimensions instead of making quota reusable. Revoked or expired leases are pruned once their active requests finish, and issuance also enforces bounded retained lease/quota sets. Under a token or cost cap, built-in protocols require a positively recognized text-generation model and reject opaque conversation/prompt/file context, remote media, server-side search, provider-managed tools, non-text output modalities, and automatic/non-standard service tiers; extensions must implement trusted bounded-input validation. On cost-capped built-in requests, omission is not allowed to inherit a provider's automatic tier: the broker injects the deterministic standard tier, then uses the rewritten bytes for token and cost bounds. Trusted dated pricing produces an immutable admission reservation, and the broker conservatively prices the concrete request body and greatest recognized protocol output maximum before egress, including conflicting limit fields and multi-candidate output multiplicity. Durable accounting charges the greater of attributed usage and the broker-observed bound once.

The daemon binds both an owner-only Unix broker socket and a loopback TCP listener by default. Required-contained Linux workers use the in-namespace loopback-to-Unix relay; host-side and explicitly unsafe runs use the real loopback listener, so their lease URL always has an owner. `HEADLESS_BROKER_ALLOW_LOOPBACK_TCP=0` explicitly selects AF_UNIX-only mode. In that mode Headless refuses any lease handoff for which no Linux required-containment relay will exist, rather than exposing a bearer token at the synthetic unowned relay port.

Native login is selected explicitly and requires project trust plus acknowledgement that outbound destination IPs are unrestricted. A client cannot declare trust, credential paths, project roots, principals, or coordinator authority in a run. Native results report `native-direct-unrestricted` network access, backend-native credential access, and unknown cost unless the CLI supplies a real charge. `NATIVE_AUTH_UNAVAILABLE` and `NATIVE_SESSION_LOST` are explicit terminal/recovery conditions; Headless does not silently fall back to a different backend account.

Built-in broker protocols cover OpenAI, Anthropic, Gemini, and xAI/OpenAI-compatible routes. A custom broker provider must register an explicit provider definition. Native OAuth state is supported only through the corresponding allowlisted regular-file capsule. Keychain-only Claude login on macOS currently fails closed; the broker does not import OAuth or keychain state.

Linux runs start a non-dumpable supervisor inside the isolated namespaces when scoped daemon proxies are needed. It listens only on selected worker-loopback ports and forwards to explicitly mounted owner-only broker/run-tool sockets. A pre-spawned helper first unshares its file-descriptor table, then—after the proxies bind—installs no-new-privileges and an architecture-checked, mode-specific seccomp filter before `execve` replaces it with the backend. The filter denies `AF_UNIX`, io_uring setup, ptrace/process-memory access, and pidfd descriptor theft. Because x86-64 and x32 share an audit architecture, the filter explicitly rejects x32 syscall numbers before comparing native syscall IDs; the Linux capability probe repeats that check. Broker mode shares no host network interface; native-direct-unrestricted mode deliberately permits outbound IP connections without exposing host pathname sockets. Missing required supervisor, relay, socket, or filter capabilities fail closed.

Required daemon workers receive a distinct owner-only Unix run-tool socket and an opaque credential held only for that run. The credential is immutable-scoped to project, job, session, principal, expiry, call count, and a fixed non-administrative operation set. Requests cannot supply identity or authority fields, select other jobs/sessions/tasks, alter grants/policy/budgets, or request write roots. Replies and failures are bounded and deeply redacted. Expiry or terminal cleanup closes all connections and removes the socket; unsafe runs do not receive this capability.

The experimental `run.delegate` operation is present only on an eligible depth-zero worker's allowlist. It can create at most one independently contained, read-only sibling child; the child endpoint omits `run.delegate`, and durable admission independently rejects delegated, unsafe, write-mode, native-login, same-backend, foreground-lead, over-budget, and no-capacity requests. Same-provider delegation atomically transfers a sub-reservation from the parent. Cross-provider delegation requires different providers and backends plus a strict `broker-api-key` target, then uses one crash-atomic linked hold over the parent and target provider quotas; its target bearer is minted once and never persisted. Both paths remain bounded by the parent's deadline, default to 25% of the parent's remaining reservation, enforce a 50% hard maximum, create no new project spend authority, and exhaust crash-unknown child allocation. The child receives fresh roots, sockets, and broker authority rather than any parent secret. Parent cancellation cascades; child failure is bounded structured data and cannot fail the parent.

On Linux, launch still requires the trusted supervisor, scoped socket, relay runtime, namespace, and seccomp arrangement. The active loopback-to-Unix echo probe is diagnostic-only because scheduler load can make a healthy transport miss its diagnostic latency window; it is not a run-admission gate. A real helper call that cannot connect fails loudly without poisoning later or unrelated runs. `HEADLESS_RUN_TOOL_TIMEOUT_MS` controls both helper and daemon-side idle windows, defaults to 5,000 ms, and is clamped to 1,000–60,000 ms. It must be set in the daemon environment before startup.

## Writes

Write mode requires a clean Git worktree. Before invoking `git worktree add`, Headless durably records a preparing lease for the planned checkout and branch; it activates that lease only after Git succeeds. The backend writes only in that leased worktree created from a recorded primary `HEAD`. Headless records and verifies the exact linked-worktree `.git` pointer before daemon-owned Git operations. Daemon Git disables system/global configuration, hooks, filters, fsmonitor, custom merge drivers, credential prompts, and external protocols; repositories that select dangerous Git configuration fail closed. Candidate and integration gates run before an authorized primary update. Primary races, dirty state, conflicts, failed gates, cancellation, or insufficient merge authority leave the primary checkout untouched and preserve outcome evidence.

Council phase records and their concrete jobs are durable. Each job atomically records its council phase slot, allowing startup to reconcile an unappended crash orphan without launching duplicate work; interrupted active phase jobs receive only a bounded, budget-checked retry, while a persisted cancelling phase resolves terminally and is never retried. Failed proposals block finality, attributable votes require a strict majority, and ties reject. For write councils, candidate retention and an approving vote cannot substitute for tests: the council test gate requires the execution jobs' persisted policy/test/review/budget finality evidence before a decision can be approved.

Only the configured coordinator has automatic write/merge authority for its project. Other principals require a persisted, unexpired grant covering project, operation, backend, optional cost, and merge authority.

Before staging, Headless fully bounds and inspects the raw candidate diff, status, and file list. Any redaction trigger, truncation, inspection failure, or over-limit candidate fails the gate and removes the worktree without creating a candidate commit/object. This pattern scan cannot identify every proprietary or user-defined secret, so retained candidates still require normal untrusted-code review.

Every candidate and integration checkout has an owner-bound durable lease. A foreign-host or verified-live lease prevents daemon takeover; a dead-owner checkout and branch are retained as crash evidence. The primary update is protected by a fsynced write-ahead integration journal. On restart, Headless verifies the clean primary and Git ancestry before reconciling an applied update into ledger/job state; ambiguous state fails closed.

## Ledger and state

Runtime state is outside the repository in an owner-only, project-hashed directory. Ledger v2 daemon-assigns reserved envelope fields and chains entries by sequence, previous hash, and SHA-256 or HMAC-SHA256 metadata. Reads verify incrementally, reject malformed sequences and chain changes, and suppress duplicate event IDs exactly across the full verified prefix. Explicit retries are suppressed before append; the bounded persisted cache is supplemented by an exact in-process prefix index, and semantic projections apply only accepted records. The ledger read projection is digest-bound and size-bounded. Context and task-state reads use maintained, bounded per-principal/session semantic projections tied to the verified ledger head; a mismatch rebuilds from verified history. Full history is loaded only when explicitly requested or when a projection must be rebuilt.

Locks contain PID, process-start identity, host, and nonce. A lock with a verified live owner is not removed, and an active lock from an unverifiable foreign host fails closed. v1 repository ledgers are verified before import; the source is preserved unchanged. A write-ahead `importing` manifest binds the source hash/dimensions and target starting head before the first v2 append. Deterministic import event IDs and reconciled progress make restart after a durable append idempotent; unexpected target activity during an unfinished import fails closed.

Persisted RunResult reads have a narrow schema-evolution decoder for the superseded `provider-direct` network value. It verifies protected archive hashes against the unmodified historical object before returning canonical in-memory `native-direct-unrestricted`, preserves every other field, and does not rewrite archive bytes. New writes and RPC use the strict current schema; malformed records and every other unknown enum value fail closed.

An unkeyed chain detects accidental or unaudited modification but can be recomputed by a state-file writer. HMAC only prevents forgery when `HEADLESS_LEDGER_KEY` / `HEADLESS_LEDGER_KEYS` is kept outside that writer’s reach. Neither mode detects deletion/rollback of a valid tail without an external head/sequence anchor.

### Ledger HMAC key generation

HMAC ledger integrity is opt-in. A key shorter than 32 bytes or obviously low-entropy (repeated characters, pure digits, common password patterns) provides false tamper-evidence, so Headless refuses to **sign new records** with it: `append` and ledger tail repair fail closed, naming the key id and the variable that supplied it. Human-memorable 16-character secrets and similar passwords are insufficient.

The floor is scoped to writing, not to opening or reading a ledger. A weak key still **verifies** an existing chain, and `headless verify` reports the weakness alongside the verdict (`weakKeys`) rather than withholding the operator's own history — refusing to read it would not raise the cost of forgery. To rotate, keep the old key in `HEADLESS_LEDGER_KEYS` so historical records stay verifiable and point `HEADLESS_LEDGER_ACTIVE_KEY_ID` at a new key that meets the floor.

Generate a key with:

```bash
openssl rand -base64 32
```

Set either a single active key:

```bash
export HEADLESS_LEDGER_KEY="$(openssl rand -base64 32)"
export HEADLESS_LEDGER_KEY_ID="primary"
```

or a JSON keyring (for rotation / verification of historical records):

```bash
export HEADLESS_LEDGER_KEYS="$(jq -nc --arg k "$(openssl rand -base64 32)" '{primary:$k}')"
export HEADLESS_LEDGER_ACTIVE_KEY_ID="primary"
```

Keys may be raw high-entropy strings (≥32 UTF-8 bytes) or standard base64 / base64url encodings of ≥32 random bytes. Do not auto-generate keys inside the daemon: out-of-band distribution is what keeps the key outside the ledger writer’s reach.

The stable `headless verify` command performs an auditor-requested full-chain scan and exits non-zero at the first sequence, previous-hash, project, digest, key, or HMAC-downgrade break. Opt-in release-evidence smokes atomically write provenance-bearing JSON, hash those exact bytes, and record the relative path and digest through authenticated `ledger.artifact`; `headless verify --evidence` additionally compares each current file with its latest durable anchor. The file does not contain its ledger receipt, avoiding a circular digest.

Execution receipts are assembled and ledger-anchored by default for every run that passes the execution-authorization checkpoint — read-only and write alike; a run denied at that checkpoint terminates without ever executing, and deliberately carries no receipt. `HEADLESS_RECEIPTS=off` disables that evidence path only for operator recovery; using it weakens the independently verifiable proof for every run completed while it is set.

The same-user operator can read or modify external state and daemon credentials. Filesystem modes prevent access by other users, not by malware already running as the owner.

Inside that boundary the socket lifecycle is still single-owner by construction, because the same code also has to survive ordinary same-user concurrency. Every in-process Unix socket binds under umask `0o077` and is verified owner-only before it accepts a frame; a contested path is decided by `bind(2)` returning `EADDRINUSE`, never by a pre-emptive unlink; and a teardown removes only the inode it bound, so a daemon, broker, run-tool endpoint, or offline recovery lock cannot delete a socket that another owner took over after the departing one closed. That last rule is a correctness property before it is a security one — both runtimes unlink a bound path from inside `close()`/`stop()`, and the daemon socket path is deterministic per project, so without it a daemon auto-stopping on idle would silently unlink the replacement a concurrent CLI invocation had just started. One bind is deliberately exempt and marked as such in place: the Linux run-tool relay capability probe binds inside a separate `bun -e` child that cannot import the shared helper, so that child restates the umask guard, the owner-only check, and its own bind-failure handling inline.

## Redaction and resource limits

Headless deeply redacts and bounds worker stdout/stderr, parsed output, stream callbacks, events, broker logs/errors, artifacts, diffs, terminal output, MCP/plugin responses, and ledger payloads. Process-stream redaction retains state across arbitrary chunk boundaries so split tokens and private keys are not released early. If redaction fails, the affected chunk is suppressed rather than emitted raw. Truncation is explicit in the structured result.

Redaction is defense in depth, not a substitute for credential isolation. Pattern-based redaction cannot identify every proprietary or user-defined secret. Provider requests necessarily disclose the selected prompt/context to that provider.

A run's positive bounded timeout is a total lifecycle deadline measured from durable job creation, including queueing, preparation, native-session recovery or broker lease lifetime, and worker execution. Process-group cancellation, output/event/artifact/body caps, budgets, concurrency limits, queue-capacity limits, and retry limits reduce denial-of-service exposure. Concurrency exhaustion queues jobs until capacity is available; overflow is rejected explicitly and a queued job that reaches its deadline resolves as timed out without launching. These controls do not protect the host from every kernel/runtime resource-exhaustion attack.

## Responsible reporting

Report suspected security issues privately to the maintainers. Include the platform, containment requirement/evidence, backend/version, minimal reproduction, and whether unsafe mode was enabled. Do not include live credentials in reports.
