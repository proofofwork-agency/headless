---
id: control-room
title: Control room (TUI)
---

# Control room (TUI)

`headless tui` (alias `hless tui`) opens the **control room**, an
[Ink](https://github.com/vadimdemedes/ink) terminal UI that drives the same
authenticated daemon as every other client. It requires an interactive terminal
and the project's one-time trust grant; native login, approval policy, and fleet
selection resolve exactly as they do on the CLI.

```bash
headless tui              # current directory as the project root
headless tui --cwd /path/to/project
```

The control room is a **live** surface: it subscribes to bounded, redacted
daemon events and refreshes automatically, and the prompt stays editable while
the daemon reconnects. It never weakens the daemon's guarantees — every command
is an authenticated RPC, every update is redacted and size-bounded, and it
cannot select an arbitrary project root or principal.

## Views

Switch views with `tab` / `shift+tab`, the number keys `1`–`6`, `←` / `→` when
the prompt is empty, or a mouse click on the tab bar.

| # | View | Shows |
| --- | --- | --- |
| 1 | **Overview** | Fleet, active goal, pending approvals, and the inspected candidate as cards, above a merged activity feed of turns, messages, and run events. |
| 2 | **Fleet** | The active profile's agents (health, backend, auth, load) beside a detail pane; other profiles are listed for `/use-fleet`. |
| 3 | **Goals** | Every known goal with its state glyph, plus the selected goal's objective, leader, and turn/message timeline. |
| 4 | **Approvals** | The pending approval queue with the selected entry's detail and the exact `/approve` and `/deny` forms. |
| 5 | **Events** | The live, redacted ledger feed with scrollback. |
| 6 | **Help** | The command palette and keybindings, rendered in-app. |

## Keybindings

| Key | Action |
| --- | --- |
| `tab` / `shift+tab` | next / previous view |
| `1`–`6` | jump to a view (empty prompt) |
| `←` / `→` | switch views (empty prompt) |
| `↑` / `↓` | select rows · scroll the event feed |
| `pgup` / `pgdn` | page the event feed |
| `⏎` | submit the prompt · activate the selected row |
| `esc` | clear the prompt, then leave scrollback, then return to Overview |
| `q` | quit (empty prompt) |
| `ctrl+c` | quit |
| mouse | click tabs and rows · wheel scrolls |

## Command palette

Free text with no leading `/` is sent to the **active goal's coordinator**,
starting a read-only goal when none is active. Slash commands mirror the CLI:

| Command | Effect |
| --- | --- |
| `/goal <objective>` · `/goal-write <objective>` | start a read-only or gated write goal |
| `/use-goal <id>` · `/cancel-goal [id]` | switch or cancel the active goal |
| `/leader <agent-id>` · `/send <text>` | transfer leadership · send a coordinator turn |
| `/ack-message <id…> [--retain]` | acknowledge mailbox entries, pruning by default |
| `/fleet` · `/use-fleet <id>` | refresh, or activate a persisted fleet profile |
| `/policy ask\|auto\|bypass` | set the active fleet's approval policy |
| `/trust status\|grant\|revoke` | manage project trust |
| `/approve <id> [reason]` · `/deny <id> [reason]` | resolve a pending approval |
| `/candidate <id>` · `/integrate <id>` · `/reject-candidate <id>` | inspect, integrate, or reject a candidate |
| `/autonomy on\|off` · `/dispatch [backend] [prompt]` | toggle the orchestrator · queue a contained read-only run |
| `/council <question>` · `/gate` · `/workflow <id>` | run a council · run the release gate · show workflow progress |
| `/claim <task-id>` · `/pair` · `/doctor` | claim durable work · pair · one-line connection summary |
| `/status` · `/help` · `/quit` | daemon summary · palette · exit |

## Design

The control room uses a flat, border-free chrome. Content panels are shaded with
a neutral dark **SURFACE** so each view reads as a raised area; the active tab
takes the same SURFACE fill with a bold, underlined label so it visually
connects to its panel; and the selected list row sits one elevation above the
panel with a teal accent caret. The presentation is split into pure, testable
layout and model builders (`src/tui/layout.ts`, `src/tui/model.ts`) separate
from the Ink components (`src/tui/components.tsx`, `src/tui/views.tsx`), and SGR
mouse reporting drives hit-tested tabs and rows.

## Requirements and behavior notes

- The control room requires an **interactive terminal**. Ink uses raw-mode stdin
  for keyboard and mouse input; running it without a TTY (for example, piping
  stdin in a script) is not supported.
- Native login still applies: a project must be trusted, and each backend's auth
  rules (see [Backends and authentication](./backends-and-auth.md)) hold exactly
  as on the CLI.
- All updates are redacted and bounded before display — the same protection
  applied to CLI output, ledger writes, and MCP/plugin responses.
