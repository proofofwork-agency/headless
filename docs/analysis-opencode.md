# OpenCode Analysis (cloned 2026-07-09)

**Source**: `opencode/` (shallow clone of https://github.com/anomalyco/opencode , dev branch at time of clone).
**Purpose**: Deep understanding to design best headless runner adapter, feature mapping (ultrathink / ultraplan / agents / workflows), and potential extension points for the Headless project.

## High-Level Structure (Monorepo)

- Root uses **Bun + Turbo** (`turbo.json`, `bunfig.toml`, `package.json`).
- **packages/** is the heart:
  - `opencode/` — The main runtime + CLI binary (`bin/opencode`). ~400 src files. This is the "engine".
    - `src/cli/cmd/run.ts` + `src/cli/cmd/run/*` — Non-interactive "headless" entrypoint.
    - `src/cli/cmd/tui.ts` etc.
  - `core/` — Heavy shared logic (Effect-heavy, Drizzle/SQLite storage, sessions, etc.).
  - `tui/` — Terminal UI (Solid/TSX?).
  - `cli/`, `server/`, `llm/`, `protocol/`, `sdk/`, `sdk-next/`, `plugin/`, `desktop/`, `app/`, `console/`, `web/`, etc.
- Other top-level: `script/`, `specs/`, `sdks/vscode/`, `patches/`, `nix/`, `infra/`.

Key entry: `packages/opencode/bin/opencode` (the installed `opencode` command).

## Agents & Modes (Critical for "superpowers")

From README + source:
- **Built-in agents** (switch with `Tab`):
  - `build` (default, full access).
  - `plan` (read-only by default; analysis & planning).
- **Subagents**: `@general` for complex multi-step / searches. Defined in `src/agent/`.
- Plan mode is a first-class concept:
  - Special prompts in `src/session/prompt/plan*.txt`, `plan-mode.txt`, `plan-enter.txt` / `plan-exit.txt` in tools.
  - Tool `src/tool/plan.ts`.
- `--agent <name>` flag on CLI (including `run`).
- Strong support for "plan first, then build".

This maps very well to Claude's Plan mode + Ultraplan.

## Headless / Non-Interactive Usage (`opencode run`)

From `packages/opencode/src/cli/cmd/run.ts` (and related):
- Primary headless path: `opencode run [prompt]`
- Important flags (confirmed in code + usage in CR adapter):
  - `--format json` : streams raw JSON events (used by ContextRelay's `parseOpencodeJsonl`).
  - `--pure` : global-ish flag seen in scripts (`opencode --pure ...`). Used in CR adapter as `opencode run --pure ...`. Appears to disable interactive/TUI side effects.
  - `--dir <path>` : run in specific dir (CR passes `--dir`).
  - `--model provider/model` or `OPENCODE_MODEL` / `--model`.
  - `--agent <name>` (build/plan/general).
  - `--variant` : reasoning effort (high, max, minimal...) — excellent hook for "ultrathink".
  - `--thinking` : show thinking blocks.
  - `--file`, `--continue` / `--session`, `--fork`, `--share`, `--title`, etc.
  - stdin support for prompt.
- Output: JSONL-style events. Key events observed in CR parser: `step_finish` with `cost`, `tokens` (input/output), `part.text`, etc.
- Non-interactive: sends prompt, streams, exits when session idle.
- ContextRelay already has a solid (but Darwin-sandbox-only for full containment) adapter using exactly this.

**Current CR adapter strengths**:
- Grounding prompt that restricts to read/glob/grep/list only.
- `OPENCODE_CONFIG_CONTENT` injected to deny writes/bash/etc at config layer (defense-in-depth).
- Sandbox wrapper on macOS.
- Custom env (HOME, TMPDIR, OPENCODE_*).
- Parses cost + tokens from step_finish.

**Gaps / Improvement opportunities** (for Headless):
- Make adapter cross-platform (Linux/Windows containment).
- Better support for `--agent plan`, `--variant`, thinking budget mapping.
- Structured "plan artifact" output.
- Live attach vs one-shot run distinction.
- Write-mode / workspace-write equivalent (OpenCode permissions + worktree?).
- Richer event typing (use their SDK? `packages/sdk*`).

## Config & Tool Control (Great for Containment)

- Config can be provided via `OPENCODE_CONFIG_CONTENT` (JSON seen in CR).
- Tools have fine-grained allow/deny + permission model.
- `src/permission/`, `src/tool/registry.ts`, `src/config/agent.ts`, `src/config/config.ts`.
- Skills system (`src/skill/`).
- MCP support (`src/mcp/`).
- This is why CR can force a read-only pure reviewer.

## Session & State Model

- Modern V2 session concepts (durable prompt admission, SessionExecution, worktrees in control-plane).
- `src/session/`, `src/control-plane/`, `src/project/`, `src/storage/`.
- Worktree adapter exists.
- Strong emphasis on durable, resumable sessions (aligns with ContextRelay ledger + named sessions).

## Output, Cost, Tokens

- JSON events carry per-step usage (input/output tokens, cost in some providers).
- CR's `parseOpencodeJsonl` already extracts this reasonably.
- Provider plugins in `src/plugin/` (including xai, openai/codex, github-copilot).

## Other Notable Features

- LSP integration.
- Extensive plugin + MCP + ACP (Agent Control Protocol? in `src/acp/`).
- Shareable sessions.
- Desktop + web + IDE surfaces.
- Heavy use of Effect (for structured concurrency, errors, resources).
- `AGENTS.md` at root + per-package with strict style (keep simple, Bun APIs, Effect patterns, no over-abstraction).

## Comparison to Claude "Superpowers" (Initial)

| Claude Feature     | OpenCode Equivalent / Notes                          | Emulation Strategy for Headless                  |
|--------------------|------------------------------------------------------|--------------------------------------------------|
| Plan mode / Ultraplan | `plan` agent + Tab + dedicated plan prompts/tools   | `--agent plan` or special grounding + capture structured plan |
| Ultrathink (max thinking) | `--variant high/max` + thinking blocks + model effort | Pass variant + "ultrathink" grounding prefix    |
| Ultracode / dynamic sub-agents | `@general` subagent + internal orchestration        | Expose subagent spawning in workflows            |
| Custom workflows / commands | Custom commands, skills, config                     | Portable skill layer + workflow engine           |
| Skills / Agents    | `skill/`, agent definitions, AGENTS.md              | Cross-backend skill extraction + application     |
| Hooks / automation | Plugins, MCP, server routes                         | Unified event bus + MCP surface                  |

OpenCode is already very close on many axes and often more flexible (BYO model, pure mode, OSS).

## Risks / Observations for Headless Runner

- Containment is mostly **permission + config + UX**; the note in SECURITY.md says it does **not** sandbox by default. CR's Darwin sandbox + config deny is important.
- Output parsing is event-stream based; must be robust to partial lines / mixed stdout.
- Large monorepo; for deep integration we would use the published `opencode-ai` + flags, not re-bundle.
- `--pure` + `--format json` + `--dir` + env overrides + config injection is the reliable headless vector today.

## Recommendations for Next Steps (Headless project)

1. Improve the adapter in ContextRelay (or new shared runner) to:
   - Support `--agent plan`, `--variant`, `--thinking`.
   - Produce canonical "Plan" artifacts.
   - Add cross-platform containment story (or document Linux limitations).
2. Treat `opencode run` as a first-class engine in the new unified `Engine` interface.
3. Use OpenCode's own AGENTS.md style + Effect patterns where we write TS.
4. Investigate their SDK (`@opencode-ai/sdk`) for programmatic control instead of pure CLI spawning where possible.

**Next analysis artifacts**: `analysis-contextrelay-reuse.md`, `superpowers-mapping.md`.

*Generated during Phase 1 exploration.*
