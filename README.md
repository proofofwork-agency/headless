# Headless v0.2

Headless is a local, project-scoped control plane for running AI coding CLIs and collaborative fleets. It normalizes OpenCode, Claude Code, Codex, and Grok Build behind one structured result, keeps their processes hidden behind a daemon-owned control plane, contains workers at the operating-system boundary, and records activity in an external hash-chained ledger.

Version 0.2 is intentionally breaking. Required containment is the default; an unavailable sandbox is an error, never an automatic downgrade.

See [CHANGELOG.md](./CHANGELOG.md) for the migration-facing release summary.

## Platform requirements

- Bun 1.1 or newer.
- macOS with `/usr/bin/sandbox-exec`, or Linux with a working `bubblewrap` (`bwrap`) installation.
- A supported backend CLI on `PATH`.
- By default, a native subscription login already established with that CLI. Headless copies only the selected backend's allowlisted login state into a temporary auth capsule after project trust is granted.
- API keys are needed only when `authMode: "broker"` (or `--auth-mode broker`) is selected explicitly.

Windows returns the stable `UNSUPPORTED_PLATFORM` result before a backend is launched.

## Install and verify

From a published package:

```bash
bun add -g @proofofwork-agency/headless@0.2.0
headless --version
```

From this checkout:

```bash
bun install --frozen-lockfile --ignore-scripts
bun run check
bun run build
bun run smoke:pack
```

`smoke:pack` packs both npm packages, verifies their allowlists against the generated `dist` trees, installs the tarballs into a clean temporary consumer, performs an isolated scratch-prefix `npm link`, and invokes only the published CLI, alias, doctor, TUI, MCP, daemon, and plugin entrypoints.

## Quick start

```bash
# Trust is an explicit, one-time decision for the canonical project root.
headless project trust grant --cwd .

# Required containment and native-login authentication are implicit.
# Omitting --model uses the backend CLI's configured default. For OpenCode,
# Headless safely extracts only the scalar global model; it never loads host config.
headless exec --backend opencode --json "Summarize this project"

headless exec --backend claude-code --model claude-sonnet-4-5 \
  --approval-policy ask --timeout-ms 60000 --json "List the public API"

# API-key brokering is an explicit hardened mode.
headless exec --backend codex --auth-mode broker --json "Review the parser"

# The only local containment bypass. It is marked unsafe in the result/ledger.
# Approval bypass does not remove Headless's outer containment or gates.
headless exec --backend codex --unsafe-no-sandbox --json "Say OK"
```

The CLI connects to the authenticated daemon for the canonical `--cwd` project root, starting an embedded daemon when necessary. `headless daemon serve` runs it explicitly. Use `headless --help` for the current command and flag surface, including durable sessions, workflows, councils, the TUI, event snapshots, and release gates.

### Backends

| Backend | Aliases | Model | Agent | Write |
| --- | --- | --- | --- | --- |
| `opencode` | `headless-opencode` | yes | yes | yes |
| `claude-code` | `claude` | yes | no | yes |
| `codex` | `codex-cli` | yes | no | yes |
| `grok-build` | `grok` | yes | yes | yes |

Adapter capabilities are runtime metadata. Direct calls to `registerAdapter`, `registerProvider`, and `registerPricing` affect only that JavaScript process. A detached daemon loads extensions only from an explicit trusted startup config; executable paths are never accepted in `RunRequest` or any daemon RPC.

The Grok command adapter and session driver implement read/write and resume, but Grok 0.2.93 cannot yet satisfy Headless's required lifetime containment invariant: it can discover project controls created after launch. Required Grok runs therefore return `BACKEND_UNSUPPORTED` before authentication or subprocess launch. The table describes adapter capabilities, not a release-gate exemption.

### Authentication and approvals

`native-login` is the default for runs, durable sessions, goals, workflows, councils, and fleet profiles. It uses the official CLI's existing account without copying the real home directory or unrelated credentials into a worker. Native runs are reported as `network: "provider-direct"`, `credentialAccess: "backend-native"`, and `cost.amountUsd: null` unless the CLI reports an actual charge. `broker` keeps the previous short-lived broker-token model, denies direct provider egress, and enforces API-cost bounds.

