---
id: tui
title: Tracking runs in the TUI
sidebar_position: 2
---

# Tracking runs in the TUI

```bash
headless tui --cwd /path/to/project
```

The TUI is a **read-only observer**: it can watch, never drive. It
authenticates with a dedicated observer credential and reads only the
`observer.snapshot` and `observer.events` daemon routes — the daemon rejects
every mutation attempted with that credential. It may start the project daemon
if one is absent, but it cannot start providers, dispatch runs, activate goals
or workflows, resolve approvals, integrate candidates, or change policy. All
of that stays in the root CLI and the attached foreground lead.

Requirements: a terminal of at least 60×20. Below that the TUI shows
`Terminal too small for the observer.` and waits — the daemon and any detached
work keep running. At 24 rows and above, every view adds one blank row between
the shared chrome and its content; shorter terminals retain the dense layout.

## The chrome

Top to bottom, every view shares the same frame:

- **Header** — the `◆ HEADLESS` brand on the left (the version string appears
  from 132 columns). On wide terminals (116 columns and up) the seven view
  tabs render inside the header row itself; on narrower terminals they drop to
  a compact tab row directly beneath it. Each tab is labelled with its jump
  digit, for example ` 1 overview `; the active tab is highlighted inverse.
  Tabs can carry live badges: the approvals tab counts pending approvals
  (`approvals·2`) and the events tab counts stderr output and non-succeeded
  completions.
- **Status dot and counts** — the right side of the header shows a colored
  connection dot plus the connection state (`CONNECTED`, `RECONNECTING`,
  `DISCONNECTED`). From 120 columns it adds compact ready/blocked backend
  counts (`R2 B1`); from 150 columns it spells them out
  (`ready:2 · blocked:1`).
- **Status strip** — one line above the footer: `ready`, `working`, or
  `error`, followed by the latest observer status message (including reconnect
  reasons).
- **Footer** — context-sensitive key hints on the left, version and copyright
  on the right.

The snapshot refreshes automatically every 2 seconds and over a live event
subscription; `r` forces a refresh. If the daemon connection drops, the
observer keeps retrying and says so in the status strip.

## The seven views

| # | View | What it shows |
| --- | --- | --- |
| 1 | Overview | The home summary: topology, health, current task, next actions, recent activity |
| 2 | Fleet | Backend and agent readiness with identity colors, trust acknowledgement, and login guidance |
| 3 | Goals | Goal lifecycle with state glyphs, detail, and the active goal's timeline |
| 4 | Approvals | Pending human decisions, with the exact CLI command to resolve them |
| 5 | Events | The live, redacted run-event stream with per-kind tones and filters |
| 6 | Config | The daemon/project configuration snapshot plus copyable shell commands |
| 7 | Help | Key reference and useful root-CLI commands |

### 1 — Overview

The landing view, titled `OBSERVER OVERVIEW · durable projected state`. It
summarizes topology (connection, project, orchestrator, fleet, lead), health
(daemon readiness, project trust, ready/login/blocked backend counts, queue
depth, pending approvals), the current goal (id, status, mode, lead, stage),
a "Next actions" list where each entry names the exact command to run and why,
and a grouped recent-activity feed. It also states the operating model
plainly: external lead, authenticated daemon, contained workers — this TUI
only observes. Project trust without native-login permission and the explicit
unrestricted-egress acknowledgement is shown as `native consent required`,
not as fully ready. When the terminal can fit every Overview group plus one
activity row, the major groups gain one blank row of separation.

### 2 — Fleet

