# Native login, sessions, and fleet operation

Headless defaults to brokered provider access. Native login is an explicit private-alpha opt-in for trusted disposable projects because its outbound destination IPs are unrestricted. Both modes retain Headless's outer operating-system containment, project boundary, durable state, worktree isolation, budgets, and finality gates.

## Project trust

Native login is available only after an authenticated operator grants trust to the daemon's canonical project root. Trust is stored outside the repository and cannot be supplied in a run request. The CLI mirrors the `project.trust.status`, `project.trust.grant`, and `project.trust.revoke` daemon methods:

```bash
headless project trust status --cwd /path/to/project
headless project trust grant --allow-native-direct-unrestricted --cwd /path/to/project
headless project trust revoke --cwd /path/to/project
```

Plain `grant` records project trust without allowing backend-native credentials. `grant --allow-native-direct-unrestricted` explicitly acknowledges arbitrary outbound IP access and permits backend-native credentials. `grant --allow-bypass` separately permits the `bypass` approval policy. Revocation prevents new native runs and does not let a client redirect the daemon to another root.

## Authentication modes

| Property | `broker` (default) | `native-login` (explicit) |
| --- | --- | --- |
| Account source | Daemon-owned provider API key | Official CLI's existing subscription login |
| Worker credential | Opaque, short-lived broker lease | Backend-specific auth capsule |
| Network evidence | `broker-only` | `native-direct-unrestricted` |
| Credential evidence | `broker-lease` | `backend-native` |
| Model | Provider/model policy may require a model under caps | Optional; omission uses the CLI default, with the fail-closed OpenCode extraction described below |
| Cost | Broker-observed and reconciled where pricing is known | `amountUsd: null` unless the CLI reports a real charge |
| Trust requirement | Existing daemon policy/grant requirements | Project trust plus explicit unrestricted-egress acknowledgement |

The authentication mode is part of every run and persisted execution record. Select native mode with `--auth-mode native-login`; omission selects broker. Experimental orchestration objects retain the same field but are outside the first beta contract. A goal's execution mode is separate: `read-only` is the default, while write mode requests the leased-worktree and integration-gate path.

## Minimal auth capsules

Headless never mounts the real home directory. It creates an owner-only worker root and copies only single-link regular files through canonical, non-symlinked paths from this fixed allowlist:

| Backend | Host source | Worker destination |
| --- | --- | --- |
| Codex | `~/.codex/auth.json` | `$HOME/.codex/auth.json` |
| Claude | `~/.claude/.credentials.json` | `$HOME/.claude/.credentials.json` |
| OpenCode | `~/.local/share/opencode/auth.json` | `$XDG_DATA_HOME/opencode/auth.json` |
| Grok | `~/.grok/auth.json` | `$HOME/.grok/auth.json` |
| Grok | `~/.config/grok/auth.json` | `$XDG_CONFIG_HOME/grok/auth.json` |

An individual file is limited to 2 MiB and the complete capsule to 4 MiB. Installed files use mode `0600`; worker directories use `0700`. Headless fingerprints the selected backend and exact capsule contents for session-recovery checks. The worker does not receive sibling-provider files, ambient API-key or OAuth-token variables, Git credentials, SSH keys or agents, shell startup files, keychain exports, project `.env` files, or host sockets.

Claude on macOS currently requires a supported regular-file state such as `~/.claude/.credentials.json`. The installed Claude CLI's login-keychain-only state is not discoverable from Headless's isolated `HOME` under the required default-deny Seatbelt profile. Restoring only `USER`/`LOGNAME`, `SECURITYSESSIONID`, or `CFFIXED_USER_HOME` does not make it available; using the real `HOME` would violate credential scope, and exporting the item or forwarding `CLAUDE_CODE_OAUTH_TOKEN` would violate the capsule boundary. Headless therefore returns `NATIVE_AUTH_UNAVAILABLE`. Use broker mode when no supported regular-file Claude login exists.