Claude on macOS currently requires a supported regular-file login state such as `~/.claude/.credentials.json`. A login-keychain-only account cannot be discovered from the isolated worker under required default-deny Seatbelt containment. Headless returns `NATIVE_AUTH_UNAVAILABLE` instead of forwarding `CLAUDE_CODE_OAUTH_TOKEN`, exposing the real `HOME`, exporting keychain data, or weakening Seatbelt; use broker mode when no supported regular-file login exists.

OpenCode is handled deliberately: when `model` is omitted, Headless performs a bounded, canonical, no-symlink read of `~/.config/opencode/opencode.json` or `opencode.jsonc`, validates only its scalar `model`, and passes that value explicitly as `--model`. It does not copy or activate the host config, so its plugins, MCP servers, commands, permissions, and other fields cannot become worker configuration. A custom host `XDG_CONFIG_HOME` or `OPENCODE_CONFIG` is intentionally ignored; specify `--model` explicitly when the safe fixed global files contain no model. Missing, malformed, oversized, linked, non-owner, or unsafe defaults return `NATIVE_AUTH_UNAVAILABLE` before OpenCode starts. The selected scalar is included in the native auth-profile fingerprint so a changed default cannot silently resume an older session.

Approval policy is independent of authentication:

- `ask` creates a durable approval before each mutating coder turn, launches that same queued turn only after approval, and later pauses separately before candidate integration.
- `auto` resolves coder-tool requests from Headless policy and integrates only after every configured gate passes.
- `bypass` selects the coder's noninteractive approval mode inside the outer sandbox. It never bypasses project trust, filesystem or credential scope, budgets, worktree isolation, clean-primary checks, finality, tests/reviews/votes, or merge authority.

Durable collaborative goals are read-only by default. Select a gated write goal explicitly with `headless goal run --mode write "Implement the approved change"`; the mode is persisted with the goal and cannot weaken project trust, worktree isolation, approval, or integration gates.

The TUI mirrors these controls without blocking its live subscriptions: `/trust status|grant [bypass] [no-native]|revoke` manages project consent, `/use-fleet <profile-id>` activates a persisted fleet, `/goal <objective>` starts a read-only goal, and `/goal-write <objective>` starts an explicitly gated write goal. Its live panel shows recent bounded, redacted turns and addressed messages; `/ack-message <id> [more ids] [--retain]` acknowledges consumed mailbox entries and prunes them by default to relieve backpressure. Omitted goal authentication and approval controls inherit the active fleet profile.

See [Native login, sessions, and fleet operation](./docs/native-login.md) for the auth-capsule allowlist, session-driver behavior, recovery rules, structured failures, and opt-in subscription smoke procedure.

Create an owner-controlled config outside untrusted project configuration (the entry paths may be relative to the config file):

```json
{
  "version": 1,
  "modules": ["./my-headless-extension.mjs"]
}
```

Each module exports `default` or `registerHeadlessExtension`, receives the daemon's exact registry API, and calls `api.registerAdapter(...)`, `api.registerProvider(...)`, and/or `api.registerPricing(...)`. Provider definitions include a trusted `validateBoundedInput` callback that rejects provider-side context the extension cannot bound under input/cost caps. Pricing entries include provider/model, effective dates, and input/output rates; they are the trusted source used when a cost-capped request must be bounded before provider egress. Start or connect with an absolute config path:

```bash
headless exec --extension-config /absolute/path/extensions.json \
  --backend my-adapter --unsafe-no-sandbox --json "Say OK"

# Or for every client launched from this trusted shell:
HEADLESS_EXTENSION_CONFIG=/absolute/path/extensions.json headless daemon serve --cwd /project
```

Library callers can pass `extensionConfigPath` (or absolute `extensionModules`) to `exec`/`connectOrStartDaemon`; `HeadlessDaemon` accepts the same startup-only options. Config/module files and their ancestor chain are canonicalized, bounded, permission-checked, and content-fingerprinted. A detached bootstrap passes the already-resolved paths and hashes through a startup-only manifest, and the child revalidates them immediately before import. The daemon reports only the configuration digest and registered IDs. A client explicitly requesting a different digest fails closed, and one process cannot host daemons with different extension registries; restart the daemon process after changing an extension. Extension modules execute with daemon authority and therefore must be treated as trusted code.

