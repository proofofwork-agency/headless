import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { userInfo } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { ProviderBroker } from "../broker/server";
import { LinkedHoldRecordSchema } from "../contracts/linked-hold";
import { BudgetStore, BudgetStoreStateSchema } from "./budget-store";
import { DurableBrokerQuotaStore } from "./broker-quota-store";
import { HeadlessError } from "./headless-error";
import { writeOwnerOnlyJson } from "./owner-json";
import {
  ensureOwnerOnlyDirectory,
  ensureOwnerOnlyFile,
  ensureProjectStateDirectories,
  getProjectStatePaths,
  type ProjectStateOptions,
  type ProjectStatePaths,
} from "./project-state";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const MAX_STORE_BYTES = 32 * 1024 * 1024;

export async function inspectLinkedHoldOffline(projectRoot: string, linkId: string, state?: ProjectStateOptions) {
  const paths = ensureProjectStateDirectories(getProjectStatePaths(projectRoot, state));
  assertStateOwner(paths);
  return withOfflineStateLock(paths, () => inspectLocked(paths, digest.parse(linkId)));
}

export async function quarantineLinkedHoldOffline(input: {
  projectRoot: string;
  linkId: string;
  expectedDigest: string;
  resolution: "exhaust" | "release";
  confirm: boolean;
  state?: ProjectStateOptions;
}) {
  if (!input.confirm) throw new HeadlessError("INVALID_REQUEST", "Linked-hold quarantine requires literal --confirm.");
  const paths = ensureProjectStateDirectories(getProjectStatePaths(input.projectRoot, input.state));
  assertStateOwner(paths);
  return withOfflineStateLock(paths, () => {
    const priorMarker = new BudgetStore(paths).manualRecoveryMarkers().find((marker) => marker.linkId === input.linkId);
    if (priorMarker) {
      if (priorMarker.recordDigest !== input.expectedDigest || priorMarker.resolution !== input.resolution) {
        throw new HeadlessError("CONFLICT", "Manual linked-hold recovery conflicts with the recorded decision.");
      }
      return {
        ok: true,
        linkId: priorMarker.linkId,
        recordDigest: priorMarker.recordDigest,
        resolution: priorMarker.resolution,
        existing: true,
        quarantineArtifact: join(paths.archiveDir, "linked-hold-quarantine", priorMarker.quarantineArtifact),
        auditEventId: priorMarker.auditEventId,
      };
    }
    const inspected = inspectLocked(paths, digest.parse(input.linkId));
    const expectedDigest = digest.parse(input.expectedDigest);
    if (inspected.recordDigest !== expectedDigest) throw new HeadlessError("CONFLICT", "Linked hold changed after inspection.");
    if (!inspected.record) throw new HeadlessError("CONFLICT", "The corrupt link cannot be isolated safely enough for automatic quarantine.");
    if (inspected.record.state !== "recovery_required") {
      throw new HeadlessError("CONFLICT", "Only a recovery-required linked hold may be quarantined.");
    }
    const zeroEgress = inspected.zeroEgress;
    if (input.resolution === "release" && !zeroEgress) {
      throw new HeadlessError("CONFLICT", "Manual release requires exact zero-egress broker evidence.");
    }

    const quarantineDir = ensureOwnerOnlyDirectory(join(paths.archiveDir, "linked-hold-quarantine"));
    const artifactPath = join(quarantineDir, `${inspected.linkId}-${inspected.recordDigest}.json`);
    const actor = localAdminPrincipal();
    const auditEventId = deterministicAuditEventId(inspected.linkId, inspected.recordDigest, input.resolution);
    if (!existsSync(artifactPath)) {
      writeOwnerOnlyJson(artifactPath, {
        version: 1,
        projectId: paths.projectId,
        linkId: inspected.linkId,
        recordDigest: inspected.recordDigest,
        resolution: input.resolution,
        actor,
        decidedAt: Date.now(),
        reason: "Explicit offline recovery of one inspected cross-provider linked hold.",
        originalRecord: inspected.record,
        brokerEvidence: inspected.broker,
      });
    }
    ensureOwnerOnlyFile(artifactPath);

    const budgets = new BudgetStore(paths);
    const result = budgets.quarantineLinkedProviderHold({
      linkId: inspected.linkId,
      expectedDigest,
      resolution: input.resolution,
      actor,
      reason: "Explicit offline recovery of one inspected cross-provider linked hold.",
      quarantineArtifact: basename(artifactPath),
      auditEventId,
      zeroEgress,
    });
    return {
      ok: true,
      linkId: inspected.linkId,
      recordDigest: inspected.recordDigest,
      resolution: input.resolution,
      existing: result.existing,
      quarantineArtifact: artifactPath,
      auditEventId,
    };
  });
}

