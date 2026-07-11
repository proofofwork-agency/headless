import { z } from "zod";

export const GROK_BUILTIN_AGENT_NAMES = ["plan", "build", "review", "general"] as const;

export function isBackendAgentName(value: string, backend?: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_:@-]{0,255}$/.test(value)) return false;
  const grok = backend?.toLowerCase() === "grok" || backend?.toLowerCase() === "grok-build";
  return !grok || GROK_BUILTIN_AGENT_NAMES.some((name) => name === value);
}

export const AgentNameSchema = z.string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => isBackendAgentName(value), "Agent must be a name, not a definition path or flag.");

export function backendAgentSelectionRefinement(
  selection: { backend?: unknown; agent?: unknown },
  context: z.RefinementCtx,
) {
  if (
    typeof selection.backend === "string"
    && typeof selection.agent === "string"
    && !isBackendAgentName(selection.agent, selection.backend)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["agent"],
      message: `Backend ${selection.backend} does not permit that named agent.`,
    });
  }
}