## Control room (TUI)

`headless tui` (alias `hless tui`) opens the control room, an Ink terminal UI that drives the same authenticated daemon as every other client. It requires an interactive terminal and the project's one-time trust grant; native-login, approval policy, and fleet selection resolve exactly as they do on the CLI. Input stays editable while the daemon reconnects, and every panel is fed by a bounded, redacted live subscription.

Six views, switched with `tab`/`shift+tab`, the number keys `1`–`6`, `←`/`→` when the prompt is empty, or a mouse click on the tab bar:

- **Overview** — fleet, active goal, pending approvals, and the inspected candidate as cards above a merged activity feed of turns, messages, and run events.
- **Fleet** — the active profile's agents (health, backend, auth, load) beside a detail pane; other profiles are listed for `/use-fleet`.
- **Goals** — every known goal with its state glyph, plus the selected goal's objective, leader, and turn/message timeline.
- **Approvals** — the pending approval queue with the selected entry's detail and the exact `/approve` and `/deny` forms.
- **Events** — the live, redacted ledger feed with scrollback (`↑`/`↓`, `pgup`/`pgdn`; `esc` returns to live).
- **Help** — the command palette and keybindings, rendered in-app.

`⏎` submits the prompt or activates the selected row; `esc` clears the prompt, then leaves scrollback, then returns to Overview; `q` quits when the prompt is empty; `ctrl+c` always quits. The mouse selects tabs and rows and the wheel scrolls. Free text with no leading `/` is sent to the active goal's coordinator, starting a read-only goal when none is active. Slash commands mirror the CLI:

| Command | Effect |
| --- | --- |
| `/goal <objective>` · `/goal-write <objective>` | start a read-only or gated write goal |
| `/use-goal <id>` · `/cancel-goal [id]` | switch or cancel the active goal |
| `/leader <agent-id>` · `/send <text>` | transfer leadership · send a coordinator turn |
| `/ack-message <id…> [--retain]` | acknowledge mailbox entries, pruning by default |
| `/fleet` · `/use-fleet <id>` | refresh, or activate a persisted fleet profile |
| `/policy ask\|auto\|bypass` | set the active fleet's approval policy |
| `/trust status\|grant\|revoke` | manage project trust |
| `/approve <id> [reason]` · `/deny <id> [reason]` | resolve a pending approval |
| `/candidate <id>` · `/integrate <id>` · `/reject-candidate <id>` | inspect, integrate, or reject a candidate |
| `/autonomy on\|off` · `/dispatch [backend] [prompt]` | toggle the orchestrator · queue a contained read-only run |
| `/council <question>` · `/gate` · `/workflow <id>` | run a council · run the release gate · show workflow progress |
| `/claim <task-id>` · `/pair` · `/doctor` | claim durable work · pair · one-line connection summary |

The control room never weakens the daemon's guarantees: every command is an authenticated daemon RPC, updates are redacted and bounded, and it cannot select an arbitrary project root or principal.

## CLI commands

Every command connects to the daemon for the canonical `--cwd` root, starting an embedded daemon when none is live. `--json` returns structured output where supported, and a literal `--` precedes prompts that begin with a flag. Backends are `opencode` (default), `claude`/`claude-code`, `codex`/`codex-cli`, and `grok`/`grok-build`; `--model` is optional everywhere and the backend's own default is used when omitted.

| Area | Commands |
| --- | --- |
| Run | `exec\|run [--backend --mode --model --agent --session-id --timeout-ms --stream --json --require-sandbox\|--unsafe-no-sandbox] "prompt"` · `launch <backend> [prompt]` |
| Sessions | `session create\|send\|resume\|cancel\|status\|result --session-id <id>` |
| Goals | `goal start\|run\|send\|follow\|status\|list\|cancel\|result [--goal-id --fleet-profile-id --coordinator --mode --detach]` |
| Collaboration | `collaboration turns\|messages\|acknowledge\|transfer-leader --goal-id <id> [--message-id … --retain]` |
| Approvals | `approval list\|resolve [--goal-id --approval-id --decision approved\|rejected --resolution]` |
| Candidates | `candidate inspect\|integrate\|reject --candidate-id <id>` |
| Fleet | `fleet health` · `fleet profile upsert\|get\|list\|remove [--file --profile-id --activate]` |
| Councils / workflows | `council [--agent … --mode] "question"` · `workflow run\|list\|status\|wait\|cancel [--file --workflow-id]` |
| Autonomy | `autonomy start\|stop\|status\|ask\|backup` · `orchestrate` · `pair` |
| Project | `project trust status\|grant\|revoke [--allow-bypass --deny-native-login]` · `init` |
| Daemon / inspect | `daemon serve\|status` · `status` · `doctor` · `events [--follow --limit]` · `tui` |
| Gate / MCP | `gate [--check check\|build\|test\|pack]` · `mcp serve\|install\|remove\|status [host]` |

