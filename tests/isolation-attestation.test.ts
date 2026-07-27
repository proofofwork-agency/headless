import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { backendDefinitions } from "../src/backends/registry";
import {
  runIsolationAttestation,
  type IsolationAttestationSpec,
  type IsolationInspectResult,
} from "../src/runtime/isolation-attestation";
import type { WorkerEnvironment } from "../src/runtime/worker-environment";

const PRIMARY = "/tmp/attestation-primary";
const CANARY = "/tmp/attestation-canary";
const worker = {} as WorkerEnvironment;

/**
 * A backend that gates configuration behind folder trust: `trusted: false` is
 * the only shape the strict validator accepts, and `trusted: true` is the
 * vacuous report a surface-free project produces.
 */
function spec(overrides: Partial<IsolationAttestationSpec> = {}): IsolationAttestationSpec {
  return {
    command: ["tool", "inspect", "--json"],
    timeoutMs: 1_000,
    maxOutputBytes: 1_000,
    validate: (value) => (value as { trusted?: unknown } | null)?.trusted === false ? null : "trust is not disabled",
    vacuousTrustFallback: {
      validateVacuousPrimary: (value) =>
        (value as { trusted?: unknown } | null)?.trusted === true ? null : "not a vacuously trusted project",
      prepareCanaryCwd: () => CANARY,
    },
    ...overrides,
  } as IsolationAttestationSpec;
}

const emitted = (value: unknown): IsolationInspectResult => ({ exitCode: 0, stdout: JSON.stringify(value) });

/** Answer each cwd differently and record the order they were inspected in. */
function inspector(byCwd: Record<string, IsolationInspectResult | (() => Promise<never>)>) {
  const seen: string[] = [];
  return {
    seen,
    inspect: async (cwd: string) => {
      seen.push(cwd);
      const answer = byCwd[cwd];
      if (!answer) throw new Error(`unexpected inspection cwd: ${cwd}`);
      return typeof answer === "function" ? answer() : answer;
    },
  };
}

