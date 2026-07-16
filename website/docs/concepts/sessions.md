---
id: sessions
title: Persistent Sessions
sidebar_position: 5
description: Durable read-only multi-turn conversations with native resume, bounded replay, cancellation, and crash reconciliation.
---

# Persistent sessions

Persistent sessions are the experimental multi-turn layer over ordinary daemon jobs. A session binds one owner, backend, optional model/agent, containment requirement, authentication mode, and approval policy. Every turn is still a normal admitted, budgeted, contained, receipted job; the session adds durable transcript and provider-resume state.

Sessions currently support **read-only turns only**. Use write-mode jobs, goals, or candidates for mutations.

The daemon route is disabled unless experimental sessions were enabled at daemon startup. The `headless experimental session ...` CLI requests that startup mode when it launches a daemon; if an older daemon is already running without it, stop and restart the daemon through the session command path.

## Lifecycle

```text
create ──► idle ── send / resume ──► running
                                      ├─ succeeded job ──► completed
                                      ├─ failed/timed-out/blocked job ──► failed
                                      └─ cancel ──► cancelling ──► cancelled

completed / failed / cancelled ── next send / resume ──► running
```

Only one turn may be active for a session. A second `send` or `resume` while state is `running` or `cancelling` is rejected with `Session already has an active job.` This prevents transcript races and two provider turns from claiming the same native thread.

All session commands are experimental:

```bash
headless experimental session create \
  --backend codex \
  --auth-mode native-login \
  --approval-policy ask \
  --require-sandbox \
  --cwd "$PROJECT"
```

Expected: a JSON session with an `id`, bound security fields, `state: "idle"`, and no `lastJobId`. Native-login creation requires compatible project trust.

Copy the returned id:

```bash
SESSION_ID="<session-id>"

headless experimental session send \
  --session-id "$SESSION_ID" \
  --timeout-ms 300000 \
  --cwd "$PROJECT" \
  -- "Map the parsing pipeline."

headless experimental session resume \
  --session-id "$SESSION_ID" \
  --timeout-ms 300000 \
  --cwd "$PROJECT" \
  -- "Now identify the highest-risk edge case."
```

Expected: each command waits for its durable job, then prints the session, job, result, and whether bounded replay was truncated. `send` and `resume` use the same serialized daemon turn path; the names make first and subsequent operator intent explicit.

Inspect or cancel without starting another turn:

```bash
headless experimental session status --session-id "$SESSION_ID" --cwd "$PROJECT"
headless experimental session result --session-id "$SESSION_ID" --cwd "$PROJECT"
headless experimental session cancel --session-id "$SESSION_ID" --cwd "$PROJECT"
```

Expected: `status` returns durable metadata, `result` returns the latest terminal `RunResult`, and `cancel` moves an active session through `cancelling` while cancelling the bound daemon job and native provider turn.

## Native resume and bounded replay

When a backend exposes an audited native session driver, Headless persists the provider session/thread ID, driver kind and version, model, auth-profile fingerprint, capability snapshot, turn count, recovery evidence, and rate-limit evidence. Later turns resume that provider-native conversation only when the stored model, auth fingerprint, driver, and containment-compatible metadata still match.

If native resume is unavailable or a provider reports that its saved session is lost, Headless falls back once to a bounded, redacted transcript replay. The replay is at most 200,000 bytes; the stored transcript is bounded to 1,000 entries and 1,000,000 content bytes. Old entries are dropped and a summary marker states when context was omitted. Replay evidence is explicit—it is not presented as a native continuation.

Changing model, backend, agent, auth mode, containment, or approval policy on a session-backed request is rejected before authorization, pricing, budget reservation, or launch. Create a new session to change those fields.

## Completion and restart recovery

The durable job terminal state is the completion authority. Session completion is reconciled directly from the job terminal bridge, not from a short RPC waiter. Long-running turns therefore remain owned beyond the old three-minute observation window and cannot leave the session stuck in `running` merely because a waiter expired.

On daemon startup, any session still marked `running` or `cancelling` is compared with its `lastJobId`; a terminal job completes the session and appends the assistant output exactly once. The completion store is idempotent by job ID, so live callback, boot reconciliation, and other terminal observers cannot duplicate the assistant turn.

:::note Daemon restart versus provider resume
The session record and transcript always survive daemon restart. Provider-native resume depends on the backend's audited capability and the persisted fingerprint checks. When that proof is unavailable, Headless uses bounded replay rather than silently attaching to an unverified provider thread.
:::

## Honest limits

- Sessions are experimental and read-only.
- Transcript redaction and bounds can omit context; inspect the `truncated` and replay fields.
- A provider can lose or invalidate its native session independently of Headless.
- Native-login sessions retain provider-direct network risk; broker sessions retain broker key and pricing configuration requirements.
- Cancelling is cooperative first and process-tree enforced by the ordinary execution lifecycle, but provider-side work already accepted may not be retractable.

See the generated [command reference](https://github.com/proofofwork-agency/headless/blob/main/docs/command-reference.md) for the current invocation grammar.

## Related

- [Modes](./modes.md) — fields bound at session creation.
- [Architecture](./architecture.md) — daemon ownership and boot reconciliation.
- [Execution receipts](./receipts.md) — every authorized session turn leaves a per-job receipt.
