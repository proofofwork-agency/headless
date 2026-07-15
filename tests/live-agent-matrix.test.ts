import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  documentedBackendSkip,
  matrixCompleteness,
  mcpHostForBackend,
  validateCouncilRecord,
  validateSessionTurnEnvelope,
  type MatrixCheck,
} from "../scripts/live-agent-matrix";

function check(name: string, status: MatrixCheck["status"]): MatrixCheck {
  return { name, layer: "test", status, detail: "fixture", durationMs: 0 };
}

function council(approved = true) {
  const participants = ["opencode", "codex"];
  return {
    council: { phase: "decision", participants },
    proposalJobs: ["p1", "p2"],
    executionJobs: ["e1", "e2"],
    reviewJobs: ["r1", "r2"],
    voteJobs: ["v1", "v2"],
    votes: [
      { agent: "opencode" },
      { agent: "codex" },
    ],
    decision: { approved, reason: approved ? "2/2 approved." : "Council finality failed: grounded vote rejected." },
  };
}

function sessionEnvelope(overrides: Record<string, unknown> = {}) {
  const result = {
    status: "succeeded",
    output: "ONE",
    jobId: "job-1",
    sessionId: "session-1",
  };
  return {
    session: {
      id: "session-1",
      backend: "opencode",
      state: "completed",
      nativeSessionId: "ses_live_opencode",
      replay: false,
      lastJobId: "job-1",
      result,
    },
    job: {
      id: "job-1",
      sessionId: "session-1",
      state: "succeeded",
      result,
    },
    replay: { truncated: false, bytes: 0 },
    result,
    ...overrides,
  };
}

describe("live agent matrix contracts", () => {
  test("requires both named execs, session multi-turn, and real council finality", () => {
    const complete = [
      check("exec:opencode", "passed"),
      check("exec:codex", "passed"),
      check("session.multi-turn", "passed"),
      check("council.run", "passed"),
    ];
    expect(matrixCompleteness(complete)).toEqual({ complete: true, missing: [] });
    expect(matrixCompleteness(complete.map((entry) => entry.name === "council.run" ? { ...entry, status: "skipped" } : entry))).toEqual({
      complete: false,
      missing: ["council.run"],
    });
  });

  test("accepts only stable structured/documented skips from the live backends", () => {
    expect(documentedBackendSkip("codex", { error: { code: "RATE_LIMITED", message: "bounded" } })).toContain("RATE_LIMITED");
    expect(documentedBackendSkip("claude-code", {
      error: { code: "NATIVE_AUTH_UNAVAILABLE", message: "Failed to authenticate. API Error: 401 Invalid authentication credentials" },
    })).toContain("keychain-only");
    expect(documentedBackendSkip("grok-build", {
      error: {
        code: "BACKEND_UNSUPPORTED",
        message: "Grok isolation attestation failed before provider access: Grok inspect did not prove project trust is disabled.",
      },
    })).toContain("attestation");
    expect(documentedBackendSkip("claude-code", { error: { code: "PROCESS_ERROR", message: "OAuth session expired and could not be refreshed" } })).toBeNull();
    expect(documentedBackendSkip("claude-code", { error: { code: "PROCESS_ERROR", message: "401 Invalid authentication credentials" } })).toBeNull();
    expect(documentedBackendSkip("codex", { error: { code: "PROCESS_ERROR", message: "429 from an unexpected layer" } })).toBeNull();
    expect(documentedBackendSkip("grok-build", {
      error: { code: "POLICY_DENIED", message: "Grok isolation attestation failed before provider access: Grok inspect did not prove project trust is disabled." },
    })).toBeNull();
    expect(documentedBackendSkip("grok-build", { error: { code: "BACKEND_UNSUPPORTED", message: "unrelated unsupported backend" } })).toBeNull();
  });

  test("accepts the actual OpenCode completed session envelope and stable native resume identity", () => {
    const first = sessionEnvelope();
    expect(validateSessionTurnEnvelope(first, { sessionId: "session-1", backend: "opencode" })).toBeNull();

    const resumed = sessionEnvelope({
      replay: { truncated: false, bytes: 42 },
      result: { ...(first.result as Record<string, unknown>), output: "TWO" },
    });
    expect(validateSessionTurnEnvelope(resumed, {
      sessionId: "session-1",
      backend: "opencode",
      nativeSessionId: "ses_live_opencode",
    })).toBeNull();
  });

  test("rejects incomplete or replayed session evidence instead of treating exit zero as success", () => {
    const envelope = sessionEnvelope();
    expect(validateSessionTurnEnvelope({
      ...envelope,
      session: { ...(envelope.session as Record<string, unknown>), state: "idle" },
    }, { sessionId: "session-1", backend: "opencode" })).toContain("completed");
    expect(validateSessionTurnEnvelope({
      ...envelope,
      session: { ...(envelope.session as Record<string, unknown>), nativeSessionId: "ses_changed" },
    }, {
      sessionId: "session-1",
      backend: "opencode",
      nativeSessionId: "ses_live_opencode",
    })).toContain("identity");
  });

  test("validates every council phase, both votes, and exit consistency", () => {
    expect(validateCouncilRecord(council(), ["opencode", "codex"], 0)).toBeNull();
    expect(validateCouncilRecord(council(false), ["opencode", "codex"], 1)).toBeNull();
    expect(validateCouncilRecord({ ...council(), reviewJobs: ["r1"] }, ["opencode", "codex"], 0)).toContain("reviewJobs");
    expect(validateCouncilRecord({ ...council(), decision: { approved: false, reason: "Council execution failed: transport" } }, ["opencode", "codex"], 1)).toContain("execution failed");
    expect(validateCouncilRecord(council(), ["opencode", "codex"], 1)).toContain("exited 1");
  });

  test("maps backend identifiers to foreground MCP hosts", () => {
    expect(mcpHostForBackend("claude-code")).toBe("claude");
    expect(mcpHostForBackend("grok-build")).toBe("grok");
    expect(mcpHostForBackend("opencode")).toBe("opencode");
  });

  test("refuses to launch any live work without the exact opt-in", async () => {
    const env = { ...process.env };
    delete env.HEADLESS_LIVE_MATRIX;
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../scripts/live-agent-matrix.ts")], {
      cwd: join(import.meta.dir, ".."),
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("Live agent matrix is disabled");
  });
});
