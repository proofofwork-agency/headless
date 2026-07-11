import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

// One curated sidebar. Ids match the markdown filenames in ./docs.
const sidebars: SidebarsConfig = {
  docs: [
    "intro",
    "control-room",
    "cli-reference",
    "backends-and-auth",
    "containment",
    "architecture",
  ],
};

export default sidebars;
