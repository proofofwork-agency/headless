import { describe, expect, test } from "bun:test";
import {
  daemonStopExitWasGraceful,
  successfulDeliberationBackends,
  validateCouncilRecord,
  validateDeliberationResponse,
  validateLedgerContext,
  validateObserverProjection,
} from "../scripts/gate-b-mcp-smoke";

const containment = {
  requirement: "required",
  enforced: true,
  platform: "darwin",
  mechanism: "darwin-seatbelt-read",
  probe: null,
  isolatedHome: true,
  credentialsIsolated: true,
  network: "native-direct-unrestricted",
  credentialAccess: "backend-native",
  unsafe: false,
};

describe("Gate B MCP smoke evidence", () => {
  test("accepts the shipped authenticated daemon stop SIGTERM without masking other exits", () => {
    expect(daemonStopExitWasGraceful(143, null)).toBe(true);
    expect(daemonStopExitWasGraceful(null, "SIGTERM")).toBe(true);
    expect(daemonStopExitWasGraceful(0, null)).toBe(true);
    expect(daemonStopExitWasGraceful(1, null)).toBe(false);
  });

  test("accepts only successful contained native-login deliberation jobs", () => {
    const jobs = validateDeliberationResponse({ jobs: [
      job("job-claude", "claude-code", "succeeded"),
      job("job-opencode", "opencode", "succeeded"),
      job("job-grok", "grok-build", "failed", "RATE_LIMITED"),
    ] });

    expect(successfulDeliberationBackends(jobs)).toEqual(["claude-code", "opencode"]);
    jobs[1]!.result.containment.network = "broker-only";
    expect(successfulDeliberationBackends(jobs)).toEqual(["claude-code"]);
  });

  test("requires every council phase and attributable votes while preserving either decision polarity", () => {
    const council = councilRecord();
    expect(validateCouncilRecord(council, ["claude-code", "opencode"], "integration:lead-codex-g1").decision?.approved).toBe(true);
    expect(() => validateCouncilRecord(
      { ...council, voteJobs: ["vote-claude"] },
      ["claude-code", "opencode"],
      "integration:lead-codex-g1",
    ))
      .toThrow("vote phase did not create one job per participant");
    expect(validateCouncilRecord(
      { ...council, votes: council.votes.slice(0, 1), decision: { approved: false, reason: "1/2 valid votes" } },
      ["claude-code", "opencode"],
      "integration:lead-codex-g1",
    ).decision?.approved).toBe(false);
    expect(() => validateCouncilRecord(
      { ...council, decision: { approved: false, reason: "no quorum" } },
      ["claude-code", "opencode"],
      "integration:lead-codex-g1",
      true,
    ))
      .toThrow("Council rejected");
  });

  test("requires the ledger artifact and every trace job id", () => {
    const ledger = {
      entries: [{
        type: "artifact",
        artifact: {
          title: "Gate B trace",
          evidence: ["deliberation:job-claude", "council:proposal-claude"],
        },
      }],
    };
    expect(validateLedgerContext(ledger, "Gate B trace", ["job-claude", "proposal-claude"])).toBeUndefined();
    expect(() => validateLedgerContext(ledger, "Gate B trace", ["missing-job"])).toThrow("omitted job ids");
  });

  test("matches the TUI observer event projection and requires terminal completion", () => {
    const observer = {
      events: [completion("job-claude"), completion("proposal-claude")],
      nextCursor: 3,
      cursorExpired: false,
    };
    expect(validateObserverProjection(observer, ["job-claude", "proposal-claude"])).toEqual({ matchedJobs: 2, terminalJobs: 2 });
    expect(() => validateObserverProjection({ ...observer, events: observer.events.slice(0, 1) }, ["job-claude", "proposal-claude"]))
      .toThrow("observer projection omitted job ids");
  });

  test("refuses to launch the live MCP gate without explicit opt-in", async () => {
    const env = { ...process.env };
    delete env.HEADLESS_GATE_B_SMOKE;
    const child = Bun.spawn([process.execPath, new URL("../scripts/gate-b-mcp-smoke.ts", import.meta.url).pathname], {
      cwd: new URL("..", import.meta.url).pathname,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      Bun.readableStreamToText(child.stdout),
      Bun.readableStreamToText(child.stderr),
      child.exited,
    ]);
    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("HEADLESS_GATE_B_SMOKE=1");
  });
});

function job(jobId: string, backend: string, status: string, errorCode: string | null = null) {
  return {
    jobId,
    backend,
    result: {
      status,
      error: errorCode ? { code: errorCode, message: errorCode, retryable: true } : null,
      backend,
      output: "evidence",
      stderr: "",
      diagnostics: { format: "test", malformedEvents: 0, ignoredEvents: 0, messages: [] },
      exitCode: status === "succeeded" ? 0 : 1,
      signal: null,
      usage: { input: 1, output: 1, reasoning: null, cached: null, providerTotal: 2 },
      cost: { amountUsd: 0, source: "provider", pricingId: null, observedRequests: 1 },
      containment: { ...containment },
      durationMs: 1,
      sessionId: null,
      jobId,
      diff: null,
      commit: null,
      truncation: { stdout: false, stderr: false, output: false, events: false, artifacts: false, diff: false },
    },
  };
}

function councilRecord() {
  return {
    council: {
      id: "council-1",
      phase: "decision",
      participants: ["claude-code", "opencode"],
      principal: "integration:lead-codex-g1",
    },
    proposalJobs: ["proposal-claude", "proposal-opencode"],
    executionJobs: ["execution-claude", "execution-opencode"],
    reviewJobs: ["review-claude", "review-opencode"],
    voteJobs: ["vote-claude", "vote-opencode"],
    votes: [
      { agent: "claude-code", jobId: "vote-claude", references: ["review-opencode"] },
      { agent: "opencode", jobId: "vote-opencode", references: ["review-claude"] },
    ],
    decision: { approved: true, reason: "2/2 attributable votes approved the reviewed candidate." },
  };
}

function completion(jobId: string) {
  return {
    version: 2 as const,
    eventId: `completion:${jobId}`,
    jobId,
    sessionId: null,
    sequence: 1,
    timestamp: 1,
    redacted: true as const,
    kind: "completion" as const,
    result: job(jobId, "opencode", "succeeded").result,
  };
}
