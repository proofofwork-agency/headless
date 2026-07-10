import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { normalizeBackend } from "../src/backends/ids";
import { backendAdapters, buildBackendEnv } from "../src/backends/registry";
import { buildGrokCommand, parseGrokJsonl } from "../src/backends/grok";
import { parseClaudeStreamJson, parseCodexJson, parseGenericAgentJson, tokenCount } from "../src/backends/json";
import { buildOpenCodeCommand, nextOpenCodeEnv, OPENCODE_CONFIG_CONTENT, parseOpenCodeJsonl } from "../src/backends/opencode";
import {
  appendEvent,
  appendNote,
  deliberate,
  getOrCreateSession,
  getReadContext,
  getTaskState,
  headlessRun,
  readLedger,
  recordArtifact,
  exec,
  LedgerIntegrityError,
} from "../src/index";
import { getPrompt, parseIntegerArg } from "../src/cli";
import { isSuccessfulRun, maybeWrapWithSandbox } from "../src/runner/simple";
import { runGitStrict } from "../src/runtime/git";
import { buildDarwinReadOnlyProfile, cleanupSandboxProfile, DARWIN_SANDBOX_EXEC, probeDarwinSandboxWriteDenial, writeDarwinSandboxProfile } from "../src/runtime/os-sandbox";

const originalEnv = { ...process.env };
const gitAvailable = runGitStrict(["--version"], process.cwd()).ok;
const gitTest = gitAvailable ? test : test.skip;
const darwinTest = process.platform === "darwin" ? test : test.skip;

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("backend normalization", () => {
  test("accepts canonical ids and aliases", () => {
    expect(normalizeBackend("claude")).toBe("claude-code");
    expect(normalizeBackend("claude-code")).toBe("claude-code");
    expect(normalizeBackend("grok")).toBe("grok-build");
    expect(normalizeBackend("grok-build")).toBe("grok-build");
    expect(normalizeBackend("codex-cli")).toBe("codex");
    expect(normalizeBackend("headless-opencode")).toBe("opencode");
  });
});

describe("opencode backend helpers", () => {
  test("builds one-shot pure JSON command with cwd, model, and agent", () => {
    expect(
      buildOpenCodeCommand(
        {
          backend: "opencode",
          prompt: "do work",
          model: "provider/model",
          agent: "review",
        },
        "/repo",
      ),
    ).toEqual([
      "opencode",
      "run",
      "--pure",
      "--format",
      "json",
      "--dir",
      "/repo",
      "--model",
      "provider/model",
      "--agent",
      "review",
      "--",
      "do work",
    ]);
  });

  test("CLI parses flags only before -- so prompt text after it cannot mutate flags", async () => {
    const { flagArgsBeforeSeparator } = await import("../src/cli");
    // `exec -- --backend codex --json say hi`: everything after -- is prompt.
    const flags = flagArgsBeforeSeparator(["exec", "--", "--backend", "codex", "--json", "say", "hi"]);
    expect(flags).toEqual(["exec"]);
    expect(flags.includes("--json")).toBe(false);
    expect(flags.includes("--backend")).toBe(false);
    // No separator: all args are flag args (normal case).
    expect(flagArgsBeforeSeparator(["exec", "--backend", "codex", "hi"])).toEqual(["exec", "--backend", "codex", "hi"]);
  });

  test("delimits the prompt with -- so a flag-like prompt cannot smuggle backend flags", () => {
    const cmd = buildOpenCodeCommand({ backend: "opencode", prompt: "--dangerously-skip-permissions" }, "/repo");
    const sep = cmd.indexOf("--");
    expect(sep).toBeGreaterThan(-1);
    // The prompt sits AFTER the -- terminator, so opencode reads it as the message.
    expect(cmd.slice(sep + 1)).toEqual(["--dangerously-skip-permissions"]);
    expect(cmd[cmd.length - 1]).toBe("--dangerously-skip-permissions");
  });

  test("parses text, cost, tokens, and errors from JSONL", () => {
    const parsed = parseOpenCodeJsonl(
      [
        JSON.stringify({ type: "text", part: { type: "text", text: "hello" } }),
        JSON.stringify({ type: "step_finish", part: { type: "step-finish", cost: 0.25, tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 4 } } } }),
        JSON.stringify({ type: "error", error: { data: { message: "bad model" } } }),
      ].join("\n"),
    );

    expect(parsed.output).toBe("hello");
    expect(parsed.cost).toBe(0.25);
    expect(parsed.tokens).toBe(17);
    expect(parsed.error).toBe("bad model");
  });

  test("parses real OpenCode message.part.updated text shape", () => {
    const parsed = parseOpenCodeJsonl(
      JSON.stringify({
        type: "message.part.updated",
        properties: {
          part: {
            type: "text",
            text: "assistant answer",
            time: { end: Date.now() },
          },
        },
      }),
    );

    expect(parsed.output).toBe("assistant answer");
  });

  test("dedupes OpenCode text collected from both top-level and properties part", () => {
    const parsed = parseOpenCodeJsonl(
      JSON.stringify({
        type: "message.part.updated",
        part: {
          type: "text",
          text: "assistant answer",
        },
        properties: {
          part: {
            type: "text",
            text: "assistant answer",
            time: { end: Date.now() },
          },
        },
      }),
    );

    expect(parsed.output).toBe("assistant answer");
  });


  test("does not treat lifecycle-only JSON as assistant output", () => {
    const parsed = parseOpenCodeJsonl(
      JSON.stringify({
        type: "step_start",
        part: { type: "step-start", sessionID: "s" },
      }),
    );

    expect(parsed.output).toBe("");
    expect(parsed.error).toBe(null);
  });

  test("rejects depth greater than one before spawning", () => {
    expect(nextOpenCodeEnv({ HEADLESS_DEPTH: "1" }).HEADLESS_DEPTH).toBe("2");
    expect(() => nextOpenCodeEnv({ HEADLESS_DEPTH: "2" })).toThrow("HEADLESS_DEPTH=2");
  });

  test("forwards provider API keys (incl. ZHIPU for z.ai/GLM) but not unrelated secrets", () => {
    const env = nextOpenCodeEnv({
      PATH: "/bin",
      HOME: "/home/test",
      ANTHROPIC_API_KEY: "ak",
      ZHIPU_API_KEY: "zk",
      OPENAI_API_KEY: "ok",
      OPENCODE_API_KEY: "zenk",
      MY_FAKE_TOKEN: "secret",
    });
    // opencode auto-detects <PROVIDER>_API_KEY; env-based auth must reach it.
    expect(env.ANTHROPIC_API_KEY).toBe("ak");
    expect(env.ZHIPU_API_KEY).toBe("zk");
    expect(env.OPENAI_API_KEY).toBe("ok");
    expect(env.OPENCODE_API_KEY).toBe("zenk");
    expect(env.MY_FAKE_TOKEN).toBeUndefined();
  });

  test("does NOT forward control-plane OPENCODE_* vars that could override read-only denies", () => {
    const env = nextOpenCodeEnv({
      PATH: "/bin",
      HOME: "/home/test",
      OPENCODE_API_KEY: "zenk",
      OPENCODE_PERMISSION: '{"bash":{"*":"allow"},"edit":"allow","write":"allow"}',
      OPENCODE_CONFIG: "/tmp/evil.json",
      OPENCODE_CONFIG_DIR: "/tmp/evil",
      OPENCODE_AUTH_CONTENT: "{}",
      OPENCODE_DISABLE_GLOBAL_CONFIG: "1",
    });
    // The credential passes through; every control-plane var is stripped, so a
    // caller cannot re-enable write/bash after our injected denies.
    expect(env.OPENCODE_API_KEY).toBe("zenk");
    expect(env.OPENCODE_PERMISSION).toBeUndefined();
    expect(env.OPENCODE_CONFIG).toBeUndefined();
    expect(env.OPENCODE_CONFIG_DIR).toBeUndefined();
    expect(env.OPENCODE_AUTH_CONTENT).toBeUndefined();
    expect(env.OPENCODE_DISABLE_GLOBAL_CONFIG).toBeUndefined();
    // Our own read-only config is still injected (and wins).
    expect(env.OPENCODE_CONFIG_CONTENT).toBe(OPENCODE_CONFIG_CONTENT);
  });

  test("injects read-only OpenCode config denies into child env", () => {
    const env = nextOpenCodeEnv({ PATH: "/bin", HOME: "/home/test", MY_FAKE_TOKEN: "secret" });
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT || "{}");

    expect(env.OPENCODE_CONFIG_CONTENT).toBe(OPENCODE_CONFIG_CONTENT);
    expect(env.MY_FAKE_TOKEN).toBeUndefined();
    expect(config.tools).toMatchObject({
      bash: false,
      edit: false,
      write: false,
      patch: false,
      webfetch: false,
    });
    expect(config.permission).toMatchObject({
      "*": "deny",
      edit: "deny",
      write: "deny",
      patch: "deny",
      webfetch: "deny",
    });
    expect(config.permission.bash).toEqual({ "*": "deny" });
  });
});

