# Headless Project Audit Report

**Date:** 2026-08-04  
**Auditor:** Grok (full-repo static review)  
**Tree:** `0.2.0-beta.6` (unpublished private beta) + unreleased security/CLI fixes on `main`  
**Method:** Structure inventory, docs/gates cross-check, source review of high-risk paths (daemon, broker, containment, ledger, budgets, MCP/plugin, CLI), CHANGELOG/review history, hygiene signals. No full `bun run check` or live backend smoke was executed in this pass.

---

## 1. Executive summary

Headless is a **serious, security-first control plane** for heterogeneous AI coding CLIs (OpenCode, Claude Code, Codex, Grok). Its strongest assets are:

- Required OS containment (Seatbelt / bubblewrap+seccomp) with fail-closed degradation  
- Daemon-authoritative policy, budgets, jobs, and identity (client claims do not establish authority)  
- Hash-chained ledger + execution receipts  
- Write isolation via leased worktrees and candidate/integration gates  
- Broad automated test surface (~100+ test files, ~900+ test cases) and multi-layer gates  

It is **not release-ready for public npm or unattended production use**. The package is explicitly private beta; Gate A/B/C publication is still blocked; several load-bearing claims depend on opt-in live evidence, platform-gated CI, or operator-supplied extensions (pricing). Architecture quality is high in the kernel, but **maintainability debt is concentrated in a few multi-thousand-line modules**, and the **orchestration surface is much larger than the stable Beta 1 CLI**.

| Dimension | Assessment | Notes |
| --- | --- | --- |
| Security / containment design | Strong | Fail-closed, layered; documented accepted limits |
| Release readiness | Blocked | Private, unpublished; gates open |
| Kernel correctness | Strong (with residual risk) | Recent unreleased fixes show remaining edge cases |
| Orchestration maturity | Mixed | Feature-rich; experimental; large service classes |
| UX / golden path | Improving | Product Gate P largely green; TTFV still manual |
| Maintainability | At risk | Several 1.1k–2.2k LOC god modules |
| Packaging / distribution | Incomplete by design | `private: true`; plugin peers unpublished package |
| Windows | Unsupported | Explicit `UNSUPPORTED_PLATFORM` |

**Overall (private beta quality):** ~7.5–8/10 for kernel ambition and honesty; **~5/10 for “ship this to strangers”** until release gates and live evidence close.

---

## 2. Project shape (inventory)

| Area | Approx. size | Role |
| --- | --- | --- |
| `src/` | ~52k LOC, ~200 TS files | Product source |
| `tests/` | 107 test files | Kernel + orchestration coverage |
| `docs/` | Plan, gates, security narrative | Acceptance oracles |
| `plugin/` | OpenCode plugin | Lead/MCP-adjacent tools |
| `website/` | Docusaurus (~345MB w/ deps) | Public docs site |
| `opencode/` | Vendored clone (~257MB local) | **Not git-tracked**; reference only |
| `dist/` | Build output | **Not git-tracked** (correct) |
| `.poly/` | Local agent ledger/handoffs | **Untracked**; workspace noise |

**Stable public CLI surface** (`STABLE_COMMAND_NAMES`): 11 commands — `exec`, `lead`, `daemon`, `project`, `init`, `setup`, `status`, `doctor`, `mcp`, `tui`, `verify`.  
**Total command specs:** ~32 (remainder under `headless experimental`).

**Package:** `@proofofwork-agency/headless@0.2.0-beta.6`, `private: true`, Bun runtime, React/Ink TUI, Zod contracts, MCP SDK.

---

## 3. What is working well

### 3.1 Security model (design and documentation)

`SECURITY.md` and the runtime match a coherent threat model: untrusted backends, trusted local daemon, same-user host not in scope. Notable strengths:

- **No silent sandbox fallback** (`CONTAINMENT_UNAVAILABLE` instead of degrade)  
- **Isolated worker HOME/XDG/tmp**; ambient API keys and host agent sockets not inherited  
- **Broker leases** with finite request/token/cost bounds, redaction, concurrent caps  
- **Identity from authenticated connection**, not client-supplied actor fields (`daemon/auth.ts`)  
- **Owner-only sockets** with umask-at-bind + post-bind ownership checks (`secure-socket.ts`)  
- **Write path:** clean primary, leased worktree, secret scan before candidate commit, integration journal  
- **Redaction** deep + streaming (18+ patterns), fail-suppress on redaction failure  
- **Extensions** content-fingerprinted, path-canonicalized, ancestor-trusted, startup-only  

