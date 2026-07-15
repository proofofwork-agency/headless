# AGENTS.md — Headless project

Follow the spirit of OpenCode's AGENTS.md (cloned in `opencode/AGENTS.md`) and the local ContextRelay conventions.

## Core Principles (keep it simple)
- One function at a time unless clear reuse.
- Prefer Bun APIs.
- Effect when it adds value; don't force it early.
- Type inference over explicit annotations.
- Small focused files.

## For this project
- The goal is a **universal headless runner + orchestrator**.
- Prioritize reliable contained execution + structured results + cost attribution.
- Ledger / worktree / policy should come from or stay compatible with ContextRelay.
- First make `headless exec` rock-solid for opencode + parity for claude/codex.
- Then layer superpowers, fleets, workflows.

See `docs/analysis-opencode.md`, `docs/analysis-contextrelay-reuse.md`, and the approved plan in the session dir.

<!-- contextrelay:start -->
## ContextRelay Collaboration

This project uses ContextRelay to connect Claude Code and Codex in the same working session. Use ContextRelay when you are blocked or uncertain, when the peer agent is better suited, when you want a second review, implementation, test, or debugging help, or when you would otherwise stop to ask the human a planning question the peer can help answer first.

Current coordinator: Claude.
Codex should ask Claude for: planning and coordination, repo-wide reasoning, and risk review before large changes.
Claude should ask Codex for: focused implementation, tests or debugging, code review and logic checks, and alternative approaches.

Git write policy: git writes belong to the current coordinator (Claude) or the human. Non-coordinator agents use read-only git commands and hand off git-sensitive work to Claude.

Ask the coordinator for work, don't sit idle:
- When you finish a task, get blocked, or go idle, proactively ask Claude (the coordinator) for the next task — say what you finished and that you are ready for more. Do not wait silently.
- To ask: Claude uses `handoff` (or `reply`); Codex uses `handoff_to_claude` (or `send_to_claude`).

Handoffs are explicit: state the reason, the concrete ask, relevant files or context refs, and who should speak next.

Autonomous decision flow:
- When you are unsure about a plan, tradeoff, design choice, risk, or next step, ask the peer agent for a bounded deliberation before asking the human. Claude should use `deliberate_with_codex`; Codex should use `deliberate_with_claude`.
- Ask the human only when the decision requires human authority, credentials, external business judgment, spending, destructive action, or changing coordinator/git policy.
- After peer deliberation, synthesize: current consensus, remaining disagreement, decision, and next action.

Idle scanner:
- The daemon may detect idle opportunities deterministically from the ledger and daemon state; agents do not run the scanner.
- `suggest` and `ask` record pull-visible `idle_opportunity` task lanes only; no live prompt is pushed.
- Handle or dismiss an idle-opportunity lane by recording a reply/note with `handles_handoff_id` set to the lane id.
- `act` may also dispatch bounded read-only workers, a read-only mini-fleet, or a contained act:write worker only when the write surface is enabled with a positive budget, the internal kind/owner policy matches, strict dual-idle holds, and containment gates all pass.
- Treat scanner lanes and worker outputs as suggestions and evidence. Outside an explicitly dispatched contained act:write worker, do not edit files, run git writes, publish, kill or restart daemons, spend beyond the configured opt-in, or take destructive/outward actions without human authority.

Useful ContextRelay tools for Codex:
- `handoff_to_claude` to delegate to Claude (set `wait_for_reply: true` for validation requests); `send_to_claude` for a direct message; `wait_for_claude` for an explicit follow-up wait.
- `deliberate_with_claude` for a bounded live debate/convergence pass on an open decision.
- `headless_run` for a one-shot, read-only reviewer through a contained adapter. Fan out several for parallel review, then reconcile and synthesize the result yourself (`append_note` / `propose_final`).
- `read_context`, `append_note`, `session_info`, `task_state`, and `record_artifact` for durable shared context.
- `ask_claude_backup` for read-only backup analysis; `backup_status` to inspect it.
- `propose_final` when work appears complete.

If Codex MCP tools are unavailable, use these fallback markers at the very start of a message:

```text
[IMPORTANT] CONTEXTRELAY_READ_CONTEXT: <optional focus>
[IMPORTANT] CONTEXTRELAY_TASK_STATE
[IMPORTANT] CONTEXTRELAY_NOTE: <note>
[IMPORTANT] CONTEXTRELAY_ARTIFACT:
kind: patch_summary|test_report|command_log|release_gate|escalation_suggestion|idle_opportunity|idle_ask_for_work|idle_action_result|idle_fleet_result|idle_evaluation_result|idle_write_result|headless_result
title: <short title>
summary: <what happened>
status: passed|failed|blocked|unknown|skipped|timed_out
evidence:
- <optional evidence>
[IMPORTANT] CONTEXTRELAY_HANDOFF_TO_CLAUDE: <ask>
[IMPORTANT] CONTEXTRELAY_PROPOSE_FINAL:
summary: <what is complete>
evidence: <why it is complete>
remaining_risk: <optional risk>
[IMPORTANT] DONE: <summary>
[HUMAN] <human-directed side note that should not be delivered as Claude-actionable context>
```

Agents cannot see each other's hidden reasoning — write goal, current plan, files touched, blockers, decisions, and next step into messages or the ledger. Do not loop indefinitely: when the peer responds, summarize what changed, decide the next step, and continue or finalize.

Backup-agent triggers are explicit only:

```text
[IMPORTANT] ASK_CODEX_BACKUP: <read-only help request>
[IMPORTANT] ASK_CLAUDE_BACKUP: <read-only help request>
```

Only use backup triggers when ContextRelay autonomy is enabled. Backup agents are read-only and should not be used for normal implementation handoff.
<!-- contextrelay:end -->
