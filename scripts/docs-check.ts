import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { generatedCommandReference } from "./generate-command-reference";
import { HEADLESS_VERSION } from "../src/version";

const root = resolve(import.meta.dir, "..");
const documents = [
  "README.md",
  "SECURITY.md",
  "CHANGELOG.md",
  "docs/command-reference.md",
  "docs/cli-and-tui-guide.md",
  "docs/mcp-integration.md",
  "docs/native-login.md",
  "docs/plan.md",
  "plugin/README.md",
];
const failures: string[] = [];

for (const relative of documents) {
  const path = join(root, relative);
  const text = readFileSync(path, "utf8");
  for (const forbidden of [
    /bun\s+src\/mcp\/server\.ts/g,
    /dist\/mcp-server\.js/g,
    /bwrap\s*\+\s*landlock/gi,
    /\.headless\/sessions\//g,
    /unreleased\s+private\s+alpha/gi,
    /private\s+alpha/gi,
  ]) {
    if (forbidden.test(text)) failures.push(`${relative} contains stale install/security text matching ${forbidden}.`);
  }

  for (const match of text.matchAll(/\[[^\]]+\]\((?!https?:|#)([^)]+)\)/g)) {
    const target = match[1].split("#", 1)[0];
    if (!target || target.startsWith("mailto:")) continue;
    if (!existsSync(resolve(dirname(path), target))) failures.push(`${relative} links to missing local file ${match[1]}.`);
  }
}

const readme = readFileSync(join(root, "README.md"), "utf8");
if (!readme.includes(HEADLESS_VERSION)) {
  failures.push(`README.md must mention the current version ${HEADLESS_VERSION}.`);
}
if (!/CLI stability boundary[\s\S]*?\bsetup\b/i.test(readme)) {
  failures.push("README.md CLI stability boundary section must list the stable `setup` command.");
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const plugin = JSON.parse(readFileSync(join(root, "plugin", "package.json"), "utf8"));
if (readFileSync(join(root, "docs", "command-reference.md"), "utf8") !== generatedCommandReference()) {
  failures.push("docs/command-reference.md is stale; run bun run generate:docs.");
}
if (pkg.version !== HEADLESS_VERSION || plugin.version !== pkg.version || pkg.private !== true || plugin.private !== true) {
  failures.push(`Root/plugin manifests must remain aligned and private at ${HEADLESS_VERSION} (src/version.ts is the single source of truth).`);
}
if (plugin.peerDependencies?.["@proofofwork-agency/headless"] !== HEADLESS_VERSION) {
  failures.push(`plugin peerDependency @proofofwork-agency/headless must equal ${HEADLESS_VERSION}.`);
}

// Website golden-path / version parity (source docs; not npm-shipped)
const websiteChecks: Array<{ relative: string; patterns: RegExp[] }> = [
  {
    relative: "website/docs/intro.md",
    patterns: [new RegExp(HEADLESS_VERSION.replace(/\./g, "\\.")), /headless setup/i, /--profile read-only-native/],
  },
  {
    relative: "website/docs/getting-started/quickstart.md",
    patterns: [/headless setup/i, /--profile read-only-native/],
  },
  {
    relative: "website/docs/guides/cli.md",
    patterns: [/\bsetup\b/, /--profile read-only-native/, /Beta 1 commands are exactly:[\s\S]*?\bsetup\b/],
  },
  {
    relative: "website/docs/getting-started/installation.md",
    patterns: [new RegExp(HEADLESS_VERSION.replace(/\./g, "\\.")), /headless setup/i],
  },
];
for (const check of websiteChecks) {
  const path = join(root, check.relative);
  if (!existsSync(path)) {
    failures.push(`${check.relative} is missing.`);
    continue;
  }
  const text = readFileSync(path, "utf8");
  if (/private\s+alpha/i.test(text)) failures.push(`${check.relative} still says private alpha.`);
  for (const pattern of check.patterns) {
    if (!pattern.test(text)) failures.push(`${check.relative} must match ${pattern}.`);
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`docs-check: ${failure}`);
  process.exit(1);
}

console.log(`docs-check passed: ${documents.length} release documents and local links verified`);