Recent unreleased fixes (CHANGELOG) show active hardening: weak HMAC keys, socket exclusivity, umask races, broker loopback ownership, CLI flag grammar, usage-error classification.

### 3.2 Contracts and fail-closed culture

Zod schemas dominate durable state; unknown enum values fail closed; legacy `provider-direct` → `native-direct-unrestricted` is an explicit narrow decoder, not free-form migration.

### 3.3 Test and gate infrastructure

- Large unit/integration suite with platform-aware skips (documented, not silent)  
- `bun run check` chains daemon hygiene, typecheck, lint/format, docs, tests, product gate  
- CI on macOS + Linux with real bubblewrap install and Seatbelt network probe on macOS  
- Product Gate P automated checks currently **8 pass / 2 manual / 0 fail** (standalone script)  
- Source hygiene bans `TODO`/`FIXME`/`@ts-ignore` in `src` (enforced by `scripts/source-hygiene.ts`)

### 3.4 Progressive disclosure

Stable help is intentionally small; experimental orchestration lives under `headless experimental`. Remedies, setup wizard, doctor, and exec profiles reduce ceremony without weakening containment defaults.

---

## 4. Critical / high issues

### C1 — Package is unpublished private beta (release blocker)

**Severity:** High (product/ops)  
**Evidence:** `package.json` `private: true`; README banner; `docs/plan.md` Gate A/B/C still open; both root and plugin manifests private.

**Impact:** No external install path; plugin `peerDependencies` on `@proofofwork-agency/headless@0.2.0-beta.6` cannot resolve from npm for third parties.

**Recommendation:** Keep blocked until Gate A (and intended gate) evidence is current on the final tree. Do not treat Product Gate P green as publish authority (docs already say this — preserve it).

---

### C2 — Live release evidence is incomplete or stale relative to claims

**Severity:** High (release integrity)  
**Evidence:**

- Native subscription smoke artifact (`docs/internal/release-evidence/native-subscription-smoke.json`) records Claude/Codex failures (rate-limited / failed) while still `releaseGatePassed: true` under platform-aware rules.  
- Product Gate P.TTFV remains **manual**: “Legacy evidence lacks strict provenance/output fields; rerun `bun run smoke:ttfv:live`.”  
- Plan still requires re-running full `release:check`, pack smoke, and platform CI after control-plane/session/TUI/package changes.  
- Unreleased CHANGELOG items have not been cut as a beta tag.

**Impact:** Easy to overclaim readiness from historical smokes or green unit tests.

**Recommendation:** Treat every publish decision as requiring **fresh** `release:check` + platform CI + opt-in native smoke on the exact commit; regenerate TTFV live evidence with strict provenance fields.

---

### C3 — Hosted Linux CI skips load-bearing run-tool cooperation tests

**Severity:** High (coverage / regression risk)  
**Evidence:** `docs/internal/hosted-linux-relay-follow-up.md`; `HOSTED_LINUX_RELAY_INCOMPATIBLE` skips four tests in `tests/daemon-run-tool.test.ts` (and one containment case) when `GITHUB_ACTIONS && linux`.

**Impact:** Depth-one `run.delegate`, helper inject/revoke, and child failure isolation are **not proven on GitHub Linux**. macOS CI and local privileged Docker remain the proof path. Hosted runner kernel/AppArmor incompatibilities are real but leave a permanent blind spot if unaddressed.

**Recommendation:** Keep the skip documented; prioritize self-hosted or `act`-shaped reproducer; do not weaken bubblewrap/seccomp to satisfy hosted CI. Track exit criteria from the follow-up doc explicitly in Gate A/B checklists.

---

### C4 — Empty built-in pricing registry (cost attribution fail-closed by design, operator foot-gun)

**Severity:** High (ops / spend honesty)  
**Evidence:** `src/runtime/pricing.ts` registry is empty; `SECURITY.md` states USD attribution needs trusted dated pricing via daemon extension; cost ceilings with unknown pricing fail closed.

**Impact:** Default installs cannot attribute USD cost without extensions. Operators may misread “unknown cost” or hit admission failures when they expect default $5 caps to work with real pricing.

**Recommendation:** Ship or document a **reference pricing extension** path for broker mode; surface doctor/readiness warning when cost caps apply and registry is empty (partially documented — make CLI-visible on `doctor`).

---

### C5 — Same-user / host compromise is outside the boundary (accepted, but easy to misuse)

**Severity:** High (if operators expect more)  
**Evidence:** `SECURITY.md` — not a boundary against attacker with same host user, PATH, Bun/Git, sandbox tooling, or ledger key.

