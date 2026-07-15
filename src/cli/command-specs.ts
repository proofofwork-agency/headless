export type CliCommandSpec<Name extends string = string> = {
  name: Name;
  aliases?: readonly string[];
  valueFlags?: readonly string[];
  help?: string;
  internal?: true;
};

/**
 * The single command/flag catalog used by dispatch, prompt parsing, and help.
 * Hidden internal audit commands omit `help` but remain explicit here.
 */
export const COMMAND_SPECS = [
  {
    name: "lead",
    valueFlags: ["--cwd", "--extension-config", "--extension-module"],
    help: "lead <use <host>|status|release> [--cwd dir]   Configure the externally launched foreground lead.",
  },
  {
    name: "exec",
    aliases: ["run"],
    valueFlags: ["--backend", "--model", "--agent", "--session-id", "--timeout-ms", "--cwd", "--extension-config", "--extension-module", "--mode", "--auth-mode", "--approval-policy"],
    help: 'exec | run [--backend id] [--mode read-only|write] [--model m] [--agent a] [--session-id id] [--timeout-ms n] [--cwd dir] [--extension-config /absolute/trusted.json] [--json] [--stream] [--require-sandbox|--unsafe-no-sandbox] "prompt"',
  },
  {
    name: "daemon",
    valueFlags: ["--cwd", "--extension-config", "--extension-module"],
    help: "daemon <serve|status|stop> [--cwd dir] [--extension-config /absolute/trusted.json]",
  },
  {
    name: "project",
    valueFlags: ["--cwd", "--extension-config", "--extension-module"],
    help: "project trust <status|grant|revoke> [--allow-native-direct-unrestricted] [--allow-bypass] [--cwd dir]",
  },
  {
    name: "fleet",
    valueFlags: ["--profile-id", "--file", "--auth-mode", "--approval-policy", "--cwd", "--extension-config", "--extension-module"],
    help: "fleet <health|profile get|list|remove> [--profile-id id] | fleet profile upsert [--file profile.json | [--profile-id id] --auth-mode native-login|broker] [--approval-policy ask|auto|bypass] [--activate|--no-activate]",
  },
  {
    name: "goal",
    valueFlags: ["--goal-id", "--fleet-profile-id", "--synthesizer", "--mode", "--auth-mode", "--approval-policy", "--timeout-ms", "--cwd", "--extension-config", "--extension-module"],
    help: "goal <start|run|send|follow|status|list|cancel|result> [--goal-id id] [--mode read-only|write] [--auth-mode native-login|broker] [--approval-policy ask|auto|bypass] [--detach] [--timeout-ms n]",
  },
  {
    name: "collaboration",
    valueFlags: ["--goal-id", "--after-sequence", "--limit", "--agent-id", "--message-id", "--cwd", "--extension-config", "--extension-module"],
    help: "collaboration <turns|messages|acknowledge|transfer-synthesizer> --goal-id id [--message-id id ...] [--retain]",
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
    valueFlags: ["--file", "--workflow-id", "--draft-id", "--timeout-ms", "--auth-mode", "--approval-policy", "--cwd", "--extension-config", "--extension-module"],
    help: "workflow <run|validate|draft-create|draft-list|draft-get|draft-launch|list|status|wait|pause|resume|cancel> [options]",
  },
  {
    name: "events",
    aliases: ["logs"],
    valueFlags: ["--limit", "--session-id", "--display-mode", "--cwd", "--extension-config", "--extension-module"],
    help: "events | logs [--display-mode compact|verbose|strict] [--errors|--activity] [--follow] [--pretty] [--limit n]",
  },
  {
    name: "autonomy",
    valueFlags: ["--cwd", "--extension-config", "--extension-module"],
    help: "autonomy <start|stop|status|ask|backup> [options]",
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
    valueFlags: ["--lead", "--cwd", "--extension-config", "--extension-module"],
    help: "init [--lead codex|grok|claude|opencode] [--cwd dir]   Initialize external per-project state and optionally configure its foreground lead.",
  },
  {
    name: "status",
    valueFlags: ["--session-id", "--cwd", "--extension-config", "--extension-module"],
    help: "status [--cwd dir]              Show project and daemon status.",
  },
  { name: "doctor", valueFlags: ["--cwd", "--extension-config", "--extension-module"], help: "doctor [--cwd dir]              Show runtime, backend inventory, daemon state, and containment defaults." },
  { name: "tui", valueFlags: ["--cwd"], help: "tui [--cwd dir]                 Open the read-only observer log and configuration pane." },
  { name: "pair", valueFlags: ["--session-id", "--cwd", "--extension-config", "--extension-module"], internal: true },
  {
    name: "mcp",
    valueFlags: ["--cwd"],
    help: "mcp <serve|install|remove|status> [codex|grok|claude|opencode] [--cwd dir]",
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
    internal: true,
  },
  { name: "coop-proof", aliases: ["autonomy-coop-proof"], valueFlags: ["--cwd", "--extension-config", "--extension-module"], internal: true },
  { name: "skill", aliases: ["skills"], valueFlags: ["--source", "--backend", "--timeout-ms", "--cwd", "--extension-config", "--extension-module"], help: "skill | skills <list|inspect|import|enable|use|revoke> [options]" },
  { name: "loop", valueFlags: ["--loop-id", "--file", "--mode", "--deadline-ms", "--max-iterations", "--per-iteration-cost-usd", "--total-cost-usd", "--cwd", "--extension-config", "--extension-module"], help: "loop <start|list|status|pause|resume|cancel> --confirm [finite policy options]" },
  { name: "ledger", valueFlags: ["--cwd", "--extension-config", "--extension-module"], help: "ledger repair-tail --confirm [--cwd dir]   Admin-only partial-tail recovery." },
  {
    name: "budget",
    valueFlags: ["--id", "--principal", "--session-id", "--workflow-id", "--provider", "--max-requests", "--max-input-tokens", "--max-output-tokens", "--max-cost-usd", "--max-artifact-bytes", "--max-concurrency", "--max-retries", "--expires-at", "--link-id", "--expected-digest", "--resolution", "--cwd", "--extension-config", "--extension-module"],
    help: "budget <list|upsert|linked-hold inspect|linked-hold quarantine> [options] [--cwd dir]",
  },
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
  const experimental = args[0] === "experimental";
  const name = experimental ? args[1] : args[0];
  if (!name || name === "help" || args.includes("--help") || args.includes("-h")) return { kind: "help" };
  if (args.includes("--version") || args.includes("-V")) return { kind: "version" };
  const spec = resolveCommandSpec(name);
  if (!spec) return { kind: "unknown", name };
  return experimental || STABLE_COMMAND_NAMES.has(spec.name)
    ? { kind: "command", spec }
    : { kind: "unknown", name };
}

