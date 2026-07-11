# Headless documentation site

A [Docusaurus 3](https://docusaurus.io/) site for Headless v0.2. It is
self-contained — it has its own `package.json` and does **not** affect the
published `@proofofwork-agency/headless` npm package.

## Run it

```bash
cd website
npm install
npm start          # dev server with hot reload at http://localhost:3000/headless/
```

## Build

```bash
npm run build      # static output in website/build
npm run serve      # preview the production build
npm run typecheck  # type-check docusaurus.config.ts / sidebars.ts
```

## Structure

- `docs/` — the documentation pages (Markdown). Order and grouping are defined
  in `sidebars.ts`.
- `docusaurus.config.ts` — site config (title, navbar, footer, theme).
- `src/css/custom.css` — theme colors, matched to the control-room TUI palette.

To add a page, create `docs/<name>.md` and add `"<name>"` to `sidebars.ts`.
