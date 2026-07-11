# Headless v0.2 release plan

This is an acceptance checklist, not a completion claim. Version 0.2 is published only after every required macOS and Linux gate passes and no P0/P1 security or data-integrity defect remains.

## Release contract

- Required containment is the default; unsafe execution is explicit, marked, and unavailable to autonomy/councils. The `bypass` approval policy remains inside required containment.
- One authenticated daemon owns one canonical project root.
- State is external, owner-only, and keyed by the canonical-root hash.
- Workers receive isolated filesystem/environment roots and no ambient host credentials.
- Native login is the default after one-time project trust and receives only a backend-specific auth capsule; API-key brokering is explicit optional hardened mode.
- Native workers report provider-direct/backend-native access and unknown cost unless the CLI reports a charge. Broker workers use a run-scoped lease and broker-only egress.
- Model is optional at every public boundary; omission uses the backend CLI's configured default.
- Goals follow a bounded durable plan/delegate/execute/critique/revise/gate/decide/integrate loop with addressed messages, actual artifacts, and typed finality.
- Every expected failure returns a structured terminal result.
- macOS and Linux are required; Windows returns `UNSUPPORTED_PLATFORM` before launch.
- v1 repository state is verified before a crash-idempotent write-ahead import and remains unchanged.

## Acceptance matrix

| Area | Evidence required before release |
| --- | --- |
| Contracts | Runtime validation and golden tests for requests, results, bounded events, adapters, jobs, tasks, native session metadata, fleet/agent profiles, goals, turns, delegations, directed messages, reviews, votes, approvals, candidates, workflow DAGs/steps, grants, budgets, councils, and finality decisions. |
| Daemon | Typed route registration, cross-process authentication, project/principal/root spoof rejection, trust/fleet/goal/collaboration/approval/candidate operations, durable jobs/tasks/workflows/events, restart recovery, cancellation, leases/integration journals, bounded FIFO queuing, and TUI snapshots. |
| Ledger/state | Reserved-field protection, incremental verified reads, partial lines, exact full-prefix duplicate suppression, ownership-aware locks, digest-bound ledger and semantic context/task projections, and valid/invalid/crash-restarted v1 migration. |
| Policy/budgets | Persisted coordinator/grants, project/backend/operation/expiry/cost scope, model-aware immutable cost reservation, concrete pre-egress request pricing, shared aggregate request/input/output quotas across current and later leases, crash-unknown quota exhaustion, cost/artifact/concurrency/retry enforcement, and once-only provider/broker reconciliation. |
| Containment | Real Seatbelt, bubblewrap, and backend-seccomp probes in provider-direct and broker-only modes plus adversarial auth-capsule, nested repository `.env`/Git-config, project/sibling, symlink/hardlink, startup-hook, egress, pre-existing/late-created socket, and x86-64 x32-ABI tests. |
| Broker | Fake OpenAI, Anthropic, Gemini, and xAI upstreams covering streaming, cancellation, body/model/route limits, positive text-model policy, opaque context/tool/server-search/non-text-output/automatic-tier rejection under caps, deterministic standard-tier injection, extension bounded-input validation, conservative conflicting token maxima and multi-candidate multiplication, shared multi-lease request/token exhaustion, per-lease/global concurrency and body-memory caps, lease pruning, bounded quota retention, and credential non-exposure. |
| Execution | Durable lifecycle with a total creation-to-exit deadline, bounded FIFO queueing and overflow evidence, complete descendant cancellation and TERM-to-KILL escalation, positive timeout bounds, bounded/redacted streams/artifacts/diffs, malformed-output classification, stable-ID-only deduplication, and stream/subscriber/mailbox backpressure. |
| Sessions | Deterministic fake-CLI and required-containment E2E for Codex app-server/fallback, Claude, OpenCode, and Grok: login detection, create/resume, one active turn, cancellation, malformed/out-of-order/reconnected events, rate limits, restart, and bounded redacted replay fallback. |
| Collaboration | Iterative questions/revisions, addressed acknowledged messages, actual artifact/diff delivery, sticky leadership and health failover, optional election, four-worker/64-queue defaults, overflow, deterministic idle opportunities, rate-limit requeue bounds, approval modes, and finality enforcement. |
| Councils/workflows | Persisted restartable DAGs and atomically phase-bound/restart-resumed councils, actual dependency results/diffs, bounded budget-checked retries and terminal cancellation recovery, real proposal/candidate/review inputs, strict-majority attributable cross-referencing votes, candidate-job test finality, deterministic routing, queueing under caps, and enforced terminal decisions. |
| Writes | A durable preparing lease before Git worktree creation, strict worker worktree, pre-commit secret rejection, candidate/integration gates, fast-forward and advanced-primary paths, conflict/gate/cancel/crash recovery, retained evidence, and authorization. |
| Integrations | CLI/MCP/plugin/TUI use daemon authority, published configs invoke only compiled files, and MCP cannot select arbitrary roots/principals. |
| Package | v0.2 metadata alignment, clean build/declarations, tarball allowlists, clean tarball install, CLI/MCP/plugin startup, and generated-artifact cleanliness. |
| CI | Current macOS and Linux jobs exercise real containment and the complete release check. macOS CI explicitly enables the sanitized public DNS/TLS Seatbelt probe; ordinary local tests retain deterministic local IP/Unix-socket coverage without public network. Provider-key broker smoke and installed-CLI native-subscription smoke remain separate protected/opt-in jobs. |

