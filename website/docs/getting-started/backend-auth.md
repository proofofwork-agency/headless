---
title: Backend authentication
sidebar_position: 2
description: Prepare Codex, OpenCode, Claude Code, and Grok Build subscription credentials for isolated native-login workers.
---

# Backend authentication

Native login never means “mount the real home.” Headless imports one bounded,
backend-specific credential capsule into an isolated worker and fingerprints
the selected state for durable session recovery.

## Codex

Log in with the official Codex CLI. Headless accepts only the fixed canonical
source `~/.codex/auth.json`, copies it owner-only to the worker, and withholds
project plugins, hooks, apps, browsers, hidden subagents, MCP skill dependencies,
and repository skill roots. The contained process receives read-only system CA
bundle paths so TLS works from the isolated home without widening Seatbelt.

## OpenCode

Log in with OpenCode. Headless reads the fixed auth source under
`~/.local/share/opencode/` and may extract only the safe scalar default model
from `~/.config/opencode/opencode.json` or `opencode.jsonc`. Project config,
plugins, commands, skills, MCP servers, and alternate host-controlled config
paths are not imported.

You may instead pass an explicit public model in the run request.

## Claude Code setup-token

macOS Claude Code commonly stores its live login in Keychain, which the required
Seatbelt worker cannot import. Create Claude's reviewed long-lived subscription
token and put it at Headless's exact allowlisted location:

```bash
umask 077
mkdir -p "$HOME/.claude"
claude setup-token > "$HOME/.claude/.headless-setup-token"
chmod 600 "$HOME/.claude/.headless-setup-token"
```

The trimmed file must be at most 4 KiB and match the `sk-ant-oat…` setup-token
format. It must be a canonical, owner-owned, single-link regular file. A present
but malformed token fails with `NATIVE_AUTH_UNAVAILABLE`; Headless does not
silently fall back to a stale `.credentials.json`.

When valid, the token takes exclusive precedence. It is hashed into the auth
fingerprint and injected as `CLAUDE_CODE_OAUTH_TOKEN` only after environment
scrubbing, only for the contained Claude native-login process. It is never
copied into the worker filesystem, daemon environment, logs, ledger, or result.

The host operator must mint this file before Claude can pass a live contained
subscription run. Headless never runs `claude setup-token` or stores the token
on the operator's behalf.

## Grok Build trust-canary

Authenticate the official CLI interactively:

```bash
grok login --device-code
```

Grok remains experimental. Its installed CLI can treat a project with no gated
control files as vacuously trusted, so Headless does not accept that observation
as proof. It creates a worker-owned canary project containing one inert MCP
control file, runs a contained network-denied `grok inspect --json`, and requires
the canary to prove that the trust gate is active while all project, compatibility,
plugin, hook, skill, MCP, and LSP surfaces remain disabled.

A missing or contradictory attestation fails before provider access. Grok write
mode remains blocked until its advertised write gate is complete.

## Capsule limits

Ordinary auth files are capped at 2 MiB each and 4 MiB total. Symlinks,
hardlinks, non-regular files, unsafe ownership, custom source paths, and changed
fingerprints fail closed. Sibling credentials, ambient API/OAuth tokens, Git and
SSH material, shell startup files, and host sockets never enter the worker.

The repository's canonical, more detailed contract is
[`docs/native-login.md`](https://github.com/proofofwork-agency/headless/blob/main/docs/native-login.md).
