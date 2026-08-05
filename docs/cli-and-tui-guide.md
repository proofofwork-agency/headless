---
sidebar_position: 2
title: CLI-first operations and the observer TUI
description: Configure one foreground lead, run contained workers, and observe durable state.
---

# CLI-first operations and the observer TUI

> Unpublished private beta (`0.2.0-beta.7`). Use disposable projects and bounded spend until the release gates pass.

Examples assume the compiled `headless` binary is on `PATH`. From this checkout, run `bun run build` and use `./dist/cli.js` in its place.

## Golden path

One path from cold start to a verified contained run. Sign in to at least one coder CLI first, then:

```bash
PROJECT="/absolute/path/to/a/disposable/project"

# 1) Wizard: init external state, inventory CLIs, print next commands
headless setup --cwd "$PROJECT"

# 2) Native login needs unrestricted-egress acknowledgement
headless project trust grant \
  --allow-native-direct-unrestricted \
  --cwd "$PROJECT"

# 3) Read-only native profile (required containment)
headless exec \
  --backend codex \
  --auth-mode native-login \
  --profile read-only-native \
  --cwd "$PROJECT" \
  -- "Inspect the public entry points."

# 4) Verify the ledger (exec also prints receipt/verify hints)
headless verify --cwd "$PROJECT"

# Readiness panel (human or --json for scripts)
headless doctor --cwd "$PROJECT"
headless doctor --json --cwd "$PROJECT"
```

Noninteractive grant+setup: `headless setup --yes --allow-native-direct-unrestricted --cwd "$PROJECT"`.

**Profiles:** `read-only-native` | `broker-readonly` collapse auth/mode/containment flags without weakening required containment. CLI and daemon run contracts default to **broker**; native login is explicit.

Optional lead binding: `setup --lead codex` (or `init --lead …`). Lead install does not grant trust, write authority, or approval bypass. Advanced orchestration (`fleet`, `goal`, `council`, sessions, receipts) lives under `headless experimental`.

## Operating model

```text
externally launched provider CLI (foreground lead)
                    │ attach + heartbeat
                    ▼
       authenticated Headless project daemon
          ├─ contained workers and sessions
          ├─ goals, workflows, councils, loops
          ├─ approvals, candidates, budgets
          └─ verified ledger and communication
                    │ read-only projection
                    ▼
                 observer TUI
```

There is exactly one configured foreground lead per project and no automatic election. A goal’s sticky synthesizer is only a worker role; health failover never changes foreground authority. Headless never launches or controls the provider CLI used as the lead.

The CLI is the complete control surface. The TUI is observation only. It has no prompt, command palette, provider login, run dispatch, goal/workflow activation, approval resolution, candidate integration, policy mutation, or provider cancellation.

## Isolate a development fixture

```bash
PROJECT="$(mktemp -d)"
STATE="$(mktemp -d)"
RUNTIME="$(mktemp -d /tmp/headless-runtime.XXXXXX)"

export HEADLESS_STATE_HOME="$STATE"
export HEADLESS_RUNTIME_HOME="$RUNTIME"

git -C "$PROJECT" init
headless setup --cwd "$PROJECT"
headless doctor --cwd "$PROJECT"
headless doctor --json --cwd "$PROJECT"
```

External state is keyed by the canonical project path. `setup` / `init` must not edit the checkout or `.gitignore`. Doctor readiness covers trust, backend PATH and native capsule presence (no secret reads), broker environment flags, and copy-paste next actions.

## Verify the ledger and recorded evidence

```bash
headless verify --cwd "$PROJECT"
headless verify --evidence --json --cwd "$PROJECT"
# Experimental receipts (outside the Beta 1 stability promise):
headless experimental receipt show <runId> --cwd "$PROJECT"
headless experimental receipt verify <runId> --cwd "$PROJECT"
```

The fast form verifies the complete sequence/hash/project/HMAC chain. The
evidence form also hashes each release-evidence file named by its latest
authenticated ledger anchor. Both exit non-zero on failure; `--json` emits the
structured first break or evidence mismatch for auditors and automation.
Receipt inspect/verify subcommands remain under `headless experimental`.

## Configure and attach the foreground lead

The recommended path uses the setup wizard or binds a lead after init:

