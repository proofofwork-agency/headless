import { z } from "zod";
import { BackendIdSchema, PrincipalIdSchema, ProjectIdSchema, TimestampSchema } from "../contracts/common";
import { HeadlessError } from "./headless-error";
import { readOwnerOnlyJson, writeOwnerOnlyJson } from "./owner-json";
import { ensureProjectStateDirectories, type ProjectStatePaths } from "./project-state";

export const LeadHostSchema = z.string().trim().toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);

export const LeadBindingSchema = z.object({
  host: LeadHostSchema,
  backendId: BackendIdSchema,
  integrationPrincipal: PrincipalIdSchema,
  generation: z.number().int().positive(),
  status: z.enum(["configured", "connected", "disconnected"]),
  configuredAt: TimestampSchema,
  attachedAt: TimestampSchema.nullable(),
  lastSeenAt: TimestampSchema.nullable(),
}).strict();

const LeadBindingStateSchema = z.object({
  version: z.literal(1),
  projectId: ProjectIdSchema,
  generation: z.number().int().nonnegative(),
  binding: LeadBindingSchema.nullable(),
  updatedAt: TimestampSchema,
}).strict();

export type LeadBinding = z.infer<typeof LeadBindingSchema>;

export class LeadBindingStore {
  private state: z.infer<typeof LeadBindingStateSchema>;

  constructor(
    private readonly paths: ProjectStatePaths,
    private readonly now: () => number = Date.now,
  ) {
    ensureProjectStateDirectories(paths);
    this.state = readOwnerOnlyJson(paths.leadBindingPath, LeadBindingStateSchema) ?? LeadBindingStateSchema.parse({
      version: 1,
      projectId: paths.projectId,
      generation: 0,
      binding: null,
      updatedAt: this.now(),
    });
    if (this.state.projectId !== paths.projectId) throw new Error("Lead binding belongs to another project.");
    this.persist();
  }

  status() {
    this.expireStaleConnection();
    return this.state.binding ? structuredClone(this.state.binding) : null;
  }

  nextGeneration() {
    return this.state.generation + 1;
  }

  use(input: { host: string; backendId: string; integrationPrincipal: string; generation: number }) {
    const now = this.now();
    if (input.generation !== this.nextGeneration()) throw new HeadlessError("CONFLICT", "Lead generation changed while the credential was being rotated.");
    this.state.generation = input.generation;
    this.state.binding = LeadBindingSchema.parse({
      ...input,
      status: "configured",
      configuredAt: now,
      attachedAt: null,
      lastSeenAt: null,
    });
    this.state.updatedAt = now;
    this.persist();
    return this.status()!;
  }

  attach(principal: string, generation: number) {
    const binding = this.requireCurrent(principal, generation);
    const now = this.now();
    binding.status = "connected";
    binding.attachedAt ??= now;
    binding.lastSeenAt = now;
    this.state.updatedAt = now;
    this.persist();
    return this.status()!;
  }

  heartbeat(principal: string, generation: number) {
    const binding = this.requireCurrent(principal, generation);
    if (binding.status !== "connected") throw new HeadlessError("CONFLICT", "The foreground lead must attach before heartbeating.");
    binding.lastSeenAt = this.now();
    this.state.updatedAt = binding.lastSeenAt;
    this.persist();
    return this.status()!;
  }

  disconnect(principal: string, generation: number) {
    const binding = this.requireCurrent(principal, generation);
    binding.status = "disconnected";
    binding.lastSeenAt = this.now();
    this.state.updatedAt = binding.lastSeenAt;
    this.persist();
    return this.status()!;
  }

  release() {
    const previous = this.status();
    this.state.generation += 1;
    this.state.binding = null;
    this.state.updatedAt = this.now();
    this.persist();
    return previous;
  }

  assertCurrent(principal: string, generation?: number) {
    this.expireStaleConnection();
    const binding = this.state.binding;
    if (!binding || binding.integrationPrincipal !== principal || (generation !== undefined && binding.generation !== generation)) {
      throw new HeadlessError("POLICY_DENIED", "This foreground-lead credential generation is no longer active.");
    }
    return structuredClone(binding);
  }

  private requireCurrent(principal: string, generation: number) {
    this.assertCurrent(principal, generation);
    return this.state.binding!;
  }

  private expireStaleConnection() {
    const binding = this.state.binding;
    if (binding?.status !== "connected" || binding.lastSeenAt === null) return;
    const now = this.now();
    if (now - binding.lastSeenAt <= 45_000) return;
    binding.status = "disconnected";
    this.state.updatedAt = now;
    this.persist();
  }

  private persist() {
    this.state = LeadBindingStateSchema.parse(this.state);
    writeOwnerOnlyJson(this.paths.leadBindingPath, this.state);
  }
}

export function leadCredentialName(host: string, generation: number) {
  return `lead-${LeadHostSchema.parse(host)}-g${generation}`;
}
