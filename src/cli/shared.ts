import { backendChoices, normalizeBackend } from "../backends/ids";
import { connectExistingDaemon, connectOrStartDaemon } from "../daemon/connect";
import type { HeadlessDaemonClient } from "../daemon/client";
import type { Job } from "../contracts/durable";
import type { RunResult } from "../contracts/run";
import { redactAndTruncate } from "../runtime/redaction";
import { HeadlessError, toStructuredError } from "../runtime/headless-error";
import { VALUE_FLAGS } from "./command-specs";
import { CliUsageError, flagArgsBeforeSeparator, readFlagValue } from "./argv";
import { parseExecProfile } from "./profile";
import { printRemedy } from "./remedy";

export const MAX_TIMEOUT_MS = 86_400_000;
export const DEFAULT_RUN_TIMEOUT_MS = 180_000;
export const MAX_EVENT_LIMIT = 1_000;
export const EVENT_POLL_INTERVAL_MS = 250;

// The argv grammar owns these; re-exported so every command import is unchanged.
export { CliUsageError, flagArgsBeforeSeparator };

let activeRun: { client: HeadlessDaemonClient; jobId: string } | null = null;
let activeDaemon: { stop(): Promise<void> } | null = null;
let receivedSignal = false;

export function setActiveDaemon(daemon: { stop(): Promise<void> }) {
  activeDaemon = daemon;
}

export function signalWasReceived() {
  return receivedSignal;
}

export function getArg(argv: string[], name: string) {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return readFlagValue(argv, name, index);
}

export function requiredArg(argv: string[], name: string) {
  const value = getArg(argv, name);
  if (!value) throw new CliUsageError(`${name} is required.`);
  return value;
}

export function getRepeatedArgs(argv: string[], name: string) {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== name) continue;
    const value = readFlagValue(argv, name, index);
    // getArg tolerates "" because callers spell their default as
    // `getArg(...) || fallback` and the error renderer reads --cwd. A repeated
    // flag has no such fallback — every value is a required identifier — so it
    // keeps its stricter contract instead of letting "" reach the daemon.
    if (value === "") throw new CliUsageError(`Missing value for ${name}.`);
    values.push(value);
    index += 1;
  }
  return values;
}

export function parseIntegerArg(argv: string[], name: string, maximum = MAX_TIMEOUT_MS) {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined) throw new CliUsageError(`Missing value for ${name}.`);
  if (!/^\d+$/.test(value.trim())) throw invalidInteger(name, maximum);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) throw invalidInteger(name, maximum);
  return parsed;
}

export function getPrompt(argv: string[]) {
  const separator = argv.indexOf("--");
  if (separator >= 0) return argv.slice(separator + 1).join(" ") || undefined;
  const positionals: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("-")) {
      if (VALUE_FLAGS.has(token)) index += 1;
      continue;
    }
    positionals.push(token);
  }
  if (positionals.length > 1) {
    throw new CliUsageError(`Unexpected extra prompt argument${positionals.length === 2 ? "" : "s"}: ${positionals.slice(1).join(" ")}`);
  }
  return positionals[0];
}

export function getMode(argv: string[]): "read-only" | "write" | undefined {
  const value = getArg(argv, "--mode");
  if (!value) return undefined;
  if (value !== "read-only" && value !== "write") throw new CliUsageError(`Invalid --mode ${value}. Expected read-only or write.`);
  return value;
}

export function getAuthMode(argv: string[]): "native-login" | "broker" | undefined {
  const value = getArg(argv, "--auth-mode");
  if (!value) return undefined;
  if (value !== "native-login" && value !== "broker") {
    throw new CliUsageError(`Invalid --auth-mode ${value}. Expected native-login or broker.`);
  }
  return value;
}

/** Resolve --profile and optional explicit flags; profile never overrides an explicit flag. */
export function resolveExecPolicy(argv: string[]) {
  let profile;
  try {
    profile = parseExecProfile(getArg(argv, "--profile"));
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }
  const mode = getMode(argv) ?? profile?.mode;
  const authMode = getAuthMode(argv) ?? profile?.authMode;
  const containment = argv.includes("--unsafe-no-sandbox") || argv.includes("--require-sandbox")
    ? parseContainment(argv)
    : (profile?.containment ?? parseContainment(argv));
  return { profile, mode, authMode, containment };
}

export function shellCwdArg(cwd: string) {
  if (/^[A-Za-z0-9_./:-]+$/.test(cwd)) return cwd;
  return JSON.stringify(cwd);
}

export function getApprovalPolicy(argv: string[]): "ask" | "auto" | "bypass" | undefined {
  const value = getArg(argv, "--approval-policy");
  if (!value) return undefined;
  if (value !== "ask" && value !== "auto" && value !== "bypass") {
    throw new CliUsageError(`Invalid --approval-policy ${value}. Expected ask, auto, or bypass.`);
  }
  return value;
}

export function parseBackend(value: string) {
  try {
    return normalizeBackend(value);
  } catch {
    if (/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) return value;
    throw new CliUsageError(`Invalid --backend ${value}. Expected a built-in alias or a configured extension id.`);
  }
}

export function backendUsage() {
  return backendChoices().join("|");
}

export function parseContainment(argv: string[]) {
  const unsafe = argv.includes("--unsafe-no-sandbox");
  const required = argv.includes("--require-sandbox");
  if (unsafe && required) throw new CliUsageError("Choose either --require-sandbox or --unsafe-no-sandbox, not both.");
  return unsafe ? "unsafe" as const : "required" as const;
}

