# Native login, sessions, and fleet operation

Headless defaults to brokered provider access. Native login is an explicit private-alpha opt-in for trusted disposable projects because its outbound destination IPs are unrestricted. Both modes retain Headless's outer operating-system containment, project boundary, durable state, worktree isolation, budgets, and finality gates.

Examples assume the compiled `headless` binary is on `PATH`. From this checkout, run `bun run build` and use `./dist/cli.js` in its place.

## Project trust

Native login is available only after an authenticated operator grants trust to the daemon's canonical project root. Trust is stored outside the repository and cannot be supplied in a run request. The CLI mirrors the `project.trust.status`, `project.trust.grant`, and `project.trust.revoke` daemon methods:

```bash
PROJECT="${PROJECT:-$(pwd)}"
headless project trust status --cwd "$PROJECT"
headless project trust grant --allow-native-direct-unrestricted --cwd "$PROJECT"
headless project trust revoke --cwd "$PROJECT"
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

Headless does not embed provider list prices. Broker USD attribution requires a trusted dated pricing entry supplied by a daemon extension. With an empty pricing registry, costs remain `amountUsd: null`; a configured USD ceiling fails closed because the broker cannot safely prove the request fits it, and the daemon emits one bounded operator warning when the first affected lease is issued. Request, token, artifact, concurrency, and deadline bounds remain enforceable without USD pricing.

The authentication mode is part of every run and persisted execution record. Select native mode with `--auth-mode native-login`; omission selects broker. Experimental orchestration objects retain the same field but are outside the first beta contract. A goal's execution mode is separate: `read-only` is the default, while write mode requests the leased-worktree and integration-gate path.

## Minimal auth capsules

Headless never mounts the real home directory. It creates an owner-only worker root and imports only the fixed, backend-specific sources below. File capsules use canonical, non-symlinked, single-link regular files; the Claude setup-token source is validated and injected as one process environment value rather than copied:

| Backend | Host source | Worker destination |
| --- | --- | --- |
| Codex | `~/.codex/auth.json` | `$HOME/.codex/auth.json` |
| Claude (Linux/Windows file login) | `~/.claude/.credentials.json` | `$HOME/.claude/.credentials.json` |
| Claude setup-token (all supported platforms) | `~/.claude/.headless-setup-token` | `CLAUDE_CODE_OAUTH_TOKEN` in the contained Claude worker only |
| OpenCode | `~/.local/share/opencode/auth.json` | `$XDG_DATA_HOME/opencode/auth.json` |
| Grok | `~/.grok/auth.json` | `$HOME/.grok/auth.json` |

Grok reads credentials only from `$GROK_HOME/auth.json` (the open-sourced grok-build confirms no XDG fallback). Sign in with `grok login` (browser OAuth) or `grok login --device-auth` on a display-less host. Because the contained credential copy is disposable, recognized OIDC state must remain valid for the complete bounded turn; an expired or near-expiry token is reported as `Login required` instead of being refreshed only inside a throwaway worker.

An ordinary auth file is limited to 2 MiB and the complete file capsule to 4 MiB. The Claude setup-token has a separate 4 KiB limit and must be owner-only. Installed files use mode `0600`; worker directories use `0700`. Headless fingerprints the selected backend and exact selected credential contents for session-recovery checks. The worker does not receive sibling-provider files, ambient API-key or OAuth-token variables, Git credentials, SSH keys or agents, shell startup files, keychain exports, project `.env` files, or host sockets. The only OAuth-token environment value Headless creates is the explicitly allowlisted Claude setup-token described below.

The installed Claude CLI's login-keychain-only state on macOS is not discoverable from Headless's isolated `HOME` under the required default-deny Seatbelt profile. Headless does not export the Keychain item, expose the real home, or inherit an ambient OAuth token. Instead, a subscription user may explicitly mint and install the reviewed setup-token capsule below. When neither that token nor a supported `~/.claude/.credentials.json` exists, Headless returns `NATIVE_AUTH_UNAVAILABLE` with the setup-token remedy.

### Claude authentication under Headless

`claude auth status --json` reports whether the host Claude CLI can authenticate; it does not prove that Headless can construct a contained capsule. On macOS, that status may be `loggedIn: true` because the current login is in Keychain while an old `~/.claude/.credentials.json` remains on disk. Headless does not compare, merge, or export the Keychain credential.

For a Keychain-backed subscription, mint Claude Code's long-lived inference token and store the command's output at Headless's exact allowlisted path:

```bash
umask 077
mkdir -p "$HOME/.claude"
claude setup-token > "$HOME/.claude/.headless-setup-token"
chmod 600 "$HOME/.claude/.headless-setup-token"
```

The trimmed file must be no larger than 4 KiB and match the `sk-ant-oat…` setup-token format. It must be a canonical, owner-owned, single-link regular file with no group or other permissions. A present but empty, malformed, oversized, symlinked, hardlinked, or non-owner-only file returns `NATIVE_AUTH_UNAVAILABLE`; Headless never silently falls back to `.credentials.json` after an operator deliberately installs an invalid setup-token.

When valid, the setup-token takes exclusive precedence over `.credentials.json`. Headless hashes it into the native-auth fingerprint under the logical manifest entry `env:CLAUDE_CODE_OAUTH_TOKEN`, clears its temporary read buffers, and injects it only after the scrubbed baseline environment has been built for the contained Claude native-login process. The source file is never copied into the worker, and the token is never added to the daemon environment, persisted state, logs, ledger, or results. Redaction recognizes the complete setup-token alphabet as defense in depth. This is a long-lived subscription bearer: protect the source like a password, rotate it with Claude when necessary, and remove the file to return to the legacy `.credentials.json` path.

Then run Claude through the normal trusted native-login path:

```bash
PROJECT="${PROJECT:-$(pwd)}"

