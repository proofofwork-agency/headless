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

## Cross-provider linked holds (v2)

Status: design for review; the implemented runtime remains same-provider-only until this section's acceptance gate passes.

### Decision and atomicity boundary

Cross-provider depth-one delegation is allowed only when the parent and target resolve to two different, non-null providers and the daemon can establish both of these holds:

1. A parent-authority hold carved from the active parent's transferable reservation and live broker lease.
2. A target-provider hold represented by a child reservation over the budgets matching the target provider and enforced by a fresh target-provider broker lease.

Neither hold grants new project spend authority. The child allocation must fit the parent's remaining envelope at the requested fraction and every matching target-provider/project budget. A target with unknown pricing under a finite parent or target cost limit is denied before an intent is written. A null-provider mismatch cannot form a two-provider link and remains denied.

The quota journal belongs inside the next version of the owner-only `BudgetStore` state envelope, as a strict `linkedHolds` collection. This is stronger than putting intent files beside `budgets.json`: `writeOwnerOnlyJson` already uses same-directory temporary write, file fsync, atomic rename, and directory fsync, so a restart sees either the complete old budget state or the complete new one. The v3-to-v4 migration adds `linkedHolds: []`; existing reservations and the v1 same-provider `subreserveDelegation` path are otherwise unchanged.

The journal follows the ledger-v1 import and integration-journal rule: durable intent precedes the first authority mutation, deterministic identities make replay idempotent, and ambiguous evidence is preserved rather than repaired optimistically. The budget state remains the source of spend authority. Broker quota state and leases are enforcement mirrors derived only from a durable `held` record; disagreement can reduce authority or stop recovery, never enlarge it.

### Linked hold record

One strict record is keyed by a deterministic `linkId = H(projectId, parentJobId, requestId)`. The record contains:

- `parentJobId`, `parentReservationId`, `childReservationId`, and the protocol `requestId`;
- parent and target backend/provider identities, which must differ by provider;
- depth `1`, the requested fraction, parent/child deadlines, and derived approval policy;
- the exact parent allocation and target reservation envelope for requests, tokens, cost, artifacts, and retries;
- the parent budget ids, target-matching budget ids, and deterministic parent-carve/target-quota ids;
- the request shape digest plus prompt digest and byte length, never prompt content;
- state, monotonic transition number, timestamps, child job id when durable, and broker evidence without bearer tokens;
- a terminal settlement digest and bounded usage projection when known.

The immutable fields are compared on every replay. Reusing `(parentJobId, requestId)` with different target, prompt digest, controls, deadline, fraction, or allocation is `CONFLICT`; an exact replay returns the existing child or terminal outcome. `parentReservationId` and admitted `parentJobId` are each unique across non-rolled-back links, preserving one admitted child per parent under concurrent calls.

States are monotonic:

| State | Durable fact |
| --- | --- |
| `intent` | Both planned debits are recorded; neither hold exists. |
| `held` | One atomic budget write carved the parent envelope and created the target child reservation. |
| `parent_carved` | The live parent broker lease was reduced under the deterministic carve id. |
| `admitted` | The child job/request and delegation link are durable. |
| `leased` | A bounded target-provider lease was issued; no token is persisted. |
| `settling` | Immutable normal or fail-closed usage evidence is recorded before quota is returned or charged. |
| `settled` | Target usage was charged and only proven-unused parent authority was returned once. |
| `rolled_back` | No provider egress was possible; both holds were fully released once. |
| `exhausted` | Egress/usage became crash-unknown; the full child slice was consumed fail closed. |
| `recovery_required` | Persisted facts conflict; no hold may be released and daemon readiness fails. |

Terminal records remain for idempotency and audit. They are not deleted as part of admission cleanup.

### BudgetStore composition

The v2 primitive is distinct from, and a strict superset of, the v1 carve:

- `subreserveDelegation` remains the same-provider fast path and does not create a journal record.
- `prepareLinkedProviderHold` writes only `intent`; it cannot return a runnable reservation.
- `applyLinkedProviderHold` is the sole operation allowed to subtract the parent envelope and create a cross-provider child reservation.
- The child reservation keeps `parentReservationId`, `delegationRequestId`, and `budgetFraction`, but its `provider` and `budgetIds` come from the target scope rather than copying the parent's ids.
- Provider-null budgets may occur in both scopes because they constrain total project/principal spend. They hold and later charge each real parent/child execution once; the linked transaction must not duplicate an id within the child reservation.
- A configured parent-provider budget is not charged for target-provider usage. Its existing parent reservation plus envelope carve is the authority fence.
- A configured target-provider budget is checked and held by the child reservation. With no configured target budget, the finite linked envelope and its durable target run quota still form the mandatory target hold; they do not create an unlimited default.

