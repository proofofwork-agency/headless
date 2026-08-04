# Resume point — 2026-08-04

Session paused on low credits. Everything below is committed and pushed. **Nothing was released, published, tagged, or merged to `main`** beyond PR #48, which you authorised.

## Branches and PRs

| Branch | PR | Head | State |
|---|---|---|---|
| `main` | — | `51ce83f` | PR #48 merged (you authorised this) |
| `security/hardening-wip` | [#49](https://github.com/proofofwork-agency/headless/pull/49) | `5342608` | Open. Last commit's full-suite run did not finish — **re-run before trusting it** |
| `fix/cli-usage-error-classification` | [#50](https://github.com/proofofwork-agency/headless/pull/50) | `0d53d99` | Open. Verified green |

A git worktree for PR #50 lives at
`/private/tmp/claude-501/-Users-danillofelanso-projects-proofofworks-headless/b264161a-d907-4bfb-b4e3-d17141ac2625/scratchpad/wt-parser`.
It is a scratchpad path and will not survive indefinitely — the branch is pushed, so
`git worktree remove` it and work from a normal checkout when you return.

## FIRST THING TO DO ON RESUME

```bash
cd /Users/danillofelanso/projects/proofofworks/headless   # on security/hardening-wip
bun run check          # full gate; the last background run was cut off mid-flight
```

`bun run check` = daemon hygiene → typecheck → plugin typecheck → lint → format → docs → `bun test tests` → product gate.
If it is green, PR #49 is ready for your review. If not, the failure is almost certainly in the
ledger or broker work described below, both of which landed late and were verified only at file scope.

## What was fixed

**PR #50 — CLI correctness.** Two root causes, both cross-cutting:
- Usage errors were classified `INTERNAL_ERROR` in text mode but `INVALID_REQUEST` under `--json`, so every typo told the operator the daemon had failed and sent them to `headless daemon status`. Classified once now, before the output-mode split.
- Every handler read its subcommand as `args[1]`, so a global flag became the action. `headless daemon --cwd DIR` and `lead --cwd DIR` failed outright, and `mcp --cwd DIR` consumed the flag *and its value* and reported the operator's own path as `Unknown MCP host`. One scanner (`src/cli/argv.ts`) now owns this; 27 index reads across 18 handlers migrated.

Plus: per-command unknown-flag rejection, `--json` scoped to commands that actually emit JSON, negative numeric flag values, `experimental`-qualified usage strings, `events` conflict surviving `--json`, `launch` requiring its backend, `tui` refusing without a TTY instead of dumping an Ink/React stack trace, and a bad `--cwd` naming itself instead of leaking `ENOENT … lstat`.

**PR #49 — hardening.** Six blockers found reviewing the uncommitted work that was sitting in the tree when the session started (ledger keyring reaching workers, pre-bind `rmSync` destroying bind exclusivity, umask corruption across concurrent binds, an un-migrated listen-then-chmod site, a leaked Bun listener, an unguarded `getuid`). Then two more found reviewing *that*: the ledger key floor blocking verification of existing history, and the broker handing workers a lease token pointed at a port nothing serves.

## Known-open, deliberately not fixed

Ranked. The first two are design questions, not patches.

1. **Session daemon capability negotiation.** `headless experimental session …` fails unless the daemon happened to be started with `--experimental-sessions`, so availability depends on which command started the daemon first. I established the flag is a *pure dispatch gate* (`src/daemon/server.ts:455` is its only functional use — no credential, socket, containment or storage difference), so it can be activated on a live daemon without a restart. Codex designed the negotiation; the open question is **yours**: does invoking the session namespace count as consent to activate it? My recommendation is yes.
2. **`headless status --cwd <anything>` spawns a persistent daemon** with `scopes: ["admin"]` for any path you point it at, including `/etc`. A documented read-only inspection command should not have that side effect. `tests/cli-v2.test.ts:27` shows the codebase already knows control-plane commands bootstrap a daemon per `--cwd`; the question is whether `status` should be one.
3. **`headless mcp install` with no backend** silently defaults to Codex and writes global MCP config, exit 0, no confirmation.
4. **`fleet health` returns an opaque `INTERNAL_ERROR`** for a profile referencing an unregistered backend, instead of per-agent unavailable detail.
5. **Unknown *positionals* are still ignored** — `headless experimental init not-a-subcommand` initialises successfully. Same class as the unknown-flag defect just fixed, but riskier to fix blind: many commands legitimately take positionals (prompts, run ids, hosts), so it needs the same per-command spec work Codex did for flags.
6. **Nested `--help` is global-only** (`workflow wait --help` prints the top-level catalog), and `gate` prints "Running…" before validating its `--check` value.

## Verification assets worth keeping

`scratchpad/exhaustive-cli.ts` — derives the command surface from `COMMAND_SPECS` so it cannot miss a command, runs **872 invocations**, captures stdout/stderr/exit separately, and asserts: no stack traces, no secret leakage, no state-path leakage, no raw filesystem errors, no text/JSON classification divergence, no hangs. PR #50 passes all of it. Copy it into `scripts/` if you want it as a permanent gate — it found three defects the 961-test suite did not.

Two cautions if you reuse it. On macOS `mkdtemp` returns `/var/...` while the CLI prints the realpath `/private/var/...`, so leak detection must compare both spellings — that bug made it report "all invariants held" while two path leaks were live. And its text-vs-JSON parity check produces false positives for commands that now *reject* `--json`, since the two invocations no longer test the same failure.

## Honest status

- PR #50 is verified: 961 tests, typecheck, lint, format, and the 872-invocation sweep.
- PR #49's last commit is **not** fully verified. Typecheck is clean and the touched suites pass at file scope, but the full run was interrupted. Re-run `bun run check` first.
- The broker fix's Linux path was reasoned about, not executed — this machine is macOS and the Linux relay test is `skipIf(platform !== "linux")`. That skip is also why the host-TCP change shipped originally with no executed coverage. **Worth a Linux CI run before merging #49**, since a false refusal there would break production runs.
- Codex reviewed PR #50 against its own spec and found two blockers, both fixed. It has not re-reviewed since, and has not reviewed #49's late ledger/broker work at all.
