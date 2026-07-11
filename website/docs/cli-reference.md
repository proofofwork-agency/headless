---
id: cli-reference
title: CLI reference
---

# CLI reference

The `headless` binary (and its identical alias `hless`) is the primary client.
`headless-mcp` is the standalone MCP stdio server. During development in a
checkout, run any command as `bun src/cli.ts <command> …`.

Every command connects to the daemon for the canonical `--cwd` root, starting an
embedded daemon when none is live. Use `headless --help` for the exact
built-in surface.

## Cross-cutting flags

- `--cwd <dir>` — the project root (default: current directory). Determines which
  per-project daemon and state are used.
- `--json` / `-j` — structured JSON output where supported.
- `--stream` — stream raw backend output (`exec` only).
- `--require-sandbox` / `--unsafe-no-sandbox` — containment selector. The default
  is `required`; `--unsafe-no-sandbox` is the only local bypass and is visibly
  marked in the result and ledger. Autonomy, orchestration, councils, and
  workflows reject unsafe.
- `--auth-mode native-login|broker` and `--approval-policy ask|auto|bypass` flow
  into run, session, goal, council, workflow, and fleet dispatch.
- A literal `--` precedes any prompt that begins with a flag.

## Backend and model selection

Canonical backends are `opencode`, `claude-code`, `codex`, and `grok-build`,
with aliases `claude`, `codex-cli`, `grok`, and `headless-opencode`.

- `--backend <id>` selects the backend (default `opencode` for `exec`/`run` and
  `session create`; `launch` takes it as a positional).
- `--model <m>` is optional everywhere and is passed straight through to the
  backend CLI. When omitted, Headless injects no model and the backend's own
  default applies.
- Goal-, council-, and fleet-driven work take their backend, model, auth mode,
  and approval policy from each agent in the selected **fleet profile** rather
  than from `--backend`/`--model`.

## Commands by area

### Run and sessions

```bash
headless exec|run [--backend id] [--mode read-only|write] [--model m] [--agent a] \
  [--session-id id] [--timeout-ms n] [--stream] [--json] \
  [--require-sandbox|--unsafe-no-sandbox] "prompt"

headless launch <backend> [--timeout-ms n] [--json] [prompt]

headless session create|send|resume|cancel|status|result --session-id <id> [--backend id] [--model m]
```

`exec` submits a one-shot prompt and waits (default timeout 180 s). `session`
manages a durable, resumable session that replays prior context.

### Goals and collaboration

```bash
headless goal start|run|send|follow|status|list|cancel|result \
  [--goal-id id] [--fleet-profile-id id] [--coordinator human|automatic|election|agent:<id>] \
  [--mode read-only|write] [--detach] [--timeout-ms n]

headless collaboration turns|messages|acknowledge|transfer-leader \
  --goal-id <id> [--message-id id …] [--retain]
```

`goal start` is always detached; `goal run` follows to completion. Goals are
read-only by default; `--mode write` selects a gated write goal.

### Approvals and candidates

```bash
headless approval list|resolve [--goal-id id] [--status …] \
  [--approval-id id --decision approved|rejected --resolution text]

headless candidate inspect|integrate|reject --candidate-id <id>
```

`candidate integrate` merges a candidate worktree into the checkout and is
subject to every configured gate.

### Fleets, councils, and workflows

```bash
headless fleet health [--profile-id id]
headless fleet profile upsert|get|list|remove [--file profile.json] [--profile-id id] [--activate|--no-activate]

headless council [--agent backend …] [--mode read-only|write] [--timeout-ms n] "question"

headless workflow run|list|status|wait|cancel [--file workflow.json | --workflow-id id] [--timeout-ms n]
```

A fleet profile is a JSON document validated by a **strict** schema: supply
`id`, `name`, and `agents[]` (each with `id`, `backend`, `name`, and optional
`model`/`priority`/`capabilities`); daemon-managed fields such as `projectId`,
`createdAt`, and `updatedAt` must be omitted. When no profile exists, the daemon
auto-provisions a `fleet-default` from the installed backends.

### Autonomy

```bash
headless autonomy start|stop|status|ask|backup
headless orchestrate
headless pair
```

`autonomy start` / `orchestrate` begin the bounded autonomous loop that spawns
contained work; unsafe execution is rejected.

### Project, daemon, and inspection

```bash
headless project trust status|grant|revoke [--allow-bypass] [--deny-native-login]
headless init

headless daemon serve|status
headless status | doctor | events [--follow] [--limit n] | tui
```

`doctor` self-checks Bun, project id/root, the authenticated principal, external
state, backend presence on `PATH`, and job/event counts.

### Gate and MCP

```bash
headless gate [--check check|build|test|pack] [--timeout-ms n]
headless mcp serve|install|remove|status [codex|grok|claude|opencode]
```

`gate` runs daemon-owned release checks (project commands, not AI backends).
`mcp install codex` registers the Headless MCP server with Codex; other hosts
print the config snippet to paste.

## Read-only vs. mutating vs. spawning

- **Read-only** (no state change): `status`, `doctor`, `events`, the
  `*.list`/`*.status`/`*.result` forms, `fleet health`, `approval list`,
  `candidate inspect`, `collaboration turns|messages`.
- **Mutating** (durable state): `project trust grant|revoke`, `fleet profile
  upsert|remove`, `session create|cancel`, `goal send|cancel`, `collaboration
  acknowledge|transfer-leader`, `approval resolve`, `candidate
  integrate|reject`, `workflow cancel`, `init`, `mcp install|remove`.
- **Spawning** (contained backend or check work): `exec`/`run`, `launch`,
  `session send|resume`, `goal start|run`, `council`, `workflow run`,
  `autonomy start`, `orchestrate`, `gate`, plus the long-running `daemon serve`,
  `mcp serve`, and `tui`.
