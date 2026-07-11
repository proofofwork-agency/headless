import { join } from "node:path";
import { z } from "zod";
import type { ProjectStatePaths } from "./project-state";
import { readOwnerOnlyJson, writeOwnerOnlyJson } from "./owner-json";

const OrchestrationStateSchema = z.object({
  version: z.literal(2),
  projectId: z.string().regex(/^[a-f0-9]{64}$/),
  enabled: z.boolean(),
  processedEventIds: z.array(z.string().uuid()).max(10_000),
  updatedAt: z.number().int().nonnegative(),
}).strict();

export class OrchestrationStateStore {
  private readonly path: string;
  private state: z.infer<typeof OrchestrationStateSchema>;

  constructor(paths: ProjectStatePaths) {
    this.path = join(paths.projectDir, "orchestration.json");
    this.state = readOwnerOnlyJson(this.path, OrchestrationStateSchema) ?? {
      version: 2,
      projectId: paths.projectId,
      enabled: false,
      processedEventIds: [],
      updatedAt: Date.now(),
    };
    if (this.state.projectId !== paths.projectId) throw new Error("Orchestration state project mismatch.");
    this.persist();
  }

  get() {
    return { ...this.state, processedEventIds: [...this.state.processedEventIds] };
  }

  setEnabled(enabled: boolean) {
    this.state.enabled = enabled;
    this.state.updatedAt = Date.now();
    this.persist();
    return this.get();
  }

  markProcessed(eventId: string) {
    if (!this.state.processedEventIds.includes(eventId)) this.state.processedEventIds.push(eventId);
    if (this.state.processedEventIds.length > 10_000) this.state.processedEventIds.splice(0, this.state.processedEventIds.length - 10_000);
    this.state.updatedAt = Date.now();
    this.persist();
  }

  private persist() {
    this.state = OrchestrationStateSchema.parse(this.state);
    writeOwnerOnlyJson(this.path, this.state);
  }
}
