import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { STABLE_COMMAND_NAMES, renderHelp, stableHelpCommandCount } from "../src/cli/command-specs";
import { parseExecProfile, EXEC_PROFILES } from "../src/cli/profile";
import { PRODUCT_GATE_REMEDY_CODES, formatRemedyLines, remedyForCode, remedyForMessage } from "../src/cli/remedy";
import { printRunResult, resolveExecPolicy, runResultNextCommands } from "../src/cli/shared";
import { runSetupCommand } from "../src/cli/commands/lifecycle";
import { buildDoctorReport, inventoryBackends } from "../src/cli/readiness";
import type { RunResult } from "../src/contracts/run";
import { authorityLadder, initialControlRoomState, nextActions } from "../src/tui/model";
import { brokerEnvReadiness } from "../src/runtime/broker-env";
import { withLiveValidationFixture } from "../scripts/live-validation-fixture";

describe("Product Gate P contracts", () => {
  test("P.HELP keeps stable help within the progressive-disclosure budget", () => {
    expect(stableHelpCommandCount()).toBeLessThanOrEqual(12);
    expect(STABLE_COMMAND_NAMES.has("setup")).toBe(true);
    const help = renderHelp(false);
    expect(help).toContain("Golden path:");
    expect(help).toContain("setup");
    expect(help).not.toContain("workflow <");
    expect(renderHelp(true)).toContain("workflow <");
  });

  test("P.REMEDY covers the top failure codes with copy-paste commands", () => {
    for (const code of PRODUCT_GATE_REMEDY_CODES) {
      const remedy = remedyForCode(code, "/repo");
      expect(remedy).toBeTruthy();
      expect(remedy!.command.length).toBeGreaterThan(5);
      expect(formatRemedyLines(remedy!).join("\n")).toContain("Next:");
    }
    expect(remedyForMessage("native project consent required", "/repo")?.code.toUpperCase()).toBe("TRUST_REQUIRED");
  });

  test("P.STEPS profiles collapse native read-only flags", () => {
    expect(parseExecProfile("read-only-native")).toEqual(EXEC_PROFILES["read-only-native"]);
    const policy = resolveExecPolicy(["exec", "--profile", "read-only-native"]);
    expect(policy.authMode).toBe("native-login");
    expect(policy.mode).toBe("read-only");
    expect(policy.containment).toBe("required");
    const override = resolveExecPolicy(["exec", "--profile", "read-only-native", "--mode", "write"]);
    expect(override.mode).toBe("write");
  });

  test("P.AHA prints verify and receipt one-liners after a durable job", () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    try {
      printRunResult(sampleResult(), false, false, { cwd: "/tmp/p" });
    } finally {
      console.error = original;
    }
    const text = lines.join("\n");
    expect(text).toContain("job: job_1");
    expect(text).toContain("headless verify --cwd /tmp/p");
    expect(text).toContain("receipt show job_1");
    const next = runResultNextCommands(sampleResult(), "/tmp/p");
    expect(next?.verify).toContain("verify");
    expect(next?.receipt).toContain("receipt show job_1");
  });

  test("P.AHA JSON embeds next.verify and next.receipt", () => {
    const chunks: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      printRunResult(sampleResult(), true, false, { cwd: "/tmp/p" });
    } finally {
      process.stdout.write = original;
    }
    const parsed = JSON.parse(chunks.join(""));
    expect(parsed.next.verify).toContain("headless verify");
    expect(parsed.next.receipt).toContain("receipt show job_1");
  });

  test("doctor readiness panel inventories backends and next actions", () => {
    const backends = inventoryBackends({
      which: (name) => (name === "codex" || name === "claude" ? `/bin/${name}` : null),
      home: "/no-home",
      platform: "darwin",
    });
    expect(backends.find((b) => b.id === "codex")?.onPath).toBe(true);
    expect(backends.find((b) => b.id === "claude-code")?.onPath).toBe(true);
    expect(backends.find((b) => b.id === "claude-code")?.remedy).toContain("setup-token");
    const report = buildDoctorReport({
      projectRoot: "/repo",
      projectId: "p",
      principal: "root",
      stateDir: "/state",
      trust: {
        trusted: false,
        nativeLoginAllowed: false,
        nativeDirectUnrestrictedAcknowledged: false,
        bypassAllowed: false,
      },
      durableJobs: 0,
      recentEvents: 0,
      backends,
      brokerEnv: [{ variable: "OPENAI_API_KEY", present: false }],
      brokerEnvSource: "daemon",
    });
    expect(report.readyForNativeExec).toBe(false);
    expect(report.brokerEnvSource).toBe("daemon");
    expect(report.nextActions.some((a) => a.id === "grant-native-trust")).toBe(true);
    expect(report.version).toBe("product-readiness-1");
  });

  test("doctor broker readiness contains only daemon-safe presence flags", () => {
    const inventory = brokerEnvReadiness({
      OPENAI_API_KEY: "present-but-never-returned",
      ANTHROPIC_API_KEY: "",
    });
    expect(inventory.find((entry) => entry.variable === "OPENAI_API_KEY")?.present).toBe(true);
    expect(inventory.find((entry) => entry.variable === "ANTHROPIC_API_KEY")?.present).toBe(false);
    expect(JSON.stringify(inventory)).not.toContain("present-but-never-returned");
  });

  test("live validation fixtures remove both state and short runtime roots", async () => {
    let roots: { root: string; runtimeHome: string } | null = null;
    await withLiveValidationFixture("headless-fixture-test", async (fixture) => {
      roots = { root: fixture.root, runtimeHome: fixture.runtimeHome };
      expect(existsSync(fixture.root)).toBe(true);
      expect(existsSync(fixture.runtimeHome)).toBe(true);
    });
    expect(roots).not.toBeNull();
    expect(existsSync(roots!.root)).toBe(false);
    expect(existsSync(roots!.runtimeHome)).toBe(false);
  });

  test("standalone Product Gate is machine-readable and does not self-certify the kernel", () => {
    const root = resolve(import.meta.dir, "..");
    const result = Bun.spawnSync(["bun", "scripts/product-gate.ts"], {
      cwd: root,
      env: { ...process.env, HEADLESS_PRODUCT_KERNEL_VERIFIED: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const report = JSON.parse(result.stdout.toString()) as {
      checks: Array<{ id: string; status: string }>;
    };
    expect(report.checks.find((check) => check.id === "P.KERNEL")?.status).toBe("manual");

    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.check).toContain("bun run check:kernel &&");
    expect(pkg.scripts.check).toContain("HEADLESS_PRODUCT_KERNEL_VERIFIED=1");
  });

  test("P.GOLDEN setup wizard inventories backends and prints next commands", async () => {
    const logs: string[] = [];
    const client = {
      state: { projectDir: "/state/project" },
      call: async (method: string) => {
        if (method === "ping") return { projectId: "p1", projectRoot: "/repo", principal: "root" };
        if (method === "project.trust.grant") return { trusted: true };
        throw new Error(`unexpected ${method}`);
      },
    };
    await runSetupCommand(["setup", "--cwd", "/repo", "--yes"], {
      client: async () => client as never,
      which: (name) => (name === "codex" ? "/bin/codex" : null),
      log: (message) => logs.push(message),
    });
    const text = logs.join("\n");
    expect(text).toContain("Recommended backend: codex");
    expect(text).toContain("project trust grant --allow-native-direct-unrestricted");
    expect(text).toContain("exec --backend codex --auth-mode native-login --profile read-only-native");
    expect(text).toContain("headless verify");
  });

  test("P.TUI next actions cover trust ladder and first exec", () => {
    const bare = { ...initialControlRoomState("/project"), connection: "connected" as const };
    const bareActions = nextActions(bare);
    expect(bareActions.some((a) => a.id === "trust")).toBe(true);
    expect(authorityLadder(bare).map((r) => r.id)).toEqual([
      "project-trust",
      "native-egress",
      "lead",
      "write",
    ]);

    const ready = {
      ...bare,
      projectTrust: {
        trusted: true,
        nativeLoginAllowed: true,
        nativeDirectUnrestrictedAcknowledged: true,
        bypassAllowed: false,
      },
      lead: { host: "codex", backendId: "codex", generation: 1, status: "connected" as const },
    };
    expect(nextActions(ready).some((a) => a.id === "first-exec")).toBe(true);
  });
});

function sampleResult(): RunResult {
  return {
    status: "succeeded",
    error: null,
    backend: "opencode",
    output: "hello",
    stderr: "",
    diagnostics: { format: "t", malformedEvents: 0, ignoredEvents: 0, messages: [] },
    exitCode: 0,
    signal: null,
    usage: { input: null, output: null, reasoning: null, cached: null, providerTotal: null },
    cost: { amountUsd: null, source: "unknown", pricingId: null, observedRequests: 0 },
    containment: {
      requirement: "required",
      enforced: true,
      platform: "other",
      mechanism: null,
      probe: null,
      isolatedHome: true,
      credentialsIsolated: true,
      network: "broker-only",
      credentialAccess: "none",
      unsafe: false,
    },
    durationMs: 1,
    sessionId: null,
    jobId: "job_1",
    diff: null,
    commit: null,
  } as RunResult;
}
