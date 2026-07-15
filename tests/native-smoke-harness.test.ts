import { describe, expect, test } from "bun:test";
import {
  evaluateNativeSmokeGate,
  nativeSmokeAcceptedLimitation,
  nativeSmokeContainmentSummary,
  nativeSmokeEvidenceValid,
} from "../scripts/native-smoke-evidence";

function smokeResult(backend: string, status: string, acceptedLimitation = false, code: string | null = null) {
  return { backend, status, acceptedLimitation, code };
}

describe("native subscription smoke harness", () => {
  test("accepts only canonical native-direct containment evidence", () => {
    const native = { driverKind: "opencode-session", authProfileFingerprint: "fingerprint" };
    const containment = {
      requirement: "required",
      enforced: true,
      network: "native-direct-unrestricted",
      credentialAccess: "backend-native",
      unsafe: false,
    };

    expect(nativeSmokeEvidenceValid({ status: "succeeded", containment }, native)).toBe(true);
    expect(nativeSmokeEvidenceValid({
      status: "succeeded",
      containment: { ...containment, network: "provider-direct" },
    }, native)).toBe(false);
  });

  test("preserves denied prelaunch evidence without accepting it as a provider turn", () => {
    const containment = {
      requirement: "required",
      enforced: false,
      mechanism: null,
      probe: null,
      isolatedHome: true,
      credentialsIsolated: true,
      network: "denied",
      credentialAccess: "none",
      unsafe: false,
    };
    const result = { status: "blocked", containment };

    expect(nativeSmokeEvidenceValid(result, null)).toBe(false);
    expect(nativeSmokeContainmentSummary(containment)).toEqual({
      mechanism: null,
      network: "denied",
      credentialAccess: "none",
    });
  });

  test("refuses to inspect credentials or launch CLIs without explicit opt-in", async () => {
    const env = { ...process.env };
    delete env.HEADLESS_NATIVE_SMOKE;
    const child = Bun.spawn([process.execPath, new URL("../scripts/native-subscription-smoke.ts", import.meta.url).pathname], {
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
    expect(stderr).toContain("Native subscription smoke is disabled");
    expect(stderr).toContain("HEADLESS_NATIVE_SMOKE=1");
  });
});

describe("native subscription per-backend release gate", () => {
  test("macOS requires only Codex and OpenCode; Claude is a documented limitation there", () => {
    const gate = evaluateNativeSmokeGate([
      smokeResult("claude-code", "failed", false, "PROCESS_ERROR"),
      smokeResult("codex", "passed"),
      smokeResult("opencode", "passed"),
      smokeResult("grok-build", "skipped", true, "BACKEND_UNSUPPORTED"),
    ], true, "darwin");
    expect(gate.requiredBackends).toEqual(["codex", "opencode"]);
    expect(gate.releaseGatePassed).toBe(true);
  });

  test("Linux requires a file-credential Claude alongside Codex and OpenCode", () => {
    const gate = evaluateNativeSmokeGate([
      smokeResult("claude-code", "passed"),
      smokeResult("codex", "passed"),
      smokeResult("opencode", "passed"),
    ], true, "linux");
    expect(gate.requiredBackends).toEqual(["claude-code", "codex", "opencode"]);
    expect(gate.releaseGatePassed).toBe(true);
  });

  test("a transiently rate-limited required backend does not fail the gate when another really passes", () => {
    const gate = evaluateNativeSmokeGate([
      smokeResult("codex", "failed", false, "RATE_LIMITED"),
      smokeResult("opencode", "passed"),
    ], true, "darwin");
    expect(gate.transientRateLimited).toEqual(["codex"]);
    expect(gate.requiredRealPass).toBe(true);
    expect(gate.releaseGatePassed).toBe(true);
  });

  test("an all-rate-limited required set proves nothing and fails", () => {
    const gate = evaluateNativeSmokeGate([
      smokeResult("codex", "failed", false, "RATE_LIMITED"),
      smokeResult("opencode", "failed", false, "RATE_LIMITED"),
    ], true, "darwin");
    expect(gate.requiredRealPass).toBe(false);
    expect(gate.releaseGatePassed).toBe(false);
  });

  test("a genuinely failed required backend fails the gate", () => {
    const gate = evaluateNativeSmokeGate([
      smokeResult("codex", "failed", false, "PROCESS_ERROR"),
      smokeResult("opencode", "passed"),
    ], true, "darwin");
    expect(gate.requiredSatisfied).toBe(false);
    expect(gate.releaseGatePassed).toBe(false);
  });

  test("Grok is experimental and never required on any platform", () => {
    expect(nativeSmokeAcceptedLimitation("grok-build", "BACKEND_UNSUPPORTED", "linux")).toBe(true);
    const gate = evaluateNativeSmokeGate([
      smokeResult("claude-code", "passed"),
      smokeResult("codex", "passed"),
      smokeResult("opencode", "passed"),
      smokeResult("grok-build", "skipped", true, "BACKEND_UNSUPPORTED"),
    ], true, "linux");
    expect(gate.requiredBackends).not.toContain("grok-build");
    expect(gate.releaseGatePassed).toBe(true);
  });

  test("Claude auth-unavailable is an accepted limitation on macOS but not on Linux", () => {
    expect(nativeSmokeAcceptedLimitation("claude-code", "NATIVE_AUTH_UNAVAILABLE", "darwin")).toBe(true);
    expect(nativeSmokeAcceptedLimitation("claude-code", "NATIVE_AUTH_UNAVAILABLE", "linux")).toBe(false);
  });

  test("a missing required backend fails the gate", () => {
    const gate = evaluateNativeSmokeGate([
      smokeResult("opencode", "passed"),
    ], true, "darwin");
    expect(gate.releaseGatePassed).toBe(false);
    expect(gate.requiredSatisfied).toBe(false);
  });

  test("a changed primary checkout fails the gate even when every backend passed", () => {
    const gate = evaluateNativeSmokeGate([
      smokeResult("codex", "passed"),
      smokeResult("opencode", "passed"),
    ], false, "darwin");
    expect(gate.releaseGatePassed).toBe(false);
  });
});
