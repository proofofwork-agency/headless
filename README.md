# Headless

> **Unreleased private alpha.** The npm packages are not published, the complete release gate is not green, and Headless must not yet be used with sensitive source, valuable native credentials, or unattended spend.

Headless is a local execution boundary for heterogeneous coding CLIs. Its current focus is one reliable path: admit a bounded request, run OpenCode, Claude Code, or Codex inside a contained worker, and return a structured result with attributable usage, cost, policy, and durable event evidence.

Grok remains experimental and is blocked unless a contained `grok inspect --json` attestation proves every project and compatibility surface disabled. Grok writes remain disabled. Writes, persistent worker sessions, the OpenCode plugin, workflows, fleets, councils, autonomy, loops, and skills are later-gate product surfaces; they are experimental and are not part of the first beta stability promise. The stable observer TUI remains read-only even when it displays those experimental projections.

## Current execution boundary

```text
CLI / SDK
    ↓
authenticated project daemon
    ↓
session binding → trust → authority → pricing → budget → queue
    ↓
contained backend execution
    ↓
durable terminal result → deterministic events → ledger attribution
```

Read-only execution is the default. Required containment uses an isolated HOME/XDG tree and an OS boundary: Seatbelt on macOS or bubblewrap/seccomp on Linux. Windows is unsupported.

## Five-minute source quickstart

Headless is intentionally installable only from this checkout while it is private alpha.

```bash
bun install --frozen-lockfile --ignore-scripts
bun run build
./dist/cli.js doctor --cwd .
```

Broker authentication is the default. Supply the provider credential to the daemon environment and select a provider-qualified model:

```bash
: "${OPENAI_API_KEY:?export OPENAI_API_KEY before running broker mode}"
./dist/cli.js exec \
  --backend opencode \
  --model openai/gpt-5 \
  --json \
  --cwd . \
  "Summarize the public execution API"
```

The broker gives every run finite ceilings even when no narrower project budget exists: 8 requests, 200,000 aggregate input tokens, 32,000 aggregate output tokens, and a $5 cap when trusted pricing is available. Unknown pricing stays `null` and requires explicit per-run approval; it is never treated as zero.

Native login is a separate, explicit risk choice. It can contact arbitrary outbound IP addresses, so enable it only for a trusted disposable project after acknowledging that limitation:

```bash
./dist/cli.js project trust grant \
  --allow-native-direct-unrestricted \
  --cwd .

./dist/cli.js exec \
  --backend codex \
  --auth-mode native-login \
  --json \
  --cwd . \
  "Inspect the parser"
```

Native results report `network: "native-direct-unrestricted"`. This is truthful egress evidence, not a destination allowlist. Project trust and native consent are stored outside the checkout and may be revoked with `project trust revoke`.

## Beta 1 commands

Default help exposes only the Gate A kernel surface:

- `exec` / `run` — one bounded execution.
- `lead use|status|release` — bind the externally launched foreground host.
- `doctor` / `status` — runtime/backend inventory and durable daemon state.
- `project trust status|grant|revoke` — project and native-egress consent.
- `daemon serve|status` — project-daemon lifecycle.
- `init [--lead <host>]` — initialize external state and optionally configure a foreground lead without editing the checkout.
- `mcp install|remove|status|serve` — manage the compiled foreground-lead MCP server.
- `tui` — open the read-only durable log and configuration pane.

Commands outside that surface require the explicit `headless experimental` namespace. List them with `headless experimental --help`; their contracts may change before their own release gate. The [generated command reference](./docs/command-reference.md) is checked against the command registry. Internal audit fixtures are intentionally hidden from help and are not operator commands.

Release staging is cumulative: Gate A publishes the contained execution kernel and lead onboarding, Gate B publishes orchestration, and Gate C publishes gated writes. The checklist in [docs/plan.md](./docs/plan.md) is an acceptance plan, not a claim that any gate is already green.

## Backend status

| Backend | Beta 1 status | Compatibility floor | Required preflight |
| --- | --- | --- | --- |
| OpenCode | Reference backend | `1.15.3` | Exact version/capability probe; broker or explicitly consented native auth |
| Claude Code | Advertised target | `2.1.206` | Same supervisor, contained capability probe, and bounded auth evidence |
| Codex | Advertised target | `0.144.1` | Same supervisor plus project plugin/hook/skill/MCP denies |
| Grok Build | Not advertised; experimental | `0.2.99` | Contained `inspect --json` attestation with all native and Cursor/Claude/Codex compatibility cells disabled |

These are minimum compatibility floors encoded in the backend definitions, not proof that a release has passed installed-native smoke. The release matrix remains blocked until exact installed versions pass on macOS and Linux.

An unavailable or incompatible backend fails before provider access. Session-backed requests derive backend, model, agent, containment, authentication, and approval policy from the persisted session; any conflict is rejected before authorization, pricing, budget reservation, or job creation.

## Security modes

| Property | Broker (default) | Native login (explicit opt-in) |
| --- | --- | --- |
| Credential visible to worker | Opaque short-lived lease | Bounded backend auth capsule |
| Network evidence | `broker-only` | `native-direct-unrestricted` |
| Arbitrary destination access | Denied | Possible; explicitly acknowledged |
| Request/token limits | Finite run defaults plus project budgets | Backend CLI behavior plus project budgets |
| Cost | $5 default ceiling when priced; explicit approval when unpriced | Unknown unless the backend reports a real charge |
| Project trust | Normal daemon authority | Trust plus unrestricted-egress acknowledgement |

