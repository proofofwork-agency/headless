#!/usr/bin/env bun
/**
 * Validate golden-path CLI surface (help, setup, doctor, exact exec output,
 * and verify) in one disposable daemon-owned fixture.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type LiveValidationFixture,
  withLiveValidationFixture,
} from "./live-validation-fixture";

const EXPECTED_OUTPUT = "PANEL_OK";

try {
  const summary = await withLiveValidationFixture("headless-cli-panel", validatePanel);
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
} catch (error) {
  console.error(`cli-panel validation failed: ${diagnostic(error)}`);
  if (!process.exitCode) process.exitCode = 1;
}

async function validatePanel(fixture: LiveValidationFixture) {
  if (!(await Bun.file(fixture.cli).exists())) throw new Error("dist/cli.js missing — run bun run build");
  writeFileSync(resolve(fixture.project, "README.md"), "# CLI panel validation\n");
  const checks: Array<{ id: string; ok: boolean; detail: string }> = [];
  const check = (id: string, ok: boolean, detail: string) => {
    checks.push({ id, ok, detail });
    console.error(`${ok ? "PASS" : "FAIL"} ${id}: ${detail}`);
  };

  const help = await fixture.run(["--help"], 10_000);
  check("help.golden", help.exitCode === 0 && help.stdout.includes("Golden path:") && help.stdout.includes("setup"), "banner + setup in default help");

  const setup = await fixture.run(["setup", "--yes", "--allow-native-direct-unrestricted", "--cwd", fixture.project], 60_000);
  check("setup.exit", setup.exitCode === 0 && !setup.timedOut, `exit ${setup.exitCode}`);
  check("setup.inventory", /capsule ok|capsule missing/.test(setup.stdout), "backend capsule inventory lines");
  check("setup.doctor_hint", setup.stdout.includes("doctor --json"), "points at doctor panel");

  const doctorHuman = await fixture.run(["doctor", "--cwd", fixture.project], 30_000);
  check("doctor.banner", doctorHuman.stdout.includes("headless doctor — v0.2"), "human panel banner");
  check("doctor.trust", doctorHuman.stdout.includes("Trust:"), "trust ladder line");
  check("doctor.broker_env", doctorHuman.stdout.includes("Broker env (daemon process"), "daemon-owned broker environment");
  check("doctor.next", doctorHuman.stdout.includes("Next actions:"), "next actions section");

  const doctorJson = await fixture.run(["doctor", "--json", "--cwd", fixture.project], 30_000);
  let report: {
    version?: string;
    readyForNativeExec?: boolean;
    recommendedBackend?: string | null;
    brokerEnvSource?: string;
    nextActions?: Array<{ id: string; command: string }>;
  } = {};
  try {
    report = JSON.parse(doctorJson.stdout);
    check("doctor.json", doctorJson.exitCode === 0 && report.version === "product-readiness-1", "schema version");
    check("doctor.ready", report.readyForNativeExec === true, `readyForNativeExec=${String(report.readyForNativeExec)}`);
    check("doctor.broker_source", report.brokerEnvSource === "daemon", `brokerEnvSource=${String(report.brokerEnvSource)}`);
    check("doctor.nextActions", Array.isArray(report.nextActions) && report.nextActions.length > 0, `count=${report.nextActions?.length ?? 0}`);
  } catch (error) {
    check("doctor.json", false, diagnostic(error));
  }

  const backend = report.recommendedBackend || "codex";
  const exec = await fixture.run([
    "exec",
    "--backend", backend,
    "--auth-mode", "native-login",
    "--mode", "read-only",
    "--profile", "read-only-native",
    "--timeout-ms", "120000",
    "--json",
    "--cwd", fixture.project,
    "--",
    `Reply with exactly: ${EXPECTED_OUTPUT}`,
  ], 180_000);

  try {
    const body = JSON.parse(exec.stdout) as {
      status?: string;
      output?: string;
      next?: { verify?: string; receipt?: string };
      jobId?: string | null;
      containment?: { network?: string; credentialAccess?: string; enforced?: boolean; unsafe?: boolean };
    };
    check("exec.json", exec.exitCode === 0 && !exec.timedOut, `exit=${exec.exitCode}`);
    check("exec.output", body.output?.trim() === EXPECTED_OUTPUT, `output=${JSON.stringify(body.output?.slice(0, 100))}`);
    check("exec.next", Boolean(body.next?.verify && body.next?.receipt), `next=${JSON.stringify(body.next)}`);
    check("exec.jobId", Boolean(body.jobId), `jobId=${String(body.jobId)}`);
    check("exec.succeeded", body.status === "succeeded", `status=${String(body.status)}`);
    check(
      "exec.native-login",
      body.containment?.network === "native-direct-unrestricted"
        && body.containment.credentialAccess === "backend-native"
        && body.containment.enforced === true
        && body.containment.unsafe === false,
      `containment=${JSON.stringify(body.containment)}`,
    );
  } catch (error) {
    check("exec.json", false, `${diagnostic(error)}; stderr=${exec.stderr.slice(0, 200)}`);
  }

  const verify = await fixture.run(["verify", "--cwd", fixture.project], 30_000);
  check("verify.exit", verify.exitCode === 0 && !verify.timedOut, `exit ${verify.exitCode}`);

  const failed = checks.filter((entry) => !entry.ok);
  return {
    ok: failed.length === 0,
    project: fixture.project,
    backend,
    checks,
    failed: failed.map((entry) => entry.id),
  };
}

function diagnostic(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replaceAll(/\s+/g, " ").slice(0, 2_000);
}
