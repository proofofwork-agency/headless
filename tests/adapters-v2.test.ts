import { describe, expect, test } from "bun:test";
import {
  getAdapter,
  listAdapters,
  registerAdapter,
  unregisterAdapter,
  type BackendAdapter,
} from "../src/backends/registry";
import { parseGrokJsonl } from "../src/backends/grok";
import {
  normalizeTokenUsage,
  parseCodexJson,
  parseGenericAgentJson,
  tokenCount,
} from "../src/backends/json";
import { parseOpenCodeJsonl } from "../src/backends/opencode";

describe("v0.2 adapter parser fixtures", () => {
  test("preserves identical provider deltas when they have no stable event id", () => {
    const fixture = [
      JSON.stringify({ type: "response.output_text.delta", delta: "same" }),
      JSON.stringify({ type: "response.output_text.delta", delta: "same" }),
    ].join("\n");

    const parsed = parseGrokJsonl(fixture);
    expect(parsed.output).toBe("samesame");
    expect(parsed.diagnostics).toMatchObject({ format: "grok-streaming-json", malformedEvents: 0 });
  });

  test("deduplicates only events carrying the same stable provider event id", () => {
    const duplicate = parseGenericAgentJson([
      JSON.stringify({ event_id: "evt-1", delta: "same" }),
      JSON.stringify({ event_id: "evt-1", delta: "same" }),
    ].join("\n"));
    const distinct = parseGenericAgentJson([
      JSON.stringify({ event_id: "evt-1", delta: "same" }),
      JSON.stringify({ event_id: "evt-2", delta: "same" }),
    ].join("\n"));

    expect(duplicate.output).toBe("same");
    expect(duplicate.diagnostics?.ignoredEvents).toBe(1);
    expect(distinct.output).toBe("same\nsame");
  });

  test("rejects malformed OpenCode JSONL instead of trusting raw text", () => {
    const parsed = parseOpenCodeJsonl([
      "not-json assistant-looking text",
      JSON.stringify({ type: "text", part: { type: "text", text: "valid" } }),
    ].join("\n"));

    expect(parsed.output).toBe("valid");
    expect(parsed.output).not.toContain("not-json");
    expect(parsed.error).toContain("Malformed OpenCode JSONL");
    expect(parsed.diagnostics).toMatchObject({
      format: "opencode-jsonl",
      malformedEvents: 1,
    });
    expect(parsed.diagnostics.messages[0]).toContain("line 1");
  });

  test("selects one canonical OpenCode part without globally deduplicating text", () => {
    const mirrored = parseOpenCodeJsonl(JSON.stringify({
      type: "message.part.updated",
      part: { type: "text", text: "answer" },
      properties: { part: { type: "text", text: "answer", time: { end: 1 } } },
    }));
    const repeated = parseOpenCodeJsonl([
      JSON.stringify({ type: "text", part: { type: "text", text: "answer" } }),
      JSON.stringify({ type: "text", part: { type: "text", text: "answer" } }),
    ].join("\n"));

    expect(mirrored.output).toBe("answer");
    expect(repeated.output).toBe("answer\nanswer");
  });

  test("preserves usage dimensions and excludes cached/reasoning subsets from legacy totals", () => {
    const usage = normalizeTokenUsage({
      input_tokens: 10,
      output_tokens: 5,
      reasoning_output_tokens: 2,
      cached_input_tokens: 3,
    });
    const codex = parseCodexJson(JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        reasoning_output_tokens: 2,
        cached_input_tokens: 3,
      },
    }));

    expect(usage).toEqual({ input: 10, output: 5, reasoning: 2, cached: 3, providerTotal: null });
    expect(tokenCount(usage)).toBe(15);
    expect(codex.tokens).toBe(15);
    expect(codex.usage).toEqual(usage);
    expect(tokenCount({ ...usage, total_tokens: 21 })).toBe(21);
    expect(tokenCount({ input_tokens: -1, output_tokens: 2.5 })).toBe(null);
  });
});

describe("v0.2 adapter registry", () => {
  test("publishes honest capability metadata for every built-in", () => {
    for (const id of ["opencode", "claude-code", "codex", "grok-build"]) {
      const adapter = getAdapter(id);
      expect(adapter).toBeDefined();
      expect(adapter?.capabilities.structuredOutput).toBe(true);
      expect(adapter?.capabilities.write).toBe(adapter?.metadata.canWrite);
    }
  });

  test("registers, replaces, retrieves, lists, and unregisters extensions", () => {
    const first = fixtureAdapter("fixture-provider");
    const replacement = { ...first, stdinPrompt: true };

    registerAdapter(first);
    expect(getAdapter(first.id)).toBe(first);
    expect(listAdapters().map((adapter) => adapter.id)).toContain(first.id);
    expect(() => registerAdapter(first)).toThrow("already registered");
    expect(registerAdapter(replacement, { replace: true })).toBe(replacement);
    expect(getAdapter(first.id)).toBe(replacement);
    expect(unregisterAdapter(first.id)).toBe(true);
    expect(getAdapter(first.id)).toBeUndefined();
  });

  test("does not allow extensions to replace or unregister built-ins", () => {
    const opencode = getAdapter("opencode")!;
    expect(() => registerAdapter(opencode, { replace: true })).toThrow("built-in");
    expect(unregisterAdapter("opencode")).toBe(false);
    expect(getAdapter("opencode")).toBe(opencode);
  });
});

function fixtureAdapter(id: string): BackendAdapter {
  return {
    id,
    metadata: {
      id,
      aliases: [],
      promptDelivery: "stdin",
      timeoutMs: 1_000,
      maxDepth: null,
      canRead: true,
      canWrite: false,
    },
    capabilities: {
      write: false,
      streaming: true,
      structuredOutput: true,
      nativeResume: false,
      cancellation: false,
      tools: false,
      effort: false,
      brokerCompatible: true,
    },
    security: {
      outerContainmentRequired: true,
      strictAuth: "credential-free",
      disablesProjectConfig: true,
      disablesHooks: true,
      disablesMcp: true,
      disablesSkills: true,
    },
    probe: {
      versionCommand: ["fixture", "--version"],
      helpCommand: ["fixture", "--help"],
      requiredHelpFragments: [],
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    },
    stdinPrompt: true,
    credentialPrefixes: [],
    buildCommand: () => ["fixture"],
    parse: (stdout) => ({ output: stdout, cost: null, tokens: null, error: null }),
  };
}
