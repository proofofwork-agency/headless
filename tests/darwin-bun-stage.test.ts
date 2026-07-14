import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import {
  MAX_DARWIN_STAGED_BUN_SCRIPT_BYTES,
  stageDarwinBunScript,
} from "../src/runtime/darwin-bun-stage";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("bounded macOS Bun script staging", () => {
  test("stages exact env and direct Bun scripts in owner-only launch directories", () => {
    const fixture = stagingFixture();
    const direct = join(fixture.bin, "direct");
    writeExecutable(direct, `#!${fixture.bun}\nconsole.log("direct")\n`);

    for (const command of [["fixture", "one"], ["direct", "two"]]) {
      const staged = stageDarwinBunScript(command, fixture.path, fixture, fixture.project);
      expect(staged.kind).toBe("staged");
      if (staged.kind !== "staged") continue;
      expect(staged.command).toEqual([fixture.bun, staged.stagedScript, command[1]!]);
      expect(readFileSync(staged.stagedScript, "utf8")).toBe(readFileSync(join(fixture.bin, command[0]!), "utf8"));
      expect(statSync(staged.stagedDirectory).mode & 0o777).toBe(0o700);
      expect(statSync(staged.stagedScript).mode & 0o777).toBe(0o600);
      expect(readdirSync(staged.stagedDirectory)).toEqual(["entry.ts"]);
      staged.cleanup();
      staged.cleanup();
      expect(existsSync(staged.stagedDirectory)).toBe(false);
    }
  });

  test("never stages Node, Codex, unsafe Bun, or oversized Bun scripts", () => {
    const fixture = stagingFixture();
    const cases = [
      { name: "node", content: "#!/usr/bin/env node\nconsole.log(1)\n", kind: "none" },
      { name: "codex.js", content: "#!/usr/bin/env bun\nconsole.log(1)\n", kind: "none" },
      { name: "env-flags", content: "#!/usr/bin/env -S bun\nconsole.log(1)\n", kind: "rejected" },
      { name: "env-args", content: "#!/usr/bin/env bun --smol\nconsole.log(1)\n", kind: "rejected" },
      { name: "direct-args", content: `#!${fixture.bun} --smol\nconsole.log(1)\n`, kind: "rejected" },
      {
        name: "oversized",
        content: `#!/usr/bin/env bun\n${"x".repeat(MAX_DARWIN_STAGED_BUN_SCRIPT_BYTES)}`,
        kind: "rejected",
      },
    ] as const;

    for (const item of cases) {
      const executable = join(fixture.bin, item.name);
      writeExecutable(executable, item.content);
      const staged = stageDarwinBunScript([item.name], fixture.path, fixture, fixture.project);
      expect(staged.kind).toBe(item.kind);
      expect(stageDirectories(fixture.runtime)).toEqual([]);
    }
  });

  test("fails closed without residue for an out-of-root or unwritable worker runtime", () => {
    const fixture = stagingFixture();
    const outside = realpathSync.native(mkdtempSync(join(tmpdir(), "headless-outside-runtime-")));
    roots.push(outside);

    const escaped = stageDarwinBunScript(["fixture"], fixture.path, {
      root: fixture.root,
      runtime: outside,
    }, fixture.project);
    expect(escaped.kind).toBe("rejected");
    expect(stageDirectories(outside)).toEqual([]);

    chmodSync(fixture.runtime, 0o500);
    const unwritable = stageDarwinBunScript(["fixture"], fixture.path, fixture, fixture.project);
    expect(unwritable.kind).toBe("rejected");
    expect(stageDirectories(fixture.runtime)).toEqual([]);
    chmodSync(fixture.runtime, 0o700);
  });

  test("does not stage project, worker-local, or non-executable scripts", () => {
    const fixture = stagingFixture();
    const projectScript = join(fixture.project, "project-tool");
    const workerScript = join(fixture.root, "worker-tool");
    const nonExecutable = join(fixture.bin, "non-executable");
    writeExecutable(projectScript, "#!/usr/bin/env bun\nconsole.log('project')\n");
    writeExecutable(workerScript, "#!/usr/bin/env bun\nconsole.log('worker')\n");
    writeFileSync(nonExecutable, "#!/usr/bin/env bun\nconsole.log('noexec')\n", { mode: 0o600 });

    for (const command of [projectScript, workerScript, nonExecutable]) {
      expect(stageDarwinBunScript([command], fixture.path, fixture, fixture.project).kind).toBe("none");
    }
    expect(stageDirectories(fixture.runtime)).toEqual([]);
  });
});

function stagingFixture() {
  const fixtureRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "headless-darwin-bun-stage-")));
  roots.push(fixtureRoot);
  const root = join(fixtureRoot, "worker");
  const bin = join(fixtureRoot, "bin");
  const runtime = join(root, "runtime");
  const project = join(fixtureRoot, "project");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  mkdirSync(project, { recursive: true, mode: 0o700 });
  const bun = realpathSync.native(process.execPath);
  const path = [bin, dirname(bun), process.env.PATH].filter(Boolean).join(delimiter);
  writeExecutable(join(bin, "bun"), "#!/bin/sh\nexit 99\n");
  writeExecutable(join(bin, "fixture"), "#!/usr/bin/env bun\nconsole.log(\"fixture\")\n");
  writeFileSync(join(bin, "sibling.ts"), "export const secret = true;\n");
  return { root, bin, runtime, project, bun, path };
}

function writeExecutable(path: string, content: string) {
  writeFileSync(path, content, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function stageDirectories(runtime: string) {
  return readdirSync(runtime).filter((name) => name.startsWith("darwin-bun-stage-"));
}
