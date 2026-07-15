# Depth-one worker delegation design

Status: Implemented experimental Phase 7 contract. The implementation and contained end-to-end tests pass on macOS and Linux; this does not promote orchestration into the Gate A stable surface.

## Objective

Let a contained worker call `run.delegate` to ask the project daemon for one bounded, read-only sub-job on another backend. The daemon remains the only authority: it authenticates the parent from the run-tool endpoint, derives every security control, carves a child allocation from the parent's reservation, launches the child as an isolated sibling, and returns a structured result.

This surface is distinct from goal/fleet `DelegationSchema`. Call its durable relationship `RunDelegationLink` to avoid conflating worker-initiated sub-jobs with coordinator-planned fleet work.

## V1 decisions

- Depth is `0 | 1`. Ordinary jobs are depth 0; a child is depth 1. A depth-1 job is always denied if it reaches delegation admission, and its run-tool endpoint does not advertise or accept `run.delegate`.
- One admitted child per parent in v1. This prevents repeated 50%-of-remaining calls from asymptotically draining the whole parent reservation. A rejected preflight may be retried.
- Parent and child must both be `mode: read-only` and `containment: required`. Unsafe parents, write parents, write children, and delegated parents are denied.
- The child uses broker auth (or a credential-free backend) in v1. Native-login delegation cannot enforce a provider-call or priced-cost sub-allocation and would create a credential-pivot surface.
- The target must resolve to a different backend from the parent and must not resolve to the active foreground-lead backend. Worker delegation is automatic routing even though the worker names a target; it does not get the explicit-lead-routing exception.
- The child is an independent daemon job, not a nested process inside the parent's sandbox. It receives fresh isolated HOME/runtime state, a fresh broker lease, and a run-tool endpoint whose operation allowlist excludes `run.delegate`.
- No write capability, merge authority, project trust, native egress, session binding, principal, containment mode, auth mode, or approval bypass is caller-selectable.

## Run-tool contract

`run.delegate` is part of the depth-0 run-tool operation set with strict parameters:

```ts
{
  backend: string;              // required; bounded BackendId
  prompt: string;               // required; existing BoundedText limit
  model?: string;               // optional; existing model validation
  agent?: string;               // optional; existing backend/agent validation
  timeoutMs?: number;           // positive; capped by parent deadline
  budgetFraction?: number;      // optional, (0, 0.5], default 0.25
}
```

The protocol request UUID is the idempotency key and must be passed to the handler by the endpoint, not copied from `params`. The immutable endpoint scope supplies project, parent job, session, and principal. The handler re-reads the durable parent job/request and requires it still be running.

The endpoint has an operation allowlist per issued credential. Omitting `run.delegate` from a child credential is defense in depth; daemon admission independently checks the durable depth/link because a hidden operation can still be forged.

`run.delegate` may wait longer than the endpoint's current five-second socket idle timeout. Its transport deadline is the child's bounded deadline plus a small reply margin, always below the parent endpoint expiry. Request and response byte caps remain unchanged; the returned child result uses the existing bounded `RunResult` projection.

## Durable relationship and authority

The strict nullable child-job field is (legacy reads default to null):

```ts
delegationOf: null | {
  parentJobId: string;
  requestId: string;
  depth: 1;
  budgetFraction: number;
}
```

The daemon creates this field; RPC and run-tool params cannot set it. A uniqueness constraint on `(parentJobId, requestId)` makes retries return the existing child/result rather than spend twice. The parent may also persist `delegatedChildJobId` or derive it from the indexed child relation; do not maintain two unaudited sources of truth.

Delegation reauthorizes the parent's authenticated principal for `run` on the target backend. A scoped grant must cover that backend and cost, and its iteration accounting must not be bypassed. Root/active-lead authority remains non-transferable identity, not a token given to the child. The child job retains the parent principal only for attribution and normal daemon checks.

## Approval-policy composition

The worker cannot choose the child policy. Use this monotonic composition:

| Parent | Child | Reason |
| --- | --- | --- |
| `ask` | `ask` | The parent's earlier approval did not approve an arbitrary later prompt/backend. |
| `auto` | `auto` | Existing autonomous authority is preserved inside the inherited slice. |
| `bypass` | `auto` | Administrative bypass is not delegated; required containment still permits ordinary autonomous tools. |

Run the normal child policy and pricing preflight before creating a runnable child. If `ask` requires a new human decision (for example unknown pricing), return `APPROVAL_REQUIRED` as a structured tool result and create no waiting child. A contained worker cannot resolve approvals, and the parent must not be held open behind an approval queue. The lead/root can make a separate explicit run after reviewing the request.

## Budget inheritance and deadline

The child gets no ordinary independent `BudgetStore.reserve()` call. The atomic sub-reservation primitive:

1. Read the parent reservation and its broker lease consumption under one daemon-owned lock.
2. Compute the parent's remaining requests, input/output tokens, priced cost, artifact bytes, retries, and time. Unknown usage under a configured bound fails closed.
3. Cap every child dimension by the requested fraction and the hard 50% ceiling. The child's priced estimate and finite broker request/token lease must fit all caps.
4. Transfer that allocation from parent to child atomically, recording `parentReservationId`; the parent can no longer spend the carved slice.
5. Require the child to resolve to the same provider as the parent. Cross-provider linked holds remain out of scope in v1; no second project-wide spend allocation is created.
6. On child completion, charge actual usage once and return provably unused allocation to the parent. On crash-unknown, exhaust the child slice; never silently return it.

