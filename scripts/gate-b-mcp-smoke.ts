import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { RunEvent, RunResult } from "../src/contracts/run";
import type { Job } from "../src/contracts/durable";
import { connectExistingDaemon } from "../src/daemon/connect";
import { atomicWriteFile } from "../src/runtime/atomic-write";

const OPT_IN_ENV = "HEADLESS_GATE_B_SMOKE";
const LEAD_HOST = "codex";
const RUN_TIMEOUT_MS = 120_000;
const COUNCIL_TIMEOUT_MS = 180_000;
const MCP_REQUEST_TIMEOUT_MS = 900_000;
const DAEMON_START_TIMEOUT_MS = 10_000;
const DAEMON_STOP_TIMEOUT_MS = 15_000;
const MAX_CHILD_OUTPUT_BYTES = 1_000_000;
const MAX_RECORDED_VOTE_OUTPUT_BYTES = 16_384;
const EVIDENCE_PATH = resolve(import.meta.dir, "../docs/internal/release-evidence/gate-b-mcp-smoke.json");
const DELIBERATION_BACKENDS = ["claude-code", "opencode", "grok-build"] as const;

type Child = ReturnType<typeof Bun.spawn>;
type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  overflowed: boolean;
};

type DeliberationJob = {
  jobId: string;
  backend: string;
  result: RunResult;
};

type CouncilRecord = {
  council: { id: string; phase: string; participants: string[]; principal: string };
  proposalJobs: string[];
  executionJobs: string[];
  reviewJobs: string[];
  voteJobs: string[];
  votes: Array<{ agent: string; jobId: string; references: string[] }>;
  decision: { approved: boolean; reason: string } | null;
};

type VoteJobEvidence = {
  participant: string;
  jobId: string;
  terminalStatus: "succeeded";
  parsed: boolean;
  output: string;
  outputBytes: number;
  outputSha256: string;
  outputTruncated: boolean;
};

type ObserverEvents = {
  events: RunEvent[];
  nextCursor: number;
  cursorExpired: boolean;
};

type RawLedgerContext = {
  entries: Array<{
    type?: string;
    artifact?: { title?: string; evidence?: string[] };
  }>;
};

type GateBEvidence = {
  version: 1;
  releaseGatePassed: boolean;
  compiledArtifactsOnly: true;
  actualMcpStdio: true;
  lead: { host: string; attached: true };
  deliberation: {
    attempts: number;
    successfulBackends: string[];
    jobs: Array<{ jobId: string; backend: string; status: string; errorCode: string | null }>;
  };
  council: {
    councilId: string;
    principal: string;
    participants: string[];
    approved: boolean;
    reason: string;
    validVotes: number;
    phaseJobCounts: { proposal: number; execution: number; review: number; vote: number };
    votes: Array<{ agent: string; jobId: string; references: string[] }>;
    voteJobs: VoteJobEvidence[];
  };
  persistence: {
    daemonRestartedBeforeVerification: boolean;
    ledgerArtifactFound: boolean;
    councilRecordMatched: boolean;
    ledgerJobIdsMatched: number;
    observerEventsMatched: number;
    observerTerminalCompletionsMatched: number;
  };
};