```bash
headless setup --lead codex --cwd "$PROJECT"
# or: headless init --lead codex --cwd "$PROJECT"
headless lead status --cwd "$PROJECT"
```

The equivalent explicit sequence is:

```bash
headless init --cwd "$PROJECT"
headless mcp install codex --cwd "$PROJECT"
headless lead use codex --cwd "$PROJECT"
```

For OpenCode, use `opencode`; the installer updates its global MCP configuration outside the checkout. Claude and Grok use their native MCP installers. All four hosts use the same generation-bound lead contract. Automated install does not inject `HEADLESS_PROJECT_ROOT` into host configs when you wire MCP manually.

`lead use` rotates a generation-specific credential. Switching hosts explicitly invalidates the previous generation but preserves all project work. `lead release` removes the binding without cancelling jobs or deleting state. A host that stops heartbeating becomes `disconnected`; Headless does not elect or launch a replacement.

## Run contained workers

CLI and daemon defaults are broker authentication, read-only mode, and required containment:

```bash
headless exec --cwd "$PROJECT" \
  --backend opencode \
  --model openai/gpt-5 \
  --profile broker-readonly \
  --timeout-ms 60000 \
  --json -- "Inspect the request schema."
```

A prompt beginning with `-` belongs after `--`. Required containment uses Seatbelt on macOS and bubblewrap/seccomp on Linux.

Native login requires project trust and an explicit acknowledgement that native provider egress is unrestricted. Prefer the profile preset:

```bash
headless project trust grant --allow-native-direct-unrestricted --cwd "$PROJECT"
headless exec --cwd "$PROJECT" \
  --backend codex \
  --auth-mode native-login \
  --profile read-only-native \
  --json -- "Inspect only."
```

Provider login is always performed in the provider’s own externally launched CLI. Headless does not capture credentials or start an interactive login process.

The run-scoped cooperation helper defaults to a 5,000 ms call window. On a slow CI host, set `HEADLESS_RUN_TOOL_TIMEOUT_MS` in the daemon environment before it starts; values are clamped to 1,000–60,000 ms:

```bash
export HEADLESS_RUN_TOOL_TIMEOUT_MS=15000
headless doctor --cwd "$PROJECT"
```

The Linux relay round-trip probe is diagnostic and gates only its dedicated cooperation test. It does not deny unrelated contained runs; a real helper transport failure is reported by that helper call.

### Depth-one worker delegation

An eligible contained worker receives `run.delegate` in its run-scoped helper operation list. This is a worker-to-daemon operation, not a root CLI subcommand. It asks the daemon to create one independent sibling job and returns either the child's bounded `RunResult` or a structured denial/failure; the parent keeps running.

V1 requires both jobs to be read-only and required-contained. The parent must be broker-authenticated, depth zero, and eligible; the child must use broker authentication (or a credential-free backend), avoid the active foreground-lead backend, and fit an immediately available worker and budget-concurrency slot. Native-login delegation is denied. A delegated child never receives `run.delegate`.

**Same-provider** children (different backend, same provider) use an atomic parent **sub-reservation**. **Cross-provider** children require different providers and backends plus a strict `broker-api-key` target, then use one **crash-atomic linked hold** over the parent and target provider quotas; the target bearer is minted once and never persisted. Both paths are implemented in production.

The request may choose a positive `budgetFraction` up to `0.5`; omission uses `0.25`. Headless carves the child slice from the parent's remaining request, token, cost, artifact, retry, and time reservation instead of granting new project spend authority. The child deadline cannot exceed the parent's remaining deadline. Approval composes monotonically: `ask` stays `ask`, `auto` stays `auto`, and `bypass` becomes `auto`. An approval requirement creates no waiting child.

## Durable work and communication

Advanced commands live under `headless experimental`:

```bash
headless experimental fleet profile list --cwd "$PROJECT"
headless experimental fleet health --cwd "$PROJECT"
headless experimental goal start --cwd "$PROJECT" --detach -- "Analyze the fixture."
headless experimental goal list --cwd "$PROJECT"
headless experimental approval list --cwd "$PROJECT"
headless experimental budget list --cwd "$PROJECT"
```

To inspect a candidate ID returned by a goal or council:

```bash
: "${CANDIDATE_ID:?set CANDIDATE_ID from the durable goal or council result}"
headless experimental candidate inspect --cwd "$PROJECT" --candidate-id "$CANDIDATE_ID"
```

Create or replace a project-wide budget with an explicit future expiry:

```bash
headless experimental budget upsert \
  --id project-default \
  --max-requests 20 \
  --max-input-tokens 50000 \
  --max-output-tokens 10000 \
  --max-cost-usd 10 \
  --max-concurrency 2 \
  --max-retries 1 \
  --expires-at 4102444800000 \
  --cwd "$PROJECT"
```

Budget administration remains a root-only experimental CLI operation. The foreground lead and observer TUI can inspect budget state but cannot change it.

Automatic worker selection avoids the active lead backend. To intentionally create a separate worker using the same provider, name that backend or per-goal synthesizer explicitly.

Directed messages, queues, task claims, handoffs, artifacts, votes, and finality remain in Headless’s existing stores and verified ledger. Headless does not ingest or replay ContextRelay runtime state.

## Integration authority

Candidate integration is human-controlled by default:

```bash
: "${CANDIDATE_ID:?set CANDIDATE_ID from candidate inspect output}"
headless experimental candidate integrate --cwd "$PROJECT" --candidate-id "$CANDIDATE_ID"
```

The lead-facing MCP/plugin surface can list approvals and inspect candidates but cannot resolve or integrate them. Daemon-managed goal integration may proceed only while every project, principal, backend, operation, cost, expiry, and iteration grant bound matches. Root CLI recovery remains available and attributable.

## Observer TUI

```bash
headless tui --cwd "$PROJECT"
```

The TUI may start the Headless daemon if it is absent. It cannot start providers or jobs. It authenticates with a dedicated observer credential and reads only `observer.snapshot` and `observer.events`; the daemon rejects every mutation attempted with that credential.

Navigation:

- `Tab` / `Shift-Tab`, number keys, arrows, and mouse select views and rows.
- Event filters, grouping, compact/verbose/strict presentation, redaction, layout, and reconnect behavior remain local presentation features.
- `?` shows observer guidance; `q` or Ctrl-C exits the client without stopping detached work.

The Config view renders project trust, lead binding, budgets, backend readiness, and daemon state from the same observer snapshot. It labels exact root-CLI commands as “run from your shell”; the TUI never runs them. Approvals and candidates likewise display CLI guidance, and provider health may display the provider’s login command without launching it.

## Migration behavior

On first daemon ownership after the historical control-layer break, Headless:

- archives Core/operator/proposal metadata without executing pending proposals;
- preserves the underlying worker sessions that were referenced by Core metadata;
- migrates goal `leaderAgentId` to `synthesizerAgentId`;
- removes fleet coordinator-selection fields;
- revokes shared generic integration credentials;
- decodes the known persisted `provider-direct` RunResult value as `native-direct-unrestricted` at durable read boundaries while keeping new writes/RPC strict;
- verifies protected archive bytes and hashes before that in-memory normalization and never rewrites those historical bytes;
- leaves ledger bytes, worktrees, jobs, tasks, artifacts, messages, approvals, candidates, grants, budgets, identifiers, and provenance intact;
- intentionally leaves any external ContextRelay state untouched.

The control-layer migration manifest records that the verified ledger was not modified.

## Verification

```bash
bun run check
bun run build
bun run smoke:pack
```

Installed-provider smoke is opt-in. OpenCode and Grok release status must not be upgraded without real installed CLI evidence. Grok remains read-only under required containment.

The staged release checklist is cumulative: Gate A covers the kernel and lead onboarding, Gate B orchestration, and Gate C writes. See [plan.md](./plan.md); the checklist is not a completion claim.

## Further reading (website)

Operator-facing expansions live under `website/docs/` (Docusaurus):

- **Building apps** — `website/docs/guides/building-apps.md` (patterns for integrating Headless as a runner)
- **Repair and recovery** — `website/docs/concepts/repair-and-recovery.md` (runtime repair loops vs Product Gate P human UX loops; see also [product-gate.md](./product-gate.md) dogfood posture)

These pages document private-beta surfaces; they do not claim continuous self-host or published packages.