Read-only inspection (`status`, `doctor`, `events`, the `*.list`/`*.status` forms, `fleet health`, `approval list`, `candidate inspect`) never mutates state. `project trust`, `fleet profile`, `approval resolve`, `candidate integrate`, and goal/session lifecycle changes are durable. `exec`, `session send`/`resume`, `goal start`/`run`, `council`, `workflow run`, `gate`, and `autonomy start` spawn contained backend or check work. Use `bun src/cli.ts <command>` in a checkout during development.

## Containment model

Every backend is treated as arbitrary code execution.

For a required run, Headless creates a private worker root with a separate `HOME`, XDG config/data/cache/runtime directories, and temporary directory. The worker never inherits the real home, ambient API keys, Git/SSH configuration, shell startup files, keychain exports, unrelated provider state, or host agent sockets. Existing repository `.env`, `.env.*`, `.envrc`, and local/common/linked-worktree Git config files are discovered recursively with a fail-closed bound, then denied on macOS and over-mounted on Linux in both primary and leased-worktree views; ordinary project source remains readable.

In native-login mode, Headless copies only the selected backend's minimal regular-file auth allowlist into that private root. Files are size-bounded, reject symlinks, use owner-only permissions, and contribute to an auth-profile fingerprint. Keychain-only Claude login on macOS is currently unsupported in required containment because the official CLI cannot discover it from the isolated home without broader real-home access. In broker mode, no native login state enters the worker and the daemon injects only a short-lived token scoped to the run, provider, model, routes, duration, and budget.

- macOS uses separate default-deny Seatbelt profiles for read and write modes. Project access is read-only, only a leased write worktree may be writable, its `.git` pointer stays immutable, and network binding remains denied. Broker runs allow only the selected loopback broker port; native-login runs permit provider-direct outbound connections plus narrow TLS service lookups.
- Linux requires successful bubblewrap and seccomp capability probes. The host and primary checkout are read-only, worker storage is mounted writable, the write worktree is the only writable project view, its `.git` pointer stays immutable, and PID/IPC/UTS namespaces remain isolated. Broker mode also isolates the network namespace. Provider-direct mode deliberately retains outbound IP networking, while host pathname sockets remain masked and the backend is denied `AF_UNIX` socket creation. On x86-64 the filter rejects the x32 syscall ABI before native syscall matching, and the capability probe exercises that alternate-ABI boundary.
- Native backend restrictions remain defense in depth: OpenCode project configuration/plugins/skills are disabled; Claude receives tool restrictions; and Codex combines its native sandbox with explicit disables for project plugins, hooks, apps, browsers, hidden subagents, MCP skill dependencies, and both repository skill roots. Grok has isolated-config, prompt/tool, and startup-snapshot hardening, but required Grok runs remain fail-closed until late-created watched project controls can be denied on both release platforms.

`--unsafe-no-sandbox` is a separate explicit local containment escape hatch. The `bypass` approval policy is not this escape hatch: bypass stays inside Headless containment and all fleet/write gates. Unsafe runs are visibly marked and are rejected by autonomous orchestration and councils.

On Linux, a non-dumpable supervisor inside the private worker namespaces owns loopback-only broker and run-tool proxies when those capabilities are active. Before the proxies bind, a helper isolates its file-descriptor table; after they are ready it installs no-new-privileges and a mode-specific seccomp filter, then replaces itself with the backend. The backend cannot create Unix sockets or inspect the supervisor. Broker mode cannot reach host/LAN/internet routes; native provider-direct mode permits outbound provider traffic but does not relax filesystem, process, Unix-socket, worktree, or credential boundaries. Missing required relay/runtime/socket/seccomp capabilities fail closed.