describe("grok and generic backend helpers", () => {
  test("builds real Grok single-turn streaming JSON command", () => {
    expect(buildGrokCommand({ backend: "grok-build", prompt: "do work", mode: "read-only" }, "/repo")).toEqual([
      "grok",
      "--single",
      "do work",
      "--cwd",
      "/repo",
      "--output-format",
      "streaming-json",
      "--permission-mode",
      "plan",
    ]);
  });

  test("parses Grok streaming JSON text and errors", () => {
    const ok = parseGrokJsonl(
      [
        JSON.stringify({ type: "response.output_text.delta", delta: "hel" }),
        JSON.stringify({ type: "response.output_text.delta", delta: "lo", usage: { input_tokens: 2, output_tokens: 3 } }),
      ].join("\n"),
    );
    expect(ok.output).toBe("hello");
    expect(ok.tokens).toBe(5);

    const failed = parseGrokJsonl(JSON.stringify({ type: "error", message: "balance exhausted" }));
    expect(failed.output).toBe("");
    expect(failed.error).toBe("balance exhausted");
  });

  test("parses generic Claude/Codex JSONL text, cost, and tokens", () => {
    const parsed = parseGenericAgentJson(
      [
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
        JSON.stringify({ total_cost_usd: 0.01, usage: { input_tokens: 4, output_tokens: 5 } }),
      ].join("\n"),
    );

    expect(parsed.output).toBe("hi");
    expect(parsed.cost).toBe(0.01);
    expect(parsed.tokens).toBe(9);
  });

  test("does not double-emit string content fields", () => {
    const parsed = parseGenericAgentJson(JSON.stringify({ content: "hello" }));

    expect(parsed.output).toBe("hello");
  });

  test("parser is bounded against a malicious backend (depth + byte caps)", async () => {
    const { collectText, textCollector, appendText } = await import("../src/backends/json");

    // Depth cap: a string buried past the recursion limit is not collected (and
    // does not overflow the stack), while a shallow one still is.
    let deep: unknown = { text: "too-deep" };
    for (let i = 0; i < 100; i += 1) deep = { message: deep };
    const deepOut = textCollector();
    expect(() => collectText(deep, deepOut)).not.toThrow();
    expect(deepOut.join(" ")).not.toContain("too-deep");
    const shallowOut = textCollector();
    collectText({ message: { text: "shallow" } }, shallowOut);
    expect(shallowOut.join(" ")).toContain("shallow");

    // Byte cap: once the collector exceeds its budget, further text is dropped.
    const capped = textCollector();
    appendText(capped, "a".repeat(9_000_000));
    appendText(capped, "b".repeat(100));
    expect(capped.length).toBe(1);
    expect(capped.join("").includes("b")).toBe(false);
  });

  test("token accounting prefers explicit total over split subset fields", () => {
    expect(tokenCount({ total_tokens: 10, input_tokens: 4, output_tokens: 5, cache: { read: 100, write: 100 } })).toBe(10);
    expect(tokenCount({ input_tokens: 4, output_tokens: 5, reasoning_tokens: 2, cache: { read: 100, write: 100 } })).toBe(11);
    expect(tokenCount({ input_tokens: 4, cached_input_tokens: 100, output_tokens: 5, reasoning_output_tokens: 2 })).toBe(11);
  });

  test("parses Claude stream-json fixture without duplicating final result", () => {
    const parsed = parseClaudeStreamJson(
      [
        JSON.stringify({ type: "system", subtype: "init" }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "pong" }] } }),
        JSON.stringify({ type: "result", subtype: "success", result: "pong", total_cost_usd: 0.02, usage: { input_tokens: 7, output_tokens: 3 } }),
      ].join("\n"),
    );

    expect(parsed.output).toBe("pong");
    expect(parsed.cost).toBe(0.02);
    expect(parsed.tokens).toBe(10);
  });

  test("parses Codex JSONL fixture through the named parser", () => {
    const parsed = parseCodexJson(
      [
        JSON.stringify({ type: "thread.started", id: "t" }),
        JSON.stringify({ type: "agent_message", message: "pong" }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 8, output_tokens: 2 } }),
      ].join("\n"),
    );

    expect(parsed.output).toBe("pong");
    expect(parsed.tokens).toBe(10);
  });

  test("parses live-captured Codex 0.143.0 JSONL golden item.completed agent message", () => {
    const parsed = parseCodexJson(
      [
        JSON.stringify({ type: "thread.started", thread_id: "019f4881-a3cc-75a1-92fb-acb3ca72c6ef" }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "PONG" } }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 11233, cached_input_tokens: 2432, output_tokens: 6, reasoning_output_tokens: 0 } }),
      ].join("\n"),
    );

    expect(parsed.output).toBe("PONG");
    expect(parsed.tokens).toBe(11239);
    expect(parsed.error).toBe(null);
  });

  test("parses Codex turn and item errors", () => {
    const parsed = parseCodexJson(
      [
        JSON.stringify({ type: "item.completed", item: { type: "error", message: "tool failed" } }),
        JSON.stringify({ type: "turn.failed", error: { message: "turn failed" } }),
      ].join("\n"),
    );

    expect(parsed.error).toContain("tool failed");
    expect(parsed.error).toContain("turn failed");
  });

  test("builds Claude Code read-only stream-json command", () => {
    expect(backendAdapters["claude-code"].buildCommand({ backend: "claude-code", prompt: "inspect" }, "/repo")).toEqual([
      "claude",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--allowedTools",
      "Read,Grep,Glob,LS",
    ]);
  });

  test("passes model to Claude Code command and ignores unmapped agent", () => {
    expect(backendAdapters["claude-code"].buildCommand({ backend: "claude-code", prompt: "inspect", model: "claude-model", agent: "review" }, "/repo")).toEqual([
      "claude",
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--allowedTools",
      "Read,Grep,Glob,LS",
      "--model",
      "claude-model",
    ]);
  });

  test("builds Codex read-only sandbox command", () => {
    expect(backendAdapters.codex.buildCommand({ backend: "codex", prompt: "inspect" }, "/repo")).toEqual([
      "codex",
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "-",
    ]);
  });

  test("passes model to Codex exec command and ignores unmapped agent", () => {
    expect(backendAdapters.codex.buildCommand({ backend: "codex", prompt: "inspect", model: "gpt-5", agent: "review" }, "/repo")).toEqual([
      "codex",
      "exec",
      "--model",
      "gpt-5",
      "--json",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "-",
    ]);
  });

  test("allowlists base env, backend credentials, and HEADLESS markers only", () => {
    const env = buildBackendEnv(backendAdapters.codex, {
      PATH: "/bin",
      HOME: "/home/test",
      TMPDIR: "/tmp",
      TERM: "xterm",
      SHELL: "/bin/zsh",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      USER: "dev",
      LOGNAME: "dev",
      OPENAI_API_KEY: "ok",
      HEADLESS_DEPTH: "1",
      MY_FAKE_TOKEN: "secret",
    });

    expect(env).toMatchObject({
      PATH: "/bin",
      HOME: "/home/test",
      TMPDIR: "/tmp",
      TERM: "xterm",
      SHELL: "/bin/zsh",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      // USER/LOGNAME must pass through — macOS Keychain auth (Claude Code) needs them.
      USER: "dev",
      LOGNAME: "dev",
      OPENAI_API_KEY: "ok",
      HEADLESS_DEPTH: "1",
    });
    expect(env.MY_FAKE_TOKEN).toBeUndefined();
  });
});

