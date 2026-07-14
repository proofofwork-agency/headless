import { COMMAND_SPECS, type CliCommandName } from "./command-specs";

export type AuditStatus = "PASS" | "FAIL" | "BLOCKED" | "EXPECTED_REJECTION" | "DEFERRED";

export type CliAuditCase = {
  id: string;
  command: CliCommandName;
  argv: readonly string[];
  description: string;
  expected: AuditStatus;
  risk: "safe" | "cost" | "destructive";
};

const subcommands: Partial<Record<CliCommandName, readonly string[]>> = {
  daemon: ["serve", "start", "status"],
  project: ["trust status", "trust grant", "trust revoke"],
  fleet: ["health", "profile upsert", "profile get", "profile list", "profile remove"],
  goal: ["start", "run", "send", "follow", "status", "list", "cancel", "result"],
  collaboration: ["turns", "messages", "acknowledge", "ack", "transfer-synthesizer"],
  approval: ["list", "resolve"],
  candidate: ["inspect", "integrate", "reject"],
  session: ["create", "send", "resume", "cancel", "status", "result"],
  workflow: ["run", "validate", "draft-create", "draft-list", "draft-get", "draft-launch", "list", "status", "wait", "pause", "resume", "cancel"],
  autonomy: ["on", "start", "off", "stop", "status", "ask", "more", "ask-for-work", "backup"],
  mcp: ["serve", "install codex", "install grok", "install claude", "install opencode", "remove codex", "remove grok", "remove claude", "remove opencode", "status codex", "status grok", "status claude", "status opencode"],
  skill: ["list", "inspect", "import", "enable", "use", "revoke"],
  loop: ["start", "list", "status", "pause", "resume", "cancel"],
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
  for (const subcommand of subcommands[spec.name] ?? []) rows.push({
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
  if (["init", "daemon", "project", "fleet", "candidate", "gate", "mcp"].includes(command)) return "destructive";
  if (command === "session" || command === "goal" || command === "workflow" || command === "orchestrate" || command === "autonomy") return "cost";
  if (command === "skill") return "destructive";
  if (command === "loop") return "cost";
  return "safe";
}

function subcommandRisk(command: CliCommandName, subcommand: string): CliAuditCase["risk"] {
  if (command === "mcp") return subcommand.endsWith(" codex") ? "destructive" : "safe";
  if (command === "collaboration" && (subcommand === "ack" || subcommand === "acknowledge")) return "destructive";
  if (command === "approval" && subcommand === "resolve") return "destructive";
  if (command === "candidate" && (subcommand === "integrate" || subcommand === "reject")) return "destructive";
  if (command === "project" || command === "fleet") return "destructive";
  if (command === "daemon" && (subcommand === "serve" || subcommand === "start")) return "destructive";
  if (["exec", "launch", "council"].includes(command)) return "cost";
  if (["session", "goal", "workflow"].includes(command) && ["create", "send", "resume", "run", "start"].includes(subcommand)) return "cost";
  if (command === "autonomy" && ["on", "start"].includes(subcommand)) return "cost";
  if (command === "orchestrate") return "cost";
  return "safe";
}

export function auditManifestCommands() {
  return new Set(CLI_AUDIT_MANIFEST.map((entry) => entry.command));
}
