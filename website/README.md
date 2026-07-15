# Headless documentation site

This directory contains the headless-branded Docusaurus v3 site. It explains
the native subscription quickstart, backend capsules, containment and write
boundaries, orchestration, release evidence, case studies, CLI reference, and
troubleshooting without changing the private package build.

## Build

```bash
cd website
bun install --frozen-lockfile
bun run typecheck
bun run build
```

Use `bun run start` for a local development server. Authored pages live under
`docs/`; generated output in `build/` and `.docusaurus/` is ignored.

The footer convention is: `© 2026 proofofwork.agency · Released under the MIT
License.` The repository [LICENSE](../LICENSE) remains the canonical license
text.
