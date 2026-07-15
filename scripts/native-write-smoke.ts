import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  evaluateNativeWriteSmokeGate,
  isNativeWriteMergeOutcome,
  nativeSmokeAcceptedLimitation,
  nativeSmokeContainmentSummary,
  nativeWriteSmokeContainmentValid,
} from "./native-smoke-evidence";

const OPT_IN_ENV = "HEADLESS_NATIVE_WRITE_SMOKE";
const CLI_TIMEOUT_MS = 90_000;
const EXEC_RUN_TIMEOUT_MS = 120_000;
const EXEC_WALL_CLOCK_MS = 180_000;
const DAEMON_START_TIMEOUT_MS = 10_000;
const DAEMON_STOP_TIMEOUT_MS = 10_000;
const MAX_CHILD_OUTPUT_BYTES = 1_000_000;

// A single deterministic edit the write turn must make. The whole point of the
// smoke is that this exact line reaches primary only through an authorized
// candidate integration, never before.
const WRITE_SMOKE_FILE = "WRITE_SMOKE.md";
const WRITE_SMOKE_MARKER = "headless native write smoke OK";
const WRITE_TASK = `Create a new file named ${WRITE_SMOKE_FILE} in the repository root. Its entire contents must be exactly this one line: ${WRITE_SMOKE_MARKER}. Do not modify, create, or delete any other file, and do not run any shell command or tool other than the single file edit.`;

