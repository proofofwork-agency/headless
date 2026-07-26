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
 * in review instead of hiding behind a passing suite.
 */
type Leg = "ubuntu" | "macos";

type GateCoverage = {
  /** Identifier or predicate as it appears in the test source. */
  gate: string;
  where: string;
  /** CI legs that execute it. Empty means it runs on no CI leg. */
  legs: Leg[];
  /** Required when `legs` is empty: why CI cannot cover it. */
  undeclaredReason?: string;
};

const GATES: GateCoverage[] = [
  { gate: "darwinTest", where: "tests/containment-v2.test.ts", legs: ["macos"] },
  { gate: "linuxBwrapTest", where: "tests/containment-v2.test.ts", legs: ["ubuntu"] },
  { gate: "linuxX64BwrapTest", where: "tests/containment-v2.test.ts", legs: ["ubuntu"] },
  { gate: "linuxRelayLifecycleTest", where: "tests/containment-v2.test.ts", legs: ["macos"] },
  { gate: "HOSTED_LINUX_RELAY_INCOMPATIBLE", where: "tests/daemon-run-tool.test.ts", legs: ["macos"] },
  { gate: "linuxTest", where: "tests/linux-broker-relay.test.ts", legs: ["ubuntu"] },
  { gate: "platformTest", where: "tests/release-gate-containment.test.ts", legs: ["ubuntu", "macos"] },
  { gate: "darwinTest", where: "tests/native-auth.test.ts", legs: ["macos"] },
  { gate: "realDarwinNetworkTest", where: "tests/native-auth.test.ts", legs: ["macos"] },
  {
    gate: "gitTest",
    where: "tests/candidate-integration-service.test.ts, tests/write-integration.test.ts, tests/worktree-leases.test.ts",
    legs: ["ubuntu", "macos"],
  },
  {
    gate: "realGrokInspectTest",
    where: "tests/grok-isolation.test.ts",
    legs: [],
    undeclaredReason:
      "Requires a locally installed grok CLI with a working `grok inspect`, which needs a real "
      + "subscription login. CI installs no provider CLIs, so this runs only on an operator machine, "
      + "in the same category as the credentialed smoke scripts.",
  },
];

describe("capability gate coverage", () => {
  test("every gate either runs on a CI leg or declares why it cannot", () => {
    const undeclared = GATES.filter((gate) => gate.legs.length === 0 && !gate.undeclaredReason?.trim());
    expect(undeclared.map((gate) => `${gate.where}:${gate.gate}`)).toEqual([]);
  });

  /**
   * Pinned deliberately. If this shrinks, a gate started running somewhere and
   * the registry is stale; if it grows, new dead coverage was added without a
   * stated reason.
   */
  test("exactly one gate is knowingly uncovered by CI", () => {
    const uncovered = GATES.filter((gate) => gate.legs.length === 0);
    expect(uncovered.map((gate) => gate.gate)).toEqual(["realGrokInspectTest"]);
  });

  test("registry accounts for every capability gate declared in the suite", () => {
    const declared = new Set(GATES.map((gate) => gate.gate));
    const found = new Set<string>();
    for (const file of readdirSync("tests").filter((name) => name.endsWith(".test.ts"))) {
      const source = readFileSync(join("tests", file), "utf8");
      // Gates are module-level bindings assigned a `test`/`test.skip` choice.
      for (const match of source.matchAll(/^const (\w+)(?::[^=]+)? = [^;]*\btest\.skip\b/gm)) {
        found.add(match[1]!);
      }
      for (const match of source.matchAll(/^const (HOSTED_LINUX_RELAY_INCOMPATIBLE)\b/gm)) {
        found.add(match[1]!);
      }
    }
    const unregistered = [...found].filter((gate) => !declared.has(gate));
    expect(unregistered, "new capability gate must be added to the coverage registry").toEqual([]);
  });
});