The atomic `held` transition re-runs the same projected request/token/cost/artifact and concurrency checks used by ordinary reservation, against both the still-active parent and proposed child. It succeeds only if all parent and target constraints fit simultaneously. A future ordinary reservation sees the linked child as active held capacity and cannot spend around it.

### Admission protocol

All steps through the parent broker carve run synchronously under one daemon delegation/quota mutation critical section. Broker request accounting reserves counters before its first asynchronous provider operation, so a parent request cannot interleave between the budget carve and live-lease carve.

1. Re-read the durable running parent and request. Reapply depth, one-child, read-only/required-containment, broker-auth, authority, lead exclusion, approval, deadline, immediate capacity, backend, provider, credential, and pricing checks.
2. Compute the parent allocation using the existing default `0.25`, hard `0.5` fraction cap over the current transferable envelope. Compute the target reservation against budgets matching the same project/principal and target provider. Provider-null project budgets match the target too; they are global constraints, not charged twice for one child result.
3. Persist `intent` with both exact deltas before subtracting an envelope, creating a reservation, mutating a broker quota, issuing a lease, consuming an authority iteration, or creating a job. Failure here has no side effect.
4. In one BudgetStore atomic replacement, revalidate generations and remaining values, subtract the parent envelope, create the inactive child reservation with the target provider and target-matching budget ids, and transition to `held`. This is the commit point for both budget-side holds; there is no crash point at which only one is visible.
5. Carve the parent live broker lease with deterministic operation id `linkId:parent`. The carve reduces request/token/cost ceilings by the parent allocation and persists its run-quota counters before transitioning to `parent_carved`. A retry returns the identical carve; a conflicting retry fails closed.
6. Activate the child reservation without queueing. If the concurrency slot disappeared, roll back only after proving no target lease/request exists; otherwise exhaust. Consume the scoped authority iteration, create the durable child job/request with `delegationOf`, then transition to `admitted`.
7. Normal execution derives a target lease from the child reservation using deterministic operation id `linkId:target`. Its run quota and all target/global budget quota counters are separate from the parent lease, capped by the linked allocation, and expire no later than the child deadline plus reply margin. Mint the bearer exactly once from `admitted`, persist only `{ targetLeaseId, targetTokenHash, targetIssuedAt, targetQuotaScope, targetExpiresAt }`, transition to `leased`, and then hand the one returned bearer to the child. The broker never persists or retains the plaintext bearer.

The child still receives fresh HOME/runtime state, no parent token/socket/secrets, and a run-tool credential without `run.delegate`. Cross-provider admission changes quota linkage only; all v1 execution, cancellation, containment, and result rules remain in force.

`ProviderBroker` therefore needs idempotent linked operations rather than a second ordinary carve:

- `carveLinkedParent(linkId, parentRunId, allocation)` wraps the existing synchronous parent-lease reduction and returns the existing identical carve on replay.
- `issueLinkedTarget(linkId, childRunId, targetScope)` issues exactly one target lease, binds its run quota to the linked child reservation, and rejects a changed provider/model/allocation. Its first successful call returns the bearer once. Every in-process or post-restart replay returns `already_leased` with token-free evidence only; it never remints or reproduces the bearer.
- `observeLinkedTarget(linkId)` returns only counters, forwarded-request state, active-request count, revocation, and expiry; it never returns the token.
- `settleLinkedParent(linkId, unused)` and target revocation are once-only even when journal recovery repeats them.

The parent lease remains the parent's provider-scoped capability. The target lease remains the child's target-provider-scoped capability. No combined token can address both providers.

### Normal settlement and once-only accounting

The parent lease and target lease serve different purposes. The parent carve fences the authority transferred away from the parent; only the target lease can perform the child's provider calls. They are not two additive charges for one upstream request.

1. Revoke the target lease and wait for active broker requests to drain. Snapshot its conservative request/token/cost observations and the terminal child `RunResult`.
2. Derive one bounded usage projection. It may tighten broker maxima with trusted provider usage but may never exceed the held envelope or turn unknown usage into zero.
3. Persist `settling` with the usage projection and its digest before changing either hold.
4. In one BudgetStore atomic replacement, remove the target child reservation, charge its actual usage once to its target/global budget ids, return only proven-unused dimensions to the parent envelope, and transition to `settled`. The consumed parent slice is delegation authority consumed, not parent-provider usage; parent-provider budgets are charged only for the parent's own result.
5. Settle the deterministic parent broker carve, restoring the same proven-unused dimensions once. If the daemon dies after budget settlement but before this live restoration, replay sees `settled` and retries the idempotent broker settlement; if the old parent lease is gone, no spend authority remains to restore.

