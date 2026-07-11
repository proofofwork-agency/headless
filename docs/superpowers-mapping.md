# Superpowers Mapping: Claude Features → All Backends

> Design backlog only. This document maps possible future abstractions; it is not a list of implemented or release-verified v0.2 capabilities. Current contracts and limits are in the README, SECURITY.md, and `docs/plan.md`.

Goal: Make using Codex / OpenCode / Grok feel like you have Claude's best power tools (ultrathink, ultraplan, dynamic workflows/agents/loops, skills, etc.).

## Core Claude "Cool Stuff"

- **ultrathink** — Magic word that bumps thinking budget to max (~32k tokens). Hard-coded detection in Claude Code.
- **Plan mode + Ultraplan** — Read-only exploration + (in newer) offload planning to cloud Claude in plan mode.
- **Ultracode / high effort + dynamic orchestration** — High reasoning + automatic spawning/coordination of sub-agents for big tasks.
- **Agents / sub-agents** — Specialized persistent or one-shot agents.
- **Workflows / custom commands / Skills / Hooks** — Project or user-defined automation, reusable procedures.
- **Loops** — Autonomous iteration with gates (plan → code → review → verify).
- **Handoffs + Deliberation** — Structured multi-agent collaboration (already strong in ContextRelay).

## Mapping Table (as of 2026-07-09)

| Feature              | Claude Code                          | OpenCode                                      | Codex (OpenAI)                     | Grok (this env)          | Headless Emulation / Strategy                                                                 |
|----------------------|--------------------------------------|-----------------------------------------------|------------------------------------|--------------------------|-----------------------------------------------------------------------------------------------|
| ultrathink / max thinking | "ultrathink" magic word + effort     | `--variant high/max` + thinking blocks + model choice | High reasoning effort in prompt/model | Via system/effort params | Unified flag `--effort max` or "ultrathink" prefix. Route to variant or add heavy system prompt. Dedicated high-reason worker. |
| Plan / Ultraplan     | Plan mode + cloud ultraplan          | `plan` agent (`--agent plan`), Tab switch, dedicated plan prompts/tools | Prompt engineering + "think step by step" + separate call | Similar                   | `--mode plan` or `--agent plan`. Always capture as structured `plan_artifact`. Can offload planning to strongest backend. |
| High effort + sub-agents | Ultracode dynamic sub-agents         | `@general` subagent + internal orchestration  | Limited (function calling + multi-turn) | Limited                   | First-class `subagent` primitive in workflow engine. Map to OpenCode @general or spawn fresh headless/live on best backend. |
| Agents / Roles       | Custom agents                        | Built-in build/plan + custom via config/skills | Prompt + tools                    | Prompt + tools           | Portable agent/role definitions. Director can assign tasks to named roles on specific engines. |
| Workflows / Commands / Skills | Custom slash, Skills, hooks         | Custom commands, skills, plugins, MCP         | Limited (custom GPTs outside)     | MCP + skills in this env | Unified `Skill` / `Workflow` YAML+TS representation. Apply via grounding or dedicated runner. Continuous-learning extraction. |
| Autonomous loops     | Via skills / projects                | Via TUI + sessions                            | Via custom harnesses              | This orchestrator        | Autoloop / fleet engine (inspired by Claw + CR idle + autonomous-loops skill). Planner → parallel coders → reviewers → gate. |
| Handoff / Deliberate | Via ContextRelay                     | Via ContextRelay or future native             | Via ContextRelay MCP              | Via ContextRelay / this  | Already excellent via CR. Expose uniformly. |
| Contained review     | `claude -p` + limited tools          | `run --pure` + config deny + sandbox          | `codex exec --sandbox read-only`  | TBD                      | Unified `headless_run --backend X --mode read-only`. CR adapter registry is the model. |

## Implementation Notes for Headless

1. **Capability detection** on each Engine:
   - `supports.planMode`, `supports.variant`, `supports.subagent`, `supports.highEffort`, `supports.write`, `supports.streamJson`, `parseCostTokens`.

2. **Grounding + Translation layer** (`superpowers/`):
   - `ultrathink.ts`: injects "Think extremely carefully..." + sets max effort/variant.
   - `plan.ts`: chooses agent or special prompt; returns canonical Plan shape (goals, steps, files, risks, verification).
   - Always wrap user intent with "You are operating as part of Headless fleet. ..."

3. **Workflow engine** owns the "Ultracode experience":
   - User says "ultracode the auth refactor".
   - System decomposes, spawns plan on best (or specified), then parallel impls, then review fleet, verification (tests + headless review + perhaps chrome e2e), synthesis.

4. **Director mode** (the "single AI coder that can do everything"):
   - A high-level agent (running on strongest available backend) that uses the runner + workflows + ledger as its tools.
   - Feels like one persistent genius that can "think hard", "plan in the cloud", spawn specialists, etc.

5. **Portability**:
   - Extract successful patterns into reusable skills that travel between backends.
   - When a backend lacks a feature, the orchestrator compensates (e.g., manual plan capture + review before allowing writes).

## OpenCode Advantages We Can Lean On

- Explicit `--agent plan`.
- `--variant` for effort (very close to effort controls).
- Strong pure / config-deny for reviewers.
- Open source → we can study and improve the adapter deeply (we did via the clone).
- Already has subagent and skill concepts.

## Codex Advantages

- Excellent `exec --sandbox read-only` and `workspace-write`.
- Fast for focused implementation.
- Good JSON streaming.

## Next

- Use this table to drive `src/superpowers/` and the `Engine` capability interface.
- Validate with concrete experiments once the first runner slice exists.

*Initial draft — will be updated as implementation reveals more precise mappings.*
