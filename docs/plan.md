# Headless v0.2 release plan

This is an acceptance checklist, not a completion claim. Publication happens per gate: Gate A publishes `0.2.0-beta.1` (kernel surface), Gate B publishes the orchestration beta, Gate C publishes writes GA. No gate publishes while a P0/P1 security or data-integrity defect remains, and no later-gate evidence requirement is deleted by this staging — it is sequenced.

## Product vision (context for every gate)

Any supported CLI coder — OpenCode, Claude Code, Codex, Grok (experimental), more later — can become the single externally launched **lead**. The lead uses the other backends as contained headless workers: one orchestrator, multiple servants, with deliberation, judge panels (councils), fleets, goals, workflows, tasks, and skills. Headless is the successor of ContextRelay: every coordination capability that required two terminals there is daemon-authoritative and contained here. The TUI is the observability pane for this loop. End-state UX: open one CLI coder, bind it as lead, and go. All writes flow through leased worktrees and candidate gates — never ambient write access. Experimental worker-initiated delegation is hard-capped at depth one, one read-only child, same-provider broker authority, inherited deadlines, and an atomic slice of the parent's reservation.

The orchestration surfaces are the product, not compatibility baggage; the contained execution kernel is their substrate. Gates below sequence hardening — they do not deprecate the vision.

## Release contract

- Required containment is the default; unsafe execution is explicit, marked, and unavailable to autonomy/councils. The `bypass` approval policy remains inside required containment.
- One authenticated daemon owns one canonical project root.
- One externally launched foreground lead binds by explicit host and generation; Headless never elects or owns its provider process.
- The TUI authenticates as an observer and can read snapshots/events only. Any future configuration surface renders state and generates root-CLI commands; it does not hold mutation authority.
- Run-tool cooperation health is not containment evidence. Linux launch still fails closed when the required supervisor, relay runtime, scoped socket, namespace, or seccomp arrangement is absent, but the active relay round-trip remains diagnostic-only and a real helper failure is local to that call.
- State is external, owner-only, and keyed by the canonical-root hash.
- Persisted state is upgrade-compatible: durable read boundaries decode known superseded schema values through an explicit legacy-aware codec (fail-closed for unknown values); new writes and RPC remain strict. A release that renames or removes a persisted enum/field ships the corresponding read-compatibility entry and an upgraded-state fixture in the same change.
- Workers receive isolated filesystem/environment roots and no ambient host credentials.
- Broker mode is the default and receives finite per-run request, token, and priced-cost ceilings. Native login is explicit opt-in after project trust plus unrestricted-egress acknowledgement and receives only a backend-specific auth capsule.
- Native workers report native-direct-unrestricted/backend-native access and unknown cost unless the CLI reports a charge. Broker workers use a run-scoped lease and broker-only egress.
- Model is optional for native execution; broker/provider policy may require an explicit model for pricing and request bounds.
- Goals follow a bounded durable plan/delegate/execute/critique/revise/gate/decide/integrate loop with addressed messages, actual artifacts, and typed finality.
- Worker `run.delegate` admission is daemon-derived and non-queueing: one depth-one read-only child, no native credentials or cross-provider pivot in v1, no delegate operation on the child, and no spend authority beyond the parent's atomic sub-reservation.
- Every expected failure returns a structured terminal result.
- macOS and Linux are required; Windows returns `UNSUPPORTED_PLATFORM` before launch.
- v1 repository state is verified before a crash-idempotent write-ahead import and remains unchanged.

## Gate A — kernel beta (`0.2.0-beta.1`)

Scope: one bounded contained execution, the daemon control plane, project trust, lead binding, MCP lead attachment, and the read-only observer log/Config TUI. This is the "open one CLI coder, bind it as lead, and go" entry point.