describe("shared isolation attestation", () => {
  test("accepts a project the strict validator admits without consulting the canary", async () => {
    const probe = inspector({ [PRIMARY]: emitted({ trusted: false }) });
    expect(await runIsolationAttestation({ spec: spec(), primaryCwd: PRIMARY, worker, inspect: probe.inspect })).toBeNull();
    // Reaching the canary would mean paying for a second contained probe that
    // proves nothing the primary has not already proven.
    expect(probe.seen).toEqual([PRIMARY]);
  });

  /**
   * The case that made Grok unusable: a surface-free project cannot force a real
   * trust decision, so the strict validator must reject its vacuous report and
   * the gate has to be proven on the canary instead.
   */
  test("proves the gate on the canary when the primary report is vacuous", async () => {
    const probe = inspector({
      [PRIMARY]: emitted({ trusted: true }),
      [CANARY]: emitted({ trusted: false }),
    });
    expect(await runIsolationAttestation({ spec: spec(), primaryCwd: PRIMARY, worker, inspect: probe.inspect })).toBeNull();
    expect(probe.seen).toEqual([PRIMARY, CANARY]);
  });

  test("fails closed when the canary shows the gate is not denying", async () => {
    const probe = inspector({
      [PRIMARY]: emitted({ trusted: true }),
      // A leaked trust grant for the canary looks exactly like this.
      [CANARY]: emitted({ trusted: true }),
    });
    expect(await runIsolationAttestation({ spec: spec(), primaryCwd: PRIMARY, worker, inspect: probe.inspect }))
      .toBe("trust-gate canary attestation failed: trust is not disabled");
  });

  test("names both errors when the vacuous fallback declines the primary", async () => {
    const probe = inspector({ [PRIMARY]: emitted({ trusted: "neither" }) });
    const failure = await runIsolationAttestation({ spec: spec(), primaryCwd: PRIMARY, worker, inspect: probe.inspect });
    // Reporting only the strict error hides why the fallback was skipped.
    expect(failure).toBe("trust is not disabled (vacuous-trust fallback declined it: not a vacuously trusted project)");
    expect(probe.seen).toEqual([PRIMARY]);
  });

  test("returns the strict error unchanged for a backend that declares no fallback", async () => {
    const probe = inspector({ [PRIMARY]: emitted({ trusted: true }) });
    const failure = await runIsolationAttestation({
      spec: spec({ vacuousTrustFallback: undefined }),
      primaryCwd: PRIMARY,
      worker,
      inspect: probe.inspect,
    });
    expect(failure).toBe("trust is not disabled");
    expect(probe.seen).toEqual([PRIMARY]);
  });

  test("fails closed when canary preparation throws", async () => {
    const probe = inspector({ [PRIMARY]: emitted({ trusted: true }) });
    const failure = await runIsolationAttestation({
      spec: spec({
        vacuousTrustFallback: {
          validateVacuousPrimary: () => null,
          prepareCanaryCwd: () => { throw new Error("no writable worker root"); },
        },
      }),
      primaryCwd: PRIMARY,
      worker,
      inspect: probe.inspect,
    });
    expect(failure).toBe("trust-gate canary attestation could not run: no writable worker root");
  });

  test("fails closed when the canary inspection itself rejects", async () => {
    const probe = inspector({
      [PRIMARY]: emitted({ trusted: true }),
      [CANARY]: async () => { throw new Error("sandbox refused to launch"); },
    });
    expect(await runIsolationAttestation({ spec: spec(), primaryCwd: PRIMARY, worker, inspect: probe.inspect }))
      .toBe("trust-gate canary attestation could not run: sandbox refused to launch");
  });

  describe("normalizes bounded process failures identically on every path", () => {
    const cases: Array<[string, IsolationInspectResult, string]> = [
      ["a timed-out inspection", { exitCode: null, timedOut: true }, "inspect timed out"],
      ["an overflowing inspection", { exitCode: 0, overflowed: true }, "inspect output exceeded its bound"],
      ["a reported executor error", { exitCode: 0, error: "spawn refused" }, "spawn refused"],
      ["a non-zero exit with stderr", { exitCode: 2, stderr: "inspect blew up" }, "inspect blew up"],
      ["a non-zero exit without stderr", { exitCode: 3 }, "inspect exited 3"],
      ["malformed output", { exitCode: 0, stdout: "{not json" }, "inspect returned malformed JSON"],
      ["absent output", { exitCode: 0 }, "inspect returned malformed JSON"],
    ];

    for (const [label, result, expected] of cases) {
      test(`rejects ${label} at the primary`, async () => {
        const probe = inspector({ [PRIMARY]: result });
        expect(await runIsolationAttestation({ spec: spec(), primaryCwd: PRIMARY, worker, inspect: probe.inspect }))
          .toBe(expected);
      });

      test(`rejects ${label} at the canary`, async () => {
        const probe = inspector({ [PRIMARY]: emitted({ trusted: true }), [CANARY]: result });
        expect(await runIsolationAttestation({ spec: spec(), primaryCwd: PRIMARY, worker, inspect: probe.inspect }))
          .toBe(`trust-gate canary attestation failed: ${expected}`);
      });
    }
  });

  /**
   * The original defect was not a wrong rule but a second copy of the rules.
   * `native-session-manager.ts` carried a strict-only reimplementation, so the
   * canary fix landed in the runner and never reached the path that Grok
   * subscription logins actually use. Both launch paths must keep deferring to
   * this engine, and neither may reintroduce a per-backend branch.
   */
  describe("has no second implementation", () => {
    const source = (path: string) => readFileSync(join(import.meta.dir, "..", "src", path), "utf-8");

    test("both launch paths delegate to the shared engine", () => {
      for (const path of ["runner/simple.ts", "runtime/native-session-manager.ts"]) {
        expect(source(path)).toContain("runIsolationAttestation");
      }
    });

    test("neither launch path re-derives the outcome locally", () => {
      for (const path of ["runner/simple.ts", "runtime/native-session-manager.ts"]) {
        const text = source(path);
        expect(text).not.toContain("grokSessionAttestationFailure");
        expect(text).not.toContain("inspect returned malformed JSON");
        expect(text).not.toContain("validateGrokIsolationInspection");
      }
    });

    test("native session initialization is adapter-driven, not backend-named", () => {
      const text = source("runtime/native-session-manager.ts");
      // Naming a backend here is what let worker configuration and attestation
      // drift apart; both are now reached through the adapter definition.
      expect(text).not.toContain("grok-build");
      expect(text).toContain("adapter.configureWorker?.(");
      expect(text).toContain("adapter.isolationAttestation");
    });

    test("every backend declaring an attestation also declares its fallback inputs", () => {
      for (const [id, definition] of Object.entries(backendDefinitions)) {
        const spec = definition.isolationAttestation;
        if (!spec) continue;
        expect(spec.command.length, id).toBeGreaterThan(0);
        expect(typeof spec.validate, id).toBe("function");
        // A declared fallback without a canary would silently degrade to
        // strict-only for surface-free projects — the original failure.
        if (spec.vacuousTrustFallback) {
          expect(typeof spec.vacuousTrustFallback.validateVacuousPrimary, id).toBe("function");
          expect(typeof spec.vacuousTrustFallback.prepareCanaryCwd, id).toBe("function");
        }
      }
    });
  });
});
