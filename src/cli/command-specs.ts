export type CliCommandSpec<Name extends string = string> = {
  name: Name;
  aliases?: readonly string[];
  valueFlags?: readonly string[];
  help?: string;
};

/**
 * The single command/flag catalog used by dispatch, prompt parsing, and help.
 * Hidden compatibility commands omit `help` but remain explicit here.
 */
export const COMMAND_SPECS = [
  {
    name: "exec",
    aliases: ["run"],
    valueFlags: ["--backend", "--model", "--agent", "--session-id", "--timeout-ms", "--cwd", "--extension-config", "--extension-module", "--mode", "--auth-mode", "--approval-policy"],
    help: 'exec | run [--backend id] [--mode read-only|write] [--model m] [--agent a] [--session-id id] [--timeout-ms n] [--cwd dir] [--extension-config /absolute/trusted.json] [--json] [--stream] [--require-sandbox|--unsafe-no-sandbox] "prompt"',
  },
  {
    name: "daemon",
    valueFlags: ["--cwd", "--extension-config", "--extension-module"],
    help: "daemon <serve|status> [--cwd dir] [--extension-config /absolute/trusted.json]",
  },
  {
    name: "project",
    valueFlags: ["--cwd", "--extension-config", "--extension-module"],
    help: "project trust <status|grant|revoke> [--allow-bypass] [--deny-native-login] [--cwd dir]",
  },
  {
    name: "fleet",
    valueFlags: ["--profile-id", "--file", "--auth-mode", "--approval-policy", "--cwd", "--extension-config", "--extension-module"],
    help: "fleet <health|profile upsert|get|list|remove> [--profile-id id] [--file profile.json] [--auth-mode native-login|broker] [--approval-policy ask|auto|bypass]",
  },
  {
    name: "goal",
    valueFlags: ["--goal-id", "--fleet-profile-id", "--coordinator", "--mode", "--auth-mode", "--approval-policy", "--timeout-ms", "--cwd", "--extension-config", "--extension-module"],
    help: "goal <start|run|send|follow|status|list|cancel|result> [--goal-id id] [--mode read-only|write] [--auth-mode native-login|broker] [--approval-policy ask|auto|bypass] [--detach] [--timeout-ms n]",
  },
  {
    name: "collaboration",
    valueFlags: ["--goal-id", "--after-sequence", "--limit", "--agent-id", "--message-id", "--cwd", "--extension-config", "--extension-module"],
    help: "collaboration <turns|messages|acknowledge|transfer-leader> --goal-id id [--message-id id ...] [--retain]",
  },
  {
    name: "approval",
    valueFlags: ["--goal-id", "--status", "--approval-id", "--decision", "--resolution", "--cwd", "--extension-config", "--extension-module"],
    help: "approval <list|resolve> [--goal-id id] [--approval-id id --decision approved|rejected --resolution text]",
  },
  {
    name: "candidate",
    valueFlags: ["--candidate-id", "--cwd", "--extension-config", "--extension-module"],
    help: "candidate <inspect|integrate|reject> --candidate-id id",
  },
  {
    name: "session",
    valueFlags: ["--backend", "--model", "--agent", "--session-id", "--timeout-ms", "--cwd", "--extension-config", "--extension-module", "--auth-mode", "--approval-policy"],
    help: "session <create|send|resume|cancel|status|result> [options]",
  },
  {
    name: "workflow",
    valueFlags: ["--file", "--workflow-id", "--timeout-ms", "--auth-mode", "--approval-policy", "--cwd", "--extension-config", "--extension-module"],
    help: "workflow <run|list|status|wait|cancel> [--file workflow.json|--workflow-id id] [--auth-mode native-login|broker] [--approval-policy ask|auto|bypass] [--timeout-ms n]",
  },
  {
    name: "events",
    valueFlags: ["--limit", "--session-id", "--cwd", "--extension-config", "--extension-module"],
    help: "events [--follow] [--pretty] [--limit n] [--session-id id] [--cwd dir]",
  },
  {
    name: "autonomy",
    valueFlags: ["--cwd", "--extension-config", "--extension-module"],
    help: "autonomy <start|stop|status|ask|backup> [--cwd dir]",
  },
  {
    name: "orchestrate",
    valueFlags: ["--cwd", "--extension-config", "--extension-module"],
    help: "orchestrate [--cwd dir]",
  },
  {
    name: "council",
    valueFlags: ["--agent", "--mode", "--timeout-ms", "--auth-mode", "--approval-policy", "--cwd", "--extension-config", "--extension-module"],
    help: 'council [--agent backend ...] [--mode read-only|write] [--auth-mode native-login|broker] [--approval-policy ask|auto|bypass] [--timeout-ms n] "question"',
  },
  {
    name: "gate",
    aliases: ["release-gate"],
    valueFlags: ["--check", "--timeout-ms", "--session-id", "--cwd", "--extension-config", "--extension-module"],
    help: "gate [--check check|build|test|pack] [--timeout-ms n] [--cwd dir]",
  },
  {
    name: "init",
    valueFlags: ["--cwd", "--extension-config", "--extension-module"],
    help: "init [--cwd dir]                 Initialize external per-project state without modifying the checkout.",
  },
  {
    name: "status",
    valueFlags: ["--session-id", "--cwd", "--extension-config", "--extension-module"],
    help: "status | doctor | tui | pair",
  },
  { name: "doctor", valueFlags: ["--cwd", "--extension-config", "--extension-module"] },
  { name: "tui", valueFlags: ["--cwd"] },
  { name: "pair", valueFlags: ["--session-id", "--cwd", "--extension-config", "--extension-module"] },
  {
    name: "mcp",
    help: "mcp <serve|install|remove|status> [codex|grok|claude|opencode]",
  },
  {
    name: "launch",
    valueFlags: ["--timeout-ms", "--cwd", "--extension-config", "--extension-module", "--auth-mode", "--approval-policy"],
    help: "launch <backend> [options]        Compatibility one-shot routed through the daemon.",
  },
  {
    name: "ask",
    aliases: ["ask-for-work", "ask-for-more-work"],
    valueFlags: ["--strength", "--completed", "--session-id", "--cwd", "--extension-config", "--extension-module"],
  },
  { name: "coop-proof", aliases: ["autonomy-coop-proof"] },
] as const satisfies readonly CliCommandSpec[];

