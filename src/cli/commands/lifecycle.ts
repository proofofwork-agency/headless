import type { Job } from "../../contracts/durable";
import { HeadlessError } from "../../runtime/headless-error";
import type { BrokerEnvReadiness } from "../../runtime/broker-env";
import {
  daemonClient,
  ensureSupportedPlatform,
  flagArgsBeforeSeparator,
  getArg,
  printJson,
  shellCwdArg,
} from "../shared";
import { EXEC_PROFILES, profileChoices } from "../profile";
import {
  BACKEND_INVENTORY,
  buildDoctorReport,
  inventoryBackends,
  printDoctorHuman,
} from "../readiness";
import { normalizeMcpHost, runMcpInstall } from "./mcp";

export type InitCommandDependencies = {
  client?: typeof daemonClient;
  installMcp?: typeof runMcpInstall;
  log?: (message: string) => void;
  which?: (command: string) => string | null;
};

export async function runTuiCommand(args: string[]) {
  ensureSupportedPlatform();
  ensureInteractiveTerminal();
  const { runTui } = await import("../../tui/App.js");
  await runTui({ projectRoot: tuiProjectRoot(args) });
}

/**
 * Ink puts stdin into raw mode, which is unavailable when stdin is a pipe, a
 * redirect, or a CI runner. Reaching render() there throws from inside React
 * and reaches the operator as a framework stack trace citing node_modules.
 * Refuse before rendering so a non-interactive caller gets one actionable line.
 */
function ensureInteractiveTerminal() {
  if (process.stdin.isTTY && process.stdout.isTTY) return;
  throw new HeadlessError(
    "UNSUPPORTED_PLATFORM",
    "The observer TUI needs an interactive terminal, so it cannot run through a pipe, a redirect, or a CI runner. For non-interactive output use `headless status --json`, `headless doctor --json`, or `headless experimental events`.",
  );
}

export function tuiProjectRoot(args: string[], fallback = process.cwd()) {
  return getArg(flagArgsBeforeSeparator(args), "--cwd") || fallback;
}

export async function runInitCommand(args: string[], dependencies: InitCommandDependencies = {}) {
  const flags = flagArgsBeforeSeparator(args);
  const lead = getArg(flags, "--lead");
  const host = lead ? normalizeMcpHost(lead) : null;
  const log = dependencies.log ?? console.log;
  const client = await (dependencies.client ?? daemonClient)(getArg(flags, "--cwd") || process.cwd(), flags);
  const ping = await client.call<{ projectId: string; projectRoot: string; principal: string }>("ping");
  log(`Initialized Headless v0.2 external state for ${ping.projectRoot}.`);
  log(`State: ${client.state.projectDir}`);
  log("The project checkout and .gitignore were not modified.");
  if (host) {
    await (dependencies.installMcp ?? runMcpInstall)(host, { checkoutRoot: ping.projectRoot });
    await client.call("lead.use", { host });
    log(`Configured ${host} as the foreground lead. Project trust and native egress remain unchanged.`);
  }
}

/**
 * Golden-path wizard: init external state, inventory CLIs, print the exact
 * next commands. Does not auto-grant native trust unless the operator passes
 * the same intentional-friction flags used by `project trust grant`.
 */
