---
title: Understand “login required”
sidebar_position: 1
description: Read the mode-specific fleet-health reason and repair broker credentials, native login state, or project trust.
---

# Understand “login required”

Fleet health keeps the structured code `login_required`, but its human reason
now describes the selected authentication mode truthfully. Read that reason
before changing credentials:

| Selected agent mode | Example reason | Correct direction |
| --- | --- | --- |
| `broker` | `No broker credential — OPENAI_API_KEY is unset...` | Put that provider key in the daemon environment and restart, or intentionally switch the agent to native-login |
| `native-login` | `No native authentication state was found for codex` | Run the provider's host login flow, then refresh health |
| `native-login` (Claude Keychain only) | Keychain state is unavailable under required containment | Mint the owner-only Headless setup-token capsule |
| `native-login` without consent | Structured code `trust_required` | Grant the explicit native-login project acknowledgement; this is not a login failure |

Do not add an API key merely because an official CLI is logged in: a broker
agent intentionally ignores subscription state. Conversely, do not switch a
broker profile to native-login merely to hide a missing daemon credential; the
two modes have different network and budget boundaries.

## 1. Grant the explicit native-login trust

```bash
PROJECT="/absolute/path/to/your/project"
headless project trust grant \
  --allow-native-direct-unrestricted \
  --cwd "$PROJECT"
```

## 2. Create a native-login fleet profile

The inline constructor applies the selected mode to the profile and every
generated agent:

```bash
headless experimental fleet profile create \
  --profile-id native-subscriptions \
  --agent codex \
  --agent opencode \
  --agent claude \
  --agent grok \
  --auth-mode native-login \
  --approval-policy ask \
  --activate \
  --cwd "$PROJECT"
```

For hand-authored JSON, the nested agents still matter: keep their `authMode`
aligned with the top-level mode. A later top-level-only file edit does not
repair an agent explicitly left in broker mode.

## 3. Verify the actual readiness evidence

```bash
headless project trust status --cwd "$PROJECT"
headless experimental fleet health \
  --profile-id native-subscriptions \
  --cwd "$PROJECT"
headless doctor --cwd "$PROJECT"
```

If Claude alone remains unavailable, install its
[setup-token capsule](../ai-coders/claude.md#macos-mint-the-setup-token-keychain-limitation).
If Grok remains blocked, its contained trust-canary inspection did not prove
the required isolation; do not bypass that attestation.

For broker mode, add the named credential to the environment of the process
that starts the daemon—not only to a later client shell—then restart it:

```bash
headless daemon stop --cwd "$PROJECT"
# Export the exact credential named by Fleet health before restarting.
export OPENAI_API_KEY="<provider-key>"
headless daemon status --cwd "$PROJECT"
headless experimental fleet health --cwd "$PROJECT"
```

Expected: health, admission, and broker egress all use that same daemon
environment. The TUI and fleet-health RPC never return the credential value;
they expose only the environment-variable name and a bounded remedy.

See [Modes and policy axes](../concepts/modes.md) for the broker/native tradeoff.
