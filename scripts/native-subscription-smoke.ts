import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  evaluateNativeSmokeGate,
  nativeSmokeAcceptedLimitation,
  nativeSmokeContainmentSummary,
  nativeSmokeEvidenceValid,
} from "./native-smoke-evidence";

const OPT_IN_ENV = "HEADLESS_NATIVE_SMOKE";
const CLI_TIMEOUT_MS = 90_000;
const DAEMON_START_TIMEOUT_MS = 10_000;
const DAEMON_STOP_TIMEOUT_MS = 10_000;
const MAX_CHILD_OUTPUT_BYTES = 1_000_000;

if (process.env[OPT_IN_ENV] !== "1") {
  console.error(`Native subscription smoke is disabled. Set ${OPT_IN_ENV}=1 only on a trusted host with intentionally logged-in CLIs.`);
  process.exit(2);
}

type Child = ReturnType<typeof Bun.spawn>;
type CommandResult = {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  overflowed: boolean;
};

type BackendSmoke = {
  backend: "claude-code" | "codex" | "opencode" | "grok-build";
  binary: string;
  status: "passed" | "skipped" | "failed";
  // A documented, accepted limitation (macOS keychain-only Claude, experimental
  // Grok) that satisfies the release gate rather than failing it.
  acceptedLimitation: boolean;
  // Structured terminal error code, when the backend produced one.
  code: string | null;
  reason: string;
  durationMs: number;
  driverKind: string | null;
  backendVersion: string | null;
  authProfileFingerprint: string | null;
  containment: {
    mechanism: string | null;
    network: string | null;
    credentialAccess: string | null;
  } | null;
  costAmountUsd: number | null;
  usageTotal: number | null;
};

const backends = [
  { backend: "claude-code", binary: "claude" },
  { backend: "codex", binary: "codex" },
  { backend: "opencode", binary: "opencode" },
  { backend: "grok-build", binary: "grok" },
] as const;

const root = mkdtempSync(join(tmpdir(), "headless-native-smoke-"));
const project = join(root, "project");
const stateHome = join(root, "state");
// macOS Unix-domain sockets have a short path limit; TMPDIR commonly expands
// under /var/folders far beyond it. Keep this disposable owner-only runtime at
// the release platforms' canonical short temporary root.
const runtimeHome = mkdtempSync(join("/tmp", "hns-runtime-"));
const cliPath = resolve(import.meta.dir, "../dist/cli.js");
const env = nativeSmokeEnvironment(process.env, stateHome, runtimeHome);
const controller = new AbortController();
let signalExitCode: number | null = null;
let daemon: Child | null = null;
let daemonOutput: Promise<{ stdout: string; stderr: string }> | null = null;

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
  process.once(signal, () => {
    signalExitCode = code;
    controller.abort(signal);
  });
}