if (process.env[OPT_IN_ENV] !== "1") {
  console.error(`Native write smoke is disabled. Set ${OPT_IN_ENV}=1 only on a trusted host with intentionally logged-in CLIs.`);
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

type BackendWriteSmoke = {
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
  candidateId: string | null;
  candidateCommit: string | null;
  mergedInline: boolean;
  integrationOutcome: string | null;
  resultingCommit: string | null;
  // The safety invariant: null when the backend never reached the preserved
  // stage; true/false once a preserved candidate has been observed against
  // primary before any authorized integration.
  primaryUnchangedBeforeIntegration: boolean | null;
  primaryAdvanced: boolean;
  editPresentOnPrimary: boolean;
  containment: {
    mechanism: string | null;
    network: string | null;
    credentialAccess: string | null;
  } | null;
};

const backends = [
  { backend: "claude-code", binary: "claude" },
  { backend: "codex", binary: "codex" },
  { backend: "opencode", binary: "opencode" },
  { backend: "grok-build", binary: "grok" },
] as const;

const root = mkdtempSync(join(tmpdir(), "headless-native-write-smoke-"));
const project = join(root, "project");
const stateHome = join(root, "state");
// macOS Unix-domain sockets have a short path limit; TMPDIR commonly expands
// under /var/folders far beyond it. Keep this disposable owner-only runtime at
// the release platforms' canonical short temporary root.
const runtimeHome = mkdtempSync(join("/tmp", "hnw-runtime-"));
const cliPath = resolve(import.meta.dir, "../dist/cli.js");
const env = nativeWriteSmokeEnvironment(process.env, stateHome, runtimeHome);
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

  const started = startDaemon(cliPath, project, env, controller.signal);
  daemon = started.child;
  daemonOutput = started.output;
  await waitForDaemon(project, stateHome, runtimeHome, daemon, controller.signal);
  // Native-login sessions additionally require the explicit unrestricted-egress
  // acknowledgement; the disposable smoke project opts in for its lifetime.
  await runCheckedCli(cliPath, ["project", "trust", "grant", "--allow-native-direct-unrestricted", "--cwd", project], env, controller.signal);

  const results: BackendWriteSmoke[] = [];
  for (const definition of backends) {
    if (controller.signal.aborted) throw new Error(`Native write smoke interrupted by ${String(controller.signal.reason)}.`);
    if (!Bun.which(definition.binary)) {
      results.push({
        ...definition,
        status: "skipped",
        acceptedLimitation: false,
        code: null,
        reason: `${definition.binary} is not installed on PATH. A missing required backend does not satisfy the release gate.`,
        durationMs: 0,
        candidateId: null,
        candidateCommit: null,
        mergedInline: false,
        integrationOutcome: null,
        resultingCommit: null,
        primaryUnchangedBeforeIntegration: null,
        primaryAdvanced: false,
        editPresentOnPrimary: false,
        containment: null,
      });
      continue;
    }
    results.push(await smokeWriteBackend(cliPath, project, env, definition, controller.signal));
  }

  // The write smoke is expected to advance primary once a candidate is
  // authorized, so the read smoke's primary-unchanged-throughout invariant does
  // not apply. The write invariant is that no preserved candidate ever mutated
  // primary before its authorized integration.
  const primaryPreservedBeforeIntegration = results.every((result) => result.primaryUnchangedBeforeIntegration !== false);
  const gate = evaluateNativeWriteSmokeGate(results, primaryPreservedBeforeIntegration, process.platform);
  console.log(JSON.stringify({
    version: 1,
    releaseGatePassed: gate.releaseGatePassed,
    requiredBackends: gate.requiredBackends,
    requiredSatisfied: gate.requiredSatisfied,
    requiredRealPass: gate.requiredRealPass,
    transientRateLimited: gate.transientRateLimited,
    compiledArtifactsOnly: true,
    providerApiKeyEnvironmentCleared: true,
    providerCredentialEnvironmentCleared: true,
    primaryUnchangedBeforeIntegration: primaryPreservedBeforeIntegration,
    results,
  }, null, 2));
  if (!gate.releaseGatePassed) process.exitCode = 1;
} catch (error) {
  console.error(`Native write smoke failed: ${safeDiagnostic(error)}`);
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

async function smokeWriteBackend(
  cli: string,
  cwd: string,
  childEnv: NodeJS.ProcessEnv,
  definition: typeof backends[number],
  signal: AbortSignal,
): Promise<BackendWriteSmoke> {
  const startedAt = Date.now();
  try {
    const before = await repositorySnapshot(cwd, childEnv, signal);

    // A native-login write turn. Ask-mode keeps the candidate preserved (no inline
    // merge) so the isolation of primary can be proven before an authorized
    // integration. The exec exits non-zero for a preserved/blocked candidate, so
    // the RunResult JSON — not the exit code — is authoritative.
    const executed = await runBounded([
      process.execPath, cli,
      "exec",
      "--backend", definition.backend,
      "--mode", "write",
      "--auth-mode", "native-login",
      "--approval-policy", "ask",
      "--require-sandbox",
      "--json",
      "--cwd", cwd,
      "--timeout-ms", String(EXEC_RUN_TIMEOUT_MS),
      "--",
      WRITE_TASK,
    ], { cwd, env: childEnv, timeoutMs: EXEC_WALL_CLOCK_MS, signal });

    const runResult = parseObject(executed.stdout, `${definition.backend} exec --json`);
    if (isErrorEnvelope(runResult)) {
      const error = objectValue(runResult.error);
      return writeFailure(definition, startedAt, stringValue(error?.code), stringValue(error?.message) ?? "Write exec returned a structured error envelope.");
    }
    const containment = objectValue(runResult.containment);
    const commit = objectValue(runResult.commit);
    const error = objectValue(runResult.error);
    const code = stringValue(error?.code);
    const candidateId = stringValue(runResult.jobId);
    const candidateCommit = stringValue(commit?.candidate);
    const mergedInline = commit?.merged === true;

    if (executed.timedOut || executed.overflowed) {
      return writeFailure(definition, startedAt, code, executed.timedOut ? "Write exec timed out." : "Write exec output exceeded its bound.");
    }
    if (!candidateCommit || !candidateId) {
      // No candidate commit is either a documented accepted limitation
      // (keychain-only Claude, experimental Grok), a transient rate limit, or a
      // genuine failure of the write turn.
      const message = stringValue(error?.message) ?? code ?? "Write turn produced no candidate commit.";
      return writeFailure(definition, startedAt, code, message);
    }
    if (!nativeWriteSmokeContainmentValid(containment)) {
      return writeFailure(definition, startedAt, code, "Write turn did not report required native-direct-unrestricted containment.");
    }

    const containmentSummary = nativeSmokeContainmentSummary(containment);
    const base: BackendWriteSmoke = {
      ...definition,
      status: "failed",
      acceptedLimitation: false,
      code,
      reason: "Write smoke did not complete.",
      durationMs: Date.now() - startedAt,
      candidateId,
      candidateCommit,
      mergedInline,
      integrationOutcome: null,
      resultingCommit: stringValue(commit?.result),
      primaryUnchangedBeforeIntegration: null,
      primaryAdvanced: false,
      editPresentOnPrimary: false,
      containment: containmentSummary,
    };

    // With ask-mode the candidate must be preserved; prove primary is byte-for-byte
    // untouched between the write turn and any authorized integration.
    if (!mergedInline) {
      const afterExec = await repositorySnapshot(cwd, childEnv, signal);
      const preserved = afterExec.head === before.head && afterExec.status === before.status;
      base.primaryUnchangedBeforeIntegration = preserved;
      if (!preserved) {
        return {
          ...base,
          status: "failed",
          reason: "Preserved candidate mutated primary before an authorized integration.",
          durationMs: Date.now() - startedAt,
        };
      }
    }

    if (mergedInline) {
      // Defensive: ask-mode is not expected to auto-merge, but an inline merge is
      // still an authorized integration. Verify primary advanced to the reported
      // resulting commit and the edit is present.
      const merged = await verifyPrimaryIntegrated(cwd, childEnv, before.head, stringValue(commit?.result), signal);
      return {
        ...base,
        status: merged.ok ? "passed" : "failed",
        integrationOutcome: "merged_inline",
        resultingCommit: merged.head,
        primaryAdvanced: merged.advanced,
        editPresentOnPrimary: merged.editPresent,
        reason: merged.ok
          ? "Native-login write auto-merged inline under required containment and reached primary."
          : merged.reason,
        durationMs: Date.now() - startedAt,
      };
    }

    // Resolve the ask-mode merge approval as root, then integrate the preserved
    // candidate through the experimental candidate surface.
    const approvalId = stringValue(objectValue(error?.details)?.approvalId);
    if (approvalId) {
      await runCheckedCli(cli, [
        "experimental", "approval", "resolve",
        "--approval-id", approvalId,
        "--decision", "approved",
        "--resolution", "native write smoke: authorized candidate integration",
        "--cwd", cwd,
      ], childEnv, signal);
    }

    const integrateRun = await runBounded([
      process.execPath, cli,
      "experimental", "candidate", "integrate",
      "--candidate-id", candidateId,
      "--cwd", cwd,
      "--json",
    ], { cwd, env: childEnv, timeoutMs: CLI_TIMEOUT_MS, signal });
    const integrated = parseObject(integrateRun.stdout, `${definition.backend} candidate.integrate`);
    if (isErrorEnvelope(integrated)) {
      const integrateError = objectValue(integrated.error);
      return {
        ...base,
        status: "failed",
        reason: `candidate integrate failed: ${stringValue(integrateError?.message) ?? stringValue(integrateError?.code) ?? "unknown error"}.`,
        durationMs: Date.now() - startedAt,
      };
    }
    const integrationOutcome = stringValue(integrated.outcome);
    const resultingCommit = stringValue(integrated.resultingCommit);
    if (!isNativeWriteMergeOutcome(integrationOutcome)) {
      return {
        ...base,
        status: "failed",
        integrationOutcome,
        reason: `candidate integrate did not merge: ${integrationOutcome ?? "no outcome"}.`,
        durationMs: Date.now() - startedAt,
      };
    }

    const verified = await verifyPrimaryIntegrated(cwd, childEnv, before.head, resultingCommit, signal);
    return {
      ...base,
      status: verified.ok ? "passed" : "failed",
      integrationOutcome,
      resultingCommit: verified.head ?? resultingCommit,
      primaryAdvanced: verified.advanced,
      editPresentOnPrimary: verified.editPresent,
      reason: verified.ok
        ? `Native-login write candidate ${integrationOutcome} to primary after isolated preservation and authorized integration.`
        : verified.reason,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return writeFailure(definition, startedAt, null, safeDiagnostic(error));
  }
}

async function verifyPrimaryIntegrated(
  cwd: string,
  childEnv: NodeJS.ProcessEnv,
  beforeHead: string,
  expectedHead: string | null,
  signal: AbortSignal,
) {
  const after = await repositorySnapshot(cwd, childEnv, signal);
  const advanced = after.head !== beforeHead && after.status === "";
  const headMatches = expectedHead === null || after.head === expectedHead;
  const filePath = join(cwd, WRITE_SMOKE_FILE);
  const editPresent = existsSync(filePath) && readFileSync(filePath, "utf8").includes(WRITE_SMOKE_MARKER);
  const ok = advanced && headMatches && editPresent;
  const reason = !advanced
    ? "Primary did not advance to the integrated commit."
    : !headMatches
      ? "Primary advanced to an unexpected commit."
      : !editPresent
        ? `Integrated commit did not carry ${WRITE_SMOKE_FILE} with the expected marker.`
        : "Integrated.";
  return { ok, advanced: advanced && headMatches, editPresent, head: after.head, reason };
}

function writeFailure(
  definition: typeof backends[number],
  startedAt: number,
  code: string | null,
  reason: string,
): BackendWriteSmoke {
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
    candidateId: null,
    candidateCommit: null,
    mergedInline: false,
    integrationOutcome: null,
    resultingCommit: null,
    primaryUnchangedBeforeIntegration: null,
    primaryAdvanced: false,
    editPresentOnPrimary: false,
    containment: null,
  };
}

function startDaemon(cli: string, cwd: string, childEnv: NodeJS.ProcessEnv, signal: AbortSignal) {
  const child = Bun.spawn([process.execPath, cli, "daemon", "serve", "--cwd", cwd], {
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
  stateDir: string,
  runtimeDir: string,
  child: Child,
  signal: AbortSignal,
) {
  const canonical = realpathSync.native(cwd);
  const projectId = createHash("sha256").update(canonical, "utf8").digest("hex");
  const socket = join(runtimeDir, `${projectId.slice(0, 32)}.sock`);
  const token = join(stateDir, "projects", projectId, "daemon", "token");
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
  await runChecked(["git", "config", "user.name", "Headless Native Write Smoke"], { cwd, env: childEnv, timeoutMs: 10_000, signal });
  await runChecked(["git", "config", "user.email", "headless-write-smoke@example.invalid"], { cwd, env: childEnv, timeoutMs: 10_000, signal });
  // The default write gate runs `bun run check` and `bun run build` inside the
  // candidate worktree; the disposable project ships trivially passing scripts so
  // a valid tiny edit reaches finality instead of failing the gate. `.headless/`
  // is ignored so daemon/worktree bookkeeping never dirties primary.
  await Bun.write(join(cwd, ".gitignore"), ".headless/\n");
  await Bun.write(join(cwd, "README.md"), "# Headless native write smoke\n");
  await Bun.write(join(cwd, "package.json"), `${JSON.stringify({
    name: "headless-native-write-smoke-fixture",
    private: true,
    scripts: { check: "true", build: "true" },
  }, null, 2)}\n`);
  await runChecked(["git", "add", "--all"], { cwd, env: childEnv, timeoutMs: 10_000, signal });
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

function nativeWriteSmokeEnvironment(source: NodeJS.ProcessEnv, state: string, runtime: string) {
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

function isErrorEnvelope(value: Record<string, unknown>) {
  return value.ok === false && "error" in value && !("containment" in value);
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

function safeDiagnostic(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "[REDACTED_OPENAI_KEY]")
    .replace(/(?:Bearer\s+)[A-Za-z0-9._~+/-]{16,}/gi, "Bearer [REDACTED]")
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .slice(0, 2_048);
}
