import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AgentProfileSchema,
  FleetProfileSchema,
  type FleetProfile,
} from "../contracts/collaboration";
import { IdentifierSchema, ProjectIdSchema, TimestampSchema } from "../contracts/common";
import { readOwnerOnlyJson, writeOwnerOnlyJson } from "./owner-json";
import { ensureProjectStateDirectories, type ProjectStatePaths } from "./project-state";

const FleetProfileStoreStateSchema = z.object({
  version: z.literal(1),
  projectId: ProjectIdSchema,
  activeProfileId: IdentifierSchema.nullable(),
  profiles: z.array(FleetProfileSchema).max(256),
  updatedAt: TimestampSchema,
}).strict().superRefine((state, context) => {
  const ids = state.profiles.map((profile) => profile.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Fleet profile ids must be unique.", path: ["profiles"] });
  }
  if (state.profiles.some((profile) => profile.projectId !== state.projectId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Every fleet profile must belong to the store project.", path: ["profiles"] });
  }
  if (state.activeProfileId !== null && !state.profiles.some((profile) => profile.id === state.activeProfileId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "The active fleet profile must exist.", path: ["activeProfileId"] });
  }
});

type AgentDraft = Omit<z.input<typeof AgentProfileSchema>, "createdAt" | "updatedAt"> & {
  createdAt?: number;
  updatedAt?: number;
};

export type FleetProfileCreateInput = Omit<
  z.input<typeof FleetProfileSchema>,
  "id" | "projectId" | "agents" | "createdAt" | "updatedAt"
> & {
  id?: string;
  agents: AgentDraft[];
};

export type FleetProfileUpdate = Partial<Omit<FleetProfile, "id" | "projectId" | "createdAt" | "updatedAt">>;
export type FleetProfileStoreState = z.infer<typeof FleetProfileStoreStateSchema>;

export class FleetProfileStore {
  readonly projectId: string;
  readonly path: string;
  private state: FleetProfileStoreState;
  private readonly now: () => number;
  private readonly id: () => string;

  constructor(
    private readonly paths: ProjectStatePaths,
    options: { now?: () => number; id?: () => string } = {},
  ) {
    ensureProjectStateDirectories(paths);
    this.projectId = ProjectIdSchema.parse(paths.projectId);
    this.path = paths.fleetProfilesPath;
    this.now = options.now ?? Date.now;
    this.id = options.id ?? (() => `fleet_${randomUUID()}`);
    const existing = readOwnerOnlyJson(this.path, FleetProfileStoreStateSchema);
    if (existing) {
      if (existing.projectId !== this.projectId) {
        throw new Error(`Fleet profile project mismatch: expected ${this.projectId}, got ${existing.projectId}`);
      }
      this.state = existing;
      return;
    }
    this.state = FleetProfileStoreStateSchema.parse({
      version: 1,
      projectId: this.projectId,
      activeProfileId: null,
      profiles: [],
      updatedAt: this.now(),
    });
    this.persist();
  }

  create(input: FleetProfileCreateInput) {
    const at = this.now();
    const profile = FleetProfileSchema.parse({
      ...input,
      id: input.id ?? this.id(),
      projectId: this.projectId,
      agents: input.agents.map((agent) => ({
        ...agent,
        createdAt: agent.createdAt ?? at,
        updatedAt: agent.updatedAt ?? at,
      })),
      createdAt: at,
      updatedAt: at,
    });
    if (this.state.profiles.some((candidate) => candidate.id === profile.id)) {
      throw new Error(`Fleet profile already exists: ${profile.id}`);
    }
    this.state.profiles.push(profile);
    if (this.state.activeProfileId === null) this.state.activeProfileId = profile.id;
    this.state.updatedAt = at;
    this.persist();
    return cloneProfile(profile);
  }

  get(id: string) {
    const parsedId = IdentifierSchema.parse(id);
    const profile = this.state.profiles.find((candidate) => candidate.id === parsedId);
    return profile ? cloneProfile(profile) : null;
  }

  list() {
    return this.state.profiles
      .map(cloneProfile)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  }

  update(id: string, patch: FleetProfileUpdate | ((profile: FleetProfile) => FleetProfile)) {
    const current = this.require(id);
    const candidate = typeof patch === "function"
      ? patch(cloneProfile(current))
      : { ...current, ...patch };
    const next = FleetProfileSchema.parse({ ...candidate, updatedAt: this.now() });
    assertProfileIdentity(current, next);
    const index = this.state.profiles.findIndex((profile) => profile.id === current.id);
    this.state.profiles[index] = next;
    this.state.updatedAt = next.updatedAt;
    this.persist();
    return cloneProfile(next);
  }

  delete(id: string) {
    const current = this.require(id);
    this.state.profiles = this.state.profiles.filter((profile) => profile.id !== current.id);
    if (this.state.activeProfileId === current.id) this.state.activeProfileId = null;
    this.state.updatedAt = this.now();
    this.persist();
    return cloneProfile(current);
  }

  setActive(id: string | null) {
    if (id === null) {
      this.state.activeProfileId = null;
    } else {
      this.state.activeProfileId = this.require(id).id;
    }
    this.state.updatedAt = this.now();
    this.persist();
    return this.getActive();
  }

  getActive() {
    return this.state.activeProfileId === null ? null : this.get(this.state.activeProfileId);
  }

  snapshot(): FleetProfileStoreState {
    return structuredClone(FleetProfileStoreStateSchema.parse(this.state));
  }

  private require(id: string) {
    const profile = this.state.profiles.find((candidate) => candidate.id === IdentifierSchema.parse(id));
    if (!profile) throw new Error(`Unknown fleet profile: ${id}`);
    return profile;
  }

  private persist() {
    this.state = FleetProfileStoreStateSchema.parse(this.state);
    writeOwnerOnlyJson(this.path, this.state);
  }
}

function assertProfileIdentity(current: FleetProfile, next: FleetProfile) {
  if (
    next.id !== current.id
    || next.projectId !== current.projectId
    || next.createdAt !== current.createdAt
  ) {
    throw new Error("Fleet profile identity fields are immutable.");
  }
}

function cloneProfile(profile: FleetProfile) {
  return structuredClone(FleetProfileSchema.parse(profile));
}