headless project trust grant --allow-native-direct-unrestricted --cwd "$PROJECT"
headless exec --cwd "$PROJECT" \
  --backend claude-code \
  --auth-mode native-login \
  --approval-policy ask \
  --timeout-ms 60000 \
  --json -- "Reply with OK only. Do not use tools."
```

On Linux, the supported subscription-login path is a normal Claude login, which Claude Code stores in the exact file Headless already allowlists:

```bash
PROJECT="${PROJECT:-$(pwd)}"

claude auth login
test -f "$HOME/.claude/.credentials.json"

headless project trust grant --allow-native-direct-unrestricted --cwd "$PROJECT"
headless exec --cwd "$PROJECT" \
  --backend claude-code \
  --auth-mode native-login \
  --approval-policy ask \
  --timeout-ms 60000 \
  --json -- "Reply with OK only. Do not use tools."
```

The file must be a non-symlinked, single-link regular file no larger than 2 MiB. Headless copies it owner-only to the isolated worker's `$HOME/.claude/.credentials.json`; it never mounts the host home. A custom `CLAUDE_CONFIG_DIR` is not an allowlisted source. Windows uses the analogous `%USERPROFILE%\.claude\.credentials.json`, but Headless execution itself currently returns `UNSUPPORTED_PLATFORM` on Windows.

Do not paste a setup-token into `.credentials.json`; Headless treats the two sources as different credential contracts. Broker mode with an Anthropic Console API key remains available when the setup-token path is unsuitable. The key must be present in the daemon's startup environment, and the model must have trusted pricing or receive the normal explicit approval:

```bash
PROJECT="${PROJECT:-$(pwd)}"
: "${ANTHROPIC_API_KEY:?export ANTHROPIC_API_KEY before starting the Headless daemon}"
: "${HEADLESS_CLAUDE_MODEL:?export the Anthropic model ID admitted by your Headless pricing policy}"

headless exec --cwd "$PROJECT" \
  --backend claude-code \
  --auth-mode broker \
  --model "$HEADLESS_CLAUDE_MODEL" \
  --approval-policy ask \
  --timeout-ms 60000 \
  --json -- "Reply with OK only. Do not use tools."
