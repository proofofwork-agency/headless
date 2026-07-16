import { createHash } from "node:crypto";
import type { BrokerLeaseScope } from "../broker/server";
import {
  RECEIPT_BUDGET_REASON_MAX,
  RECEIPT_POLICY_TRAIL_MAX,
  RECEIPT_POLICY_REASON_MAX,
  RECEIPT_PREVIEW_MAX,
  ReceiptBodySchema,
  ReceiptSchema,
  type Receipt,
  type ReceiptBody,
} from "../contracts/receipt";
import type { RunEvent, RunResult, SerializedRunRequest } from "../contracts/run";
import { receiptAnchorArtifact, parseReceiptAnchor } from "./receipt-anchor";
import {
  canonicalReceiptJson,
  receiptSectionDigests,
  receiptSelfDigest,
  sha256Hex,
} from "./receipt-canonical";
import type { ReceiptStore } from "./receipt-store";
import { recordArtifact } from "./ledger-api";
import { redactAndTruncate } from "./redaction";
import type { ProjectStateOptions, ProjectStatePaths } from "./project-state";
import type { GateCheckResult } from "./release-gate";

export type ReceiptProvenanceContext = {
  headlessVersion: string;
  platform: string;
  commit: string | null;
  backendVersions: Readonly<Record<string, string | null>>;
};

export type ReceiptAuthorizationSnapshot = ReceiptBody["authorization"];
export type ReceiptBrokerLeaseSnapshot = NonNullable<ReceiptBody["brokerLease"]>;
export type ReceiptGateManifestEntry = ReceiptBody["gates"][number];

export type AssembleReceiptInput = {
  jobId: string;
  sessionId: string | null;
  principal: string;
  request: SerializedRunRequest;
  result: RunResult;
  policyEvents: readonly RunEvent[];
  authorization: ReceiptAuthorizationSnapshot;
  brokerLease: ReceiptBrokerLeaseSnapshot | null;
  gates: readonly ReceiptGateManifestEntry[];
  budget: ReceiptBody["budget"];
  startedAt: number;
  endedAt: number;
};

export type ReceiptServiceDependencies = {
  paths: ProjectStatePaths;
  stateOptions?: ProjectStateOptions;
  receipts: Pick<ReceiptStore, "put">;
  provenance: ReceiptProvenanceContext;
};

export const RECEIPT_GAP_ARTIFACT_KIND = "execution_receipt_gap";

/**
 * Assemble the bounded receipt, append its deterministic ledger anchor, and
 * only then persist the full receipt with that ledger position embedded.
 * The caller owns the non-fatal guard because this function intentionally
 * throws on any malformed input, ledger mismatch, or store failure.
 */
export function assembleAndAnchorReceipt(
  deps: ReceiptServiceDependencies,
  input: AssembleReceiptInput,
): Receipt {
  const endedAt = new Date(input.endedAt).toISOString();
  const body = ReceiptBodySchema.parse({
    receiptId: receiptIdForRun(input.jobId),
    runId: input.jobId,
    sessionId: input.sessionId,
    projectId: deps.paths.projectId,
    principal: input.principal,
    request: {
      backend: input.request.backend,
      mode: input.request.mode,
      model: input.request.model ?? null,
      agent: input.request.agent ?? null,
      timeoutMs: input.request.timeoutMs,
      containment: input.request.containment,
      authMode: input.request.authMode,
      approvalPolicy: input.request.approvalPolicy,
      prompt: receiptBlob(input.request.prompt),
    },
    result: {
      status: input.result.status,
      error: input.result.error,
      exitCode: input.result.exitCode,
      signal: input.result.signal,
      usage: input.result.usage,
      cost: input.result.cost,
      containment: input.result.containment,
      durationMs: input.result.durationMs,
      truncation: input.result.truncation,
      output: receiptBlob(input.result.output),
      diff: input.result.diff ? {
        digest: sha256Hex(input.result.diff.patch),
        bytes: Buffer.byteLength(input.result.diff.patch, "utf8"),
        files: input.result.diff.files,
        baseCommit: input.result.diff.baseCommit,
        candidateCommit: input.result.diff.candidateCommit,
        resultingCommit: input.result.diff.resultingCommit,
      } : null,
    },
    policyTrail: input.policyEvents
      .filter((event) => event.kind === "policy")
      .slice(-RECEIPT_POLICY_TRAIL_MAX)
      .map((event) => ({
        decision: event.decision,
        rule: event.rule,
        reason: boundedRedactedText(event.reason, RECEIPT_POLICY_REASON_MAX),
      })),
    authorization: input.authorization,
    brokerLease: input.brokerLease,
    gates: [...input.gates],
    budget: {
      ...input.budget,
      reasons: input.budget.reasons.map((reason) => boundedRedactedText(reason, RECEIPT_BUDGET_REASON_MAX)),
    },
    provenance: {
      startedAt: new Date(input.startedAt).toISOString(),
      endedAt,
      headlessVersion: deps.provenance.headlessVersion,
      platform: deps.provenance.platform,
      commit: deps.provenance.commit,
      backendVersion: deps.provenance.backendVersions[input.request.backend] ?? null,
    },
  });
  const sectionDigests = receiptSectionDigests(body);
  const selfDigest = receiptSelfDigest(body);
  const anchor = {
    version: 1 as const,
    receiptId: body.receiptId,
    runId: body.runId,
    sha256: selfDigest,
    mode: body.request.mode,
    status: body.result.status,
    provenance: {
      generatedAt: endedAt,
      headlessVersion: body.provenance.headlessVersion,
      platform: body.provenance.platform,
      commit: body.provenance.commit,
    },
  };
  const artifact = receiptAnchorArtifact(anchor);
  const event = recordArtifact({
    cwd: deps.paths.canonicalProjectRoot,
    state: deps.stateOptions,
    authenticatedPrincipal: input.principal,
    sessionId: input.sessionId ?? input.jobId,
    ...artifact,
    eventId: receiptAnchorEventId(input.jobId),
  });
  const persistedAnchor = parseReceiptAnchor(event.type === "artifact" ? event.artifact?.evidence : undefined);
  if (!persistedAnchor || canonicalReceiptJson(persistedAnchor) !== canonicalReceiptJson(anchor)) {
    throw new Error(`Receipt anchor replay mismatch for run ${input.jobId}.`);
  }
  if (!event.hash) throw new Error(`Receipt anchor for run ${input.jobId} has no ledger hash.`);
  const receipt = ReceiptSchema.parse({
    version: 1,
    body,
    sectionDigests,
    integrity: {
      selfDigest,
      ledgerAnchor: {
        projectId: event.projectId,
        sequence: event.sequence,
        hash: event.hash,
      },
    },
  });
  deps.receipts.put(receipt);
  return receipt;
}

