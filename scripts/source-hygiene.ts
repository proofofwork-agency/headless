import { readFileSync, statSync } from "node:fs";

const mode = process.argv[2];
if (mode !== "lint" && mode !== "format") throw new Error("Usage: bun scripts/source-hygiene.ts <lint|format>");

const roots = ["src", "plugin", "scripts", "tests", "docs", ".github"];
const extensions = new Set([".ts", ".tsx", ".md", ".json", ".yml", ".yaml"]);
const files = ["README.md", "SECURITY.md", "CHANGELOG.md", "package.json", "tsconfig.json"];
for (const root of roots) {
  const glob = new Bun.Glob("**/*");
  for (const path of glob.scanSync({ cwd: root, onlyFiles: true })) {
    if (path.split("/").some((part) => part === "node_modules" || part === "dist" || part === ".git" || part === "cache")) continue;
    const extension = path.slice(path.lastIndexOf("."));
    if (extensions.has(extension)) files.push(`${root}/${path}`);
  }
}

const failures: string[] = [];
for (const path of [...new Set(files)].sort()) {
  if (!statSync(path).isFile()) continue;
  const source = readFileSync(path, "utf8");
  if (mode === "format") {
    if (source.includes("\r")) failures.push(`${path}: CRLF/carriage returns are not allowed`);
    if (!source.endsWith("\n")) failures.push(`${path}: file must end with a newline`);
    source.split("\n").forEach((line, index) => {
      if (/[ \t]+$/.test(line)) failures.push(`${path}:${index + 1}: trailing whitespace`);
      if (line.includes("\t")) failures.push(`${path}:${index + 1}: tab indentation is not allowed`);
    });
    if (path.endsWith(".json")) {
      try { JSON.parse(source); } catch (error) { failures.push(`${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`); }
    }
    continue;
  }
  if (!/\.(?:ts|tsx)$/.test(path)) continue;
  if (path === "scripts/source-hygiene.ts") continue;
  for (const [pattern, label] of [
    [/\bas\s+any\b/g, "untyped any cast"],
    [/\bMath\.random\s*\(/g, "nondeterministic Math.random"],
    [/\b(?:TODO|FIXME)\b/g, "unfinished TODO/FIXME marker"],
    [/@ts-ignore\b/g, "unchecked @ts-ignore"],
  ] as const) {
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split("\n").length;
      failures.push(`${path}:${line}: ${label}`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`source ${mode} check passed: ${new Set(files).size} files`);