| Area | Evidence required before Gate A publish |
| --- | --- |
| Contracts | Runtime validation and golden tests for requests, results, bounded events, adapters, jobs, tasks, native session metadata, grants, budgets, and structured errors. |
| Upgrade compatibility | Legacy-aware persisted-RunResult decoding at every durable read boundary (run-event projection, protected archive with raw-bytes hash verification before normalization, jobs, sessions, workflow steps); an upgraded-state fixture proving daemon/doctor startup and canonical RPC reads against pre-rename state with unchanged archive bytes/hashes and fail-closed unknown values. |
| Daemon | Typed route registration, cross-process authentication, project/principal/root spoof rejection, lead attach/heartbeat/switch/release, observer-only snapshots/events, trust/approval operations, durable jobs/tasks/events, restart recovery, cancellation, leases/integration journals, and bounded FIFO queuing. |
| Lead onboarding | `lead use|status|release` plus automated MCP install/attach parity for OpenCode, Claude Code, Codex, and Grok config paths; generation-bound MCP clients share attach/heartbeat behavior; MCP cannot select arbitrary roots/principals or self-confirm approvals/integration. |
| Observer TUI | Dedicated observer credentials limited to ping/snapshots/events; log and Config views for daemon, backend, trust, lead, and budget state; exact root-CLI command generation only; exhaustive denial of every mutation route. |
| Ledger/state | Reserved-field protection, incremental verified reads, partial lines, exact full-prefix duplicate suppression, ownership-aware locks, digest-bound ledger and semantic context/task projections, and valid/invalid/crash-restarted v1 migration. |
| Policy/budgets | Persisted root/lead/grant authority, project/backend/operation/expiry/cost/iteration scope, model-aware immutable cost reservation, concrete pre-egress request pricing, shared aggregate request/input/output quotas across current and later leases, crash-unknown quota exhaustion, cost/artifact/concurrency/retry enforcement, and once-only provider/broker reconciliation. |
| Containment | Real Seatbelt, bubblewrap, and backend-seccomp probes in native-direct-unrestricted and broker-only modes plus adversarial auth-capsule, nested repository `.env`/Git-config, project/sibling, symlink/hardlink, startup-hook, egress, pre-existing/late-created socket, and x86-64 x32-ABI tests. |
| Broker | Fake OpenAI, Anthropic, Gemini, and xAI upstreams covering streaming, cancellation, body/model/route limits, positive text-model policy, opaque context/tool/server-search/non-text-output/automatic-tier rejection under caps, deterministic standard-tier injection, extension bounded-input validation, conservative conflicting token maxima and multi-candidate multiplication, shared multi-lease request/token exhaustion, per-lease/global concurrency and body-memory caps, lease pruning, bounded quota retention, and credential non-exposure. |
| Execution | Durable lifecycle with a total creation-to-exit deadline, bounded FIFO queueing and overflow evidence, complete descendant cancellation and TERM-to-KILL escalation, positive timeout bounds, bounded/redacted streams/artifacts/diffs, malformed-output classification, stable-ID-only deduplication, stream/subscriber/mailbox backpressure, and bounded per-call run-tool failure without launch-wide probe poisoning. |
| Sessions | Deterministic fake-CLI and required-containment E2E for Codex app-server/fallback, Claude, OpenCode, and Grok: login detection, create/resume, one active turn, cancellation, malformed/out-of-order/reconnected events, rate limits, restart, and bounded redacted replay fallback. |
| Package | v0.2 metadata alignment, clean build/declarations, tarball allowlists, clean tarball install, CLI/MCP/daemon startup, and generated-artifact cleanliness. |
| CI | Current macOS and Linux jobs exercise real containment and the complete release check. macOS CI explicitly enables the sanitized public DNS/TLS Seatbelt probe; ordinary local tests retain deterministic local IP/Unix-socket coverage without public network. Provider-key broker smoke and installed-CLI native-subscription smoke remain separate protected/opt-in jobs. |

## Gate B — orchestration beta

Scope: the lead's multi-agent surfaces — deliberation fan-out, councils/judge panels, fleets, goals, workflows, loops, skills — plus their projections in the observer TUI and the plugin. Requires Gate A published.

| Area | Evidence required before Gate B publish |
| --- | --- |
| Contracts | Runtime validation and golden tests for fleet/agent profiles, goals, turns, planned delegations, depth-one run-tool delegation links, directed messages, reviews, votes, approvals, candidates, workflow DAGs/steps, councils, and finality decisions. |
| Daemon | Fleet/goal/collaboration/candidate operations, durable workflows, one-child `run.delegate` admission/recovery/cancellation, and their restart recovery under the same authentication and queueing guarantees as Gate A. |
| Collaboration | Iterative questions/revisions, addressed acknowledged messages, actual artifact/diff delivery, sticky task synthesis and health failover without authority promotion, active-lead backend exclusion for automatic routing, optional election, four-worker/64-queue defaults, overflow, deterministic idle opportunities, rate-limit requeue bounds, approval modes, finality enforcement, and bounded same-provider worker delegation with atomic parent-budget inheritance. |
| Councils/workflows | Persisted restartable DAGs and atomically phase-bound/restart-resumed councils, actual dependency results/diffs, bounded budget-checked retries and terminal cancellation recovery, real proposal/candidate/review inputs, strict-majority attributable cross-referencing votes, candidate-job test finality, deterministic routing, queueing under caps, and enforced terminal decisions. |
| End-to-end evidence | One recorded contained smoke: a real bound lead attaches via MCP, fans out `headless_deliberate` to at least two other backends, runs `council_deliberate` through vote and decision, and the full trace is verifiable in the ledger and visible in the TUI events view. |
| Integrations | CLI/MCP/plugin use daemon authority, the OpenCode plugin shares attach/heartbeat behavior, the TUI is observer-only, and release configs invoke only compiled files. |
| Package/CI | Gate A package and CI requirements re-verified from the Gate B tree. |

