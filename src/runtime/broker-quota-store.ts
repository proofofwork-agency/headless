import { z } from "zod";
import { BrokerBudgetQuotaSchema, type BrokerBudgetQuota } from "../broker/server";
import { ProjectIdSchema, TimestampSchema } from "../contracts/common";
import type { ProjectStatePaths } from "./project-state";
import { readOwnerOnlyJson, writeOwnerOnlyJson } from "./owner-json";

const DurableBrokerQuotaSchema = BrokerBudgetQuotaSchema.extend({
  expiresAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).strict();

const DurableBrokerQuotaStateSchema = z.object({
  version: z.literal(1),
  projectId: ProjectIdSchema,
  quotas: z.array(DurableBrokerQuotaSchema).max(10_000),
  updatedAt: TimestampSchema,
}).strict();

export class DurableBrokerQuotaStore {
  private state: z.infer<typeof DurableBrokerQuotaStateSchema>;

  constructor(private readonly paths: ProjectStatePaths, private readonly now = Date.now) {
    const existing = readOwnerOnlyJson(paths.brokerQuotasPath, DurableBrokerQuotaStateSchema);
    if (existing && existing.projectId !== paths.projectId) throw new Error("Broker quota project identity mismatch.");
    this.state = existing ?? DurableBrokerQuotaStateSchema.parse({
      version: 1,
      projectId: paths.projectId,
      quotas: [],
      updatedAt: this.now(),
    });
    this.prune();
    this.persist();
  }

  snapshot() {
    this.prune();
    return this.state.quotas.map(({ expiresAt, updatedAt, ...quota }) => BrokerBudgetQuotaSchema.parse(quota));
  }

  update(value: BrokerBudgetQuota, expiresAt?: number) {
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

  private prune() {
    const now = this.now();
    this.state.quotas = this.state.quotas.filter((quota) => quota.expiresAt > now);
  }

  private persist() {
    writeOwnerOnlyJson(this.paths.brokerQuotasPath, DurableBrokerQuotaStateSchema.parse(this.state));
  }
}