Every backend is treated as arbitrary code. Output and events are bounded and redacted. Broker leases are run-scoped and enforce aggregate request/input/output quotas across concurrent requests. A terminal job/result is persisted before completion events; startup reconciliation repairs missing deterministic terminal events without rerunning the backend.

Required workers may receive a run-scoped cooperation helper. On Linux its loopback-to-Unix round-trip probe is diagnostic only: a transient cooperation failure does not weaken containment or deny an otherwise valid run. Helper calls still fail loudly and remain bounded. `HEADLESS_RUN_TOOL_TIMEOUT_MS` sets the daemon/helper call window before daemon startup; it defaults to 5,000 ms and is clamped to 1,000–60,000 ms.

Depth-zero read-only workers may use the experimental `run.delegate` helper operation to request one contained sibling job. V1 is deliberately narrow: the child must use a different backend on the same provider, broker authentication (or a credential-free backend), required containment, and read-only mode. Admission is immediate rather than queued, excludes the foreground-lead backend, inherits the parent deadline and approval policy (`bypass` becomes `auto`), and atomically carves 25% of the parent reservation by default with a hard 50% cap. A delegated child cannot delegate again; its failure is returned as structured tool data and does not terminate the parent.

Headless owns its ledger and communication state. It does not read, import, or depend on a ContextRelay runtime.

## Writes and experimental orchestration

Write mode is not part of the read-only beta gate. Its intended invariant is that ambiguity never mutates the primary checkout: a clean primary is required, work occurs in a leased worktree, bounded secret/diff checks and configured gates run, and only an authorized integration decision may advance primary.

The daemon already contains experimental worker sessions, plugin integrations, fleets, goals, workflows, councils, autonomy, loops, and skills for the later gates. The stable TUI is observer-only: it reads snapshots/events, displays durable logs and configuration state, and generates root-CLI commands; it cannot dispatch work, resolve approvals, integrate candidates, mutate policy, or control provider processes.

```bash
./dist/cli.js tui --cwd .
```

The Config view shows project trust, foreground lead binding, budgets, backend readiness, and daemon state. Its commands are copy-paste guidance labeled “run from your shell”; the TUI never executes them and never holds root authority.

One durable foreground lead may be configured per project:

```bash
./dist/cli.js init --lead codex --cwd .
```

This one-shot path initializes external state, installs the host's global or project-associated MCP registration, then binds the foreground lead. It does not grant project trust or native egress. The equivalent explicit sequence is `./dist/cli.js init --cwd .`, `./dist/cli.js mcp install codex --cwd .`, then `./dist/cli.js lead use codex --cwd .`.

The provider host remains an externally launched, visible process. Its MCP or plugin attaches and heartbeats; Headless never launches, injects into, elects, or kills the foreground lead. Explicit switching rotates the credential generation and invalidates state-changing access from the previous host without deleting jobs, sessions, messages, artifacts, or ledger history. Automatic worker routing avoids the active lead backend; an explicit backend or synthesizer selection may still create a separate headless worker using that provider.

Human CLI integration is the default. Lead tools may inspect approvals and candidates but cannot resolve or directly integrate them. Daemon-managed goal integration may proceed only when a finite authority grant matches the project, principal, backend, operation, cost, expiry, and iteration bounds. The root CLI retains credential, trust, budget, recovery, and emergency integration authority.

## State and public API

State lives outside the repository, keyed by `sha256(canonical project root)`:

- macOS: `~/Library/Application Support/Headless/projects/<project-id>`
- Linux: `${XDG_STATE_HOME:-~/.local/state}/headless/projects/<project-id>`
- Tests: set `HEADLESS_STATE_HOME` and `HEADLESS_RUNTIME_HOME` to disposable directories.

Durable reads have an explicit compatibility boundary. State written before the network-evidence rename may contain exactly `provider-direct`; Headless verifies protected archive bytes and hashes before decoding that value as the canonical in-memory `native-direct-unrestricted`. New writes and RPC remain strict, unknown values fail closed, and compatibility reads do not rewrite historical archive bytes.

The root library surface contains `exec`, the `RunRequest`/`RunResult`/`RunEvent` types, backend identifiers/metadata, and structured errors. The authenticated daemon client remains available through `./daemon`. Runtime schemas, MCP, provider relay code, and orchestration internals live under `./experimental` subpaths.

SDK execution streams durable events as they arrive:

```ts
import { exec } from "@proofofwork-agency/headless";

const result = await exec({
  backend: "opencode",
  model: "openai/gpt-5",
  prompt: "Inspect the request schema",
  onEvent(event) {
    console.error(event.kind, event.sequence);
  },
  onStdoutChunk(chunk) {
    process.stdout.write(chunk);
  },
});
```

The package name in this example is reserved for the future beta; it does not currently resolve from npm.

## Verification and release gate

Local verification:

```bash
bun run check
bun run build
bun run smoke:pack
```

Do not infer release readiness from a stale test count. Gate A requires zero failures/errors on macOS and Linux, clean-clone build and tarball installation, protected broker smoke for OpenAI/Anthropic/Gemini/xAI, installed native-login smoke for each advertised backend/version, and operational GitHub Actions jobs. Gates B and C add their recorded orchestration and per-backend write evidence. Publication remains blocked until the applicable gate is complete and the packages resolve through `npm view` after an authorized release.

See [native authentication](./docs/native-login.md), [foreground-lead MCP integration](./docs/mcp-integration.md), [security limits](./SECURITY.md), the [current plan](./docs/plan.md), and the [Docusaurus site sources](./website/README.md).

## License

MIT. See [LICENSE](./LICENSE).
