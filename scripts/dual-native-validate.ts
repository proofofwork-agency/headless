#!/usr/bin/env bun
/**
 * Dual-backend native-login gate. Requires installed, logged-in Codex and
 * OpenCode CLIs and verifies exact first-value output from both.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type LiveValidationFixture,
  withLiveValidationFixture,
} from "./live-validation-fixture";

const backends = ["codex", "opencode"] as const;

try {
  const summary = await withLiveValidationFixture("headless-dual-native", validateDualNative);
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
} catch (error) {
  console.error(`dual-native validation failed: ${diagnostic(error)}`);
  if (!process.exitCode) process.exitCode = 1;
}

async function validateDualNative(fixture: LiveValidationFixture) {
  if (!(await Bun.file(fixture.cli).exists())) throw new Error("dist/cli.js missing — run bun run build");
  writeFileSync(resolve(fixture.project, "README.md"), "# dual native-login validation\n");
  const checks: Array<{ id: string; ok: boolean; detail: string }> = [];
  const check = (id: string, ok: boolean, detail: string) => {
    checks.push({ id, ok, detail });
    console.error(`${ok ? "PASS" : "FAIL"} ${id}: ${detail}`);
  };

  const setup = await fixture.run(["setup", "--yes", "--allow-native-direct-unrestricted", "--cwd", fixture.project], 60_000);
  check("setup", setup.exitCode === 0 && !setup.timedOut, `exit ${setup.exitCode}`);

  for (const backend of backends) {
    const expectedOutput = `DUAL_${backend.toUpperCase()}_OK`;
    const result = await fixture.run([
      "exec",
      "--backend", backend,
      "--auth-mode", "native-login",
      "--mode", "read-only",
      "--profile", "read-only-native",
      "--timeout-ms", "180000",
      "--json",
      "--cwd", fixture.project,
      "--",
      `Reply with exactly: ${expectedOutput}`,
    ], 200_000);
    try {
      const body = JSON.parse(result.stdout) as {
        status?: string;
        output?: string;
        containment?: {
          network?: string;
          credentialAccess?: string;
          enforced?: boolean;
          unsafe?: boolean;
        };
        error?: { message?: string };
      };
      check(`${backend}.process`, result.exitCode === 0 && !result.timedOut, `exit=${result.exitCode}`);
      check(`${backend}.status`, body.status === "succeeded", `status=${String(body.status)} err=${body.error?.message ?? ""}`);
      check(`${backend}.output`, body.output?.trim() === expectedOutput, `output=${JSON.stringify(body.output?.slice(0, 100))}`);
      check(
        `${backend}.native-login`,
        body.containment?.network === "native-direct-unrestricted"
          && body.containment.credentialAccess === "backend-native"
          && body.containment.enforced === true
          && body.containment.unsafe === false,
        `containment=${JSON.stringify(body.containment)}`,
      );
    } catch (error) {
      check(`${backend}.json`, false, `${diagnostic(error)}; ${result.stdout.slice(0, 200)} ${result.stderr.slice(0, 200)}`);
    }
  }

  const failed = checks.filter((entry) => !entry.ok);
  return {
    ok: failed.length === 0,
    project: fixture.project,
    backends: [...backends],
    checks,
    failed: failed.map((entry) => entry.id),
  };
}

function diagnostic(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replaceAll(/\s+/g, " ").slice(0, 2_000);
}
