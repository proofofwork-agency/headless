import { backendChoices, normalizeBackend } from "../backends/ids";
import { connectOrStartDaemon } from "../daemon/connect";
import type { HeadlessDaemonClient } from "../daemon/client";
import type { Job } from "../contracts/durable";
import type { RunResult } from "../contracts/run";
import { redactAndTruncate } from "../runtime/redaction";
import { HeadlessError, toStructuredError } from "../runtime/headless-error";
import { VALUE_FLAGS } from "./command-specs";

export const MAX_TIMEOUT_MS = 86_400_000;
export const DEFAULT_RUN_TIMEOUT_MS = 180_000;
export const MAX_EVENT_LIMIT = 1_000;
export const EVENT_POLL_INTERVAL_MS = 250;

export class CliUsageError extends Error {}

let activeRun: { client: HeadlessDaemonClient; jobId: string } | null = null;
let activeDaemon: { stop(): Promise<void> } | null = null;
let receivedSignal = false;

export function setActiveDaemon(daemon: { stop(): Promise<void> }) {
  activeDaemon = daemon;
}

export function signalWasReceived() {
  return receivedSignal;
}

export function flagArgsBeforeSeparator(argv: string[]) {
  const index = argv.indexOf("--");
  return index === -1 ? argv : argv.slice(0, index);
}

export function getArg(argv: string[], name: string) {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) throw new CliUsageError(`Missing value for ${name}.`);
  return value;
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
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) throw new CliUsageError(`Missing value for ${name}.`);
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

export function printRunResult(result: RunResult, json: boolean, stream: boolean) {
  if (json) {
    printJson(result);
    return;
  }
  const output = result.output ? redactAndTruncate(result.output).text : "(no text output)";
  if (stream) process.stdout.write(output);
  else console.log(output);
  if (result.cost.amountUsd != null || result.usage.providerTotal != null) {
    console.error(`\n---\ncost: ${result.cost.amountUsd ?? "n/a"}  tokens: ${result.usage.providerTotal ?? "n/a"}  time: ${result.durationMs}ms`);
  }
  if (result.containment.unsafe) console.error("WARNING: result was produced without required OS containment.");
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