/** Record an explicit, idempotent evidence gap without impersonating a receipt anchor. */
export function recordReceiptGap(
  deps: Pick<ReceiptServiceDependencies, "paths" | "stateOptions">,
  input: { jobId: string; sessionId: string | null; principal: string; reason: string },
) {
  const reason = boundedRedactedText(input.reason, 2_048);
  return recordArtifact({
    cwd: deps.paths.canonicalProjectRoot,
    state: deps.stateOptions,
    authenticatedPrincipal: input.principal,
    sessionId: input.sessionId ?? input.jobId,
    kind: RECEIPT_GAP_ARTIFACT_KIND,
    title: `Execution receipt gap: ${input.jobId}`,
    summary: `Run ${input.jobId} completed, but its receipt evidence could not be durably assembled.`,
    status: "failed",
    evidence: [`run:${input.jobId}`, `reason:${reason}`],
    eventId: receiptGapEventId(input.jobId),
  });
}

/** Redacted, immutable enforcement envelope; excludes credentials and counters. */
export function receiptBrokerLeaseSnapshot(scope: BrokerLeaseScope): ReceiptBrokerLeaseSnapshot {
  const envelope = {
    provider: scope.provider,
    models: [...scope.models],
    endpointClasses: [...scope.endpointClasses],
    expiresAt: scope.expiresAt,
    maxRequests: scope.maxRequests,
    maxBodyBytes: scope.maxBodyBytes,
    maxConcurrentRequests: scope.maxConcurrentRequests,
    maxInFlightBodyBytes: scope.maxInFlightBodyBytes,
    maxStreamMs: scope.maxStreamMs,
    maxCostUsd: scope.maxCostUsd,
    quotas: scope.budgetQuotas.map((quota) => ({
      id: quota.id,
      maxRequests: quota.maxRequests,
      maxInputTokens: quota.maxInputTokens,
      maxOutputTokens: quota.maxOutputTokens,
      maxCostUsd: quota.maxCostUsd,
    })),
  };
  return {
    ...envelope,
    scopeDigest: sha256Hex(canonicalReceiptJson(envelope)),
  };
}

export function receiptGateManifest(
  phase: "candidate" | "integration",
  checks: readonly GateCheckResult[],
): ReceiptGateManifestEntry[] {
  return checks.map((check) => ({
    phase,
    name: check.name,
    status: check.ok ? "passed" : check.timedOut ? "timed_out" : check.cancelled ? "cancelled" : "failed",
    definitionDigest: sha256Hex(canonicalReceiptJson({ command: check.command, args: check.args })),
    evidenceDigest: sha256Hex(check.output),
  }));
}

export function receiptIdForRun(runId: string) {
  return deterministicUuid("headless-receipt", runId);
}

export function receiptAnchorEventId(runId: string) {
  return deterministicUuid("headless-receipt-anchor", runId);
}

export function receiptGapEventId(runId: string) {
  return deterministicUuid("headless-receipt-gap", runId);
}

function receiptBlob(value: string) {
  return {
    digest: sha256Hex(value),
    bytes: Buffer.byteLength(value, "utf8"),
    preview: boundedRedactedText(value, RECEIPT_PREVIEW_MAX),
  };
}

/**
 * Redaction's public truncation marker is intentionally additive and its
 * already-truncated input path is intentionally stable for existing callers.
 * Receipt schemas require a hard final bound, so leave enough marker margin
 * before redaction and enforce the schema limit again afterward.
 */
function boundedRedactedText(value: string, maxLength: number) {
  const markerMargin = Math.min(96, Math.max(0, maxLength - 1));
  const redacted = redactAndTruncate(value, maxLength - markerMargin).text;
  if (redacted.length <= maxLength) return redacted;
  const marker = "\n[TRUNCATED]";
  if (marker.length >= maxLength) return marker.slice(0, maxLength);
  return `${redacted.slice(0, maxLength - marker.length)}${marker}`;
}

function deterministicUuid(namespace: string, value: string) {
  const hex = createHash("sha256").update(`${namespace}\0${value}`).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = "8";
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}