Broker aggregate counters are enforcement evidence, while BudgetStore is durable accounting. Replaying a settlement digest is a no-op. A different digest for an already settling/terminal link is an integrity error. The target bearer is never reissued after its first mint, including before terminal state; a lost bearer is handled by recovery rather than reproduced. Neither provider can be charged twice by job recovery plus journal recovery.

### Rollback, interruption, and startup recovery

Linked-hold recovery runs before ordinary reservation recovery, queue pumping, broker lease issuance, or daemon readiness. It verifies the strict journal, child reservation/job relation, allocation arithmetic, deterministic quota ids, and monotonic broker counters.

- `intent` with no child reservation and an unchanged parent envelope is marked `rolled_back`; there was no hold to release.
- Because journal and reservations share one atomic envelope, `intent` plus any parent subtraction or child reservation is impossible in valid state and becomes `recovery_required`.
- `held` or `parent_carved` without a durable child can be fully rolled back only when the target quota is absent or proves zero reserved/forwarded requests and the post-restart broker has no token. Restore the parent envelope, remove the target reservation, reconcile/expire the parent carve, and mark `rolled_back` atomically.
- `admitted` without target-lease evidence is completed as a blocked child and rolled back under the same zero-egress proof. Recovery does not silently rerun a worker prompt.
- `leased`, running, or cancelling with durable zero request/token/cost counters may roll back only after revocation proves no in-flight request remains. Any nonzero, missing, or conflicting target counter completes the interrupted child as `exhausted`: charge the entire target reservation conservatively and return none of the parent slice.
- `settling` replays the recorded digest to `settled`. If usage evidence is missing or conflicts, transition to `recovery_required`; never substitute zero or return quota.
- `settled`, `rolled_back`, and `exhausted` are verified idempotently. Missing target charges, a reappearing child reservation, counter regression, or a second child link is ambiguous and blocks readiness.

An incomplete acquisition therefore ends in exactly one of three safe outcomes: complete the already-provable transition, fully roll back both unused holds, or exhaust the bounded slice. Corrupt or contradictory state is quarantined as `recovery_required`; it is never auto-released. Parent cancellation uses the existing cascade, then follows the same normal-versus-unknown settlement rules.

Crash tests should use explicit cut points rather than timing:

| Last durable point | Restart outcome |
| --- | --- |
| Before `intent` | No link and no side effect. |
| `intent` | `rolled_back`. |
| `held`, no broker evidence | Full atomic rollback. |
| Parent carve, no target quota | Full rollback after deterministic carve reconciliation. |
| Target quota/lease, zero forwarded requests | Full rollback only after revocation and zero-egress proof. |
| Any forwarded request or uncertain target evidence | `exhausted`. |
| `settling` with matching digest | Replay once to `settled`. |
| Any mismatched relation/counter/digest | `recovery_required`; no release. |

### Explicit operator recovery

`recovery_required` blocks normal daemon readiness but must not require hand-editing `budgets.json`. Add two experimental, local-admin commands scoped to one exact link:

```text
headless experimental budget linked-hold inspect --link-id <id> --cwd <root>
headless experimental budget linked-hold quarantine --link-id <id> --expected-digest <sha256> --resolution <exhaust|release> --confirm --cwd <root>
```

These commands run through an offline recovery path because the normal daemon may be unable to become ready. They require ownership of the external project state, acquire the exclusive daemon/state lock, and refuse while any daemon owns it. They do not accept wildcards, lists, provider filters, or `all`; one invocation can inspect or mutate one `linkId` only. The inspection decoder validates the outer budget envelope and every non-target entry strictly, bounds the raw target record, and prints a redacted digest and related reservation/broker evidence without prompt content or tokens.

Quarantine requires root/admin authority, literal `--confirm`, an explicit resolution, and the digest printed by the immediately reviewed inspection. A changed digest is `CONFLICT`. Before altering budget state it fsyncs an owner-only quarantine artifact containing the original bounded record, project/link identity, prior state digest, selected resolution, actor, time, and reason. It then performs one atomic budget-state replacement which removes only the named active journal record, records a strict manual-recovery marker, and handles only its uniquely linked child reservation:

- `exhaust` is the recommended fail-closed resolution. It returns none of the parent carve, charges the full identifiable target child envelope, and leaves any expired broker mirror without reusable authority.
- `release` is allowed only after the operator accepts the spend-ambiguity warning and the exact parent subtraction, child reservation, and zero-egress evidence all validate. It restores only those proven holds; missing or conflicting arithmetic refuses the release.

