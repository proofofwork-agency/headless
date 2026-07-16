---
id: skills
title: Portable Skills
sidebar_position: 6
description: Import, inspect, approve, invoke, and audit immutable text-only instruction bundles.
---

# Portable skills

Portable skills are experimental, project-scoped instruction bundles. They let an operator review and approve one immutable set of text instructions, then invoke that exact content on a selected backend without enabling the provider's native skills, hooks, plugins, MCP configuration, or package installation.

They are intentionally narrower than a plugin system: no executable files, archives, URLs, dependency install, provider-native control files, or implicit network authority.

## Bundle format

A v1 bundle is an absolute local directory containing:

```text
review-skill/
├── manifest.json
├── instructions.md
└── references/
    └── checklist.md
```

```json title="manifest.json"
{
  "schemaVersion": 1,
  "id": "review-public-api",
  "version": "1.0.0",
  "name": "Review public API",
  "license": "MIT",
  "instructions": "instructions.md",
  "references": ["references/checklist.md"],
  "tools": [],
  "requirements": {
    "read": true,
    "write": false,
    "network": false,
    "delegation": false
  },
  "roles": ["reviewer"],
  "providers": ["codex", "opencode"],
  "verification": ["Cite every inspected entry point"]
}
```

The bundle is limited to 64 files, 256,000 bytes per file, and 1,000,000 bytes total. Only `manifest.json`, `instructions.md`, and declared `references/*.md|txt` files are accepted. Every file must be non-executable, regular, single-link, non-symlinked text. Undeclared and binary files fail import.

Manifest tools and requirements are declarative metadata for review; they do not grant runtime permissions. Invocation still forces the fixed Headless boundary described below.

## Import, inspect, and enable

```bash
headless experimental skill import --source /absolute/path/to/review-skill --cwd "$PROJECT"
```

Expected: Headless validates the complete bundle, hashes path/length/content in deterministic order, copies it into owner-only project state, and records `review-public-api@1.0.0` as `quarantined`.

```bash
headless experimental skill inspect review-public-api@1.0.0 --cwd "$PROJECT"
headless experimental skill enable review-public-api@1.0.0 --cwd "$PROJECT"
headless experimental skill list --cwd "$PROJECT"
```

Expected: `inspect` returns the manifest, immutable content hash, and composed text; `enable` re-hashes the stored bundle before approval; `list` shows the enabled record and approver metadata.

An existing `id@version` may be re-imported only when its content hash is identical. Different content under the same version is denied—increment the version instead. Revocation is permanent for that immutable record:

```bash
headless experimental skill revoke review-public-api@1.0.0 --cwd "$PROJECT"
```

Expected: state becomes `revoked`; it cannot be invoked or re-enabled.

## Invoke under a fixed boundary

```bash
headless experimental skill use review-public-api@1.0.0 \
  --backend codex \
  --timeout-ms 300000 \
  --cwd "$PROJECT" \
  -- "Focus on exported TypeScript symbols."
```

Expected: Headless concatenates the immutable instructions/references with bounded redacted arguments and starts a new session for the explicit backend. The invocation is always:

- read-only;
- required OS containment;
- `ask` approval policy;
- a new project-owned session and durable job;
- native provider skills, hooks, plugins, MCP configuration, and package installation disabled.

The current skill CLI does not expose an auth-mode flag. The created session follows the daemon's broker default, so configure the corresponding daemon-held provider credential. A missing backend or non-enabled skill fails closed before a run is admitted.

## Durable audit trail and recovery

Each invocation records the project, skill ID and version, immutable content hash, bounded arguments, authenticated authority, receiving backend, timestamp, durable `jobId`, status, and bounded result evidence. Status moves from `admitted` to `running` and then to the real terminal job state (`succeeded`, `failed`, `timed_out`, `cancelled`, or `blocked`). The daemon also emits attributable `portable_skill_invoked` and `portable_skill_completed` ledger notes.

Completion is driven by the same durable terminal bridge as sessions. If the daemon restarts while an invocation is running, startup reconciles the stored audit `jobId` against the recovered job and records the true terminal state. A lost short-lived waiter cannot turn a successful long run into a durable false failure.

Pre-upgrade audit entries without a trustworthy job relationship remain `admitted` with `jobId: null`; Headless does not invent a completion mapping for historical state.

:::warning Skills are instructions, not trusted code
Enablement proves that the reviewed bytes match the imported bytes. It does not prove that the instructions are correct, that a provider will follow them, or that their output is safe. Keep using ordinary review, budgets, receipts, and project gates.
:::

See the generated [command reference](https://github.com/proofofwork-agency/headless/blob/main/docs/command-reference.md) for the exact experimental command grammar.

## Related

- [Persistent sessions](./sessions.md) — the durable read-only turn used by invocation.
- [Containment](./containment.md) — the required worker boundary skills cannot relax.
- [Execution receipts](./receipts.md) — receipt evidence for the invocation job.
