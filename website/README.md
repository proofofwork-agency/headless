# Headless documentation site

This directory contains the Docusaurus v3 site for Headless. It is independent
from the private-alpha package build and publishes only static documentation.

## Build

```bash
cd website
bun install --frozen-lockfile
bun run typecheck
bun run build
```

Use `bun run start` for a local development server. Authored pages live under
`docs/`; generated output in `build/` and `.docusaurus/` is ignored.