**Impact:** Marketing or internal use that treats Headless as multi-tenant isolation on a shared user account is wrong.

**Recommendation:** Keep README/SECURITY prominence; never market multi-user host isolation without redesign.

---

## 5. Medium issues

### M1 — God modules threaten reviewability and regression safety

Largest source files (approx.):

| File | Lines |
| --- | --- |
| `src/daemon/server.ts` | 2181 |
| `src/runtime/budget-store.ts` | 1722 |
| `src/daemon/job-admission-service.ts` | 1694 |
| `src/broker/server.ts` | 1661 |
| `src/runtime/goal-coordinator-service.ts` | 1569 |
| `src/runtime/ledger-v2.ts` | 1400 |
| `src/runner/simple.ts` | 1192 |
| `src/runtime/os-sandbox.ts` | 1140 |
| `src/daemon/run-execution-service.ts` | 1139 |

**Impact:** Security-critical logic (budgets, linked holds, admission, broker bounds) is hard to audit end-to-end; partial extractions already exist (route-handlers, services) but composition still concentrates in server/admission.

**Recommendation:** Continue service extraction with **invariant tests at module boundaries** (budget atomicity, lease revocation, admission denial matrix) rather than pure move-code refactors.

---

### M2 — Orchestration surface far exceeds stable product promise

Goals, fleets, councils, workflows, loops, autonomy, skills, sessions, candidates, receipts, repair loops, and depth-one delegation exist in daemon/MCP/plugin, while Beta 1 stable CLI is 11 commands.

**Impact:**

- Cognitive load for contributors  
- Risk of experimental paths drifting without Product Gate owner ack  
- Plugin/MCP can expose more power than the “stable” story implies when `HEADLESS_MCP_TOOLSET=full`

**Recommendation:** Keep experimental namespace hard; default MCP lead-core toolset (already present) should remain default; document which experimental daemon routes are considered Gate B blockers vs optional.

---

### M3 — Native-login and Claude Keychain friction

**Severity:** Medium  
**Evidence:** Keychain-only Claude fails closed under required Seatbelt; explicit setup-token capsule required; native-login requires project trust + unrestricted egress acknowledgement.

**Impact:** Golden path on macOS Claude is multi-step and easy to fail closed for operators who only “logged in” via Keychain UI. Correct security posture, poor TTFV for that backend.

**Recommendation:** Keep fail-closed; invest in setup/doctor remedies (partially present) and case-study docs; do not reintroduce Keychain import.

---

### M4 — Grok remains experimental / attestation-heavy

**Severity:** Medium  
**Evidence:** Isolation attestation, vacuous-trust canary, refresh_token stripping, `inspect --json` network-denied proof.

**Impact:** Higher maintenance cost; more failure modes (`NATIVE_AUTH_*`, isolation failures); Gate C still blocks advertising write for backends without write smoke — Grok write especially sensitive.

**Recommendation:** Keep experimental labeling until isolation characterization is fully automated in CI (where binary available).

---

### M5 — Broker default loopback TCP exposure (local)

**Severity:** Medium (local network)  
**Evidence:** Broker binds owner-only Unix socket **and** loopback TCP by default; `HEADLESS_BROKER_ALLOW_LOOPBACK_TCP=0` for AF_UNIX-only.

**Impact:** On multi-user or multi-process localhost environments, loopback bearer tokens increase attack surface vs Unix-only. Mitigations exist (short-lived scoped tokens, redaction); still weaker than AF_UNIX-only.

**Recommendation:** Consider AF_UNIX-only default when Linux required containment is the primary mode; or document strongly in doctor for multi-user hosts.

---

### M6 — HMAC ledger integrity is opt-in

**Severity:** Medium  
**Evidence:** Unkeyed SHA-256 chain can be recomputed by anyone who can write state files; HMAC requires `HEADLESS_LEDGER_KEY` / keyring; external head anchor still needed against tail deletion.

**Impact:** Default deployments get tamper-*evident* not tamper-*proof* ledgers.

**Recommendation:** Doctor should warn when HMAC is unset if operator claims audit requirements; document external anchoring options (partially in SECURITY).

---

### M7 — Redaction cannot cover proprietary secrets

**Severity:** Medium (accepted limit)  
**Evidence:** Pattern scanner; candidate scan fails closed on triggers but cannot know custom secret formats; false positives previously blocked valid code (fixed for some patterns).

**Impact:** Write candidates with novel secret shapes can pass pattern scan; retained candidates still need human review (documented).

