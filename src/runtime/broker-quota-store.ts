import { z } from "zod";
import {
  BrokerBudgetQuotaSchema,
  BrokerLinkedOperationSchema,
  type BrokerBudgetQuota,
  type BrokerLinkedOperation,
} from "../broker/server";
import { ProjectIdSchema, TimestampSchema } from "../contracts/common";
import type { ProjectStatePaths } from "./project-state";
import { readOwnerOnlyJson, writeOwnerOnlyJson } from "./owner-json";

const DurableBrokerQuotaSchema = BrokerBudgetQuotaSchema.extend({
  expiresAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();

const LegacyDurableBrokerQuotaStateSchema = z.object({
  version: z.literal(1),
  projectId: ProjectIdSchema,
  quotas: z.array(DurableBrokerQuotaSchema).max(10_000),
  updatedAt: TimestampSchema,
}).strict();

const DurableBrokerQuotaStateSchema = z.object({
  version: z.literal(2),
  projectId: ProjectIdSchema,
  quotas: z.array(DurableBrokerQuotaSchema).max(10_000),
  linkedOperations: z.array(BrokerLinkedOperationSchema).max(10_000),
  updatedAt: TimestampSchema,
}).strict();

const PersistedDurableBrokerQuotaStateSchema = z.union([
  LegacyDurableBrokerQuotaStateSchema,
  DurableBrokerQuotaStateSchema,
]);

export class DurableBrokerQuotaStore {
  private state: z.infer<typeof DurableBrokerQuotaStateSchema>;

  constructor(
    private readonly paths: ProjectStatePaths,
    private readonly now = Date.now,
    private readonly options: { readOnly?: boolean } = {},
  ) {
    const existing = readOwnerOnlyJson(paths.brokerQuotasPath, PersistedDurableBrokerQuotaStateSchema);
    if (existing && existing.projectId !== paths.projectId) throw new Error("Broker quota project identity mismatch.");
    this.state = existing?.version === 2 ? existing : DurableBrokerQuotaStateSchema.parse({
      ...(existing ?? {}),
      version: 2,
      projectId: paths.projectId,
      quotas: existing?.quotas ?? [],
      linkedOperations: [],
      updatedAt: existing?.updatedAt ?? this.now(),
    });
    if (!options.readOnly) {
      this.prune();
      this.persist();
    }
  }

  snapshot() {
    if (!this.options.readOnly) this.prune();
    return this.state.quotas.map(({ expiresAt, updatedAt, ...quota }) => BrokerBudgetQuotaSchema.parse(quota));
  }

  linkedSnapshot() {
    return this.state.linkedOperations.map((operation) => BrokerLinkedOperationSchema.parse(operation));
  }

  update(value: BrokerBudgetQuota, expiresAt?: number) {
    if (this.options.readOnly) throw new Error("Read-only broker quota store cannot be updated.");
    const quota = BrokerBudgetQuotaSchema.parse(value);
    const index = this.state.quotas.findIndex((candidate) => candidate.id === quota.id);
    const current = index < 0 ? null : this.state.quotas[index];
    const next = DurableBrokerQuotaSchema.parse({
      ...quota,
      expiresAt: Math.max(expiresAt ?? 0, current?.expiresAt ?? 0, this.now() + 60_000),
      updatedAt: this.now(),
    });
    if (index < 0) this.state.quotas.push(next);
    else this.state.quotas[index] = next;
    this.prune();
    this.state.updatedAt = this.now();
    this.persist();
  }

  updateLinkedOperation(value: BrokerLinkedOperation) {
    if (this.options.readOnly) throw new Error("Read-only broker quota store cannot be updated.");
    const operation = BrokerLinkedOperationSchema.parse(value);
    const index = this.state.linkedOperations.findIndex((candidate) => candidate.operationId === operation.operationId);
    if (index < 0) {
      if (this.state.linkedOperations.length >= 10_000) throw new Error("Durable linked broker operation retention limit is exhausted.");
      this.state.linkedOperations.push(operation);
    } else {
      this.state.linkedOperations[index] = operation;
    }
    this.state.updatedAt = this.now();
    this.persist();
  }

  private prune() {
    const now = this.now();
    this.state.quotas = this.state.quotas.filter((quota) => quota.expiresAt > now);
  }

  private persist() {
    writeOwnerOnlyJson(this.paths.brokerQuotasPath, DurableBrokerQuotaStateSchema.parse(this.state));
  }
}