if (import.meta.main) {
  if (process.env[OPT_IN_ENV] !== "1") {
    console.error(`Gate B MCP smoke is disabled. Set ${OPT_IN_ENV}=1 only on a trusted host with intentionally logged-in CLIs.`);
    process.exit(2);
  }
  await main();
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "headless-gate-b-mcp-smoke-"));
  const project = join(root, "project");
  const stateHome = join(root, "state");
  const runtimeHome = mkdtempSync(join("/tmp", "hgb-runtime-"));
  const cliPath = resolve(import.meta.dir, "../dist/cli.js");
  const mcpPath = resolve(import.meta.dir, "../dist/mcp/server.js");
  const env = smokeEnvironment(process.env, stateHome, runtimeHome, project);
  const controller = new AbortController();
  let signalExitCode: number | null = null;
  let daemon: ReturnType<typeof startDaemon> | null = null;
  let mcpClient: Client | null = null;

  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    process.once(signal, () => {
      signalExitCode = code;
      controller.abort(signal);
    });
  }

  try {
    assertCompiledArtifact(cliPath, "CLI");
    assertCompiledArtifact(mcpPath, "MCP server");
    mkdirSync(project, { mode: 0o700 });
    mkdirSync(stateHome, { mode: 0o700 });
    await initializeFixture(project, env, controller.signal);

    daemon = startDaemon(cliPath, project, env, controller.signal);
    await waitForDaemon(project, stateHome, runtimeHome, daemon.child, controller.signal);
    await runCheckedCli(cliPath, ["project", "trust", "grant", "--allow-native-direct-unrestricted", "--cwd", project], env, controller.signal);
    const leadUse = parseJsonObject(
      (await runCheckedCli(cliPath, ["lead", "use", LEAD_HOST, "--cwd", project], env, controller.signal)).stdout,
      "lead use",
    );
    const leadBinding = objectValue(leadUse.binding);
    const leadPrincipal = stringValue(leadBinding?.integrationPrincipal);
    if (!leadPrincipal) throw new Error("Lead binding did not return an integration principal.");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [mcpPath, "--host", LEAD_HOST],
      cwd: project,
      env: definedEnvironment(env),
      stderr: "inherit",
    });
    mcpClient = new Client({ name: "headless-gate-b-smoke", version: "1.0.0" });
    await mcpClient.connect(transport, { timeout: 15_000 });
    const advertised = await mcpClient.listTools({}, { timeout: 15_000 });
    for (const expected of ["headless_deliberate", "council_deliberate", "headless_record_artifact", "headless_read_context"]) {
      if (!advertised.tools.some((tool) => tool.name === expected)) throw new Error(`Compiled MCP server did not advertise ${expected}.`);
    }

    const deliberation = await runDeliberation(mcpClient, controller.signal);
    const successfulBackends = successfulDeliberationBackends(deliberation.jobs);
    if (successfulBackends.length < 2) {
      throw new Error(`Gate B requires two successful native-login servants; only ${successfulBackends.join(", ") || "none"} completed.`);
    }

    const rootClient = await connectExistingDaemon({ projectRoot: project, state: { env } });
    if (!rootClient) throw new Error("Owned daemon disappeared before the council run.");
    const councilAttempts: CouncilRecord[] = [];
    let council: CouncilRecord | null = null;
    for (let attempt = 0; attempt < 2 && !council; attempt += 1) {
      const participants = rotatePair(successfulBackends, attempt);
      const candidate = validateCouncilRecord(await callToolJson(mcpClient, "council_deliberate", {
        question: "Gate B decision: approve only if a real MCP lead can fan out contained native-login work and the resulting council jobs remain visible in both the durable ledger trace and observer event projection. Keep every phase concise.",
        agents: participants.join(","),
        mode: "read-only",
        authMode: "native-login",
        approvalPolicy: "auto",
        timeoutMs: COUNCIL_TIMEOUT_MS,
      }, MCP_REQUEST_TIMEOUT_MS), participants, leadPrincipal, false);
      councilAttempts.push(candidate);
      council = candidate;
      break;
    }
    if (!council) throw new Error("Council did not reach an attributable decision.");
    const voteJobEvidence = await collectVoteJobEvidence(rootClient, council);

    const allJobIds = unique([
      ...deliberation.jobs.map((job) => job.jobId),
      ...councilAttempts.flatMap(councilJobIds),
    ]);
    const sessionId = `gate-b-mcp-${randomUUID()}`;
    const title = `Gate B MCP trace ${council.council.id}`;
    const evidence: GateBEvidence = {
      version: 1,
      releaseGatePassed: false,
      compiledArtifactsOnly: true,
      actualMcpStdio: true,
      lead: { host: LEAD_HOST, attached: true },
      deliberation: {
        attempts: deliberation.attempts,
        successfulBackends,
        jobs: deliberation.jobs.map((job) => ({
          jobId: job.jobId,
          backend: job.backend,
          status: job.result.status,
          errorCode: job.result.error?.code ?? null,
        })),
      },
      council: {
        councilId: council.council.id,
        principal: council.council.principal,
        participants: council.council.participants,
        approved: council.decision!.approved,
        reason: council.decision!.reason,
        validVotes: council.votes.length,
        phaseJobCounts: {
          proposal: council.proposalJobs.length,
          execution: council.executionJobs.length,
          review: council.reviewJobs.length,
          vote: council.voteJobs.length,
        },
        votes: council.votes.map(({ agent, jobId, references }) => ({ agent, jobId, references })),
        voteJobs: voteJobEvidence,
      },
      persistence: {
        daemonRestartedBeforeVerification: false,
        ledgerArtifactFound: false,
        councilRecordMatched: false,
        ledgerJobIdsMatched: 0,
        observerEventsMatched: 0,
        observerTerminalCompletionsMatched: 0,
      },
    };
    writeEvidence(evidence);
    const traceEvidence = [
      `lead=${LEAD_HOST}`,
      ...deliberation.jobs.map((job) => `deliberation:${job.jobId}:${job.backend}:${job.result.status}`),
      ...councilAttempts.flatMap((record) => [
        `council:${record.council.id}:principal:${record.council.principal}`,
        `council:${record.council.id}:decision:${String(record.decision?.approved)}:${record.decision?.reason ?? "missing"}`,
        ...record.proposalJobs.map((id) => `council:${record.council.id}:proposal:${id}`),
        ...record.executionJobs.map((id) => `council:${record.council.id}:execution:${id}`),
        ...record.reviewJobs.map((id) => `council:${record.council.id}:review:${id}`),
        ...record.voteJobs.map((id) => `council:${record.council.id}:vote:${id}`),
      ]),
      ...voteJobEvidence.map((vote) => `vote:${vote.participant}:${vote.jobId}:${vote.terminalStatus}:parsed=${String(vote.parsed)}:sha256=${vote.outputSha256}`),
    ];
    await callToolJson(mcpClient, "headless_record_artifact", {
      kind: "headless_result",
      title,
      summary: "A bound foreground lead used compiled MCP stdio to deliberate with multiple contained native-login servants and reach an attributable council decision.",
      status: "passed",
      evidence: traceEvidence,
      sessionId,
    }, 30_000);
    validateLedgerContext(
      await callToolJson(mcpClient, "headless_read_context", { view: "raw", limit: 100, sessionId }, 30_000),
      title,
      allJobIds,
    );

    await mcpClient.close();
    mcpClient = null;
    await stopOwnedDaemonGracefully(cliPath, project, env, controller.signal, daemon);
    daemon = null;

    daemon = startDaemon(cliPath, project, env, controller.signal);
    await waitForDaemon(project, stateHome, runtimeHome, daemon.child, controller.signal);
    const restartedRoot = await connectExistingDaemon({ projectRoot: project, state: { env } });
    if (!restartedRoot) throw new Error("Owned daemon did not reconnect after restart.");
    const ledger = await restartedRoot.call<RawLedgerContext>("ledger.context", { view: "raw", limit: 100, sessionId });
    validateLedgerContext(ledger, title, allJobIds);
    const restartedCouncil = validateCouncilRecord(
      await restartedRoot.call("council.status", { councilId: council.council.id }),
      council.council.participants,
      leadPrincipal,
      false,
    );
    if (councilRecordDigest(restartedCouncil) !== councilRecordDigest(council)) {
      throw new Error("Council record changed across the authenticated daemon restart.");
    }
    const restartedVotes = await collectVoteJobEvidence(restartedRoot, restartedCouncil);
    if (JSON.stringify(restartedVotes) !== JSON.stringify(voteJobEvidence)) {
      throw new Error("Durable vote-job evidence changed across the authenticated daemon restart.");
    }
    await restartedRoot.call("auth.provisionObserver");
    const observer = await connectExistingDaemon({ projectRoot: project, state: { env }, credential: { observer: true } });
    if (!observer) throw new Error("Provisioned observer credential could not reconnect after restart.");
    const observerEvents = await observer.call<ObserverEvents>("observer.events", { limit: 1_000 });
    const projection = validateObserverProjection(observerEvents, allJobIds);

    evidence.releaseGatePassed = true;
    evidence.persistence = {
      daemonRestartedBeforeVerification: true,
      ledgerArtifactFound: true,
      councilRecordMatched: true,
      ledgerJobIdsMatched: allJobIds.length,
      observerEventsMatched: projection.matchedJobs,
      observerTerminalCompletionsMatched: projection.terminalJobs,
    };
    writeEvidence(evidence);
    console.log(JSON.stringify(evidence, null, 2));
  } catch (error) {
    console.error(`Gate B MCP smoke failed: ${safeDiagnostic(error)}`);
    process.exitCode = signalExitCode ?? 1;
  } finally {
    if (mcpClient) await mcpClient.close().catch(() => {});
    if (daemon) await cleanupOwnedDaemon(daemon, DAEMON_STOP_TIMEOUT_MS);
    rmSync(root, { recursive: true, force: true });
    rmSync(runtimeHome, { recursive: true, force: true });
    if (signalExitCode !== null) process.exitCode = signalExitCode;
  }
}

