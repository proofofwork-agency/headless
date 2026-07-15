import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { generatedCommandReference } from "./generate-command-reference";
import { HEADLESS_VERSION } from "../src/version";

const root = resolve(import.meta.dir, "..");
const documents = ["README.md", "SECURITY.md", "CHANGELOG.md", "docs/command-reference.md", "docs/cli-and-tui-guide.md", "docs/mcp-integration.md", "docs/native-login.md", "docs/plan.md"];
const failures: string[] = [];

for (const relative of documents) {
  const path = join(root, relative);
  const text = readFileSync(path, "utf8");
  for (const forbidden of [
    /bun\s+src\/mcp\/server\.ts/g,
    /dist\/mcp-server\.js/g,
    /bwrap\s*\+\s*landlock/gi,
    /\.headless\/sessions\//g,
  ]) {
    if (forbidden.test(text)) failures.push(`${relative} contains stale install/security text matching ${forbidden}.`);
  }

  for (const match of text.matchAll(/\[[^\]]+\]\((?!https?:|#)([^)]+)\)/g)) {
    const target = match[1].split("#", 1)[0];
    if (!target || target.startsWith("mailto:")) continue;
    if (!existsSync(resolve(dirname(path), target))) failures.push(`${relative} links to missing local file ${match[1]}.`);
  }
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const plugin = JSON.parse(readFileSync(join(root, "plugin", "package.json"), "utf8"));
if (readFileSync(join(root, "docs", "command-reference.md"), "utf8") !== generatedCommandReference()) {
  failures.push("docs/command-reference.md is stale; run bun run generate:docs.");
}
if (pkg.version !== HEADLESS_VERSION || plugin.version !== pkg.version || pkg.private !== true || plugin.private !== true) {
  failures.push(`Root/plugin manifests must remain aligned and private at ${HEADLESS_VERSION} (src/version.ts is the single source of truth).`);
}

if (failures.length) {
  for (const failure of failures) console.error(`docs-check: ${failure}`);
  process.exit(1);
}

console.log(`docs-check passed: ${documents.length} release documents and local links verified`);
