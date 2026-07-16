---
id: modes
title: Modes and Policy Axes
sidebar_position: 2
description: Execution, authentication, containment, and approval are independent choices with different defaults and risks.
---

# Modes and policy axes

A Headless run is described by four independent axes. “Native mode,” “write mode,” and “unsafe mode” are not synonyms: each changes a different boundary. Persisted sessions bind all four choices at creation so a later turn cannot quietly widen them.

## Reference table

### Execution

| Value | Meaning | Default | CLI setting | Security implication |
| --- | --- | --- | --- | --- |
| `read-only` | Worker can inspect the project and write only isolated runtime storage | **Yes** | `--mode read-only` or omit | No candidate worktree; project mutations are denied by the outer sandbox |
| `write` | Worker receives a leased writable worktree and may produce a candidate | No | `--mode write` | Never writes primary directly; still requires candidate scanning, gates, finality, and authorized integration |

### Authentication

| Value | Meaning | Default | CLI setting | Security implication |
| --- | --- | --- | --- | --- |
| `broker` | Daemon holds the provider API credential; worker receives a finite opaque lease | **CLI/daemon default** | `--auth-mode broker` or omit | Tight provider route/model/request/token/cost enforcement and broker-only worker networking |
| `native-login` | Worker receives only the selected CLI's bounded native credential capsule | MCP tool default | `--auth-mode native-login` | Requires project trust and unrestricted-provider-egress acknowledgement; provider IP destinations are not allowlisted |

The default split is intentional. Public CLI and daemon run contracts default to `broker`, keeping provider keys out of workers. Direct MCP tool schemas default to `native-login`, matching an attached provider CLI's subscription workflow. Goals may inherit auth from their selected fleet profile. Always inspect the durable request or fleet agent rather than assuming one surface's default applies everywhere.

### Containment

| Value | Meaning | Default | CLI setting | Security implication |
| --- | --- | --- | --- | --- |
| `required` | A live-probed Seatbelt or bubblewrap/seccomp boundary must wrap the worker | **Yes** | `--require-sandbox` or omit | Missing capability refuses launch; result carries enforced mechanism and network evidence |
| `unsafe` | Explicitly skip Headless's outer OS sandbox | No | `--unsafe-no-sandbox` | Host-user access is exposed; result/ledger/receipt are visibly marked; prohibited for autonomy, councils, and workflows |

### Approval

| Value | Meaning | Default | CLI setting | Security implication |
| --- | --- | --- | --- | --- |
| `ask` | Mutating coder turns and integration decisions pause for attributable approval where required | **Yes** | `--approval-policy ask` or omit | Human decisions remain separate, durable checkpoints |
| `auto` | Eligible work proceeds automatically through ordinary policy and finality gates | No | `--approval-policy auto` | Removes the per-turn human pause; does not bypass containment, budgets, tests, or merge authority |
| `bypass` | Use the backend's noninteractive approval-bypass mechanism | No | `--approval-policy bypass` | Requires explicit project `--allow-bypass`; remains inside outer containment and never grants merge authority by itself |

`bypass` approval is not `unsafe` containment. On a required run, the backend may stop asking about its own tools while the OS sandbox still denies everything outside Headless's grant.

## Common combinations

### Tight broker inspection

```bash
headless exec \
  --backend opencode \
  --mode read-only \
  --auth-mode broker \
  --approval-policy ask \
  --require-sandbox \
  -- "Map the public API."
```

Expected: required read-only containment, no provider key in the worker, and finite broker enforcement. Every flag shown is the default except the backend; spelling them out is useful in audited scripts.

### Subscription-backed inspection

```bash
headless project trust grant --allow-native-direct-unrestricted
headless exec \
  --backend codex \
  --auth-mode native-login \
  --mode read-only \
  -- "Review the parser."
```

Expected: the Codex capsule is installed into an isolated worker, required filesystem/process containment stays active, and the result reports `network: "native-direct-unrestricted"`.

### Gated candidate write

```bash
headless exec \
  --backend opencode \
  --mode write \
  --auth-mode broker \
  --approval-policy ask \
  -- "Add a focused regression test."
```

Expected: changes land only in a leased worktree and become a preserved candidate. Primary moves only through a later authorized candidate-integration decision.

:::warning Avoid “make everything permissive” bundles
Combining native-login, write, bypass approval, and unsafe containment removes several independent checkpoints at once. Headless requires separate flags and trust decisions so the risk cannot be hidden behind one vague “agent mode.” Unsafe containment remains unavailable to autonomous orchestration even when other permissions exist.
:::

## Fleet health reports the selected mode

Fleet health uses each agent's actual `authMode`. A broker agent without its daemon-held key reports the missing credential environment variable and suggests seeding broker keys or choosing native-login. A native-login agent reports the capsule's concrete reason, such as a missing regular-file login, an unsafe OpenCode model configuration, or Claude's setup-token remedy. A missing trust grant is reported separately as `trust_required`.

Health, admission, and broker egress read the same daemon environment source, so an embedded daemon cannot report one credential source and execute with another. See [Understand “login required”](../troubleshooting/login-required.md) for repair steps.

## Command surface

The [generated command reference](https://github.com/proofofwork-agency/headless/blob/main/docs/command-reference.md) is the authoritative list of flags. Not every experimental object exposes every axis: portable skills force required/read-only/ask, workflows and councils force required containment, and persistent sessions are read-only with their other axes fixed at creation.

## Related

- [Containment](./containment.md) — exact OS boundaries and the unsafe marker.
- [The safety model](./safety-model.md) — how modes interact with budgets, credentials, and gated writes.
- [Persistent sessions](./sessions.md) — values are bound once for the multi-turn lifecycle.
