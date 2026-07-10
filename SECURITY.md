# Security model

Headless runs coding-agent CLIs and records what they do. Its two guarantees are **containment** (a read-only run does not modify your project; a write run only ever produces a reviewable diff) and **auditability** (a tamper-evident ledger of every action). This document states the threat model, the enforcement layers, and the **known limits** — the things the current design does *not* guarantee.

## Threat model

The backends (opencode, claude, codex, grok) are **semi-trusted**: normally cooperative, but may be prompt-injected, buggy, or a compromised/malicious build. Containment is defense-in-depth against a backend that tries to exceed read-only, escape a write worktree, exfiltrate secrets, or DoS the runner. It is **not** a defense against a hostile *operator* (someone who controls the parent process's environment, `PATH`, or the ledger key already controls the run).

## Enforcement layers

Read-only runs are contained in up to three independent layers (see the README):

1. **App-level tool denies** (all platforms) — per-backend read-only flags/config.
2. **OS sandbox** (macOS) — a Seatbelt deny-list: the backend runs normally but cannot write the project dir or read/write credential dirs.
3. **Git-worktree isolation** (write mode) — writes happen in a throwaway worktree; only a diff is returned.

The ledger is a hash-chained JSONL log with verified reads, secret redaction on write, and an optional keyed HMAC (`HEADLESS_LEDGER_KEY`) for tamper-proof integrity.

## Hardened in the 2026-07-10 adversarial pass

An adversarial review (Codex + agents) drove these fixes (all with regression tests):

- **opencode read-only bypasses**: a caller `OPENCODE_PERMISSION` env could override the injected denies (now only `OPENCODE_API_KEY` is forwarded); a prompt beginning with a flag could smuggle backend flags (prompt now follows `--`).
- **CLI flag isolation**: flags are parsed only before a `--`; prompt text after it can't mutate `--backend`/`--json`/etc.
- **Ledger integrity**: an all-unchained rewrite bypassed verification (now every event must be chained); dot-only session ids are rejected.
- **Redaction**: now covers every event field (not just `content`) and more secret formats (Google/GitHub-PAT/Slack-app/HTTP-Basic).
- **Tamper-proof option**: `HEADLESS_LEDGER_KEY` switches the chain to keyed HMAC-SHA256.
- **Sandbox robustness**: a transient probe failure no longer latches the sandbox off; the `GOOGLE_` env prefix was narrowed.
- **DoS bounds**: stdout/stderr are read with a 16MB cap; the JSON parser has recursion-depth and total-byte caps.
- **Process teardown**: timeouts recursively kill the whole descendant tree (not just direct children) with KILL escalation.

## Known limits (accepted, by design or deferred)

These were identified and are **not** currently fixed. Treat them as the boundary of the guarantee.

- **Write mode has no OS backstop.** Contained write relies on the backend honoring `cwd = <worktree>`; nothing at the OS level stops a misbehaving write backend from writing an absolute path or `../<primary>`. The captured diff reflects the worktree only. (Only `grok-build` can write today.) *Planned:* sandbox the write run to the worktree.
- **OS sandbox is macOS-only and fail-open.** On Linux/Windows, or if the Seatbelt probe fails, a read-only run falls back to app-level denies with **no OS backstop** and does not refuse to run. *Planned:* a Linux (bubblewrap/landlock) profile; optionally a fail-closed mode.
- **The macOS profile is `(allow default)` minus project + credential-dir writes.** It enforces *"the project is not modified"* and blocks reads/writes of `~/.ssh|.aws|.gnupg|.config/gcloud`. It does **not** block network egress or reads of every other secret store (`~/.config/gh`, `~/.netrc`, `~/.npmrc`, …), nor writes to shell rc files or LaunchAgents outside the project. A read secret can still leave over the network.
- **Subpath write-denies can be defeated by hardlinks** if the backend already has arbitrary code-exec (the exact layer the OS sandbox is meant to backstop) — an inherent limit of path-based Seatbelt denies.
- **Ledger tamper-proofness needs the key held out-of-band.** Without `HEADLESS_LEDGER_KEY`, or if the key lives where the file-writer can read it, the chain is only tamper-*evident*. Even with the HMAC, **tail truncation / rollback** (deleting the last N events) is not detectable without also anchoring the head hash/length externally.
- **The orchestrator writes `.headless/` into the target directory** during read-only runs (the unsandboxed parent, not the child). Gitignore `.headless/` in any repo you run against.
- **Backends are resolved via inherited `PATH`.** A poisoned parent `PATH` yields code execution as the Headless user (operator-environment threat, out of the backend threat model).
- **Ledger append is O(n) per event** (full-file rewrite); long sessions grow quadratically. *Planned:* segmentation/compaction.

## Reporting

This is an internal reference implementation. Report security issues to the maintainers privately rather than opening a public issue.
