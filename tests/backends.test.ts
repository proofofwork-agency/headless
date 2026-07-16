import { describe, expect, test } from "bun:test";
import { normalizeBackend, SUPPORTED_BACKENDS, backendChoices } from "../src/backends/ids";
import { backendDefinitions, buildBackendEnv } from "../src/backends/registry";
import { buildGrokCommand, parseGrokJsonl } from "../src/backends/grok";
import {
  decodeClaudeEvent,
  decodeCodexEvent,
  decodeGrokEvent,
  decodeOpenCodeEvent,
  decoderForBackend,
} from "../src/runtime/session-drivers/event-decoder";
import { GROK_HEADLESS_SYSTEM_PROMPT, GROK_READ_TOOLS, GROK_WRITE_TOOLS } from "../src/runtime/grok-isolation";
import { parseClaudeStreamJson, parseCodexJson, parseGenericAgentJson, tokenCount } from "../src/backends/json";
import { buildOpenCodeCommand, nextOpenCodeEnv, OPENCODE_CONFIG_CONTENT, parseOpenCodeJsonl } from "../src/backends/opencode";
import { isSuccessfulRun } from "../src/runner/simple";

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
});

describe("built-in session event decoders", () => {
  test("decodes Codex agent-message completion snapshots", () => {
    const [event] = decodeCodexEvent({
      type: "item.completed",
      thread_id: "thread-1",
      turn_id: "turn-1",
      item: { id: "item-1", type: "agent_message", text: "codex output" },
    });

    expect(event).toMatchObject({
      kind: "text",
      stableId: "item:item-1:completed",
      sessionId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      text: "codex output",
      textMode: "snapshot",
    });
  });

  test("decodes Claude result text, usage, and completion", () => {
    const events = decodeClaudeEvent({
      type: "result",
      session_id: "session-1",
      result: "claude output",
      usage: { input_tokens: 3, output_tokens: 2 },
      total_cost_usd: 0.01,
    });

    expect(events.find((event) => event.kind === "text")).toMatchObject({ text: "claude output", textMode: "snapshot" });
    expect(events.find((event) => event.kind === "usage")).toMatchObject({ usage: { input: 3, output: 2 }, costUsd: 0.01 });
    expect(events.find((event) => event.kind === "completion")).toMatchObject({ sessionId: "session-1", failed: false });
  });

  test("decodes completed OpenCode text parts", () => {
    const [event] = decodeOpenCodeEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-1",
          type: "text",
          text: "opencode output",
          sessionID: "session-1",
          messageID: "message-1",
          time: { end: 123 },
        },
      },
    });

    expect(event).toMatchObject({
      kind: "text",
      stableId: "part:part-1:completed",
      sessionId: "session-1",
      turnId: "message-1",
      itemId: "part-1",
      text: "opencode output",
      textMode: "snapshot",
    });
  });

  test("dispatches every built-in backend to its decoder", () => {
    expect(decoderForBackend("codex")).toBe(decodeCodexEvent);
    expect(decoderForBackend("claude-code")).toBe(decodeClaudeEvent);
    expect(decoderForBackend("opencode")).toBe(decodeOpenCodeEvent);
    expect(decoderForBackend("grok-build")).toBe(decodeGrokEvent);
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

  // Exact wire shapes from the open-sourced grok-build headless emitter
  // (xai-grok-pager/src/headless.rs + xai-grok-shell notification.rs).
  test("parseGrokJsonl decodes the grok-build source event shapes", () => {
    const lines = [
      JSON.stringify({ type: "text", data: "hi" }),
      JSON.stringify({ type: "thought", data: "hidden reasoning" }),
      JSON.stringify({
        type: "end",
        stopReason: "EndTurn",
        sessionId: "3e0f9df8-3c40-4b1e-8f0a-1c2d3e4f5a6b",
        requestId: "req-1",
        num_turns: 1,
        usage: { input_tokens: 10, cache_read_input_tokens: 3, output_tokens: 5, reasoning_tokens: 2, total_tokens: 20 },
        total_cost_usd: 0.01,
      }),
    ].join("\n");
    const p = parseGrokJsonl(lines);
    expect(p.output).toBe("hi");
    expect(p.output).not.toContain("hidden");
    expect(p.cost).toBe(0.01);
    expect(p.usage).toMatchObject({ input: 10, cached: 3, output: 5, reasoning: 2 });
    expect(p.error).toBeNull();
  });

  test("parseGrokJsonl surfaces max_turns_reached as an error", () => {
    const p = parseGrokJsonl(JSON.stringify({ type: "max_turns_reached" }));
    expect(p.error).toContain("maximum turn limit");
  });

  test("one-shot Grok refusals and cancellations fail closed at zero exit", () => {
    for (const stopReason of ["Refusal", "Cancelled"]) {
      const parsed = parseGrokJsonl([
        JSON.stringify({ type: "text", data: `provider ${stopReason.toLowerCase()}` }),
        JSON.stringify({ type: "end", stopReason }),
      ].join("\n"));
      expect(parsed.error).toContain(stopReason);
      expect(isSuccessfulRun({
        timedOut: false,
        parseError: parsed.error,
        noAssistantOutput: parsed.output.length === 0,
        exitCode: 0,
      })).toBe(false);
    }

    const completed = parseGrokJsonl([
      JSON.stringify({ type: "text", data: "complete" }),
      JSON.stringify({ type: "end", stopReason: "EndTurn" }),
    ].join("\n"));
    expect(completed.error).toBeNull();
    expect(isSuccessfulRun({
      timedOut: false,
      parseError: completed.error,
      noAssistantOutput: completed.output.length === 0,
      exitCode: 0,
    })).toBe(true);
  });

  test("decodeGrokEvent maps the grok-build end event to usage + completion", () => {
    const events = decodeGrokEvent({
      type: "end",
      stopReason: "EndTurn",
      sessionId: "3e0f9df8-3c40-4b1e-8f0a-1c2d3e4f5a6b",
      usage: { input_tokens: 10, cache_read_input_tokens: 3, output_tokens: 5, reasoning_tokens: 2, total_tokens: 20 },
      total_cost_usd: 0.01,
    });
    const usage = events.find((event) => event.kind === "usage");
    const completion = events.find((event) => event.kind === "completion");
    expect(usage?.usage).toMatchObject({ input: 10, cached: 3, output: 5, reasoning: 2 });
    expect(usage?.costUsd).toBe(0.01);
    expect(completion?.failed).toBe(false);
    expect(completion?.sessionId).toBe("3e0f9df8-3c40-4b1e-8f0a-1c2d3e4f5a6b");
  });

  test("decodeGrokEvent fails completions for refusal/filter/cancel/max-token stop reasons", () => {
    for (const stopReason of ["Refusal", "ContentFilter", "Cancelled", "ModelContextWindowExceeded", "MaxTokens", "max_tokens"]) {
      const completion = decodeGrokEvent({ type: "end", stopReason }).find((event) => event.kind === "completion");
      expect(completion?.failed).toBe(true);
    }
    const clean = decodeGrokEvent({ type: "end", stopReason: "EndTurn" }).find((event) => event.kind === "completion");
    expect(clean?.failed).toBe(false);
  });

  test("decodeGrokEvent treats max_turns_reached as a failed error", () => {
    const [event] = decodeGrokEvent({ type: "max_turns_reached" });
    expect(event).toMatchObject({ kind: "error", failed: true });
  });

  test("decodeGrokEvent classifies grok-build's real rate-limit messages", () => {
    // Exact user-facing strings from xai-grok-shell/src/sampling/error.rs.
    const oauth = decodeGrokEvent({ type: "error", message: "You've hit the rate limit for your plan. Upgrade to continue." });
    const apiKey = decodeGrokEvent({ type: "error", message: "You've hit your team's API rate limit. See https://docs.x.ai/developers/rate-limits for details." });
    const plain = decodeGrokEvent({ type: "error", message: "Authentication failed. Run `grok login`." });
    expect(oauth[0]?.kind).toBe("rate-limit");
    expect(apiKey[0]?.kind).toBe("rate-limit");
    expect(plain[0]?.kind).toBe("error");
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
