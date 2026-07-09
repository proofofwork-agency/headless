import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
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
import { isSuccessfulRun } from "../src/runner/simple";

const originalEnv = { ...process.env };

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
      "do work",
    ]);
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

  test("token accounting prefers explicit total over split subset fields", () => {
    expect(tokenCount({ total_tokens: 10, input_tokens: 4, output_tokens: 5, cache: { read: 100, write: 100 } })).toBe(10);
    expect(tokenCount({ input_tokens: 4, output_tokens: 5, reasoning_tokens: 2, cache: { read: 100, write: 100 } })).toBe(11);
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
      OPENAI_API_KEY: "ok",
      HEADLESS_DEPTH: "1",
    });
    expect(env.MY_FAKE_TOKEN).toBeUndefined();
  });
});

describe("runner process behavior", () => {
  test("passes pure OpenCode command and recursion env to child", async () => {
    const bin = mkdtempSync(join(tmpdir(), "headless-bin-"));
    const capture = join(bin, "capture.json");
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
    const capture = join(bin, "env-capture.json");
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
      `#!/bin/sh
sleep 2
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
      `#!/bin/sh
printf '{"type":"error","error":{"message":"backend failed"}}\\n'
exit 7
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
      `#!/bin/sh
printf '{"type":"step_start","part":{"type":"step-start","sessionID":"s"}}\\n'
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

  test("allows legacy unchained ledger entries only before the chained prefix starts", () => {
    const cwd = mkdtempSync(join(tmpdir(), "headless-ledger-"));
    const session = getOrCreateSession({ cwd, sessionId: "legacy-prefix-session" });
    const chained = readFileSync(session.ledgerPath, "utf8");
    const legacy = JSON.stringify({
      schema: "v1",
      id: "legacy",
      timestamp: Date.now(),
      sessionId: session.sessionId,
      type: "note",
      source: "test",
      content: "legacy prefix",
    });
    writeFileSync(session.ledgerPath, `${legacy}\n${chained}`, "utf8");

    expect(readLedger(session).map((event) => event.id)).toEqual(["legacy", expect.any(String)]);
  });

  test("rejects legacy unchained ledger entries appended after a chained event", () => {
    const cwd = mkdtempSync(join(tmpdir(), "headless-ledger-"));
    const session = getOrCreateSession({ cwd, sessionId: "legacy-tail-session" });
    const legacy = JSON.stringify({
      schema: "v1",
      id: "legacy-tail",
      timestamp: Date.now(),
      sessionId: session.sessionId,
      type: "note",
      source: "test",
      content: "legacy tail",
    });
    writeFileSync(session.ledgerPath, `${readFileSync(session.ledgerPath, "utf8")}${legacy}\n`, "utf8");

    expect(() => readLedger(session)).toThrow(LedgerIntegrityError);
  });

  test("append after a legacy prefix numbers the chained event so it round-trips", () => {
    const cwd = mkdtempSync(join(tmpdir(), "headless-ledger-"));
    const session = getOrCreateSession({ cwd, sessionId: "legacy-append-session" });
    const chained = readFileSync(session.ledgerPath, "utf8");
    const legacy = JSON.stringify({
      schema: "v1",
      id: "legacy",
      timestamp: Date.now(),
      sessionId: session.sessionId,
      type: "note",
      source: "test",
      content: "legacy prefix",
    });
    // Ledger becomes: [legacy(unchained), session_started(seq 1)].
    writeFileSync(session.ledgerPath, `${legacy}\n${chained}`, "utf8");

    const appended = appendNote({ cwd, sessionId: session.sessionId, text: "after legacy" });
    // seq counts only chained events (session_started=1), so this is 2 — not 3.
    expect(appended.seq).toBe(2);
    const events = readLedger(session);
    expect(events.map((event) => event.id)).toEqual(["legacy", expect.any(String), appended.id]);
    expect(events.at(-1)?.content).toBe("after legacy");
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
      `#!/bin/sh
printf '{"type":"text","part":{"text":"worker ok"}}\\n'
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

  test("failed backend run records failed result", async () => {
    const bin = mkdtempSync(join(tmpdir(), "headless-bin-"));
    await writeExecutable(
      join(bin, "opencode"),
      `#!/bin/sh
printf '{"type":"error","error":{"message":"backend failed"}}\\n'
exit 3
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
      `#!/bin/sh
sleep 2
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
      `#!/bin/sh
printf '{"type":"text","part":{"text":"deliberated"}}\\n'
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
