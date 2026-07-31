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
- Product Gate P (`docs/product-gate.md`) is the UX oracle; security gates A/B/C live in `docs/plan.md`. Current tree is unpublished private beta — not alpha.
- When in doubt, ask peer via ContextRelay handoff/deliberate before large design changes.

Current coordinator: human / you decide per session.

<!-- contextrelay:start -->
## ContextRelay Collaboration

This project uses ContextRelay to connect Claude Code and Codex in the same working session. Use ContextRelay when you are blocked or uncertain, when the peer agent is better suited, when you want a second review, implementation, test, or debugging help, or when you would otherwise stop to ask the human a planning question the peer can help answer first.

Current coordinator: Codex.
Codex should coordinate: planning and task routing, focused implementation, tests and debugging, and git writes when runtime permissions allow it and the human has approved this repo policy.
Claude should support Codex with: repo-wide reasoning and architecture review, risk review before large changes, alternative approaches, and delegated implementation or debugging tasks.

Git write policy: git writes belong to the current coordinator (Codex) or the human. Codex may handle branch, commit, merge, push, and PR work only when runtime permissions allow it and the human has approved that policy. Non-coordinator agents use read-only git commands and hand off git-sensitive work to Codex or the human.

Ask the coordinator for work, don't sit idle:
- When you finish a task, get blocked, or go idle, proactively ask Codex (the coordinator) for the next task — say what you finished and that you are ready for more. Do not wait silently.
- To ask: Claude uses `handoff` (or `reply`); Codex uses `handoff_to_claude` (or `send_to_claude`).

Handoffs are explicit: state the reason, the concrete ask, relevant files or context refs, and who should speak next.

Autonomous decision flow:
- When you are unsure about a plan, tradeoff, design choice, risk, or next step, ask the peer agent for a bounded deliberation before asking the human. Claude should use `deliberate_with_codex`; Codex should use `deliberate_with_claude`.
- Ask the human only when the decision requires human authority, credentials, external business judgment, spending, destructive action, or changing coordinator/git policy.
- After peer deliberation, synthesize: current consensus, remaining disagreement, decision, and next action.

Useful ContextRelay tools for Claude:
- `handoff` to delegate to Codex; `reply`, `get_messages`, and `wait_for_messages` for live communication.
- `deliberate_with_codex` for a bounded live debate/convergence pass on an open decision.
- `contained_run` for a one-shot, read-only reviewer through a contained adapter. Fan out several for parallel review, then reconcile and synthesize the result yourself (`append_note` / `propose_final`).
- `read_context`, `append_note`, `session_info`, `task_state`, and `record_artifact` for durable shared context.
- `propose_final` when work appears complete.

Agents cannot see each other's hidden reasoning — write goal, current plan, files touched, blockers, decisions, and next step into messages or the ledger. Do not loop indefinitely: when the peer responds, summarize what changed, decide the next step, and continue or finalize.
<!-- contextrelay:end -->
