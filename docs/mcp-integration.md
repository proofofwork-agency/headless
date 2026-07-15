# Foreground-lead MCP and OpenCode plugin

Foreground-lead onboarding is part of the Beta 1 CLI surface. The orchestration tools exposed through the MCP server remain experimental unless documented otherwise.

Headless has one externally launched foreground lead per project. The provider CLI remains visible and owns its own lifecycle. Headless does not start, inject into, elect, or kill it. The host’s MCP process or OpenCode plugin attaches to the configured binding and sends a heartbeat.

## Configure a lead

Install Headless, then initialize external project state, install the host integration, and bind the foreground lead in one command:

```bash
bun install --frozen-lockfile --ignore-scripts
bun run build

PROJECT="$(pwd)"
HEADLESS=./dist/cli.js
"$HEADLESS" init --lead codex --cwd "$PROJECT"
```

Supported lead names are `codex`, `claude`, `opencode`, and `grok`. The one-shot command does not grant project trust or native egress. Those remain explicit, separate policy decisions.

The equivalent manual sequence is:

```bash
PROJECT="${PROJECT:-$(pwd)}"
HEADLESS="${HEADLESS:-./dist/cli.js}"
"$HEADLESS" init --cwd "$PROJECT"
"$HEADLESS" mcp install codex --cwd "$PROJECT"
"$HEADLESS" lead use codex --cwd "$PROJECT"
```

Codex, Claude Code, and Grok are installed through their native MCP commands. Grok uses user scope. OpenCode is merged into its global `~/.config/opencode/opencode.json`; Headless refuses to place that configuration inside the project checkout. Claude and Grok failures print their complete native command plus configuration fallback. A Codex failure reports the complete retry command. An OpenCode update failure prints the exact JSON entry to merge manually.

Install is automated for all four hosts. In the current Beta 1 tree, `mcp remove` and `mcp status` invoke Codex directly; for Claude, Grok, and OpenCode they print guidance to use that host's MCP command, configuration file, or UI.

`headless lead status` reports `configured`, `connected`, or `disconnected`. `headless lead release` revokes the current generation. Calling `lead use` again explicitly switches hosts, increments the generation, and invalidates the previous host’s state-changing access. Detached jobs, worker sessions, messages, artifacts, candidates, and ledger history remain intact.

The compiled server command always names the host:

```bash
PROJECT="${PROJECT:-$(pwd)}"
HEADLESS_PROJECT_ROOT="$PROJECT" headless-mcp --host codex
```

A generic stdio configuration is:

```json
{
  "mcpServers": {
    "headless": {
      "command": "headless-mcp",
      "args": ["--host", "codex"],
      "env": { "HEADLESS_PROJECT_ROOT": "/absolute/project" }
    }
  }
}
```

Use the compiled binary, not `src/mcp/server.ts` or `plugin/index.ts`. OpenCode attaches as host `opencode`; `headless init --lead opencode` performs both its global MCP registration and lead binding.

## Identity and authority

The process connects to the owner-only project daemon with a generation-specific principal such as `integration:lead-codex-g3`. Client-supplied project roots, principals, actors, sources, credentials, and grants cannot replace authenticated identity.

The active lead may create contained runs, goals, workflows, messages, reviews, and finality proposals. It cannot administer credentials, trust, budgets, fleet profiles, or authority grants. Approval and candidate tools are deliberately inspection-only; a lead cannot resolve its own approval or integrate/reject a candidate through this tool surface.

The normal integration path is a human CLI action. A daemon-managed goal may integrate its candidate only when project, principal, backend, operation, cost, expiry, and iteration grant limits all match; this does not add an integration mutation to the lead tool surface. Root CLI recovery remains attributable in the verified ledger.

Automatic worker and synthesizer selection excludes the active lead backend. An explicit backend or per-goal synthesizer selection may still create a separate contained worker using the same provider.

## Tool surface

Execution and orchestration:

- `headless_run` submits one contained daemon job and returns its full structured result.
- `headless_deliberate` fans out a bounded read-only question. Its default backends are OpenCode and Codex.
- `council_deliberate` runs daemon-owned proposal, execution, review, vote, and decision phases.
- `headless_goal` starts, messages, inspects, lists, cancels, or reads a durable goal result.
- `headless_workflow_run` and `headless_workflow_status` operate bounded workflow DAGs.
- `headless_gate` runs configured release-gate checks.

Worker-initiated `run.delegate` is not an MCP mutation. It is a separately authenticated run-tool operation available only inside an eligible depth-zero contained worker. The daemon reauthorizes and audits one read-only child against the parent's deadline and fraction-capped allocation. Same-provider children use an atomic parent sub-reservation; cross-provider children require different providers and backends plus a strict `broker-api-key` target and use a crash-atomic linked hold over the parent and target provider quotas. The lead cannot forge the parent linkage or grant a child native credentials, and a cross-provider target bearer is minted once and never persisted.

Read and communication tools:

- `headless_project_trust`, `headless_fleet_profile`, and `headless_fleet_health` are read-only.
- `headless_collaboration` reads turns/messages and acknowledges addressed messages.
- `headless_approval` lists visible approvals.
- `headless_candidate` inspects a candidate.
- `headless_append_note`, `headless_record_artifact`, `headless_read_context`, `headless_task_state`, and finality/task/vote helpers use the existing verified ledger and stores.
- `send_message`, `wait_for_handoff`, and `get_messages` use Headless’s durable, redacted, principal-isolated communication paths.

There is no generic `claude/channel` fallback and no process-local queue or ledger. Host-specific channel adaptation belongs in the host integration layer.

## Containment and results

Required containment is the default. Broker authentication and `ask` approval remain the default policy. Native login additionally requires project trust and explicit unrestricted-egress acknowledgement. Grok remains experimental and read-only until lifetime write-containment can prove that late-created project control files are denied.

`headless_run` returns the complete structured result, including output, diagnostics, usage, cost, containment evidence, diff/commit data, and truncation fields. Its timeout covers queueing, preparation, provider access, and execution. Expected failures remain structured and redacted.

The MCP server and OpenCode plugin share the same attach/heartbeat client implementation and daemon state. Neither owns provider processes or foreground authority outside the configured generation.
