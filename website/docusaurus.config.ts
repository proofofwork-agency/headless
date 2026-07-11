import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

// Docs-only Docusaurus site for Headless v0.2. `npm install && npm start` in
// this directory to run it locally; `npm run build` produces static output in
// ./build. The site is self-contained (its own package.json) so it does not
// affect the published Headless npm package.
const config: Config = {
  title: "Headless",
  tagline: "A local, project-scoped control plane for AI coding CLIs and collaborative fleets",
  url: "https://proofofwork-agency.github.io",
  baseUrl: "/headless/",
  organizationName: "proofofwork-agency",
  projectName: "headless",
  onBrokenLinks: "warn",
  i18n: { defaultLocale: "en", locales: ["en"] },
  presets: [
    [
      "classic",
      {
        docs: {
          routeBasePath: "/",
          sidebarPath: "./sidebars.ts",
          editUrl: "https://github.com/proofofwork-agency/headless/tree/main/website/",
        },
        blog: false,
        theme: { customCss: "./src/css/custom.css" },
      } satisfies Preset.Options,
    ],
  ],
  themeConfig: {
    colorMode: { defaultMode: "dark", respectPrefersColorScheme: true },
    navbar: {
      title: "Headless",
      items: [
        { type: "docSidebar", sidebarId: "docs", position: "left", label: "Docs" },
        { to: "/control-room", label: "Control room", position: "left" },
        { to: "/cli-reference", label: "CLI", position: "left" },
        { href: "https://github.com/proofofwork-agency/headless", label: "GitHub", position: "right" },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Docs",
          items: [
            { label: "Introduction", to: "/" },
            { label: "Control room (TUI)", to: "/control-room" },
            { label: "CLI reference", to: "/cli-reference" },
            { label: "Architecture", to: "/architecture" },
          ],
        },
        {
          title: "Project",
          items: [
            { label: "GitHub", href: "https://github.com/proofofwork-agency/headless" },
            { label: "SECURITY.md", href: "https://github.com/proofofwork-agency/headless/blob/main/SECURITY.md" },
          ],
        },
      ],
      copyright: "Headless v0.2 — required containment is the default.",
    },
    prism: {
      additionalLanguages: ["bash", "json"],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
