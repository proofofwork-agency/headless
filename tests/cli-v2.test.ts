import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  COMMAND_SPECS,
  COMMAND_TABLE,
  COMMAND_REGISTRY_VERSION,
  UNIFIED_COMMAND_REGISTRY,
  VALUE_FLAGS,
  flagArgsBeforeSeparator,
  getPrompt,
  mcpServerCommand,
  parseCliInvocation,
  parseIntegerArg,
  renderHelp,
  resolveCommand,
  runMcpInstall,
} from "../src/cli";
import { parseBudgetCommand } from "../src/cli/commands/budget";
import { schedulingWindow } from "./support/timing";

const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;
const cliSharedUrl = new URL("../src/cli/shared.ts", import.meta.url).href;

describe("v0.2 CLI contracts", () => {
  test("registers every command and alias through one exhaustive command table", () => {
    expect([...COMMAND_TABLE.keys()]).toEqual(COMMAND_SPECS.map((spec) => spec.name));
    for (const spec of COMMAND_SPECS) {
      expect(resolveCommand(spec.name)?.spec).toBe(spec);
      if (!("aliases" in spec)) continue;
      for (const alias of spec.aliases) {
        expect(resolveCommand(alias)?.spec).toBe(spec);
        expect(parseCliInvocation(["experimental", alias])).toEqual({ kind: "command", spec });
      }
    }
  });

  test("uses one versioned registry for the CLI-only command surface", () => {
    expect(COMMAND_REGISTRY_VERSION).toBe(1);
    expect(UNIFIED_COMMAND_REGISTRY.cli.map((entry) => entry.source.name)).toEqual(COMMAND_SPECS.map((spec) => spec.name));
    expect(UNIFIED_COMMAND_REGISTRY.cli.every((entry) => entry.stableId && entry.executionTarget && entry.confirmation)).toBe(true);
    expect("slash" in UNIFIED_COMMAND_REGISTRY).toBe(false);
    expect("proposals" in UNIFIED_COMMAND_REGISTRY).toBe(false);
  });

  test("generates help and value-flag parsing from the shared command specifications", () => {
    const help = renderHelp();
    const experimentalHelp = renderHelp(true);
    for (const spec of COMMAND_SPECS) if ("valueFlags" in spec) for (const flag of spec.valueFlags) expect(VALUE_FLAGS.has(flag)).toBe(true);
    for (const command of ["exec", "lead", "daemon", "project", "init", "status", "doctor", "mcp", "tui", "verify"]) {
      const spec = COMMAND_SPECS.find((candidate) => candidate.name === command);
      expect(spec && "help" in spec ? help : "").toContain(`  ${spec && "help" in spec ? spec.help : ""}`);
    }
    expect(help).not.toContain("workflow <");
    expect(experimentalHelp).toContain("workflow <");
    for (const spec of COMMAND_SPECS) if ("help" in spec) expect(experimentalHelp).toContain(spec.help);
    expect(COMMAND_SPECS.filter((spec) => "internal" in spec).map((spec) => spec.name)).toEqual(["pair", "ask", "coop-proof"]);
    for (const spec of COMMAND_SPECS) if ("internal" in spec) expect("help" in spec).toBe(false);
    expect(parseCliInvocation(["session"])).toEqual({ kind: "unknown", name: "session" });
    expect(parseCliInvocation(["experimental", "session"])).toEqual({ kind: "command", spec: COMMAND_SPECS.find((spec) => spec.name === "session")! });
    expect(parseCliInvocation(["mcp", "status", "codex"])).toEqual({ kind: "command", spec: COMMAND_SPECS.find((spec) => spec.name === "mcp")! });
    expect(parseCliInvocation(["tui"])).toEqual({ kind: "command", spec: COMMAND_SPECS.find((spec) => spec.name === "tui")! });
    expect(parseCliInvocation(["verify", "--evidence"])).toEqual({ kind: "command", spec: COMMAND_SPECS.find((spec) => spec.name === "verify")! });
    expect(parseCliInvocation(["exec", "--version", "--help"])).toEqual({ kind: "help" });
    expect(parseCliInvocation(["missing"])).toEqual({ kind: "unknown", name: "missing" });
  });

  test("shows help successfully when invoked without a command", async () => {
    expect(parseCliInvocation([])).toEqual({ kind: "help" });

    const result = await runCli([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${renderHelp()}\n`);
    expect(result.stderr).toBe("");
  });

  test("prints large JSON responses as one complete parseable document", async () => {
    const child = Bun.spawn([
      "bun",
      "-e",
      `import { printJson } from ${JSON.stringify(cliSharedUrl)}; printJson({ payload: "x".repeat(100_000) });`,
    ], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({ payload: "x".repeat(100_000) });
  });

  test("recognizes all value-taking v0.2 flags", () => {
    for (const flag of ["--session-id", "--limit", "--check", "--timeout-ms", "--cwd", "--extension-config", "--lead"]) {
      expect(VALUE_FLAGS.has(flag)).toBe(true);
    }
    expect(getPrompt(["exec", "--session-id", "session-1", "--limit", "2", "prompt"])).toBe("prompt");
    expect(flagArgsBeforeSeparator(["exec", "--cwd", "/repo", "--", "--cwd", "/prompt"])).toEqual(["exec", "--cwd", "/repo"]);
  });

  test("accepts only positive bounded integer arguments", () => {
    expect(parseIntegerArg(["exec", "--timeout-ms", "1"], "--timeout-ms")).toBe(1);
    expect(parseIntegerArg(["events", "--limit", "1000"], "--limit", 1000)).toBe(1000);
    for (const value of ["0", "-1", "1.5", "NaN", "9007199254740992", "86400001"]) {
      expect(() => parseIntegerArg(["exec", "--timeout-ms", value], "--timeout-ms")).toThrow();
    }
    expect(() => parseIntegerArg(["events", "--limit", "1001"], "--limit", 1000)).toThrow();
  });

  test("parses root budget commands while keeping them experimental", () => {
    expect(parseBudgetCommand(["budget", "list"])).toEqual({ method: "budget.list", params: {} });
    expect(parseBudgetCommand(["budget", "upsert", "--id", "project-limit", "--max-requests", "20", "--max-cost-usd", "10", "--max-retries", "0"]))
      .toEqual({ method: "budget.upsert", params: { id: "project-limit", maxRequests: 20, maxCostUsd: 10, maxRetries: 0 } });
    expect(() => parseBudgetCommand(["budget", "upsert", "--id", "project-limit", "--max-requests", "0"])).toThrow("positive safe integer");
    expect(parseBudgetCommand(["budget", "linked-hold", "inspect", "--link-id", "a".repeat(64)])).toEqual({
      offline: "inspect",
      linkId: "a".repeat(64),
    });
    expect(parseBudgetCommand([
      "budget", "linked-hold", "quarantine", "--link-id", "a".repeat(64),
      "--expected-digest", "b".repeat(64), "--resolution", "exhaust", "--confirm",
    ])).toEqual({
      offline: "quarantine",
      linkId: "a".repeat(64),
      expectedDigest: "b".repeat(64),
      resolution: "exhaust",
      confirm: true,
    });
    expect(() => parseBudgetCommand(["budget", "linked-hold", "inspect", "--link-id", "a", "--link-id", "b"])).toThrow("one literal");
    expect(() => parseBudgetCommand(["budget", "linked-hold", "inspect", "--link-id", "*"])).toThrow("one literal");
    expect(parseCliInvocation(["budget", "list"])).toEqual({ kind: "unknown", name: "budget" });
    expect(parseCliInvocation(["experimental", "budget", "list"])).toEqual({ kind: "command", spec: COMMAND_SPECS.find((spec) => spec.name === "budget")! });
  });

  test("published MCP configuration invokes the installed binary only", () => {
    const server = mcpServerCommand("codex");
    expect(server).toEqual({ command: "headless-mcp", args: ["--host", "codex"] });
    expect(JSON.stringify(server)).not.toContain("src/");
    expect(JSON.stringify(server)).not.toContain(".ts");
    expect(typeof runMcpInstall).toBe("function");
  });

  test("help describes required containment and external state without stale repository claims", async () => {
    const result = await runCli(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Required containment is the default");
    expect(result.stdout).toContain("external per-project state");
    expect(result.stdout).not.toContain(".headless");
    expect(result.stdout).not.toContain("best-effort");
    expect(result.stdout).not.toContain("src/mcp/server.ts");
  });

  test("rejects conflicting containment flags before daemon startup", async () => {
    const result = await runCli(["exec", "--require-sandbox", "--unsafe-no-sandbox", "prompt"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Choose either --require-sandbox or --unsafe-no-sandbox");
  });

  test("autonomy rejects unsafe mode and legacy OpenCode serve is removed", async () => {
    const unsafe = await runCli(["experimental", "autonomy", "start", "--unsafe-no-sandbox"]);
    expect(unsafe.exitCode).toBe(1);
    expect(unsafe.stderr).toContain("Autonomy prohibits --unsafe-no-sandbox");

    const legacy = await runCli(["experimental", "launch", "opencode-serve"]);
    expect(legacy.exitCode).toBe(1);
    expect(legacy.stderr).toContain("bypasses daemon containment");
  });

  test("init creates only external state and leaves the project untouched", async () => {
    const project = mkdtempSync(join(tmpdir(), "headless-cli-project-"));
    const state = mkdtempSync(join(tmpdir(), "headless-cli-state-"));
    writeFileSync(join(project, "marker.txt"), "unchanged\n");
    const before = readdirSync(project);
    const result = await runCli(["init", "--cwd", project], { HEADLESS_STATE_HOME: state });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("external state");
    expect(result.stdout).toContain("checkout and .gitignore were not modified");
    expect(readdirSync(project)).toEqual(before);
    expect(readdirSync(join(state, "projects")).length).toBe(1);
  });

  test("daemon serve handles termination through the daemon-owned shutdown path", async () => {
    const project = mkdtempSync(join(tmpdir(), "headless-cli-daemon-project-"));
    const state = mkdtempSync(join(tmpdir(), "headless-cli-daemon-state-"));
    const child = Bun.spawn(["bun", cliPath, "daemon", "serve", "--cwd", project], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...processEnv(), HEADLESS_STATE_HOME: state },
    });
    let ready = false;
    let signalReady: () => void = () => {};
    const readyPromise = new Promise<void>((resolve) => { signalReady = resolve; });
    const stderrPromise = (async () => {
      const decoder = new TextDecoder();
      let text = "";
      for await (const chunk of child.stderr) {
        text += decoder.decode(chunk, { stream: true });
        if (!ready && text.includes("Headless daemon ready")) {
          ready = true;
          signalReady();
        }
      }
      return text + decoder.decode();
    })();
    await Promise.race([
      readyPromise,
      child.exited.then((exitCode) => { throw new Error(`daemon exited before readiness with ${exitCode}`); }),
      Bun.sleep(schedulingWindow(5_000)).then(() => { throw new Error("daemon readiness timed out"); }),
    ]);
    child.kill("SIGTERM");
    const [exitCode, stderr] = await Promise.all([child.exited, stderrPromise]);
    expect(exitCode).toBe(143);
    expect(stderr).toContain("Headless daemon ready");
  });

  test("daemon stop signals the authenticated socket owner and never autostarts a missing daemon", async () => {
    const project = mkdtempSync(join(tmpdir(), "headless-cli-daemon-stop-project-"));
    const state = mkdtempSync(join(tmpdir(), "headless-cli-daemon-stop-state-"));
    const env = { HEADLESS_STATE_HOME: state };
    const child = Bun.spawn(["bun", cliPath, "daemon", "serve", "--cwd", project], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...processEnv(), ...env },
    });
    let ready = false;
    let signalReady: () => void = () => {};
    const readyPromise = new Promise<void>((resolve) => { signalReady = resolve; });
    const stderrPromise = (async () => {
      const decoder = new TextDecoder();
      let text = "";
      for await (const chunk of child.stderr) {
        text += decoder.decode(chunk, { stream: true });
        if (!ready && text.includes("Headless daemon ready")) {
          ready = true;
          signalReady();
        }
      }
      return text + decoder.decode();
    })();
    await Promise.race([
      readyPromise,
      child.exited.then((exitCode) => { throw new Error(`daemon exited before readiness with ${exitCode}`); }),
      Bun.sleep(schedulingWindow(5_000)).then(() => { throw new Error("daemon readiness timed out"); }),
    ]);

    const stopped = await runCli(["daemon", "stop", "--cwd", project], env);
    const [daemonExit, daemonStderr] = await Promise.all([child.exited, stderrPromise]);
    expect(stopped.exitCode).toBe(0);
    expect(JSON.parse(stopped.stdout)).toEqual({ stopped: true, pid: child.pid });
    expect(daemonExit).toBe(143);
    expect(daemonStderr).toContain("Headless daemon ready");

    const absent = await runCli(["daemon", "stop", "--cwd", project], env);
    expect(absent.exitCode).toBe(1);
    expect(absent.stderr).toContain("No Headless daemon is running");
  }, 45_000);

  test("session send waits for the durable daemon job and leaves its owned daemon cleanly stoppable", async () => {
    const root = mkdtempSync(join(tmpdir(), "headless-cli-session-"));
    const project = join(root, "project");
    const state = join(root, "state");
    const bin = join(root, "bin");
    mkdirSync(project);
    mkdirSync(bin);
    const backend = join(bin, "opencode");
    writeFileSync(backend, "#!/usr/bin/env bun\nconsole.log(JSON.stringify({type:'text',text:'session complete'}));\n");
    chmodSync(backend, 0o700);
    const env = { HEADLESS_STATE_HOME: state, PATH: `${bin}:${process.env.PATH ?? ""}`, OPENAI_API_KEY: "test-only-key" };
    const daemon = Bun.spawn(["bun", cliPath, "daemon", "serve", "--cwd", project, "--experimental-sessions"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...processEnv(), ...env },
    });
    const daemonStdout = Bun.readableStreamToText(daemon.stdout);
    let daemonReady = false;
    let signalReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => { signalReady = resolve; });
    const daemonStderr = (async () => {
      const decoder = new TextDecoder();
      let text = "";
      for await (const chunk of daemon.stderr) {
        text += decoder.decode(chunk, { stream: true });
        if (!daemonReady && text.includes("Headless daemon ready")) {
          daemonReady = true;
          signalReady();
        }
      }
      return text + decoder.decode();
    })();

    try {
      await Promise.race([
        ready,
        daemon.exited.then((exitCode) => { throw new Error(`daemon exited before readiness with ${exitCode}`); }),
        Bun.sleep(schedulingWindow(5_000)).then(() => { throw new Error("daemon readiness timed out"); }),
      ]);
      const created = await runCli(["experimental", "session", "create", "--cwd", project, "--backend", "opencode", "--model", "openai/test-model", "--auth-mode", "broker", "--unsafe-no-sandbox"], env);
      expect(created.exitCode, created.stderr).toBe(0);
      const session = JSON.parse(created.stdout) as { id: string };

      const sending = runCli([
        "experimental", "session", "send", "--cwd", project, "--session-id", session.id,
        "--timeout-ms", "15000", "first request",
      ], env);
      const approval = await waitForPendingApproval(project, env);
      const resolved = await runCli([
        "experimental", "approval", "resolve", "--cwd", project, "--approval-id", approval.id,
        "--decision", "approved", "--resolution", "Test fixture pricing is intentionally unknown.",
      ], env);
      expect(resolved.exitCode, resolved.stderr).toBe(0);
      const sent = await sending;
      expect(sent.exitCode, sent.stderr || sent.stdout).toBe(0);
      const response = JSON.parse(sent.stdout) as { job: { state: string }; result: { output: string } };
      expect(response.job.state).toBe("succeeded");
      expect(response.result.output).toBe("session complete");
    } finally {
      const stopped = daemonReady ? await runCli(["daemon", "stop", "--cwd", project], env) : null;
      const [exitCode, stderr] = await Promise.all([daemon.exited, daemonStderr, daemonStdout]);
      rmSync(root, { recursive: true, force: true });
      if (stopped) {
        expect(stopped.exitCode, stopped.stderr).toBe(0);
        expect(exitCode, stderr).toBe(143);
      }
    }
  }, 60_000);
});

async function waitForPendingApproval(project: string, env: Record<string, string>) {
  const deadline = Date.now() + schedulingWindow(10_000);
  while (Date.now() < deadline) {
    const listed = await runCli(["experimental", "approval", "list", "--cwd", project, "--status", "pending"], env);
    if (listed.exitCode === 0) {
      const approvals = JSON.parse(listed.stdout) as Array<{ id: string; kind: string }>;
      const approval = approvals.find((candidate) => candidate.kind === "unpriced_broker_run");
      if (approval) return approval;
    }
    await Bun.sleep(25);
  }
  throw new Error("Timed out waiting for the unpriced broker approval.");
}

async function runCli(args: string[], extraEnv: Record<string, string> = {}) {
  const process = Bun.spawn(["bun", cliPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...processEnv(), ...extraEnv },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    Bun.readableStreamToText(process.stdout),
    Bun.readableStreamToText(process.stderr),
    process.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function processEnv() {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
