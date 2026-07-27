import type { BackendDefinition } from "../backends/registry";
import type { WorkerEnvironment } from "./worker-environment";

export type IsolationAttestationSpec = NonNullable<BackendDefinition["isolationAttestation"]>;

/**
 * The part of a bounded process result an attestation needs. The runner's
 * `ProbeExecution` and the native session's `SessionExecutionResult` both
 * satisfy it structurally, which is what lets one engine serve both paths.
 */
export type IsolationInspectResult = {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  overflowed?: boolean;
  error?: string;
};

/**
 * Two-phase isolation attestation, shared by every launch path.
 *
 * A backend that gates repo-local configuration behind folder trust records a
 * decision only for a project that carries a gated surface. A surface-free
 * project therefore reports a vacuous "trusted" that the strict validator must
 * reject, so the gate has to be proven elsewhere: inside a worker-owned canary
 * project that always carries one.
 *
 * This policy previously lived only in the runner while the native-session path
 * kept a strict-only copy of it. The copy could never admit an ordinary project,
 * which silently made Grok unusable for exactly the subscription logins that
 * route through that path. Both the policy and the result normalization live
 * here so neither can drift apart again — a launch path supplies only how to run
 * the inspection, never when to accept it.
 */
export async function runIsolationAttestation(input: {
  spec: IsolationAttestationSpec;
  primaryCwd: string;
  worker: WorkerEnvironment;
  inspect: (cwd: string) => Promise<IsolationInspectResult>;
}): Promise<string | null> {
  const { spec, primaryCwd, worker, inspect } = input;

  const primary = inspectionOf(await inspect(primaryCwd));
  if ("failure" in primary) return primary.failure;

  const strict = spec.validate(primary.value);
  if (!strict) return null;

  const fallback = spec.vacuousTrustFallback;
  if (!fallback) return strict;

  const vacuous = fallback.validateVacuousPrimary(primary.value, primaryCwd);
  // Reporting only the strict error hides why the fallback was declined, which
  // reads as a trust failure when the real cause is an unrelated surface.
  if (vacuous) return `${strict} (vacuous-trust fallback declined it: ${vacuous})`;

  // The target project exposes no trust-gated control surface, so its trust
  // decision is vacuous. Prove the gate itself on a canary that always carries
  // one; a leaked grant or a disabled gate fails closed there.
  try {
    const canary = inspectionOf(await inspect(fallback.prepareCanaryCwd(worker)));
    if ("failure" in canary) return `trust-gate canary attestation failed: ${canary.failure}`;
    const canaryStrict = spec.validate(canary.value);
    return canaryStrict ? `trust-gate canary attestation failed: ${canaryStrict}` : null;
  } catch (error) {
    return `trust-gate canary attestation could not run: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function inspectionOf(result: IsolationInspectResult): { failure: string } | { value: unknown } {
  if (result.error) return { failure: result.error };
  if (result.timedOut) return { failure: "inspect timed out" };
  if (result.overflowed) return { failure: "inspect output exceeded its bound" };
  if (result.exitCode !== 0) return { failure: result.stderr || `inspect exited ${result.exitCode}` };
  try {
    return { value: JSON.parse(result.stdout ?? "") };
  } catch {
    return { failure: "inspect returned malformed JSON" };
  }
}
