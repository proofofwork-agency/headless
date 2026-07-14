import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LoopPolicySchema, LoopRecordSchema, type LoopPolicy } from "../contracts/loop";
import type { ProjectStatePaths } from "./project-state";
import { readOwnerOnlyJson, writeOwnerOnlyJson } from "./owner-json";

export class LoopStore {
  constructor(private readonly paths: ProjectStatePaths) {}
  create(policy: LoopPolicy, principal: string) {
    const now = Date.now();
    const loop = LoopRecordSchema.parse({ version: 1, id: randomUUID(), projectId: this.paths.projectId, principal, policy: LoopPolicySchema.parse(policy), state: "queued", iterations: [], usedCostUsd: 0, usedRequests: 0, nextRunAt: null, lastObservedAt: now, createdAt: now, updatedAt: now });
    this.write(loop); return loop;
  }
  get(id: string) { return existsSync(this.path(id)) ? readOwnerOnlyJson(this.path(id), LoopRecordSchema) : null; }
  list() { return readdirSync(this.paths.loopsDir).filter((name) => name.endsWith(".json")).flatMap((name) => { const loop = this.get(name.slice(0, -5)); return loop ? [loop] : []; }).sort((a, b) => b.updatedAt - a.updatedAt); }
  update(id: string, change: (loop: NonNullable<ReturnType<LoopStore["get"]>>) => void) { const loop = this.get(id); if (!loop) throw new Error(`Unknown loop: ${id}`); change(loop); loop.updatedAt = Date.now(); this.write(loop); return loop; }
  private write(loop: NonNullable<ReturnType<LoopStore["get"]>>) { writeOwnerOnlyJson(this.path(loop.id), LoopRecordSchema.parse(loop)); }
  private path(id: string) { if (!/^[a-zA-Z0-9-]{1,160}$/.test(id)) throw new Error("Invalid loop id."); return join(this.paths.loopsDir, `${id}.json`); }
}
