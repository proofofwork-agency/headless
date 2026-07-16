# Headless docs

Docusaurus v3 site for the Headless documentation:
https://proofofwork-agency.github.io/headless/

- Develop: `cd website && bun install && bun run start` — live-reload dev server at http://localhost:3000
- Build: `cd website && bun run build` — static output in `website/build/` (preview it with `bun run serve`)
- Deploy: a merge to `main` builds with frozen dependencies and publishes `website/build/` through the least-privilege GitHub Pages workflow.
