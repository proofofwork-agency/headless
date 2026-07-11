# TUI + CLI test report — 2026-07-11

Autonomous test pass of the Headless v0.2 control-room TUI and CLI on the
`feat/tui-control-room` branch. All runs used the branch source
(`bun src/cli.ts …`) against a real daemon.

## Method

- **Isolated project:** a throwaway git repo as the canonical root, its own
  daemon, its own external state. No shared state was touched.
- **Real backends:** `opencode`, `claude`, `grok` (Codex skipped — out of
  credits). `headless doctor` confirmed all four present on `PATH`.
- **Layers exercised:** CLI command surface; TUI command logic driven through
  the real `TuiController` against the live daemon; TUI render via an Ink
  frame-capture harness; and a PTY boot of `headless tui`.

## CLI command surface — all functional

| Command | Result |
| --- | --- |
| `doctor` | ✅ boots daemon, reports project id/root/principal, backends, state dir |
| `project trust status/grant` | ✅ grant → `trusted: true, nativeLoginAllowed: true` |
| `daemon status`, `status`, `events`, `init` | ✅ all return structured output |
| `fleet health`, `fleet profile list/get/upsert/remove` | ✅ upsert validated after dropping daemon-managed fields; `fleet-default` auto-provisioned |
| `goal start/list/status/cancel` | ✅ goal created (`planning`), listed, statused, cancelled |
| `collaboration turns` | ✅ returns turns for a goal |
| `session create/status/cancel` | ✅ durable session lifecycle |
| `approval list` | ✅ (`[]` empty) |
| `candidate inspect` (missing) | ✅ correct `Unknown candidate` error |
| `autonomy status`, `workflow list`, `mcp status` | ✅ |

**Trust gate verified fail-closed:** before trust, native-login `exec` returned
`NATIVE_AUTH_UNAVAILABLE` ("Native login requires one-time project trust"). The
denial is recorded in the ledger as a `policy: denied` event.

**Strict fleet schema:** `fleet profile upsert` rejects `projectId`,
`createdAt`, `updatedAt` as unrecognized keys — those are daemon-managed and
must be omitted from the profile JSON.

## Backend execution

| Backend | Required containment | `--unsafe-no-sandbox` |
| --- | --- | --- |
| **opencode** | ❌ "Backend version probe failed" under Seatbelt | ✅ **succeeded** — returned `READY`, exit 0, usage 1929/3 |
| **claude** | ❌ `NATIVE_AUTH_UNAVAILABLE` — keychain-only login, no regular-file creds | ❌ same (adapter requires regular-file state) |
| **grok** | ❌ refused — grok-build "does not disable: project configuration, startup hooks, project MCP servers, project skills" | ⚠️ launched, then grok-CLI internal error (`auto_background_on_timeout requires enabled_background`) |

**Pipeline proven end-to-end:** the opencode unsafe run went dispatch → sandbox
decision → backend launch → real model response → structured result. The
required-containment blocks are **documented, fail-closed behaviors** (see
README "Authentication and approvals" / "Containment model"), not command bugs:

- **claude** — keychain-only login is unsupported in required containment;
  Headless refuses rather than exposing `HOME`/keychain. Confirmed no
  `~/.claude/.credentials.json` exists.
- **grok** — current Grok can discover late-created project controls, so
  required runs fail closed.
- **opencode** — the capability/version probe fails **under the sandbox** though
  `opencode --version` succeeds unsandboxed. This is the one finding that looks
  environment/containment-specific and is worth a follow-up (does the Seatbelt
  profile deny something the opencode version probe needs?).

## TUI

- **Render (all six views):** an Ink frame-capture harness rendered Overview,
  Fleet, Goals, Approvals, Events, Help plus the chrome at widths 72–100. Layout
  is intact; the new darker-area colors (SURFACE panels, active-tab fill,
  tinted selection, teal caret) verified present in the raw ANSI.
- **Command logic (driven against the live daemon):** the real `TuiController`
  was fed the exact prompt strings a user types. Every command routed and
  reported correctly: `/help`, `/status`, `/trust status`, `/fleet`,
  `/use-fleet test-fleet` (activated), `/policy auto` + `/policy ask` (both set),
  `/goal …` (started a goal, "free text now goes to its coordinator"),
  `/candidate nonexistent` (clean `Unknown candidate`), `/ack-message`/`/leader`
  (correct usage guards), free text (auto-started a goal), `/quit` (exit). State
  updated live (fleet with 3 agents, goals, active goal).
- **Boot:** `headless tui` launched in a PTY, initialized Ink and the React
  reconciler, then stopped only at "Raw mode is not supported" because the
  background job has no interactive stdin TTY. Expected — the TUI requires a
  real terminal.

## Visual change

Tabs/areas were redesigned to match the tpn TUI's "darker color to highlight
areas": content panels are shaded with the neutral dark `SURFACE`, the active
tab takes the same SURFACE fill with a bold underlined label, and selected rows
sit one elevation above with a teal accent caret. Layout grid and tab hit-test
columns are unchanged, so the 10 TUI unit tests and mouse hit-testing are
unaffected. `bun run check` (512 tests) and `bun run build` stay green.

## Known limitations / follow-ups

1. **opencode version probe under required containment** — investigate what the
   Seatbelt read profile denies during the probe; opencode runs fine unsafe.
2. **claude native login** needs regular-file credentials on this machine
   (keychain-only today) or broker mode.
3. **grok** stays fail-closed under required containment by design until
   late-created project controls can be denied.
4. **TUI leaks daemons in tests** — a prior state left ~160 `daemon serve`
   processes from temp-project test runs; cleaned up during this pass. Worth a
   test-teardown fix.