OpenCode's model default is metadata, not capsule content. If a native OpenCode request omits `model`, Headless reads at most 64 KiB from the first present fixed global file, `~/.config/opencode/opencode.json` then `opencode.jsonc`. The file must resolve canonically inside the real home, be an owner-owned single-link regular file, and pass a no-follow open. Headless parses JSON/JSONC, validates only the scalar `model` with normal option bounds, passes it explicitly as `--model`, immediately clears the source buffers, and includes the selected value in the auth-profile fingerprint. It never copies or activates the host config; plugin, MCP, command, permission, agent, and every other field remain unavailable inside the worker because OpenCode still runs in pure mode with Headless's immutable config and disable flags.

Host `XDG_CONFIG_HOME`, `OPENCODE_CONFIG`, and alternate config paths are intentionally not consulted because they are untrusted control-plane surfaces. Use an explicit public `model` when the fixed global file does not provide the desired default. If neither fixed file contains a safe scalar, or the selected file is malformed, oversized, linked, non-owner, or unsafe, the run/session returns `NATIVE_AUTH_UNAVAILABLE` before an OpenCode process is launched. An explicit model takes precedence without reading host OpenCode config. A changed extracted model changes the persisted fingerprint, so Headless refuses native resume and uses only its recorded bounded replay path when replay evidence is available.

An unavailable, invalid, symlinked, or oversized login produces `NATIVE_AUTH_UNAVAILABLE`. Native authentication deliberately means the official backend can use its own scoped account state and contact its provider; it does not claim broker-style network or credential invisibility.

Grok hardening prepares a Headless-owned `config.toml` in its isolated `GROK_HOME`, explicit environment-level disables for every Cursor/Claude/Codex compatibility cell, no memory/subagents/web fetch/update/telemetry, a Headless system-prompt override, a mode-specific built-in tool allowlist, and startup-snapshot masks for existing project control paths. Before any provider access, a contained, network-denied `grok inspect --json` must attest that native project surfaces and every compatibility cell are disabled. Grok remains experimental and blocked when the installed version cannot produce that evidence.

## Approval policies

| Policy | Coder tool requests | Candidate integration |
| --- | --- | --- |
| `ask` | Create a durable pre-launch approval for each mutating turn; resume that same queued turn after approval | Pause separately for merge approval after gates |
| `auto` | Resolve from daemon policy | Integrate only after all configured gates |
| `bypass` | Use the backend's noninteractive approval mode inside containment | Integrate only after all configured gates |

`bypass` is not `--unsafe-no-sandbox`. It does not disable project trust, clean-primary checks, leased worktrees, filesystem or credential scope, budgets, finality, tests, reviews, votes, or merge authority. A tool or integration pause is reported as `APPROVAL_REQUIRED`; unattended clients can inspect and resolve it through `approval.list` and `approval.resolve` if their authenticated scope allows it.

## Experimental native session drivers

Persistent sessions are disabled by default in Beta 1. The details below describe the explicit `headless experimental session` compatibility surface and do not enlarge the stable one-shot execution contract.

Headless capability-probes the installed CLI before opening a session and records every selection decision.

Named backend agents are supported for OpenCode and Grok and are persisted across create/resume. Claude and Codex reject the option instead of silently ignoring it. Agent values must be names; definition-file paths and flag-like values are rejected at admission so they cannot re-enable project configuration.

| Backend | Preferred driver | Recovery path |
| --- | --- | --- |
| Codex | Hidden persistent `codex app-server` after JSON-RPC handshake | Fall back to `codex exec resume` |
| Claude | `claude -p` with a durable session ID | `--resume <session-id>` |
| OpenCode | Structured `opencode run` | `--session <session-id>` |
| Grok | Experimental structured execution after contained compatibility attestation | `--resume <session-id>` |

Persisted metadata includes the native session/thread ID, driver kind, backend version, auth-profile fingerprint, capability snapshot, last turn, rate-limit evidence, and recovery status. Only one turn may be active per native session. Cancellation targets the entire process tree; persistent transports use bounded frames, event counts, stderr, request timeouts, and TERM-to-KILL shutdown.