The original quarantine artifact and manual-recovery marker are never discarded by this command. On the next successful startup the daemon emits a deterministic protected audit event before readiness, recording the link, record digest, actor, resolution, affected reservation/budget ids, and whether quota was exhausted or released. It never records a prompt, credential, or lease token. Repeating the exact command is idempotent; a different resolution or digest is rejected.

If the target cannot be isolated while every other budget, reservation, and linked hold remains valid, the command refuses rather than rewriting ambiguous state. Backup restoration or a separately audited forensic tool is then required. This narrow escape hatch prevents one isolated link from permanently bricking the project without turning recovery into a quota-refund API.

### Preserved invariants

- One admitted child per parent and `(parentJobId, requestId)` idempotency remain durable constraints.
- Depth stays hard-capped at one; child credentials and admission both exclude delegation.
- The fraction remains default `0.25`, maximum `0.5`, applied to every finite parent dimension.
- Unsafe, write, native-login, delegated-parent, active-lead, unknown-price, and unauthorized targets remain denied.
- Capacity remains immediate and non-queueing; `maxConcurrency: 1` still cannot delegate.
- Child deadline remains below the parent deadline by the reply margin; cancellation still cascades only parent to child.
- Approval composition remains `ask -> ask`, `auto -> auto`, and `bypass -> auto`.
- Audit remains digest-only for prompts. Observer/TUI may show link id, providers, state, allocation, and settlement, but gains no mutation route or broker token.
- Same-provider v1 keeps its existing atomic sub-reservation and synchronous lease carve; it does not enter this journal.

### New threat review

| Threat | Mitigation |
| --- | --- |
| Two-provider overspend | Intent precedes authority; both budget holds commit in one atomic state write; parent and target broker ceilings are derived from that record. |
| Crash between provider holds | No sequential budget debit exists. Broker-side partial progress is identified by deterministic ids and either rolled back with zero-egress proof or exhausted. |
| Orphan target hold | Every target reservation/quota names a retained link and bounded expiry; unmatched evidence blocks readiness instead of becoming reusable quota. |
| Double settlement/replay | Monotonic states, transition number, immutable settlement digest, deterministic broker operations, and terminal idempotency. |
| Cross-provider prompt pivot | Existing target authority/lead checks, required containment, broker-only auth, no inherited secrets, depth one, and digest-only audit. |
| Price-model mismatch | Trusted target-provider pricing is required wherever a finite cost ceiling applies; unknown or changed pricing fails before intent or during recovery. |
| Generic-budget double charge | The child result is committed once to its target/global budget ids; the parent-provider budget receives only parent usage. |
| Recovery used as quota refund | Only zero-egress evidence permits rollback; missing, regressed, or conflicting counters exhaust or quarantine the hold. |

### Acceptance gate for v2

- Contract/migration tests accept v3 state by adding an empty journal, reject unknown states/fields, and preserve the v1 same-provider byte-for-byte behavior after migration.
- Atomicity tests kill after `intent`, during the atomic `held` write, after parent carve, after child admission, after target lease, and during settlement; each restart reaches the specified terminal state.
- Budget tests prove both provider/global holds fit before admission, concurrent requests admit one child, no target ordinary reservation creates independent authority, and parent/target budgets cannot double-spend.
- Broker tests prove deterministic parent-carve replay, mint-once target replay returning token-free `already_leased` evidence, separate provider scopes, target token non-persistence/non-retention, zero-egress rollback, bounded expiry, and once-only unused restoration.
- Recovery tests inject one-sided reservations, missing jobs, altered allocations, regressed counters, duplicate links, and settlement-digest mismatch; every ambiguity fails readiness without releasing quota.
- Operator-recovery tests prove inspect is redacted/read-only, mutation requires admin ownership plus confirm/digest/resolution, one quarantined `linkId` restores readiness, its audit evidence survives, and every other hold remains byte-for-byte unchanged.
- Usage tests prove target actuals charge target/global budgets once, parent actuals charge parent/global budgets once, unused linked allocation returns once, and crash-unknown exhausts both sides of the slice.
- End-to-end tests cover cross-provider success/failure/timeout/cancel, parent continuation, restart/idempotent replay, active-lead exclusion, no child delegation operation, and redacted parent/child audit.
- Observer/TUI and denial-sweep tests prove the linked state is read-only projection and no observer or worker credential gains administrative methods.

### Open questions for implementation review

1. What terminal-record compaction policy follows v2? V2 should retain records for at least the lifetime of the parent job, ledger retention, and all broker-quota expiries; eager deletion is out of scope.
2. May a future recovery return a partially unused slice from nonzero durable counters? V2 says no: all-zero target run quota is zero-egress proof, but any nonzero counter exhausts the full slice until counter durability is formalized as accounting evidence.