async function runDeliberation(client: Client, signal: AbortSignal) {
  const jobs: DeliberationJob[] = [];
  let pending = [...DELIBERATION_BACKENDS];
  let attempts = 0;
  while (attempts < 3 && successfulDeliberationBackends(jobs).length < 2) {
    attempts += 1;
    const response = validateDeliberationResponse(await callToolJson(client, "headless_deliberate", {
      question: "Gate B smoke: in at most two sentences, state one reason orchestration evidence should be durable and observer-visible. Do not use tools.",
      backends: pending.join(","),
      authMode: "native-login",
      approvalPolicy: "auto",
      timeoutMs: RUN_TIMEOUT_MS,
    }, RUN_TIMEOUT_MS + 90_000));
    jobs.push(...response);
    if (successfulDeliberationBackends(jobs).length >= 2) break;
    const retryable = response.filter((job) => job.result.error?.code === "RATE_LIMITED");
    if (retryable.length === 0) break;
    pending = unique(retryable.map((job) => job.backend));
    const delay = Math.max(...retryable.map((job) => retryAfterMs(job.result)), 15_000);
    await abortableDelay(Math.min(delay, 60_000), signal);
  }
  return { jobs, attempts };
}

export function validateDeliberationResponse(value: unknown): DeliberationJob[] {
  const root = objectValue(value);
  if (!Array.isArray(root?.jobs) || root.jobs.length === 0) throw new Error("headless_deliberate returned no jobs.");
  return root.jobs.map((entry, index) => {
    const job = objectValue(entry);
    const result = objectValue(job?.result);
    const jobId = stringValue(job?.jobId);
    const backend = stringValue(job?.backend);
    if (!jobId || !backend || !result) throw new Error(`headless_deliberate job ${index} was malformed.`);
    return { jobId, backend, result: result as RunResult };
  });
}

