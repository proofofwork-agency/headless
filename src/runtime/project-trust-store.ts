import { existsSync } from "node:fs";
import { ProjectTrustSchema, type ProjectTrust } from "../contracts/native";
import type { ProjectStatePaths } from "./project-state";
import { readOwnerOnlyJson, writeOwnerOnlyJson } from "./owner-json";
import { HeadlessError } from "./headless-error";

export class ProjectTrustStore {
  constructor(private readonly paths: ProjectStatePaths) {}

  status(): ProjectTrust {
    if (!existsSync(this.paths.projectTrustPath)) return this.defaultState();
    return readOwnerOnlyJson(this.paths.projectTrustPath, ProjectTrustSchema) ?? this.defaultState();
  }

  grant(input: {
    principal: string;
    nativeLoginAllowed?: boolean;
    nativeDirectUnrestrictedAcknowledged?: boolean;
    bypassAllowed?: boolean;
  }) {
    const nativeLoginAllowed = input.nativeLoginAllowed ?? false;
    const nativeDirectUnrestrictedAcknowledged = input.nativeDirectUnrestrictedAcknowledged ?? false;
    if (nativeLoginAllowed && !nativeDirectUnrestrictedAcknowledged) {
      throw new HeadlessError(
        "APPROVAL_REQUIRED",
        "Native login requires explicit acknowledgement that provider egress is unrestricted by destination IP.",
      );
    }
    const now = Date.now();
    const state = ProjectTrustSchema.parse({
      version: 1,
      projectId: this.paths.projectId,
      trusted: true,
      nativeLoginAllowed,
      nativeDirectUnrestrictedAcknowledged,
      bypassAllowed: input.bypassAllowed ?? false,
      trustedBy: input.principal,
      trustedAt: now,
      revokedAt: null,
    });
    this.write(state);
    return state;
  }

  revoke() {
    const previous = this.status();
    const state = ProjectTrustSchema.parse({
      ...previous,
      trusted: false,
      nativeLoginAllowed: false,
      nativeDirectUnrestrictedAcknowledged: false,
      bypassAllowed: false,
      revokedAt: Date.now(),
    });
    this.write(state);
    return state;
  }

  assertNativeLoginAllowed(approvalPolicy: "ask" | "auto" | "bypass") {
    const state = this.status();
    if (!state.trusted || !state.nativeLoginAllowed || !state.nativeDirectUnrestrictedAcknowledged) {
      throw new HeadlessError("NATIVE_AUTH_UNAVAILABLE", "Native login requires project trust and explicit acknowledgement of unrestricted provider egress.");
    }
    if (approvalPolicy === "bypass" && !state.bypassAllowed) {
      throw new HeadlessError("APPROVAL_REQUIRED", "Approval bypass is not trusted for this project.");
    }
    return state;
  }

  private defaultState() {
    return ProjectTrustSchema.parse({
      version: 1,
      projectId: this.paths.projectId,
      trusted: false,
      nativeLoginAllowed: false,
      nativeDirectUnrestrictedAcknowledged: false,
      bypassAllowed: false,
      trustedBy: null,
      trustedAt: null,
      revokedAt: null,
    });
  }

  private write(state: ProjectTrust) {
    writeOwnerOnlyJson(this.paths.projectTrustPath, ProjectTrustSchema.parse(state));
  }
}
