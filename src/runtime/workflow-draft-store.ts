import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { IdentifierSchema, PrincipalIdSchema, ProjectIdSchema, TimestampSchema } from "../contracts/common";
import type { ProjectStatePaths } from "./project-state";
import { ensureOwnerOnlyDirectory } from "./project-state";
import { readOwnerOnlyJson, writeOwnerOnlyJson } from "./owner-json";

const WorkflowDraftSchema = z.object({ version: z.literal(1), id: IdentifierSchema, projectId: ProjectIdSchema, principal: PrincipalIdSchema, definition: z.record(z.unknown()), state: z.enum(["draft", "launched"]), workflowId: IdentifierSchema.nullable(), createdAt: TimestampSchema, updatedAt: TimestampSchema }).strict();
export type WorkflowDraft = z.infer<typeof WorkflowDraftSchema>;

export class WorkflowDraftStore {
  private readonly directory;
  constructor(private readonly paths: ProjectStatePaths) { this.directory = ensureOwnerOnlyDirectory(join(paths.workflowsDir, "drafts")); }
  create(definition: Record<string, unknown>, principal: string) { const now = Date.now(); const draft = WorkflowDraftSchema.parse({ version: 1, id: `draft_${randomUUID()}`, projectId: this.paths.projectId, principal, definition, state: "draft", workflowId: null, createdAt: now, updatedAt: now }); this.write(draft); return draft; }
  get(id: string) { return existsSync(this.path(id)) ? readOwnerOnlyJson(this.path(id), WorkflowDraftSchema) : null; }
  list() { return readdirSync(this.directory).filter((name) => name.endsWith(".json")).flatMap((name) => { const draft = this.get(name.slice(0, -5)); return draft ? [draft] : []; }).sort((a, b) => b.updatedAt - a.updatedAt); }
  launched(id: string, workflowId: string) { const draft = this.get(id); if (!draft) throw new Error(`Unknown workflow draft: ${id}`); draft.state = "launched"; draft.workflowId = workflowId; draft.updatedAt = Date.now(); this.write(draft); return draft; }
  private write(draft: WorkflowDraft) { writeOwnerOnlyJson(this.path(draft.id), WorkflowDraftSchema.parse(draft)); }
  private path(id: string) { if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error("Invalid workflow draft id."); return join(this.directory, `${id}.json`); }
}
