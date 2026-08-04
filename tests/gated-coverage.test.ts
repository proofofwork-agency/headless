import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Capability gates keep platform-specific tests from failing where they cannot
 * run. The hazard is a gate whose predicate is false on every CI leg: the suite
 * still reports green while that code is never exercised anywhere, which is
 * worse than a missing test because it looks covered.
 *
 * This registry states, for each gate, which leg actually runs it. A gate that
 * runs nowhere in CI must be declared with a reason, so the tradeoff is visible
 * in review instead of hiding behind a passing suite. Declared legs are checked
 * against the gate's own predicate: a leg that the predicate rules out was the
 * original hole here, where a bwrap (Linux-only) test claimed macOS coverage
 * and the guard accepted it because the claim was merely non-empty.
 */
type Leg = "ubuntu" | "macos";

const LEG_PLATFORM: Record<Leg, string> = { ubuntu: "linux", macos: "darwin" };

type GateCoverage = {
  /** Identifier, or `skipIf(<predicate>)` for a gate written inline on a test. */
  gate: string;
  /** Test files that declare it; a gate of the same name elsewhere is separate. */
  files: string[];
  /** CI legs that execute it. Empty means it runs on no CI leg. */
  legs: Leg[];
  /** Required when `legs` is empty: why CI cannot cover it. */
  undeclaredReason?: string;
};

const GATES: GateCoverage[] = [
  { gate: "darwinTest", files: ["tests/containment-v2.test.ts"], legs: ["macos"] },
  { gate: "linuxBwrapTest", files: ["tests/containment-v2.test.ts"], legs: ["ubuntu"] },
  { gate: "linuxX64BwrapTest", files: ["tests/containment-v2.test.ts"], legs: ["ubuntu"] },
  {
    gate: "linuxRelayLifecycleTest",
    files: ["tests/containment-v2.test.ts"],
    legs: [],
    undeclaredReason:
      "It is a bwrap case, so macOS cannot run it, and the hosted GitHub Linux runner cannot terminalize "
      + "the relay child (see docs/internal/hosted-linux-relay-follow-up.md). The privileged CI step that "
      + "HEADLESS_PRIVILEGED_CONTAINMENT_CI=1 was written for no longer exists, so the only coverage is a "
      + "local Linux machine or a self-hosted privileged runner that sets that variable. This gate now "
      + "guards ONLY the combined case, which also requires the broker and run-tool relays to be "
      + "reachable; that availability leg is repeatedly intermittent on hosted x86-64 (3 of 9 samples "
      + "failed, every diagnosed one with unixError ENOENT and toolCode 1 — containment held), so it is "
      + "deliberately skipped there and measured off-CI on native Linux. The SECURITY property it used to "
      + "carry is not uncovered: the standalone `denies a host Unix socket created after launch` case is "
      + "required on hosted x86-64 by .github/workflows/privileged-containment.yml, asserts the socket was "
      + "visible before trusting its denial, and is mutation-proved against removal of the seccomp filter.",
  },
  { gate: "darwinTest", files: ["tests/native-auth.test.ts"], legs: ["macos"] },
  { gate: "realDarwinNetworkTest", files: ["tests/native-auth.test.ts"], legs: ["macos"] },
  { gate: "linuxTest", files: ["tests/linux-broker-relay.test.ts"], legs: ["ubuntu"] },
  { gate: "platformTest", files: ["tests/release-gate-containment.test.ts"], legs: ["ubuntu", "macos"] },
  {
    gate: "gitTest",
    files: [
      "tests/candidate-integration-service.test.ts",
      "tests/daemon-candidate-routes.test.ts",
      "tests/worktree.test.ts",
      "tests/worktree-leases.test.ts",
      "tests/write-integration.test.ts",
    ],
    legs: ["ubuntu", "macos"],
  },
  {
    gate: "realGrokInspectTest",
    files: ["tests/grok-isolation.test.ts"],
    legs: [],
    undeclaredReason:
      "Requires a locally installed grok CLI with a working `grok inspect`, which needs a real "
      + "subscription login. CI installs no provider CLIs, so this runs only on an operator machine, "
      + "in the same category as the credentialed smoke scripts.",
  },
  {
    gate: "installedCodexTest",
    files: ["tests/backend-hardening.test.ts"],
    legs: [],
    undeclaredReason:
      "Requires a locally installed codex CLI at >= 0.144.1, and CI installs no provider CLIs. It was "
      + "previously an early `return` inside the test body, which reports as a PASS with zero assertions — "
      + "invisible to this registry and to anyone reading the output. Declaring it as a gate makes the gap "
      + "countable; the strict-policy construction it guards is still covered by the non-installed "
      + "buildCodexCommand cases on both legs.",
  },
  { gate: 'skipIf(process.platform !== "linux")', files: ["tests/broker.test.ts"], legs: ["ubuntu"] },
  {
    gate: 'skipIf(process.platform !== "darwin" && process.platform !== "linux")',
    files: ["tests/control-plane-utils.test.ts", "tests/daemon.test.ts"],
    legs: ["ubuntu", "macos"],
  },
  {
    gate: "skipIf(HOSTED_LINUX_RELAY_INCOMPATIBLE || !strictContainmentAvailable())",
    files: ["tests/daemon-run-tool.test.ts"],
    legs: ["macos"],
  },
  { gate: "skipIf(!strictContainmentAvailable())", files: ["tests/runtime-fault-audit.test.ts"], legs: ["ubuntu", "macos"] },
  { gate: 'skipIf(process.platform !== "darwin")', files: ["tests/run-tool-endpoint.test.ts"], legs: ["macos"] },
];