```

If the project daemon is already running without `ANTHROPIC_API_KEY`, restart that owned daemon from an environment containing the key; changing the caller shell cannot add a credential to an existing daemon.

OpenCode's model default is metadata, not capsule content. If a native OpenCode request omits `model`, Headless reads at most 64 KiB from the first present fixed global file, `~/.config/opencode/opencode.json` then `opencode.jsonc`. The file must resolve canonically inside the real home, be an owner-owned single-link regular file, and pass a no-follow open. Headless parses JSON/JSONC, validates only the scalar `model` with normal option bounds, passes it explicitly as `--model`, immediately clears the source buffers, and includes the selected value in the auth-profile fingerprint. It never copies or activates the host config; plugin, MCP, command, permission, agent, and every other field remain unavailable inside the worker because OpenCode still runs in pure mode with Headless's immutable config and disable flags.

Host `XDG_CONFIG_HOME`, `OPENCODE_CONFIG`, and alternate config paths are intentionally not consulted because they are untrusted control-plane surfaces. Use an explicit public `model` when the fixed global file does not provide the desired default. If neither fixed file contains a safe scalar, or the selected file is malformed, oversized, linked, non-owner, or unsafe, the run/session returns `NATIVE_AUTH_UNAVAILABLE` before an OpenCode process is launched. An explicit model takes precedence without reading host OpenCode config. A changed extracted model changes the persisted fingerprint, so Headless refuses native resume and uses only its recorded bounded replay path when replay evidence is available.

An unavailable, invalid, symlinked, or oversized login produces `NATIVE_AUTH_UNAVAILABLE`. Native authentication deliberately means the official backend can use its own scoped account state and contact its provider; it does not claim broker-style network or credential invisibility.

One-shot and persistent native-session launches apply the selected backend's `prepareEnvironment` hook after the isolated baseline environment is built. These hooks may add only reviewed backend control values, read-only system trust-store paths, and Claude's deliberately installed setup-token credential; they do not restore ambient API keys or OAuth tokens, keychain exports, real-home paths, or host sockets. In particular, Codex receives `SSL_CERT_FILE=/etc/ssl/cert.pem` and `SSL_CERT_DIR=/etc/ssl/certs` so TLS validation works from its isolated home without widening the Seatbelt network profile. Claude receives `CLAUDE_CODE_OAUTH_TOKEN` only when the setup-token capsule validated and the launch uses `native-login`; broker launches and capability probes do not receive it.

Grok hardening prepares a Headless-owned `config.toml` in its isolated `GROK_HOME`, explicit environment-level disables for every Cursor/Claude/Codex compatibility cell, no memory/subagents/web fetch/update/telemetry, a Headless system-prompt override, a mode-specific built-in tool allowlist, and startup-snapshot masks for existing project control paths. Before any provider access, a contained, network-denied `grok inspect --json` must attest that native project surfaces and every compatibility cell are disabled. Grok remains experimental and blocked when the installed version cannot produce that evidence.

## Approval policies

| Policy | Coder tool requests | Candidate integration |
| --- | --- | --- |
| `ask` | Create a durable pre-launch approval for each mutating turn; resume that same queued turn after approval | Pause separately for merge approval after gates |
| `auto` | Resolve from daemon policy | Integrate only after all configured gates |
| `bypass` | Use the backend's noninteractive approval mode inside containment | Integrate only after all configured gates |

`bypass` is not `--unsafe-no-sandbox`. It does not disable project trust, clean-primary checks, leased worktrees, filesystem or credential scope, budgets, finality, tests, reviews, votes, or merge authority. A tool or integration pause is reported as `APPROVAL_REQUIRED`; authenticated operators can use the experimental `approval list` and `approval resolve` subcommands when their scope allows it.

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

For unattended use, `headless experimental goal run --autonomous --detach -- "Analyze the fixture."` starts a detached autonomous goal, while goal follow/send/status/cancel/result commands and MCP expose the same daemon state. The idle scanner waits for eight seconds of quiescence, durably deduplicates opportunity fingerprints across restart, and detects failed gates without follow-up, unverified completion, stalled work, unresolved candidates, and idle workers without a model call. `suggest` publishes only a visible lane, `read-only` may verify it within bounds, and `write` may submit a change only through the normal daemon write path. Autonomous writes still require project trust, an `auto` or allowed `bypass` goal, a clean primary checkout, a daemon-leased worktree, budgets, checks, review, finality, and merge authority. Headless reports a dirty primary checkout but never modifies or cleans it automatically.

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

A missing binary or login may be recorded as an explicit local skip, but it does not satisfy Gate A for that backend. Later orchestration and write claims additionally require Gates B and C in [plan.md](./plan.md). Never paste auth files, keychain material, or raw tokens into an issue or test artifact.
