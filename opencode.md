# Headless — Full Project Flaw & Issue Audit

> Independent audit of the working tree at `0.2.0-beta.6`.
> Method: kernel checks (typecheck / lint / full test suite), two parallel
> deep-dive explorations (command-injection/spawn surface; race/TOCTOU/resource
> leaks), and targeted review of the security-critical runtime primitives
> (atomic-write, redaction, sandbox, broker relay, MCP/daemon validation).

## TL;DR

The codebase is **mature and well-defended**. The full kernel passes cleanly
(`bun run check` is green: typecheck clean, lint clean on 364 files, **1036 pass
/ 11 skip / 0 fail** across 107 files, 17326 expectations). No critical or
high-severity defect was found. The most actionable issue is a single
**medium** resource-leak / idle-shutdown subversion in the daemon's TCP-style
accept handler, plus several **low** TOCTOU / cleanup-gap items that are
defense-in-depth. Versions are aligned, `dist/` is gitignored (not tracked), and
there are **zero** `TODO`/`FIXME`/`HACK` markers in `src/`.

## Methodology & scope

- **Kernel**: `bun run typecheck`, `bun scripts/source-hygiene.ts lint`,
  `bun test tests`.
- **Surface mapped**: `src/` (~52k LOC / 207 TS/TSX files), with focus on
  `runner/simple.ts`, `daemon/server.ts`, `runtime/{atomic-write,redaction,
  git,worktree,os-sandbox,credential-store,receipt-*,secure-socket,ledger-v2}.ts`,
  `mcp/server.ts`, `broker/`, `backends/`.
- **Issue classes sought**: command injection, path traversal, secret leakage,
  TOCTOU, race conditions, resource/fd leaks, unhandled rejections, timer
  leaks, shutdown gaps, version/build-artifact drift.

## What is genuinely strong (no action needed)

- **No command-injection surface.** Every `spawn`/`spawnSync`/`execFileSync`
  uses argument arrays with no shell. Prompts travel via stdin, never argv.
  Model/agent values pass through `safeOption` (rejects empty, >256B,
  leading-`-`, control chars). No `eval`/`new Function`/`node:vm`/string
  `setTimeout`. Gate-check names resolve through a hardcoded table to fixed
  commands (`release-gate.ts`).
- **Path traversal is consistently blocked.** `realpath` + `isWithin`/`O_NOFOLLOW`
  + owner-only mode checks across worktree, executable read roots, daemon
  extensions, skills, and state paths. Skills additionally reject symlinks,
  executable bits, NUL bytes, and undeclared files.
- **Redaction is robust.** 17+ anchored secret patterns, a hardened generic
  `key=value` scanner that avoids mangling code, a stateful `StreamingRedactor`
  with credential-boundary overlap, and deep recursion into artifacts. Failures
  fail closed (`[SUPPRESSED: REDACTION FAILURE]`).
- **Process/cleanup discipline.** Idempotent `cleanup()` closures, `unref`'d
  timers, abort listeners added/removed in `finally`, atomic tmp→fsync→rename
  with directory fsync, owner-only chmod verified post-write.
- **Concurrency model is sound.** Single-owner socket election + synchronous
  store mutations (no `await` inside critical sections) make intra-process
  async interleaving impossible; the ledger additionally uses a `mkdir`
  cross-process lock.
- **Input validation.** MCP and daemon routes use Zod `.strict()` schemas
  throughout; credential scopes enforced (`observer`/`integration`/`admin`).

## Findings

### MEDIUM

#### M1 — Daemon accept socket has no idle/read timeout (resource leak + idle-shutdown subversion)
`src/daemon/server.ts:402-431` (`accept`)

The per-connection handler caps the *accumulated* buffer at
`MAX_DAEMON_MESSAGE_BYTES` but **never calls `socket.setTimeout(...)`**. A client
that connects and sends nothing — or drip-feeds sub-newline bytes under the cap —
holds the socket in `this.sockets` indefinitely.

Two real consequences:
1. **FD/memory leak & trivial local DoS** — each idle connection is retained.
2. **Subverts the idle-shutdown watchdog.** `isQuiescent()`
   (`server.ts:348-357`) returns `false` whenever `sockets.size > 0`, so a single
   lingering idle connection permanently defeats `DEFAULT_DAEMON_IDLE_TIMEOUT_MS`
   — bootstrapped daemons then leak as residents forever (the exact failure the
   watchdog exists to prevent, `server.ts:306-335`).

This is an inconsistency, not a design choice: `RunToolEndpointManager.accept`
**does** set `socket.setTimeout(runToolCallTimeoutMs(), () => socket.destroy())`
at `src/daemon/run-tool-endpoint.ts:227`. The existing `daemon-lifecycle-leak`
tests exercise idle shutdown only with *no* lingering connections, so this gap is
uncovered.

**Fix**: add `socket.setTimeout(<read-deadline-ms>, () => socket.destroy())` in
`accept` (reset the timer on each `data` chunk). Suggested deadline in the tens
of seconds for one-request-per-connection protocol framing.

### LOW (defense-in-depth)

#### L1 — `atomicWriteFile`: success-path `closeSync` not guarded
`src/runtime/atomic-write.ts:36`

`closeSync(fd)` sits outside the try/catch. The write-failure path (lines 31-35)
correctly cleans up fd + temp file, but if the success-path `closeSync` throws
(rare EBADF/EIO after fsync) the temp file `tmp` is orphaned on disk. Wrap line 36
in a guarded block that unlinks `tmp` on failure.

