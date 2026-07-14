import { describe, expect, test } from "bun:test";
import { RunRequestSchema, RunResultSchema } from "../src/contracts/run";
import { MAX_DAEMON_MESSAGE_BYTES } from "../src/daemon/protocol";

describe("v0.2 wire bounds", () => {
  test("bounds prompts by UTF-8 bytes below the daemon envelope", () => {
    const base = { backend: "fixture", projectRoot: process.cwd() };
    const request = RunRequestSchema.parse({ ...base, prompt: "x".repeat(500_000) });
    expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(MAX_DAEMON_MESSAGE_BYTES);
    expect(() => RunRequestSchema.parse({ ...base, prompt: "😀".repeat(130_000) })).toThrow(/UTF-8 bytes/i);
  });

  test("keeps a maximum practical result within one bounded daemon response", () => {
    const result = RunResultSchema.parse({
      status: "succeeded",
      error: null,
      backend: "fixture",
      output: "o".repeat(262_144),
      stderr: "e".repeat(262_144),
      diagnostics: { format: "fixture", malformedEvents: 0, ignoredEvents: 0, messages: [] },
      exitCode: 0,
      signal: null,
      usage: { input: 1, output: 1, reasoning: null, cached: null, providerTotal: 2 },
      cost: { amountUsd: null, source: "unknown", pricingId: null, observedRequests: 0 },
      containment: { requirement: "required", enforced: true, platform: "linux", mechanism: "test", probe: "ok", isolatedHome: true, credentialsIsolated: true, network: "denied", unsafe: false },
      durationMs: 1,
      sessionId: null,
      jobId: "job",
      diff: { patch: "p".repeat(262_144), status: "s".repeat(65_536), files: Array.from({ length: 256 }, (_, index) => `file-${index}`), baseCommit: null, candidateCommit: null, resultingCommit: null },
      commit: null,
      truncation: { stdout: true, stderr: true, output: true, events: false, artifacts: false, diff: true },
    });
    const framed = JSON.stringify({ version: 2, id: crypto.randomUUID(), ok: true, result: { result } });
    expect(Buffer.byteLength(framed)).toBeLessThan(MAX_DAEMON_MESSAGE_BYTES);
    expect(() => RunResultSchema.parse({ ...result, output: "x".repeat(270_001) })).toThrow();
  });
});
