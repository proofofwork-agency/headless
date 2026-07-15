# Headless Project Collaboration Rules

This project uses (or will integrate with) ContextRelay for coordination when multiple agents (Claude, Codex, OpenCode, Grok) work together.

## Git
- Feature branches + PRs. No direct main pushes.

## Local dev
- Bun is the runtime.
- `bun run check`, `bun run build`.
- Use `bun src/cli.ts exec ...` during development.

## Headless focus
- All new code should make it easy and safe to run coding agents headlessly.
- Containment and auditability (ledger) are non-negotiable.
- When in doubt, ask peer via ContextRelay handoff/deliberate before large design changes.

Current coordinator: human / you decide per session.

<!-- contextrelay:start -->
## ContextRelay Collaboration

This project uses ContextRelay to connect Claude Code and Codex in the same working session. Use ContextRelay when you are blocked or uncertain, when the peer agent is better suited, when you want a second review, implementation, test, or debugging help, or when you would otherwise stop to ask the human a planning question the peer can help answer first.

Current coordinator: Claude.
Codex should ask Claude for: planning and coordination, repo-wide reasoning, and risk review before large changes.
Claude should ask Codex for: focused implementation, tests or debugging, code review and logic checks, and alternative approaches.

Git write policy: git writes belong to the current coordinator (Claude) or the human. Non-coordinator agents use read-only git commands and hand off git-sensitive work to Claude.

Keep the peer fed, you are the coordinator:
- When Codex reports idle, finishes a task, or asks for work, assign the next concrete task or explicitly park Codex. Do not leave the peer idle without direction.

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

Useful ContextRelay tools for Claude:
- `handoff` to delegate to Codex; `reply`, `get_messages`, and `wait_for_messages` for live communication.
- `deliberate_with_codex` for a bounded live debate/convergence pass on an open decision.
- `headless_run` for a one-shot, read-only reviewer through a contained adapter. Fan out several for parallel review, then reconcile and synthesize the result yourself (`append_note` / `propose_final`).
- `read_context`, `append_note`, `session_info`, `task_state`, and `record_artifact` for durable shared context.
- `ask_codex_backup` for read-only backup analysis; `backup_status` to inspect it.
- `propose_final` when work appears complete.

Agents cannot see each other's hidden reasoning — write goal, current plan, files touched, blockers, decisions, and next step into messages or the ledger. Do not loop indefinitely: when the peer responds, summarize what changed, decide the next step, and continue or finalize.

Backup-agent triggers are explicit only:

```text
[IMPORTANT] ASK_CODEX_BACKUP: <read-only help request>
[IMPORTANT] ASK_CLAUDE_BACKUP: <read-only help request>
```

Only use backup triggers when ContextRelay autonomy is enabled. Backup agents are read-only and should not be used for normal implementation handoff.
<!-- contextrelay:end -->
