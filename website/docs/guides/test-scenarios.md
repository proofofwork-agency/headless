---
id: test-scenarios
title: "Test scenarios & example cases"
sidebar_position: 3
---

# Test scenarios and example cases

Eight worked scenarios an evaluator can run end-to-end. Each states its goal,
the exact commands, what success looks like, and what failure looks like.
Every command and output claim below is grounded in the current tree.

## Setup (once)

Build from source and isolate a disposable fixture so nothing touches your
real projects or state. Prefer `setup` (inventories CLIs, recommends a
backend, and prints the next commands) over bare `init`:

```bash
bun install --frozen-lockfile --ignore-scripts
bun run build
HEADLESS="$PWD/dist/cli.js"

PROJECT="$(mktemp -d)"
export HEADLESS_STATE_HOME="$(mktemp -d)"
export HEADLESS_RUNTIME_HOME="$(mktemp -d /tmp/headless-runtime.XXXXXX)"

git -C "$PROJECT" init
"$HEADLESS" setup --cwd "$PROJECT"
"$HEADLESS" doctor --json --cwd "$PROJECT"
```

`setup` creates external per-project state (the checkout and `.gitignore` are
not modified), inventories supported CLIs, and recommends a backend.
`doctor --json` reports structured readiness (trust, native consent, PATH
inventory). Equivalent to `init` alone when you only need empty project state.

The scenarios use the native-login path (no separate API key), which requires
one explicit consent (or fold it into setup with
`--yes --allow-native-direct-unrestricted`):

```bash
"$HEADLESS" project trust grant --allow-native-direct-unrestricted --cwd "$PROJECT"
```

Scenarios write `headless` for brevity — substitute `"$HEADLESS"`. Prefer
`--backend opencode --auth-mode native-login --profile read-only-native`
(swap in `codex`, `claude`, or `grok` per your installed logins). Use
`--profile broker-readonly` / broker mode (`--model openai/gpt-5` with
`OPENAI_API_KEY` exported) when the daemon holds provider keys instead.

## 1. First contained read-only run, then inspect its receipt

**Goal:** prove a contained run happened, and that its receipt verifies
against the live ledger.

```bash
RUN_ID="$(headless exec --cwd "$PROJECT" \
  --backend opencode --auth-mode native-login \
  --profile read-only-native \
  --timeout-ms 120000 --json \
  -- "List the files in this project and describe its purpose." \
  | jq -r .jobId)"

headless experimental receipt list --cwd "$PROJECT"
headless experimental receipt show "$RUN_ID" --cwd "$PROJECT"
headless experimental receipt verify "$RUN_ID" --cwd "$PROJECT"
```

(No `jq`? Run without the substitution and copy the `jobId` field from the
JSON.)

**Success:** the exec exits 0 with `"status": "succeeded"`. `receipt show`
prints the receipt card — backend and mode, a `contain` line naming the real
mechanism (Seatbelt on macOS, bubblewrap on Linux) with **no** `UNSAFE`
marker, the ledger anchor sequence and hash, and the self-digest. `verify`
prints `✓ VERIFIED <runId> (full-chain)` and exits 0.

**Failure:** the exec exits 1 with a structured `error` in the JSON (for
example an auth or containment failure), or `verify` prints
`✗ FAILED <runId>: <reason>` and exits 1 — which would mean the ledger,
anchor, or receipt digest no longer agree and the evidence cannot be trusted.

## 2. Tamper-evidence: flip one byte in an exported receipt

**Goal:** show that offline receipt verification fails closed on any
modification.

```bash
headless experimental receipt export "$RUN_ID" \
  --out "$PROJECT/export.json" --cwd "$PROJECT"

# Confirm the genuine export verifies offline first:
headless experimental receipt verify --file "$PROJECT/export.json"

# Tamper: change one recorded value (durationMs +1) and re-verify:
bun -e 'const f=process.argv[1];const d=JSON.parse(await Bun.file(f).text());
d.receipt.body.result.durationMs+=1;
await Bun.write(f,JSON.stringify(d));' "$PROJECT/export.json"

headless experimental receipt verify --file "$PROJECT/export.json"
echo "exit code: $?"
```

