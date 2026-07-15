import { describe, expect, test } from "bun:test";
import {
  nativeSmokeContainmentSummary,
  nativeSmokeEvidenceValid,
} from "../scripts/native-smoke-evidence";

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
