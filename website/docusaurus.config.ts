import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

let packageVersion = '0.2.0-beta.1';
try {
  packageVersion = JSON.parse(
    readFileSync(resolve(process.cwd(), '../package.json'), 'utf8'),
  ).version;
} catch {
  // Keep the literal fallback so a missing parent manifest cannot break docs.
}

const config = {
  title: 'Headless',
  tagline: 'One visible lead. Every CLI coder becomes a contained, auditable fleet.',
  url: 'https://proofofwork-agency.github.io',
  baseUrl: '/headless/',
  organizationName: 'proofofwork-agency',
  projectName: 'headless',
  onBrokenLinks: 'throw',
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
  },
  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },
  presets: [
    [
      'classic',
      {
        docs: {
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
          editUrl:
            'https://github.com/proofofwork-agency/headless/tree/main/website/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],
  themeConfig: {
    navbar: {
      title: 'Headless',
      items: [
        {
          to: '/getting-started/init-a-lead',
          label: 'Get started',
          position: 'left',
        },
        {
          to: '/orchestration/lead-servants',
          label: 'Orchestration',
          position: 'left',
        },
        {
          to: '/case-studies/proven-runs',
          label: 'Proof',
          position: 'left',
        },
        {
          href: 'https://github.com/proofofwork-agency/headless/releases',
          label: `v${packageVersion}`,
          position: 'right',
        },
        {
          href: 'https://github.com/proofofwork-agency/headless',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Project',
          items: [
            {
              label: 'GitHub',
              href: 'https://github.com/proofofwork-agency/headless',
            },
            {
              label: 'Security model',
              to: '/security/containment-ledger-broker',
            },
            {
              label: 'CLI reference',
              to: '/reference/cli',
            },
            {
              label: 'MIT License',
              href: 'https://github.com/proofofwork-agency/headless/blob/main/LICENSE',
            },
          ],
        },
      ],
      copyright: '© 2026 proofofwork.agency · Released under the MIT License.',
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
} satisfies Config;

export default config;