Every daemon-owned required run also receives a separate owner-only Unix endpoint and an in-memory, short-lived credential bound to that exact project, job, session, and principal. A disposable `headless-run-tool` helper exposes only bounded cooperation operations such as context, notes, messages, task status, artifacts, and finality proposals. It cannot start runs, choose a filesystem root, change policy or budgets, grant authority, merge writes, or administer credentials. The daemon destroys the listener and live connections when the run terminates; unsafe runs never receive it.

See [SECURITY.md](./SECURITY.md) for the threat model and exact limits.

## Writes and finality

A write run requires Git and a clean primary checkout. Headless durably records a preparing lease before asking Git to create the ephemeral worktree from the recorded primary `HEAD`, then activates the lease only after creation succeeds. The primary checkout is not the worker’s writable directory. Headless captures and redacts the candidate diff even when execution fails.

Daemon-owned integration uses a sanitized Git environment and daemon identity, then records the base, candidate, resulting commit, gates, actor, grant, and outcome. Auto-merge is permitted only when the authenticated coordinator has merge authority and configured policy/test/review/vote/budget gates pass. An unchanged clean primary can fast-forward; an advanced primary is integrated and re-gated in a separate worktree. Durable leases retain crashed worktrees as evidence, and a fsynced integration journal reconciles a crash after the primary update. Conflicts, ambiguous recovery, or failed gates leave primary untouched or fail closed while preserving evidence.

Direct library runs without a daemon write-integration policy remain diff-only.

## Daemon and durable state

One authenticated daemon owns each canonical project root. Its Unix socket and token are owner-only, and clients cannot replace the daemon’s project root or self-declare their principal/coordinator identity.

State is outside the repository and keyed by `sha256(canonical project root)`:

- Linux: `${XDG_STATE_HOME:-~/.local/state}/headless/projects/<project-id>`
- macOS: `~/Library/Application Support/Headless/projects/<project-id>`
- Tests/managed deployments: `HEADLESS_STATE_HOME/projects/<project-id>`

This contains the ledger and read projections, jobs, tasks, workflows, sessions, policy/grants, budgets, worktree leases, integration journals, artifacts, and daemon metadata. A normal read-only run does not create `.headless` or edit `.gitignore` in the repository.

On first v0.2 open, a valid v1 `.headless` ledger is verified and imported into external state. Before the first v2 import append, Headless writes an `importing` manifest bound to the verified source hash, dimensions, target ledger, and starting head. Import records use deterministic IDs and progress is reconciled on restart, making a crash after a durable append idempotent. The original file is not changed. Invalid or ambiguous chains fail with recovery guidance.

### Ledger v2

Ledger v2 assigns immutable envelope fields in the daemon: version, sequence, timestamp, project ID, authenticated principal, event ID, previous hash, and hash/HMAC metadata. Payload fields cannot override the envelope.

Reads verify the chain incrementally with partial-line buffering, exact event-ID duplicate suppression, and a digest-bound, size-bounded persisted read projection. Explicit retry IDs are suppressed before append; an exact verified-prefix index prevents older duplicates from reappearing after the bounded persisted ID window rolls over. Context and task-state calls apply only accepted events to a maintained, bounded semantic projection for the authenticated principal and session; a ledger head mismatch triggers a verified rebuild instead of trusting stale state. Lock ownership includes PID, process-start identity, host, and nonce; a verified live owner’s lock is never removed and an unverifiable foreign-host lock fails closed. Set `HEADLESS_LEDGER_KEY` to use HMAC-SHA256 rather than an unkeyed hash.

All event/output/diff paths are deeply redacted and size-bounded before callbacks, terminal output, ledger writes, MCP/plugin responses, and TUI updates. Stateful process-stream redaction protects credentials split across chunk boundaries. Unknown provider pricing is represented as `null`, not zero.

## Structured contracts

The shared Zod schemas exported by the package define requests, results, events, adapters, jobs, tasks, sessions, workflows and steps, grants, budgets, councils, fleet profiles, goals, turns, delegations, directed messages, reviews, votes, approvals, candidates, and finality decisions.