A two-pane view: the agent list on the left (readiness glyph, agent name,
backend, auth mode), a detail pane on the right (active profile, approval
policy, auth mode, worker/queue limits, and the selected agent's readiness).
Each of the four advertised backends renders in a stable identity color
wherever it is named — Claude orange, Codex blue, OpenCode green, Grok violet
— so the fleet reads at a glance. When an agent shows `Login required`, the
detail pane preserves the daemon's mode-specific reason: broker mode names the
missing daemon credential; native-login shows the supported provider login or
setup-token remedy. Missing native egress acknowledgement instead appears as
`Trust required`; the detail pane shows the exact trust command supplied by
the daemon and suppresses provider-login instructions. Trust-gated agents
count as blocked, not logged out. The TUI never runs a login or reads a
credential value.
Multiple profiles are listed with a reminder that switching happens through
the root CLI.

### 3 — Goals

Goals on the left, detail on the right. Every goal carries a lifecycle glyph:
`○` queued, `◔` planning, `◑` delegating, `●` active, `◕` critiquing, `◍`
gating, `◉` waiting approval, `◎` integrating, `✓` succeeded, `✗` failed, `⊘`
cancelled, `◷` timed out. The detail pane shows state, mode (write mode is
highlighted as a warning), synthesizer, owner, a plain-language phase label,
the expected next transition, and the objective. For the active goal it also
renders a live timeline of turns and messages. Press `h` to cycle the history
mode between `recent`, `all`, and `grouped`.

### 4 — Approvals

A table of pending approvals — id, kind, requester, age, summary — with a
detail panel for the selected row, including its expiry when one exists. The
panel prints the resolve hint verbatim:

```text
resolve  headless experimental approval resolve --approval-id <id> …
```

Resolution happens only via the CLI (`--decision approved|rejected` plus a
required `--resolution` note); the TUI can only show you what is waiting.

### 5 — Events

The live run-event stream, newest at the bottom, each line toned by kind:
lifecycle blue, stdout muted, stderr amber, policy decisions green or amber,
tool use cyan, artifacts green, usage violet, completions green/red by
outcome. The section header states the current position (`live` or
`scrollback <n>`), the display mode, the active filter, and shown/total
counts. Keys inside this view: `e` toggles the errors filter, `a` the
activity filter, `g` toggles grouping of repeated events, arrows or the mouse
wheel scroll, PgUp/PgDn page. The same durable projection is available in the
shell via `headless experimental events`.

### 6 — Config

The observer configuration snapshot, explicitly labelled
`state only · this process cannot mutate project configuration`: project path,
trust state, lead binding, daemon state, worker delegations, per-backend
readiness, and configured budgets. The right column, "Run from your shell",
generates exact root-CLI commands for the changes you might want to make —
and the header says it plainly: the TUI never executes them.

### 7 — Help

The observer contract in one screen — what the TUI reads, what it will never
do — plus the key bindings and a short list of useful root-CLI commands
(`headless lead status`, `headless experimental goal list`,
`headless experimental approval list`, and friends).

## Navigation

Keyboard:

- `1`–`7` jump straight to a view.
- `Tab` / `Shift-Tab` cycle forward/backward through the views.
- `Esc` returns to Overview (from Overview it quits).
- Arrow keys or `j`/`k` move the row selection in Fleet, Goals, and
  Approvals, and scroll the Events feed; `PgUp`/`PgDn` page Events.
- In Events, `e` toggles errors-only, `a` toggles activity-only, and `g`
  toggles grouping. Change compact/verbose/strict rendering from a shell with
  `headless experimental events --display-mode <mode>`; the TUI has no log-mode
  mutation key.
- In Goals, `h` cycles recent, all, and grouped history. Selection only
  highlights a row; the live timeline follows the daemon's already-active
  goal and `Enter` does not activate one.
- `r` refreshes the observer snapshot.
- `q` (on empty input) or `Ctrl-C` quits the client without stopping the
  daemon or any detached work.

Mouse (SGR mouse reporting is enabled while the TUI runs and restored on
exit):

- Click a tab to switch views.
- Click a list row to select it.
- Wheel scrolls the Events feed and moves list selections.

## Typical watch workflows

**Kick off a goal in one terminal, watch it in another.**

```bash
# terminal 1
headless experimental goal start --cwd "$PROJECT" --detach -- "Analyze the fixture."

# terminal 2
headless tui --cwd "$PROJECT"
```

Press `3` to watch the goal's lifecycle glyph advance and its timeline fill,
and `5` to watch the raw event stream. When the goal needs a human decision,
the approvals badge lights up; press `4`, read the summary, and resolve it
from a shell with the exact command the panel shows you.

**Watch fleet readiness while you fix logins.** Keep the TUI on view `2`
while you run provider logins and `headless experimental fleet profile`
changes in a shell; press `r` after each change and watch the readiness dots
and auth column update.

**Audit a risky run.** Start an `exec` in one terminal and watch view `5` in
another: stderr lines render amber, policy denials stand out, and a run
executed with `--unsafe-no-sandbox` remains visible in the durable projection
and its receipt.

## Honest limits

- The Fleet, Goals, Approvals, and Events views project **experimental**
  daemon surfaces — their CLI counterparts live under
  `headless experimental` and may change before their release gate. The
  observer contract itself (read-only, snapshot plus events) is Beta 1.
- The TUI has no prompt, command palette, provider login, run dispatch,
  approval resolution, candidate integration, policy mutation, or provider
  cancellation — by design, not omission.
- Help is view `7`; there is no separate `?` shortcut.