#### L2 — `atomicAppendFile`: `existsSync`→`openSync` durability race
`src/runtime/atomic-write.ts:69-86`

`created` decides whether the directory entry is fsynced. If the file is deleted
between the check and the open, `created` is stale `false` and the **directory
entry is not persisted** on the file's first event (durability gap only; file
contents are still fsynced). The comment notes ledger callers hold the `mkdir`
lock, but `RunEventStore`/`IntegrationJournal` appenders reuse this helper
without that lock. Low under the single-owner daemon.

#### L3 — `ReceiptJournal.pending()`: `existsSync`→write with no lock
`src/runtime/receipt-journal.ts:69-77`

Check-then-create with no cross-process guard (unlike the ledger's `withOwnedLock`).
Two writers observing "not exists" both write (atomic replace, so no torn read,
but the second clobbers the first's `createdAt`). Touched during
`reconcileReceipts` startup; single-owner daemon mostly mitigates.

#### L4 — `TaskStore.create()`: `existsSync`→write TOCTOU
`src/daemon/task-store.ts:78-80`

Classic check-then-create; only reachable on UUID collision (astronomically
unlikely) and synchronous within one process. Cross-process residual only.

#### L5 — `CredentialStore`: `existsSync`→`readFileSync` + no cross-process lock
`src/runtime/credential-store.ts:100-102,135-137`

A token file removed between `existsSync` and `readFileSync` throws an uncaught
ENOENT in that block. Separately, unlike the ledger, the store has no
`withOwnedLock`, so a CLI mutating `credentials.json` concurrently with a live
daemon races on read-modify-write (last `writeOwnerOnlyJson` wins). Socket
election routes CLI ops through the daemon in practice, keeping this low.

#### L6 — Main daemon `Server` has no persistent `error` listener after bind
`src/daemon/server.ts:242`

`secureUnixListen` attaches only a transient `once("error")` for the bind window.
After `start()` succeeds, `this.server` has no `error` listener, whereas
`RunToolEndpointManager` deliberately adds `server.on("error", …)`
(`run-tool-endpoint.ts:193`). A runtime `error` event on an EventEmitter with no
handler crashes the process. Low probability post-listen, but a latent crash.
Add a persistent `server.on("error", …)` that records a diagnostic.

#### L7 — `stop()` does not await in-flight `LoopService` tasks
`src/daemon/server.ts:378`

`LoopService` is constructed without the `track` option, so its background `run()`
promises never enter `this.executions`; `dispose()` only flips a flag and clears
the gate cache. In-flight loop iterations continue briefly after `stop()` returns
(referencing disposing services) and are not covered by `waitForExecutions`
(`server.ts:366`). Bounded because loops self-terminate on the next `disposed`
check and `isQuiescent()` accounts for `loopService.activeCount`, hence low.

### INFO (deliberately handled, listed for completeness)

- **Dynamic `import()` of operator-supplied extension modules**
  (`daemon-extensions.ts:234`) — the only dynamic import of a non-relative path.
  Gated by `secureCanonicalFile` (realpath, regular-file, owner-only bits,
  owner = daemon/root) + sha256-pinned manifest digest + `assertTrustedAncestorChain`,
  and never reachable from a daemon request. Worth re-review only if the
  operator-trust threat model broadens.
- **`withOwnedLock` uses `Atomics.wait`/`sleepSync`** (`ledger-v2.ts:1062,1398`)
  — blocks the event loop for ≤5ms per spin, ≤10s total. Correctness fine;
  latency-only concern.
- **Non-ledger JSON stores rely entirely on socket election** for cross-process
  safety (synchronous mutations make intra-process races impossible). This is a
  documented design; only the ledger carries the explicit cross-process lock.

## Hygiene & consistency checks

| Check | Result |
|---|---|
| `HEADLESS_VERSION` vs `package.json` | aligned (`0.2.0-beta.6`) |
| `dist/` tracked in git | **no** (gitignored; no stale-artifact risk) |
| `TODO`/`FIXME`/`HACK`/`XXX` in `src/` | **0** |
| Typecheck | clean |
| Lint (source-hygiene, 364 files) | clean |
| Full test suite | 1036 pass / 11 skip / **0 fail** |

## Recommended priority

1. **M1** — daemon accept read-timeout (real leak + watchdog subversion; ~5 LOC).
2. **L6** — persistent `server.on("error", …)` on the main daemon server (~3 LOC,
   prevents a latent process crash).
3. **L1** — guard the success-path `closeSync` in `atomicWriteFile` (temp-file
   leak prevention).
4. **L2–L5** — optional hardening: prefer `O_CREAT|O_EXCL` semantics or an owned
   lock where the existsSync→open pattern决定 durability/identity; treat as a
   single cleanup pass rather than independent fixes.
5. **L7** — pass `track` to `LoopService` (or await `this.active` in `dispose`)
   so `stop()` covers loop iterations.

## Bottom line

No architectural flaws, no injection/traversal/secret-leak vectors, and a green
kernel. The project's load-bearing claims (contained read/write execution,
tamper-evident ledger, credential isolation) are backed by code and tests. The
single medium finding (M1) is a small, localized gap in the daemon connection
handler that should be closed before the next release; the remaining items are
low-severity defense-in-depth.
