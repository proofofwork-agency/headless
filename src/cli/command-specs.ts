export type CliCommandSpec<Name extends string = string> = {
  name: Name;
  aliases?: readonly string[];
  valueFlags?: readonly string[];
  /**
   * Switches the command consumes on its own. Declaring them per command is
   * what lets unknown-flag rejection stay honest: a union of every command's
   * flags would let a flag that is valid somewhere pass everywhere.
   */
  booleanFlags?: readonly string[];
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
    booleanFlags: ["--json"],
    help: "lead <use <host>|status|release> [--cwd dir]   Configure the externally launched foreground lead.",
  },
  {
    name: "exec",
    aliases: ["run"],
    valueFlags: ["--backend", "--model", "--agent", "--session-id", "--timeout-ms", "--cwd", "--extension-config", "--extension-module", "--mode", "--auth-mode", "--approval-policy", "--profile"],
    booleanFlags: ["--json", "-j", "--stream", "--unsafe-no-sandbox", "--require-sandbox"],
    help: 'exec | run [--backend id] [--profile read-only-native|broker-readonly] [--mode read-only|write] [--model m] [--agent a] [--session-id id] [--timeout-ms n] [--cwd dir] [--json] [--stream] "prompt"',
  },
  {
    name: "daemon",
    valueFlags: ["--cwd", "--extension-config", "--extension-module", "--idle-timeout-ms"],
    booleanFlags: ["--no-idle-timeout", "--experimental-sessions", "--all", "--confirm", "--json"],
    help: "daemon <serve|status|stop|reap> [--cwd dir] [--extension-config /absolute/trusted.json] [--idle-timeout-ms ms | --no-idle-timeout] [reap: --confirm] [reap: --all]",
  },
  {
    name: "project",
    valueFlags: ["--cwd", "--extension-config", "--extension-module"],
    booleanFlags: ["--allow-native-direct-unrestricted", "--allow-bypass", "--json"],
    help: "project trust <status|grant|revoke> [--allow-native-direct-unrestricted] [--allow-bypass] [--cwd dir]",
  },
  {
    name: "fleet",
    valueFlags: ["--profile-id", "--agent", "--file", "--auth-mode", "--approval-policy", "--cwd", "--extension-config", "--extension-module"],
    booleanFlags: ["--activate", "--no-activate", "--json"],
    help: "fleet <health|profile get|list|remove> [--profile-id id] | fleet profile create --profile-id id --agent backend [--agent backend ...] [--auth-mode native-login|broker] [--approval-policy ask|auto|bypass] [--activate|--no-activate] | fleet profile upsert [--file profile.json | [--profile-id id] --auth-mode native-login|broker] [--approval-policy ask|auto|bypass] [--activate|--no-activate]",
  },
  {
    name: "goal",
    valueFlags: ["--goal-id", "--fleet-profile-id", "--synthesizer", "--mode", "--auth-mode", "--approval-policy", "--timeout-ms", "--cwd", "--extension-config", "--extension-module"],
    booleanFlags: ["--autonomous", "--detach", "--json"],
    help: "goal <start|run|send|follow|status|list|cancel|result> [--goal-id id] [--mode read-only|write] [--auth-mode native-login|broker] [--approval-policy ask|auto|bypass] [--detach] [--timeout-ms n]",
  },
  {
    name: "collaboration",
    valueFlags: ["--goal-id", "--after-sequence", "--limit", "--agent-id", "--message-id", "--cwd", "--extension-config", "--extension-module"],
    booleanFlags: ["--retain", "--json"],
    help: "collaboration <turns|messages|acknowledge|transfer-synthesizer> --goal-id id [--message-id id ...] [--retain]",
  },
  {
    name: "approval",
    valueFlags: ["--goal-id", "--status", "--approval-id", "--decision", "--resolution", "--cwd", "--extension-config", "--extension-module"],
    booleanFlags: ["--json"],
    help: "approval <list|resolve> [--goal-id id] [--approval-id id --decision approved|rejected --resolution text]",
  },
  {
    name: "candidate",
    valueFlags: ["--candidate-id", "--cwd", "--extension-config", "--extension-module"],
    booleanFlags: ["--json"],
    help: "candidate <inspect|integrate|reject> --candidate-id id",
  },
  {
    name: "session",
    valueFlags: ["--backend", "--model", "--agent", "--session-id", "--timeout-ms", "--cwd", "--extension-config", "--extension-module", "--auth-mode", "--approval-policy"],
    booleanFlags: ["--unsafe-no-sandbox", "--require-sandbox", "--json"],
    help: "session <create|send|resume|cancel|status|result> [options]",
  },
  {
    name: "workflow",
    valueFlags: ["--file", "--workflow-id", "--draft-id", "--timeout-ms", "--auth-mode", "--approval-policy", "--cwd", "--extension-config", "--extension-module"],
    booleanFlags: ["--unsafe-no-sandbox", "--json"],
    help: "workflow <run|validate|draft-create|draft-list|draft-get|draft-launch|list|status|wait|pause|resume|cancel> [options]",
  },
  {
    name: "events",
    aliases: ["logs"],
    valueFlags: ["--limit", "--session-id", "--display-mode", "--cwd", "--extension-config", "--extension-module"],
    booleanFlags: ["--follow", "-f", "--pretty", "-p", "--errors", "--activity", "--json"],
    help: "events | logs [--display-mode compact|verbose|strict] [--errors|--activity] [--follow] [--pretty] [--limit n]",
  },
  {
    name: "autonomy",
    valueFlags: ["--cwd", "--extension-config", "--extension-module"],
    booleanFlags: ["--unsafe-no-sandbox", "--json"],
    help: "autonomy <start|stop|status|ask|backup> [options]",
  },
  {
    name: "orchestrate",
    valueFlags: ["--cwd", "--extension-config", "--extension-module"],
    booleanFlags: ["--unsafe-no-sandbox", "--json"],
    help: "orchestrate [--cwd dir]",
  },
  {
    name: "council",
    valueFlags: ["--agent", "--mode", "--timeout-ms", "--auth-mode", "--approval-policy", "--cwd", "--extension-config", "--extension-module"],
    booleanFlags: ["--unsafe-no-sandbox", "--json"],
    help: 'council [--agent backend ...] [--mode read-only|write] [--auth-mode native-login|broker] [--approval-policy ask|auto|bypass] [--timeout-ms n] "question"',
  },
  {
    name: "gate",
    aliases: ["release-gate"],
    valueFlags: ["--check", "--timeout-ms", "--session-id", "--cwd", "--extension-config", "--extension-module"],
    booleanFlags: ["--json"],
    help: "gate [--check check|build|test|pack] [--timeout-ms n] [--cwd dir]",
  },
  {
    name: "init",
    valueFlags: ["--lead", "--cwd", "--extension-config", "--extension-module"],
    help: "init [--lead codex|grok|claude|opencode] [--cwd dir]   Initialize external per-project state and optionally configure its foreground lead.",
  },
  {
    name: "setup",
    valueFlags: ["--lead", "--cwd", "--extension-config", "--extension-module"],
    booleanFlags: ["--yes", "--allow-native-direct-unrestricted", "--allow-bypass"],
    help: "setup [--lead host] [--yes] [--allow-native-direct-unrestricted] [--cwd dir]   Golden-path wizard: init, inventory CLIs, print next commands.",
  },
  {
    name: "status",
    valueFlags: ["--session-id", "--cwd", "--extension-config", "--extension-module"],
    booleanFlags: ["--json"],
    help: "status [--cwd dir]              Show project and daemon status.",
  },
  { name: "doctor", valueFlags: ["--cwd", "--extension-config", "--extension-module"], booleanFlags: ["--json", "-j"], help: "doctor [--json] [--cwd dir]     Readiness panel: trust, backends, capsules, daemon broker env, next commands." },
  { name: "tui", valueFlags: ["--cwd"], help: "tui [--cwd dir]                 Open the read-only observer log and configuration pane." },
  { name: "pair", valueFlags: ["--session-id", "--cwd", "--extension-config", "--extension-module"], internal: true },
  {
    name: "mcp",
    valueFlags: ["--cwd"],
    help: "mcp <serve [host]|install <host>|remove <host>|status [host]> [--cwd dir]   Install/remove require an explicit codex, grok, claude, or opencode host.",
  },
  {
    name: "launch",
    valueFlags: ["--timeout-ms", "--cwd", "--extension-config", "--extension-module", "--auth-mode", "--approval-policy"],
    booleanFlags: ["--json", "-j", "--unsafe-no-sandbox", "--require-sandbox"],
    help: "launch <backend> [options]        Compatibility one-shot routed through the daemon.",
  },
  {
    name: "ask",
    aliases: ["ask-for-work", "ask-for-more-work"],
    valueFlags: ["--strength", "--completed", "--session-id", "--cwd", "--extension-config", "--extension-module"],
    booleanFlags: ["--backup"],
    internal: true,
  },
  { name: "coop-proof", aliases: ["autonomy-coop-proof"], valueFlags: ["--cwd", "--extension-config", "--extension-module"], internal: true },
  { name: "skill", aliases: ["skills"], valueFlags: ["--source", "--backend", "--timeout-ms", "--cwd", "--extension-config", "--extension-module"], booleanFlags: ["--json"], help: "skill | skills <list|inspect|import|enable|use|revoke> [options]" },
  { name: "loop", valueFlags: ["--loop-id", "--file", "--mode", "--deadline-ms", "--max-iterations", "--per-iteration-cost-usd", "--total-cost-usd", "--check", "--backend", "--verify-backend", "--auth-mode", "--approval-policy", "--model", "--max-repair-nodes", "--stagnation-limit", "--gate-timeout-ms", "--step-timeout-ms", "--cwd", "--extension-config", "--extension-module"], booleanFlags: ["--confirm", "--repair", "--json"], help: "loop <start|list|status|pause|resume|cancel> --confirm [--repair --check name] [finite policy options]" },
  { name: "verify", valueFlags: ["--cwd", "--extension-config", "--extension-module"], booleanFlags: ["--evidence", "--json"], help: "verify [--evidence] [--json] [--cwd dir]   Verify the tamper-evident ledger and optional evidence files." },
  { name: "ledger", valueFlags: ["--cwd", "--extension-config", "--extension-module"], booleanFlags: ["--confirm", "--evidence", "--json"], help: "ledger <verify [--evidence] [--json] | repair-tail --confirm> [--cwd dir]" },
  {
    name: "receipt",
    valueFlags: ["--out", "--file", "--ledger", "--limit", "--cwd", "--extension-config", "--extension-module"],
    booleanFlags: ["--json"],
    help: "receipt <show <runId> | list | export <runId> [--out file] | verify <runId> | verify --file export.json [--ledger ledger.jsonl] | diff <runIdA> <runIdB>> [--json] [--cwd dir]   Inspect, export, compare, and verify execution receipts.",
  },
  {
    name: "budget",
    valueFlags: ["--id", "--principal", "--session-id", "--workflow-id", "--provider", "--max-requests", "--max-input-tokens", "--max-output-tokens", "--max-cost-usd", "--max-artifact-bytes", "--max-concurrency", "--max-retries", "--expires-at", "--link-id", "--expected-digest", "--resolution", "--cwd", "--extension-config", "--extension-module"],
    booleanFlags: ["--confirm", "--json"],
    help: "budget <list|upsert|linked-hold inspect|linked-hold quarantine> [options] [--cwd dir]",
  },
] as const satisfies readonly CliCommandSpec[];

