---
title: Fleet says “login required”
sidebar_position: 1
description: Fix the misleading login-required symptom caused by missing project trust or a broker-default fleet profile.
---

# Fleet says “login required”

A subscription CLI can work directly while fleet health still reports
`login_required`. Two policy mistakes can produce that same humanized symptom:

1. the project has not been trusted for native login; or
2. the fleet profile—or one of its agents—still defaults to `broker`, so the
   daemon looks for a provider API key instead of the installed subscription.

Do not add an API key if native subscription login is what you intended.

## 1. Grant the explicit native-login trust

```bash
PROJECT="/absolute/path/to/your/project"
headless project trust grant \
  --allow-native-direct-unrestricted \
  --cwd "$PROJECT"
```

## 2. Create a native-login fleet profile

The nested agents matter; set `authMode` on each one:

```bash
cat > /tmp/headless-native-fleet.json <<'JSON'
{
  "id": "native-subscriptions",
  "name": "Native subscription fleet",
  "authMode": "native-login",
  "approvalPolicy": "ask",
  "agents": [
    {"id": "codex", "backend": "codex", "name": "Codex", "authMode": "native-login"},
    {"id": "opencode", "backend": "opencode", "name": "OpenCode", "authMode": "native-login"},
    {"id": "claude", "backend": "claude-code", "name": "Claude", "authMode": "native-login"},
    {"id": "grok", "backend": "grok-build", "name": "Grok", "authMode": "native-login"}
  ]
}
JSON

headless experimental fleet profile upsert \
  --file /tmp/headless-native-fleet.json \
  --auth-mode native-login \
  --cwd "$PROJECT"
```

The top-level `--auth-mode` is intentional, but it does not repair a nested
agent explicitly configured as broker. Keep both levels aligned.

## 3. Verify the actual readiness evidence

```bash
headless project trust status --cwd "$PROJECT"
headless experimental fleet health \
  --profile-id native-subscriptions \
  --cwd "$PROJECT"
headless doctor --cwd "$PROJECT"
```

If Claude alone remains unavailable, install its
[setup-token capsule](../getting-started/backend-auth.md#claude-code-setup-token).
If Grok remains blocked, its contained trust-canary inspection did not prove
the required isolation; do not bypass that attestation.