try {
  assertCompiledCli(cliPath);
  mkdirSync(project, { mode: 0o700 });
  mkdirSync(stateHome, { mode: 0o700 });
  await initializeFixture(project, env, controller.signal);
  const baseline = await repositorySnapshot(project, env, controller.signal);

  const started = startDaemon(cliPath, project, env, controller.signal);
  daemon = started.child;
  daemonOutput = started.output;
  await waitForDaemon(project, stateHome, runtimeHome, daemon, controller.signal);
  // Native-login sessions additionally require the explicit unrestricted-egress
  // acknowledgement; the disposable smoke project opts in for its lifetime.
  await runCheckedCli(cliPath, ["project", "trust", "grant", "--allow-native-direct-unrestricted", "--cwd", project], env, controller.signal);

  const results: BackendSmoke[] = [];
  for (const definition of backends) {
    if (controller.signal.aborted) throw new Error(`Native smoke interrupted by ${String(controller.signal.reason)}.`);
    if (!Bun.which(definition.binary)) {
      results.push({
        ...definition,
        status: "skipped",
        acceptedLimitation: false,
        code: null,
        reason: `${definition.binary} is not installed on PATH. A missing required backend does not satisfy the release gate.`,
        durationMs: 0,
        driverKind: null,
        backendVersion: null,
        authProfileFingerprint: null,
        containment: null,
        costAmountUsd: null,
        usageTotal: null,
      });
      continue;
    }
    results.push(await smokeBackend(cliPath, project, env, definition, controller.signal));
  }

  const after = await repositorySnapshot(project, env, controller.signal);
  const repositoryUnchanged = baseline.head === after.head && baseline.status === after.status && after.status === "";
  if (!repositoryUnchanged) {
    for (const result of results) {
      if (result.status === "passed") {
        result.status = "failed";
        result.reason = "The primary checkout changed during read-only native smoke.";
      }
    }
  }
  const gate = evaluateNativeSmokeGate(results, repositoryUnchanged);
  console.log(JSON.stringify({
    version: 2,
    releaseGatePassed: gate.releaseGatePassed,
    requiredBackends: gate.requiredBackends,
    requiredSatisfied: gate.requiredSatisfied,
    requiredRealPass: gate.requiredRealPass,
    compiledArtifactsOnly: true,
    providerApiKeyEnvironmentCleared: true,
    providerCredentialEnvironmentCleared: true,
    repositoryUnchanged,
    results,
  }, null, 2));
  if (!gate.releaseGatePassed) process.exitCode = 1;
} catch (error) {
  console.error(`Native subscription smoke failed: ${safeDiagnostic(error)}`);
  process.exitCode = signalExitCode ?? 1;
} finally {
  if (daemon) await stopDaemon(daemon, DAEMON_STOP_TIMEOUT_MS);
  if (daemonOutput) {
    const output = await daemonOutput.catch(() => ({ stdout: "", stderr: "" }));
    if (daemon?.exitCode !== 0 && daemon?.exitCode !== null && process.exitCode !== 0) {
      const diagnostic = safeDiagnostic(output.stderr || output.stdout);
      if (diagnostic) console.error(`Daemon diagnostic: ${diagnostic}`);
    }
  }
  rmSync(root, { recursive: true, force: true });
  rmSync(runtimeHome, { recursive: true, force: true });
  if (signalExitCode !== null) process.exitCode = signalExitCode;
}

async function smokeBackend(
  cli: string,
  cwd: string,
  childEnv: NodeJS.ProcessEnv,
  definition: typeof backends[number],
  signal: AbortSignal,
): Promise<BackendSmoke> {
  const startedAt = Date.now();
  try {
    const created = await runCheckedCli(cli, [
      // `session` moved behind the experimental namespace in the Beta 1
      // surface refocus; the smoke exercises that compatibility surface.
      "experimental", "session", "create",
      "--cwd", cwd,
      "--backend", definition.backend,
      "--auth-mode", "native-login",
      "--approval-policy", "ask",
      "--require-sandbox",
    ], childEnv, signal);
    const session = parseObject(created.stdout, `${definition.backend} session.create`);
    const sessionId = requiredString(session.id, `${definition.backend} session id`);
    const sent = await runBounded([
      process.execPath, cli,
      "experimental", "session", "send",
      "--cwd", cwd,
      "--session-id", sessionId,
      "--timeout-ms", "60000",
      "--",
      "Reply with OK only. Do not use tools.",
    ], { cwd, env: childEnv, timeoutMs: CLI_TIMEOUT_MS, signal });
    const envelope = parseObject(sent.stdout, `${definition.backend} session.send`);
    const result = objectValue(envelope.result);
    const durableSession = objectValue(envelope.session);
    const native = objectValue(durableSession?.native);
    const containment = objectValue(result?.containment);
    const cost = objectValue(result?.cost);
    const usage = objectValue(result?.usage);
    const evidenceValid = nativeSmokeEvidenceValid(result, native);
    if (sent.exitCode !== 0 || sent.timedOut || sent.overflowed || !evidenceValid) {
      const structuredError = objectValue(result?.error);
      const code = stringValue(structuredError?.code);
      const reason = stringValue(structuredError?.message)
        ?? code
        ?? (sent.timedOut ? "CLI smoke timed out." : sent.overflowed ? "CLI smoke output exceeded its bound." : "Native containment/session evidence was incomplete.");
      return smokeFailure(definition, startedAt, code, reason, native, containment, cost, usage);
    }
    return {
      ...definition,
      status: "passed",
      acceptedLimitation: false,
      code: null,
      reason: "Native subscription turn completed with required native-direct-unrestricted containment.",
      durationMs: Date.now() - startedAt,
      driverKind: stringValue(native?.driverKind),
      backendVersion: stringValue(native?.backendVersion),
      authProfileFingerprint: fingerprintValue(native?.authProfileFingerprint),
      containment: nativeSmokeContainmentSummary(containment),
      costAmountUsd: finiteNumber(cost?.amountUsd),
      usageTotal: finiteNumber(usage?.providerTotal),
    };
  } catch (error) {
    return smokeFailure(definition, startedAt, null, safeDiagnostic(error), null, null, null, null);
  }
}

