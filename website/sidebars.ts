import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docs: [
    'intro',
    {
      type: 'category',
      label: 'Getting started',
      items: ['getting-started/installation', 'getting-started/quickstart'],
    },
    {
      type: 'category',
      label: 'Core concepts',
      items: [
        'concepts/safety-model',
        'concepts/receipts',
        'concepts/leads-and-fleet',
      ],
    },
    {
      type: 'category',
      label: 'AI coders',
      items: [
        'ai-coders/claude',
        'ai-coders/codex',
        'ai-coders/opencode',
        'ai-coders/grok',
      ],
    },
    {
      type: 'category',
      label: 'Guides',
      items: ['guides/cli', 'guides/tui', 'guides/test-scenarios'],
    },
    {
      type: 'category',
      label: 'Operations',
      items: [
        'troubleshooting/login-required',
        'release-gates/evidence',
        'case-studies/proven-runs',
      ],
    },
  ],
};

export default sidebars;
