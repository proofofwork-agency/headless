# MCP integration

Headless v0.2 ships a compiled stdio MCP server as the `headless-mcp` binary and the `@proofofwork-agency/headless/mcp` export. The MCP process is a client of the same authenticated project daemon used by the CLI, plugin, and TUI.

## Install

```bash
bun add -g @proofofwork-agency/headless@0.2.0
headless-mcp
```

Or let an MCP host launch the published package without a global install:

```bash
bunx --bun -p @proofofwork-agency/headless@0.2.0 headless-mcp
```

Do not configure an installed client to execute `src/mcp/server.ts` or `plugin/index.ts`; those files are not part of the published package.

## Bind the project

Set `HEADLESS_PROJECT_ROOT` to the one project the MCP server is allowed to operate on. If it is omitted, the server binds to its startup working directory.

A generic stdio host configuration looks like:

```json
{
  "mcpServers": {
    "headless": {
      "command": "headless-mcp",
      "env": {
        "HEADLESS_PROJECT_ROOT": "/absolute/path/to/project"
      }
    }
  }
}
```

When using `bunx`, set `command` to `bunx` and use:

```json
{
  "args": [
    "--bun",
    "-p",
    "@proofofwork-agency/headless@0.2.0",
    "headless-mcp"
  ]
}
```

Codex, Claude Code, Grok Build, and OpenCode each have their own location and syntax for stdio MCP configuration. Translate the same command, arguments, and environment into the host’s current MCP configuration format.

## Admission and authority

The process canonicalizes the configured project and connects to that project’s owner-only daemon socket. Tool arguments cannot replace the project root, choose an unrestricted `cwd`, or grant coordinator authority. Supplied `source`, actor, coordinator, or claimed principal fields are treated only as untrusted payload metadata or ignored.

Required containment is the default for `headless_run`. Autonomous and council operations reject unsafe containment. Write and merge operations still require the daemon’s persisted coordinator policy or a scoped grant.

Native login and `ask` approval are the defaults after one-time project trust; callers may explicitly select broker authentication or another allowed approval policy but cannot supply credential paths. Model is optional and omission uses the selected CLI's configured default. Native results report provider-direct/backend-native evidence and unknown cost unless the CLI reports a real charge. MCP admission preserves structured `NATIVE_AUTH_UNAVAILABLE`, `NATIVE_SESSION_LOST`, `APPROVAL_REQUIRED`, `RATE_LIMITED`, and `QUEUE_CAPACITY_EXCEEDED` failures.

## Tool surface

Execution and deliberation:

- `headless_run` submits one durable job and returns its complete structured result.
- `headless_deliberate` runs bounded read-only jobs across selected backends and returns each attributable result.
- `council_deliberate` uses daemon-owned proposal, execution, review, vote, and decision phases.
- `headless_gate` runs only configured release-gate checks with timeout/cancellation.

Durable workflows:

- `headless_workflow_run` accepts `definition`, a JSON string containing a v0.2 workflow DAG, and starts it with required containment.
- `headless_workflow_status` accepts `action: "list" | "status" | "wait" | "cancel"`; non-list actions also require `workflowId`, and `wait` accepts a bounded `timeoutMs`.

The definition contains one to 64 acyclic steps. Each step has `id`, `backend`, and `prompt`; optional fields are `kind: "execution" | "test" | "review" | "vote"`, `mode`, `model`, `agent`, `timeoutMs`, `dependsOn`, and `maxAttempts`. Top-level `requirements` selects policy, tests, review, vote, and budget finality gates. Workflow ownership comes from the authenticated MCP connection, dependency results/diffs are supplied to downstream steps by the daemon, and write candidates remain preserved for an explicit authorized integration decision.

For example, pass this object as the JSON-encoded `definition` string:

```json
{
  "requirements": {
    "policy": true,
    "tests": false,
    "review": true,
    "vote": false,
    "budget": true
  },
  "steps": [
    {
      "id": "draft",
      "backend": "codex",
      "prompt": "Produce the candidate",
      "mode": "write"
    },
    {
      "id": "review",
      "kind": "review",
      "backend": "claude-code",
      "prompt": "Review the actual candidate result and diff",
      "dependsOn": ["draft"]
    }
  ]
}
```

Ledger and finality:

- `headless_append_note`
- `headless_record_artifact`
- `headless_read_context`
- `headless_task_state`
- `headless_propose_final`
- `headless_record_task_claim`
- `headless_record_consensus_vote`
- `headless_record_idle_action`
- `headless_record_release_gate`

Fleet messaging:

- `headless_ask_for_work`, `ask_for_work`, `ask_for_more_work`, and `ask_for_backup`
- `send_message`, `wait_for_handoff`, and session-scoped `get_messages`
- `headless_get_cooperation_instructions`

Daemon-backed fleet automation also mirrors the project-trust, fleet-profile/health, goal lifecycle, collaboration turns/messages/leader transfer, approval inbox/resolution, and candidate inspect/integrate/reject protocol families. `headless_goal` starts in `read-only` mode unless its strict `start` action explicitly supplies `mode: "write"`; the selected mode is durable and still passes through ordinary worktree, approval, finality, and integration gates. Authentication derives from the MCP credential: these operations cannot self-declare ownership, coordinator authority, grants, merge authority, or a different project root. Directed messages include sender/recipient sequences, acknowledgement state, bounded redacted content, and artifact references rather than a competing-consumer queue.

The automatically provisioned `integration:mcp` credential is deliberately non-admin. It can inspect trust, fleets, health, owned goals/collaboration, approvals, and candidates and can operate its own goal lifecycle, but direct trust/profile mutations, leader transfer, approval resolution, and candidate integration/rejection return `POLICY_DENIED`. Use the owner-authenticated CLI or TUI for those actions; v0.2 does not let an MCP request promote its own credential.

The server advertises the experimental `claude/channel` capability. It attempts push notifications when supported and always records a redacted session-scoped queue entry for pull fallback.

## Results and errors

`headless_run` returns JSON text containing `jobId`, `sessionId`, and the full v0.2 result. It does not replace long results with a fixed-length summary. Output, stderr, diagnostics, usage dimensions, cost attribution, containment evidence, diff/commit data, and explicit truncation fields are preserved within their schema bounds. Its timeout is a total durable lifecycle deadline covering queueing, preparation, native-session recovery or broker access, and execution. A durable FIFO scheduler reports queue positions and rejects overflow explicitly rather than dropping work.

Expected execution failures are represented by the result’s terminal status and structured error. MCP admission/validation failures set the MCP tool result’s error flag with a bounded redacted message.

## OpenCode plugin versus MCP

Use `@proofofwork-agency/headless-plugin` when OpenCode should load Headless as a native plugin. Use `headless-mcp` when a general MCP host should access the daemon. Both are daemon clients and share project policy/state; neither has process-local coordinator authority.

The plugin declares `@proofofwork-agency/headless@^0.2.0` as a required peer. Install both packages. The repository’s source-file plugin entry is only a development configuration.