## Open release gates

These must be closed or the release must remain unpublished:

1. The manually triggered protected provider-smoke workflow must pass with one bounded real broker request for OpenAI, Anthropic, Gemini, and xAI. Its `provider-smoke` GitHub environment requires secrets `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, and `XAI_API_KEY`, plus variables `HEADLESS_SMOKE_OPENAI_MODEL`, `HEADLESS_SMOKE_ANTHROPIC_MODEL`, `HEADLESS_SMOKE_GEMINI_MODEL`, and `HEADLESS_SMOKE_XAI_MODEL`. The harness exists, but this repository does not claim the credentialed run has passed.
2. Opt-in native-subscription smoke must pass without API keys for installed, already logged-in Claude, Codex, OpenCode, and Grok CLIs. Each run must omit model, remain read-only and required-contained, report provider-direct/backend-native evidence, leave the primary checkout unchanged, and retain the selected driver/version/auth fingerprint without auth contents. See [native-login.md](./native-login.md#opt-in-real-subscription-smoke).
3. The complete macOS/Linux workflow must pass in hosted CI in both authentication network modes; local argument-construction tests are not a substitute for real sandbox execution.

Do not carry forward an older local release pass after control-plane, native-auth, session-driver, fleet, TUI, or package changes. Re-run `release:check`, clean tarball installation, compiled `headless`/`hless`/`headless-mcp`/daemon/TUI/plugin startup, real Seatbelt, privileged bubblewrap/seccomp, and generated-artifact cleanliness from the final tree. The repository makes no claim that either real-account smoke has passed until its evidence is recorded.

## Milestone order

1. Characterize and split the daemon/CLI control plane; centralize errors, validation, result normalization, process-tree termination, and owner-only persistence.
2. Contracts, external state, project trust, auth capsules, broker protocols, strict platform containment, sessions, policy, budgets, and finality.
3. Durable execution, adapters/parsers, addressed collaboration, bounded FIFO scheduling/backpressure, rate-limit/watchdog recovery, and deterministic idle opportunities.
4. Goals, fleets, councils/workflows, approvals, candidates, and gated write integration.
5. CLI/MCP/plugin/TUI convergence and package/CI/documentation gates.

Milestones may be developed independently, but they do not justify a partial v0.2 publish.

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