export type CliCommandName = typeof COMMAND_SPECS[number]["name"];
export type ResolvedCliCommandSpec = typeof COMMAND_SPECS[number];

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
  const separator = args.indexOf("--");
  const controlArgs = separator < 0 ? args : args.slice(0, separator);
  if (!name || name === "help" || controlArgs.includes("--help") || controlArgs.includes("-h")) return { kind: "help" };
  if (controlArgs.includes("--version") || controlArgs.includes("-V")) return { kind: "version" };
  const spec = resolveCommandSpec(name);
  if (!spec) return { kind: "unknown", name };
  return experimental || STABLE_COMMAND_NAMES.has(spec.name)
    ? { kind: "command", spec }
    : { kind: "unknown", name };
}

/** Beta 1 public surface. Adding a name requires Product Gate owner ack (docs/product-gate.md). */
export const STABLE_COMMAND_NAMES = new Set([
  "exec",
  "lead",
  "daemon",
  "project",
  "init",
  "setup",
  "status",
  "doctor",
  "mcp",
  "tui",
  "verify",
]);

export function stableHelpCommandCount() {
  return COMMAND_SPECS.filter((spec) => "help" in spec && STABLE_COMMAND_NAMES.has(spec.name)).length;
}

export function renderHelp(includeExperimental = false) {
  return [
    "headless (hless) — Beta 1 contained execution runner",
    "",
    "Golden path: headless setup → project trust grant (native) → exec --auth-mode native-login --profile read-only-native → verify",
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

/** Render local usage when help names a public command, otherwise the catalog. */
export function renderInvocationHelp(args: string[]) {
  const experimental = args[0] === "experimental";
  const name = experimental ? args[1] : args[0];
  const spec = resolveCommandSpec(name);
  if (spec && "help" in spec && (experimental || STABLE_COMMAND_NAMES.has(spec.name))) {
    return renderCommandUsage(spec.name);
  }
  return renderHelp(experimental || args.includes("--experimental"));
}

/**
 * Usage lines must name the namespace the operator has to type. A bare
 * "Usage: headless goal ..." from an experimental command is an instruction the
 * top-level experimental gate then rejects.
 */
export function renderCommandUsage(name: string) {
  const spec = resolveCommandSpec(name);
  if (!spec) return "Usage: headless --help";
  const namespace = STABLE_COMMAND_NAMES.has(spec.name) ? "" : "experimental ";
  return `Usage: headless ${namespace}${"help" in spec ? spec.help : spec.name}`;
}

function registerName(name: string, spec: typeof COMMAND_SPECS[number]) {
  if (commandLookup.has(name)) throw new Error(`Duplicate CLI command or alias: ${name}`);
  commandLookup.set(name, spec);
}
