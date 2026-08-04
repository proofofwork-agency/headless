import { COMMAND_SPECS, VALUE_FLAGS, renderCommandUsage, resolveCommandSpec, type ResolvedCliCommandSpec } from "./command-specs";

/**
 * Operator input, never a runtime fault. It lives here rather than in shared.ts
 * so the argv grammar has no dependency on the daemon-facing helpers; shared.ts
 * re-exports it so every existing importer keeps the same class identity.
 */
export class CliUsageError extends Error {}

export type CommandPositional = { value: string; index: number };

export type ParsedCommandArgv = {
  spec: ResolvedCliCommandSpec | undefined;
  flagsBeforeSeparator: string[];
  positionalEntries: CommandPositional[];
  passthrough: string[] | undefined;
};

export type ResolvedAction = {
  action: string | undefined;
  explicit: boolean;
  operands: string[];
  argvWithoutAction: string[];
};

/**
 * Help and version are intercepted before dispatch; they are listed so direct
 * callers of validateCommandFlags agree with the CLI.
 *
 * --json is deliberately NOT here. src/cli.ts renders every *failure* as JSON
 * whenever --json appears in argv, which is why it was once accepted globally —
 * but that made it a silent no-op on commands that print human text, so
 * `headless init --json` exited 0 with prose. Each command whose success output
 * is JSON declares the flag itself; the rest reject it as unknown, and that
 * rejection is still delivered as a JSON envelope because error rendering reads
 * raw argv.
 */
const ALWAYS_ACCEPTED_FLAGS = ["--help", "-h", "--version", "-V"] as const;

const VALUE_FLAGS_BY_COMMAND = new Map(COMMAND_SPECS.map((spec) => [
  spec.name,
  new Set<string>("valueFlags" in spec ? spec.valueFlags : []),
] as const));

const ACCEPTED_FLAGS_BY_COMMAND = new Map(COMMAND_SPECS.map((spec) => [
  spec.name,
  new Set<string>([
    ...("valueFlags" in spec ? spec.valueFlags : []),
    ...("booleanFlags" in spec ? spec.booleanFlags : []),
    ...ALWAYS_ACCEPTED_FLAGS,
  ]),
] as const));

export function flagArgsBeforeSeparator(argv: string[]) {
  const index = argv.indexOf("--");
  return index === -1 ? argv : argv.slice(0, index);
}

/** `-1`, `-1.5`, `-1e3` are values; the semantic parser rejects them with a typed range message. */
export function isNegativeNumericLiteral(token: string) {
  return /^-(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(token);
}

/** A token opens a flag unless it is a bare `-` operand or a negative number. */
export function isFlagToken(token: string) {
  return token.startsWith("-") && token !== "-" && !isNegativeNumericLiteral(token);
}

/**
 * A flag's value is missing when nothing follows, when `--` follows, or when
 * another flag follows. An empty string IS a value: callers spell the default
 * as `getArg(flags, "--cwd") || process.cwd()`, and rejecting "" here turned
 * `--cwd ""` into a throw inside the top-level error renderer, which reads
 * --cwd to build its remedy and so faulted on the error it was rendering.
 */
export function isFlagValue(token: string | undefined): token is string {
  return token !== undefined && token !== "--" && !isFlagToken(token);
}

export function readFlagValue(argv: string[], name: string, index: number) {
  const value = argv[index + 1];
  if (!isFlagValue(value)) throw new CliUsageError(`Missing value for ${name}.`);
  return value;
}

/**
 * Split one command invocation into flags, positionals, and the passthrough
 * tail. A registered value flag and its value are consumed as a single grammar
 * unit, so `mcp --cwd /repo` yields no positional instead of reading /repo as
 * the MCP host.
 */
export function parseCommandArgv(argv: string[]): ParsedCommandArgv {
  const spec = resolveCommandSpec(argv[0]);
  const valueFlags = spec ? VALUE_FLAGS_BY_COMMAND.get(spec.name)! : VALUE_FLAGS;
  const separator = argv.indexOf("--");
  const end = separator === -1 ? argv.length : separator;
  const positionalEntries: CommandPositional[] = [];
  for (let index = 1; index < end; index += 1) {
    const token = argv[index]!;
    if (isFlagToken(token)) {
      if (valueFlags.has(token) && isFlagValue(argv[index + 1])) index += 1;
      continue;
    }
    positionalEntries.push({ value: token, index });
  }
  return {
    spec,
    flagsBeforeSeparator: separator === -1 ? argv : argv.slice(0, separator),
    positionalEntries,
    passthrough: separator === -1 ? undefined : argv.slice(separator + 1),
  };
}

/**
 * Resolve the subcommand from the grammar rather than from a physical index.
 * `args[1]` made every global flag look like an action, so `daemon --cwd dir`
 * reported a usage error for the flag the operator was told to pass.
 *
 * argvWithoutAction drops only the action token, keeping flags, their values,
 * and the `--` tail, so handlers can hand it straight to getPrompt.
 */
// A fallback makes the action total, so handlers that switch on it (Set.has,
// array lookup) need no non-null assertion at every call site.
export function resolveCommandAction(argv: string[], fallback: string): ResolvedAction & { action: string };
export function resolveCommandAction(argv: string[], fallback?: string): ResolvedAction;
export function resolveCommandAction(argv: string[], fallback?: string): ResolvedAction {
  const [first, ...rest] = parseCommandArgv(argv).positionalEntries;
  if (!first) return { action: fallback, explicit: false, operands: [], argvWithoutAction: [...argv] };
  return {
    action: first.value,
    explicit: true,
    operands: rest.map((entry) => entry.value),
    argvWithoutAction: [...argv.slice(0, first.index), ...argv.slice(first.index + 1)],
  };
}

/**
 * Reject flags the resolved command does not accept, using its own catalog and
 * not the union of every command's flags: the union lets a flag that is valid
 * somewhere masquerade as valid everywhere. Tokens after `--` are opaque prompt
 * input and are never inspected.
 */
export function validateCommandFlags(argv: string[]) {
  const spec = resolveCommandSpec(argv[0]);
  if (!spec) return;
  const accepted = ACCEPTED_FLAGS_BY_COMMAND.get(spec.name)!;
  const separator = argv.indexOf("--");
  const end = separator === -1 ? argv.length : separator;
  for (let index = 1; index < end; index += 1) {
    const token = argv[index]!;
    if (isFlagToken(token) && !accepted.has(token)) {
      throw new CliUsageError(`Unknown flag for ${spec.name}: ${token}.`);
    }
  }
}

/**
 * Reject a stray positional on a command whose grammar is flags only.
 *
 * `headless init not-a-subcommand` used to initialise successfully and discard
 * the token — the same silent-ignore defect as unknown flags, and just as
 * likely to hide a typo for a subcommand the operator thought existed. Only
 * commands that opt in via `positionals: "none"` are checked, so commands
 * taking prompts, ids, hosts or unbounded trailing text are untouched.
 */
export function validateCommandPositionals(argv: string[]) {
  const spec = resolveCommandSpec(argv[0]);
  if (!spec || !("positionals" in spec) || spec.positionals !== "none") return;
  const { positionalEntries } = parseCommandArgv(argv);
  const stray = positionalEntries[0];
  if (!stray) return;
  throw new CliUsageError(
    `${spec.name} takes no subcommand or argument, but received "${stray.value}". ${renderCommandUsage(spec.name)}`,
  );
}
