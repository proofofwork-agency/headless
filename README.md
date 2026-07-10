# Headless

**A contained, auditable runner for coding agents.** Headless gives you one normalized way to run OpenCode, Claude Code, Codex, and the Grok CLI from scripts, other tools, or an OpenCode plugin — with defense-in-depth containment and a tamper-evident local ledger of everything that happened.

Two properties are non-negotiable:

- **Containment** — a read-only run cannot modify your project, and a write run can only ever produce a reviewable diff (never touch your working tree). Enforced in up to three layers (app-level tool denies, an OS sandbox on macOS, and git-worktree isolation for writes).
- **Auditability** — every run is recorded to a hash-chained `.headless` JSONL ledger with secret redaction, so you can replay exactly what each agent did.

The core lives in `src/`. The CLI and the OpenCode plugin are thin adapters over that core.

---

## Requirements

- **[Bun](https://bun.sh)** — the runtime. Everything runs on Bun; there is no Node build.
- **The backend CLIs you intend to use**, installed and authenticated (see [Backends & authentication](#backends--authentication)):
  - `opencode` — [opencode.ai](https://opencode.ai)
  - `claude` — Claude Code
  - `codex` — OpenAI Codex CLI
  - `grok` — Grok CLI
- **macOS** is recommended for the strongest containment (the OS sandbox is macOS-only); Linux/Windows fall back to app-level containment.

Headless has **zero runtime dependencies** — everything is Bun/Node built-ins. `@opencode-ai/plugin` is a dev/peer dependency, needed only when loading the OpenCode plugin.

---

## Install

```bash
git clone https://github.com/proofofwork-agency/headless.git
cd headless
bun install
bun run check   # typecheck + full test suite (should be green)
```

During development, invoke the CLI directly with Bun:

```bash
bun src/cli.ts exec --backend opencode --json "say OK"
```

To build distributable JS + type declarations into `dist/` (and expose the `headless` / `hless` bins):

```bash
bun run build
```

---

## Quick start

```bash
# Read-only run (default) — the agent can read your project but cannot modify it
bun src/cli.ts exec --backend claude "Summarize what src/runner/simple.ts does"

# Cap the timeout, get the full structured result as JSON
bun src/cli.ts exec --backend codex --timeout-ms 60000 --json "List the exported functions in src/index.ts"

# Contained write — runs in a throwaway git worktree and returns a DIFF; your tree is untouched
bun src/cli.ts exec --backend grok --mode write --json "Add a docstring to the exec() function"
```

Exit code is `0` when the run succeeded (`ok: true`) and `1` otherwise.

---

## CLI reference

```
headless (hless) — normalized headless runner for coding CLIs

Commands:
  exec | run    Run one prompt on a backend and return a normalized result.
  launch <t>    Launch a backend helper (opencode serve, a pure worker, a grok smoke).
  --help  | -h  Show help.
  --version | -V  Print the Headless version.
```

### `exec` / `run`

```bash
bun src/cli.ts exec --backend <backend> [options] "your prompt"
```

| Flag | Values | Default | Notes |
| --- | --- | --- | --- |
| `--backend` | see [Backends](#backends--authentication) | `opencode` | Backend id or alias. Unknown values error clearly. |
| `--mode` | `read-only`, `write` | `read-only` | `write` is diff-only and git-required — see [Modes](#modes). |
| `--model` | provider/model string | backend default | Passed to the backend CLI (all four honor it). |
| `--agent` | agent name | — | Honored by `opencode` and `grok`; ignored by `claude`/`codex`. |
| `--cwd` | path | current dir | Working directory the agent reads/operates in. |
| `--timeout-ms` | integer | 180000 | Hard timeout; the process tree is killed and the result is marked `timedOut`. |
| `--json` / `-j` | — | off | Print the full structured result as JSON instead of just the answer text. |
| `--` | — | — | Everything after `--` is the verbatim prompt (useful for prompts starting with `-`). |

The prompt is the positional argument (or everything after `--`). Passing more than one positional, or a flag with no value, is a friendly usage error.

**Examples**

```bash
bun src/cli.ts exec --backend opencode --model anthropic/claude-sonnet-4-5 "explain this repo"
bun src/cli.ts exec --backend claude --json "say OK"
bun src/cli.ts exec --backend codex --mode write --json -- "--fix the flaky retry in the runner"
```

### `launch`

Helper passthroughs for experimentation (these inherit your terminal, they are not contained runs):

```bash
bun src/cli.ts launch opencode-serve            # opencode serve (for attach / SDK work)
bun src/cli.ts launch opencode --cwd ./somedir  # opencode run --pure one-shot worker
bun src/cli.ts launch grok                       # a Grok CLI single-turn smoke through Headless
```

---

## Modes

### Read-only (default)

The agent may read the project but must not change it. This is enforced in layers (see [Containment](#containment)). If a backend produces no assistant text, the result is `ok: false` with `"No assistant output was produced by the backend."`.

### Contained write (`--mode write`)

`--mode write` is **diff-only and git-required**. Headless:

1. Refuses if `--cwd` is not a git worktree root, or if the tree is dirty (uncommitted changes are not seeded).
2. Creates an ephemeral git worktree on a `headless/write/<label>-<id>` branch.
3. Runs the backend **inside that worktree**.
4. Captures the resulting patch/status/file list.
5. Removes the worktree and prunes the branch — **your working tree is never modified.**

The changes come back as a structured diff for you (or a parent process) to review and apply:

```ts
{
  diff: { patch: string, status: string, files: string[] },
  worktreeBranch: string
}
```

Only `grok-build` currently advertises write capability; a `--mode write` request on a read-only backend is rejected before the process is spawned.

---

## Backends & authentication

| Backend | Aliases | Auth setup | `--model` | `--agent` | Write |
| --- | --- | --- | --- | --- | --- |
| `opencode` | `headless-opencode` | provider auth via `opencode auth login` or env keys (below) | ✅ | ✅ | ✕ |
| `claude-code` | `claude` | run `claude` and complete `/login` | ✅ | ✕ | ✕ |
| `codex` | `codex-cli` | complete the Codex CLI auth flow | ✅ | ✕ | ✕ |
| `grok-build` | `grok` | Grok CLI auth + account balance | ✅ | ✅ | ✅ |

The backend CLIs must already be installed and authenticated on your machine — Headless drives the real CLIs. On macOS, Claude Code stores its token in the Keychain; Headless forwards `USER`/`LOGNAME` so that keychain lookup works inside the contained child.

### OpenCode models and credentials

OpenCode is launched with `--pure`. Per the OpenCode source, `--pure` disables **external plugins only** — it does **not** strip authentication, environment API keys, or config. So any authenticated model works:

- Pass it as `--model <provider>/<model>` (e.g. `--model anthropic/claude-sonnet-4-5`, `--model zai-coding-plan/glm-4.7`).
- Credentials resolve from, in order: `<PROVIDER>_API_KEY` environment variables (auto-detected), your `~/.local/share/opencode/auth.json` (populated by `opencode auth login`), and any `provider.<id>.options.apiKey` in `OPENCODE_CONFIG_CONTENT`. All of these work under `--pure`.
- Headless forwards common provider key prefixes to the child: `OPENCODE_`, `ANTHROPIC_`, `OPENAI_`, `XAI_`, `GOOGLE_`, `GEMINI_`, `OPENROUTER_`, `ZHIPU_`, `ZAI_`, `GROQ_`, `DEEPSEEK_`, `MISTRAL_`, `DASHSCOPE_`. Unrelated environment variables are stripped.
- The env var name is provider-specific (from the [models.dev](https://models.dev) catalog), **not** always `<NAME>_API_KEY`. Notably, **z.ai / GLM (`zai`, `zai-coding-plan`) use `ZHIPU_API_KEY`.**

If an OpenCode run produces no output, it is almost always the **model**, not Headless: opencode's free hosted models (`opencode/big-pickle`, `*-free`) authenticate but are too weak to emit valid tool calls, and some third-party endpoints intermittently return empty responses or server errors. Headless authenticates the provider, applies its denies, sandboxes the run, and parses output correctly regardless — pick a capable, reliable model for real work.

---

## Containment

Read-only runs are contained in up to three independent layers, so a bypass of one is caught by the next:

1. **App-level tool denies (all platforms).** Each backend is launched read-only:
   - OpenCode: an injected `OPENCODE_CONFIG_CONTENT` denies `write`/`edit`/`patch`/`bash`/`webfetch`/`websearch`/`task`/`skill`/... at both the `tools` and `permission` layers (merged last, so it overrides user config).
   - Claude Code: `--allowedTools Read,Grep,Glob,LS`.
   - Codex: `codex exec --sandbox read-only`.
   - Grok: `--permission-mode plan` for read-only runs.
   - The child process environment is allowlisted (base vars + per-backend credential prefixes + `HEADLESS_*`); unrelated secrets never reach the child.

2. **OS sandbox (macOS).** On macOS, Headless auto-detects `/usr/bin/sandbox-exec` and probes that Seatbelt actually denies writes, then wraps each non-exempt read-only run in a generated Seatbelt profile. The profile is a **deny-list**: it lets the backend run normally (its SQLite DB, macOS Keychain auth, caches, temp all work) and then denies the things a read-only run must never do — **all writes to the project dir** (`--cwd`), reads/writes of credential dirs (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gcloud`), and interactive shells (`/bin/bash`, `/bin/zsh`). Codex is exempt (it already runs its own OS sandbox); write mode is exempt (it uses worktree isolation). On non-macOS, or if the probe fails, Headless falls back to app-level containment without refusing the run.

3. **Git-worktree isolation (write mode).** See [Contained write](#contained-write---mode-write) — write runs happen in a throwaway worktree and only ever yield a diff.

---

## Ledger (auditability)

When run through the runtime/orchestrator (the plugin tools and `headlessRun`/`deliberate` helpers), every action is recorded to a per-session JSONL ledger:

```text
.headless/sessions/<session-id>/ledger.jsonl
```

- **Typed events**: `session_started`, `note`, `artifact`, `run_started`, `worker_spawned`, `headless_result`, `handoff`, `finality_proposal`.
- **Tamper-evident**: each event carries `seq`, `prevHash`, and `sha256` `hash`. Reads verify the whole chain and throw `LedgerIntegrityError` if a line is malformed, reordered, inserted, or modified. (Tamper-*evident*, not tamper-*proof* — there is no secret MAC key yet.)
- **Secret redaction on write**: 13 secret patterns (private keys, `sk-`/Bearer/Slack/GitHub/AWS/JWT/Stripe/GCP keys, generic `key=…`) are redacted **before** hashing, and content over 20k chars is truncated. The live caller still receives the raw output; only the durable ledger is sanitized.
- **Atomic + locked writes**: appends go through a mkdir lock and a `tmp → fsync → rename → chmod 600` atomic rewrite, so concurrent readers never see a torn line.
- **Read models** derive recent context, task lanes, artifacts, finality blockers, and run status by replaying the log.

`.headless/` is gitignored. Add it to your own repo's `.gitignore` if you run write mode there (otherwise the ledger dirties the tree and contained write refuses).

---

## Structured result

`--json` (and the programmatic API) return an `ExecResult`:

```ts
{
  ok: boolean,            // true only if not timed out, no parse error, produced output, exit 0
  backend: string,        // canonical backend id
  output: string,         // assistant text (or the error/stderr on failure)
  cost: number | null,    // where the backend reports it
  tokens: number | null,  // where the backend reports it
  durationMs: number,
  exitCode: number | null,
  timedOut: boolean,
  diff?: { patch: string, status: string, files: string[] } | null,  // write mode only
  worktreeBranch?: string | null                                     // write mode only
}
```

---

## OpenCode plugin

`plugin/index.ts` is a loadable OpenCode plugin that exposes the Headless runtime as tools inside an OpenCode session:

- `headless_run` — run a prompt on any backend and return a normalized result
- `headless_append_note` — append a note to the session ledger
- `headless_record_artifact` — record a structured artifact
- `headless_read_context` — read recent ledger context / a summary read model
- `headless_task_state` — task lanes, artifacts, finality blockers, run status
- `headless_propose_final` — record a finality proposal
- `headless_deliberate` — bounded fan-out across backends, collected for parent synthesis

This repo dogfoods the plugin via `opencode.json`:

```json
{ "plugin": ["./plugin/index.ts"] }
```

To use it elsewhere, place it in an OpenCode plugin location (`.opencode/plugin` / `.opencode/plugins`) or reference `plugin/index.ts` from your OpenCode config. Tools write session data under `<directory>/.headless/sessions/<session-id>/ledger.jsonl`, using the OpenCode `ToolContext` directory/session.

> The plugin is not yet npm-publishable on its own: `plugin/package.json` (`@proofofwork-agency/headless-plugin`) still imports the Headless core from `../src`, which a standalone tarball wouldn't include. Repo-path / `.opencode` usage works today.

---

## Programmatic API

The core is importable from `src/index.ts`:

```ts
import { exec, headlessRun, deliberate, getReadContext, getTaskState } from "./src/index";

// One-shot, no ledger:
const res = await exec({ backend: "claude", prompt: "say OK", mode: "read-only" });

// Orchestrated (writes the ledger):
const { result, session } = await headlessRun({
  cwd: process.cwd(),
  backend: "opencode",
  model: "anthropic/claude-sonnet-4-5",
  prompt: "summarize this repo",
  mode: "read-only",
});

// Fan out the same question across backends and collect results:
const { results } = await deliberate({
  cwd: process.cwd(),
  question: "What does src/runner/simple.ts do?",
  backends: ["claude", "codex"],
});
```

---

## Development

```bash
bun run check    # bunx tsc --noEmit  +  bun test tests   (75 tests)
bun run build    # bundle dist/*.js  +  emit dist/*.d.ts
bun run test     # tests only
```

CI (GitHub Actions) runs `bun install --frozen-lockfile` + check + build on every push/PR to `main`.

Smoke checks against real CLIs (require the backend to be authenticated):

```bash
bun src/cli.ts exec --backend claude --json --timeout-ms 60000 "say OK"
bun src/cli.ts exec --backend codex  --json --timeout-ms 60000 "say OK"
bun src/cli.ts exec --backend opencode --model opencode/big-pickle --json --timeout-ms 60000 "say OK"
```

### Project layout

```
src/
  cli.ts                 CLI entrypoint (exec/run/launch/help/version)
  index.ts               public API: exec(), types, re-exports
  backends/              adapter registry, per-backend command + parser + env
    registry.ts  ids.ts  metadata.ts  env.ts  opencode.ts  grok.ts  json.ts
  runner/simple.ts       spawns backends; sandbox + worktree wiring
  runtime/               ledger, read models, orchestrator, sandbox, worktree, redaction
plugin/                  OpenCode plugin (index.ts + package.json)
tests/                   headless.test.ts, plugin-load.test.ts, worktree.test.ts
docs/                    analyses + the project review
```

---

## Status

**Implemented, tested, and verified live against the real CLIs:**

- normalized `exec` across OpenCode, Claude Code, Codex, Grok, with per-backend model/agent flags
- three-layer read-only containment (app denies + macOS OS sandbox + env allowlist), verified live (writes to the project are blocked)
- contained write mode via ephemeral git worktrees (diff-only), verified live (working tree untouched, no orphan worktrees)
- tamper-evident hash-chained ledger with verified reads, secret redaction, atomic/locked writes
- OpenCode plugin that loads in the real `opencode` binary and registers its tools
- backend adapter registry, timeout/no-output classification, bounded `deliberate` fan-out
- publishable package (`dist` JS + `.d.ts`, `files` allowlist, prepublish build) and CI

**Known gaps / roadmap:**

- OS-level containment is macOS-only; Linux (bubblewrap/landlock) is not yet ported
- ledger integrity is tamper-evident, not tamper-proof (no MAC/signature key)
- ledger append rewrites the whole file per event (O(n²)); fine at MVP scale, wants segmentation/compaction for long sessions
- backend output is parsed after completion, not streamed live
- Claude/Codex parser coverage includes a live-captured Codex golden; Grok lacks a live golden (needs account balance)
- the OpenCode plugin is not standalone-npm-publishable yet (imports core from `../src`)

---

## License

MIT — see [LICENSE](./LICENSE).
