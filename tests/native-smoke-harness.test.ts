import { describe, expect, test } from "bun:test";
import {
  evaluateNativeSmokeGate,
  nativeSmokeAcceptedLimitation,
  nativeSmokeContainmentSummary,
  nativeSmokeEvidenceValid,
} from "../scripts/native-smoke-evidence";

function smokeResult(backend: string, status: string, acceptedLimitation = false) {
  return { backend, status, acceptedLimitation };
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
  test("macOS keychain-only Claude is an accepted limitation and still passes the gate", () => {
    expect(nativeSmokeAcceptedLimitation("claude-code", "NATIVE_AUTH_UNAVAILABLE", "darwin")).toBe(true);
    const gate = evaluateNativeSmokeGate([
      smokeResult("claude-code", "skipped", true),
      smokeResult("codex", "passed"),
      smokeResult("opencode", "passed"),
      smokeResult("grok-build", "failed"),
    ], true);
    expect(gate.releaseGatePassed).toBe(true);
    expect(gate.requiredBackends).toEqual(["claude-code", "codex", "opencode"]);
  });

  test("Claude auth-unavailable is NOT accepted off macOS and fails the gate", () => {
    expect(nativeSmokeAcceptedLimitation("claude-code", "NATIVE_AUTH_UNAVAILABLE", "linux")).toBe(false);
    const gate = evaluateNativeSmokeGate([
      smokeResult("claude-code", "failed"),
      smokeResult("codex", "passed"),
      smokeResult("opencode", "passed"),
    ], true);
    expect(gate.releaseGatePassed).toBe(false);
    expect(gate.requiredSatisfied).toBe(false);
  });

  test("Grok is experimental and never affects the gate", () => {
    expect(nativeSmokeAcceptedLimitation("grok-build", "BACKEND_UNSUPPORTED", "linux")).toBe(true);
    const gate = evaluateNativeSmokeGate([
      smokeResult("claude-code", "passed"),
      smokeResult("codex", "passed"),
      smokeResult("opencode", "passed"),
      smokeResult("grok-build", "skipped", true),
    ], true);
    expect(gate.releaseGatePassed).toBe(true);
  });

  test("all accepted-skips prove nothing: at least one required backend must really pass", () => {
    const gate = evaluateNativeSmokeGate([
      smokeResult("claude-code", "skipped", true),
      smokeResult("codex", "skipped", true),
      smokeResult("opencode", "skipped", true),
    ], true);
    expect(gate.requiredSatisfied).toBe(true);
    expect(gate.requiredRealPass).toBe(false);
    expect(gate.releaseGatePassed).toBe(false);
  });

  test("a missing required backend fails the gate", () => {
    const gate = evaluateNativeSmokeGate([
      smokeResult("codex", "passed"),
      smokeResult("opencode", "passed"),
    ], true);
    expect(gate.releaseGatePassed).toBe(false);
    expect(gate.requiredSatisfied).toBe(false);
  });

  test("a changed primary checkout fails the gate even when every backend passed", () => {
    const gate = evaluateNativeSmokeGate([
      smokeResult("claude-code", "passed"),
      smokeResult("codex", "passed"),
      smokeResult("opencode", "passed"),
    ], false);
    expect(gate.releaseGatePassed).toBe(false);
  });
});