**Success (of the demo):** the first offline verify prints
`✓ VERIFIED <runId> (…)` with an honest assurance level — `embedded-record`
for a SHA-anchored ledger ("offline; run with `--ledger` for full-chain
proof") or `structural-only` for an HMAC-anchored one. After the one-value
edit, verification prints `✗ FAILED <runId>: <reason>` and **exits 1**. No
flag can make the tampered export pass.

**Failure:** if the tampered file verified, tamper-evidence would be broken —
report it as a security bug.

## 3. Ledger verification (read-only)

**Goal:** verify the whole tamper-evident ledger chain and understand what a
break report looks like — without breaking anything. This is a read-only
inspection; do **not** corrupt a real ledger to test it.

```bash
headless verify --cwd "$PROJECT"
headless verify --json --cwd "$PROJECT"
headless verify --evidence --json --cwd "$PROJECT"
```

**Success:** `✓ intact: <n> records, head <seq>/<hash>, <algorithm>` and exit
0; the JSON form reports `"ok": true` with `recordsChecked` and the `head`
record. The `--evidence` form additionally re-hashes each anchored
release-evidence file and reports matched/mismatched/missing/malformed
counts.

**Failure (what a break would look like):** exit 1 with
`✗ BREAK at seq <n>: <reason>` on stderr; the JSON verdict carries
`"ok": false` and a `firstBreakAt: { "sequence": <n>, "reason": "…" }` object
pinpointing the first record where the sequence/hash/HMAC chain no longer
holds (for example a hash mismatch after any byte of a record changed). That
is the signal to stop trusting the state and investigate.

## 4. Write-mode candidate flow on a toy repo

**Goal:** show that write mode never edits primary directly — it produces a
preserved candidate that a human integrates or rejects.

```bash
TOY="$(mktemp -d)"
git -C "$TOY" init
printf 'hello\n' > "$TOY/README.md"
git -C "$TOY" add . && git -C "$TOY" commit -m "seed"

headless init --cwd "$TOY"
headless project trust grant --allow-native-direct-unrestricted --cwd "$TOY"

WRITE_ID="$(headless exec --cwd "$TOY" \
  --backend opencode --auth-mode native-login \
  --mode write --timeout-ms 300000 --json \
  -- "Append a usage section to README.md." \
  | jq -r .jobId)"

# If the run parks on a pending approval, resolve it and re-check:
headless experimental approval list --cwd "$TOY" --status pending
# headless experimental approval resolve --cwd "$TOY" \
#   --approval-id <id> --decision approved --resolution "Reviewed."

headless experimental candidate inspect  --cwd "$TOY" --candidate-id "$WRITE_ID"
headless experimental candidate integrate --cwd "$TOY" --candidate-id "$WRITE_ID"
# or: headless experimental candidate reject --cwd "$TOY" --candidate-id "$WRITE_ID"
```

The candidate id is the write run's `jobId`.

**Success:** the run result carries a bounded diff and candidate commit while
`git -C "$TOY" status` stays clean — primary is untouched. `inspect` returns
the preserved evidence (diff, gate outcomes, finality, approval state).
`integrate` exits 0 with an outcome of `merged_fast_forward`,
`merged_advanced`, or `recovered_applied`, and only then does the toy repo's
history advance. `reject` records the decision and leaves primary untouched.
Any project gates configured for the repo (`check|build|test|pack`) run in the
candidate before integration; a bare toy repo may honestly report its gates as
not required.

**Failure:** `integrate` exits 1 with a structured reason — failed gates,
secret detection, conflict, missing approval, or overflow — and primary is
preserved in every one of those cases.

## 5. Unsafe-mode visibility

**Goal:** show that the only containment bypass is loud, recorded, and
permanent in the evidence.

```bash
headless exec --cwd "$PROJECT" \
  --backend opencode --auth-mode native-login \
  --unsafe-no-sandbox \
  -- "Print the current working directory."

UNSAFE_ID="$(headless exec --cwd "$PROJECT" \
  --backend opencode --auth-mode native-login \
  --unsafe-no-sandbox --json \
  -- "Print the current working directory." | jq -r .jobId)"

headless experimental receipt show "$UNSAFE_ID" --cwd "$PROJECT"
```

**Success:** the human-format run prints
`WARNING: result was produced without required OS containment.` on stderr; the
JSON result records `"unsafe": true` under `containment`; and the receipt's
`contain` line ends with a visible `UNSAFE` marker. The record cannot be
suppressed. As a bonus check, passing `--require-sandbox` and
`--unsafe-no-sandbox` together fails immediately with
`Choose either --require-sandbox or --unsafe-no-sandbox, not both.`

**Failure:** any unsafe run whose warning, JSON containment evidence, or
receipt marker is missing is a reportable defect.

## 6. Fleet health and the foreground lead

**Goal:** bind a foreground lead, read fleet readiness, and watch both in the
TUI.

```bash
headless experimental fleet health --cwd "$PROJECT"

headless mcp install codex --cwd "$PROJECT"
headless lead use codex --cwd "$PROJECT"
headless lead status --cwd "$PROJECT"
# later: headless lead release --cwd "$PROJECT"

headless tui --cwd "$PROJECT"    # press 2 for the Fleet view
```

(`headless init --lead codex` performs init, MCP install, and `lead use` in
one step.)

**Success:** `fleet health` returns per-agent readiness JSON; `lead status`
shows the codex binding. In the TUI's Fleet view each backend renders in its
identity color with a readiness dot; a `Login required` row shows the
provider's own login command and tells you to run it externally.

**Failure:** everything reads `login_required` even though your provider CLIs
are logged in — the documented trap. It usually means the project is not
trusted for native login or the fleet profile (or one of its nested agents)
still defaults to broker. Grant trust and upsert a profile whose top level
**and** every agent use `native-login`, then re-run `fleet health`.

## 7. Budget fail-closed

**Goal:** show that a tight budget denies work with a structured error
instead of silently overspending.

```bash
headless experimental budget upsert \
  --id demo-cap \
  --max-requests 1 \
  --expires-at 4102444800000 \
  --cwd "$PROJECT"

headless experimental budget list --cwd "$PROJECT"

# First run fits the budget:
headless exec --cwd "$PROJECT" --backend opencode --auth-mode native-login \
  --profile read-only-native --json -- "Say ok."

# Second run exceeds max-requests:
headless exec --cwd "$PROJECT" --backend opencode --auth-mode native-login \
  --profile read-only-native --json -- "Say ok again."
echo "exit code: $?"
```

**Success:** the first run succeeds and `budget list` shows its usage counted
against `demo-cap`. The second run exits 1 with a **structured denial**: the
JSON result reports `"status": "blocked"` and an error with
`"code": "BUDGET_EXCEEDED"` whose message names the budget and the limit
(`demo-cap: request limit exceeded.`). Nothing reached the provider for the
blocked run. Related fail-closed behavior: under a `--max-cost-usd` cap, a
run whose model pricing is unknown is also blocked with `BUDGET_EXCEEDED`
("cost usage is unknown") — unknown cost is never treated as zero.

**Failure:** the second run executing anyway, or a denial without the
structured `BUDGET_EXCEEDED` error, would be a budget-enforcement bug.

## 8. Multi-coder goal with a fleet profile

**Goal:** run a durable goal against an explicit fleet profile and follow it
to a terminal state.

```bash
cat > /tmp/fleet.json <<'JSON'
{
  "id": "native-subscriptions",
  "name": "Native subscription fleet",
  "authMode": "native-login",
  "approvalPolicy": "ask",
  "agents": [
    {"id": "codex", "backend": "codex", "name": "Codex", "authMode": "native-login"},
    {"id": "opencode", "backend": "opencode", "name": "OpenCode", "authMode": "native-login"}
  ]
}
JSON

headless experimental fleet profile upsert --file /tmp/fleet.json --activate --cwd "$PROJECT"

GOAL_ID="$(headless experimental goal start --cwd "$PROJECT" \
  --fleet-profile-id native-subscriptions \
  --detach \
  -- "Summarize this project's layout and propose one improvement." \
  | jq -r '.goal.id // .goalId // .id')"

headless experimental goal follow --cwd "$PROJECT" --goal-id "$GOAL_ID"
headless experimental goal result --cwd "$PROJECT" --goal-id "$GOAL_ID"
```

Watch it live in a second terminal: `headless tui --cwd "$PROJECT"`, press
`3` for the Goals view and `5` for Events.

**Success:** `goal start` returns a durable goal id immediately. `follow`
streams turn lines to stderr (`[goal <id>] <agent> <state>: …`) and, when the
goal reaches a terminal state, prints the final goal-plus-result JSON —
exiting 0 only on `succeeded`. In the TUI the goal's glyph advances through
the lifecycle (planning `◔`, delegating `◑`, active `●`, … succeeded `✓`).
Automatic worker selection avoids the active lead backend.

**Failure:** the goal ends `failed` or `timed_out` (follow exits 1 and the
glyph shows `✗` or `◷`); or `follow` itself times out, in which case the goal
remains durable and can be followed again or read later with `goal result`.

## Dropped scenarios

Nothing was dropped. All eight scenarios above use only commands and flags
present in the generated command reference and the current source tree.
