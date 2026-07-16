---
id: installation
title: Installation
sidebar_position: 1
---

# Installation

Headless is an unpublished private beta (`0.2.0-beta.3`). The packages are private and not on npm, so you build from source.

## Requirements

- **macOS or Linux.** Windows is unsupported: Headless returns `UNSUPPORTED_PLATFORM` before any backend launch.
- **Bun** (`>= 1.1.0`) as the runtime; the repository pins `bun@1.3.14` as its package manager.
- **Git.** Projects are Git repositories, and write mode requires a clean worktree.
- **Containment tooling.** On macOS, Headless uses probed, default-deny Seatbelt profiles built into the OS. On Linux, it requires bubblewrap and a working seccomp filter — both are probed before running, and a missing capability returns `CONTAINMENT_UNAVAILABLE` rather than falling back to a weaker sandbox.

## Build from source

```bash
git clone https://github.com/proofofwork-agency/headless
cd headless
bun install --frozen-lockfile --ignore-scripts
bun run build
```

The build produces `dist/cli.js` and the `headless`, `hless`, and `headless-mcp` binaries. Either link them onto your `PATH`:

```bash
bun link
headless --version
```

or invoke the checkout directly — the repository's own docs use both forms:

```bash
./dist/cli.js --version        # the compiled CLI
bun src/cli.ts doctor          # straight from source, during development
```

The rest of this documentation assumes `headless` is on `PATH`; substitute `./dist/cli.js` if you have not linked it.

## Verify with doctor

```bash
headless doctor
```

`doctor` shows the runtime, backend inventory, daemon state, and containment defaults. Run it before anything else: it tells you whether required containment is available on this machine and which coder CLIs Headless can see.

## Install and sign in the coder CLIs

Headless drives four official AI coder CLIs. Each one must be installed and logged in on the host before its native-login path can work — Headless never performs a provider login for you; it only imports each CLI's own bounded credential capsule into the contained worker.

| Coder CLI | Binary | Sign in |
| --- | --- | --- |
| [Claude Code](../ai-coders/claude.md) | `claude` | `claude auth login`; on macOS Keychain-backed subscriptions, mint the setup-token described in the [quickstart](./quickstart.md) |
| [Codex](../ai-coders/codex.md) | `codex` | `codex login` |
| [OpenCode](../ai-coders/opencode.md) | `opencode` | `opencode auth login` |
| [Grok Build](../ai-coders/grok.md) | `grok` | `grok login`, or `grok login --device-auth` on a display-less host |

You do not need all four — one signed-in CLI is enough to start. The per-coder guides linked above cover each backend's credential source and current status; Grok Build in particular remains experimental and read-only under required containment.

:::note
Native login additionally requires per-project consent (`headless project trust grant --allow-native-direct-unrestricted`), because native provider egress is unrestricted. The [quickstart](./quickstart.md) walks through it; [the safety model](../concepts/safety-model.md) explains why.
:::

## Next step

Continue to the [quickstart](./quickstart.md): initialize a project, run your first contained job, and verify its execution receipt.
