/**
 * Live root-CLI + daemon-API native matrix.
 *
 * This opt-in harness drives the compiled Headless CLI against installed,
 * logged-in backends. It covers native exec, persistent sessions, a real
 * two-backend council, trust, budgets, release gates, root event reads, lead
 * binding, and isolated MCP config generation.
 *
 * It is NOT the full Gate-B lead-host acceptance proof. MCP stdio attach and
 * its deliberate/council/ledger calls plus observer-authenticated TUI evidence
 * remain a separate recorded acceptance run.
 *
 * Delegation (run.delegate) is worker-emitted and is covered by the Phase 7
 * acceptance suite rather than driven here.
 *
 *   HEADLESS_LIVE_MATRIX=1 bun scripts/live-agent-matrix.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HeadlessDaemonClient } from "../src/daemon/client";
import { getProjectStatePaths } from "../src/runtime/project-state";

const OPT_IN = "HEADLESS_LIVE_MATRIX";
const MAX_CHILD_OUTPUT_BYTES = 1_000_000;
const DAEMON_START_TIMEOUT_MS = 15_000;
const DAEMON_STOP_TIMEOUT_MS = 10_000;
const COUNCIL_WALL_TIMEOUT_MS = 780_000;

type Child = ReturnType<typeof Bun.spawn>;
type Backend = { backend: string; binary: string };
const BACKENDS: Backend[] = [
  { backend: "opencode", binary: "opencode" },
  { backend: "codex", binary: "codex" },
  { backend: "claude-code", binary: "claude" },
  { backend: "grok-build", binary: "grok" },
];

export type MatrixCheckStatus = "passed" | "failed" | "skipped";
export type MatrixCheck = {
  name: string;
  layer: string;
  status: MatrixCheckStatus;
  detail: string;
  durationMs: number;
};

type CheckOutcome = { ok: boolean; skip?: boolean; detail: string };
type CommandResult = {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  overflowed: boolean;
};

const REQUIRED_CHECKS = ["exec:opencode", "exec:codex", "session.multi-turn", "council.run"] as const;
const GROK_ATTESTATION_LIMITATION = "Grok inspect did not prove project trust is disabled.";

class MatrixHalt extends Error {}

export function documentedBackendSkip(backend: string, result: Record<string, unknown> | null) {
  const error = objectValue(result?.error);
  const code = stringValue(error?.code);
  const message = stringValue(error?.message);
  if (code === "RATE_LIMITED") return "provider returned structured RATE_LIMITED";
  if (backend === "claude-code" && code === "NATIVE_AUTH_UNAVAILABLE") return "documented macOS Claude keychain-only limitation";
  if (backend === "grok-build" && code === "BACKEND_UNSUPPORTED" && message?.includes(GROK_ATTESTATION_LIMITATION)) {
    return "documented Grok project-trust attestation gate";
  }
  return null;
}

export function validateSessionTurnEnvelope(
  value: Record<string, unknown> | null,
  expected: { sessionId: string; backend: string; nativeSessionId?: string },
) {
  if (!value) return "session turn did not return a structured envelope";
  const session = objectValue(value.session);
  const job = objectValue(value.job);
  const result = objectValue(value.result);
  const replay = objectValue(value.replay);
  const jobResult = objectValue(job?.result);
  const sessionResult = objectValue(session?.result);
  const jobId = stringValue(job?.id);
  const nativeSessionId = stringValue(session?.nativeSessionId);
  if (!session || !job || !result || !replay) return "session turn envelope is missing session, job, result, or replay evidence";
  if (session.id !== expected.sessionId || session.backend !== expected.backend) return "session turn is attributed to the wrong session or backend";
  if (session.state !== "completed" || session.replay !== false) return "native session turn did not reach the durable completed state";
  if (!nativeSessionId || (expected.nativeSessionId && nativeSessionId !== expected.nativeSessionId)) {
    return "native session identity is missing or changed across resume";
  }
  if (!jobId || job.sessionId !== expected.sessionId || job.state !== "succeeded") return "session job is not a succeeded job bound to the session";
  if (session.lastJobId !== jobId || result.jobId !== jobId || result.sessionId !== expected.sessionId) {
    return "session, job, and result identifiers are not durably linked";
  }
  if (result.status !== "succeeded" || jobResult?.status !== "succeeded" || sessionResult?.status !== "succeeded") {
    return "session turn lacks succeeded result evidence at every durable layer";
  }
  if (typeof result.output !== "string" || result.output.trim().length === 0) return "session turn returned no assistant output";
  if (typeof replay.bytes !== "number" || !Number.isSafeInteger(replay.bytes) || replay.bytes < 0 || typeof replay.truncated !== "boolean") {
    return "session turn replay evidence is malformed";
  }
  return null;
}

export function mcpHostForBackend(backend: string) {
  if (backend === "claude-code") return "claude";
  if (backend === "grok-build") return "grok";
  return backend;
}

export function validateCouncilRecord(
  value: Record<string, unknown> | null,
  participants: readonly string[],
  exitCode: number | null,
) {
  if (!value) return "council did not return a structured record";
  const council = objectValue(value.council);
  const decision = objectValue(value.decision);
  const phase = stringValue(council?.phase);
  const approved = decision?.approved;
  const reason = stringValue(decision?.reason);
  if (phase !== "decision") return `council stopped at phase ${phase ?? "unknown"}`;
  if (typeof approved !== "boolean" || !reason) return "council decision is missing boolean approval or a nonempty reason";
  if (reason.startsWith("Council execution failed:")) return reason;
  const recordedParticipants = stringArray(council?.participants);
  if (!sameMembers(recordedParticipants, participants)) return "council participants do not match the requested two-backend set";
  for (const field of ["proposalJobs", "executionJobs", "reviewJobs", "voteJobs"] as const) {
    const jobs = stringArray(value[field]);
    if (jobs.length !== participants.length) return `${field} has ${jobs.length}/${participants.length} durable phase jobs`;
  }
  const votes = Array.isArray(value.votes) ? value.votes.map(objectValue) : [];
  if (votes.length !== participants.length || votes.some((vote) => vote === null)) {
    return `votes has ${votes.filter(Boolean).length}/${participants.length} attributable records`;
  }
  const voteAgents = votes.flatMap((vote) => stringValue(vote?.agent) ?? []);
  if (!sameMembers(voteAgents, participants)) return "votes are not attributable to both requested participants";
  if (approved && exitCode !== 0) return `approved council exited ${String(exitCode)} instead of 0`;
  if (!approved && exitCode !== 1) return `rejected council exited ${String(exitCode)} instead of 1`;
  return null;
}

export function matrixCompleteness(checks: readonly MatrixCheck[]) {
  const missing = REQUIRED_CHECKS.filter((name) => checks.find((check) => check.name === name)?.status !== "passed");
  return { complete: missing.length === 0, missing };
}

async function main() {
  if (process.env[OPT_IN] !== "1") {
    console.error(`Live agent matrix is disabled. Set ${OPT_IN}=1 only on a trusted host with intentionally logged-in CLIs.`);
    process.exitCode = 2;
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "headless-live-matrix-"));
  const project = join(root, "project");
  const stateHome = join(root, "state");
  // Keep Unix-domain socket paths short on macOS and Linux.
  const runtimeHome = mkdtempSync(join("/tmp", "hlm-rt-"));
  const cli = resolve(import.meta.dir, "../dist/cli.js");
  const env = liveMatrixEnvironment(process.env, stateHome, runtimeHome);
  const controller = new AbortController();
  const checks: MatrixCheck[] = [];
  const available: string[] = [];
  let signalExitCode: number | null = null;
  let daemon: Child | null = null;
  let daemonOutput: Promise<{ stdout: string; stderr: string }> | null = null;
  let daemonStopped = true;
  let harnessError: string | null = null;
  let baseline: { head: string; status: string } | null = null;

  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    process.once(signal, () => {
      signalExitCode = code;
      controller.abort(signal);
    });
  }

  const run = async (argv: string[], timeoutMs = 90_000, commandEnv: NodeJS.ProcessEnv = env) => {
    const result = await runBounded([process.execPath, cli, ...argv], {
      cwd: project,
      env: commandEnv,
      timeoutMs,
      signal: controller.signal,
    });
    if ((result.timedOut || result.overflowed) && !controller.signal.aborted) {
      controller.abort(`${argv.slice(0, 3).join(" ")} ${result.timedOut ? "timed out" : "overflowed"}`);
    }
    return result;
  };

  const check = async (name: string, layer: string, fn: () => Promise<CheckOutcome>) => {
    if (controller.signal.aborted) throw new MatrixHalt(`matrix halted: ${String(controller.signal.reason)}`);
    const startedAt = Date.now();
    try {
      const outcome = await fn();
      checks.push({
        name,
        layer,
        status: outcome.skip ? "skipped" : outcome.ok ? "passed" : "failed",
        detail: outcome.detail,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      checks.push({
        name,
        layer,
        status: "failed",
        detail: `threw: ${safeDiagnostic(error)}`,
        durationMs: Date.now() - startedAt,
      });
    }
    const last = checks.at(-1)!;
    console.error(`[${last.status.toUpperCase().padEnd(7)}] ${layer}/${name} (${last.durationMs}ms) ${last.detail.slice(0, 160)}`);
    // A timed-out/overflowed command aborts the controller. Record that
    // command's honest outcome, then stop the matrix before any further spend.
    if (controller.signal.aborted) throw new MatrixHalt(`matrix halted: ${String(controller.signal.reason)}`);
    return last;
  };

  try {
    assertCompiledCli(cli);
    mkdirSync(project, { mode: 0o700, recursive: true });
    mkdirSync(stateHome, { mode: 0o700, recursive: true });
    await initializeFixture(project, env, controller.signal);
    baseline = await repositorySnapshot(project, env, controller.signal);
    if (!/^[a-f0-9]{40,64}$/.test(baseline.head) || baseline.status !== "") {
      throw new Error("fixture baseline commit was not created cleanly");
    }

    // Start the experimental-session daemon before any CLI client. Readiness
    // is proven through an owned token/socket and a direct, non-autostarting
    // ping, so this harness can never accidentally spawn a competing daemon.
    const started = startDaemon(cli, project, env, controller);
    daemon = started.child;
    daemonOutput = started.output;
    await waitForOwnedDaemon(project, env, daemon, controller.signal);

    const trustGrant = await run(["project", "trust", "grant", "--allow-native-direct-unrestricted", "--cwd", project], 30_000);
    const granted = parseCommandObject(trustGrant, "project trust grant");
    if (!trustIsFullyGranted(granted)) throw new Error("disposable project trust grant did not enable all three required booleans");

    // ---- L0: readiness (no backend execution) ----
    await check("doctor", "L0", async () => {
      const result = await run(["doctor", "--cwd", project], 30_000);
      return commandOutcome(result, result.exitCode === 0 && /backend/i.test(result.stdout), "daemon+backends reported");
    });
    await check("status", "L0", async () => {
      const result = await run(["status", "--cwd", project], 20_000);
      return commandOutcome(result, result.exitCode === 0, "daemon status ok");
    });
    await check("project.trust.status", "L0", async () => {
      const result = await run(["project", "trust", "status", "--cwd", project], 20_000);
      const trust = result.exitCode === 0 && !result.timedOut && !result.overflowed
        ? parseObject(result.stdout, "project trust status")
        : null;
      return commandOutcome(result, trustIsFullyGranted(trust), "trusted + native login + native direct unrestricted acknowledged");
    });

    // ---- L1a: per-backend native exec probe ----
    for (const definition of BACKENDS) {
      if (!Bun.which(definition.binary)) {
        const skipped = {
          name: `exec:${definition.backend}`,
          layer: "L1",
          status: "skipped" as const,
          detail: `${definition.binary} not installed; skips do not satisfy completeness`,
          durationMs: 0,
        };
        checks.push(skipped);
        console.error(`[SKIPPED] L1/${skipped.name} ${skipped.detail}`);
        continue;
      }
      await check(`exec:${definition.backend}`, "L1", async () => {
        const result = await run([
          "exec",
          "--backend", definition.backend,
          "--mode", "read-only",
          "--auth-mode", "native-login",
          "--json",
          "--cwd", project,
          "--",
          "Reply with the single word OK. Do not use tools.",
        ], 240_000);
        const document = parseObjectOrNull(result.stdout);
        const status = stringValue(document?.status);
        const ok = result.exitCode === 0 && !result.timedOut && !result.overflowed && status === "succeeded";
        if (ok) available.push(definition.backend);
        const skipped = ok ? null : documentedBackendSkip(definition.backend, document);
        const error = objectValue(document?.error);
        return {
          ok,
          skip: skipped !== null,
          detail: ok
            ? `succeeded (${stringValue(objectValue(document?.containment)?.network) ?? "unknown network"})`
            : skipped ?? `${status ?? "no run result"}: ${stringValue(error?.code) ?? "UNKNOWN"}: ${safeDiagnostic(stringValue(error?.message) ?? result.stderr)}`,
        };
      });
    }

    const executor = ["opencode", "codex"].find((backend) => available.includes(backend)) ?? available[0];
    console.error(`\n== executor=${executor ?? "none"}; available=[${available.join(", ") || "none"}] ==\n`);

    // ---- L1b: persistent session lifecycle ----
    await check("session.multi-turn", "L1", async () => {
      if (!executor) return { ok: false, skip: true, detail: "no live backend; completeness remains unsatisfied" };
      const created = await run([
        "experimental", "session", "create",
        "--cwd", project,
        "--backend", executor,
        "--auth-mode", "native-login",
        "--approval-policy", "ask",
        "--require-sandbox",
      ], 60_000);
      if (!commandSucceeded(created)) return { ok: false, detail: commandFailure("session.create", created) };
      const session = parseObject(created.stdout, "session.create");
      const sessionId = stringValue(session.id);
      if (!sessionId || session.backend !== executor || session.state !== "idle") {
        return { ok: false, detail: "session.create returned an invalid id/backend/state" };
      }

      const first = await run([
        "experimental", "session", "send",
        "--cwd", project,
        "--session-id", sessionId,
        "--timeout-ms", "60000",
        "--",
        "Reply with the word ONE.",
      ], 90_000);
      const firstEnvelope = parseObjectOrNull(first.stdout);
      const firstResult = objectValue(firstEnvelope?.result);
      const firstSession = objectValue(firstEnvelope?.session);
      const firstSkip = documentedBackendSkip(executor, firstResult);
      const firstInvalid = validateSessionTurnEnvelope(firstEnvelope, { sessionId, backend: executor });
      if (!commandSucceeded(first) || firstInvalid) {
        return {
          ok: false,
          skip: firstSkip !== null,
          detail: firstSkip ?? firstInvalid ?? commandFailure("session.send", first, firstResult),
        };
      }
      const nativeSessionId = stringValue(firstSession?.nativeSessionId)!;

      // Exercise the distinct resume action, not a second send alias.
      const resumed = await run([
        "experimental", "session", "resume",
        "--cwd", project,
        "--session-id", sessionId,
        "--timeout-ms", "60000",
        "--",
        "Reply with the word TWO.",
      ], 90_000);
      const resumedEnvelope = parseObjectOrNull(resumed.stdout);
      const resumedResult = objectValue(resumedEnvelope?.result);
      const resumeSkip = documentedBackendSkip(executor, resumedResult);
      const resumeInvalid = validateSessionTurnEnvelope(resumedEnvelope, { sessionId, backend: executor, nativeSessionId });
      const ok = commandSucceeded(resumed) && resumeInvalid === null;
      return {
        ok,
        skip: !ok && resumeSkip !== null,
        detail: ok ? `send+resume succeeded for ${executor}` : resumeSkip ?? resumeInvalid ?? commandFailure("session.resume", resumed, resumedResult),
      };
    });

    // ---- L2: orchestration ----
    await check("council.run", "L2", async () => {
      const participants = ["opencode", "codex"];
      if (!participants.every((backend) => available.includes(backend))) {
        return { ok: false, skip: true, detail: "requires live opencode+codex; skips do not satisfy completeness" };
      }
      const result = await run([
        "experimental", "council",
        "--agent", participants[0]!,
        "--agent", participants[1]!,
        "--cwd", project,
        "--auth-mode", "native-login",
        "--timeout-ms", "600000",
        "--",
        "Should this repo add a CONTRIBUTING file? Answer yes or no in one sentence.",
      ], COUNCIL_WALL_TIMEOUT_MS);
      if (result.timedOut) {
        return { ok: false, skip: true, detail: `still running at ${COUNCIL_WALL_TIMEOUT_MS / 1000}s; matrix halts without claiming finality` };
      }
      if (result.overflowed) return { ok: false, detail: "council output exceeded the harness bound" };
      const record = parseObjectOrNull(result.stdout);
      const invalid = validateCouncilRecord(record, participants, result.exitCode);
      const approved = objectValue(record?.decision)?.approved;
      return {
        ok: invalid === null,
        detail: invalid ?? `real decision finality reached (approved=${String(approved)}) with 2 jobs in every phase and 2 attributable votes`,
      };
    });
    await check("fleet.profile.list", "L2", async () => {
      const result = await run(["experimental", "fleet", "profile", "list", "--cwd", project], 20_000);
      const document = commandSucceeded(result) ? parseObjectOrNull(result.stdout) : null;
      return commandOutcome(result, Array.isArray(document?.profiles), "fleet profile list returned structured state");
    });
    await check("goal.list", "L2", async () => {
      const result = await run(["experimental", "goal", "list", "--cwd", project], 20_000);
      const document = commandSucceeded(result) ? parseJsonOrNull(result.stdout) : null;
      return commandOutcome(result, Array.isArray(document), "goal list returned a structured array");
    });

    // ---- L3: durable evidence + non-execution tools ----
    await check("gate.run", "L3", async () => {
      const result = await run(["experimental", "gate", "--cwd", project, "--timeout-ms", "60000"], 150_000);
      const report = parsePrefixedObject(result.stdout, "Running daemon-owned release gate checks...", "gate.run");
      const gateChecks = Array.isArray(report?.checks) ? report.checks.map(objectValue) : [];
      const ok = commandSucceeded(result)
        && report?.ok === true
        && gateChecks.length === 2
        && gateChecks.every((entry) => entry?.ok === true && entry.timedOut === false && entry.cancelled === false);
      return { ok, detail: ok ? "deterministic fixture check+build gates both passed" : commandFailure("gate.run", result) };
    });
    await check("budget.upsert+list", "L3", async () => {
      const upsert = await run([
        "experimental", "budget", "upsert",
        "--id", "matrix-budget",
        "--provider", "openai",
        "--max-requests", "8",
        "--cwd", project,
      ], 20_000);
      const list = await run(["experimental", "budget", "list", "--cwd", project], 20_000);
      const upserted = commandSucceeded(upsert) ? parseObjectOrNull(upsert.stdout) : null;
      const listed = commandSucceeded(list) ? parseJsonOrNull(list.stdout) : null;
      const budgets = Array.isArray(listed) ? listed.map(objectValue) : [];
      const ok = upserted?.id === "matrix-budget"
        && upserted?.maxRequests === 8
        && budgets.some((budget) => budget?.id === "matrix-budget" && budget.maxRequests === 8);
      return { ok, detail: ok ? "budget upsert+list returned the durable budget" : commandFailure("budget upsert/list", upsert.exitCode === 0 ? list : upsert) };
    });
    await check("events.snapshot (root)", "L3", async () => {
      const result = await run(["experimental", "events", "--cwd", project], 20_000);
      const lines = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
      const ok = commandSucceeded(result) && lines.length > 0 && lines.every((line) => parseObjectOrNull(line) !== null);
      return commandOutcome(result, ok, `root event snapshot returned ${lines.length} structured events`);
    });

    // ---- L4: lead binding + isolated MCP config generation ----
    await check("lead.use+status", "L4", async () => {
      if (!executor) return { ok: false, skip: true, detail: "no live backend; completeness already unsatisfied" };
      const host = mcpHostForBackend(executor);
      const use = await run(["lead", "use", host, "--cwd", project], 20_000);
      const status = await run(["lead", "status", "--cwd", project], 20_000);
      const used = commandSucceeded(use) ? objectValue(parseObjectOrNull(use.stdout)?.binding) : null;
      const current = commandSucceeded(status) ? parseObjectOrNull(status.stdout) : null;
      const valid = (binding: Record<string, unknown> | null) => binding?.host === host
        && binding.backendId === executor
        && typeof binding.generation === "number"
        && Number.isSafeInteger(binding.generation)
        && Number(binding.generation) > 0
        && binding.status === "configured";
      const ok = valid(used) && valid(current) && used?.generation === current?.generation;
      return { ok, detail: ok ? `lead host=${host} backend=${executor} generation=${String(current?.generation)} configured` : commandFailure("lead use/status", use.exitCode === 0 ? status : use) };
    });
    await check("mcp.install:opencode (isolated)", "L4", async () => {
      const home = join(root, "mcp-home");
      const configHome = join(home, ".config");
      mkdirSync(home, { recursive: true, mode: 0o700 });
      const isolatedEnv: NodeJS.ProcessEnv = {
        ...env,
        HOME: home,
        XDG_CONFIG_HOME: configHome,
        XDG_STATE_HOME: join(home, ".local", "state"),
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        CODEX_HOME: join(home, ".codex"),
      };
      const result = await run(["mcp", "install", "opencode", "--cwd", project], 20_000, isolatedEnv);
      const configPath = join(configHome, "opencode", "opencode.json");
      const config = commandSucceeded(result) && existsSync(configPath)
        ? parseObjectOrNull(readFileSync(configPath, "utf8"))
        : null;
      const server = objectValue(objectValue(config?.mcp)?.headless);
      const command = Array.isArray(server?.command) ? server.command : [];
      const installed = result.stdout.includes("Installed the published Headless MCP server in OpenCode's global config:");
      const ok = installed
        && server?.type === "local"
        && JSON.stringify(command) === JSON.stringify(["headless-mcp", "--host", "opencode"])
        && result.exitCode === 0
        && !result.timedOut
        && !result.overflowed;
      return { ok, detail: ok ? `verified isolated config at ${configPath}` : "installer did not produce the exact success message and concrete isolated OpenCode entry" };
    });

    await check("fixture.repository-unchanged", "L4", async () => {
      const after = await repositorySnapshot(project, env, controller.signal);
      const ok = baseline !== null && after.head === baseline.head && after.status === baseline.status && after.status === "";
      return { ok, detail: ok ? `fixture remained at baseline ${after.head.slice(0, 12)}` : "matrix changed the disposable project worktree or HEAD" };
    });
  } catch (error) {
    harnessError = safeDiagnostic(error);
    if (!(error instanceof MatrixHalt)) {
      checks.push({ name: "harness", layer: "control", status: "failed", detail: harnessError, durationMs: 0 });
      console.error(`live matrix failed: ${harnessError}`);
    } else {
      console.error(harnessError);
    }
  } finally {
    if (daemon) {
      daemonStopped = await stopProcessGroup(daemon, DAEMON_STOP_TIMEOUT_MS);
      if (!daemonStopped) {
        checks.push({
          name: "daemon.cleanup",
          layer: "control",
          status: "failed",
          detail: "owned daemon did not exit after process-group TERM→KILL; disposable roots were preserved",
          durationMs: 0,
        });
      }
    }
    if (daemonOutput && daemonStopped) {
      const output = await daemonOutput.catch(() => ({ stdout: "", stderr: "" }));
      if (daemon?.exitCode !== 0 && daemon?.exitCode !== null && checks.some((entry) => entry.status === "failed")) {
        const diagnostic = safeDiagnostic(output.stderr || output.stdout);
        if (diagnostic) console.error(`Daemon diagnostic: ${diagnostic}`);
      }
    }

    // Never delete the token/socket/state beneath a daemon we did not prove
    // exited. The preserved paths are reported for manual recovery.
    if (daemonStopped) {
      rmSync(root, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    } else {
      console.error(`Preserved disposable matrix roots: ${root} ${runtimeHome}`);
    }

    const passed = checks.filter((entry) => entry.status === "passed").length;
    const skipped = checks.filter((entry) => entry.status === "skipped").length;
    const failed = checks.filter((entry) => entry.status === "failed").length;
    const completeness = matrixCompleteness(checks);
    const incomplete = completeness.missing.length;
    const status = failed > 0 ? "failed" : incomplete > 0 ? "incomplete" : "passed";
    console.log(JSON.stringify({
      version: 2,
      scope: "root-CLI + daemon-API native matrix (not full Gate-B MCP/TUI evidence)",
      status,
      executor: ["opencode", "codex"].find((backend) => available.includes(backend)) ?? available[0] ?? null,
      available,
      passed,
      skipped,
      failed,
      incomplete,
      missingRequiredChecks: completeness.missing,
      daemonStopped,
      interrupted: signalExitCode !== null,
      harnessError,
      checks,
    }, null, 2));
    process.exitCode = signalExitCode ?? (status === "passed" ? 0 : 1);
  }
}

function startDaemon(cli: string, cwd: string, env: NodeJS.ProcessEnv, controller: AbortController) {
  const child = Bun.spawn([process.execPath, cli, "daemon", "serve", "--cwd", cwd, "--experimental-sessions"], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const budget = { remaining: 256_000, overflowed: false };
  let stopping: Promise<boolean> | null = null;
  const stop = () => {
    stopping ??= stopProcessGroup(child, 1_000);
    if (!controller.signal.aborted) controller.abort("daemon output exceeded its bound");
  };
  const stdout = readBounded(child.stdout, budget, stop);
  const stderr = readBounded(child.stderr, budget, stop);
  const abort = () => { void stopProcessGroup(child, DAEMON_STOP_TIMEOUT_MS); };
  controller.signal.addEventListener("abort", abort, { once: true });
  return {
    child,
    output: Promise.all([stdout, stderr]).then(([out, err]) => {
      controller.signal.removeEventListener("abort", abort);
      return { stdout: out, stderr: err };
    }),
  };
}

async function waitForOwnedDaemon(
  project: string,
  env: NodeJS.ProcessEnv,
  child: Child,
  signal: AbortSignal,
) {
  const state = getProjectStatePaths(project, { env });
  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new MatrixHalt(`daemon startup interrupted: ${String(signal.reason)}`);
    if (child.exitCode !== null) throw new Error(`owned daemon exited during startup with code ${child.exitCode}`);
    if (existsSync(state.socketPath) && existsSync(state.tokenPath)) {
      try {
        const client = new HeadlessDaemonClient({ projectRoot: project, state: { env }, timeoutMs: 750 });
        const ping = await client.call<Record<string, unknown>>("ping", {}, 750);
        if (ping.projectRoot === state.canonicalProjectRoot && ping.experimentalSessionsEnabled === true) return;
      } catch {
        // The files may exist just before the socket begins accepting requests.
      }
    }
    await Bun.sleep(25);
  }
  throw new Error("owned compiled daemon did not become directly reachable within 15 seconds");
}

async function initializeFixture(cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal) {
  await Bun.write(join(cwd, "README.md"), "# Headless live matrix fixture\n");
  await Bun.write(join(cwd, "package.json"), `${JSON.stringify({
    name: "headless-live-matrix-fixture",
    private: true,
    scripts: {
      check: "bun -e \"console.log('matrix-check-ok')\"",
      build: "bun -e \"console.log('matrix-build-ok')\"",
    },
  }, null, 2)}\n`);
  const gitEnv = {
    ...env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "Headless Live Matrix",
    GIT_AUTHOR_EMAIL: "headless-matrix@example.invalid",
    GIT_COMMITTER_NAME: "Headless Live Matrix",
    GIT_COMMITTER_EMAIL: "headless-matrix@example.invalid",
  };
  await runChecked(["git", "init", "--quiet"], { cwd, env: gitEnv, timeoutMs: 10_000, signal });
  await runChecked(["git", "add", "README.md", "package.json"], { cwd, env: gitEnv, timeoutMs: 10_000, signal });
  await runChecked(["git", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "matrix fixture"], { cwd, env: gitEnv, timeoutMs: 10_000, signal });
}

async function repositorySnapshot(cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal) {
  const [head, status] = await Promise.all([
    runChecked(["git", "rev-parse", "HEAD"], { cwd, env, timeoutMs: 10_000, signal }),
    runChecked(["git", "status", "--porcelain=v1", "--untracked-files=all"], { cwd, env, timeoutMs: 10_000, signal }),
  ]);
  return { head: head.stdout.trim(), status: status.stdout.trim() };
}

async function runChecked(
  argv: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal: AbortSignal },
) {
  const result = await runBounded(argv, options);
  if (!commandSucceeded(result)) {
    throw new Error(`${argv[0]} failed: ${commandFailure(argv.join(" "), result)}`);
  }
  return result;
}

async function runBounded(
  argv: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal: AbortSignal },
): Promise<CommandResult> {
  if (options.signal.aborted) throw new MatrixHalt(`command launch blocked after abort: ${String(options.signal.reason)}`);
  const child = Bun.spawn(argv, {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  let timedOut = false;
  let stopping: Promise<boolean> | null = null;
  const stop = () => stopping ??= stopProcessGroup(child, 1_000);
  const budget = { remaining: MAX_CHILD_OUTPUT_BYTES, overflowed: false };
  const timeout = setTimeout(() => {
    timedOut = true;
    void stop();
  }, options.timeoutMs);
  timeout.unref?.();
  const abort = () => { void stop(); };
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBounded(child.stdout, budget, () => { void stop(); }),
      readBounded(child.stderr, budget, () => { void stop(); }),
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

async function stopProcessGroup(child: Child, timeoutMs: number) {
  if (child.exitCode !== null) return true;
  signalProcessGroup(child, "SIGTERM");
  if (await exitsWithin(child, timeoutMs)) return true;
  signalProcessGroup(child, "SIGKILL");
  return exitsWithin(child, 2_000);
}

function signalProcessGroup(child: Child, signal: "SIGTERM" | "SIGKILL") {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch (error) {
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

function liveMatrixEnvironment(source: NodeJS.ProcessEnv, stateHome: string, runtimeHome: string) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (isProviderCredentialEnvironmentKey(key)) delete env[key];
  }
  env.HEADLESS_STATE_HOME = stateHome;
  env.HEADLESS_RUNTIME_HOME = runtimeHome;
  delete env.HEADLESS_EXTENSION_CONFIG;
  return env;
}

function isProviderCredentialEnvironmentKey(key: string) {
  return /(?:^|_)API_KEY$/i.test(key)
    || /^(?:ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|CODEX_API_KEY|GROK_API_KEY|OPENAI_ACCESS_TOKEN|GOOGLE_APPLICATION_CREDENTIALS|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AZURE_OPENAI_KEY)$/i.test(key);
}

function commandSucceeded(result: CommandResult) {
  return result.exitCode === 0 && !result.timedOut && !result.overflowed;
}

function commandOutcome(result: CommandResult, ok: boolean, success: string): CheckOutcome {
  return { ok, detail: ok ? success : commandFailure("command", result) };
}

function commandFailure(label: string, result: CommandResult, structuredResult?: Record<string, unknown> | null) {
  const error = objectValue(structuredResult?.error);
  const detail = stringValue(error?.message) ?? stringValue(error?.code) ?? (result.stderr || result.stdout);
  return `${label} ${result.timedOut ? "timed out" : result.overflowed ? "overflowed" : `exited ${String(result.exitCode)}`}: ${safeDiagnostic(detail)}`;
}

function parseCommandObject(result: CommandResult, label: string) {
  if (!commandSucceeded(result)) throw new Error(commandFailure(label, result));
  return parseObject(result.stdout, label);
}

function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseObjectOrNull(text: string) {
  return objectValue(parseJsonOrNull(text));
}

function parseObject(text: string, label: string) {
  const parsed = parseObjectOrNull(text);
  if (!parsed) throw new Error(`${label} did not return exactly one structured JSON object`);
  return parsed;
}

function parsePrefixedObject(text: string, prefix: string, label: string) {
  const trimmed = text.trim();
  if (!trimmed.startsWith(prefix)) return null;
  const json = trimmed.slice(prefix.length).trim();
  return parseObjectOrNull(json) ?? (() => { throw new Error(`${label} did not return its structured report after the expected prefix`); })();
}

function objectValue(value: unknown) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stringArray(value: unknown) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value as string[] : [];
}

function sameMembers(left: readonly string[], right: readonly string[]) {
  const sortedRight = [...right].sort();
  return left.length === right.length && [...left].sort().every((entry, index) => entry === sortedRight[index]);
}

function trustIsFullyGranted(value: Record<string, unknown> | null) {
  return value?.trusted === true
    && value.nativeLoginAllowed === true
    && value.nativeDirectUnrestrictedAcknowledged === true;
}

function assertCompiledCli(path: string) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`Compiled CLI is unavailable at ${path}. Run bun run build before the opt-in matrix.`);
  }
}

function safeDiagnostic(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "[REDACTED_OPENAI_KEY]")
    .replace(/(?:Bearer\s+)[A-Za-z0-9._~+/-]{16,}/gi, "Bearer [REDACTED]")
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .slice(0, 2_048);
}

if (import.meta.main) await main();