export const STABLE_COMMAND_NAMES = new Set(["exec", "lead", "daemon", "project", "init", "status", "doctor", "mcp", "tui"]);

export function renderHelp(includeExperimental = false) {
  return [
    "headless (hless) — Beta 1 contained execution runner",
    "",
    "Commands:",
    ...COMMAND_SPECS.flatMap((spec) => {
      if (!("help" in spec) || (!includeExperimental && !STABLE_COMMAND_NAMES.has(spec.name))) return [];
      return [`  ${includeExperimental && !STABLE_COMMAND_NAMES.has(spec.name) ? `experimental ${spec.help}` : spec.help}`];
    }),
    "",
    "Required containment is the default. --unsafe-no-sandbox is the only local bypass and is visibly marked in results.",
    "Broker authentication is the default; native login requires explicit project consent to unrestricted provider egress.",
    includeExperimental
      ? "Experimental commands require the `headless experimental` namespace and are outside the beta stability promise."
      : "Run `headless experimental --help` to list commands outside the beta stability promise.",
    "Use a literal -- before prompts that begin with a flag.",
  ].join("\n");
}

function registerName(name: string, spec: typeof COMMAND_SPECS[number]) {
  if (commandLookup.has(name)) throw new Error(`Duplicate CLI command or alias: ${name}`);
  commandLookup.set(name, spec);
}
