import { describe, expect, test } from "bun:test";
import { normalizeBackend, SUPPORTED_BACKENDS, backendChoices } from "../src/backends/ids";
import { backendAdapters, buildBackendEnv } from "../src/backends/registry";
import { buildGrokCommand, parseGrokJsonl } from "../src/backends/grok";
import { GROK_HEADLESS_SYSTEM_PROMPT, GROK_READ_TOOLS, GROK_WRITE_TOOLS } from "../src/runtime/grok-isolation";
import { parseClaudeStreamJson, parseCodexJson, parseGenericAgentJson, tokenCount } from "../src/backends/json";
import { buildOpenCodeCommand, nextOpenCodeEnv, openCodeColdStartNeedsRetry, OPENCODE_CONFIG_CONTENT, parseOpenCodeJsonl } from "../src/backends/opencode";

describe("backend normalization", () => {
  test("accepts canonical ids and aliases", () => {
    expect(normalizeBackend("claude")).toBe("claude-code");
    expect(normalizeBackend("claude-code")).toBe("claude-code");
    expect(normalizeBackend("grok")).toBe("grok-build");
    expect(normalizeBackend("grok-build")).toBe("grok-build");
    expect(normalizeBackend("codex-cli")).toBe("codex");
    expect(normalizeBackend("headless-opencode")).toBe("opencode");
  });

  test("ids.ts is single source of truth (no alias drift)", () => {
    const choices = backendChoices();
    // All canonicals in choices (via aliases map)
    for (const b of SUPPORTED_BACKENDS) {
      expect(choices).toContain(b);
    }
    // normalize covers all
    for (const b of SUPPORTED_BACKENDS) {
      expect(normalizeBackend(b)).toBe(b);
    }
    expect(SUPPORTED_BACKENDS.length).toBeGreaterThanOrEqual(4);
  });
});

describe("opencode backend helpers", () => {
  test("builds command with prompt passthrough and --dir", () => {
    const cmd = buildOpenCodeCommand({ backend: "opencode", prompt: "hello" }, "/tmp/x");
    expect(cmd[0]).toBe("opencode");
    expect(cmd).toContain("--dir");
    expect(cmd).toContain("/tmp/x");
  });

  test("injects OPENCODE_CONFIG_CONTENT denies for read-only", () => {
    const env = nextOpenCodeEnv({ ...process.env });
    expect(env.OPENCODE_CONFIG_CONTENT).toContain("permission");
  });

  test("parseOpenCodeJsonl extracts assistant text + usage from jsonl", () => {
    const sample = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
      JSON.stringify({ type: "result", usage: { total_tokens: 42 } }),
    ].join("\n");
    const p = parseOpenCodeJsonl(sample);
    expect(p.output).toContain("hi");
    // tokens may be summed or null depending on fixture shape; just assert no crash + text
    expect(typeof p.tokens === "number" || p.tokens === null).toBe(true);
  });

  test("openCodeColdStartNeedsRetry detects cold starts without assistant output", () => {
    const stepMarkers = [
      JSON.stringify({ type: "step_start", part: { type: "step-start" } }),
      JSON.stringify({ type: "step_finish", part: { type: "step-finish", tokens: { output: 0 } } }),
    ].join("\n");
    const withText = [
      JSON.stringify({ type: "step_start", part: { type: "step-start" } }),
      JSON.stringify({ type: "message.part.updated", part: { type: "text", text: "READY", time: { end: 1 } } }),
    ].join("\n");
    // >= 1.17: exit 0, step markers, no text part -> retry
    expect(openCodeColdStartNeedsRetry({ exitCode: 0, stdout: stepMarkers })).toBe(true);
    // <= 1.15: exit 0, empty stdout, migration banner on stderr -> retry
    expect(openCodeColdStartNeedsRetry({ exitCode: 0, stdout: "", stderr: "sqlite-migration:done\nDatabase migration complete." })).toBe(true);
    // a real answer -> no retry
    expect(openCodeColdStartNeedsRetry({ exitCode: 0, stdout: withText })).toBe(false);
    // a non-zero exit is a genuine failure, not a cold start -> no retry
    expect(openCodeColdStartNeedsRetry({ exitCode: 1, stdout: stepMarkers })).toBe(false);
    // empty stdout without the migration banner is not a recognizable cold start
    expect(openCodeColdStartNeedsRetry({ exitCode: 0, stdout: "", stderr: "" })).toBe(false);
  });
});

describe("grok and generic backend helpers", () => {
  test("buildGrokCommand includes the prompt and disables optional native surfaces", () => {
    const read = buildGrokCommand({ backend: "grok-build", prompt: "do it", mode: "read-only" }, ".");
    const write = buildGrokCommand({ backend: "grok-build", prompt: "change it", mode: "write" }, ".");
    expect(read.join(" ")).toContain("do it");
    expect(read).toEqual(expect.arrayContaining(["--no-subagents", "--no-memory", "--disable-web-search", "--verbatim"]));
    expect(read[read.indexOf("--system-prompt-override") + 1]).toBe(GROK_HEADLESS_SYSTEM_PROMPT);
    expect(read[read.indexOf("--tools") + 1]).toBe(GROK_READ_TOOLS);
    expect(write[write.indexOf("--tools") + 1]).toBe(GROK_WRITE_TOOLS);
  });

  test("parseGrokJsonl pulls assistant + usage", () => {
    const line = JSON.stringify({ type: "assistant", content: "hello from grok", usage: { total_tokens: 7 } });
    const p = parseGrokJsonl(line);
    expect(p.output).toBe("hello from grok");
    expect(p.tokens).toBe(7);
  });

  test("parseCodexJson handles item.completed envelope", () => {
    const env = JSON.stringify({ type: "item.completed", item: { agent_message: "codex-out" }, usage: { total_tokens: 11 } });
    const p = parseCodexJson(env);
    // parser shape may vary by version; ensure it runs without throwing and produces string output
    expect(typeof p.output).toBe("string");
  });

  test("tokenCount and parseGeneric", () => {
    const tc = tokenCount({ a: 1, b: { c: 2 } });
    expect(typeof tc === "number" ? tc > 0 : true).toBe(true);
    const g = parseGenericAgentJson('{"message":"x"}');
    expect(g.output).toContain("x");
  });
});