describe("runner process behavior", () => {
  test("passes pure OpenCode command and recursion env to child", async () => {
    const bin = mkdtempSync(join(tmpdir(), "headless-bin-"));
    // Capture outside cwd: the macOS sandbox denies writes to the project dir.
    const capture = join(mkdtempSync(join(tmpdir(), "headless-cap-")), "capture.json");
    await writeExecutable(
      join(bin, "opencode"),
      `#!/usr/bin/env bun
await Bun.write(${JSON.stringify(capture)}, JSON.stringify({
  argv: process.argv.slice(2),
  depth: process.env.HEADLESS_DEPTH,
  parent: process.env.HEADLESS_PARENT_BACKEND,
}));
console.log(JSON.stringify({ type: "text", part: { type: "text", text: "ok" } }));
`,
    );
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.HEADLESS_DEPTH = "1";

    const result = await exec({ backend: "opencode", prompt: "inspect", cwd: bin });
    const captured = JSON.parse(await Bun.file(capture).text());

    expect(result.ok).toBe(true);
    expect(result.output).toBe("ok");
    expect(captured.argv).toContain("--pure");
    expect(captured.argv).toContain("--format");
    expect(captured.argv).toContain("json");
    expect(captured.argv).toContain("--dir");
    expect(captured.argv).toContain(bin);
    expect(captured.depth).toBe("2");
    expect(captured.parent).toBe("opencode");
  });

  test("does not pass unrelated secret env vars to child process", async () => {
    const bin = mkdtempSync(join(tmpdir(), "headless-bin-"));
    // Capture outside cwd: the macOS sandbox denies writes to the project dir.
    const capture = join(mkdtempSync(join(tmpdir(), "headless-cap-")), "env-capture.json");
    await writeExecutable(
      join(bin, "opencode"),
      `#!/usr/bin/env bun
await Bun.write(${JSON.stringify(capture)}, JSON.stringify({
  fake: process.env.MY_FAKE_TOKEN ?? null,
  path: process.env.PATH ?? null,
  home: process.env.HOME ?? null,
  headless: process.env.HEADLESS_DEPTH ?? null,
  config: process.env.OPENCODE_CONFIG_CONTENT ?? null,
}));
console.log(JSON.stringify({ type: "text", part: { type: "text", text: "ok" } }));
`,
    );
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.HOME = bin;
    process.env.HEADLESS_DEPTH = "1";
    process.env.MY_FAKE_TOKEN = "secret";

    const result = await exec({ backend: "opencode", prompt: "inspect", cwd: bin });
    const captured = JSON.parse(await Bun.file(capture).text());

    expect(result.ok).toBe(true);
    expect(captured.fake).toBe(null);
    expect(captured.path).toContain(bin);
    expect(captured.home).toBe(bin);
    expect(captured.headless).toBe("2");
    expect(JSON.parse(captured.config).permission.edit).toBe("deny");
  });

  test("returns timedOut when child exceeds timeout", async () => {
    const bin = mkdtempSync(join(tmpdir(), "headless-bin-"));
    await writeExecutable(
      join(bin, "opencode"),
      `#!/usr/bin/env bun
await Bun.sleep(2000);
`,
    );
    process.env.PATH = `${bin}:${process.env.PATH}`;

    const result = await exec({ backend: "opencode", prompt: "slow", cwd: bin, timeoutMs: 50 });

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  test("returns ok false for non-zero exit and preserves error output", async () => {
    const bin = mkdtempSync(join(tmpdir(), "headless-bin-"));
    await writeExecutable(
      join(bin, "opencode"),
      `#!/usr/bin/env bun
console.log(JSON.stringify({ type: "error", error: { message: "backend failed" } }));
process.exit(7);
`,
    );
    process.env.PATH = `${bin}:${process.env.PATH}`;

    const result = await exec({ backend: "opencode", prompt: "fail", cwd: bin });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(7);
    expect(result.output).toBe("backend failed");
  });

  test("returns ok false when OpenCode only emits lifecycle events", async () => {
    const bin = mkdtempSync(join(tmpdir(), "headless-bin-"));
    await writeExecutable(
      join(bin, "opencode"),
      `#!/usr/bin/env bun
console.log(JSON.stringify({ type: "step_start", part: { type: "step-start", sessionID: "s" } }));
`,
    );
    process.env.PATH = `${bin}:${process.env.PATH}`;

    const result = await exec({ backend: "opencode", prompt: "no answer", cwd: bin });

    expect(result.ok).toBe(false);
    expect(result.output).toBe("No assistant output was produced by the backend.");
  });

  test("rejects unsupported write mode before spawning a backend", async () => {
    const bin = mkdtempSync(join(tmpdir(), "headless-bin-"));
    const marker = join(bin, "spawned");
    await writeExecutable(
      join(bin, "opencode"),
      `#!/bin/sh
touch ${JSON.stringify(marker)}
printf '{"type":"text","part":{"text":"should not run"}}\\n'
`,
    );
    process.env.PATH = `${bin}:${process.env.PATH}`;

    const result = await exec({ backend: "opencode", prompt: "write", cwd: bin, mode: "write" });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("does not support write mode");
    expect(existsSync(marker)).toBe(false);
  });

  gitTest("write mode requires a git repository before spawning a backend", async () => {
    const bin = mkdtempSync(join(tmpdir(), "headless-bin-"));
    const cwd = mkdtempSync(join(tmpdir(), "headless-non-git-"));
    const marker = join(cwd, "spawned");
    await writeExecutable(
      join(bin, "grok"),
      `#!/bin/sh
touch ${JSON.stringify(marker)}
printf '{"type":"response.output_text.delta","delta":"should not run"}\\n'
`,
    );
    process.env.PATH = `${bin}:${process.env.PATH}`;

    const result = await exec({ backend: "grok-build", prompt: "write", cwd, mode: "write" });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("write mode requires a git repository");
    expect(existsSync(marker)).toBe(false);
  });

  gitTest("write mode runs in an ephemeral worktree and returns a structured diff", async () => {
    const repo = initGitRepo();
    const bin = mkdtempSync(join(tmpdir(), "headless-bin-"));
    const beforeList = gitWorktreeList(repo);
    await writeExecutable(
      join(bin, "grok"),
      `#!/usr/bin/env bun
await Bun.write("agent-change.txt", "from agent\\n");
console.log(JSON.stringify({ type: "response.output_text.delta", delta: "done" }));
`,
    );
    process.env.PATH = `${bin}:${process.env.PATH}`;

    const result = await exec({ backend: "grok-build", prompt: "write", cwd: repo, mode: "write" });
    const afterList = gitWorktreeList(repo);
    const remainingBranches = runGitStrict(["branch", "--list", "headless/write/*", "--format=%(refname:short)"], repo);

    expect(result.ok).toBe(true);
    expect(result.output).toBe("done");
    expect(result.diff?.files).toEqual(["agent-change.txt"]);
    expect(result.diff?.status).toContain("?? agent-change.txt");
    expect(result.diff?.patch).toContain("+from agent");
    expect(result.worktreeBranch?.startsWith("headless/write/grok-build-")).toBe(true);
    expect(existsSync(join(repo, "agent-change.txt"))).toBe(false);
    expect(afterList).toBe(beforeList);
    expect(remainingBranches.stdout.trim()).toBe("");
  });

  gitTest("write mode captures a diff even when the backend fails", async () => {
    const repo = initGitRepo();
    const bin = mkdtempSync(join(tmpdir(), "headless-bin-"));
    await writeExecutable(
      join(bin, "grok"),
      `#!/usr/bin/env bun
await Bun.write("failed-change.txt", "from failed worker\\n");
console.log(JSON.stringify({ type: "error", message: "backend failed" }));
process.exit(7);
`,
    );
    process.env.PATH = `${bin}:${process.env.PATH}`;

    const result = await exec({ backend: "grok-build", prompt: "write", cwd: repo, mode: "write" });

    expect(result.ok).toBe(false);
    expect(result.output).toBe("backend failed");
    expect(result.exitCode).toBe(7);
    expect(result.diff?.files).toEqual(["failed-change.txt"]);
    expect(result.diff?.patch).toContain("+from failed worker");
    expect(existsSync(join(repo, "failed-change.txt"))).toBe(false);
  });

  darwinTest("read-only sandbox preserves stdin passthrough for stdin-based backends", async () => {
    const bin = mkdtempSync(join(tmpdir(), "headless-bin-"));
    // Capture must live OUTSIDE cwd: the sandbox denies writes to the project
    // dir (cwd=bin), so the fake backend writes its capture to a separate dir.
    const outDir = mkdtempSync(join(tmpdir(), "headless-capture-"));
    const capture = join(outDir, "stdin-capture.txt");
    await writeExecutable(
      join(bin, "claude"),
      `#!/usr/bin/env bun
const input = await Bun.readableStreamToText(Bun.stdin.stream());
await Bun.write(${JSON.stringify(capture)}, input);
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "stdin ok" }] } }));
`,
    );
    process.env.PATH = `${bin}:${process.env.PATH}`;

    const result = await exec({ backend: "claude-code", prompt: "hello through stdin", cwd: bin });

    expect(result.ok).toBe(true);
    expect(result.output).toBe("stdin ok");
    expect(readFileSync(capture, "utf8")).toBe("hello through stdin\n");
  });
});

describe("macOS OS sandbox", () => {
  darwinTest("probe confirms sandbox-exec denies writes on darwin", () => {
    expect(probeDarwinSandboxWriteDenial().ok).toBe(true);
  });

  darwinTest("buildDarwinReadOnlyProfile denies project writes, credential access, and interactive shells", () => {
    const cwd = mkdtempSync(join(tmpdir(), "headless-sandbox-cwd-"));
    const cred = mkdtempSync(join(tmpdir(), "headless-sandbox-cred-"));
    const profile = buildDarwinReadOnlyProfile({
      workdir: cwd,
      denyWriteRoots: [cred],
      denyReadRoots: [cred],
    });

    expect(profile).toContain("(allow default)");
    expect(profile).toContain(`(deny file-write* (subpath ${JSON.stringify(realpathSync.native(cwd))}))`);
    expect(profile).toContain(`(deny file-write* (subpath ${JSON.stringify(realpathSync.native(cred))}))`);
    expect(profile).toContain(`(deny file-read* (subpath ${JSON.stringify(realpathSync.native(cred))}))`);
    expect(profile).toContain('(deny process-exec (literal "/bin/bash"))');
    expect(profile).toContain('(deny process-exec (literal "/bin/zsh"))');
    // /bin/sh stays allowed so backends can shell out for legitimate work.
    expect(profile).not.toContain('(deny process-exec (literal "/bin/sh"))');
  });

  darwinTest("sandbox profile denies project-dir writes while allowing writes elsewhere", () => {
    const cwd = mkdtempSync(join(tmpdir(), "headless-sandbox-cwd-"));
    const scratch = mkdtempSync(join(tmpdir(), "headless-sandbox-scratch-"));
    const denied = join(cwd, "should-fail");
    const allowed = join(scratch, "should-pass");
    const profile = writeDarwinSandboxProfile({ workdir: cwd });

    try {
      const denyResult = spawnSync(DARWIN_SANDBOX_EXEC, ["-f", profile, "/usr/bin/perl", "-e", `open my $fh, '>', ${JSON.stringify(denied)} or die $!; print $fh "x";`], {
        cwd,
        encoding: "utf8",
      });
      const allowResult = spawnSync(DARWIN_SANDBOX_EXEC, ["-f", profile, "/usr/bin/perl", "-e", `open my $fh, '>', ${JSON.stringify(allowed)} or die $!; print $fh "x";`], {
        cwd,
        encoding: "utf8",
      });

      expect(denyResult.status).not.toBe(0);
      expect(existsSync(denied)).toBe(false);
      expect(allowResult.status).toBe(0);
      expect(readFileSync(allowed, "utf8")).toBe("x");
    } finally {
      cleanupSandboxProfile(profile);
    }
  });

  darwinTest("maybeWrapWithSandbox wraps non-self-sandboxed read-only commands and skips codex", () => {
    const cwd = mkdtempSync(join(tmpdir(), "headless-sandbox-cwd-"));
    const wrapped = maybeWrapWithSandbox(["echo", "ok"], { backend: "opencode", prompt: "ok" }, backendAdapters.opencode, cwd);
    const codex = maybeWrapWithSandbox(["codex", "exec", "-"], { backend: "codex", prompt: "ok" }, backendAdapters.codex, cwd);

    try {
      expect(wrapped.sandboxed).toBe(true);
      expect(wrapped.cmd[0]).toBe(DARWIN_SANDBOX_EXEC);
      expect(codex.sandboxed).toBe(false);
      expect(codex.cmd).toEqual(["codex", "exec", "-"]);
    } finally {
      wrapped.cleanup();
      codex.cleanup();
    }
  });
});

describe("native ledger runtime", () => {
  test("creates a .headless session with initial session_started entry", () => {
    const cwd = mkdtempSync(join(tmpdir(), "headless-ledger-"));
    const session = getOrCreateSession({ cwd, sessionId: "test-session" });

    expect(session.ledgerPath).toBe(join(cwd, ".headless", "sessions", "test-session", "ledger.jsonl"));
    expect(existsSync(session.ledgerPath)).toBe(true);

    const events = readLedger(session);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("session_started");
    expect(events[0].sessionId).toBe("test-session");
  });

  test("appends valid JSONL events and reads recent context in order", () => {
    const cwd = mkdtempSync(join(tmpdir(), "headless-ledger-"));
    const session = getOrCreateSession({ cwd, sessionId: "recent-session" });
    appendNote({ cwd, sessionId: session.sessionId, text: "first" });
    recordArtifact({ cwd, sessionId: session.sessionId, kind: "test_report", title: "Tests", summary: "passed", status: "passed" });

    const lines = readFileSync(session.ledgerPath, "utf8").trim().split("\n");
    expect(lines.every((line) => JSON.parse(line).schema === "v1")).toBe(true);

    const context = getReadContext({ cwd, sessionId: session.sessionId, view: "recent", limit: 2 });
    expect(context.entries.map((entry) => entry.type)).toEqual(["note", "artifact"]);
  });

  test("redacts secrets before hashing ledger note content", () => {
    const cwd = mkdtempSync(join(tmpdir(), "headless-ledger-"));
    const session = getOrCreateSession({ cwd, sessionId: "redaction-session" });

    appendNote({ cwd, sessionId: session.sessionId, text: "token sk-ABCDEFGHIJKLMNOP1234 should not persist" });
    const events = readLedger(session);
    const note = events.at(-1);

    expect(note?.content).toBe("token [REDACTED_OPENAI_KEY] should not persist");
    expect(note?.content).not.toContain("sk-ABCDEFGHIJKLMNOP1234");
    expect(note?.meta?.redacted).toBe(true);
    expect(note?.meta?.truncated).toBe(false);
    expect(readLedger(session).at(-1)?.hash).toBe(note?.hash);
  });

  test("redacts secrets in non-content fields (artifact summary/evidence), not just content", () => {
    const cwd = mkdtempSync(join(tmpdir(), "headless-ledger-"));
    const session = getOrCreateSession({ cwd, sessionId: "deep-redaction-session" });

    recordArtifact({
      cwd,
      sessionId: session.sessionId,
      kind: "patch_summary",
      title: "Deploy",
      summary: "prod key sk-ABCDEFGHIJKLMNOP1234 must not persist",
      status: "passed",
      evidence: ["also github_pat_ABCDEFGHIJKLMNOPQRSTUV token"],
    });
    const event = readLedger(session).at(-1);
    const serialized = JSON.stringify(event);

    // No raw secret anywhere in the stored event (content, artifact.*, meta.*).
    expect(serialized).not.toContain("sk-ABCDEFGHIJKLMNOP1234");
    expect(serialized).not.toContain("github_pat_ABCDEFGHIJKLMNOPQRSTUV");
    expect(event?.artifact?.summary).toContain("[REDACTED_OPENAI_KEY]");
    expect(JSON.stringify(event?.artifact?.evidence)).toContain("[REDACTED_GITHUB_PAT]");
    expect(event?.meta?.redacted).toBe(true);
    // Redacted form still verifies (redaction happened before hashing).
    expect(() => readLedger(session)).not.toThrow();
  });

  test("redaction covers additional real secret formats", async () => {
    const { redactAndTruncate } = await import("../src/runtime/redaction");
    expect(redactAndTruncate("key AIzaSyD-ABCDEFGHIJKLMNOPQRSTUVWXYZ01234").text).toContain("[REDACTED_GOOGLE_API_KEY]");
    expect(redactAndTruncate("github_pat_11ABCDEFG0abcdefghijklmnop").text).toContain("[REDACTED_GITHUB_PAT]");
    expect(redactAndTruncate("xapp-1-A000BBB-123456789").text).toContain("[REDACTED_SLACK_APP_TOKEN]");
    expect(redactAndTruncate("Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1l").text).toContain("[REDACTED_BASIC_AUTH]");
  });

  test("truncates oversized ledger content with metadata", () => {
    const cwd = mkdtempSync(join(tmpdir(), "headless-ledger-"));
    const session = getOrCreateSession({ cwd, sessionId: "truncate-session" });

    appendNote({ cwd, sessionId: session.sessionId, text: "x".repeat(20_010) });
    const note = readLedger(session).at(-1);

    expect(note?.content?.length).toBeLessThan(20_050);
    expect(note?.content).toContain("[TRUNCATED 10 chars]");
    expect(note?.meta?.redacted).toBe(false);
    expect(note?.meta?.truncated).toBe(true);
  });

  test("appends a verifiable seq/hash chain", () => {
    const cwd = mkdtempSync(join(tmpdir(), "headless-ledger-"));
    const session = getOrCreateSession({ cwd, sessionId: "hash-session" });
    appendNote({ cwd, sessionId: session.sessionId, text: "first" });

    const events = readLedger(session);
    expect(events[0].seq).toBe(1);
    expect(events[0].prevHash).toBe(null);
    expect(typeof events[0].hash).toBe("string");
    expect(events[1].seq).toBe(2);
    expect(events[1].prevHash).toBe(events[0].hash);
  });

  test("rejects tampered ledger events with a clear integrity error", () => {
    const cwd = mkdtempSync(join(tmpdir(), "headless-ledger-"));
    const session = getOrCreateSession({ cwd, sessionId: "tamper-session" });
    appendNote({ cwd, sessionId: session.sessionId, text: "original" });

    const lines = readFileSync(session.ledgerPath, "utf8").trim().split("\n");
    const tampered = JSON.parse(lines[1]);
    tampered.content = "changed";
    lines[1] = JSON.stringify(tampered);
    writeFileSync(session.ledgerPath, `${lines.join("\n")}\n`, "utf8");

    expect(() => readLedger(session)).toThrow(LedgerIntegrityError);
  });

  test("with HEADLESS_LEDGER_KEY, a recomputed (plain-SHA) forged chain is rejected — tamper-proof", async () => {
    const { createHash } = await import("crypto");
    const prev = process.env.HEADLESS_LEDGER_KEY;
    process.env.HEADLESS_LEDGER_KEY = "out-of-band-secret";
    try {
      const cwd = mkdtempSync(join(tmpdir(), "headless-ledger-"));
      const session = getOrCreateSession({ cwd, sessionId: "hmac-session" });
      appendNote({ cwd, sessionId: session.sessionId, text: "original action" });
      // A clean read verifies with the key.
      expect(() => readLedger(session)).not.toThrow();

      // Attacker edits the note and re-forges the chain the only way they can
      // without the key: a plain SHA-256 over the event.
      const lines = readFileSync(session.ledgerPath, "utf8").trim().split("\n");
      const ev = JSON.parse(lines[1]);
      ev.content = "covered up";
      const { hash: _drop, ...withoutHash } = ev;
      ev.hash = createHash("sha256").update(JSON.stringify(withoutHash)).digest("hex");
      lines[1] = JSON.stringify(ev);
      writeFileSync(session.ledgerPath, `${lines.join("\n")}\n`, "utf8");

      // Verified WITH the key, the plain-SHA forgery does not match the HMAC.
      expect(() => readLedger(session)).toThrow(LedgerIntegrityError);
    } finally {
      if (prev === undefined) delete process.env.HEADLESS_LEDGER_KEY;
      else process.env.HEADLESS_LEDGER_KEY = prev;
    }
  });

  const UNCHAINED_EVENT = JSON.stringify({
    schema: "v1",
    id: "forged",
    timestamp: 1,
    sessionId: "x",
    type: "note",
    source: "attacker",
    content: "forged event with no seq/prevHash/hash",
  });

  test("rejects an unchained event as a leading line", () => {
    const cwd = mkdtempSync(join(tmpdir(), "headless-ledger-"));
    const session = getOrCreateSession({ cwd, sessionId: "unchained-prefix" });
    writeFileSync(session.ledgerPath, `${UNCHAINED_EVENT}\n${readFileSync(session.ledgerPath, "utf8")}`, "utf8");
    expect(() => readLedger(session)).toThrow(LedgerIntegrityError);
  });

  test("rejects an unchained event appended as a trailing line", () => {
    const cwd = mkdtempSync(join(tmpdir(), "headless-ledger-"));
    const session = getOrCreateSession({ cwd, sessionId: "unchained-tail" });
    writeFileSync(session.ledgerPath, `${readFileSync(session.ledgerPath, "utf8")}${UNCHAINED_EVENT}\n`, "utf8");
    expect(() => readLedger(session)).toThrow(LedgerIntegrityError);
  });

  test("rejects a fully-unchained (forged) ledger — no hashing required to bypass was the hole", () => {
    const cwd = mkdtempSync(join(tmpdir(), "headless-ledger-"));
    const session = getOrCreateSession({ cwd, sessionId: "forged-session" });
    // Attacker replaces the entire ledger with chain-less lines. Previously this
    // passed verification (all events looked "legacy"); it must now fail.
    writeFileSync(session.ledgerPath, `${UNCHAINED_EVENT}\n${UNCHAINED_EVENT}\n${UNCHAINED_EVENT}\n`, "utf8");
    expect(() => readLedger(session)).toThrow(LedgerIntegrityError);
  });

  test("rejects a dot-only sessionId that would redirect the ledger out of sessions/", () => {
    const cwd = mkdtempSync(join(tmpdir(), "headless-ledger-"));
    const session = getOrCreateSession({ cwd, sessionId: ".." });
    // ".." is rejected and a fresh session id is generated instead, so the
    // ledger stays under sessions/<generated-id>, not redirected to .headless/.
    expect(session.sessionId).not.toBe("..");
    expect(session.sessionDir).toContain(join("sessions", session.sessionId));
  });

  test("derives task state from handoff, handled note, artifact, and finality entries", () => {
    const cwd = mkdtempSync(join(tmpdir(), "headless-ledger-"));
    const session = getOrCreateSession({ cwd, sessionId: "state-session" });
    const handoff = appendEvent(session, {
      type: "handoff",
      source: "opencode",
      content: "review this",
      handoff: {
        from: "opencode",
        to: "headless_workers",
        reason: "review",
        ask: "review this",
      },
    });
    appendNote({ cwd, sessionId: session.sessionId, text: "handled", handlesHandoffId: handoff.id });
    recordArtifact({ cwd, sessionId: session.sessionId, kind: "patch_summary", title: "Patch", summary: "done", status: "passed" });
    appendEvent(session, {
      type: "finality_proposal",
      source: "opencode",
      content: "complete",
    });

    const state = getTaskState({ cwd, sessionId: session.sessionId });
    expect(state.taskBoard.activeCount).toBe(0);
    expect(state.taskBoard.handledCount).toBe(1);
    expect(state.taskBoard.lanes[0].handledBy).toHaveLength(1);
    expect(state.artifacts[0].kind).toBe("patch_summary");
    expect(state.finality.proposals).toHaveLength(1);
  });
});

describe("orchestration", () => {
  test("headless_run records lifecycle events and final normalized result", async () => {
    const bin = mkdtempSync(join(tmpdir(), "headless-bin-"));
    await writeExecutable(
      join(bin, "opencode"),
      `#!/usr/bin/env bun
console.log(JSON.stringify({ type: "text", part: { text: "worker ok" } }));
`,
    );
    process.env.PATH = `${bin}:${process.env.PATH}`;

    const { result, session } = await headlessRun({ backend: "opencode", prompt: "inspect", cwd: bin, sessionId: "run-session" });
    const events = readLedger(session);

    expect(result.ok).toBe(true);
    expect(events.map((event) => event.type)).toContain("run_started");
    expect(events.map((event) => event.type)).toContain("worker_spawned");
    expect(events.at(-1)?.type).toBe("headless_result");
    expect(events.at(-1)?.result?.output).toBe("worker ok");
  });

  test("headless_run redacts bearer tokens from ledger result output", async () => {
    const bin = mkdtempSync(join(tmpdir(), "headless-bin-"));
    await writeExecutable(
      join(bin, "opencode"),
      `#!/usr/bin/env bun
console.log(JSON.stringify({ type: "text", part: { text: "token Bearer abcdefghijklmnop123456" } }));
`,
    );
    process.env.PATH = `${bin}:${process.env.PATH}`;

    const { result, session } = await headlessRun({ backend: "opencode", prompt: "inspect", cwd: bin, sessionId: "redacted-output-session" });
    const last = readLedger(session).at(-1);

    expect(result.output).toContain("Bearer abcdefghijklmnop123456");
    expect(last?.content).toBe("token Bearer [REDACTED_BEARER_TOKEN]");
    expect(last?.result?.output).toBe("token Bearer [REDACTED_BEARER_TOKEN]");
    expect(JSON.stringify(last)).not.toContain("abcdefghijklmnop123456");
  });

  test("failed backend run records failed result", async () => {
    const bin = mkdtempSync(join(tmpdir(), "headless-bin-"));
    await writeExecutable(
      join(bin, "opencode"),
      `#!/usr/bin/env bun
console.log(JSON.stringify({ type: "error", error: { message: "backend failed" } }));
process.exit(3);
`,
    );
    process.env.PATH = `${bin}:${process.env.PATH}`;

    const { result, session } = await headlessRun({ backend: "opencode", prompt: "fail", cwd: bin, sessionId: "failed-session" });
    const last = readLedger(session).at(-1);

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(last?.type).toBe("headless_result");
    expect(last?.meta?.status).toBe("failed");
  });

  test("timeout records timedOut true", async () => {
    const bin = mkdtempSync(join(tmpdir(), "headless-bin-"));
    await writeExecutable(
      join(bin, "opencode"),
      `#!/usr/bin/env bun
await Bun.sleep(2000);
`,
    );
    process.env.PATH = `${bin}:${process.env.PATH}`;

    const { result, session } = await headlessRun({ backend: "opencode", prompt: "slow", cwd: bin, sessionId: "timeout-session", timeoutMs: 50 });
    const last = readLedger(session).at(-1);

    expect(result.timedOut).toBe(true);
    expect(last?.result?.timedOut).toBe(true);
    expect(last?.meta?.status).toBe("timed_out");
  });

  test("exitCode null is not classified as a successful run", () => {
    expect(isSuccessfulRun({ timedOut: false, parseError: null, noAssistantOutput: false, exitCode: null })).toBe(false);
    expect(isSuccessfulRun({ timedOut: false, parseError: null, noAssistantOutput: false, exitCode: 0 })).toBe(true);
  });

  test("headless_deliberate fans out and returns collected outputs", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "headless-deliberate-"));
    await writeExecutable(
      join(cwd, "opencode"),
      `#!/usr/bin/env bun
console.log(JSON.stringify({ type: "text", part: { text: "deliberated" } }));
`,
    );
    process.env.PATH = `${cwd}:${process.env.PATH}`;

    const result = await deliberate({
      cwd,
      sessionId: "deliberate-session",
      question: "List capabilities",
      backends: ["opencode"],
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].backend).toBe("opencode");
    expect(result.results[0].output).toBe("deliberated");
    expect(getTaskState({ cwd, sessionId: "deliberate-session" }).taskBoard.handledCount).toBe(1);
  });

  test("headless_deliberate leaves the handoff active when every worker fails", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "headless-deliberate-failed-"));
    await writeExecutable(
      join(cwd, "opencode"),
      `#!/bin/sh
printf '{"type":"error","error":{"message":"worker failed"}}\\n'
exit 2
`,
    );
    process.env.PATH = `${cwd}:${process.env.PATH}`;

    const result = await deliberate({
      cwd,
      sessionId: "deliberate-failed-session",
      question: "List capabilities",
      backends: ["opencode"],
    });

    const state = getTaskState({ cwd, sessionId: "deliberate-failed-session" });
    const events = readLedger(result.session);
    const failureNote = events.at(-1);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].ok).toBe(false);
    expect(state.taskBoard.activeCount).toBe(1);
    expect(state.taskBoard.handledCount).toBe(0);
    expect(failureNote?.content).toContain("Deliberation failed");
    expect(failureNote?.handlesHandoffId).toBeUndefined();
  });

  gitTest("headless_run records write diffs as ledger artifacts", async () => {
    const repo = initGitRepo();
    const bin = mkdtempSync(join(tmpdir(), "headless-bin-"));
    await writeExecutable(
      join(bin, "grok"),
      `#!/usr/bin/env bun
await Bun.write("ledger-change.txt", "from ledger\\n");
console.log(JSON.stringify({ type: "response.output_text.delta", delta: "done" }));
`,
    );
    process.env.PATH = `${bin}:${process.env.PATH}`;

    const { result, session } = await headlessRun({ backend: "grok-build", prompt: "write", cwd: repo, mode: "write", sessionId: "write-artifact-session" });
    const artifact = readLedger(session).find((event) => event.artifact?.kind === "write_diff");

    expect(result.ok).toBe(true);
    expect(result.diff?.files).toEqual(["ledger-change.txt"]);
    expect(artifact?.type).toBe("artifact");
    expect(artifact?.artifact?.evidence).toEqual(["ledger-change.txt"]);
    expect(artifact?.meta?.patch).toContain("+from ledger");
  });
});

