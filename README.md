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
[architecture and data flow](./website/docs/concepts/architecture.md),
[the four policy axes](./website/docs/concepts/modes.md),
[operating-system containment](./website/docs/concepts/containment.md),
[the safety model](./website/docs/concepts/safety-model.md),
[persistent sessions](./website/docs/concepts/sessions.md),
[portable skills](./website/docs/concepts/skills.md),
[execution receipts](./website/docs/concepts/receipts.md),
[leads and the fleet](./website/docs/concepts/leads-and-fleet.md),
the per-coder guides for
[Claude](./website/docs/ai-coders/claude.md),
[Codex](./website/docs/ai-coders/codex.md),
[OpenCode](./website/docs/ai-coders/opencode.md), and
[Grok](./website/docs/ai-coders/grok.md), and the
[recorded case studies](./website/docs/case-studies/proven-runs.md).

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
- Leased write worktrees with secret scanning, project gates, finality, and
  authorized integration instead of direct primary-checkout mutation.

## Five-minute native-login quickstart

Native login is the primary real-run path. It uses each official CLI's existing
subscription login and does not require a separate provider API key.

```bash
bun install --frozen-lockfile --ignore-scripts
bun run build

HEADLESS="$PWD/dist/cli.js"
PROJECT="/absolute/path/to/a/disposable/project"

"$HEADLESS" init --lead codex --cwd "$PROJECT"
"$HEADLESS" project trust grant \
  --allow-native-direct-unrestricted \
  --cwd "$PROJECT"

"$HEADLESS" exec \
  --backend opencode \
  --auth-mode native-login \
  --mode read-only \
  --timeout-ms 120000 \
  --json \
  --cwd "$PROJECT" \
  -- "Inspect the public entry points."
```

Use `claude`, `opencode`, or `grok` instead of `codex` in `init --lead`.
Initialization creates external state, installs the host's MCP registration,
and binds the lead. It does **not** grant project trust, native egress, write
authority, or approval bypass.

Native results report `network: "native-direct-unrestricted"`. This is truthful
egress evidence, not a provider destination allowlist. Revoke consent with:

```bash
"$HEADLESS" project trust revoke --cwd "$PROJECT"
```

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

The MCP lead surface includes:

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
`trust_required`. The exact JSON and repair commands are in
[Understand “login required”](./website/docs/troubleshooting/login-required.md).

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

## Release gates

| Gate | Scope | Evidence | Published? |
| --- | --- | --- | --- |
| A | Kernel exec, daemon, trust, lead/MCP onboarding, observer TUI | Current required macOS/Linux evidence green | No |
| B | Deliberations, councils, fleets, goals, workflows, delegation | Real multi-backend council and capstone trace recorded | No |
| C | Leased write candidates and authorized integration | Capstone and rotating-lead builds recorded | No |

The [release plan](./docs/plan.md) is the canonical cumulative checklist.
Packages remain private at `0.2.0-beta.3`; no npm availability is implied.

## CLI stability boundary

Default help exposes only the Beta 1 kernel commands:

- `exec` / `run`
- `lead use|status|release`
- `doctor` / `status`
- `project trust status|grant|revoke`
- `daemon serve|status`
- `init [--lead <host>]`
- `mcp install|remove|status|serve`
- `tui`
- `verify [--evidence]`

Other commands require `headless experimental`. Their contracts may change
before the corresponding gate. The [generated command reference](./docs/command-reference.md)
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
