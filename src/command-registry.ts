import { COMMAND_SPECS } from "./cli/command-specs";

export const COMMAND_REGISTRY_VERSION = 1 as const;

export type RegistryRisk = "safe" | "confirm";
export const UNIFIED_COMMAND_REGISTRY = {
  version: COMMAND_REGISTRY_VERSION,
  cli: COMMAND_SPECS.map((source) => ({
    stableId: `cli.${source.name}`,
    aliases: "aliases" in source ? source.aliases : [],
    surfaces: ["cli"] as const,
    argumentSchema: { valueFlags: "valueFlags" in source ? source.valueFlags : [] },
    examples: "help" in source ? [source.help] : [],
    description: "help" in source ? source.help : source.name,
    category: "cli",
    applicability: "always",
    unavailableReason: null,
    recovery: null,
    risk: "safe" as RegistryRisk,
    confirmation: "existing-handler",
    executionTarget: source.name,
    source,
  })),
} as const;