export async function runSetupCommand(args: string[], dependencies: InitCommandDependencies = {}) {
  const flags = flagArgsBeforeSeparator(args);
  const cwd = getArg(flags, "--cwd") || process.cwd();
  const which = dependencies.which ?? ((name: string) => Bun.which(name));
  const log = dependencies.log ?? console.log;
  const yes = flags.includes("--yes");
  const grantNative = flags.includes("--allow-native-direct-unrestricted");
  const lead = getArg(flags, "--lead");

  await runInitCommand(args, dependencies);

  const backends = inventoryBackends({ which });
  const found = backends.filter((backend) => backend.onPath);
  const usable = backends.filter((backend) => backend.onPath && backend.nativeCapsulePresent);
  const recommended = usable[0]?.id ?? found[0]?.id ?? "opencode";
  log("");
  log("Backend inventory:");
  for (const backend of backends) {
    const path = backend.onPath ? "found" : "not on PATH";
    const capsule = backend.nativeCapsulePresent ? "capsule ok" : "capsule missing";
    log(`  ${backend.id}: ${path} · ${capsule}`);
    if (backend.remedy) log(`    Next: ${backend.remedy}`);
  }
  if (found.length === 0) {
    log("No supported coder CLIs found. Install codex, opencode, claude, or grok, then re-run setup.");
  } else {
    log(`Recommended backend: ${recommended}`);
  }

  if (grantNative) {
    const client = await (dependencies.client ?? daemonClient)(cwd, flags);
    await client.call("project.trust.grant", {
      nativeLoginAllowed: true,
      nativeDirectUnrestrictedAcknowledged: true,
      bypassAllowed: flags.includes("--allow-bypass"),
    });
    log("Granted project trust with native unrestricted-egress acknowledgement.");
  }

  const cwdArg = shellCwdArg(cwd);
  log("");
  log("Golden path (≤ 4 decisions after CLIs are installed):");
  if (!grantNative) {
    log(`  1) headless project trust grant --allow-native-direct-unrestricted --cwd ${cwdArg}`);
    log("     (intentional friction: acknowledges unrestricted provider egress for native login)");
  }
  log(`  ${grantNative ? "1" : "2"}) headless exec --backend ${recommended} --auth-mode native-login --profile read-only-native --cwd ${cwdArg} -- "Explain this repository."`);
  log(`  ${grantNative ? "2" : "3"}) headless verify --cwd ${cwdArg}`);
  log(`  ${grantNative ? "3" : "4"}) headless tui --cwd ${cwdArg}   # optional observer`);
  if (lead) log(`Lead host ${lead} was configured during init when --lead was passed.`);
  log("");
  log(`Profiles: ${profileChoices().join(", ")} — ${EXEC_PROFILES["read-only-native"].description}`);
  log(`Doctor panel: headless doctor --json --cwd ${cwdArg}`);
  if (!yes && !grantNative) {
    log("Tip: re-run with --yes --allow-native-direct-unrestricted to init + grant native trust non-interactively.");
  }
}

export async function runDoctorCommand(args: string[]) {
  const flags = flagArgsBeforeSeparator(args);
  const cwd = getArg(flags, "--cwd") || process.cwd();
  const client = await daemonClient(cwd, flags);
  const [ping, snapshot, trust] = await Promise.all([
    client.call<{
      projectId: string;
      projectRoot: string;
      principal: string;
      brokerEnv?: BrokerEnvReadiness[];
    }>("ping"),
    client.call<{ jobs: Job[]; events: unknown[] }>("events.snapshot", { limit: 10 }),
    client.call<{
      trusted: boolean;
      nativeLoginAllowed: boolean;
      nativeDirectUnrestrictedAcknowledged: boolean;
      bypassAllowed: boolean;
    }>("project.trust.status"),
  ]);
  const report = buildDoctorReport({
    projectRoot: ping.projectRoot,
    projectId: ping.projectId,
    principal: ping.principal,
    stateDir: client.state.projectDir,
    trust: {
      trusted: trust.trusted,
      nativeLoginAllowed: trust.nativeLoginAllowed,
      nativeDirectUnrestrictedAcknowledged: trust.nativeDirectUnrestrictedAcknowledged,
      bypassAllowed: trust.bypassAllowed,
    },
    durableJobs: snapshot.jobs.length,
    recentEvents: snapshot.events.length,
    brokerEnv: ping.brokerEnv ?? [],
    brokerEnvSource: ping.brokerEnv ? "daemon" : "unavailable",
  });
  if (flags.includes("--json") || flags.includes("-j")) {
    printJson(report);
    return;
  }
  printDoctorHuman(report);
}

export async function runStatusCommand(args: string[]) {
  const flags = flagArgsBeforeSeparator(args);
  const client = await daemonClient(getArg(flags, "--cwd") || process.cwd(), flags);
  const sessionId = getArg(flags, "--session-id");
  const [ping, tasks, snapshot, orchestration] = await Promise.all([
    client.call("ping"),
    client.call("ledger.task", { sessionId }),
    client.call("events.snapshot", { sessionId, limit: 10 }),
    client.call("orchestrator.status"),
  ]);
  console.log(JSON.stringify({ daemon: ping, tasks, snapshot, orchestration }, null, 2));
}

// Re-export inventory for tests that pin the backend list.
export { BACKEND_INVENTORY };
