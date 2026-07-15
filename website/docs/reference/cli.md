---
title: CLI reference
sidebar_position: 1
description: The generated, registry-checked Headless command reference and stability boundary.
---

# CLI reference

The command table is generated from `src/cli/command-specs.ts` and checked by
`bun run check:docs`. This site deliberately links to that canonical generated
file instead of maintaining a second copy that could drift:

**[Open the generated command reference](https://github.com/proofofwork-agency/headless/blob/main/docs/command-reference.md)**

## Stability boundary

Default help exposes the Beta 1 kernel surface:

- `exec` / `run`
- `lead use|status|release`
- `doctor` / `status`
- `project trust status|grant|revoke`
- `daemon serve|status`
- `init [--lead <host>]`
- `mcp install|remove|status|serve`
- `tui`

Everything under `headless experimental` may change before its own gate. Run:

```bash
headless --help
headless experimental --help
```

Internal audit fixtures remain hidden and are not operator commands.