export function successfulDeliberationBackends(jobs: DeliberationJob[]) {
  return unique(jobs.filter((job) => nativeResultPassed(job.result)).map((job) => job.backend));
}

export function validateCouncilRecord(
  value: unknown,
  expectedParticipants: string[],
  expectedPrincipal: string,
  requireApproved = false,
): CouncilRecord {
  const record = objectValue(value);
  const council = objectValue(record?.council);
  const decision = objectValue(record?.decision);
  const participants = stringArray(council?.participants);
  const principal = stringValue(council?.principal);
  const proposalJobs = stringArray(record?.proposalJobs);
  const executionJobs = stringArray(record?.executionJobs);
  const reviewJobs = stringArray(record?.reviewJobs);
  const voteJobs = stringArray(record?.voteJobs);
  const votes = Array.isArray(record?.votes) ? record.votes.map((entry) => objectValue(entry)) : [];
  if (!stringValue(council?.id) || council?.phase !== "decision") throw new Error("Council did not reach its decision phase.");
  if (!sameSet(participants, expectedParticipants)) throw new Error("Council participants did not match the requested servants.");
  if (principal !== expectedPrincipal) throw new Error("Council decision was not attributed to the bound lead principal.");
  for (const [phase, jobs] of [["proposal", proposalJobs], ["execution", executionJobs], ["review", reviewJobs], ["vote", voteJobs]] as const) {
    if (jobs.length !== expectedParticipants.length) throw new Error(`Council ${phase} phase did not create one job per participant.`);
  }
  const parsedVotes = votes.map((vote, index) => {
    const agent = stringValue(vote?.agent);
    const jobId = stringValue(vote?.jobId);
    const references = stringArray(vote?.references);
    if (!agent || !jobId || references.length === 0) throw new Error(`Council vote ${index} was malformed.`);
    if (!voteJobs.includes(jobId)) throw new Error(`Council vote ${index} did not cite its durable vote job.`);
    return { agent, jobId, references };
  });
  if (unique(parsedVotes.map((vote) => vote.agent)).length !== parsedVotes.length) throw new Error("Council contained duplicate parsed-vote attribution.");
  if (parsedVotes.some((vote) => !expectedParticipants.includes(vote.agent))) throw new Error("Council contained a parsed vote from a non-participant.");
  const approved = typeof decision?.approved === "boolean" ? decision.approved : null;
  const reason = stringValue(decision?.reason);
  if (approved === null || !reason || reason.includes("Council execution failed")) throw new Error("Council decision was missing or reported an execution failure.");
  if (requireApproved && !approved) throw new Error(`Council rejected the evidence rule: ${reason}`);
  return {
    council: { id: stringValue(council?.id)!, phase: "decision", participants, principal },
    proposalJobs,
    executionJobs,
    reviewJobs,
    voteJobs,
    votes: parsedVotes,
    decision: { approved, reason },
  };
}

