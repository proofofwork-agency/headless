import { COMMAND_SPECS, type CliCommandName } from "./command-specs";
import { POSITIONAL_GRAMMAR, type PositionalGrammar } from "./positional-grammar";

export type AuditStatus = "PASS" | "FAIL" | "BLOCKED" | "EXPECTED_REJECTION" | "DEFERRED";

export type CliAuditCase = {
  id: string;
  command: CliCommandName;
  argv: readonly string[];
  description: string;
  expected: AuditStatus;
  risk: "safe" | "cost" | "destructive";
};

/**
 * Which operand values are worth auditing is the only genuinely audit-specific
 * part of a subcommand row: the grammar declares that `mcp install` takes a
 * host, not which hosts this inventory should enumerate.
 */
const MCP_HOSTS = ["codex", "grok", "claude", "opencode"] as const;
const AUDIT_OPERANDS: Readonly<Record<string, readonly string[]>> = {
  "mcp install": MCP_HOSTS,
  "mcp remove": MCP_HOSTS,
  "mcp status": MCP_HOSTS,
};

/**
 * Every action path the grammar declares, deepest-first, as space-joined
 * subcommands: `trust grant`, `linked-hold quarantine`, `reap`.
 *
 * Derived rather than hand-listed because the hand-listed catalog was a second
 * source of truth and had already drifted: `lead` and `receipt` had no rows at
 * all, `daemon` was missing reap, and `mcp` was missing the server alias — all
 * four invisible to a coverage test that only compared command names.
 */
function grammarActionPaths(grammar: PositionalGrammar, prefix: readonly string[] = []): string[][] {
  if (grammar.kind !== "actions") return prefix.length ? [[...prefix]] : [];
  return Object.entries(grammar.actions).flatMap(([action, child]) => grammarActionPaths(child, [...prefix, action]));
}

function subcommandsFor(command: CliCommandName): string[] {
  const grammar = POSITIONAL_GRAMMAR[command];
  if (!grammar) return [];
  return grammarActionPaths(grammar).flatMap((path) => {
    const joined = path.join(" ");
    const operands = AUDIT_OPERANDS[`${command} ${joined}`];
    return operands ? operands.map((operand) => `${joined} ${operand}`) : [joined];
  });
}

/**
 * Subcommands that only READ. This is an allowlist on purpose: the previous
 * shape was a chain of "destructive" arms over `return "safe"`, so any
 * subcommand nobody remembered to name inherited "safe" by omission. That is
 * how `daemon stop`, every cancel/pause/resume, transfer-synthesizer, the
 * workflow draft mutators, `autonomy off/stop` and `loop start` all ended up
 * classified as reads. A comment saying the fallback "is not silent" did not
 * change that it was.
 *
 * Inverting it makes the failure mode conservative: a new subcommand is
 * destructive until someone deliberately lists it here as a read.
 */
const READ_ONLY_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  lead: ["status"],
  daemon: ["status"],
  mcp: ["serve", "server", "status", "status codex", "status grok", "status claude", "status opencode"],
  budget: ["list", "linked-hold inspect"],
  ledger: ["verify"],
  receipt: ["list", "show", "export", "verify", "diff"],
  collaboration: ["turns", "messages"],
  approval: ["list"],
  candidate: ["inspect"],
  session: ["status", "result"],
  goal: ["list", "follow", "status", "result"],
  workflow: ["list", "status", "wait", "validate", "draft-list", "draft-get"],
  autonomy: ["status"],
  loop: ["list", "status"],
  skill: ["list", "inspect"],
  fleet: ["health", "profile get", "profile list"],
  project: ["trust status"],
};

/** Subcommands that spend provider quota rather than mutating local state. */
const COST_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  session: ["create", "send", "resume"],
  goal: ["start", "run", "send"],
  workflow: ["run", "draft-launch"],
  autonomy: ["on", "start", "ask", "more", "ask-for-work", "backup"],
  loop: ["start"],
};

/** Read-only inventory used by the black-box audit and CI coverage checks. */
export const CLI_AUDIT_MANIFEST: readonly CliAuditCase[] = COMMAND_SPECS.flatMap((spec) => {
  const aliases = "aliases" in spec ? spec.aliases : [];
  const rows: CliAuditCase[] = [{
    id: spec.name,
    command: spec.name,
    argv: [spec.name],
    description: `canonical ${spec.name} invocation`,
    expected: "DEFERRED",
    risk: commandRisk(spec.name),
  }];
  for (const alias of aliases) rows.push({ id: alias, command: spec.name, argv: [alias], description: `alias for ${spec.name}`, expected: "DEFERRED", risk: commandRisk(spec.name) });
  for (const subcommand of subcommandsFor(spec.name)) rows.push({
    id: `${spec.name}:${subcommand}`,
    command: spec.name,
    argv: [spec.name, ...subcommand.split(" ")],
    description: `${spec.name} ${subcommand} subcommand`,
    expected: "DEFERRED",
    risk: subcommandRisk(spec.name, subcommand),
  });
  return rows;
});

function commandRisk(command: CliCommandName): CliAuditCase["risk"] {
  if (["exec", "launch", "council"].includes(command)) return "cost";
  if (["init", "setup", "daemon", "project", "fleet", "candidate", "gate", "mcp"].includes(command)) return "destructive";
  if (command === "session" || command === "goal" || command === "workflow" || command === "orchestrate" || command === "autonomy") return "cost";
  if (command === "skill") return "destructive";
  if (command === "budget") return "destructive";
  if (command === "loop") return "cost";
  return "safe";
}

function subcommandRisk(command: CliCommandName, subcommand: string): CliAuditCase["risk"] {
  if ((READ_ONLY_SUBCOMMANDS[command] ?? []).includes(subcommand)) return "safe";
  if ((COST_SUBCOMMANDS[command] ?? []).includes(subcommand)) return "cost";
  if (["exec", "launch", "council", "orchestrate"].includes(command)) return "cost";
  // Conservative fallback. Overstating a read as destructive is a review
  // annoyance; understating a mutation is the defect this replaced.
  return "destructive";
}

export function auditManifestCommands() {
  return new Set(CLI_AUDIT_MANIFEST.map((entry) => entry.command));
}