Backend-specific event decoders preserve stable provider event IDs, order out-of-order deltas by provider sequence, tolerate and count malformed events, retain terminal lifecycle evidence under pressure, and never apply global text deduplication. A zero exit plus assistant output may infer completion when no contradictory lifecycle evidence exists. Rate limits preserve their observation time and bounded retry-after value; the scheduler may requeue only within the delegation's attempt budget and goal deadline.

An isolated OpenCode worker may exit successfully after its one-time local database migration without handling the requested turn. Headless recognizes only the exact completed-migration evidence and may repeat that identical command once in the same worker. The first execution, retry preparation, and optional second execution share one turn deadline; cancellation, timeout, overflow, nonzero exit, ordinary empty output, or repeated migration evidence cannot produce a third attempt.

If a backend loses native resume, Headless may start a fresh session with at most 200,000 bytes of recent, deeply redacted transcript. The recovery record distinguishes native resume, replay pending/completed, and permanent session loss. No transcript means `NATIVE_SESSION_LOST`; Headless does not pretend a new context is the old native thread.

## Fleet defaults and unattended operation

Fleet profiles contain worker backends, optional models, authentication and approval modes, bounds, and idle-autonomy policy. Task synthesis is selected per goal; it does not grant foreground authority. Public daemon methods are `fleet.profile.upsert|get|list|remove`, `fleet.health`, and `goal.start|send|status|list|cancel|result`. Defaults are four active workers, 64 queued delegations per project, one active turn per native session, eight deliberation rounds, two attempts per delegation, and a 60-minute goal deadline.

An automatic goal begins with a durable read-only planning turn. Headless accepts only the bounded `HEADLESS_PLAN_V1` delegation envelope and uses one safe deterministic fallback task when the planner output is malformed. It assigns at most `maxActiveWorkers` distinct eligible workers, executes independent work concurrently through the durable FIFO scheduler, and gives the sticky leader a bounded bundle containing every admitted worker's actual output, diff, turn ID, and artifact IDs for candidate synthesis. Planning, worker, and review turns remain read-only; only candidate synthesis and revision turns can create a preserved write candidate. Grounded reviewers run concurrently where capacity permits, and revisions remain bounded by `maxDeliberationRounds` before deterministic gates and integration.

Queue overflow returns `QUEUE_CAPACITY_EXCEEDED`; jobs are never silently dropped. Rate-limited work carries retry-after evidence. Addressed collaboration messages include sender, recipient, sequence, acknowledgement, artifact references, and bounded redacted content. `collaboration.messages.acknowledge` lets the authenticated recipient or recorded goal coordinator explicitly acknowledge and optionally prune a bounded ID batch; clients cannot declare the recipient identity, and protected events are never discarded merely because a mailbox is full. Reviewers and voters receive the referenced artifacts and candidate diff; a vote must cite actual turn or artifact evidence.

Automatic task synthesis is sticky while healthy. `synthesizer: election` instead records attributable, deterministic policy ballots derived from the same authentication, health, capability, rate-limit, priority, load, and failure snapshot. It requires a real multi-agent quorum and strict winner; the evidence explicitly does not claim model-authored consensus. Synthesizer failover never changes the configured foreground lead.

For unattended use, `headless experimental goal run --autonomous --detach <objective>` starts a detached autonomous goal, while goal follow/send/status/cancel/result commands and MCP expose the same daemon state. The idle scanner waits for eight seconds of quiescence, durably deduplicates opportunity fingerprints across restart, and detects failed gates without follow-up, unverified completion, stalled work, unresolved candidates, and idle workers without a model call. `suggest` publishes only a visible lane, `read-only` may verify it within bounds, and `write` may submit a change only through the normal daemon write path. Autonomous writes still require project trust, an `auto` or allowed `bypass` goal, a clean primary checkout, a daemon-leased worktree, budgets, checks, review, finality, and merge authority. Headless reports a dirty primary checkout but never modifies or cleans it automatically.