function smokeFailure(
  definition: typeof backends[number],
  startedAt: number,
  code: string | null,
  reason: string,
  native: Record<string, unknown> | null,
  containment: Record<string, unknown> | null,
  cost: Record<string, unknown> | null,
  usage: Record<string, unknown> | null,
): BackendSmoke {
  const acceptedLimitation = nativeSmokeAcceptedLimitation(definition.backend, code, process.platform);
  return {
    ...definition,
    status: acceptedLimitation ? "skipped" : "failed",
    acceptedLimitation,
    code,
    reason: acceptedLimitation
      ? `${safeDiagnostic(reason)} — documented accepted limitation; does not fail the release gate.`
      : safeDiagnostic(reason),
    durationMs: Date.now() - startedAt,
    driverKind: stringValue(native?.driverKind),
    backendVersion: stringValue(native?.backendVersion),
    authProfileFingerprint: fingerprintValue(native?.authProfileFingerprint),
    containment: nativeSmokeContainmentSummary(containment),
    costAmountUsd: finiteNumber(cost?.amountUsd),
    usageTotal: finiteNumber(usage?.providerTotal),
  };
}

function startDaemon(cli: string, cwd: string, childEnv: NodeJS.ProcessEnv, signal: AbortSignal) {
  // The harness's own daemon must opt into experimental persistent sessions
  // or the `experimental session` namespace refuses to attach to it.
  const child = Bun.spawn([process.execPath, cli, "daemon", "serve", "--cwd", cwd, "--experimental-sessions"], {
    cwd,
    env: childEnv,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const budget = { remaining: 256_000, overflowed: false };
  const stopOnOverflow = () => { void stopDaemon(child, 1_000); };
  const stdout = readBounded(child.stdout, budget, stopOnOverflow);
  const stderr = readBounded(child.stderr, budget, stopOnOverflow);
  signal.addEventListener("abort", () => { void stopDaemon(child, DAEMON_STOP_TIMEOUT_MS); }, { once: true });
  return { child, output: Promise.all([stdout, stderr]).then(([out, err]) => ({ stdout: out, stderr: err })) };
}

async function waitForDaemon(
  cwd: string,
  stateHome: string,
  runtimeHome: string,
  child: Child,
  signal: AbortSignal,
) {
  const canonical = realpathSync.native(cwd);
  const projectId = createHash("sha256").update(canonical, "utf8").digest("hex");
  const socket = join(runtimeHome, `${projectId.slice(0, 32)}.sock`);
  const token = join(stateHome, "projects", projectId, "daemon", "token");
  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
  while (!existsSync(socket) || !existsSync(token)) {
    if (signal.aborted) throw new Error(`Daemon startup interrupted by ${String(signal.reason)}.`);
    if (child.exitCode !== null) throw new Error(`Compiled daemon exited during startup with code ${child.exitCode}.`);
    if (Date.now() >= deadline) throw new Error("Compiled daemon did not become ready within 10 seconds.");
    await Bun.sleep(25);
  }
}

async function initializeFixture(cwd: string, childEnv: NodeJS.ProcessEnv, signal: AbortSignal) {
  await runChecked(["git", "init", "--quiet"], { cwd, env: childEnv, timeoutMs: 10_000, signal });
  await runChecked(["git", "config", "user.name", "Headless Native Smoke"], { cwd, env: childEnv, timeoutMs: 10_000, signal });
  await runChecked(["git", "config", "user.email", "headless-smoke@example.invalid"], { cwd, env: childEnv, timeoutMs: 10_000, signal });
  await Bun.write(join(cwd, "README.md"), "# Headless native subscription smoke\n");
  await runChecked(["git", "add", "README.md"], { cwd, env: childEnv, timeoutMs: 10_000, signal });
  await runChecked(["git", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"], { cwd, env: childEnv, timeoutMs: 10_000, signal });
}

async function repositorySnapshot(cwd: string, childEnv: NodeJS.ProcessEnv, signal: AbortSignal) {
  const [head, status] = await Promise.all([
    runChecked(["git", "rev-parse", "HEAD"], { cwd, env: childEnv, timeoutMs: 10_000, signal }),
    runChecked(["git", "status", "--porcelain=v1", "--untracked-files=all"], { cwd, env: childEnv, timeoutMs: 10_000, signal }),
  ]);
  return { head: head.stdout.trim(), status: status.stdout.trim() };
}

async function runCheckedCli(cli: string, args: string[], childEnv: NodeJS.ProcessEnv, signal: AbortSignal) {
  return runChecked([process.execPath, cli, ...args], { cwd: process.cwd(), env: childEnv, timeoutMs: CLI_TIMEOUT_MS, signal });
}

async function runChecked(
  argv: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal: AbortSignal },
) {
  const result = await runBounded(argv, options);
  if (result.exitCode !== 0 || result.timedOut || result.overflowed) {
    throw new Error(`${argv[0]} failed (${result.timedOut ? "timed out" : result.overflowed ? "output overflow" : `exit ${String(result.exitCode)}`}): ${safeDiagnostic(result.stderr || result.stdout)}`);
  }
  return result;
}

async function runBounded(
  argv: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal: AbortSignal },
): Promise<CommandResult> {
  const child = Bun.spawn(argv, {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  let timedOut = false;
  const budget = { remaining: MAX_CHILD_OUTPUT_BYTES, overflowed: false };
  const stop = () => { void stopDaemon(child, 1_000); };
  const timeout = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeoutMs);
  timeout.unref?.();
  const abort = () => stop();
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBounded(child.stdout, budget, stop),
      readBounded(child.stderr, budget, stop),
      child.exited.catch(() => null),
    ]);
    return {
      exitCode,
      signal: child.signalCode ?? null,
      stdout,
      stderr,
      timedOut,
      overflowed: budget.overflowed,
    };
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", abort);
  }
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  budget: { remaining: number; overflowed: boolean },
  overflow: () => void,
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > budget.remaining) {
        output += decoder.decode(value.subarray(0, Math.max(0, budget.remaining)), { stream: true });
        budget.remaining = 0;
        budget.overflowed = true;
        overflow();
        break;
      }
      budget.remaining -= value.byteLength;
      output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } finally {
    reader.releaseLock();
  }
}

