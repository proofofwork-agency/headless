import { COMMAND_SPECS } from "./command-specs";

/**
 * The legal positional shape of every command, in one place.
 *
 * Extra positionals used to be discarded in silence: `headless init wat`
 * initialised, `daemon status wat` ran, `lead use codex wat` succeeded. That is
 * the same defect class as ignored unknown flags, and hides a typo for a
 * subcommand the operator believed existed.
 *
 * Kept beside COMMAND_SPECS rather than inside it so each entry stays readable,
 * with an exhaustiveness test pinning that every command has a grammar.
 *
 * Two rules the shapes below encode and the validator must honour:
 *  - Nothing after `--` is ever inspected. That tail is opaque by contract, so
 *    a fixed field can never be satisfied from it: `mcp install -- codex` is a
 *    missing host, not a supplied one.
 *  - `unlessAnyFlag` marks a slot the operator may fill EITHER positionally or
 *    through a flag. When that flag is present the slot closes, so supplying
 *    both is rejected instead of silently dropping one.
 */

/** One fixed token, consumed in declaration order. */
export type PositionalField = {
  name: string;
  required: boolean;
  /** Slot closes when any of these flags is present. */
  unlessAnyFlag?: readonly string[];
};

/**
 * Free text: at most one token before `--` (quote it), or an unbounded tail
 * after `--`. Preserves getPrompt's existing shell contract.
 */
export type TextOperand = {
  name: string;
  required: boolean;
  unlessAnyFlag?: readonly string[];
};

export type PositionalGrammar =
  | { kind: "leaf"; fields?: readonly PositionalField[]; text?: TextOperand }
  | { kind: "actions"; default?: string; actions: Readonly<Record<string, PositionalGrammar>> };

const none: PositionalGrammar = { kind: "leaf" };
const actionOnly: PositionalGrammar = { kind: "leaf" };
const optionalText = (name: string): PositionalGrammar => ({ kind: "leaf", text: { name, required: false } });
const requiredText = (name: string): PositionalGrammar => ({ kind: "leaf", text: { name, required: true } });
const requiredField = (name: string): PositionalGrammar => ({ kind: "leaf", fields: [{ name, required: true }] });