async function collectVoteJobEvidence(
  client: NonNullable<Awaited<ReturnType<typeof connectExistingDaemon>>>,
  council: CouncilRecord,
) {
  const jobs = await Promise.all(council.voteJobs.map((jobId) => client.call<Job>("run.status", { jobId })));
  return jobs.map((job, index): VoteJobEvidence => {
    const participant = council.council.participants[index];
    if (!participant || job.backend !== participant || job.id !== council.voteJobs[index]) {
      throw new Error(`Council vote job ${index} lost its participant binding.`);
    }
    if (!job.result || job.result.status !== "succeeded") {
      throw new Error(`Council vote job ${job.id} did not terminal-complete successfully (${job.result?.status ?? job.state}).`);
    }
    const bytes = Buffer.byteLength(job.result.output);
    return {
      participant,
      jobId: job.id,
      terminalStatus: "succeeded",
      parsed: council.votes.some((vote) => vote.jobId === job.id && vote.agent === participant),
      output: Buffer.from(job.result.output).subarray(0, MAX_RECORDED_VOTE_OUTPUT_BYTES).toString("utf8"),
      outputBytes: bytes,
      outputSha256: createHash("sha256").update(job.result.output, "utf8").digest("hex"),
      outputTruncated: bytes > MAX_RECORDED_VOTE_OUTPUT_BYTES,
    };
  });
}

function councilRecordDigest(council: CouncilRecord) {
  return createHash("sha256").update(JSON.stringify({
    council: council.council,
    proposalJobs: council.proposalJobs,
    executionJobs: council.executionJobs,
    reviewJobs: council.reviewJobs,
    voteJobs: council.voteJobs,
    votes: council.votes,
    decision: council.decision,
  }), "utf8").digest("hex");
}

export function validateLedgerContext(value: unknown, title: string, jobIds: string[]) {
  const context = objectValue(value);
  if (!Array.isArray(context?.entries)) throw new Error("Ledger context did not contain raw entries.");
  const artifact = context.entries
    .map((entry) => objectValue(entry))
    .find((entry) => objectValue(entry?.artifact)?.title === title);
  if (!artifact) throw new Error("Gate B ledger artifact was not durable.");
  const serialized = JSON.stringify(artifact);
  const missing = jobIds.filter((jobId) => !serialized.includes(jobId));
  if (missing.length > 0) throw new Error(`Gate B ledger artifact omitted job ids: ${missing.join(", ")}.`);
}