export function ensureSupportedPlatform() {
  if (process.platform === "win32") {
    throw new HeadlessError("UNSUPPORTED_PLATFORM", "Headless v0.2 does not support Windows.");
  }
}

export async function daemonClient(
  projectRoot: string,
  flags: string[] = [],
  options: { enableExperimentalSessions?: boolean } = {},
) {
  ensureSupportedPlatform();
  return connectOrStartDaemon({
    projectRoot,
    extensionConfigPath: getArg(flags, "--extension-config"),
    extensionModules: getRepeatedArgs(flags, "--extension-module"),
    enableExperimentalSessions: options.enableExperimentalSessions,
  });
}

/** Connect to a live project daemon without turning an inspection into startup. */
export async function runningDaemonClient(projectRoot: string, flags: string[] = []) {
  ensureSupportedPlatform();
  const client = await connectExistingDaemon({
    projectRoot,
    extensionConfigPath: getArg(flags, "--extension-config"),
    extensionModules: getRepeatedArgs(flags, "--extension-module"),
  });
  if (!client) {
    throw new HeadlessError("DAEMON_UNAVAILABLE", `No Headless daemon is running for ${projectRoot}.`);
  }
  return client;
}

export async function submitAndWait(client: HeadlessDaemonClient, request: Record<string, unknown>) {
  const timeoutMs = Number(request.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
  const submitted = await client.call<Job>("run.submit", request);
  const completed = await waitForJob(client, submitted, timeoutMs);
  if (!completed.result) throw new Error(`Job ${submitted.id} reached ${completed.state} without a result.`);
  return completed.result;
}

export async function waitForJob(client: HeadlessDaemonClient, job: Job, timeoutMs: number) {
  if (job.result) return job;
  activeRun = { client, jobId: job.id };
  try {
    const waitTimeoutMs = boundedWaitTimeout(timeoutMs);
    return await client.call<Job>("run.wait", { jobId: job.id, timeoutMs: waitTimeoutMs }, Math.min(waitTimeoutMs + 2_000, MAX_TIMEOUT_MS));
  } finally {
    activeRun = null;
  }
}

export function runResultNextCommands(result: RunResult, cwd = process.cwd()) {
  const cwdArg = shellCwdArg(cwd);
  if (!result.jobId) return null;
  return {
    verify: `headless verify --cwd ${cwdArg}`,
    receipt: `headless experimental receipt show ${result.jobId} --cwd ${cwdArg}`,
  };
}

export function printRunResult(result: RunResult, json: boolean, stream: boolean, options: { cwd?: string } = {}) {
  const cwd = options.cwd ?? process.cwd();
  const next = runResultNextCommands(result, cwd);
  if (json) {
    printJson(next ? { ...result, next } : result);
    return;
  }
  const output = result.output ? redactAndTruncate(result.output).text : "(no text output)";
  if (stream) process.stdout.write(output);
  else console.log(output);
  const meta: string[] = [];
  if (result.cost.amountUsd != null || result.usage.providerTotal != null) {
    meta.push(`cost: ${result.cost.amountUsd ?? "n/a"}  tokens: ${result.usage.providerTotal ?? "n/a"}  time: ${result.durationMs}ms`);
  }
  if (result.jobId) meta.push(`job: ${result.jobId}`);
  if (meta.length) console.error(`\n---\n${meta.join("\n")}`);
  if (result.containment.unsafe) console.error("WARNING: result was produced without required OS containment.");
  // Artifact-first aha (P.AHA): always point at verify / receipt after a durable job.
  if (next && !stream) {
    console.error(`Next: ${next.verify}`);
    console.error(`Receipt: ${next.receipt}`);
  }
  if (result.error) {
    printRemedy(result.error.code, result.error.message, cwd);
  }
}

/** Write one complete JSON document without console/renderer byte clipping. */
export function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function boundedCouncilTimeout(runTimeoutMs: number, participants: number) {
  const phases = 4;
  return Math.min(runTimeoutMs * phases * Math.max(1, participants) + 10_000, MAX_TIMEOUT_MS);
}

export function boundedGateTimeout(checkTimeoutMs: number, checks: number) {
  return Math.min(checkTimeoutMs * Math.max(1, checks) + 10_000, MAX_TIMEOUT_MS);
}

export async function handleSignal(signal: NodeJS.Signals) {
  if (receivedSignal) return;
  receivedSignal = true;
  if (activeRun) {
    try {
      await activeRun.client.call("run.cancel", { jobId: activeRun.jobId }, 2_000);
    } catch (error) {
      reportSignalFailure("Active run cancellation failed", error);
    }
  }
  let shutdownFailed = false;
  if (activeDaemon) {
    try {
      await activeDaemon.stop();
    } catch (error) {
      shutdownFailed = true;
      reportSignalFailure("Daemon shutdown failed", error);
    }
  }
  process.exit(shutdownFailed ? 1 : signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143);
}

function reportSignalFailure(label: string, error: unknown) {
  const structured = toStructuredError(error);
  console.error(`${label}: ${structured.code}: ${structured.message}`);
}

function boundedWaitTimeout(runTimeoutMs: number) {
  return Math.min(runTimeoutMs + 10_000, MAX_TIMEOUT_MS);
}

function invalidInteger(name: string, maximum: number) {
  return new CliUsageError(`Invalid value for ${name}: expected a positive integer no greater than ${maximum}.`);
}