## Gate C — writes GA (`0.2.0`)

Scope: write mode as a standard, gated capability for every advertised backend. Requires Gate B published.

| Area | Evidence required before Gate C publish |
| --- | --- |
| Writes | A durable preparing lease before Git worktree creation, strict worker worktree, pre-commit secret rejection, candidate/integration gates, fast-forward and advanced-primary paths, conflict/gate/cancel/crash recovery, retained evidence, and authorization. |
| Per-backend enablement | Each advertised backend passes installed native-login write smoke before its write mode is advertised; Grok remains blocked until its full isolation characterization gate passes. |
| Package/CI | Gate A/B package and CI requirements re-verified from the Gate C tree. |

## Open release gates

These must be closed or the affected gate must remain unpublished:

1. The manually triggered protected provider-smoke workflow must pass with one bounded real broker request for OpenAI, Anthropic, Gemini, and xAI. Its `provider-smoke` GitHub environment requires secrets `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, and `XAI_API_KEY`, plus variables `HEADLESS_SMOKE_OPENAI_MODEL`, `HEADLESS_SMOKE_ANTHROPIC_MODEL`, `HEADLESS_SMOKE_GEMINI_MODEL`, and `HEADLESS_SMOKE_XAI_MODEL`. The harness exists, but this repository does not claim the credentialed run has passed. (Gate A)
2. Opt-in native-subscription smoke must pass without API keys for installed, already logged-in Claude, Codex, and OpenCode CLIs. Each run must omit model, remain read-only and required-contained, report native-direct-unrestricted/backend-native evidence, leave the primary checkout unchanged, and retain the selected driver/version/auth fingerprint without auth contents. Grok remains experimental until its full characterization gate passes. See [native-login.md](./native-login.md#opt-in-real-subscription-smoke). (Gate A)
3. The recorded lead→deliberate→council end-to-end smoke described under Gate B. (Gate B)

The complete current branch, including depth-one contained delegation, has passed the hosted macOS and Linux workflow. That evidence closes the former CI-bootstrap blocker but is not a substitute for either credentialed Gate A smoke above, and it must be re-run after relevant changes.

Do not carry forward an older local release pass after control-plane, native-auth, session-driver, fleet, TUI, or package changes. Re-run `release:check`, clean tarball installation, compiled `headless`/`hless`/`headless-mcp`/daemon/TUI/plugin startup, real Seatbelt, privileged bubblewrap/seccomp, and generated-artifact cleanliness from the final tree. The repository makes no claim that either real-account smoke has passed until its evidence is recorded.

## Milestone order

1. Characterize and split the daemon/CLI control plane; centralize errors, validation, result normalization, process-tree termination, and owner-only persistence. (Gate A)
2. Contracts, external state, upgrade-compatibility codec, project trust, auth capsules, broker protocols, strict platform containment, sessions, policy, budgets, and finality. (Gate A)
3. Durable execution, adapters/parsers, bounded FIFO scheduling/backpressure, rate-limit/watchdog recovery, lead binding, and automated MCP lead onboarding for all advertised backends. (Gate A)
4. Addressed collaboration, goals, fleets, councils/workflows, deterministic idle opportunities, approvals, and their projections in the observer TUI. (Gate B)
5. Candidates and gated write integration with per-backend enablement. (Gate C)
6. Package/CI/documentation checks re-run at every gate boundary.

Milestones may be developed independently, but a gate publishes only when every requirement in its own table and all previous gates' tables passes.

## Local release commands

```bash
bun install --frozen-lockfile --ignore-scripts
bun run check
bun run build
bun run smoke:pack
# Explicit opt-in, real installed subscription logins, no provider API keys.
HEADLESS_NATIVE_SMOKE=1 bun run smoke:native
```

`bun run release:check` runs the same typecheck/test/build/pack-install chain. A local pass does not replace both platform CI jobs.

The live provider harness is deliberately separate and requires the protected credentials/model variables listed above:

```bash
bun run smoke:providers
```

Do not treat a skipped or uncredentialed invocation as a passed provider gate.

Native-subscription smoke is likewise separate and manually opted in. Its harness clears provider API-key variables and exercises each installed CLI's existing login from disposable project/state/runtime roots using compiled artifacts. Follow [native-login.md](./native-login.md#opt-in-real-subscription-smoke); a missing binary/login is an explicit skip/failure, not a passing release result.
