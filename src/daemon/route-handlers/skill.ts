import type { DaemonFamilyHandlerRegistrations } from "../route-dispatcher";
import type { DaemonRouteContext } from "../route-context";

type SkillFamilies = Pick<DaemonFamilyHandlerRegistrations, "skill">;

export function skillRouteHandlers(context: DaemonRouteContext): SkillFamilies {
  return { skill: {
    "skill.list": () => context.listSkills(),
    "skill.inspect": (params) => context.inspectSkill(params.skill),
    "skill.import": (params, credential) => context.importSkill(params.source, credential.principal),
    "skill.enable": (params, credential) => context.enableSkill(params.skill, credential.principal),
    "skill.use": (params, credential) => context.useSkill(params, credential),
    "skill.revoke": (params) => context.revokeSkill(params.skill),
  } };
}