```ts
import { RunRequestSchema, exec } from "@proofofwork-agency/headless";

const request = RunRequestSchema.parse({
  backend: "codex",
  prompt: "Review the parser",
  projectRoot: process.cwd(),
  containment: "required",
  authMode: "native-login",
  approvalPolicy: "ask",
  timeoutMs: 60_000,
});

const result = await exec({
  backend: request.backend,
  prompt: request.prompt,
  cwd: request.projectRoot,
  containment: request.containment,
  authMode: request.authMode,
  approvalPolicy: request.approvalPolicy,
  timeoutMs: request.timeoutMs,
});
```

Expected runtime failures return structured results with terminal status, structured error, stdout/stderr, parser diagnostics, exit code/signal, separated token dimensions, cost attribution, containment evidence, session/job IDs, diff/commit data, and truncation flags. Invalid API use remains an exception. A run timeout starts when the durable job is created and covers queueing, preparation, broker access, and worker execution. Concurrency caps keep excess jobs queued instead of rejecting or dropping them. Cost-capped runs require trusted dated pricing: admission reserves a conservative model-aware estimate, authorization reuses that immutable estimate, and the broker checks each concrete protocol token maximum before egress. When a request supplies multiple recognized output-limit fields, the greatest value is reserved and multiplied by its greatest declared candidate count. Under token or cost caps, built-ins require a positively recognized text-generation model and reject provider-side conversation/prompt/file references, remote media, server-side search, provider-managed tools, non-text output modalities, and automatic/non-standard service tiers whose context or charges cannot be bounded from the request; provider extensions must supply a trusted bounded-input validator. For built-in cost-capped protocols, an omitted service tier is normalized to that provider's deterministic standard tier before byte/token pricing and forwarding. Durable budget request/input/output quotas are shared atomically across every lease for that budget, including leases issued later, so concurrent runs cannot each spend the same remainder. Interrupted broker-backed runs exhaust affected bounded dimensions when exact usage was lost, preventing quota reuse after a daemon crash. Unknown or unbounded pricing fails closed under a cap while the public cost remains `null`.

Durable sessions expose create, send/resume, cancel, status, and result operations through `HeadlessDaemonClient`. A dedicated driver factory capability-probes each installed CLI and records the selected driver, backend version, auth fingerprint, capabilities, native session/thread ID, last turn, rate-limit evidence, and recovery state. Codex prefers a hidden persistent app-server transport and falls back to `codex exec resume`; Claude uses print mode with durable IDs and `--resume`; OpenCode uses `run --session`; Grok uses structured headless execution with `--resume`. Backend event assemblers preserve stable IDs, order out-of-order deltas, bound malformed data/output, infer completion only from explicit evidence, and retain retry-after data. If native resume is unavailable, Headless may replay only a bounded redacted transcript and records that recovery explicitly.

## Durable workflows

The daemon persists workflow DAGs and their step attempts, resumes queued/running workflows after restart, injects bounded actual dependency results and diffs into downstream prompts, retries only within each step's `maxAttempts`, and enforces typed policy, budget, test, review, and vote finality. Workflow execution always requires containment. Write steps preserve candidate commits for an explicit authorized integration decision; a workflow does not silently merge them.

Create a JSON definition and use the same daemon-backed CLI for lifecycle operations:

```json
{
  "id": "review-change",
  "requirements": {
    "policy": true,
    "tests": true,
    "review": true,
    "vote": false,
    "budget": true
  },
  "steps": [
    {
      "id": "implement",
      "kind": "execution",
      "backend": "codex",
      "prompt": "Implement the requested change",
      "mode": "write",
      "timeoutMs": 180000,
      "maxAttempts": 2
    },
    {
      "id": "test",
      "kind": "test",
      "backend": "opencode",
      "prompt": "Test the candidate and report concrete evidence",
      "dependsOn": ["implement"]
    },
    {
      "id": "review",
      "kind": "review",
      "backend": "claude-code",
      "prompt": "Review the candidate result and diff",
      "dependsOn": ["implement", "test"]
    }
  ]
}
```

```bash
headless workflow run --file workflow.json
headless workflow list
headless workflow status --workflow-id review-change
headless workflow wait --workflow-id review-change --timeout-ms 600000
headless workflow cancel --workflow-id review-change
```

