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
  if (command === "mcp") return /^(install|remove)(?: |$)/.test(subcommand) ? "destructive" : "safe";
  if (command === "budget") return subcommand === "upsert" || subcommand === "linked-hold quarantine" ? "destructive" : "safe";
  if (command === "ledger") return subcommand === "repair-tail" ? "destructive" : "safe";
  if (command === "collaboration" && (subcommand === "ack" || subcommand === "acknowledge")) return "destructive";
  if (command === "approval" && subcommand === "resolve") return "destructive";
  if (command === "candidate" && (subcommand === "integrate" || subcommand === "reject")) return "destructive";
  if (command === "project" || command === "fleet") return "destructive";
  // reap kills resident daemons; use/release rewrite the configured foreground
  // lead. Both were unreachable while the catalog was hand-maintained.
  if (command === "daemon") return ["serve", "start", "reap"].includes(subcommand) ? "destructive" : "safe";
  if (command === "lead") return subcommand === "status" ? "safe" : "destructive";
  if (["exec", "launch", "council"].includes(command)) return "cost";
  if (["session", "goal", "workflow"].includes(command) && ["create", "send", "resume", "run", "start"].includes(subcommand)) return "cost";
  if (command === "autonomy" && ["on", "start"].includes(subcommand)) return "cost";
  if (command === "orchestrate") return "cost";
  return "safe";
}

export function auditManifestCommands() {
  return new Set(CLI_AUDIT_MANIFEST.map((entry) => entry.command));
}