/**
 * How a gate's predicate reads: a `const x = cond ? test : test.skip` binding
 * runs when the condition holds, while `test.skipIf(cond)` runs when it does
 * not. The polarity is what makes a platform literal mean "only here" or
 * "anywhere but here".
 */
type Polarity = "runs-when" | "skips-when";

type FoundGate = { gate: string; file: string; predicate: string; polarity: Polarity };

function scanGates(file: string, source: string): FoundGate[] {
  const bindings = new Map<string, string>();
  for (const match of source.matchAll(/^const (\w+)(?::[^=]+)? = ([^;]*);$/gm)) bindings.set(match[1]!, match[2]!);
  const found: FoundGate[] = [];
  for (const [name, definition] of bindings) {
    if (!/\btest\.skip\b/.test(definition)) continue;
    found.push({ gate: name, file, predicate: expand(definition, bindings), polarity: "runs-when" });
  }
  // Inline gates were invisible to this registry: `\btest\.skip\b` cannot match
  // `test.skipIf`, so a platform gate written on the test itself registered
  // nothing and inherited no coverage claim at all.
  for (const match of source.matchAll(/\btest\.skipIf\(([\s\S]*?)\)\(/g)) {
    const predicate = match[1]!.replace(/\s+/g, " ").trim();
    found.push({ gate: `skipIf(${predicate})`, file, predicate: expand(predicate, bindings), polarity: "skips-when" });
  }
  return found;
}

/** Inlines referenced module bindings so a delegating gate carries their predicates. */
function expand(text: string, bindings: Map<string, string>) {
  let expanded = text;
  for (let round = 0; round < 3; round += 1) {
    const next = expanded.replace(/\b\w+\b/g, (name) => (bindings.has(name) ? ` ${bindings.get(name)} ` : name));
    if (next === expanded) break;
    expanded = next;
  }
  return expanded;
}

function platformConstraints({ predicate, polarity }: FoundGate) {
  const required = new Set<string>();
  const excluded = new Set<string>();
  for (const match of predicate.matchAll(/process\.platform\s*(===|!==)\s*"(\w+)"/g)) {
    const runsOnIt = (match[1] === "===") === (polarity === "runs-when");
    (runsOnIt ? required : excluded).add(match[2]!);
  }
  return { required, excluded };
}

// This file's own source states the patterns it looks for, so scanning it would
// register the guard's prose and regexes as gates. It declares no gated tests.
const SELF = "gated-coverage.test.ts";

const FOUND = readdirSync("tests")
  .filter((name) => name.endsWith(".test.ts") && name !== SELF)
  .flatMap((name) => scanGates(join("tests", name), readFileSync(join("tests", name), "utf8")));

const key = (file: string, gate: string) => `${file}:${gate}`;

describe("capability gate coverage", () => {
  test("every gate either runs on a CI leg or declares why it cannot", () => {
    const undeclared = GATES.filter((gate) => gate.legs.length === 0 && !gate.undeclaredReason?.trim());
    expect(undeclared.map((gate) => `${gate.files.join(", ")}:${gate.gate}`)).toEqual([]);
  });

  /**
   * Pinned deliberately. If this shrinks, a gate started running somewhere and
   * the registry is stale; if it grows, new dead coverage was added without a
   * stated reason.
   *
   * Counts GATES, not tests, and the two are not the same number. Behind these
   * three gates sit FOUR individual tests that execute on no CI leg:
   *   - tests/containment-v2.test.ts:440  denies a host Unix socket created
   *     after launch while broker and run tools remain reachable
   *   - tests/grok-isolation.test.ts:180  attests a gated-config-free project
   *     through the trust-gate canary
   *   - tests/grok-isolation.test.ts:217  real inspect sees no project
   *     instructions, skills, hooks, MCP, plugins, LSP, or startup config
   *   - tests/backend-hardening.test.ts  installed Codex accepts the complete
   *     strict policy before provider access — found only because it was NOT a
   *     skip: it early-returned with zero assertions and reported as a pass,
   *     which no scanner reading skip syntax can see. Now an explicit gate.
   * A gate-level count reads like a completeness claim over tests and is not
   * one; adding a case under an existing uncovered gate would not move this
   * number. The enumeration above is the human-readable record, kept here so
   * the understatement is visible at the assertion rather than inferred.
   *
   * The first of those three is no longer merely declared: it is measured
   * off-CI on privileged Linux with real bubblewrap. See
   * docs/internal/hosted-linux-relay-follow-up.md for the command, the pass
   * counts, and the architecture limit that still applies.
   */
  test("exactly three gate names are knowingly uncovered by CI", () => {
    const uncovered = GATES.filter((gate) => gate.legs.length === 0);
    expect(uncovered.map((gate) => gate.gate).sort())
      .toEqual(["installedCodexTest", "linuxRelayLifecycleTest", "realGrokInspectTest"]);
  });

  /**
   * The teeth: a declared leg has to be a platform the gate's own predicate
   * admits. Without this, `legs.length > 0` was the whole check, so a wrong leg
   * read as coverage — which is exactly how a test that runs nowhere passed.
   */
  test("every declared leg is a platform the gate can actually run on", () => {
    const declared = new Map(GATES.flatMap((gate) => gate.files.map((file) => [key(file, gate.gate), gate])));
    const impossible: string[] = [];
    for (const found of FOUND) {
      const entry = declared.get(key(found.file, found.gate));
      if (!entry) continue;
      const { required, excluded } = platformConstraints(found);
      for (const leg of entry.legs) {
        const platform = LEG_PLATFORM[leg];
        if (excluded.has(platform) || (required.size > 0 && !required.has(platform))) {
          impossible.push(`${found.file}:${found.gate} cannot run on ${leg} (${platform})`);
        }
      }
    }
    expect(impossible).toEqual([]);
  });

  test("registry accounts for every capability gate declared in the suite", () => {
    const declared = new Set(GATES.flatMap((gate) => gate.files.map((file) => key(file, gate.gate))));
    const unregistered = [...new Set(FOUND.map((found) => key(found.file, found.gate)))]
      .filter((found) => !declared.has(found));
    expect(unregistered, "new capability gate must be added to the coverage registry").toEqual([]);
  });

  test("registry names no gate the suite has stopped declaring", () => {
    const found = new Set(FOUND.map((entry) => key(entry.file, entry.gate)));
    const stale = GATES.flatMap((gate) => gate.files.map((file) => key(file, gate.gate)))
      .filter((entry) => !found.has(entry));
    expect(stale, "registry entry no longer matches a gate in the suite").toEqual([]);
  });
});