Step `kind` defaults to `execution`, `mode` to `read-only`, `timeoutMs` to 180000, `maxAttempts` to 1, and `dependsOn` to an empty array. Definitions are bounded to 64 acyclic steps and two million prompt bytes.

Councils persist their mode, timeout, phase job IDs, attributable votes, and terminal decision. Every phase job carries an atomic council/slot binding, so startup can reconcile a crash between job creation and council-record update without duplicating work or spend; an interrupted active phase gets one budget-checked retry, while a phase already cancelling becomes terminal and is never retried after restart. Failed proposals cannot satisfy finality, and an even council requires a strict majority rather than accepting a tie. A write council's test gate is bound to the durable finality decisions produced by the actual candidate execution jobs; preserving a candidate commit is not treated as evidence that its configured tests passed.

## MCP server

The published `headless-mcp` binary is a stdio server. It is bound to one configured project root; tool arguments cannot select an arbitrary filesystem root or claim coordinator authority.

```bash
HEADLESS_PROJECT_ROOT=/absolute/project headless-mcp
```

Without a global install, MCP hosts can launch the published binary with:

```bash
bunx --bun -p @proofofwork-agency/headless@0.2.0 headless-mcp
```

See [docs/mcp-integration.md](./docs/mcp-integration.md) for host configurations and the tool surface.

## OpenCode plugin

Install both packages; the plugin intentionally declares Headless as a required runtime peer:

```bash
bun add @proofofwork-agency/headless@0.2.0 \
  @proofofwork-agency/headless-plugin@0.2.0
```

Then add the compiled package to OpenCode configuration:

```json
{
  "plugin": ["@proofofwork-agency/headless-plugin"]
}
```

The repository’s `opencode.json` references `./plugin/index.ts` only for local development. Published consumers load `plugin/dist/index.js`; no excluded TypeScript source is required.

## Release checks

```bash
bun run check          # typecheck, hygiene/docs checks, deterministic tests
bun run build          # clean JS bundles and declarations
bun run smoke:pack     # tarball contents, clean install, compiled entrypoints
bun run release:check  # all of the above
# Explicit opt-in only; uses built artifacts and existing CLI subscriptions.
HEADLESS_NATIVE_SMOKE=1 bun run smoke:native
```

CI runs the gate on current Ubuntu and macOS runners. Linux installs bubblewrap and requires its real write-denial probe; macOS requires the real Seatbelt probe. The ordinary local suite keeps its provider-direct socket checks local and deterministic; macOS CI sets `HEADLESS_REAL_NETWORK_TEST=1` for the separate public DNS/TLS Seatbelt probe, whose child receives only the isolated worker environment. Provider-secret smoke tests are separate from deterministic fake-provider tests.

The manually triggered `Protected provider smoke` workflow runs `bun run smoke:providers` through real scoped broker leases. Its protected GitHub environment must be named `provider-smoke` and supply secrets `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, and `XAI_API_KEY`, plus model variables `HEADLESS_SMOKE_OPENAI_MODEL`, `HEADLESS_SMOKE_ANTHROPIC_MODEL`, `HEADLESS_SMOKE_GEMINI_MODEL`, and `HEADLESS_SMOKE_XAI_MODEL`. It makes one bounded request per provider and is intentionally not part of `release:check`; this repository does not claim that the credentialed smoke has run.

Real native-subscription smoke is also opt-in and never part of credential-free CI. The harness refuses to start unless `HEADLESS_NATIVE_SMOKE=1`, requires `dist/cli.js`, creates disposable project/state/runtime roots, removes provider API-key and known provider-token variables—including `CLAUDE_CODE_OAUTH_TOKEN`—from every child, runs one bounded read-only native session turn per installed backend, verifies the primary checkout is unchanged, and always terminates its daemon tree. It records pass/skip/failure separately for Claude, Codex, OpenCode, and Grok; any missing or unsupported login means the release gate did not pass. The exact procedure and evidence are in [docs/native-login.md](./docs/native-login.md#opt-in-real-subscription-smoke).

No release should be published while a required platform gate fails or a known P0/P1 security or data-integrity defect remains.

## License

MIT. See [LICENSE](./LICENSE).