export type CliCommandName = typeof COMMAND_SPECS[number]["name"];

export const VALUE_FLAGS = new Set<string>(COMMAND_SPECS.flatMap((spec) => "valueFlags" in spec ? [...spec.valueFlags] : []));

const commandLookup = new Map<string, typeof COMMAND_SPECS[number]>();
for (const spec of COMMAND_SPECS) {
  registerName(spec.name, spec);
  if ("aliases" in spec) for (const alias of spec.aliases) registerName(alias, spec);
}

export function resolveCommandSpec(name: string | undefined) {
  return name ? commandLookup.get(name) : undefined;
}

export type CliInvocation =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "command"; spec: typeof COMMAND_SPECS[number] }
  | { kind: "unknown"; name: string | undefined };

export function parseCliInvocation(args: string[]): CliInvocation {
  const name = args[0];
  if (name === "help" || args.includes("--help") || args.includes("-h")) return { kind: "help" };
  if (args.includes("--version") || args.includes("-V")) return { kind: "version" };
  const spec = resolveCommandSpec(name);
  return spec ? { kind: "command", spec } : { kind: "unknown", name };
}

export function renderHelp() {
  return [
    "headless (hless) v0.2 — universal contained runner and local orchestrator",
    "",
    "Commands:",
    ...COMMAND_SPECS.flatMap((spec) => "help" in spec ? [`  ${spec.help}`] : []),
    "",
    "Required containment is the default. --unsafe-no-sandbox is the only local bypass and is visibly marked in results.",
    "Autonomy and councils always require containment.",
    "Use a literal -- before prompts that begin with a flag.",
  ].join("\n");
}

function registerName(name: string, spec: typeof COMMAND_SPECS[number]) {
  if (commandLookup.has(name)) throw new Error(`Duplicate CLI command or alias: ${name}`);
  commandLookup.set(name, spec);
}
