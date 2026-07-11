import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const documents = ["README.md", "SECURITY.md", "CHANGELOG.md", "docs/mcp-integration.md", "docs/native-login.md", "docs/plan.md"];
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
if (pkg.version !== "0.2.0" || plugin.version !== pkg.version) failures.push("Root/plugin versions are not aligned at 0.2.0.");

if (failures.length) {
  for (const failure of failures) console.error(`docs-check: ${failure}`);
  process.exit(1);
}

console.log(`docs-check passed: ${documents.length} release documents and local links verified`);