**Recommendation:** Optional project-supplied pattern lists (carefully designed, size-bounded) for Gate C; keep fail-closed on scan errors.

---

### M8 — Detached daemon lifecycle / orphans

**Severity:** Medium  
**Evidence:** `connectOrStartDaemon` spawns detached daemons; `daemon reap` / inventory added for lost state homes; tests for lifecycle leaks.

**Impact:** Disposable test roots and crashed operators can leave processes; mitigated but remains an operator care item.

**Recommendation:** Ensure `doctor` / `status` always surface orphan inventory; keep `check:daemons` first in kernel check (already wired).

---

### M9 — Windows permanently unsupported (product limit)

**Severity:** Medium (market / support)  
**Evidence:** Explicit early refusal in daemon, runner, CLI.

**Impact:** Entire enterprise Windows segment excluded; correct given Seatbelt/bwrap design.

**Recommendation:** Keep fail-closed; avoid half-ports.

---

### M10 — Coordinator / collaboration doc drift

**Severity:** Low–Medium (process)  
**Evidence:** Root `AGENTS.md` and `Claude.md` ContextRelay blocks both say coordinator is Codex; system session context may disagree; `Claude.md` also says “human / you decide per session.”

**Impact:** Multi-agent sessions may fight over git write ownership.

**Recommendation:** Single source of truth for coordinator; strip conflicting sentences.

---

### M11 — Repo hygiene: untracked `.poly/`, large local `opencode/` and `website/node_modules`

**Severity:** Low  
**Evidence:** Git status shows `?? .poly/`; `opencode/` and website deps are local bulk.

**Impact:** Agent noise, disk use, accidental commit risk if ignore rules slip.

**Recommendation:** Ensure `.poly/` and any poly workspaces are gitignored if they remain local tooling artifacts; keep `opencode/` untracked (already).

---

### M12 — Silent catch in provider resolution

**Severity:** Low  
**Evidence:** `src/daemon/server.ts` `providerForBackend` uses `catch {}` then falls back to model prefix.

**Impact:** Mis-registered backends may silently get wrong provider attribution for budgeting/pricing.

**Recommendation:** Log diagnostic or return structured unknown rather than empty catch.

---

## 6. Architecture risks (systemic)

### 6.1 Dual authority surfaces (CLI root vs MCP lead vs observer TUI)

The design intentionally splits authority. Complexity cost:

- Many credential scopes and tool allowlists  
- Easy to introduce a mutation path that skips a scope check  
- Tests cover spoof rejection extensively — keep them as release blockers  

### 6.2 Dual execution entry points

Stable `exec()` always goes through the daemon (`src/index.ts`). Experimental `runHeadless` / runner path still exists for internal/supervisor use. Risk is callers bypassing daemon policy.

**Recommendation:** Keep experimental package exports explicit; lint or test that public SDK cannot spawn workers without daemon.

### 6.3 Linked holds and crash recovery

Cross-provider delegation + crash-atomic linked holds are among the hardest correctness regions (`budget-store`, `linked-hold-recovery`). Recent work is sophisticated; residual risk is high if refactors land without dedicated property tests.

### 6.4 Backend version coupling

Parsers and probes pin CLI help fragments and minimum versions (e.g. OpenCode). Upstream CLI churn (Codex envelopes, Claude flags, Grok inspect) historically broke parse fidelity (documented in July review). Continuous live matrix is necessary, not optional.

### 6.5 Surface freeze vs feature gravity

Product Gate P.SCOPE freezes stable commands, but experimental + MCP + plugin still expand. Without Gate B discipline, the product becomes an orchestration suite before the kernel is published.

---

## 7. Testing gaps and blind spots

| Gap | Why it matters |
| --- | --- |
| Hosted Linux run-tool skips | Delegation / helper lifecycle unproven on GHA Linux |
| Live TTFV strict provenance | Golden-path UX claim not fully automated |
| Provider-key broker smoke optional | Real broker protocol vs fake upstreams |
| Windows | N/A by policy |
| Cross-process long soak | Resource leaks under multi-day daemon |
| Adversarial MCP tool argument fuzzing | Large tool registry surface |
| Full-suite runtime in this audit | Report is static; re-run `bun run check` before decisions |

Platform-conditional skips are generally **correct** (darwin/linux/git/bwrap) and inventory-tested via `gated-coverage.test.ts` — good practice.

---

## 8. Dependency and packaging notes