export function validateObserverProjection(value: ObserverEvents, jobIds: string[]) {
  if (!Array.isArray(value.events)) throw new Error("Observer event projection was malformed.");
  const matched = unique(value.events.filter((event) => jobIds.includes(event.jobId)).map((event) => event.jobId));
  const terminal = unique(value.events
    .filter((event) => jobIds.includes(event.jobId) && event.kind === "completion")
    .map((event) => event.jobId));
  const missing = jobIds.filter((jobId) => !matched.includes(jobId));
  const nonterminal = jobIds.filter((jobId) => !terminal.includes(jobId));
  if (missing.length > 0) throw new Error(`TUI observer projection omitted job ids: ${missing.join(", ")}.`);
  if (nonterminal.length > 0) throw new Error(`TUI observer projection omitted terminal completion for: ${nonterminal.join(", ")}.`);
  return { matchedJobs: matched.length, terminalJobs: terminal.length };
}

async function callToolJson(client: Client, name: string, args: Record<string, unknown>, timeout: number) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout });
  if (response.isError === true) throw new Error(toolText(response) || `${name} failed without a diagnostic.`);
  const text = toolText(response);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${name} did not return one JSON text result.`);
  }
}

function toolText(value: { content?: unknown }) {
  if (!Array.isArray(value.content)) return "";
  return value.content.map((entry) => {
    const content = objectValue(entry);
    return content?.type === "text" && typeof content.text === "string" ? content.text : "";
  }).join("\n");
}

function nativeResultPassed(result: RunResult) {
  return result.status === "succeeded"
    && result.containment.requirement === "required"
    && result.containment.enforced
    && result.containment.network === "native-direct-unrestricted"
    && result.containment.credentialAccess === "backend-native"
    && !result.containment.unsafe;
}

function retryAfterMs(result: RunResult) {
  const value = result.error?.details?.retryAfterMs;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 15_000;
}

function rotatePair(backends: string[], attempt: number) {
  if (backends.length < 2) throw new Error("At least two successful servants are required for council.");
  return [backends[attempt % backends.length]!, backends[(attempt + 1) % backends.length]!];
}

function councilJobIds(record: CouncilRecord) {
  return unique([...record.proposalJobs, ...record.executionJobs, ...record.reviewJobs, ...record.voteJobs]);
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
  const stopOnOverflow = () => { void stopProcess(child, 1_000); };
  const output = Promise.all([
    readBounded(child.stdout, budget, stopOnOverflow),
    readBounded(child.stderr, budget, stopOnOverflow),
  ]).then(([stdout, stderr]) => ({ stdout, stderr }));
  signal.addEventListener("abort", () => { void stopProcess(child, DAEMON_STOP_TIMEOUT_MS); }, { once: true });
  return { child, output };
}

async function stopOwnedDaemonGracefully(
  cli: string,
  cwd: string,
  childEnv: NodeJS.ProcessEnv,
  signal: AbortSignal,
  daemon: ReturnType<typeof startDaemon>,
) {
  await runCheckedCli(cli, ["daemon", "stop", "--cwd", cwd], childEnv, signal);
  if (!await exitsWithin(daemon.child, DAEMON_STOP_TIMEOUT_MS)) {
    await cleanupOwnedDaemon(daemon, 1_000);
    throw new Error("Authenticated daemon stop removed the socket but the owned process did not exit.");
  }
  const output = await daemon.output.catch(() => ({ stdout: "", stderr: "" }));
  if (!daemonStopExitWasGraceful(daemon.child.exitCode, daemon.child.signalCode ?? null)) {
    throw new Error(`Owned daemon exited with code ${daemon.child.exitCode}: ${safeDiagnostic(output.stderr || output.stdout)}`);
  }
}

export function daemonStopExitWasGraceful(exitCode: number | null, signalCode: string | null) {
  return exitCode === 0 || exitCode === 143 || signalCode === "SIGTERM";
}

function writeEvidence(evidence: GateBEvidence) {
  mkdirSync(dirname(EVIDENCE_PATH), { recursive: true, mode: 0o700 });
  atomicWriteFile(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
}

async function cleanupOwnedDaemon(daemon: ReturnType<typeof startDaemon>, timeoutMs: number) {
  await stopProcess(daemon.child, timeoutMs);
  await daemon.output.catch(() => ({ stdout: "", stderr: "" }));
}

async function waitForDaemon(cwd: string, stateHome: string, runtimeHome: string, child: Child, signal: AbortSignal) {
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
  await runChecked(["git", "config", "user.name", "Headless Gate B Smoke"], { cwd, env: childEnv, timeoutMs: 10_000, signal });
  await runChecked(["git", "config", "user.email", "headless-gate-b@example.invalid"], { cwd, env: childEnv, timeoutMs: 10_000, signal });
  await Bun.write(join(cwd, "README.md"), "# Headless Gate B MCP smoke\n");
  await runChecked(["git", "add", "README.md"], { cwd, env: childEnv, timeoutMs: 10_000, signal });
  await runChecked(["git", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"], { cwd, env: childEnv, timeoutMs: 10_000, signal });
}

async function runCheckedCli(cli: string, args: string[], childEnv: NodeJS.ProcessEnv, signal: AbortSignal) {
  return runChecked([process.execPath, cli, ...args], { cwd: process.cwd(), env: childEnv, timeoutMs: 90_000, signal });
}

async function runChecked(argv: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal: AbortSignal }) {
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
  const stop = () => { void stopProcess(child, 1_000); };
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
    return { exitCode, stdout, stderr, timedOut, overflowed: budget.overflowed };
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", abort);
  }
}

async function readBounded(stream: ReadableStream<Uint8Array>, budget: { remaining: number; overflowed: boolean }, overflow: () => void) {
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

async function stopProcess(child: Child, timeoutMs: number) {
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
      void error;
    }
  }
}

function exitsWithin(child: Child, timeoutMs: number) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return Promise.race([child.exited.then(() => true, () => true), Bun.sleep(timeoutMs).then(() => false)]);
}

function smokeEnvironment(source: NodeJS.ProcessEnv, state: string, runtime: string, project: string) {
  const childEnv = { ...source };
  for (const key of Object.keys(childEnv)) {
    if (isProviderCredentialEnvironmentKey(key)) delete childEnv[key];
  }
  childEnv.HEADLESS_STATE_HOME = state;
  childEnv.HEADLESS_RUNTIME_HOME = runtime;
  childEnv.HEADLESS_PROJECT_ROOT = project;
  delete childEnv.HEADLESS_EXTENSION_CONFIG;
  return childEnv;
}

function isProviderCredentialEnvironmentKey(key: string) {
  return /(?:^|_)API_KEY$/i.test(key)
    || /^(?:ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|CODEX_API_KEY|GROK_API_KEY|OPENAI_ACCESS_TOKEN|GOOGLE_APPLICATION_CREDENTIALS|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AZURE_OPENAI_KEY)$/i.test(key);
}

function definedEnvironment(env: NodeJS.ProcessEnv) {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function assertCompiledArtifact(path: string, label: string) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Compiled ${label} is unavailable at ${path}. Run bun run build first.`);
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseJsonObject(text: string, label: string) {
  try {
    const parsed: unknown = JSON.parse(text);
    const value = objectValue(parsed);
    if (!value) throw new Error("not an object");
    return value;
  } catch {
    throw new Error(`${label} did not return one JSON object.`);
  }
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringArray(value: unknown) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : [];
}

function unique(values: readonly string[]) {
  return [...new Set(values)];
}

function sameSet(left: string[], right: string[]) {
  return left.length === right.length && unique(left).length === left.length && left.every((entry) => right.includes(entry));
}

function safeDiagnostic(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "[REDACTED_PROVIDER_CREDENTIAL]")
    .replace(/(?:Bearer\s+)[A-Za-z0-9._~+/-]{16,}/gi, "Bearer [REDACTED]")
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .slice(0, 2_048);
}

function abortableDelay(ms: number, signal: AbortSignal) {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise<void>((resolveDelay) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolveDelay();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
