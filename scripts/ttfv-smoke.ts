#!/usr/bin/env bun
/**
 * Golden-path TTFV smoke: setup → trust → doctor --json → exec --profile → verify.
 *
 * Default: warm ceremony (no provider exec) measuring setup+doctor+trust.
 * Opt-in live turn: HEADLESS_TTFV_LIVE=1 runs a real read-only native exec.
 * Only a live, exact-output result can satisfy Product Gate P.TTFV.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  releaseEvidenceProvenance,
  writeReleaseEvidenceFile,
} from "./native-smoke-evidence";
import {
  type LiveValidationFixture,
  type ValidationCommandResult,
  withLiveValidationFixture,
} from "./live-validation-fixture";

const LIVE = process.env.HEADLESS_TTFV_LIVE === "1";
const MAX_LIVE_MS = 5 * 60_000;
const MAX_CEREMONY_MS = 90_000;
const EVIDENCE_PATH = resolve(import.meta.dir, "../docs/internal/release-evidence/ttfv-smoke.json");
const EXPECTED_OUTPUT = "TTFV_OK";

type Step = ValidationCommandResult & { name: string; durationMs: number };

try {
  const evidence = await withLiveValidationFixture("headless-ttfv", runSmoke);
  console.log(JSON.stringify({ ...evidence, evidencePath: EVIDENCE_PATH }, null, 2));
  console.error(`ttfv-smoke passed (${LIVE ? "live" : "ceremony"}) in ${evidence.totalMs}ms`);
} catch (error) {
  console.error(`ttfv-smoke failed: ${diagnostic(error)}`);
  if (!process.exitCode) process.exitCode = 1;
}

async function runSmoke(fixture: LiveValidationFixture) {
  if (!(await Bun.file(fixture.cli).exists())) {
    throw new Error(`Missing ${fixture.cli}; run bun run build first.`);
  }
  writeFileSync(resolve(fixture.project, "README.md"), "# TTFV disposable project\n");

  const steps: Step[] = [];
  const started = Date.now();
  let failure: string | null = null;
  let recommendedBackend: string | null = null;
  let readyForNativeExec = false;
  let doctorNextActions = 0;
  let modelOutputVerified = false;
  let containmentVerified = false;

  const run = async (name: string, args: string[], timeoutMs: number) => {
    const stepStarted = Date.now();
    const result = await fixture.run(args, timeoutMs);
    const step = { ...result, name, durationMs: Date.now() - stepStarted };
    steps.push(step);
    return step;
  };

  try {
    const setup = await run(
      "setup",
      ["setup", "--yes", "--allow-native-direct-unrestricted", "--cwd", fixture.project],
      60_000,
    );
    assertStep(setup, "setup");

    const doctor = await run("doctor", ["doctor", "--json", "--cwd", fixture.project], 30_000);
    assertStep(doctor, "doctor --json");
    const report = JSON.parse(doctor.stdout) as {
      readyForNativeExec?: boolean;
      recommendedBackend?: string | null;
      nextActions?: Array<{ command: string }>;
      trust?: { nativeReady?: boolean };
    };
    if (!report.trust || typeof report.readyForNativeExec !== "boolean") {
      throw new Error("doctor report missing readiness fields");
    }
    if (!Array.isArray(report.nextActions) || report.nextActions.length === 0) {
      throw new Error("doctor report missing nextActions panel");
    }
    recommendedBackend = report.recommendedBackend ?? "codex";
    readyForNativeExec = report.readyForNativeExec;
    doctorNextActions = report.nextActions.length;

    if (LIVE) {
      if (!readyForNativeExec) {
        throw new Error(`LIVE mode requires readyForNativeExec; doctor said no (backend=${recommendedBackend})`);
      }
      const exec = await run("exec", [
        "exec",
        "--backend", recommendedBackend,
        "--auth-mode", "native-login",
        "--mode", "read-only",
        "--profile", "read-only-native",
        "--timeout-ms", "120000",
        "--json",
        "--cwd", fixture.project,
        "--",
        `Reply with exactly: ${EXPECTED_OUTPUT}`,
      ], 180_000);
      assertStep(exec, "exec");
      const result = JSON.parse(exec.stdout) as {
        status?: string;
        output?: string;
        next?: { verify?: string; receipt?: string };
        containment?: {
          network?: string;
          credentialAccess?: string;
          enforced?: boolean;
          unsafe?: boolean;
        };
      };
      if (result.status !== "succeeded") throw new Error(`exec status ${String(result.status)}`);
      if (!result.next?.verify || !result.next?.receipt) throw new Error("exec JSON missing next.verify/next.receipt");
      modelOutputVerified = result.output?.trim() === EXPECTED_OUTPUT;
      if (!modelOutputVerified) {
        throw new Error(`exec output did not equal ${EXPECTED_OUTPUT}: ${JSON.stringify(result.output?.slice(0, 200))}`);
      }
      containmentVerified = result.containment?.network === "native-direct-unrestricted"
        && result.containment.credentialAccess === "backend-native"
        && result.containment.enforced === true
        && result.containment.unsafe === false;
      if (!containmentVerified) throw new Error(`native containment evidence was incomplete: ${JSON.stringify(result.containment)}`);

      const verify = await run("verify", ["verify", "--json", "--cwd", fixture.project], 30_000);
      assertStep(verify, "verify");
    }
  } catch (error) {
    failure = diagnostic(error);
  }

  const totalMs = Date.now() - started;
  const ceremonyMs = steps
    .filter((step) => step.name === "setup" || step.name === "doctor")
    .reduce((total, step) => total + step.durationMs, 0);
  const budgetMs = LIVE ? MAX_LIVE_MS : MAX_CEREMONY_MS;
  const ok = failure === null && totalMs <= budgetMs;
  const evidence = {
    version: 1,
    gate: "product-P.TTFV",
    mode: LIVE ? "live" as const : "ceremony" as const,
    ok,
    releaseGatePassed: LIVE && ok && modelOutputVerified && containmentVerified,
    totalMs,
    ceremonyMs,
    budgetMs,
    project: fixture.project,
    recommendedBackend,
    readyForNativeExec,
    doctorNextActions,
    modelOutputVerified,
    containmentVerified,
    expectedOutput: LIVE ? EXPECTED_OUTPUT : null,
    failure,
    steps: steps.map(({ name, durationMs, exitCode, timedOut }) => ({
      name,
      durationMs,
      exitCode,
      timedOut,
    })),
    completedAt: new Date().toISOString(),
  };
  const written = writeReleaseEvidenceFile({
    path: EVIDENCE_PATH,
    evidence,
    provenance: releaseEvidenceProvenance(),
  });
  if (!ok) {
    throw new Error(failure ?? `TTFV smoke exceeded budget ${budgetMs}ms (total ${totalMs}ms)`);
  }
  return written.document;
}

function assertStep(step: Step, label: string) {
  if (step.timedOut) throw new Error(`${label} timed out`);
  if (step.exitCode !== 0) throw new Error(`${label} failed: ${step.stderr || step.stdout.slice(0, 800)}`);
}

function diagnostic(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replaceAll(/\s+/g, " ").slice(0, 2_000);
}
