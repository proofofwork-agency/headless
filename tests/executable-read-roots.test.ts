import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import {
  executableReadRoots,
  MAX_EXECUTABLE_MANIFEST_BYTES,
  MAX_EXECUTABLE_PATH_ENTRIES,
  MAX_EXECUTABLE_PATH_VALUE_BYTES,
  MAX_EXECUTABLE_RUNTIME_ROOTS,
  MAX_EXECUTABLE_SHEBANG_BYTES,
} from "../src/runtime/executable-read-roots";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("executable runtime read roots", () => {
  test("grants exact Codex runtime files without exposing command or native siblings", () => {
    const fixture = codexFixture();
    const middle = join(fixture.bin, "codex-middle");
    symlinkSync(relative(fixture.bin, fixture.commandEntrypoint), middle);
    symlinkSync("codex-middle", join(fixture.bin, "codex"));

    const result = executableReadRoots(["codex"], { PATH: fixture.bin });

    expect(result).toEqual(expect.arrayContaining([
      fixture.entrypoint,
      fixture.packageManifest,
      fixture.platformManifest,
      fixture.nativeExecutable,
      fixture.node,
    ]));
    for (const directory of [fixture.bin, fixture.packageRoot, fixture.platformRoot, dirname(fixture.nativeExecutable)]) {
      expect(result).not.toContain(directory);
    }
    expect(result).not.toContain(fixture.binSibling);
    expect(result).not.toContain(fixture.codeModeHost);
    expect(result.length).toBeLessThanOrEqual(MAX_EXECUTABLE_RUNTIME_ROOTS);
  });

  for (const layout of ["nested", "hoisted", "pnpm"] as const) {
    test(`supports the verified ${layout} optional-package layout`, () => {
      const fixture = codexFixture({ layout });
      linkCommand(fixture);

      const result = executableReadRoots(["codex"], { PATH: fixture.bin });

      expect(result).toEqual(expect.arrayContaining([
        fixture.entrypoint,
        fixture.packageManifest,
        fixture.platformManifest,
        fixture.nativeExecutable,
        fixture.node,
      ]));
      expect(result).not.toContain(fixture.packageRoot);
      expect(result).not.toContain(fixture.platformRoot);
      expect(result).not.toContain(dirname(fixture.nativeExecutable));
    });
  }

  test("supports the official bundled vendor fallback with exact files only", () => {
    const fixture = codexFixture({ layout: "bundled" });
    linkCommand(fixture);

    const result = executableReadRoots(["codex"], { PATH: fixture.bin });

    expect(result).toEqual(expect.arrayContaining([
      fixture.entrypoint,
      fixture.packageManifest,
      fixture.nativeExecutable,
      fixture.node,
    ]));
    expect(result).not.toContain(dirname(fixture.nativeExecutable));
    expect(result).not.toContain(fixture.codeModeHost);
  });

  test("adds only the exact interpreter explicitly requested by safe env shebangs", () => {
    const fixture = codexFixture();
    linkCommand(fixture);
    const generic = join(fixture.bin, "generic");
    writeFileSync(generic, "#!/usr/bin/env node\n");

    expect(executableReadRoots(["generic"], { PATH: fixture.bin })).toEqual([
      generic,
      realpathSync.native("/usr/bin/env"),
      fixture.node,
    ]);
    const codex = executableReadRoots(["codex"], { PATH: fixture.bin });
    expect(codex).toContain(fixture.node);
    expect(codex).not.toContain(fixture.bun);
    expect(codex).not.toContain(fixture.bin);
  });

  test("supports exact Bun, Node, and absolute interpreter files without exposing siblings", () => {
    const fixture = codexFixture();
    const bunScript = join(fixture.bin, "bun-script");
    const nodeScript = join(fixture.bin, "node-script");
    const directScript = join(fixture.bin, "direct-script");
    const directInterpreter = join(fixture.bin, "direct-runtime");
    writeFileSync(bunScript, "#!/usr/bin/env bun\n");
    writeFileSync(nodeScript, "#!/usr/bin/env node\n");
    writeFileSync(directInterpreter, "runtime");
    writeFileSync(directScript, `#!${directInterpreter}\n`);

    const env = realpathSync.native("/usr/bin/env");
    expect(executableReadRoots(["bun-script"], { PATH: fixture.bin })).toEqual([
      bunScript,
      env,
      fixture.bun,
    ]);
    expect(executableReadRoots(["node-script"], { PATH: fixture.bin })).toEqual([
      nodeScript,
      env,
      fixture.node,
    ]);
    expect(executableReadRoots(["direct-script"], { PATH: fixture.bin })).toEqual([
      directScript,
      directInterpreter,
    ]);
    for (const sibling of [fixture.bin, fixture.binSibling, fixture.node, fixture.bun]) {
      expect(executableReadRoots(["direct-script"], { PATH: fixture.bin })).not.toContain(sibling);
    }
  });

  test("rejects env flags, assignments, extra arguments, unsafe names, and oversized shebangs", () => {
    const fixture = codexFixture();
    const shebangs = [
      "#!/usr/bin/env",
      "#!/usr/bin/env -S bun",
      "#!/usr/bin/env FOO=bar bun",
      "#!/usr/bin/env bun --inspect",
      "#!/usr/bin/env ../bun",
      `#!${fixture.bun} --inspect`,
      `#!/usr/bin/env ${"b".repeat(MAX_EXECUTABLE_SHEBANG_BYTES)}`,
    ];
    for (const [index, shebang] of shebangs.entries()) {
      const script = join(fixture.bin, `rejected-${index}`);
      writeFileSync(script, `${shebang}\n`);
      expect(executableReadRoots([script], { PATH: fixture.bin })).toEqual([script]);
    }
  });

  test("rejects a platform-package symlink that escapes the owning node_modules tree", () => {
    const fixture = codexFixture({ layout: "none" });
    const outside = join(fixture.root, "outside", "platform");
    const outsideManifest = join(outside, "package.json");
    const outsideNative = join(outside, "vendor", platformTarget().triple, "bin", "codex");
    mkdirSync(dirname(outsideNative), { recursive: true });
    writeFileSync(outsideManifest, JSON.stringify({ name: platformTarget().packageName }));
    writeFileSync(outsideNative, "native");
    mkdirSync(dirname(fixture.platformLookup), { recursive: true });
    symlinkSync(outside, fixture.platformLookup);
    linkCommand(fixture);

    const result = executableReadRoots(["codex"], { PATH: fixture.bin });

    expect(result).toEqual(expect.arrayContaining([fixture.entrypoint, fixture.packageManifest, fixture.node]));
    expect(result).not.toContain(outsideManifest);
    expect(result).not.toContain(outsideNative);
    expect(result.every((path) => !path.startsWith(outside))).toBe(true);
  });

  test("rejects a native executable symlink escape while retaining exact verified manifests", () => {
    const fixture = codexFixture({ nativeExecutable: false });
    const outside = join(fixture.root, "outside-native");
    writeFileSync(outside, "native");
    mkdirSync(dirname(fixture.nativeExecutable), { recursive: true });
    symlinkSync(outside, fixture.nativeExecutable);
    linkCommand(fixture);

    const result = executableReadRoots(["codex"], { PATH: fixture.bin });

    expect(result).toEqual(expect.arrayContaining([
      fixture.entrypoint,
      fixture.packageManifest,
      fixture.platformManifest,
      fixture.node,
    ]));
    expect(result).not.toContain(outside);
    expect(result).not.toContain(fixture.nativeExecutable);
  });

  test("rejects a package-name alias instead of treating the main package as a platform package", () => {
    const fixture = codexFixture({ platformManifestName: "@openai/codex" });
    linkCommand(fixture);

    const result = executableReadRoots(["codex"], { PATH: fixture.bin });

    expect(result).toEqual(expect.arrayContaining([fixture.entrypoint, fixture.packageManifest, fixture.node]));
    expect(result).not.toContain(fixture.platformManifest);
    expect(result).not.toContain(fixture.nativeExecutable);
  });

  test("accepts the official npm alias only when both manifests bind its exact platform version", () => {
    const fixture = codexFixture({
      platformManifestName: "@openai/codex",
      boundPlatformAlias: true,
    });
    linkCommand(fixture);

    const result = executableReadRoots(["codex"], { PATH: fixture.bin });

    expect(result).toEqual(expect.arrayContaining([
      fixture.platformManifest,
      fixture.nativeExecutable,
    ]));
  });

  test("bounds PATH before splitting, caps entries, and refuses oversized package metadata", () => {
    const fixture = codexFixture();
    linkCommand(fixture);
    const preceding = Array.from(
      { length: MAX_EXECUTABLE_PATH_ENTRIES },
      (_, index) => join(fixture.root, `missing-${index}`),
    );
    expect(executableReadRoots(["codex"], { PATH: [...preceding, fixture.bin].join(delimiter) })).toEqual([]);
    expect(executableReadRoots(["codex"], {
      PATH: `${fixture.bin}${delimiter}${"x".repeat(MAX_EXECUTABLE_PATH_VALUE_BYTES + 1)}`,
    })).toEqual([]);

    writeFileSync(fixture.packageManifest, Buffer.alloc(MAX_EXECUTABLE_MANIFEST_BYTES + 1, 0x20));
    expect(executableReadRoots(["codex"], { PATH: fixture.bin })).toEqual([
      fixture.entrypoint,
      realpathSync.native("/usr/bin/env"),
      fixture.node,
    ]);
  });
});