async function stopDaemon(child: Child, timeoutMs: number) {
  if (child.exitCode !== null) return;
  signalTree(child, "SIGTERM");
  if (await exitsWithin(child, timeoutMs)) return;
  signalTree(child, "SIGKILL");
  await exitsWithin(child, 2_000);
}

function signalTree(child: Child, signal: "SIGTERM" | "SIGKILL") {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch (error) {
      // Cleanup-only race: the process may have exited between both signal attempts.
      void error;
    }
  }
}

function exitsWithin(child: Child, timeoutMs: number) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return Promise.race([
    child.exited.then(() => true, () => true),
    Bun.sleep(timeoutMs).then(() => false),
  ]);
}

function nativeSmokeEnvironment(source: NodeJS.ProcessEnv, state: string, runtime: string) {
  const childEnv = { ...source };
  for (const key of Object.keys(childEnv)) {
    if (isProviderCredentialEnvironmentKey(key)) delete childEnv[key];
  }
  childEnv.HEADLESS_STATE_HOME = state;
  childEnv.HEADLESS_RUNTIME_HOME = runtime;
  delete childEnv.HEADLESS_EXTENSION_CONFIG;
  return childEnv;
}

function isProviderCredentialEnvironmentKey(key: string) {
  return /(?:^|_)API_KEY$/i.test(key)
    || /^(?:ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|CODEX_API_KEY|GROK_API_KEY|OPENAI_ACCESS_TOKEN|GOOGLE_APPLICATION_CREDENTIALS|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AZURE_OPENAI_KEY)$/i.test(key);
}

function assertCompiledCli(path: string) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`Compiled CLI is unavailable at ${path}. Run bun run build before the opt-in smoke.`);
  }
}

function parseObject(text: string, label: string) {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${label} did not return one structured JSON object.`);
  }
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requiredString(value: unknown, label: string) {
  const result = stringValue(value);
  if (!result) throw new Error(`${label} was missing.`);
  return result;
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function fingerprintValue(value: unknown) {
  const fingerprint = stringValue(value);
  return fingerprint && /^[a-f0-9]{64}$/.test(fingerprint) ? fingerprint : null;
}

function safeDiagnostic(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "[REDACTED_OPENAI_KEY]")
    .replace(/(?:Bearer\s+)[A-Za-z0-9._~+/-]{16,}/gi, "Bearer [REDACTED]")
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .slice(0, 2_048);
}