Collaborative goals remain read-only unless `--mode write` is explicit. A write goal preserves the candidate first, sends its real job ID, output, diff, file list, and commit evidence to reviewers, requires a structured citation and attributable vote, then integrates through the candidate service. In `ask` mode, each mutating candidate/revision turn first waits on its own `coder_tool` approval; after the gates, the goal pauses again in `waiting_approval` for a distinct merge approval. Resolving that merge approval resumes the same candidate rather than running the coder again.

## Release invariants

The following are release requirements, not backend best-effort promises:

- native provider egress does not relax outer filesystem, process, Unix-socket, worktree, credential, or finality boundaries;
- a worker can read only its selected backend's auth capsule, never the real home or sibling credentials;
- untrusted project plugins, hooks, MCP servers, startup configuration, skills, and shell startup files remain disabled;
- `bypass` still fails containment, budget, credential-scope, repository-integrity, and merge-authority violations;
- every process timeout, cancellation, output overflow, daemon shutdown, and transport close performs bounded process-tree termination;
- lifecycle, policy, approval, and completion evidence is retained durably even when display updates are coalesced;
- native cost remains unknown rather than being reported as zero when the CLI supplies no charge;
- macOS Seatbelt and Linux bubblewrap/seccomp adversarial suites pass in both native-direct-unrestricted and broker-only modes;
- deterministic credential-free fake-CLI coverage passes for create/resume, cancellation, malformed events, rate limits, reconnects, daemon restart, and replay fallback for all four backends.

## Opt-in real subscription smoke

Real-account smoke is manually initiated and must never run in mandatory credential-free CI. Build first, ensure the official CLIs are already logged in, and set the exact opt-in guard:

```bash
bun run build
HEADLESS_NATIVE_SMOKE=1 bun run smoke:native
```

The harness uses only `dist/cli.js`, creates disposable clean project/state/runtime roots, grants trust only to that fixture, removes provider API-key and known provider-token variables from every child, starts one owned daemon, and runs one bounded read-only durable native-session turn per installed backend. It reports the selected driver/version/auth fingerprint and containment/cost/usage evidence, verifies Git remains clean at the original commit, and performs bounded TERM-to-KILL daemon cleanup on success, failure, timeout, output overflow, or an interrupt.

Grok is experimental. Headless installs an isolated configuration, masks every project control path present at startup, removes shell execution from the admitted tool set, and requires a contained, network-denied inspection attestation before provider access. A failed or incomplete attestation blocks the run. Direct Grok write execution remains fail-closed.

The equivalent manual shape is shown below for diagnosing a single backend:

```bash
tmp="$(mktemp -d)"
git -C "$tmp" init
git -C "$tmp" config user.name "Headless Smoke"
git -C "$tmp" config user.email "headless-smoke@example.invalid"
touch "$tmp/README.md"
git -C "$tmp" add README.md
git -C "$tmp" -c commit.gpgsign=false commit -m fixture

headless project trust grant --allow-native-direct-unrestricted --cwd "$tmp"

env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY -u GEMINI_API_KEY -u XAI_API_KEY \
  -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN -u CODEX_API_KEY \
  -u GROK_API_KEY -u OPENAI_ACCESS_TOKEN \
  headless exec --cwd "$tmp" --backend claude-code --auth-mode native-login \
  --approval-policy ask --timeout-ms 60000 --json "Reply with OK only. Do not use tools."

# Repeat with --backend codex, opencode, and grok-build.
```

Do not specify a model: the smoke must prove that model omission uses each CLI's configured default. For OpenCode, first ensure the fixed global `~/.config/opencode/opencode.json` or `opencode.jsonc` contains a safe scalar `model`; custom XDG/config overrides are intentionally ignored and do not satisfy this check. Use read-only mode and a bounded prompt. For each backend, retain the CLI version, selected session-driver kind, auth-profile fingerprint (never auth contents), containment mechanism, `native-direct-unrestricted`/`backend-native` evidence, terminal status, usage if reported, and cost attribution. Confirm the project and primary checkout remain unchanged and no API key appeared in output, events, artifacts, or logs.

A missing binary or login may be recorded as an explicit local skip, but it does not satisfy the v0.2 release gate for that backend. Never paste auth files, keychain material, or raw tokens into an issue or test artifact.
