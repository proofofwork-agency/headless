# Headless

> **Unpublished private beta candidate.** The packages are not published and no Gate A,
> B, or C release has shipped. Build from source, use disposable projects, and
> do not entrust Headless with sensitive source, valuable credentials, or
> unattended spend yet.

Headless turns any supported CLI coder into the visible foreground lead while
the others run as contained servants behind one local, auditable control plane.
Claude Code, Codex, OpenCode, and Grok use the same admission, containment,
budget, approval, result, and ledger contracts.

```text
foreground Claude / Codex / OpenCode / Grok lead
                    │ generation-bound MCP
                    ▼
         authenticated project daemon
                    │ policy → budget → queue
                    ▼
         independently contained workers
                    │
                    └─ result → ledger → observer TUI
```

The full documentation is hosted at
[proofofwork-agency.github.io/headless](https://proofofwork-agency.github.io/headless/).
Its [Docusaurus site sources](./website/README.md) include the
[quickstart](./website/docs/getting-started/quickstart.md),
[why Headless](./website/docs/concepts/why-headless.md),
[architecture and data flow](./website/docs/concepts/architecture.md),
[the four policy axes](./website/docs/concepts/modes.md),
[operating-system containment](./website/docs/concepts/containment.md),
[the safety model](./website/docs/concepts/safety-model.md),
[persistent sessions](./website/docs/concepts/sessions.md),
[portable skills](./website/docs/concepts/skills.md),
[execution receipts](./website/docs/concepts/receipts.md),
[repair and recovery](./website/docs/concepts/repair-and-recovery.md),
[leads and the fleet](./website/docs/concepts/leads-and-fleet.md),
[building applications](./website/docs/guides/building-apps.md),
the per-coder guides for
[Claude](./website/docs/ai-coders/claude.md),
[Codex](./website/docs/ai-coders/codex.md),
[OpenCode](./website/docs/ai-coders/opencode.md), and
[Grok](./website/docs/ai-coders/grok.md), and the
[recorded case studies](./website/docs/case-studies/proven-runs.md).

## Why not a single AI coder

A single chat with one coder is useful for interactive work. Headless is a
control plane around many coders when you need authority, audit, and recovery
that one session window does not provide.

| Concern | One chat / one coder | Headless |
| --- | --- | --- |
| Coordination | Implicit in the conversation | Daemon-owned policy, queue, and generation-bound MCP lead |
| Backends | One vendor stack at a time | Claude, Codex, OpenCode, and Grok under one contract |
| Isolation | Host shell and ambient credentials | Required OS containment (Seatbelt / bubblewrap+seccomp) |
| Spend | Easy to exceed without a hard stop | Budgets, broker leases, crash-atomic linked holds |
| Mutation | Direct primary-checkout edits | Leased write worktrees, gates, finality, authorized integration |
| Evidence | Scrollback and provider logs | Hash-chained ledger + per-run execution receipts |
| Roles | One agent is both planner and implementer | One visible lead + independently contained servants |

Use a single coder when that is enough. Use Headless when heterogeneous
execution, fail-closed recovery, and attributable results matter more than a
monolithic chat transcript.

## What makes Headless different

Headless competes on **safe heterogeneous execution**, not on matching any one
vendor's multi-agent UI or subagent depth.

- **Cross-backend, not same-vendor only.** Claude Code, Codex, OpenCode, and
  Grok share admission, containment, budget, approval, result, and ledger
  contracts. Same-vendor multi-agent products stay inside one provider's
  runtime; Headless treats backends as interchangeable workers under one
  project daemon.
- **Required OS containment and fail-closed recovery.** Workers do not run as
  ambient host processes. Ambiguous budget, worktree, integration, or
  linked-hold state fails closed rather than inventing authority.
- **Tamper-evident ledger and execution receipts.** Every admitted run leaves
  attributable evidence you can verify offline (`headless verify`,
  `experimental receipt`).
- **Orchestration UI is secondary.** The observer TUI has no mutation
  authority. The product wedge is the control plane: policy, containment,
  budgets, leased writes, and recovery.
- **Daemon-authoritative successor.** Headless is the daemon-owned successor of
  two-terminal ContextRelay-style coordination: one project daemon is the
  source of truth; CLI, MCP lead, and TUI are authenticated clients.

**Non-goals for this private beta** (deliberate scope, not temporary gaps only):

- Conductor-style visual multi-agent parity
- Matching same-vendor subagent depth before the heterogeneous kernel is solid
- Windows support
- Unattended production spend or continuous self-host of this monorepo

Deeper framing lives in
[why Headless](./website/docs/concepts/why-headless.md).

## What works in the current tree

- One bounded `exec` path across four backend adapters.
- Subscription-native execution without separate API keys, plus broker mode as
  the tighter credential and network alternative.
- Required Seatbelt containment on macOS and bubblewrap plus seccomp on Linux.
- One externally launched, generation-bound MCP lead per project.
- A read-only observer TUI with logs and a Config pane that generates commands
  but holds no mutation authority.
- Experimental deliberations, councils, fleets, goals, workflows, sessions,
  approvals, candidates, and depth-one worker delegation.
- Experimental gate-driven repair loops (`experimental loop --repair`) that
  compile a repair graph from failing checks and re-gate until green, budget,
  deadline, or stagnation.
- Experimental restartable workflow DAGs with durable step state and recovery.
- Leased write worktrees with secret scanning, project gates, finality, and
  authorized integration instead of direct primary-checkout mutation.

## Golden path (≤ 5 minutes)

One path from cold start to a verified contained run. Use a **disposable** project
while Headless is private beta. Sign in to at least one coder CLI first
(`codex login`, `opencode auth login`, `claude setup-token` on macOS, etc.).

```bash
bun install --frozen-lockfile --ignore-scripts
bun run build

HEADLESS="$PWD/dist/cli.js"
PROJECT="/absolute/path/to/a/disposable/project"

# 1) Wizard: init external state, inventory CLIs, print next commands
"$HEADLESS" setup --cwd "$PROJECT"

# 2) Intentional friction: native login needs unrestricted-egress acknowledgement
"$HEADLESS" project trust grant \
  --allow-native-direct-unrestricted \
  --cwd "$PROJECT"

# 3) Native subscription login (not broker API keys) + read-only + required containment
"$HEADLESS" exec \
  --backend codex \
  --auth-mode native-login \
  --profile read-only-native \
  --cwd "$PROJECT" \
  -- "Inspect the public entry points."

# 4) Artifact-first: verify the ledger (exec also prints receipt/verify hints)
"$HEADLESS" verify --cwd "$PROJECT"

# Readiness panel (human or --json for scripts)
"$HEADLESS" doctor --cwd "$PROJECT"
"$HEADLESS" doctor --json --cwd "$PROJECT"
```

Noninteractive grant+setup:
`"$HEADLESS" setup --yes --allow-native-direct-unrestricted --cwd "$PROJECT"`.

Optional lead binding: `setup --lead codex` (or `init --lead …`). Lead install does
**not** grant trust, write authority, or approval bypass.

Profiles: `read-only-native` | `broker-readonly`. Advanced orchestration
(`fleet`, `goal`, `council`, …) lives under `headless experimental`.

Native results report `network: "native-direct-unrestricted"`. This is truthful
egress evidence, not a provider destination allowlist. Revoke consent with:

```bash
"$HEADLESS" project trust revoke --cwd "$PROJECT"
```

## Building applications

Operator outline only — not a full tutorial. Prefer the golden path until the
kernel is solid on your machine. Depth lives under
[building applications](./website/docs/guides/building-apps.md) and the CLI
guide.

1. **Kernel.** `setup` → contained `exec` → `verify` (and `doctor` when
   readiness is unclear). This is the only path Product Gate P optimizes for.
2. **Lead + fleet profile.** Bind a visible lead (`setup --lead` / `lead use`)
   and declare a fleet profile under `experimental fleet` so workers share
   auth mode, approval policy, and idle posture without ad-hoc flags each run.
3. **Goals.** Start with a read-only plan goal; promote to write only with
   trust, budgets, gates, review, and authorized integration. Autonomous goal
   modes remain experimental and still require the normal write path.
4. **Councils / deliberate.** Use `experimental council` or MCP
   `headless_deliberate` / `council_deliberate` for multi-backend review before
   you trust a candidate. Routing excludes the active lead backend by default.
5. **Loops and workflows (experimental).** Repair loops and durable workflow
   DAGs compose the primitives above; they do not bypass containment, gates, or
   integration authority. See [Experimental recovery surfaces](#experimental-recovery-surfaces).

## Backend readiness

The four adapters are live in the current tree, with different release status:

| Backend | Native subscription source | Current status |
| --- | --- | --- |
| Codex | Canonical `~/.codex/auth.json` | Live contained exec/session evidence |
| OpenCode | Canonical OpenCode auth plus safe default model or explicit model | Reference backend; live exec/session/write evidence |
| Claude Code | User-minted `~/.claude/.headless-setup-token` | Capsule implemented and fixture-green; this machine still needs the operator token file for live proof |
| Grok Build | `grok login --device-auth` | Experimental read-only path guarded by the new trust-canary attestation; writes remain blocked |

### Claude subscription setup-token

macOS Claude Code commonly keeps its working login in Keychain, which required
containment does not import. Mint the reviewed long-lived subscription token
and store it at Headless's exact allowlisted path:

```bash
umask 077
mkdir -p "$HOME/.claude"
claude setup-token > "$HOME/.claude/.headless-setup-token"
chmod 600 "$HOME/.claude/.headless-setup-token"
```

The token is validated, fingerprinted, and injected only into the contained
Claude native-login process after ambient environment scrubbing. It takes
exclusive precedence over `.credentials.json` and is never copied into the
worker filesystem, daemon state, logs, ledger, or results. A present invalid
file fails closed rather than falling back. See [native-login.md](./docs/native-login.md).

### Grok trust-canary

Grok may report a control-file-free project as trusted without proving its trust
gate. Headless therefore creates a worker-owned inert MCP canary and requires a
contained, network-denied `grok inspect --json` to prove the trust boundary and
every project/compatibility surface disabled before provider access. A missing
or contradictory attestation returns a structured failure; it is never bypassed.

## Broker mode alternative

Broker mode is the default. The daemon keeps the provider key and the worker
receives only an opaque, finite lease:

```bash
: "${OPENAI_API_KEY:?export OPENAI_API_KEY before broker execution}"
"$HEADLESS" exec \
  --backend opencode \
  --model openai/gpt-5 \
  --mode read-only \
  --json \
  --cwd "$PROJECT" \
  -- "Summarize the public API."
```

Broker leases enforce provider, model, route, body, duration, request, token,
concurrency, and priced-cost limits. Unknown price is never treated as zero.

## Lead and fleet orchestration

The provider host remains an externally launched, visible process. Headless
does not launch, inject into, elect, or kill it. Switching lead rotates the
credential generation and invalidates state-changing access from the old host
without deleting durable project history.

By default the MCP lead surface advertises the **lead-core** toolset (10 tools)
so a foreground lead is not buried under orchestration. Set
`HEADLESS_MCP_TOOLSET=full` to restore the complete registry (28 tools), which
includes:

- `headless_run` for one bounded servant;
- `headless_deliberate` for attributable read-only fan-out;
- `council_deliberate` for persisted proposal, execution, review, vote, and
  decision phases;
- fleet, goal, workflow, collaboration, approval-inspection, candidate, ledger,
  and observer tools over authenticated daemon routes.

Automatic routing excludes the active lead backend. The lead may inspect
approvals and candidates, but root authority retains trust, credentials,
budgets, recovery, approval resolution, and emergency integration.

Depth-one `run.delegate` admits one read-only child per eligible worker. The
child cannot delegate again. Same-provider children inherit an atomic
sub-reservation; cross-provider children use one crash-atomic linked hold over
the parent and target provider quotas. Target bearer material is minted once,
never persisted, and ambiguity exhausts authority rather than returning it.

### Understand fleet “login required”

Broker and native-login agents may both use the structured `login_required`
code, but health now reports the selected mode's true reason: broker names the
missing daemon credential variable; native-login surfaces the capsule or
setup-token remedy. Missing native project consent is separately
`trust_required`; the Fleet TUI renders that state as `Trust required`, shows
the daemon-provided acknowledgement command, and does not misdirect the
operator to a provider login flow. The exact JSON and repair commands are in
[Understand “login required”](./website/docs/troubleshooting/login-required.md).

Native workers do not consume ambient provider state. Codex receives a
worker-owned `CODEX_HOME`, and project discovery is pinned to the requested
working root so an unrelated ancestor `.git` marker cannot expose the
operator's `~/.codex/config.toml`. Grok's disposable OIDC capsule must remain
valid through the bounded turn; expired or near-expiry state is rejected before
provider launch with the exact `grok login` remedy.

## Gated writes

Write workers never edit primary directly:

1. the daemon persists a preparing lease and creates an isolated worktree;
2. one-turn coder-tool approval bounds the mutating worker turn;
3. bounded diff and secret scanning run before a candidate is accepted;
4. configured `check`/`build`/`test`/`pack` gates run in the candidate;
5. policy, budget, review, and vote requirements produce durable finality;
6. an authorized integration decision journals and advances primary.

Timeout, cancellation, conflict, secret detection, failed gates, output
overflow, and crash ambiguity all preserve primary.

## Experimental recovery surfaces

These surfaces are **experimental** (`headless experimental …`). Contracts may
change before Gate B. They compose the kernel; they do not replace
containment, budgets, or human authority over trust and integration. Concept
pages:
[repair and recovery](./website/docs/concepts/repair-and-recovery.md),
[why Headless](./website/docs/concepts/why-headless.md).

- **Repair loops.** `headless experimental loop … --repair` treats a named
  gate as the oracle: it compiles a repair graph from failing checks, runs
  serial repairs (each step sees the previous result), and re-gates until the
  project is green, a cost or deadline budget is spent, or the failure
  signature stagnates (unchanged across the configured stagnation limit). A
  succeeded repair graph is not success; only the re-run gate decides.
- **Restartable workflow DAGs.** `experimental workflow` validates and runs
  durable DAGs with dependency results, bounded retries, pause/resume/cancel,
  and restart recovery of step state.
- **Goal revision loops.** Goals can plan, produce candidates, collect review,
  and revise under bounded deliberation rounds — still subject to mode, budget,
  and write gates.
- **Idle autonomy on fleet profiles.** Profile `idleAutonomy` defaults to
  `suggest`: durable opportunity lanes only. Higher modes may verify or write
  only through the normal daemon paths. This is not continuous self-host.
- **Daemon boot reconciliation.** On startup the daemon restores linked-hold
  decisions, worktree leases and integration journals, jobs, receipts, and
  sessions in a fixed order. Ambiguous authority fails closed rather than
  guessing.

## Security boundary

Every backend is arbitrary code. Required workers receive isolated HOME/XDG,
runtime, cache, and temporary roots. Real-home credentials, sibling-provider
state, Git/SSH material, shell startup files, host agent sockets, repository
`.env` files, and project backend plugins are withheld.

The TUI authenticates only as an observer. Its log and Config views read
snapshots/events and generate root-CLI commands; they cannot submit work,
resolve approvals, integrate candidates, mutate trust or budgets, or control
provider processes.

Output, events, artifacts, and diffs are bounded and redacted. Durable reads
have explicit compatibility codecs; new writes and RPC remain strict. Ledger,
budget, broker, worktree, and linked-hold recovery fail closed on unknown or
contradictory state. Read [SECURITY.md](./SECURITY.md) before using credentials
or write mode.

## Live evidence

The current tree contains real acceptance evidence beyond unit tests:

- **Neon Breakout capstone:** a Codex lead orchestrated an OpenCode/Codex fleet
  through contained writes, meaningful gates, approvals, finality, and
  integration. The result is an 893-line, dependency-free browser game.
- **Rotating-lead tournament:** Claude, Codex, and OpenCode each led the same
  word-frequency CLI build and delegated implementation to another backend.
  Every artifact passed its primary gate; artifact-only quality scores were
  OpenCode lead 8.9, Codex lead 8.1, Claude lead 7.8.

These runs prove the exercised paths, not release publication. See the
[case-study details](./website/docs/case-studies/proven-runs.md).

### Dogfood posture

Partial dogfood only — honest about what is and is not claimed:

| Claimed / recorded | Not claimed |
| --- | --- |
| Multi-backend deliberate/council traces | Continuous self-host of this monorepo |
| Native subscription smokes on installed CLIs | Headless builds Headless unattended |
| Capstone and rotating-lead gated write paths | Full production self-host or unattended spend |
| Repair-loop fixture and agent-backed verification in the tree | Product Gate P as a runtime repair loop |

**Product Gate P** (`docs/product-gate.md`) is a **human UX oracle** for golden-path
ceremony, progressive disclosure, and help/remedy quality. It is distinct from
runtime repair loops and from security Gates A/B/C in `docs/plan.md`. A green
Product Gate does not authorize npm publication.

## Release gates

| Gate | Scope | Evidence | Published? |
| --- | --- | --- | --- |
| A | Kernel exec, daemon, trust, lead/MCP onboarding, observer TUI | Current required macOS/Linux evidence green | No |
| B | Deliberations, councils, fleets, goals, workflows, delegation | Real multi-backend council and capstone trace recorded | No |
| C | Leased write candidates and authorized integration | Capstone and rotating-lead builds recorded | No |

The [release plan](./docs/plan.md) is the canonical cumulative checklist.
Packages remain private at `0.2.0-beta.7`; no npm availability is implied.

## CLI stability boundary

Default help exposes only the Beta 1 stable commands (`STABLE_COMMAND_NAMES`):

- `exec` / `run`
- `lead use|status|release`
- `daemon serve|status|stop|reap`
- `project trust status|grant|revoke`
- `init [--lead <host>]`
- `setup`
- `status`
- `doctor` (`--json`)
- `mcp install|remove|status|serve`
- `tui`
- `verify [--evidence]`

Other commands require `headless experimental`. Their contracts may change
before the corresponding gate. Orchestration, receipts, and sessions remain
experimental. The [generated command reference](./docs/command-reference.md)
is checked against the registry.

## Verification

```bash
headless verify --cwd "$PROJECT"
headless verify --evidence --cwd "$PROJECT"

bun run check
bun run build
bun run smoke:pack

cd website
bun install --frozen-lockfile
bun run build
```

`headless verify` checks every ledger sequence, previous hash, project binding,
declared SHA/HMAC digest, and rotated key ID. `--evidence` also recomputes each
latest anchored release-evidence file digest. Either form exits non-zero on a
break or mismatch.

Do not infer release readiness from a stale count or one live run. Re-run the
applicable gate from the exact release tree and inspect every skip.

## License

MIT. See [LICENSE](./LICENSE).

© 2026 [proofofwork.agency](https://proofofwork.agency/).
