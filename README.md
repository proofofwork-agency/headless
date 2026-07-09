# Headless

Headless is a Bun-based runner and local control plane for executing coding agents from other tools.

The current MVP is intentionally narrow:

- normalized `headless exec` for OpenCode, Claude Code, Codex, and Grok CLI
- a native `.headless` JSONL ledger with replayable read models
- an OpenCode plugin exposing Headless tools backed by that shared core
- structured results with output, exit code, timeout, token, and cost fields where the backend exposes them

The core lives in `src/`. The CLI and OpenCode plugin are adapters over that core.

## Current Surface

```bash
bun src/cli.ts exec --backend opencode --json "say OK"
bun src/cli.ts exec --backend claude --json "say OK"
bun src/cli.ts exec --backend codex --json "say OK"
bun src/cli.ts exec --backend grok --json "say OK"
bun src/cli.ts exec --backend grok --mode write --json "make the requested change"
```

OpenCode child workers are launched as:

```bash
opencode run --pure --format json --dir <cwd> ...
```

Grok child workers are launched through the real Grok CLI single-turn path:

```bash
grok --single <prompt> --cwd <cwd> --output-format streaming-json
```

Backend option support:

| Backend | `--model` | `--agent` |
| --- | --- | --- |
| OpenCode | passed as `--model` | passed as `--agent` |
| Claude Code | passed as `--model` | ignored; no Headless agent mapping yet |
| Codex | passed as `--model` | ignored; Codex exec has no Headless agent mapping yet |
| Grok CLI | passed as `--model` | passed as `--agent` |

## Troubleshooting

Claude Code and Codex runs use the installed local CLIs, so those CLIs must already be authenticated. For Claude Code, run `claude` and complete `/login`; for Codex, complete its CLI auth flow before invoking it through Headless.

### OpenCode models and credentials

OpenCode is launched with `--pure`. Per the OpenCode source (v1.17.x, `packages/opencode/src/plugin/index.ts`), `--pure` disables **external plugins only** — it does **not** strip provider authentication, environment API keys, or config. So Headless can run any authenticated model:

- Pass it as `--model <provider>/<model>` (e.g. `--model anthropic/claude-sonnet-4-5`, `--model zai-coding-plan/glm-4.7`).
- Credentials resolve, in order, from: `<PROVIDER>_API_KEY` env vars (auto-detected; the env allowlist forwards `ANTHROPIC_`/`OPENAI_`/`XAI_`/`GOOGLE_`/`GEMINI_`/`OPENROUTER_` and `OPENCODE_` prefixes), then the user's `~/.local/share/opencode/auth.json`, then any `provider.<id>.options.apiKey` in `OPENCODE_CONFIG_CONTENT`. All of these work under `--pure`.
- The env var name is provider-specific (from the models.dev catalog), **not** always `<NAME>_API_KEY`. Notably, **z.ai / GLM ("zai", "zai-coding-plan") use `ZHIPU_API_KEY`**.

If a run produces no assistant output, it is almost always the **model**, not Headless: opencode's free hosted models (`opencode/big-pickle`, `*-free`) authenticate but are too weak to emit valid tool calls (they print the tool call as text), and some third-party endpoints (observed with z.ai GLM) intermittently return empty responses or `Unexpected server error`. Headless authenticates the provider, applies its tool/permission denies, wraps the run in the OS sandbox, and parses the output correctly regardless — pick a capable, reliable model for real work.

## macOS Read-Only Sandbox

On macOS, Headless auto-detects `/usr/bin/sandbox-exec` and probes that Seatbelt actually denies writes. When available, read-only runs for OpenCode, Claude Code, and Grok are wrapped in a generated Seatbelt profile as an OS-enforced floor beneath each backend's app-level denies.