/** Aliases resolve to the canonical name before lookup, so only canonicals appear. */
export const POSITIONAL_GRAMMAR: Readonly<Record<string, PositionalGrammar>> = {
  // ---- stable -------------------------------------------------------------
  lead: {
    kind: "actions",
    default: "status",
    actions: { status: actionOnly, release: actionOnly, use: requiredField("host") },
  },
  exec: requiredText("prompt"),
  daemon: {
    kind: "actions",
    default: "status",
    // `start` is an undocumented but implemented alias; preserved deliberately.
    actions: { serve: actionOnly, start: actionOnly, status: actionOnly, stop: actionOnly, reap: actionOnly },
  },
  project: {
    kind: "actions",
    actions: {
      trust: {
        kind: "actions",
        default: "status",
        actions: { status: actionOnly, grant: actionOnly, revoke: actionOnly },
      },
    },
  },
  init: none,
  setup: none,
  status: none,
  doctor: none,
  tui: none,
  mcp: {
    kind: "actions",
    default: "serve",
    // `server` is an implemented alias. A bare host (`mcp codex`) stays an
    // unknown action rather than shorthand, which is today's behaviour.
    actions: {
      serve: { kind: "leaf", fields: [{ name: "host", required: false }] },
      server: { kind: "leaf", fields: [{ name: "host", required: false }] },
      status: { kind: "leaf", fields: [{ name: "host", required: false }] },
      install: requiredField("host"),
      remove: requiredField("host"),
    },
  },
  verify: none,

  // ---- experimental -------------------------------------------------------
  fleet: {
    kind: "actions",
    default: "health",
    actions: {
      health: actionOnly,
      profile: {
        kind: "actions",
        actions: {
          create: actionOnly, upsert: actionOnly, get: actionOnly, list: actionOnly, remove: actionOnly,
        },
      },
    },
  },
  goal: {
    kind: "actions",
    default: "list",
    actions: {
      list: actionOnly, follow: actionOnly, status: actionOnly, cancel: actionOnly, result: actionOnly,
      start: requiredText("objective"), run: requiredText("objective"), send: requiredText("message"),
    },
  },
  collaboration: {
    kind: "actions",
    default: "turns",
    actions: {
      turns: actionOnly, messages: actionOnly, acknowledge: actionOnly, ack: actionOnly,
      "transfer-synthesizer": actionOnly,
    },
  },
  approval: {
    kind: "actions",
    default: "list",
    actions: {
      list: actionOnly,
      // --resolution owns the text when present; supplying both is rejected.
      resolve: { kind: "leaf", text: { name: "resolution", required: true, unlessAnyFlag: ["--resolution"] } },
    },
  },
  candidate: {
    kind: "actions",
    default: "inspect",
    actions: { inspect: actionOnly, integrate: actionOnly, reject: actionOnly },
  },
  session: {
    kind: "actions",
    default: "status",
    actions: {
      create: actionOnly, cancel: actionOnly, status: actionOnly, result: actionOnly,
      send: requiredText("prompt"), resume: requiredText("prompt"),
    },
  },
  workflow: {
    kind: "actions",
    default: "list",
    actions: {
      run: actionOnly, validate: actionOnly, "draft-create": actionOnly, "draft-list": actionOnly,
      "draft-get": actionOnly, "draft-launch": actionOnly, list: actionOnly, status: actionOnly,
      wait: actionOnly, pause: actionOnly, resume: actionOnly, cancel: actionOnly,
    },
  },
  events: none,
  autonomy: {
    kind: "actions",
    default: "status",
    actions: {
      on: actionOnly, start: actionOnly, off: actionOnly, stop: actionOnly, status: actionOnly,
      ask: optionalText("request"), more: optionalText("request"),
      "ask-for-work": optionalText("request"), backup: optionalText("request"),
    },
  },
  orchestrate: none,
  council: optionalText("question"),
  gate: none,
  launch: { kind: "leaf", fields: [{ name: "backend", required: true }], text: { name: "prompt", required: false } },
  skill: {
    kind: "actions",
    default: "list",
    actions: {
      list: actionOnly,
      // import's source comes from --source, never a positional.
      import: actionOnly,
      inspect: requiredField("skillId"), enable: requiredField("skillId"), revoke: requiredField("skillId"),
      // Extra arguments for `use` are legal only after `--`.
      use: requiredField("skillId"),
    },
  },
  loop: {
    kind: "actions",
    default: "list",
    actions: {
      list: actionOnly, status: actionOnly, pause: actionOnly, resume: actionOnly, cancel: actionOnly,
      start: { kind: "leaf", text: { name: "objective", required: true, unlessAnyFlag: ["--file", "--repair"] } },
    },
  },
  ledger: {
    kind: "actions",
    actions: { verify: actionOnly, "repair-tail": actionOnly },
  },
  receipt: {
    kind: "actions",
    actions: {
      list: actionOnly,
      show: requiredField("runId"),
      export: requiredField("runId"),
      // --file replaces the runId; supplying both is rejected.
      verify: { kind: "leaf", fields: [{ name: "runId", required: true, unlessAnyFlag: ["--file"] }] },
      diff: { kind: "leaf", fields: [{ name: "runIdA", required: true }, { name: "runIdB", required: true }] },
    },
  },
  budget: {
    kind: "actions",
    default: "list",
    actions: {
      list: actionOnly,
      upsert: actionOnly,
      "linked-hold": { kind: "actions", actions: { inspect: actionOnly, quarantine: actionOnly } },
    },
  },

  // ---- internal (reachable, so still declared) ----------------------------
  pair: none,
  ask: optionalText("request"),
  "coop-proof": none,
};

/** Every command must declare a grammar; the test pins this too. */
export const COMMANDS_MISSING_GRAMMAR = COMMAND_SPECS
  .map((spec) => spec.name)
  .filter((name) => !(name in POSITIONAL_GRAMMAR));
