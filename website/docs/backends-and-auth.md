---
id: backends-and-auth
title: Backends and authentication
---

# Backends and authentication

## Backends

| Backend | Aliases | Model | Agent | Write |
| --- | --- | --- | --- | --- |
| `opencode` | `headless-opencode` | yes | yes | yes |
| `claude-code` | `claude` | yes | no | yes |
| `codex` | `codex-cli` | yes | no | yes |
| `grok-build` | `grok` | yes | yes | yes |

The default backend for `exec`/`run` and `session create` is `opencode`. The
table describes adapter capabilities, not a release-gate exemption.

## Project trust

Native login is unavailable until a project root is explicitly trusted — a
one-time decision:

```bash
headless project trust grant --cwd .
headless project trust status --cwd .
```

Until then, native-login runs fail closed with `NATIVE_AUTH_UNAVAILABLE`
("Native login requires one-time project trust"). `--allow-bypass` enables the
`bypass` approval policy for the project; `--deny-native-login` restricts it to
broker mode.

## Native login vs. broker

- **`native-login` (default)** uses the official CLI's existing account without
  copying the real home directory or unrelated credentials into a worker. Native
  runs are reported as `network: "provider-direct"`,
  `credentialAccess: "backend-native"`, and `cost.amountUsd: null` unless the CLI
  reports an actual charge.
- **`broker`** keeps the short-lived broker-token model, denies direct provider
  egress, and enforces API-cost bounds. Select it with `--auth-mode broker`.

## Per-backend behavior

### Claude Code

Claude on macOS requires a supported **regular-file** login state such as
`~/.claude/.credentials.json`. A **login-keychain-only** account cannot be
discovered from the isolated worker under required Seatbelt containment, so
Headless returns `NATIVE_AUTH_UNAVAILABLE` rather than forwarding
`CLAUDE_CODE_OAUTH_TOKEN`, exposing the real `HOME`, or exporting keychain data.
If your Claude login is keychain-only, use broker mode (`--auth-mode broker`) or
establish a regular-file login.

### OpenCode

When `--model` is omitted, Headless performs a bounded, canonical, no-symlink
read of `~/.config/opencode/opencode.json` (or `.jsonc`), validates only its
scalar `model`, and passes that value explicitly. It does not copy or activate
the host config, so OpenCode plugins, MCP servers, commands, and permissions
cannot become worker configuration. Missing, malformed, oversized, linked,
non-owner, or unsafe defaults return `NATIVE_AUTH_UNAVAILABLE` before OpenCode
starts; pass `--model` explicitly in that case.

### Grok Build

The Grok adapter implements read/write and resume, but current Grok releases
cannot yet satisfy Headless's required lifetime containment invariant — they can
discover project controls (configuration, startup hooks, MCP servers, skills)
created after launch. Required Grok runs therefore fail closed before
authentication or subprocess launch.

### Codex

Codex combines its own native sandbox with explicit disables for project
plugins, hooks, apps, browsers, hidden subagents, MCP skill dependencies, and
both repository skill roots.

## Approval policy

Approval policy is independent of authentication and is set per run, per fleet,
or with `/policy` in the control room:

- **`ask`** creates a durable approval before each mutating coder turn and again
  before candidate integration.
- **`auto`** resolves coder-tool requests from Headless policy and integrates
  only after every configured gate passes.
- **`bypass`** selects the coder's noninteractive approval mode **inside** the
  outer sandbox. It never bypasses project trust, filesystem or credential
  scope, budgets, worktree isolation, clean-primary checks, finality, or merge
  authority. It is not the `--unsafe-no-sandbox` containment escape hatch.

## Verifying your environment

`headless doctor` reports whether each backend is present on `PATH`, the
authenticated principal, and where external state lives. It does not launch a
backend; use a bounded `headless exec --backend <id> "Reply READY"` to confirm
an end-to-end run.