The profile is a **deny-list**: it allows the backend to run normally (its SQLite databases, macOS Keychain auth, caches, and temp all work) and then subtracts the things a read-only run must never do — it **denies all writes to the project directory** (`--cwd`, the OS-enforced read-only guarantee), denies read/write of credential directories (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gcloud`), and denies spawning interactive shells (`/bin/bash`, `/bin/zsh`). This shape is deliberate: an allow-list that enumerates every writable root breaks full CLIs (opencode's SQLite, claude's Keychain), while the property we actually need — "the project is not modified" — is enforced directly. `/bin/sh` stays allowed so backends can shell out for legitimate work; the agent's own bash/exec tool is already denied at the app level.

Codex is exempt from this outer wrapper because it already runs with `codex exec --sandbox read-only`; write mode is also exempt because it uses ephemeral git worktree containment instead.

On non-macOS platforms, or if the sandbox probe fails, Headless falls back to the app-level containment without refusing the run.

## Contained Write Mode

`--mode write` is diff-only and git-required. Headless creates an ephemeral git worktree on a `headless/write/<label>-<id>` branch, runs the backend inside that worktree, captures the resulting patch/status/file list, and removes the worktree. It does not auto-apply or merge changes back into the caller's tree.

If the requested `--cwd` is not a git worktree root, write mode fails before spawning the backend. Dirty primary trees are refused for now; Headless does not seed uncommitted caller changes into write worktrees.

The structured result includes:

```ts
{
  diff: { patch: string, status: string, files: string[] },
  worktreeBranch: string
}
```

When invoked through the runtime/orchestrator, the same diff is recorded as a `write_diff` ledger artifact with the changed files as evidence.

## OpenCode Plugin

`plugin/index.ts` exports a loadable OpenCode plugin with these tools:

- `headless_run`
- `headless_append_note`
- `headless_record_artifact`
- `headless_read_context`
- `headless_task_state`
- `headless_propose_final`
- `headless_deliberate`

This repo dogfoods the plugin through `opencode.json`:

```json
{ "plugin": ["./plugin/index.ts"] }
```

For local global use, install or copy the plugin into an OpenCode plugin location such as `.opencode/plugin` / `.opencode/plugins`, or reference this repo's `plugin/index.ts` from OpenCode config.

The plugin package is not npm-ready yet. `plugin/package.json` is named `@proofofwork-agency/headless-plugin`, but publishing still needs a bundle that includes the Headless core currently imported from `../src`.

The plugin uses `context.directory || context.worktree` as the execution root and writes session data under:

```text
.headless/sessions/<session-id>/ledger.jsonl
```

## Ledger

The native ledger records typed events:

- `session_started`
- `note`
- `artifact`
- `run_started`
- `worker_spawned`
- `headless_result`
- `handoff`
- `finality_proposal`

Read models derive recent context, task lanes, artifacts, finality blockers, and run status by replaying the JSONL log.

Each new ledger event includes `seq`, `prevHash`, and `hash`. Reads verify that chain and fail with a `LedgerIntegrityError` if a line is malformed, reordered, or modified. This is tamper-evident, not tamper-proof: there is no secret MAC key yet.

## Status

Implemented and tested:

- native `.headless` ledger and read models
- tamper-evident ledger seq/hash chain with guarded reads
- backend adapter registry for command construction and parsing
- mode policy rejection before subprocess launch for backends that cannot write
- child process environment allowlisting for all backends
- OpenCode read-only runs inject config-level tool and permission denies for write/edit/patch/bash/web tools
- OpenCode plugin tool surface
- OpenCode pure worker command construction and JSON parsing
- Grok CLI command construction and streaming JSON parsing
- named Claude/Codex JSON output parsers with local fixture coverage
- timeout classification and no-output classification
- lifecycle recording for `headless_run`
- bounded fan-out for `headless_deliberate`

Known gaps:

- containment is not yet enforced with worktrees or an OS sandbox
- ledger integrity has no MAC/signature and therefore does not defend against an attacker who can rewrite the whole ledger
- `mode` enforces backend capability before launch, and OpenCode read-only runs deny write/edit/patch/bash/web tools through `OPENCODE_CONFIG_CONTENT`; this is defense in depth, not filesystem isolation
- streaming is parsed after process completion, not exposed live
- Claude/Codex parser fixtures are local representative fixtures, not live authenticated CLI golden files
- OpenCode plugin API is still pre-1.0 and may change

## Development

```bash
bun run check
bun run build
```

Useful smoke checks:

```bash
bun src/cli.ts exec --backend opencode --json --timeout-ms 60000 "say OK"
bun src/cli.ts exec --backend grok --json --timeout-ms 60000 "say OK"
```

In the current local environment, OpenCode may exit successfully without emitting assistant text; Headless treats that as `ok: false` with `No assistant output was produced by the backend.` Grok may return account or quota errors from the real CLI; Headless surfaces those as failed structured results.
