# Handoff → workflow `continue-security-fixes` (`wfrun_msaoj0cc_a2`)
# From: free-text LEAD grok (dig after implement-fix-1/2 errors)
# TS: 2026-08-01T18:13:00Z
# Audience: remaining/revise/verify hops + any resume after stop

## Hop board (as observed)
| Hop | Seat | State | Notes |
|-----|------|-------|-------|
| plan-security-fixes | @glm | done | plan produced |
| implement-fix-1 | @grok-3 | **error** | likely sec-socket-chmod-race or early batch; no durable socket helper landed |
| implement-fix-2 | @grok-2 | **error** | likely sec-owner-only-no-uid; ensureOwnerOnly* still weak |
| implement-fix-3 | @grok-3 | was running | broker token query path |
| implement-fix-4 | @grok-2 | was running | broker TCP + ledger HMAC |

## Working tree progress (git status at dig time)
Already modified (do **not** revert; build on top):
- `src/broker/server.ts` — headers-only extractToken; `?key=` → 400 migration hint; upstream `searchParams.delete("key")`; `allowLoopbackTcp` / Unix-only when socket set; lease may include `unixSocket`
- `tests/broker.test.ts` — Gemini uses `x-goog-api-key`; new reject-`?key=` test
- `src/daemon/server.ts` — broker constructed with `allowLoopbackTcp: linux ? undefined : true`
- `src/daemon/run-execution-service.ts` — plumbs `unixSocket` authoritatively
- `src/runner/simple.ts` — comments + `HEADLESS_BROKER_UNIX_SOCKET`; Linux requires broker unix socket
- `src/runtime/ledger-v2.ts` — HMAC key floor raised; fail-closed weak keys
- `tests/ledger-keys.test.ts` (new), ledger/receipt test touch-ups
- `SECURITY.md` — docs for key gen / broker surface

## Issue checklist for remaining hops

### DONE (treat as fixed unless review finds holes)
1. **sec-broker-token-query** (high)
   - `extractToken(request)` headers only: `x-headless-token`, Bearer, `x-api-key`, `x-goog-api-key`
   - bare `?key=` → **400** with header-auth message; token must never appear in body/logs
   - verify: `bun test tests/broker.test.ts` (reject query key + gemini header path)

2. **sec-broker-tcp-surface** (medium) — mostly done
   - Unix socket configured + default: **no host TCP** on Linux
   - Darwin: loopback TCP residual-trust forced on (CLI SDKs need HTTP BASE_URL)
   - Opt-in: `allowLoopbackTcp` / `HEADLESS_BROKER_ALLOW_LOOPBACK_TCP=1`
   - Workers: `unixSocket` authoritative; baseUrl may be synthetic loopback for relay port
   - residual: broker unix still `chmod` after `Bun.serve({ unix })` (same TOCTOU class as #3)

3. **sec-ledger-hmac-key-floor** (medium)
   - keys must meet ≥32-byte entropy floor; weak keyring/env fails startup
   - tests: `tests/ledger-keys.test.ts`, ledger-v2/receipt adjustments
   - verify: `bun test tests/ledger-keys.test.ts tests/ledger-v2.test.ts`

### STILL OPEN — implement next (fix-1 / fix-2 failed)

4. **sec-socket-chmod-race** (high) — **NOT FIXED**
   Evidence still live:
   - `src/daemon/server.ts` ~244–250: `server.listen(...)` then `chmodSync(..., 0o600)`
   - `src/daemon/run-tool-endpoint.ts` ~190–195: same pattern
   - `src/broker/server.ts` ~324–325: `Bun.serve({ unix })` then `chmodSync`
   - `src/runtime/os-sandbox.ts` ~963: staged string `listen(...=>chmodSync...)`
   Fix plan (minimal):
   - Add shared helper e.g. `secureChmodUnixSocket(path)` that: lstats, requires isSocket, uid===getuid() (or root-only if euid0), `(mode & 0o077)===0` after chmod 0o600; throw otherwise
   - Before listen: ensure parent dir via hardened owner-only; `umask(0o077)` around bind if feasible restore after
   - Immediately after listen callback / Bun.serve unix: call helper before any accept path returns to callers
   - Prefer binding with restrictive umask so window is closed even before chmod
   - Apply to daemon, run-tool, broker unix, os-sandbox stage snippet
   - Test: after start, `lstat` mode `0o600` and uid match; document TOCTOU closure
   - Do not add public CLI

5. **sec-owner-only-no-uid** (high) — **NOT FIXED**
   Evidence still live:
   - `src/runtime/project-state.ts` `ensureOwnerOnlyDirectory` / `ensureOwnerOnlyFile` (~159–176): mkdir/lstat/chmod only — **no uid, no ancestor walk**
   - Contrast: `src/runtime/daemon-extensions.ts` `secureCanonicalFile` / `assertTrustedAncestorChain` (~380–414) already check uid + 0o022 + sticky-root exception
   Fix plan:
   - Lift or share ancestor/uid checks into project-state (or call daemon-extensions helpers without cycles)
   - After lstat: reject symlink; require directory/file; `uid === process.getuid()` (allow uid0 only if running as root); chmod 0700/0600; require `(mode & 0o077) === 0`
   - Walk ancestors: owner uid + not group/other-writable unless sticky root-owned dir with self-owned child (same rule as daemon-extensions)
   - Cover tokenPath, observerTokenPath, integrationsDir, daemonRuntimeDir, socket parent, credentials parents
   - Tests: foreign-uid path fails; group-writable ancestor fails; symlink swap fails; happy path still 0700/0600
   - Suggested test file: extend `tests/project-state*.test.ts` or nearest existing

## Failure analysis (fix-1 / fix-2)
- Ledger shows implement seats exploring socket chmod + ensureOwnerOnly but **no completed implement report** and no helper landed for those two.
- Concurrent multi-hop edits on `src/broker/server.ts` are active; failed hops may be tool/timeout/race rather than bad plan.
- **Guidance for revise hops:** skip redoing token-query / ledger / TCP; only land socket TOCTOU + owner-only uid. Serialize file touches: project-state first, then daemon/run-tool/broker chmod helper.

## Suggested verify commands (narrow)
```bash
bun test tests/broker.test.ts tests/ledger-keys.test.ts tests/ledger-v2.test.ts
# after owner-only + socket fixes:
bun test tests/daemon.test.ts tests/project-state.test.ts 2>/dev/null || bun test tests/daemon*.test.ts
```

## Do not
- Revert broker/ledger patches already in tree
- Add stable public CLI surfaces (scope freeze / Product Gate P)
- Expand Windows support
- Re-open theoretical issues outside the five confirmed IDs

## Acceptance for workflow completion
| ID | Required end state |
|----|--------------------|
| sec-broker-token-query | fixed + test green |
| sec-broker-tcp-surface | fixed on Linux default; Darwin residual documented |
| sec-ledger-hmac-key-floor | fixed + test green |
| sec-socket-chmod-race | fixed helper on all 4 call sites + mode/owner assert |
| sec-owner-only-no-uid | fixed uid+ancestor + tests |