function inspectLocked(paths: ProjectStatePaths, linkId: string) {
  const raw = readRawBudgetState(paths);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Budget state is not an object.");
  const record = raw as Record<string, unknown>;
  if (record.version !== 4 || !Array.isArray(record.linkedHolds)) {
    throw new HeadlessError("CONFLICT", "Linked-hold recovery requires version-four budget state.");
  }
  const matches = record.linkedHolds.filter((candidate) => isRecord(candidate) && candidate.linkId === linkId);
  if (matches.length !== 1) throw new HeadlessError("CONFLICT", `Expected exactly one linked hold ${linkId}, found ${matches.length}.`);
  const target = matches[0]!;
  const otherHolds = record.linkedHolds.filter((candidate) => candidate !== target);
  // Strictly validate the outer envelope and every non-target entry. The one
  // reviewed target remains bounded by the owner-only file-size ceiling.
  BudgetStoreStateSchema.parse({ ...record, linkedHolds: otherHolds });
  const parsed = LinkedHoldRecordSchema.safeParse(target);
  const strictRecord = parsed.success ? parsed.data : null;
  const recordDigest = createHash("sha256").update(JSON.stringify(strictRecord ?? target)).digest("hex");
  const quotaStore = new DurableBrokerQuotaStore(paths, Date.now, { readOnly: true });
  const broker = new ProviderBroker({ initialLinkedOperations: quotaStore.linkedSnapshot() });
  const brokerEvidence = broker.linkedOperationSnapshot(linkId);
  return {
    version: 1,
    projectId: paths.projectId,
    linkId,
    recordDigest,
    state: strictRecord?.state ?? (isRecord(target) && typeof target.state === "string" ? target.state.slice(0, 64) : "invalid"),
    recoveryReason: strictRecord?.recoveryReason ?? null,
    record: strictRecord,
    invalidRecord: parsed.success ? null : {
      keys: isRecord(target) ? Object.keys(target).slice(0, 128).sort() : [],
      issue: parsed.error.issues[0]?.message ?? "invalid linked hold",
    },
    broker: brokerEvidence,
    zeroEgress: provesZeroEgress(brokerEvidence.target, strictRecord),
  };
}

async function withOfflineStateLock<T>(paths: ProjectStatePaths, operation: () => T | Promise<T>) {
  if (existsSync(paths.socketPath)) {
    if (await socketAcceptsConnections(paths.socketPath)) {
      throw new HeadlessError("DAEMON_ALREADY_RUNNING", "Offline linked-hold recovery refuses while a daemon owns the project state.");
    }
    rmSync(paths.socketPath, { force: true });
  }
  const server = createServer((socket) => socket.destroy());
  let bound = false;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(paths.socketPath, () => {
        bound = true;
        server.off("error", reject);
        resolve();
      });
    });
    chmodSync(paths.socketPath, 0o600);
    return await operation();
  } finally {
    if (bound) {
      await closeServer(server);
      rmSync(paths.socketPath, { force: true });
    }
  }
}

function readRawBudgetState(paths: ProjectStatePaths) {
  ensureOwnerOnlyFile(paths.budgetsPath);
  if (statSync(paths.budgetsPath).size > MAX_STORE_BYTES) throw new Error("Budget state exceeds its recovery byte limit.");
  return JSON.parse(readFileSync(paths.budgetsPath, "utf8")) as unknown;
}

function provesZeroEgress(
  operation: ReturnType<ProviderBroker["linkedOperationSnapshot"]>["target"],
  record: z.infer<typeof LinkedHoldRecordSchema> | null,
) {
  if (!operation) return record?.brokerEvidence.targetLeaseId === null;
  if (operation.kind !== "target") return false;
  const observation = operation.observation;
  return operation.phase !== "issued"
    ? observation.requests === 0 && observation.forwardedRequests === 0 && observation.activeRequests === 0
    : observation.requests === 0
      && observation.forwardedRequests === 0
      && observation.observedCostUsd === 0
      && observation.accountedCostUsd === 0
      && observation.accountedInputTokens === 0
      && observation.accountedOutputTokens === 0
      && observation.activeRequests === 0;
}

function assertStateOwner(paths: ProjectStatePaths) {
  if (typeof process.getuid !== "function") throw new HeadlessError("UNSUPPORTED_PLATFORM", "Offline linked-hold recovery requires POSIX ownership checks.");
  const owner = statSync(paths.projectDir).uid;
  const uid = process.getuid();
  if (uid !== 0 && owner !== uid) throw new HeadlessError("POLICY_DENIED", "Offline linked-hold recovery requires ownership of the external project state.");
}

function deterministicAuditEventId(linkId: string, recordDigest: string, resolution: string) {
  const hex = createHash("sha256").update(`linked-hold-recovery\0${linkId}\0${recordDigest}\0${resolution}`).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = "8";
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function localAdminPrincipal() {
  try {
    return `local:${userInfo().username}`.slice(0, 128);
  } catch {
    return `local:uid-${typeof process.getuid === "function" ? process.getuid() : "unknown"}`;
  }
}

function socketAcceptsConnections(path: string) {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection(path);
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}

function closeServer(server: Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