| Item | Status |
| --- | --- |
| Bun engine | `>=1.1.0` declared; CI pins `1.3.14` |
| `@modelcontextprotocol/sdk` | 1.29.0 |
| React 19 + Ink 7 | TUI only |
| Zod 3 | Contracts |
| Plugin peer on unpublished headless | Distribution incomplete |
| `files` allowlist | Narrow (good) |
| `prepublishOnly` | Runs full release check (good when publish unblocked) |
| Vendored `opencode/` | Local reference; not in package |

---

## 9. Documentation quality

| Doc | Quality |
| --- | --- |
| README | Honest beta warning; clear golden path |
| SECURITY.md | Excellent; explicit limits |
| docs/plan.md | Strong acceptance checklist |
| docs/product-gate.md | Clear oracle vs security gates |
| docs/review-2026-07-09.md | Historical; correctly marked non-current |
| fleet forensic docs | Historical; not release evidence |
| CHANGELOG | High signal; recent unreleased security fixes well described |

**Doc risks:** Historical scores (e.g. “8.5/10”) can be misread as current release attestation — the headers warn; keep them.

---

## 10. Issue severity matrix (summary)

| ID | Severity | Area | One-liner |
| --- | --- | --- | --- |
| C1 | Critical/High | Release | Private beta, unpublished |
| C2 | High | Evidence | Live/smoke evidence incomplete or stale |
| C3 | High | CI | Hosted Linux skips run-tool cooperation |
| C4 | High | Cost | Empty pricing registry |
| C5 | High | Threat model | Same-user boundary must not be oversold |
| M1 | Medium | Maintainability | Multi-kLOC god modules |
| M2 | Medium | Product | Experimental surface sprawl |
| M3 | Medium | UX/security | Claude Keychain fail-closed friction |
| M4 | Medium | Backend | Grok experimental complexity |
| M5 | Medium | Network | Broker loopback TCP default |
| M6 | Medium | Integrity | HMAC ledger opt-in |
| M7 | Medium | Secrets | Pattern redaction limits |
| M8 | Medium | Ops | Detached daemon orphans |
| M9 | Medium | Platform | No Windows |
| M10 | Low–Med | Process | Coordinator doc conflict |
| M11 | Low | Hygiene | `.poly/` untracked |
| M12 | Low | Code quality | Empty catch in provider resolve |

---

## 11. Recommended priority order

1. **Do not publish** until Gate A checklist is green on the exact tree (including fresh native smoke + pack smoke + both CI platforms).  
2. **Close or permanently escalate C3** (hosted Linux run-tool) with a self-hosted reproducer plan; keep skips documented.  
3. **Cut unreleased CHANGELOG** into a beta tag only after full `release:check`.  
4. **Regenerate TTFV live** with strict provenance fields.  
5. **Surface pricing emptiness** in doctor when cost caps matter; optional reference pricing extension.  
6. **Continue budget/admission/broker boundary tests** before further god-file growth.  
7. **Freeze stable CLI** aggressively; Gate B work under experimental until Gate A publishes.  
8. **Ignore-list `.poly/`** (if tooling continues to write it).  
9. **Unify coordinator** sentence across AGENTS/Claude docs.  
10. **Optional:** AF_UNIX-only broker default for multi-user cautionary environments.

---

## 12. Positive residual judgment

Despite the blockers above, this is **not a prototype that merely claims security**. The containment, broker, ledger, and write-integration design show repeated adversarial hardening, explicit fail-closed choices, and unusually honest docs for a multi-agent tooling project. The main risk is **shipping or scaling orchestration before the publication evidence and CI blind spots are closed**, and **losing auditability as the largest modules keep growing**.

---

## 13. Audit limitations

- Static review; did not run full `bun test` / `bun run check` / live native matrix in this session.  
- Did not re-audit every daemon route for scope completeness line-by-line.  
- Did not perform penetration testing against Seatbelt/bwrap profiles.  
- Product Gate was run standalone (8 pass / 2 manual); kernel suite not re-verified here.  
- Findings about “current” smoke evidence reflect files present on 2026-08-04 and may change when operators re-run smokes.

---

## 14. Suggested next action for the team

Run on a clean tree:

```bash
bun install --frozen-lockfile --ignore-scripts
bun run check
bun run build
bun run smoke:pack
# opt-in when CLIs are logged in:
HEADLESS_NATIVE_SMOKE=1 bun run smoke:native
HEADLESS_TTFV_LIVE=1 bun run smoke:ttfv:live
```

Use those results + `docs/plan.md` Gate A table as the only publish oracle; treat this report as a prioritized risk register, not as gate evidence.

---

*End of report.*
