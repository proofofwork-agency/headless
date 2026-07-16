---
id: containment
title: Operating-System Containment
sidebar_position: 3
description: The exact macOS Seatbelt and Linux bubblewrap/seccomp boundaries, probes, relays, and explicit unsafe bypass.
---

# Operating-system containment

Headless treats every backend as arbitrary code. Backend tool allowlists are useful defence in depth, but the security boundary is the outer operating-system sandbox built by Headless. Required containment is the default; when the platform cannot prove the required controls, the run returns `CONTAINMENT_UNAVAILABLE` instead of launching in a weaker mode.

## Required and unsafe

| Requirement | CLI | Result |
| --- | --- | --- |
| Required (default) | no flag, or `--require-sandbox` | Launch only after the platform probe and complete outer sandbox can be applied |
| Unsafe | `--unsafe-no-sandbox` | Skip the outer OS sandbox, mark the result and receipt `unsafe: true`, and print a warning |

`--unsafe-no-sandbox` is the **only** local containment bypass. Passing it together with `--require-sandbox` is a usage error. Autonomous goal execution, councils, and workflows do not accept unsafe containment; persistent portable-skill invocations always use required containment.

Approval `bypass` is a different axis. It changes the backend's tool-approval behavior *inside* the worker and requires explicit project consent, but it does not disable Headless's outer sandbox, budgets, worktree isolation, or integration authority. See [Modes](./modes.md).

:::warning
Unsafe mode is an operator escape hatch, not a compatibility fallback. It exposes the host permissions of the invoking user, and the durable `unsafe` evidence cannot be converted into a contained result later.
:::

## macOS: default-deny Seatbelt

Before admitting required work on macOS, `probeDarwinSandboxWriteDenial()` executes `/usr/bin/sandbox-exec` with a control read and a denied write. The probe passes only when the control succeeds, the attempted file is absent, and the denied command exits non-zero.

The generated profile starts with `(deny default)` and then grants the minimum process, file, signal, and network operations required by the run:

- The project is readable. A read-only worker can write only inside its isolated HOME/XDG/cache/runtime/temp roots.
- A write worker can also write its leased worktree. The primary checkout and the linked worktree's `.git` pointer are explicitly write- and link-denied.
- Repository credential files (`.env`, local Git config, and related bounded discoveries) are explicitly read-denied even where a parent directory is readable.
- Network binding is always denied.
- A broker worker may connect only to its selected localhost broker port. The optional run-tool gets one exact daemon Unix socket grant, separate from provider access.
- A native-login worker receives outbound IP access plus the exact macOS DNS resolver socket required by libc. SSH agents, Docker sockets, arbitrary host Unix sockets, and Keychain services remain denied.

Native-login's network evidence is therefore `native-direct-unrestricted`: filesystem and process containment remain active, but provider destination IPs are not allowlisted.

### Why Codex says `danger-full-access` on required macOS runs

Seatbelt profiles do not safely compose. Starting Codex's own native Seatbelt inside Headless's already-contained process can fail or create a misleading boundary. For required macOS runs, Headless passes Codex the inner sandbox value `danger-full-access` while keeping the **outer Headless Seatbelt profile** as the authority. The same shared rule is used for one-shot Codex, exec-resume sessions, and app-server sessions.

That value does not mean the worker has full host access. It means “do not start a second Codex sandbox inside the outer Headless sandbox.” Filesystem, network, worktree, credential, signal, and run-tool access remain constrained by Headless.

## Linux: bubblewrap plus seccomp

`probeLinuxBwrap()` proves more than the presence of `bwrap`. It verifies a real denied write, then launches the architecture-specific containment supervisor and proves that the inherited backend seccomp filter denies `AF_UNIX` socket creation. On x86-64 it also executes an x32-tagged syscall probe and requires that alternate ABI to be rejected before native syscall dispatch.

Required Linux workers receive:

- a read-only bind of the host root and primary checkout;
- isolated PID, IPC, and UTS namespaces;
- a tmpfs-backed isolated home plus exact writable worker directories;
- for write mode, one writable bind for the leased worktree while primary stays read-only;
- a network namespace for broker and network-denied work;
- masked host Unix-socket paths as defence in depth;
- an inherited seccomp filter that denies backend `AF_UNIX` creation, including sockets created after the filesystem snapshot.

Native-login uses provider-direct IP networking, so it does not unshare the network namespace. The seccomp and filesystem boundaries still prevent ambient pathname-socket access.

### Broker and run-tool relays

A Linux backend cannot create a Unix socket, yet the daemon broker and cooperation endpoint are Unix-socket services. Headless's trusted namespace supervisor bridges this intentionally:

```text
contained backend
      │ loopback TCP inside namespace
      ▼
trusted linux-relay supervisor
      │ exact configured Unix socket
      ├── provider broker
      └── run-scoped cooperation endpoint
```

The backend receives only the loopback port and a finite run-tool operation allowlist. `probeLinuxRunToolRelay()` performs a real contained loopback-to-Unix echo round trip; it is a transport-health diagnostic in CI, not permission to weaken an otherwise valid sandbox. The run-tool endpoint remains authenticated, bounded, job/session/principal-scoped, and revoked at terminal state.

## Platform behavior

| Platform | Required mechanism | Admission proof |
| --- | --- | --- |
| macOS | `/usr/bin/sandbox-exec` with a generated Seatbelt profile | `probeDarwinSandboxWriteDenial()` |
| Linux | bubblewrap namespaces/mounts plus inherited backend seccomp | `probeLinuxBwrap()`; run-tool transport separately uses `probeLinuxRunToolRelay()` |
| Windows | Unsupported | Returns `UNSUPPORTED_PLATFORM` before backend launch |

The probes are live capability tests, not version checks. Installing a binary with the right name is insufficient if the host kernel or policy prevents the actual boundary.

## What containment does not protect against

The outer sandbox trusts the OS, Seatbelt or bubblewrap, the Linux supervisor, Bun, Git, the Headless daemon, and the executable actually resolved from `PATH`. It is not a boundary against an attacker who already controls the same host user or can replace those trusted components. Native-login deliberately trusts the selected official CLI with its own bounded credential capsule and outbound provider IP access. Broker mode deliberately trusts the daemon broker with the real provider credential.

Containment also cannot stop the selected provider from seeing the prompt and context sent to it. Redaction protects durable evidence and logs; it does not redact the provider request needed to perform the task.

## Related

- [The safety model](./safety-model.md) — credentials, budgets, writes, ledger integrity, and threat model.
- [Modes](./modes.md) — distinguish containment from execution, authentication, and approval policy.
- [Architecture](./architecture.md) — where the trusted supervisor, broker, and daemon sit in the request path.
