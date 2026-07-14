import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextOpenCodeEnv } from "../src/backends/opencode";
import { runHeadless } from "../src/runner/simple";
import { installNativeAuthCapsule } from "../src/runtime/native-auth-capsule";
import { MAX_OPENCODE_NATIVE_CONFIG_BYTES, resolveOpenCodeNativeModel } from "../src/runtime/opencode-native-model";
import { createWorkerEnvironment } from "../src/runtime/worker-environment";

const roots: string[] = [];
const originalPath = process.env.PATH;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalOpenCodeConfig = process.env.OPENCODE_CONFIG;

afterEach(() => {
  process.env.PATH = originalPath;
  restoreEnvironment("XDG_CONFIG_HOME", originalXdgConfigHome);
  restoreEnvironment("OPENCODE_CONFIG", originalOpenCodeConfig);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("OpenCode native model defaults", () => {
  test("extracts only the JSON scalar and never copies malicious plugin or MCP config", () => {
    const fixture = nativeFixture();
    writeConfig(fixture.home, "opencode.json", {
      model: "openai/native-default",
      plugin: ["file:///tmp/malicious-plugin.js"],
      mcp: { attacker: { command: ["/tmp/steal-secrets"] } },
    });
    const worker = createWorkerEnvironment({ baseDir: fixture.workerBase });
    try {
      const result = installNativeAuthCapsule(worker, "opencode", {
        homeDir: fixture.home,
        resolveOpenCodeModel: true,
      });
      expect(result).toMatchObject({ available: true, model: "openai/native-default" });
      expect(result.manifest?.files).toEqual(["data/opencode/auth.json"]);
      expect(existsSync(join(worker.config, "opencode", "opencode.json"))).toBe(false);
      expect(existsSync(join(worker.config, "opencode", "opencode.jsonc"))).toBe(false);
      const env = nextOpenCodeEnv(worker.env);
      expect(env.OPENCODE_CONFIG_CONTENT).not.toContain("malicious-plugin");
      expect(env.OPENCODE_CONFIG_CONTENT).not.toContain("steal-secrets");
      expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
      expect(env.OPENCODE_DISABLE_DEFAULT_PLUGINS).toBe("1");
    } finally {
      worker.cleanup();
    }
  });

  test("supports bounded JSONC comments and trailing commas", () => {
    const fixture = nativeFixture();
    const directory = configDirectory(fixture.home);
    writeFileSync(join(directory, "opencode.jsonc"), `{
      // The URL-like value proves comment stripping stays outside strings.
      "model": "openrouter/model//stable",
      "mcp": { "ignored": true, },
    }`, { mode: 0o600 });

    expect(resolveOpenCodeNativeModel({ homeDir: fixture.home })).toEqual({
      available: true,
      model: "openrouter/model//stable",
      source: "opencode.jsonc",
    });
  });

  test("rejects symlinked, hardlinked, and oversized global configuration", () => {
    const symlinkFixture = nativeFixture();
    const target = join(symlinkFixture.home, "redirected.json");
    writeFileSync(target, JSON.stringify({ model: "openai/symlink" }), { mode: 0o600 });
    symlinkSync(target, join(configDirectory(symlinkFixture.home), "opencode.json"));
    expect(resolveOpenCodeNativeModel({ homeDir: symlinkFixture.home })).toMatchObject({ available: false });

    const hardlinkFixture = nativeFixture();
    const shared = join(hardlinkFixture.home, "shared.json");
    writeFileSync(shared, JSON.stringify({ model: "openai/hardlink" }), { mode: 0o600 });
    linkSync(shared, join(configDirectory(hardlinkFixture.home), "opencode.json"));
    expect(resolveOpenCodeNativeModel({ homeDir: hardlinkFixture.home })).toMatchObject({
      available: false,
      reason: expect.stringContaining("single-link owner file"),
    });

    const writableFixture = nativeFixture();
    const writable = join(configDirectory(writableFixture.home), "opencode.json");
    writeFileSync(writable, JSON.stringify({ model: "openai/group-writable" }), { mode: 0o622 });
    chmodSync(writable, 0o622);
    expect(resolveOpenCodeNativeModel({ homeDir: writableFixture.home })).toMatchObject({
      available: false,
      reason: expect.stringContaining("single-link owner file"),
    });

    const oversizedFixture = nativeFixture();
    writeFileSync(
      join(configDirectory(oversizedFixture.home), "opencode.json"),
      Buffer.alloc(MAX_OPENCODE_NATIVE_CONFIG_BYTES + 1, 0x20),
      { mode: 0o600 },
    );
    expect(resolveOpenCodeNativeModel({ homeDir: oversizedFixture.home })).toMatchObject({
      available: false,
      reason: expect.stringContaining("size limit"),
    });
  });

  test("explicit model overrides the host default without reading or copying it", () => {
    const fixture = nativeFixture();
    const target = join(fixture.home, "untrusted.json");
    writeFileSync(target, JSON.stringify({ model: "attacker/model", plugin: ["malicious"] }), { mode: 0o600 });
    symlinkSync(target, join(configDirectory(fixture.home), "opencode.json"));

    expect(resolveOpenCodeNativeModel({
      homeDir: fixture.home,
      requestedModel: "openai/explicit-model",
    })).toEqual({
      available: true,
      model: "openai/explicit-model",
      source: "explicit",
    });
  });

  test("ignores custom XDG and OpenCode config paths unless a model is explicit", () => {
    const fixture = nativeFixture();
    const custom = join(fixture.root, "custom-config");
    mkdirSync(custom);
    writeFileSync(join(custom, "opencode.json"), JSON.stringify({ model: "attacker/custom-default" }), { mode: 0o600 });
    process.env.XDG_CONFIG_HOME = custom;
    process.env.OPENCODE_CONFIG = join(custom, "opencode.json");

    expect(resolveOpenCodeNativeModel({ homeDir: fixture.home })).toMatchObject({ available: false });
    expect(resolveOpenCodeNativeModel({
      homeDir: fixture.home,
      requestedModel: "openai/explicit-safe",
    })).toMatchObject({ available: true, model: "openai/explicit-safe" });
  });

  test("binds the selected scalar into the auth profile fingerprint", () => {
    const fixture = nativeFixture();
    writeConfig(fixture.home, "opencode.json", { model: "openai/model-a" });
    const first = createWorkerEnvironment({ baseDir: fixture.workerBase });
    const second = createWorkerEnvironment({ baseDir: fixture.workerBase });
    try {
      const before = installNativeAuthCapsule(first, "opencode", {
        homeDir: fixture.home,
        resolveOpenCodeModel: true,
      });
      writeConfig(fixture.home, "opencode.json", { model: "openai/model-b" });
      const after = installNativeAuthCapsule(second, "opencode", {
        homeDir: fixture.home,
        resolveOpenCodeModel: true,
      });
      expect(before.manifest?.fingerprint).not.toBe(after.manifest?.fingerprint);
      expect([before.model, after.model]).toEqual(["openai/model-a", "openai/model-b"]);
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });

  test("propagates the global default into one-shot argv and fails before launch when missing", async () => {
    const fixture = nativeFixture();
    const project = join(fixture.root, "project");
    const bin = join(fixture.root, "bin");
    mkdirSync(project);
    mkdirSync(bin);
    installFakeOpenCode(bin);
    process.env.PATH = `${bin}:${originalPath}`;
    writeConfig(fixture.home, "opencode.json", { model: "openai/one-shot-default", mcp: { ignored: true } });

    const result = await runHeadless({
      backend: "opencode",
      prompt: "hello",
      cwd: project,
      containment: "unsafe",
      authMode: "native-login",
      authHomeDir: fixture.home,
    });
    expect(result).toMatchObject({ ok: true, output: "one-shot-ok" });
    expect(readFileSync(join(project, ".opencode-argv"), "utf8")).toContain("--model\nopenai/one-shot-default\n");

    rmSync(join(configDirectory(fixture.home), "opencode.json"));
    rmSync(join(project, ".opencode-argv"));
    const missing = await runHeadless({
      backend: "opencode",
      prompt: "must not launch",
      cwd: project,
      containment: "unsafe",
      authMode: "native-login",
      authHomeDir: fixture.home,
    });
    expect(missing).toMatchObject({
      ok: false,
      status: "blocked",
      error: { code: "NATIVE_AUTH_UNAVAILABLE" },
    });
    expect(existsSync(join(project, ".opencode-argv"))).toBe(false);
  });

  test("propagates an explicit one-shot model without a global default", async () => {
    const fixture = nativeFixture();
    const project = join(fixture.root, "project");
    const bin = join(fixture.root, "bin");
    mkdirSync(project);
    mkdirSync(bin);
    installFakeOpenCode(bin);
    process.env.PATH = `${bin}:${originalPath}`;

    const result = await runHeadless({
      backend: "opencode",
      prompt: "hello",
      cwd: project,
      model: "openai/explicit-one-shot",
      containment: "unsafe",
      authMode: "native-login",
      authHomeDir: fixture.home,
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(join(project, ".opencode-argv"), "utf8")).toContain("--model\nopenai/explicit-one-shot\n");
  });

  test("normalizes unsafe explicit models and an unavailable home before launch", async () => {
    const fixture = nativeFixture();
    const project = join(fixture.root, "project");
    const bin = join(fixture.root, "bin");
    mkdirSync(project);
    mkdirSync(bin);
    installFakeOpenCode(bin);
    process.env.PATH = `${bin}:${originalPath}`;

    const invalid = await runHeadless({
      backend: "opencode",
      prompt: "must not launch",
      cwd: project,
      model: "openai/unsafe\nmodel",
      containment: "unsafe",
      authMode: "native-login",
      authHomeDir: fixture.home,
    });
    expect(invalid).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    expect(existsSync(join(project, ".opencode-argv"))).toBe(false);

    const missingHome = await runHeadless({
      backend: "opencode",
      prompt: "must not launch",
      cwd: project,
      model: "openai/safe",
      containment: "unsafe",
      authMode: "native-login",
      authHomeDir: join(fixture.root, "missing-home"),
    });
    expect(missingHome).toMatchObject({
      ok: false,
      status: "blocked",
      error: { code: "NATIVE_AUTH_UNAVAILABLE" },
    });
    expect(existsSync(join(project, ".opencode-argv"))).toBe(false);
  });
});

function nativeFixture() {
  const root = mkdtempSync(join(tmpdir(), "headless-opencode-native-model-"));
  const home = join(root, "home");
  const workerBase = join(root, "workers");
  mkdirSync(home);
  mkdirSync(workerBase);
  mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
  writeFileSync(join(home, ".local", "share", "opencode", "auth.json"), JSON.stringify({ token: "native-token" }), { mode: 0o600 });
  configDirectory(home);
  roots.push(root);
  return { root, home, workerBase };
}

function configDirectory(home: string) {
  const directory = join(home, ".config", "opencode");
  mkdirSync(directory, { recursive: true });
  return directory;
}

function writeConfig(home: string, name: "opencode.json" | "opencode.jsonc", contents: unknown) {
  writeFileSync(join(configDirectory(home), name), JSON.stringify(contents), { mode: 0o600 });
}

function installFakeOpenCode(bin: string) {
  const path = join(bin, "opencode");
  writeFileSync(path, `#!/bin/sh
printf '%s\n' "$@" > "$PWD/.opencode-argv"
if [ -e "$XDG_CONFIG_HOME/opencode/opencode.json" ] || [ -e "$XDG_CONFIG_HOME/opencode/opencode.jsonc" ]; then
  printf '%s\n' 'host config escaped into worker' >&2
  exit 71
fi
printf '%s\n' '{"type":"part.updated","properties":{"part":{"type":"text","text":"one-shot-ok","time":{"end":1}}}}'
`, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
