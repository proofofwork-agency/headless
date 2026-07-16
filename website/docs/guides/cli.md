---
id: cli
title: Execution commands
sidebar_position: 1
---

# Execution commands

A task-oriented cookbook for driving Headless from the shell. Every command
below exists in the current tree; each block states the expected outcome so you
can verify it immediately.

Conventions used throughout:

- Examples assume the compiled `headless` binary is on `PATH`. From a source
  checkout, run `bun run build` and use `./dist/cli.js` in its place.
- Every command accepts `--cwd dir` to target a project other than the current
  directory.
- Commands outside the Beta 1 kernel require the explicit
  `headless experimental` namespace and carry **no stability promise**. The
  Beta 1 commands are exactly: `exec`/`run`, `lead`, `daemon`, `project`,
  `init`, `status`, `doctor`, `mcp`, `tui`, and `verify`. Everything else in
  this guide is invoked as `headless experimental <command>` and is marked as
  such.
- A prompt that begins with `-` belongs after a literal `--` separator.

This cookbook does not duplicate the full flag tables. The complete command
reference is generated from `src/cli/command-specs.ts`, checked by
`bun run check:docs`, and published as
[docs/command-reference.md](https://github.com/proofofwork-agency/headless/blob/main/docs/command-reference.md)
in the repository — consult it for the authoritative surface, and
`headless --help` / `headless experimental --help` for your build.

## One-shot runs

The `exec` command (alias: `run`) submits one bounded, contained job through
the project daemon and waits for its result.

```bash
headless exec --backend codex "Summarize the public entry points of this repo."
```

Expected: the model's text output on stdout, a `cost / tokens / time` footer on
stderr when known, and exit code 0 on success (1 otherwise). If `--backend` is
omitted, `opencode` is the default. Read-only mode, broker authentication, and
required OS containment (Seatbelt on macOS, bubblewrap/seccomp on Linux) are
the defaults.

### Structured JSON result

```bash
headless exec --backend codex --json "Summarize the public entry points."
```

Expected: one complete JSON document — the full `RunResult` with `status`,
`output`, `usage`, `cost`, `containment` (including `unsafe` and `network`),
`durationMs`, `jobId`, and a structured `error` when the run did not succeed.
The `jobId` is the run id you pass to `experimental receipt` later.

### Streaming raw output

```bash
headless exec --backend codex --stream "Generate a haiku about ledgers."
```

Expected: the output text is written directly to stdout without a trailing
newline (suitable for piping); cost/usage still land on stderr.

### Write mode

```bash
headless exec --backend opencode --mode write \
  "Add a --version flag to the CLI entry point."
```

Expected: the worker mutates a **leased, isolated worktree**, never your
checkout. The result carries a bounded diff and a candidate commit; your
primary branch only advances after an explicit
`headless experimental candidate integrate` decision (see the
[write-mode scenario](./test-scenarios.md#4-write-mode-candidate-flow-on-a-toy-repo)).

### Containment flags

```bash
headless exec --backend codex --require-sandbox "Inspect only."
```

Expected: identical to the default — containment is already required. The flag
makes the requirement explicit and fails the run if the platform sandbox is
unavailable.

```bash
headless exec --backend codex --unsafe-no-sandbox "Inspect only."
```

Expected: the run executes **without** OS containment and the CLI prints
`WARNING: result was produced without required OS containment.` on stderr. The
result and its receipt permanently record `containment.unsafe: true`. This is
the only local bypass; autonomy, councils, and workflows reject it outright.
Passing both flags together is an immediate usage error:
`Choose either --require-sandbox or --unsafe-no-sandbox, not both.`

### Timeout, model, and session correlation

```bash
headless exec --backend opencode \
  --model openai/gpt-5 \
  --timeout-ms 60000 \
  --session-id review-pass-1 \
  --json -- "Inspect the request schema."
```

Expected: the run is killed and reported `timed_out` if it exceeds
`--timeout-ms` (default 180000 ms, maximum 86400000 ms); `--model` selects the
provider model; `--session-id` tags the job so `headless status --session-id`
and `headless experimental events --session-id` can filter to it.

### Native-login runs

Broker mode is the default. Native subscription login requires an explicit,
revocable project consent first:

```bash
headless project trust grant --allow-native-direct-unrestricted
headless exec --backend codex --auth-mode native-login --json -- "Inspect only."
```

Expected: the run uses the official CLI's existing login; the result truthfully
reports `network: "native-direct-unrestricted"`. Revoke with
`headless project trust revoke`.

## Daemon and project health

```bash
headless daemon serve
```

Expected: a foreground daemon that prints
`Headless daemon ready for <project root>` on stderr and keeps running until
signalled (SIGTERM exits 143). Most commands start a daemon on demand, so
`serve` is mainly for dedicated terminals and debugging.

```bash
headless daemon status
```

Expected: the daemon's `ping` response as JSON (project id, root, principal,
runtime info). A daemon is started if absent.

```bash
headless daemon stop
```

Expected: `{ "stopped": true, "pid": <n> }` after a graceful shutdown. When no
daemon is running the command exits 1 with
`No Headless daemon is running for <root>.` — `stop` never autostarts one.

```bash
headless status
```

Expected: one JSON document combining the daemon ping, ledger task state, a
recent event snapshot, and orchestrator status.

```bash
headless doctor
```

Expected: a human-readable self-check — Bun runtime version, project root and
id, authenticated principal, external state directory, whether each of
`opencode`, `codex`, `claude`, and `grok` is on `PATH`, durable job and event
counts, and a reminder that containment defaults to required.

## Verify the ledger and receipts

### Ledger verification (Beta 1)

```bash
headless verify
```

Expected: `✓ intact: <n> records, head <seq>/<hash>, <algorithm>` and exit 0
when the complete sequence/hash/project/HMAC chain holds. On a break it prints
`✗ BREAK at seq <n>: <reason>` to stderr and exits 1.

```bash
headless verify --evidence --json
```

Expected: the structured verdict as JSON — `ok`, `recordsChecked`, `head`, and
on failure a `firstBreakAt: { sequence, reason }` object that pinpoints the
first broken record. `--evidence` additionally re-hashes each release-evidence
file named by the latest authenticated ledger anchor and reports
`matched / mismatched / missing / malformed` counts. Either form exits non-zero
on any break or mismatch, which makes it safe for CI.

### Receipts (experimental)

Every completed run has a portable execution receipt anchored to the ledger.
All receipt subcommands accept `--json` and `--cwd`.

```bash
headless experimental receipt list
headless experimental receipt show <runId>
```

Expected: `list` prints one summary line per owned receipt
(`<runId> <status> <backend>/<mode> seq <n> <endedAt>`, or `(no receipts)`).
`show` prints the receipt card: run status, principal, backend/mode/model,
authority source, containment evidence (with a visible `UNSAFE` marker when
applicable), cost and token usage, broker lease, gates, the ledger anchor
sequence/hash, and the receipt's self-digest.

```bash
headless experimental receipt verify <runId>
```

Expected: `✓ VERIFIED <runId> (full-chain)` and exit 0 — the daemon re-verifies
the live ledger chain, the anchor, and the receipt self-digest. On failure it
prints `✗ FAILED <runId>: <reason>` (plus the first ledger break or the failing
digest section) and exits 1.

```bash
headless experimental receipt export <runId> --out export.json
headless experimental receipt verify --file export.json
headless experimental receipt verify --file export.json --ledger ledger.jsonl
```

Expected: `export` writes a portable, self-contained JSON receipt (mode 0600)
and confirms `Wrote portable receipt for <runId> to export.json` on stderr.
Offline `verify --file` needs **no daemon** and reports one of three assurance
levels:

| Assurance | Meaning |
| --- | --- |
| `full-chain` | The export was re-verified against a supplied `--ledger` file: chain, anchor record, and head all match. The strongest verdict. |
| `embedded-record` | Offline only. The receipt self-digest and its embedded SHA-256 anchor record verify, but the surrounding chain was not checked. Run with `--ledger` for full-chain proof. |
| `structural-only` | The embedded anchor is an HMAC record. It is structurally consistent, but authenticity requires the live ledger and its verification key. |

Any tampering — in the receipt body, the anchor, or the export envelope —
fails closed: `✗ FAILED <runId>: <reason>` and exit 1.

```bash
headless experimental receipt diff <runIdA> <runIdB>
```

Expected: `= <a> and <b> match on the compared fields`, or one
`~ field: a -> b` line per difference across backend, mode, model, status,
authority source, cost, token totals, containment mechanism/network/unsafe,
gate count, exit code, and the prompt/output digests.

## Orchestration (experimental)

Everything in this section is invoked under `headless experimental` and may
change before its release gate.

### Goals

```bash
headless experimental goal start --detach -- "Analyze the fixture and report risks."
```

Expected: JSON containing the durable goal id. `start` always detaches; the
goal keeps running in the daemon.

```bash
headless experimental goal follow --goal-id <goalId>
headless experimental goal result --goal-id <goalId>
```

Expected: `follow` polls the durable goal, streams agent turns to stderr as
`[goal <id>] <agent> <state>: <output>`, and on a terminal state prints the
final `{ goal, result }` JSON — exit 0 only when the goal succeeded. If the
follow window (`--timeout-ms`, default 3600000 ms) elapses, the CLI reports
that the goal remains durable and can be followed again. `result` fetches the
persisted outcome of a finished goal at any time. `goal list`, `goal status`,
`goal send`, and `goal cancel` round out the lifecycle.

### Councils

```bash
headless experimental council \
  --agent codex --agent opencode \
  --timeout-ms 300000 \
  -- "Should the parser move to a streaming design?"
```

Expected: a persisted council record as JSON covering proposal, execution,
review, vote, and decision phases; exit 0 only when the council decision is
approved. Councils prohibit `--unsafe-no-sandbox`.

### Workflows

A workflow is a validated, restartable DAG: each step retains its
dependencies, backend selection, bounded retries, approval policy, terminal
state, and actual result evidence.

```bash
headless experimental workflow validate --file workflow.json
headless experimental workflow run --file workflow.json
```

Expected: `validate` checks the JSON definition without executing anything.
`run` submits the workflow and prints its durable state; use
`workflow status|wait|pause|resume|cancel --workflow-id <id>` afterwards
(`wait` exits 0 only on `succeeded`). Workflows also prohibit
`--unsafe-no-sandbox`.

### Gates

```bash
headless experimental gate --check build --check test --timeout-ms 300000
```

Expected: `Running daemon-owned release gate checks...` followed by a JSON
report of each configured `check|build|test|pack` gate; exit 0 only when every
requested gate passed.

### Budgets

```bash
headless experimental budget upsert \
  --id project-default \
  --max-requests 20 \
  --max-input-tokens 50000 \
  --max-output-tokens 10000 \
  --max-cost-usd 10 \
  --max-concurrency 2 \
  --max-retries 1 \
  --expires-at 4102444800000

headless experimental budget list
```

Expected: the upserted budget echoed as JSON, then listed with its live usage
counters. Budgets can also be scoped with `--principal`, `--session-id`,
`--workflow-id`, or `--provider`. Budget administration is root-CLI-only: the
foreground lead and the TUI can inspect budgets but cannot change them. A run
that would exceed a budget is admitted as `blocked` with a structured
`BUDGET_EXCEEDED` error — and unknown cost is never treated as zero.

### Events and logs

```bash
headless experimental events --limit 50
headless experimental logs --errors --follow
```

Expected: redacted, bounded run events as JSON lines (`logs` is an alias).
`--follow` prints `Following daemon events (Ctrl-C to stop)...` and then polls
for new events. `--display-mode compact|verbose|strict` controls grouping
versus complete streams versus strict attributable identity; `--errors` and
`--activity` are mutually exclusive channel filters; `--pretty` pretty-prints
each event.

## Foreground leads

The lead is an externally launched provider CLI that attaches to the project
daemon over MCP. Headless never launches or kills it.

```bash
headless init --lead codex
```

Expected: external per-project state is created (the checkout and `.gitignore`
are not modified), the Codex MCP registration is installed, and the lead is
bound — confirmed by
`Configured codex as the foreground lead. Project trust and native egress remain unchanged.`
Valid hosts: `codex`, `grok`, `claude`, `opencode`.

```bash
headless lead status
headless lead use opencode
headless lead release
```

Expected: JSON responses. `use` rotates a generation-bound credential —
switching hosts invalidates the previous generation without deleting project
work. `release` removes the binding without cancelling jobs. A host that stops
heartbeating shows as `disconnected`; Headless never elects a replacement.

## Fleet

```bash
headless experimental fleet health
headless experimental fleet health --profile-id native-subscriptions
```

Expected: per-agent readiness JSON (ready, login required, blocked) with
mode-specific recovery guidance. Broker agents name the missing daemon-held
credential variable; native-login agents surface the real capsule/login
reason; missing native consent is `trust_required`. See
[Understand “login required”](../troubleshooting/login-required.md).

```bash
headless experimental fleet profile upsert --file fleet.json --activate
headless experimental fleet profile list
```

Expected: the stored profile echoed as JSON, then listed together with the
active profile id. `--file` creates or replaces a profile; without `--file`,
`--auth-mode` / `--approval-policy` patch the active profile (top level and
every agent). `fleet profile get|remove --profile-id <id>` complete the set.
