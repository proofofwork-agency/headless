# Headless OpenCode plugin

This is the compiled OpenCode plugin for Headless v0.2. It is a daemon client and requires the matching Headless runtime package.

```bash
bun add @proofofwork-agency/headless@0.2.0 \
  @proofofwork-agency/headless-plugin@0.2.0
```

Add the package to OpenCode configuration:

```json
{
  "plugin": ["@proofofwork-agency/headless-plugin"]
}
```

The published entrypoint is `dist/index.js`. Consumers do not need this repository’s TypeScript source. Project admission, authentication, containment, policy, budgets, and ledger state are owned by the project-scoped Headless daemon.

The `headless_goal` tool accepts `mode: "read-only" | "write"` for its `start` action. Omission defaults to `read-only`; write goals retain the daemon's leased-worktree, approval, finality, and integration requirements.

Goal-level `authMode` and `approvalPolicy` are optional and inherit the selected fleet profile when omitted. The automatically provisioned OpenCode integration credential is non-admin: it may inspect control-plane state and operate its own goals, but project trust/profile mutations, leader transfer, approval resolution, and direct candidate integration/rejection remain owner-only CLI/TUI actions.

See the main `@proofofwork-agency/headless` README and SECURITY.md for platform requirements and security limits.