The versioned reservation envelope exposes a transferable remaining request/token/cost allocation for this purpose. Retrofitting delegation as two ordinary reservations would permit overcommit or double charging and remains forbidden.

Set `childDeadlineAt = min(now + requestedTimeoutMs, parentDeadlineAt - replyMargin)`. Queue time is part of this ceiling. Reject when too little time remains. Parent cancellation/terminal recovery cascades cancellation to a live child; a child terminal state never cancels or fails the parent.

The scheduler must not queue a child behind its waiting parent. Admission requires an immediately activatable ordinary worker slot and budget-concurrency slot; otherwise return retryable `DELEGATION_CAPACITY_UNAVAILABLE`. In particular, `maxConcurrency: 1` cannot delegate. A special lane that exceeds configured concurrency is out of scope for v1.

## Execution and failure result

Launch the child through the normal admission/execution pipeline with the derived controls and sub-reservation. Never pass the parent broker token, run-tool socket, HOME, runtime directory, native auth capsule, or worktree lease into the child.

Expected outcomes always resolve the tool call:

```ts
{ ok: true, childJobId: string, result: RunResult }
{ ok: false, childJobId: string | null, error: StructuredError }
```

Child `failed`, `timed_out`, `cancelled`, `blocked`, capacity denial, approval requirement, and policy denial are data in this reply, not exceptions that kill the parent. Only loss of the authenticated run-tool transport is a transport failure. The parent is free to continue after any child outcome.

## Audit and observer/TUI projection

The child `Job.delegationOf` is the durable source of parent-child attribution. Before launch, append protected parent events for request and policy outcome; after allocation append admitted/started/completed events carrying parent job, child job, request ID, target backend, depth, deadline, approval policy, and allocated/actual budget dimensions. Store a redacted prompt digest and byte length in audit events, not a second raw prompt copy.

Emit the existing ledger `worker_spawned`/`headless_result` lifecycle with daemon-derived parent/child metadata, or add a typed run-delegation event if those projections cannot express the relationship without unvalidated `meta`. Hash-chain/archive behavior is unchanged.

The observer snapshot contains jobs, delegation projections, and bounded run events, so no mutating route or new observer scope is needed. The TUI indents a delegated child below its parent and shows backend, state, elapsed/deadline, allocated fraction, actual cost/usage, and terminal error. It does not expose prompt content or add cancel/retry controls.

## Threat review

| Threat | Mitigation |
| --- | --- |
| Repeated budget drain | One admitted child, aggregate hard fraction, atomic transfer, idempotent request ID, once-only commit. |
| Concurrent parent/child overspend | Broker-lease consumption and reservation transfer share a lock; the parent's lease is reduced before the child lease is issued. |
| Prompt-injection pivot | Read-only required containment, broker-only auth, backend allowlist/authority recheck, active-lead exclusion, no child-selected controls. |
| Credential or socket theft | Child is a daemon-launched sibling with fresh roots/leases; parent secrets and delegate-capable endpoint are absent. |
| Depth bypass/replay | Persisted depth/link checked at admission, per-endpoint allowlist, authenticated immutable scope, unique request ID. |
| Containment nesting ambiguity | Never nest the child under the parent sandbox; independently probe and record child containment evidence. |
| Queue deadlock | No-wait capacity admission; no child queue behind a live parent. |
| Orphan spend after cancellation/crash | Parent-to-child cancellation, durable relation recovery, fail-closed exhaustion of unknown child allocation. |
| Result/prompt exfiltration | Existing redaction and byte caps, bounded `RunResult`, prompt digest-only audit, no observer prompt content. |
| Approval laundering | Child policy is derived, bypass downgrades to auto, new `ask` decisions do not become worker-resolvable pending approvals. |

## Acceptance gate

- Contract tests reject extra fields, unknown operations, depth 2, unsafe/write/native delegation, same/lead backend, and forged parent/depth/request IDs.
- Budget tests prove atomic 50% caps across every dimension, no double charge, unused return, crash-unknown exhaustion, same-provider enforcement, and concurrent calls admitting at most one child.
- Scheduler tests prove no max-concurrency deadlock and retryable immediate capacity denial.
- End-to-end tests prove success, child failure/timeout/cancel, parent continuation, cancellation cascade, restart recovery, idempotent replay, redacted bounded audit, and child run-tool omission of `run.delegate`.
- Observer/TUI tests prove parent-child grouping from snapshots/events and unchanged observer method denial for all non-observer routes.

## Locked v1 decisions

1. One admitted child per parent. Rejected preflight may be retried; an admitted child consumes the only slot.
2. Broker-authenticated or credential-free children only. Native login is not delegated.
3. Same-provider targets only until linked target-provider holds are implemented; the target backend must still differ from the parent and active lead.
4. `budgetFraction` defaults to `0.25` and has a hard `0.5` maximum. The daemon transfers only the validated bounded allocation.
5. Approval composition is `ask -> ask`, `auto -> auto`, and `bypass -> auto`.
