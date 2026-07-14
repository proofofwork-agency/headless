import type { Job } from "../../contracts/durable";
import {
  daemonClient,
  ensureSupportedPlatform,
  flagArgsBeforeSeparator,
  getArg,
} from "../shared";
import { normalizeMcpHost, runMcpInstall } from "./mcp";

export type InitCommandDependencies = {
  client?: typeof daemonClient;
  installMcp?: typeof runMcpInstall;
  log?: (message: string) => void;
};

export async function runTuiCommand(args: string[]) {
  ensureSupportedPlatform();
  const { runTui } = await import("../../tui/App.js");
  await runTui({ projectRoot: tuiProjectRoot(args) });
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

export async function runDoctorCommand(args: string[]) {
  const flags = flagArgsBeforeSeparator(args);
  const client = await daemonClient(getArg(flags, "--cwd") || process.cwd(), flags);
  const [ping, snapshot] = await Promise.all([
    client.call<{ projectId: string; projectRoot: string; principal: string }>("ping"),
    client.call<{ jobs: Job[]; events: unknown[] }>("events.snapshot", { limit: 10 }),
  ]);
  console.log("headless doctor — v0.2 daemon and runtime self-check");
  console.log(`Bun runtime: ${Bun.version}`);
  console.log(`Project: ${ping.projectRoot}`);
  console.log(`Project ID: ${ping.projectId}`);
  console.log(`Authenticated principal: ${ping.principal}`);
  console.log(`External state: ${client.state.projectDir}`);
  for (const backend of ["opencode", "codex", "claude", "grok"]) {
    console.log(`  backend ${backend}: ${Bun.which(backend) ? "found" : "not on PATH"}`);
  }
  console.log(`Durable jobs: ${snapshot.jobs.length}; recent events: ${snapshot.events.length}`);
  console.log("Containment defaults to required. Unsafe execution is explicit and never used by autonomy or councils.");
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
