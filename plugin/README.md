# Headless OpenCode plugin

> **Unreleased private alpha.** This plugin is not published and is outside the first read-only beta stability promise.

The plugin is a thin client of the project-scoped Headless daemon. Admission, authentication, containment, policy, budgets, terminal results, events, and ledger state remain daemon-owned.

For local development, build both packages from the repository root:

```bash
bun run build
```

Then point a disposable OpenCode development configuration at the local compiled plugin. Do not use this alpha with sensitive source or valuable credentials.

The plugin and MCP server derive their advertised names, schemas, and defaults from one shared registry. Direct run, deliberation, and council tools default to native-login plus `ask`, while `headless_deliberate` defaults to OpenCode and Codex. The `headless_goal` compatibility tool accepts `mode: "read-only" | "write"`; omission is read-only, and goal authentication and approval values inherit the selected profile when omitted. The automatically provisioned integration credential is non-admin and cannot grant trust, transfer leadership, resolve approvals, or integrate candidates.

The plugin package stays private until the core execution release gates pass and an authorized beta is published. See the repository README and SECURITY.md for current limits.