describe("ledger durability and concurrency", () => {
  test("concurrent cross-process appends stay atomic and keep the hash chain intact", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "headless-concurrent-"));
    const sessionId = "concurrent-session";
    getOrCreateSession({ cwd, sessionId });

    const srcIndex = new URL("../src/index.ts", import.meta.url).pathname;
    const fixture = join(cwd, "writer.ts");
    await Bun.write(
      fixture,
      `import { appendNote } from ${JSON.stringify(srcIndex)};\n` +
        `const cwd = process.argv[2]!;\n` +
        `const sid = process.argv[3]!;\n` +
        `const n = Number(process.argv[4]!);\n` +
        `for (let i = 0; i < n; i += 1) appendNote({ cwd, sessionId: sid, text: \`p\${process.pid}-\${i}\` });\n`,
    );

    const children = 6;
    const perChild = 15;
    const procs = Array.from({ length: children }, () =>
      Bun.spawn(["bun", fixture, cwd, sessionId, String(perChild)], { cwd, stdout: "ignore", stderr: "inherit" }),
    );
    for (const proc of procs) await proc.exited;

    const events = readLedger(getOrCreateSession({ cwd, sessionId }));
    expect(events.length).toBe(1 + children * perChild);
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
  });
});

describe("cli argument parsing", () => {
  test("getPrompt skips the value of known value-taking flags", () => {
    expect(getPrompt(["exec", "--cwd", "./x"])).toBeUndefined();
    expect(getPrompt(["exec", "--backend", "opencode", "--model", "gpt-4"])).toBeUndefined();
    expect(getPrompt(["exec", "--backend", "grok", "do work"])).toBe("do work");
    expect(getPrompt(["exec", "--cwd", "./x", "do work"])).toBe("do work");
  });

  test("getPrompt treats everything after -- as the prompt verbatim", () => {
    expect(getPrompt(["exec", "--", "--not-a-flag", "and more"])).toBe("--not-a-flag and more");
  });

  test("getPrompt ignores the subcommand token", () => {
    expect(getPrompt(["exec"])).toBeUndefined();
    expect(getPrompt(["run", "hello"])).toBe("hello");
  });

  test("parseIntegerArg returns undefined when absent and parses when valid", () => {
    expect(parseIntegerArg(["exec", "--timeout-ms", "1500"], "--timeout-ms")).toBe(1500);
    expect(parseIntegerArg(["exec", "hi"], "--timeout-ms")).toBeUndefined();
  });

  test("CLI reports missing value flags without a stack trace", async () => {
    const result = await runCli(["exec", "--backend"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Missing value for --backend.");
    expect(result.stderr).not.toContain("at ");
  });

  test("CLI rejects extra unquoted prompt positionals by name", async () => {
    const result = await runCli(["exec", "first", "second", "third"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unexpected extra prompt arguments: second third");
    expect(result.stderr).not.toContain("at ");
  });

  test("CLI reports unsupported backend as one friendly line", async () => {
    const result = await runCli(["exec", "--backend", "nope", "prompt"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toContain("Unsupported --backend nope.");
    expect(result.stderr).not.toContain("at ");
  });
});

async function writeExecutable(path: string, content: string) {
  await Bun.write(path, content);
  chmodSync(path, 0o755);
}

function initGitRepo() {
  const repo = mkdtempSync(join(tmpdir(), "headless-repo-"));
  expect(runGitStrict(["init"], repo).ok).toBe(true);
  writeFileSync(join(repo, ".gitignore"), ".headless/\n", "utf8");
  writeFileSync(join(repo, "README.md"), "base\n", "utf8");
  expect(runGitStrict(["add", ".gitignore", "README.md"], repo).ok).toBe(true);
  expect(runGitStrict(["-c", "user.email=headless@example.test", "-c", "user.name=Headless Test", "commit", "-m", "init"], repo).ok).toBe(true);
  return repo;
}

function gitWorktreeList(repo: string) {
  const list = runGitStrict(["worktree", "list", "--porcelain"], repo);
  expect(list.ok).toBe(true);
  return list.stdout;
}

async function runCli(args: string[]) {
  const proc = Bun.spawn(["bun", new URL("../src/cli.ts", import.meta.url).pathname, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    Bun.readableStreamToText(proc.stdout),
    Bun.readableStreamToText(proc.stderr),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}
