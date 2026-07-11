# Backend connectivity findings — 2026-07-11

Why the control-room TUI "couldn't connect with the CLI AI coders", what was
fixed, and the one remaining decision (a containment-posture choice) required for
a coder to fully complete a turn under required containment.

## Symptom

Starting a goal in the TUI produced an endless-looking retry loop:

```
stdout  Backend grok-build cannot start a required native session because it does
        not disable: project configuration, startup hooks, project MCP servers,
        project skills.
completion  blocked: Backend grok-build cannot start a required native session …
```

112+ events, no coder ever responded.

## Root causes and fixes (shipped)

### 1. The coordinator kept selecting a structurally-unrunnable backend

`agentAvailability` (`src/daemon/server.ts`) judged an agent's health from
**binary-on-PATH + authenticated + rate-limit only** — it never consulted
`requiredContainmentSecurityGaps`. grok-build is fail-closed under required
containment (it can't disable project config/hooks/MCP/skills), yet it reported
`healthy` and was picked as leader/delegate every time, then hard-failed at the
containment gate. Goals are always required-contained (unsafe is rejected), so a
backend with gaps can never run in one.

**Fix:** mark a backend `offline` when `requiredContainmentSecurityGaps` is
non-empty. Selection already excludes offline/unhealthy agents, so the
coordinator now routes to a runnable backend (opencode/codex) and grok shows as
unavailable instead of green. Verified: a goal now picks `leader: opencode` and
produces **0** grok-loop events (was 100+).

### 2. Codex was completely broken by a stale config override

`codexProjectPolicyArguments` emitted `-c projects."<path>".trust_level="untrusted"`.
Codex ≥ 0.144 **removed** that config field, and headless also passes
`--strict-config`, which makes an unknown field fatal — so every codex run
aborted before starting. The untrusted posture is already enforced by
`--sandbox`, `--ignore-user-config`, `--ignore-rules`, and `--ephemeral`.

**Fix:** stop emitting the deprecated field. Codex's probe now passes and codex
runs under Seatbelt (`containment.enforced: true`). Verified: `codex exec … "Reply
READY"` returns `READY` (codex is authenticated, not out of credits).

### 3. Probe failures were undiagnosable

A failed capability probe reported only `Version probe exited 1`, discarding the
backend's own stderr — which is exactly what hid these issues.

**Fix:** `probeBackendAdapter` now appends a bounded, redacted slice of the
probe's stdout/stderr to the failure reason (e.g. the backend printing why it
could not start).

All four changes: `bun run check` clean, **512 tests pass**.

## The remaining decision: coders vs. required containment

With the above fixes the coordinator selects a runnable backend, but a coder
still cannot **complete a turn** under headless's strict required-containment
profile, because each coder needs filesystem access the profile denies by design.
This was confirmed empirically per backend:

| Backend | What it needs that required containment denies |
| --- | --- |
| **opencode** | **Real-home READ.** opencode (a self-contained Bun/Mach-O binary) reads several real-home paths at startup via `getpwuid` — not redirectable by `HOME`/`XDG_*`. With the home readable (writes still denied, secrets deny-listed) it runs (`--version` → `0`, `~/.ssh` read denied). |
| **codex** | **Broad temp WRITE.** codex's arg0 / "PATH aliases" sandbox machinery writes to the system temp and cleans up stale arg0 dirs; the read-only profile allows writes only to the worker. Fails even with `--dangerously-bypass-approvals-and-sandbox` (the machinery runs regardless): *"could not create PATH aliases: Operation not permitted"*. The outer jail correctly blocks a probe write to the project dir. |
| **claude-code** | **Regular-file credentials.** Login is keychain-only here; required containment can't export the keychain, so `NATIVE_AUTH_UNAVAILABLE`. |
| **grok-build** | **Policy.** Fail-closed until late-created project controls can be denied on both platforms. |

This is an architectural tension between headless's "the worker never inherits
the real home / writes only to the worker" model and how these coder CLIs
actually bootstrap. It cannot be resolved without **relaxing containment for the
selected coder**, which is a security-posture decision (`CLAUDE.md`:
"Containment … non-negotiable"), not something to change silently.

### Validated options (pick per deployment)

1. **opencode, read-mostly home** *(recommended, least-bad)* — in the native-login
   read-only profile, add `(allow file-read* (subpath <HOME>))` **plus** extend
   the existing secret denials to reads (`~/.ssh`, `~/.aws`, `~/.gnupg`,
   `~/.config/gh`, `~/.git-credentials`, `~/.netrc`, keychains, `~/.claude`,
   `~/.codex`, `~/.config/gcloud`, browser profiles). Keeps write-deny. Validated:
   opencode runs; secret reads denied. Best gated behind an explicit opt-in so the
   default stays strict.
2. **codex, scoped temp write** — allow codex's arg0/alias temp writes to a
   scoped temp root and pre-clean stale dirs. Less sensitive than home-read but
   needs more work to get fully green (a fatal write remained after the alias
   step).
3. **Broker mode** for a provider with an API key — sidesteps native-login home
   access entirely (no home enters the worker).

### Also worth investigating (possible real bug)

The read-only **run** profile emits `(deny network*)` while the result reports
`containment.network: "provider-direct"`. If a native-login run is meant to reach
the provider directly, the profile and the reported value disagree — a coder
would be denied its API socket even after the auth capsule is built. Worth
reconciling in `src/runner/simple.ts` (`writeDarwinReadOnlySandboxProfile`,
`sandboxNetwork`).

## Test status

- CLI surface: every command re-verified functional (trust, daemon, status,
  events, fleet, goal, session, approval, candidate, autonomy, workflow, mcp,
  init).
- Selection: grok now `offline`; goal routes to opencode; **0** grok-loop events.
- Codex: probe passes; `codex exec` returns `READY` (unsandboxed / permissive
  outer). Under the strict read-only run profile it hits the temp-write wall above.
- TUI: controller driven against the live daemon — all commands route; fleet shows
  grok as unavailable.
- `bun run check` + 512 tests green.