type CodexLayout = "nested" | "hoisted" | "pnpm" | "bundled" | "none";

function codexFixture(options: {
  layout?: CodexLayout;
  nativeExecutable?: boolean;
  platformManifestName?: string;
  boundPlatformAlias?: boolean;
} = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "headless-codex-runtime-roots-")));
  roots.push(root);
  const layout = options.layout ?? "nested";
  const target = platformTarget();
  const install = join(root, "install");
  const bin = join(install, "bin");
  const packageRoot = layout === "pnpm"
    ? join(install, "node_modules", ".pnpm", "@openai+codex@0.0.0", "node_modules", "@openai", "codex")
    : join(install, "node_modules", "@openai", "codex");
  const entrypoint = join(packageRoot, "bin", "codex.js");
  const packageManifest = join(packageRoot, "package.json");
  const platformLookup = join(packageRoot, "node_modules", "@openai", target.packageName.split("/")[1]!);
  const platformRoot = layout === "hoisted"
    ? join(install, "node_modules", "@openai", target.packageName.split("/")[1]!)
    : layout === "pnpm"
      ? join(install, "node_modules", ".pnpm", `${target.packageName.replace("/", "+")}@0.0.0`, "node_modules", "@openai", target.packageName.split("/")[1]!)
      : platformLookup;
  const platformManifest = join(platformRoot, "package.json");
  const nativeExecutable = layout === "bundled"
    ? join(packageRoot, "vendor", target.triple, "bin", "codex")
    : join(platformRoot, "vendor", target.triple, "bin", "codex");
  const node = join(bin, "node");
  const bun = join(bin, "bun");
  const binSibling = join(bin, "host-secret-tool");
  const codeModeHost = join(dirname(nativeExecutable), "codex-code-mode-host");

  mkdirSync(bin, { recursive: true });
  mkdirSync(dirname(entrypoint), { recursive: true });
  writeFileSync(entrypoint, "#!/usr/bin/env node\n");
  const platformVersion = `0.0.0-${target.packageName.split("codex-")[1]}`;
  writeFileSync(packageManifest, JSON.stringify({
    name: "@openai/codex",
    version: "0.0.0",
    optionalDependencies: options.boundPlatformAlias
      ? { [target.packageName]: `npm:@openai/codex@${platformVersion}` }
      : undefined,
  }));
  for (const executable of [node, bun, binSibling]) writeFileSync(executable, "runtime");

  if (layout !== "bundled" && layout !== "none") {
    mkdirSync(dirname(platformManifest), { recursive: true });
    writeFileSync(platformManifest, JSON.stringify({
      name: options.platformManifestName ?? target.packageName,
      version: options.boundPlatformAlias ? platformVersion : undefined,
    }));
    if (layout === "pnpm") {
      mkdirSync(dirname(platformLookup), { recursive: true });
      symlinkSync(relative(dirname(platformLookup), platformRoot), platformLookup);
    }
  }
  if (layout !== "none" && options.nativeExecutable !== false) {
    mkdirSync(dirname(nativeExecutable), { recursive: true });
    writeFileSync(nativeExecutable, "native");
  }
  if (layout !== "none") {
    mkdirSync(dirname(codeModeHost), { recursive: true });
    writeFileSync(codeModeHost, "sibling");
  }

  let commandEntrypoint = entrypoint;
  if (layout === "pnpm") {
    const linkedPackage = join(install, "node_modules", "@openai", "codex");
    mkdirSync(dirname(linkedPackage), { recursive: true });
    symlinkSync(relative(dirname(linkedPackage), packageRoot), linkedPackage);
    commandEntrypoint = join(linkedPackage, "bin", "codex.js");
  }
  return {
    root,
    bin,
    commandEntrypoint,
    packageRoot,
    entrypoint,
    packageManifest,
    platformLookup,
    platformRoot,
    platformManifest,
    nativeExecutable,
    codeModeHost,
    node,
    bun,
    binSibling,
  };
}

function linkCommand(fixture: ReturnType<typeof codexFixture>) {
  symlinkSync(relative(fixture.bin, fixture.commandEntrypoint), join(fixture.bin, "codex"));
}

function platformTarget() {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return { packageName: "@openai/codex-darwin-arm64", triple: "aarch64-apple-darwin" };
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return { packageName: "@openai/codex-darwin-x64", triple: "x86_64-apple-darwin" };
  }
  if (process.platform === "linux" && process.arch === "arm64") {
    return { packageName: "@openai/codex-linux-arm64", triple: "aarch64-unknown-linux-musl" };
  }
  return { packageName: "@openai/codex-linux-x64", triple: "x86_64-unknown-linux-musl" };
}
