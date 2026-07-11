import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import { ZodError } from "zod";
import { HeadlessError, toStructuredError } from "../runtime/headless-error";
import type { RunResult, SerializedRunRequest } from "../contracts/run";
import { killAllActiveRunners } from "../runner/simple";
import { redactAndTruncate } from "../runtime/redaction";
import { safeAgentName } from "../runtime/validation";
import { cleanupWithDiagnostic, recordRuntimeDiagnostic } from "../runtime/diagnostics";
import { ensureOwnerOnlyFile, ensureProjectStateDirectories, getProjectStatePaths, type ProjectStateOptions } from "../runtime/project-state";
import { safeJsonParse } from "../runtime/safe-json";
import {
  DAEMON_PROTOCOL_VERSION,
  DaemonRequestSchema,
  MAX_DAEMON_MESSAGE_BYTES,
  type DaemonRequest,
  type DaemonResponse,
} from "./protocol";
import { JobStore } from "./job-store";
import { ProviderBroker } from "../broker/server";
import { getProvider } from "../broker/providers";
import { PersistentSessionStore } from "../runtime/persistent-sessions";
import { NativeSessionManager } from "../runtime/native-session-manager";
import { ProjectTrustStore } from "../runtime/project-trust-store";
import { FleetProfileStore } from "../runtime/fleet-profile-store";
import { GoalStore } from "../runtime/goal-store";
import { ApprovalStore } from "../runtime/approval-store";
import type { CandidateIntegrationService } from "../runtime/candidate-integration-service";
import { DirectedMailbox } from "../runtime/directed-mailbox";
import type { GoalAgentAvailability, GoalSecurityControls } from "../runtime/goal-coordinator-service";
import { GoalRuntimeService } from "./goal-runtime-service";
import { createWorkerEnvironment } from "../runtime/worker-environment";
import { installNativeAuthCapsule } from "../runtime/native-auth-capsule";
import { getAdapter, requiredContainmentSecurityGaps, resolveAdapterId } from "../backends/registry";
import type { Job, Task } from "../contracts/durable";
import type { AgentProfile, FleetProfile } from "../contracts/collaboration";
import { AuthorityStore } from "../runtime/authority-store";
import { BudgetStore } from "../runtime/budget-store";
import { FinalityStore } from "../runtime/finality-store";
import { appendEvent, getOrCreateSession } from "../runtime/session";
import { CouncilStore } from "../runtime/council-store";
import { CouncilService } from "./council-service";
import { DEFAULT_GATES, runReleaseGate, type GateCheck } from "../runtime/release-gate";
import { OrchestrationStateStore } from "../runtime/orchestration-state";
import { listAdapters } from "../backends/registry";
import { atomicWriteFile } from "../runtime/atomic-write";
import { getProcessStartIdentity } from "../runtime/ledger-v2";
import { getHeadSha, runGitStrict } from "../runtime/git";
import { WorktreeLeaseStore } from "../runtime/worktree-leases";
import { IntegrationJournal, type IntegrationJournalRecord } from "../runtime/integration-journal";
import { WorkflowService } from "./workflow-service";
import {
  JobAdmissionService,
  estimateRequestResources,
} from "./job-admission-service";
import { TaskStore } from "./task-store";
import { RunEventStore } from "./run-event-store";
import { PersistentMessageQueue } from "../runtime/message-queue";
import { CredentialStore, type AuthenticatedCredential } from "../runtime/credential-store";
import { assertPrincipalOwns } from "./auth";
import { RunToolEndpointManager } from "./run-tool-endpoint";
import { createRunToolCallHandler } from "./run-tool-operations";
import { dispatchDaemonRoute, type DaemonRouteHandlerMap } from "./route-dispatcher";
import { createDaemonRouteHandlers } from "./route-handlers";
import { optionalString, optionalTimeout, stringArray, stringParam } from "./route-params";
import { createCandidateIntegrationService } from "./candidate-service";
import { RunExecutionService } from "./run-execution-service";
import {
  loadDaemonExtensions,
  resolveDaemonExtensionConfig,
  type LoadedDaemonExtensions,
} from "../runtime/daemon-extensions";

export type HeadlessDaemonOptions = {
  projectRoot: string;
  principal?: string;
  state?: ProjectStateOptions;
  token?: string;
  coordinator?: string;
  maxConcurrency?: number;
  maxQueued?: number;
  /** Project-configured checks executed in the candidate and integration worktrees. */
  writeGateChecks?: GateCheck[];
  /** Trusted startup-only extension config; never accepted by the daemon protocol. */
  extensionConfigPath?: string;
  /** Trusted absolute entrypoints for embedded/bootstrapped daemons. */
  extensionModules?: readonly string[];
};

export class HeadlessDaemon {
  readonly state;
  readonly principal: string;
  jobs!: JobStore;
  private token = "";
  private readonly configuredToken?: string;
  private readonly stateOptions?: ProjectStateOptions;
  private readonly waiters = new Map<string, Array<(job: Job) => void>>();
  private readonly broker: ProviderBroker;
  private sessions!: PersistentSessionStore;
  private nativeSessions!: NativeSessionManager;
  private trust!: ProjectTrustStore;
  private fleets!: FleetProfileStore;
  private goals!: GoalStore;
  private approvals!: ApprovalStore;
  private candidateIntegrations!: CandidateIntegrationService;
  private directedMailbox!: DirectedMailbox;
  private goalRuntime!: GoalRuntimeService;
  private tasks!: TaskStore;
  private runEvents!: RunEventStore;
  private authority!: AuthorityStore;
  private budgets!: BudgetStore;
  private finality!: FinalityStore;
  private readonly jobAdmissionLimits: Pick<HeadlessDaemonOptions, "maxConcurrency" | "maxQueued">;
  private readonly coordinator: string;
  private councils!: CouncilStore;
  private orchestration!: OrchestrationStateStore;
  private messages!: PersistentMessageQueue;
  private credentials!: CredentialStore;
  private worktreeLeases!: WorktreeLeaseStore;
  private integrationJournal!: IntegrationJournal;
  private workflowService!: WorkflowService;
  private jobAdmission!: JobAdmissionService;
  private runTools!: RunToolEndpointManager;
  private councilService!: CouncilService;
  private runExecution!: RunExecutionService;
  private readonly writeGateChecks: GateCheck[];
  private readonly extensionConfig;
  private loadedExtensions: LoadedDaemonExtensions;
  private readonly executions = new Set<Promise<void>>();
  private stopping = false;
  private ready = false;
  private ownedStateInitialized = false;
  private server: Server | null = null;
  private routeHandlers!: DaemonRouteHandlerMap;

  constructor(options: HeadlessDaemonOptions) {
    this.state = ensureProjectStateDirectories(getProjectStatePaths(options.projectRoot, options.state));
    this.principal = (options.principal?.trim() || localPrincipal()).slice(0, 128);
    this.configuredToken = options.token;
    this.stateOptions = options.state;
    this.broker = new ProviderBroker({
      unixSocketPath: join(this.state.daemonRuntimeDir, `${this.state.projectId.slice(0, 16)}-${process.pid}-${randomBytes(4).toString("hex")}.broker.sock`),
    });
    this.coordinator = options.coordinator ?? this.principal;
    this.writeGateChecks = options.writeGateChecks ?? DEFAULT_GATES;
    this.jobAdmissionLimits = { maxConcurrency: options.maxConcurrency, maxQueued: options.maxQueued };
    this.extensionConfig = resolveDaemonExtensionConfig({
      configPath: options.extensionConfigPath,
      modulePaths: options.extensionModules,
      env: options.state?.env,
    });
    this.loadedExtensions = {
      digest: this.extensionConfig.digest,
      adapters: [],
      providers: [],
      pricing: [],
    };
  }

  async start() {
    if (process.platform === "win32") throw new HeadlessError("UNSUPPORTED_PLATFORM", "Headless daemon is unsupported on Windows.");
    if (this.server) return this.state.socketPath;
    this.stopping = false;
    this.ready = false;
    this.jobAdmission?.dispose();
    if (existsSync(this.state.socketPath)) {
      if (await socketBecomesAvailable(this.state.socketPath)) throw new HeadlessError("DAEMON_ALREADY_RUNNING", `A Headless daemon already owns ${this.state.canonicalProjectRoot}.`);
      rmSync(this.state.socketPath, { force: true });
    }
    const server = createServer((socket) => this.accept(socket));
    let bound = false;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.state.socketPath, () => {
          bound = true;
          server.off("error", reject);
          resolve();
        });
      });
      chmodSync(this.state.socketPath, 0o600);
      this.loadedExtensions = await loadDaemonExtensions(this.extensionConfig);
      this.initializeOwnedState();
      this.broker.start();
      // The socket elects the local daemon; durable worktree leases additionally
      // fail closed on a live or foreign-host owner before recovery/admission.
      this.worktreeLeases.reconcile();
      await this.candidateIntegrations.reconcile();
      this.reconcileIntegrationJournal();
      this.jobs.recoverInterruptedJobs(true);
      this.jobAdmission.recoverBudgetReservations();
      this.reconcilePersistentSessions();
      this.reconcileTasks();
      this.ready = true;
      this.server = server;
      this.writeMetadata(true);
    } catch (error) {
      this.ready = false;
      await cleanupWithDiagnostic("daemon.start.socket-close", () => new Promise<void>((resolve) => server.close(() => resolve())));
      if (bound) await cleanupWithDiagnostic("daemon.start.socket-remove", () => { rmSync(this.state.socketPath, { force: true }); });
      await cleanupWithDiagnostic("daemon.start.run-tools-revoke", () => this.runTools?.revokeAll());
      await cleanupWithDiagnostic("daemon.start.goal-runtime-dispose", () => this.goalRuntime?.dispose());
      await cleanupWithDiagnostic("daemon.start.job-admission-dispose", () => this.jobAdmission?.dispose());
      await cleanupWithDiagnostic("daemon.start.broker-stop", () => this.broker.stop());
      await cleanupWithDiagnostic("daemon.start.message-queue-close", () => this.messages?.close());
      this.ownedStateInitialized = false;
      throw error;
    }
    this.jobAdmission.recoverQueuedJobs();
    this.workflowService.recover();
    this.councilService.recover();
    this.goalRuntime.recover();
    return this.state.socketPath;
  }

  async stop() {
    this.stopping = true;
    this.jobAdmission?.dispose();
    this.runExecution?.cancelAll("daemon stopping");
    if (this.executions.size) {
      const drained = await waitForExecutions(this.executions, 30_000);
      if (!drained) {
        const terminations = await killAllActiveRunners("SIGKILL");
        if (terminations.some((termination) => !termination.exited) || !(await waitForExecutions(this.executions, 5_000))) {
          // Keep the listening socket and broker ownership intact: allowing a
          // replacement daemon while old workers still run would violate the
          // one-owner boundary.
          throw new HeadlessError("DAEMON_SHUTDOWN_INCOMPLETE", "Daemon workers did not terminate during bounded shutdown.", { retryable: true });
        }
      }
    }
    if (this.ownedStateInitialized) {
      await this.goalRuntime.waitForIdle();
      this.goalRuntime.dispose();
    }
    if (this.ownedStateInitialized) await this.nativeSessions.closeAll();
    if (this.ownedStateInitialized) await this.runTools.revokeAll();
    if (this.server) {
      this.ready = false;
      const server = this.server;
      this.server = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(this.state.socketPath, { force: true });
    }
    this.broker.stop();
    if (this.ownedStateInitialized) {
      this.messages.close();
      this.writeMetadata(false);
      this.ownedStateInitialized = false;
    }
  }

  private accept(socket: Socket) {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_DAEMON_MESSAGE_BYTES) {
        socket.destroy(new Error("Daemon request exceeded the message limit."));
        return;
      }
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        void this.respond(socket, line);
      }
    });
  }

  private async respond(socket: Socket, line: string) {
    let request: DaemonRequest;
    try {
      request = DaemonRequestSchema.parse(safeJsonParse(line));
    } catch (error) {
      socket.end(`${JSON.stringify(failure(crypto.randomUUID(), error, { code: "INVALID_REQUEST", safeMessage: messageOf(error) }))}\n`);
      return;
    }
    if (!this.ready) {
      socket.end(`${JSON.stringify(failure(request.id, new HeadlessError("DAEMON_UNAVAILABLE", "Daemon is still acquiring or releasing project ownership.", { retryable: true })))}\n`);
      return;
    }
    const credential = this.credentials.authenticate(request.token);
    if (!credential) {
      socket.end(`${JSON.stringify(failure(request.id, new HeadlessError("DAEMON_AUTH_FAILED", "Daemon authentication failed.")))}\n`);
      return;
    }
    try {
      const result = await dispatchDaemonRoute(this.routeHandlers, request.method, request.params, credential);
      socket.end(`${JSON.stringify({ version: DAEMON_PROTOCOL_VERSION, id: request.id, ok: true, result } satisfies DaemonResponse)}\n`);
    } catch (error) {
      const fallback = error instanceof ZodError || error instanceof TypeError
        ? { code: "INVALID_REQUEST" as const, safeMessage: messageOf(error) }
        : { code: "INTERNAL_ERROR" as const, safeMessage: "The daemon could not complete the request." };
      socket.end(`${JSON.stringify(failure(request.id, error, fallback))}\n`);
    }
  }

  private fleetHealth(profile: FleetProfile) {
    const agents = profile.agents.map((agent) => ({
      agent,
      ...this.agentAvailability(agent),
      executable: getAdapter(resolveAdapterId(agent.backend))?.probe.versionCommand[0] ?? null,
    }));
    return {
      profileId: profile.id,
      active: this.fleets.snapshot().activeProfileId === profile.id,
      leaderCandidates: agents,
      healthy: agents.some((entry) => entry.authenticated && (entry.health === "healthy" || entry.health === "degraded")),
      checkedAt: Date.now(),
    };
  }

  private agentAvailability(
    agent: AgentProfile,
    security: GoalSecurityControls = { authMode: agent.authMode, approvalPolicy: agent.approvalPolicy },
  ): GoalAgentAvailability {
    let executable = false;
    let containmentBlocked = false;
    try {
      const adapter = getAdapter(resolveAdapterId(agent.backend));
      executable = !!adapter && Bun.which(adapter.probe.versionCommand[0]) !== null;
      // A backend that cannot satisfy required outer containment can never run in
      // a goal — goals are always required-contained and unsafe execution is
      // rejected. Treat it as unavailable so the coordinator selects a runnable
      // backend instead of dispatching delegations that fail-close every attempt.
      containmentBlocked = !!adapter && requiredContainmentSecurityGaps(adapter).length > 0;
    } catch (error) {
      recordRuntimeDiagnostic("transport", "fleet-agent-probe", error, "warning");
      executable = false;
    }
    let authenticated = false;
    if (executable) {
      if (security.authMode === "native-login") {
        const trust = this.trust.status();
        if (trust.trusted && trust.nativeLoginAllowed && (security.approvalPolicy !== "bypass" || trust.bypassAllowed)) {
          const worker = createWorkerEnvironment();
          try {
            authenticated = installNativeAuthCapsule(worker, resolveAdapterId(agent.backend)).available;
          } catch (error) {
            console.error(redactAndTruncate(`Native fleet auth probe failed for ${agent.id}: ${messageOf(error)}`, 2_048).text);
          } finally {
            worker.cleanup();
          }
        }
      } else {
        const provider = providerForBackend(agent.backend, agent.model);
        const definition = provider ? getProvider(provider) : null;
        authenticated = getAdapter(resolveAdapterId(agent.backend))?.security.strictAuth === "credential-free"
          || (!!definition && !!process.env[definition.credentialEnv]);
      }
    }
    const sessions = this.sessions.list().filter((session) => session.backend === resolveAdapterId(agent.backend));
    const rateLimitedUntil = sessions.reduce<number | null>((latest, session) => {
      const rate = session.native?.rateLimit;
      if (!rate?.limited || rate.retryAfterMs === null || rate.detectedAt === null) return latest;
      const until = rate.detectedAt + rate.retryAfterMs;
      return latest === null || until > latest ? until : latest;
    }, null);
    const recent = this.jobs.list().filter((job) => job.backend === resolveAdapterId(agent.backend)).slice(-20);
    const recentFailures = recent.filter((job) => job.state === "failed" || job.state === "timed_out").length;
    const activeTurns = sessions.filter((session) => session.state === "running" || session.state === "cancelling").length;
    const health: GoalAgentAvailability["health"] = !executable || containmentBlocked
      ? "offline"
      : !authenticated ? "unhealthy" : rateLimitedUntil !== null && rateLimitedUntil > Date.now() ? "degraded" : "healthy";
    return { authenticated, health, rateLimitedUntil, activeTurns, recentFailures };
  }

  private wait(jobId: string, timeoutMs = 180_000): Promise<Job> {
    const job = this.requireJob(jobId);
    if (["succeeded", "failed", "timed_out", "cancelled", "blocked"].includes(job.state)) return Promise.resolve(job);
    return new Promise<Job>((resolve, reject) => {
      const timer = setTimeout(() => {
        const active = this.waiters.get(jobId) ?? [];
        const index = active.indexOf(callback);
        if (index >= 0) active.splice(index, 1);
        if (active.length === 0) this.waiters.delete(jobId);
        reject(new HeadlessError("TIMED_OUT", "Timed out waiting for the daemon job."));
      }, timeoutMs);
      const callback = (completed: Job) => {
        clearTimeout(timer);
        resolve(completed);
      };
      const waiting = this.waiters.get(jobId) ?? [];
      waiting.push(callback);
      this.waiters.set(jobId, waiting);
    });
  }

  private requireJob(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new HeadlessError("INVALID_REQUEST", `Unknown job: ${id}`);
    return job;
  }

  private requireJobFor(id: string, credential: AuthenticatedCredential) {
    const job = this.requireJob(id);
    assertPrincipalOwns(credential, job.principal, "Job");
    return job;
  }

  private visibleJobs(credential: AuthenticatedCredential, jobId?: string) {
    if (jobId) return [this.requireJobFor(jobId, credential)];
    const jobs = this.jobs.list();
    return credential.scopes.includes("admin") ? jobs : jobs.filter((job) => job.principal === credential.principal);
  }

  private requireTask(id: string) {
    const task = this.tasks.get(id);
    if (!task) throw new HeadlessError("INVALID_REQUEST", `Unknown task: ${id}`);
    return task;
  }

  private isTaskVisible(task: Task, credential: AuthenticatedCredential) {
    if (credential.scopes.includes("admin") || task.claimedBy === credential.principal) return true;
    const job = this.jobs.get(task.jobId);
    if (!job) return false;
    if (job.principal === credential.principal) return true;
    return this.authority.authorize({
      projectId: this.state.projectId,
      principal: credential.principal,
      operation: job.mode === "write" ? "write" : "run",
      backend: job.backend,
      // Visibility checks do not authorize a new provider request or spend.
      estimatedCostUsd: 0,
      merge: false,
    }).allowed;
  }

  private assertTaskVisible(task: Task, credential: AuthenticatedCredential) {
    if (this.isTaskVisible(task, credential)) return;
    throw new HeadlessError("POLICY_DENIED", "Task belongs to another authenticated principal.");
  }

  private taskForJob(jobId: string) {
    return this.tasks.list({ jobId })[0] ?? null;
  }

  private createSession(params: Record<string, unknown>, principal: string) {
    const backend = resolveAdapterId(stringParam(params, "backend"));
    const adapter = getAdapter(backend);
    const requestedAgent = optionalString(params.agent);
    const agent = requestedAgent ? safeAgentName(requestedAgent, backend) : undefined;
    if (agent && !adapter?.supportsNamedAgent) {
      throw new HeadlessError("BACKEND_UNSUPPORTED", `Backend ${backend} does not support named agents in contained Headless sessions.`);
    }
    const authMode = params.authMode === "broker" ? "broker" : "native-login";
    const approvalPolicy = params.approvalPolicy === "auto" || params.approvalPolicy === "bypass" ? params.approvalPolicy : "ask";
    if (authMode === "native-login" && adapter?.security.strictAuth !== "credential-free") {
      const trust = this.trust.status();
      if (!trust.trusted || !trust.nativeLoginAllowed || (approvalPolicy === "bypass" && !trust.bypassAllowed)) {
        throw new HeadlessError("NATIVE_AUTH_UNAVAILABLE", "Native sessions require compatible project trust.");
      }
    }
    return this.sessions.create({
      principal,
      backend,
      model: optionalString(params.model),
      agent,
      containment: params.containment === "unsafe" ? "unsafe" : "required",
      authMode,
      approvalPolicy,
      nativeSessionId: adapter?.capabilities.nativeResume ? optionalString(params.nativeSessionId) ?? null : null,
    });
  }

  private sendSession(params: Record<string, unknown>, credential: AuthenticatedCredential) {
    const session = this.requireSessionFor(stringParam(params, "sessionId"), credential);
    if (session.state === "running" || session.state === "cancelling") {
      throw new HeadlessError("INVALID_REQUEST", "Session already has an active job.");
    }
    const prompt = stringParam(params, "prompt");
    const replay = this.sessions.replay(session.id);
    const fullPrompt = session.replay && replay.text
      ? `The following is a bounded, redacted replay of this persistent session. Replay truncated: ${replay.truncated}.\n\n${replay.text}\n\nNEW USER REQUEST:\n${prompt}`
      : prompt;
    this.sessions.append(session.id, "user", prompt);
    const job = this.jobAdmission.submit({
      backend: session.backend,
      prompt: fullPrompt,
      mode: "read-only",
      model: session.model ?? undefined,
      agent: session.agent ?? undefined,
      timeoutMs: params.timeoutMs,
      sessionId: session.id,
      containment: session.containment,
      authMode: session.authMode,
      approvalPolicy: session.approvalPolicy,
    }, session.principal);
    this.sessions.start(session.id, job.id);
    void this.wait(job.id).then((completed) => {
      if (completed?.result) this.sessions.complete(session.id, completed.result);
    }).catch((error) => {
      const detail = redactAndTruncate(`Persistent session completion failed: ${messageOf(error)}`, 2_048).text;
      try {
        this.runEvents.append({ jobId: job.id, sessionId: session.id }, {
          kind: "policy",
          decision: "deferred",
          rule: "session-completion-recovery",
          reason: detail,
        });
      } catch (diagnosticError) {
        console.error(redactAndTruncate(`Unable to persist session recovery diagnostic: ${messageOf(diagnosticError)}`, 2_048).text);
      }
    });
    return { session: this.requireSession(session.id), job, replay: { truncated: replay.truncated, bytes: replay.bytes } };
  }

  private cancelSession(id: string, credential: AuthenticatedCredential) {
    const session = this.requireSessionFor(id, credential);
    if (!session.lastJobId) return session;
    this.sessions.cancelling(id);
    if (session.authMode === "native-login") {
      void this.nativeSessions.cancel(id).catch((error) => {
        console.error(redactAndTruncate(`Unable to cancel native session ${id}: ${messageOf(error)}`, 2_048).text);
      });
    }
    this.jobAdmission.cancel(session.lastJobId);
    return this.requireSession(id);
  }

  private requireSession(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new HeadlessError("INVALID_REQUEST", `Unknown session: ${id}`);
    return session;
  }

  private requireSessionFor(id: string, credential: AuthenticatedCredential) {
    const session = this.requireSession(id);
    assertPrincipalOwns(credential, session.principal, "Session");
    return session;
  }

  private assertRequestedSessionOwnership(params: Record<string, unknown>, credential: AuthenticatedCredential) {
    const sessionId = optionalString(params.sessionId);
    if (!sessionId) return;
    const session = this.sessions.get(sessionId);
    if (session) assertPrincipalOwns(credential, session.principal, "Session");
  }

  private resolveWaiters(job: Job) {
    for (const resolve of this.waiters.get(job.id) ?? []) resolve(job);
    this.waiters.delete(job.id);
  }

  private reconcileIntegrationJournal() {
    const primaryHead = getHeadSha(this.state.canonicalProjectRoot);
    if (!primaryHead) {
      if (this.integrationJournal.listOpen().length > 0) throw new Error("Cannot reconcile integration journal without a primary Git HEAD.");
      return;
    }
    for (const record of this.integrationJournal.listOpen()) {
      const job = this.jobs.get(record.jobId);
      if (!job) throw new Error(`Integration journal references missing job ${record.jobId}.`);
      const targetApplied = gitIsAncestor(record.targetCommit, primaryHead, this.state.canonicalProjectRoot);
      const expectedStillRelevant = gitIsAncestor(record.expectedPrimaryHead, primaryHead, this.state.canonicalProjectRoot);
      const session = getOrCreateSession({
        cwd: this.state.canonicalProjectRoot,
        state: this.stateOptions,
        authenticatedPrincipal: record.principal,
        sessionId: record.sessionId ?? `recovery-${record.jobId}`,
      });

      if (targetApplied) {
        const status = runGitStrict(["status", "--porcelain=v1", "--untracked-files=all"], this.state.canonicalProjectRoot);
        if (!status.ok || status.stdout.trim()) {
          throw new Error(`Applied integration journal ${record.jobId} cannot be reconciled while the primary checkout is dirty or unverifiable.`);
        }
        this.integrationJournal.markApplied(record.jobId, record.targetCommit);
        appendEvent(session, integrationRecoveryEvent(record, "applied", primaryHead), integrationJournalEventId(record, "applied"));
        this.jobs.recoverAppliedIntegration(record.jobId, recoveredIntegrationResult(job, this.jobs.request(record.jobId), record));
        this.integrationJournal.markCompleted(record.jobId, record.targetCommit);
        continue;
      }

      if (record.state === "applied" || !expectedStillRelevant) {
        throw new Error(`Integration journal ${record.jobId} is ambiguous: primary ${primaryHead} contains neither the prepared target nor a verifiable unmodified base.`);
      }
      appendEvent(session, integrationRecoveryEvent(record, "abandoned", primaryHead), integrationJournalEventId(record, "abandoned"));
      this.integrationJournal.markAbandoned(record.jobId, primaryHead);
    }
  }

  private reconcilePersistentSessions() {
    for (const session of this.sessions.list()) {
      if (session.state !== "running" && session.state !== "cancelling") continue;
      const job = session.lastJobId ? this.jobs.get(session.lastJobId) : null;
      if (!job?.result || !["succeeded", "failed", "timed_out", "cancelled", "blocked"].includes(job.state)) continue;
      this.sessions.complete(session.id, job.result);
    }
  }

  private reconcileTasks() {
    this.tasks.recoverStaleLeases();
    for (const task of this.tasks.list()) {
      if (task.state === "completed" || task.state === "failed" || task.state === "cancelled") continue;
      const job = this.jobs.get(task.jobId);
      if (!job) {
        this.tasks.cancel({ taskId: task.id, principal: this.principal });
        continue;
      }
      if (!job.result || !["succeeded", "failed", "timed_out", "cancelled", "blocked"].includes(job.state)) continue;
      let current = this.tasks.get(task.id)!;
      if (current.state === "pending") {
        current = this.tasks.claim({ taskId: current.id, principal: job.principal, leaseMs: 1_000 });
      }
      this.tasks.complete({
        taskId: current.id,
        principal: current.claimedBy ?? job.principal,
        outcome: job.state === "succeeded" ? "completed" : "failed",
      });
    }
  }

  /** Initialize every mutable project store only after this process has won the socket. */
  private initializeOwnedState() {
    this.token = this.configuredToken ?? loadOrCreateToken(this.state.tokenPath);
    this.jobs = new JobStore(this.state.jobsDir);
    this.tasks = new TaskStore(this.state.tasksDir, { recoverOnOpen: false });
    this.runEvents = new RunEventStore(this.state.runEventsPath, { compactOnOpen: false });
    this.sessions = new PersistentSessionStore(this.state);
    this.nativeSessions = new NativeSessionManager(this.state.canonicalProjectRoot, this.sessions, {
      authHomeDir: this.stateOptions?.homeDir,
      diagnostic: (message, error) => {
        console.error(redactAndTruncate(`${message} ${messageOf(error)}`, 2_048).text);
      },
    });
    this.trust = new ProjectTrustStore(this.state);
    this.fleets = new FleetProfileStore(this.state);
    if (this.fleets.list().length === 0) {
      this.fleets.create({
        id: "fleet-default",
        name: "Installed native coders",
        coordinator: { kind: "automatic" },
        agents: listAdapters().map((adapter) => ({
          id: adapter.id,
          backend: adapter.id,
          name: adapter.id,
          priority: adapter.id === "codex" ? 20 : adapter.id === "claude-code" ? 10 : adapter.id === "opencode" ? 5 : 0,
          capabilities: [
            "read",
            ...(adapter.capabilities.write ? ["write"] : []),
            ...(adapter.capabilities.tools ? ["tools"] : []),
            ...(adapter.capabilities.nativeResume ? ["native-resume"] : []),
          ],
        })),
      });
    }
    this.goals = new GoalStore(this.state);
    this.approvals = new ApprovalStore(this.state, { expiryActor: this.principal });
    this.directedMailbox = new DirectedMailbox({ statePath: join(this.state.projectDir, "directed-mailbox.json") });
    this.authority = new AuthorityStore(this.state, { coordinator: this.coordinator });
    this.budgets = new BudgetStore(this.state);
    this.finality = new FinalityStore(this.state);
    this.jobAdmission = new JobAdmissionService({
      projectId: this.state.projectId,
      projectRoot: this.state.canonicalProjectRoot,
      ...this.jobAdmissionLimits,
      jobs: this.jobs,
      tasks: this.tasks,
      runEvents: this.runEvents,
      approvals: this.approvals,
      trust: this.trust,
      authority: this.authority,
      budgets: this.budgets,
      isStopping: () => this.stopping,
      execute: (jobId, request, controls) => this.runExecution.execute(jobId, request, controls),
      abort: (jobId) => { this.runExecution.cancel(jobId); },
      completed: (job) => this.resolveWaiters(job),
      trackExecution: (execution) => {
        this.executions.add(execution);
        void execution.then(
          () => this.executions.delete(execution),
          () => this.executions.delete(execution),
        );
      },
      diagnostic: (message, error) => {
        console.error(redactAndTruncate(`${message} ${error === undefined ? "" : messageOf(error)}`, 2_048).text);
      },
    });
    this.councils = new CouncilStore(this.state);
    this.councilService = new CouncilService({
      projectId: this.state.projectId,
      councils: this.councils,
      jobs: this.jobs,
      submit: (params, principal, options) => this.jobAdmission.submit(params, principal, options),
      wait: (jobId, timeoutMs) => this.wait(jobId, timeoutMs),
      authorize: (request) => this.authority.authorize(request),
      resolveBackend: resolveAdapterId,
      getBackend: (backend) => getAdapter(backend) ?? null,
      latestFinality: (jobId) => this.finality.latest(jobId),
      listFinality: () => this.finality.list().map(({ decision }) => decision),
      evaluateFinality: (input) => this.finality.evaluate(input),
      isStopping: () => this.stopping,
      trackExecution: (execution) => {
        this.executions.add(execution);
        void execution.finally(() => this.executions.delete(execution));
      },
    });
    this.orchestration = new OrchestrationStateStore(this.state);
    this.messages = new PersistentMessageQueue(join(this.state.projectDir, "message-queue.sqlite"));
    this.credentials = new CredentialStore(this.state, { token: this.token, principal: this.principal });
    this.worktreeLeases = new WorktreeLeaseStore(this.state.worktreesDir, this.state.projectId);
    this.integrationJournal = new IntegrationJournal(this.state);
    this.candidateIntegrations = createCandidateIntegrationService({
      paths: this.state,
      jobs: this.jobs,
      finality: this.finality,
      approvals: this.approvals,
      authority: this.authority,
      journal: this.integrationJournal,
      worktreeLeases: this.worktreeLeases,
      checks: this.writeGateChecks,
    });
    this.workflowService = new WorkflowService({
      paths: this.state,
      projectRoot: this.state.canonicalProjectRoot,
      isStopping: () => this.stopping,
      assertSessionOwnership: (sessionId, credential) => {
        this.assertRequestedSessionOwnership({ sessionId }, credential);
      },
      estimate: estimateRequestResources,
      authorize: (request) => this.authority.authorize(request),
      submit: (params, principal, options) => this.jobAdmission.submit(params, principal, options),
      getJob: (jobId) => this.jobs.get(jobId),
      getJobRequest: (jobId) => this.jobs.request(jobId),
      waitJob: (jobId, timeoutMs) => this.wait(jobId, timeoutMs),
      cancelJob: (jobId) => {
        this.jobAdmission.cancel(jobId);
      },
      evaluateFinality: (evaluation) => this.finality.evaluate(evaluation),
      trackExecution: (execution) => {
        this.executions.add(execution);
        void execution.finally(() => this.executions.delete(execution));
      },
      diagnostic: (message, error) => {
        console.error(redactAndTruncate(`${message} ${messageOf(error)}`, 2_048).text);
      },
    });
    this.runTools = new RunToolEndpointManager({
      socketDir: this.state.daemonRuntimeDir,
      handle: createRunToolCallHandler({
        projectRoot: this.state.canonicalProjectRoot,
        state: this.stateOptions,
        getJob: (jobId) => this.jobs.get(jobId),
        getTask: (jobId) => this.taskForJob(jobId),
        messages: this.messages,
      }),
    });
    this.runExecution = new RunExecutionService({
      paths: this.state,
      stateOptions: this.stateOptions,
      jobs: this.jobs,
      tasks: this.tasks,
      runEvents: this.runEvents,
      sessions: this.sessions,
      nativeSessions: this.nativeSessions,
      approvals: this.approvals,
      authority: this.authority,
      budgets: this.budgets,
      finality: this.finality,
      broker: this.broker,
      runTools: this.runTools,
      worktreeLeases: this.worktreeLeases,
      integrationJournal: this.integrationJournal,
      writeGateChecks: this.writeGateChecks,
      completed: (job) => this.resolveWaiters(job),
    });
    this.goalRuntime = new GoalRuntimeService({
      paths: this.state,
      stateOptions: this.stateOptions,
      coordinatorPrincipal: this.coordinator,
      maxConcurrency: this.jobAdmission.maxConcurrency,
      maxQueued: this.jobAdmission.maxQueued,
      fleets: this.fleets,
      goals: this.goals,
      sessions: this.sessions,
      jobs: this.jobs,
      finality: this.finality,
      candidates: this.candidateIntegrations,
      mailbox: this.directedMailbox,
      trust: this.trust,
      orchestration: this.orchestration,
      availability: (agent, security) => this.agentAvailability(agent, security),
      createSession: (params, principal) => this.createSession(params, principal),
      submitRun: (params, principal, options) => this.jobAdmission.submit(params, principal, options),
      waitRun: (jobId, timeoutMs) => this.wait(jobId, timeoutMs),
      cancelRun: (jobId) => this.jobAdmission.cancel(jobId),
      isStopping: () => this.stopping,
      load: () => this.jobAdmission.load(),
      diagnostic: (message, error) => {
        console.error(redactAndTruncate(`${message} ${error === undefined ? "" : messageOf(error)}`, 2_048).text);
      },
    });
    this.initializeRouteHandlers();
    this.ownedStateInitialized = true;
  }

  private initializeRouteHandlers() {
    this.routeHandlers = createDaemonRouteHandlers({
      projectId: this.state.projectId,
      projectRoot: this.state.canonicalProjectRoot,
      stateOptions: this.stateOptions,
      extensionInfo: () => ({
        digest: this.loadedExtensions.digest,
        adapters: this.loadedExtensions.adapters,
        providers: this.loadedExtensions.providers,
        pricing: this.loadedExtensions.pricing,
      }),
      trust: this.trust,
      fleets: this.fleets,
      fleetHealth: (profile) => this.fleetHealth(profile),
      startGoal: (params, credential) => this.goalRuntime.startGoal(params, credential),
      goalCoordinator: this.goalRuntime.coordinator,
      goals: this.goals,
      directedMailbox: this.directedMailbox,
      requireGoal: (goalId) => this.goalRuntime.requireGoal(goalId),
      cancelGoalAs: (goalId, actor) => this.goalRuntime.cancelGoalAs(goalId, actor),
      approvals: this.approvals,
      resolveApproval: (params, credential) => {
        const approval = this.approvals.resolveAsAdministrator(params.approvalId, credential.principal, params.decision, params.resolution);
        this.jobAdmission.handleApprovalResolution(approval);
        this.goalRuntime.handleApprovalResolution(approval);
        return approval;
      },
      candidates: this.candidateIntegrations,
      credentials: this.credentials,
      authority: this.authority,
      budgets: this.budgets,
      assertRequestedSessionOwnership: (params, credential) => this.assertRequestedSessionOwnership(params, credential),
      submitRun: (params, principal) => this.jobAdmission.submit(params, principal),
      jobs: this.jobs,
      requireJob: (jobId) => this.requireJob(jobId),
      requireJobFor: (jobId, credential) => this.requireJobFor(jobId, credential),
      cancelRun: (jobId) => this.jobAdmission.cancel(jobId),
      waitRun: (jobId, timeoutMs) => this.wait(jobId, timeoutMs),
      visibleJobs: (credential, jobId) => this.visibleJobs(credential, jobId),
      runEvents: this.runEvents,
      tasks: this.tasks,
      requireTask: (taskId) => this.requireTask(taskId),
      assertTaskVisible: (task, credential) => this.assertTaskVisible(task, credential),
      isTaskVisible: (task, credential) => this.isTaskVisible(task, credential),
      messages: this.messages,
      runCouncil: (params, principal) => this.councilService.run(params, principal),
      councils: this.councils,
      createWorkflow: (params, credential) => this.workflowService.create(params, credential),
      requireWorkflowFor: (workflowId, credential) => this.workflowService.requireFor(workflowId, credential),
      workflows: this.workflowService.store,
      waitWorkflow: (workflowId, timeoutMs) => this.workflowService.wait(workflowId, timeoutMs),
      cancelWorkflow: (workflowId) => this.workflowService.cancel(workflowId),
      runGate: (params, principal) => runReleaseGate({
        checks: parseGateChecks(params.checks),
        cwd: this.state.canonicalProjectRoot,
        state: this.stateOptions,
        timeoutMs: optionalTimeout(params.timeoutMs),
        sessionId: optionalString(params.sessionId),
        authenticatedPrincipal: principal,
      }),
      enableAutonomy: () => this.goalRuntime.enableAutonomy(),
      disableAutonomy: () => this.goalRuntime.disableAutonomy(),
      autonomyStatus: () => this.goalRuntime.autonomyStatus(),
      createSession: (params, principal) => this.createSession(params, principal),
      sendSession: (params, credential) => this.sendSession(params, credential),
      cancelSession: (sessionId, credential) => this.cancelSession(sessionId, credential),
      requireSessionFor: (sessionId, credential) => this.requireSessionFor(sessionId, credential),
    });
  }

  private writeMetadata(running: boolean) {
    atomicWriteFile(this.state.daemonMetadataPath, `${JSON.stringify({
      version: 2,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      projectId: this.state.projectId,
      projectRoot: this.state.canonicalProjectRoot,
      principal: this.principal,
      pid: process.pid,
      processStart: getProcessStartIdentity(),
      socketPath: this.state.socketPath,
      brokerSocketPath: this.broker.unixSocketPath,
      extensionConfigDigest: this.loadedExtensions.digest,
      extensionAdapters: this.loadedExtensions.adapters,
      extensionProviders: this.loadedExtensions.providers,
      extensionPricing: this.loadedExtensions.pricing,
      running,
      updatedAt: Date.now(),
    })}\n`, { mode: 0o600 });
    ensureOwnerOnlyFile(this.state.daemonMetadataPath);
  }
}

function loadOrCreateToken(path: string) {
  if (!existsSync(path)) {
    try {
      writeFileSync(path, `${randomBytes(48).toString("base64url")}\n`, { mode: 0o600, flag: "wx" });
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
    }
  }
  ensureOwnerOnlyFile(path);
  const token = readFileSync(path, "utf8").trim();
  if (token.length < 32) throw new Error("Daemon token file is invalid.");
  return token;
}

function socketAcceptsConnections(path: string) {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection(path);
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}

async function waitForExecutions(executions: Set<Promise<void>>, timeoutMs: number) {
  if (executions.size === 0) return true;
  const marker = Symbol("shutdown-timeout");
  const outcome = await Promise.race([
    Promise.allSettled([...executions]),
    Bun.sleep(timeoutMs).then(() => marker),
  ]);
  return outcome !== marker;
}

async function socketBecomesAvailable(path: string) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await socketAcceptsConnections(path)) return true;
    await Bun.sleep(20);
  }
  return false;
}

function failure(
  id: string,
  error: unknown,
  fallback: Parameters<typeof toStructuredError>[1] = {},
): DaemonResponse {
  return {
    version: DAEMON_PROTOCOL_VERSION,
    id,
    ok: false,
    error: toStructuredError(error, fallback),
  };
}

function localPrincipal() {
  try {
    return `local:${userInfo().username}`;
  } catch (error) {
    recordRuntimeDiagnostic("state", "local-principal", error, "warning");
    return `local:pid-${process.pid}`;
  }
}

function gitIsAncestor(commit: string, descendant: string, cwd: string) {
  const result = runGitStrict(["merge-base", "--is-ancestor", commit, descendant], cwd);
  if (result.ok) return true;
  if (result.code === 1) return false;
  throw new Error(`Cannot verify integration journal ancestry: ${result.stderr.trim() || "git merge-base failed"}`);
}

function integrationRecoveryEvent(record: IntegrationJournalRecord, state: "applied" | "abandoned", primaryHead: string) {
  return {
    type: "finality_decision" as const,
    source: record.principal,
    runId: record.jobId,
    content: state === "applied"
      ? "Recovered a primary update from the durable integration journal."
      : "Closed a prepared integration intent that did not update primary.",
    meta: {
      phase: "startup-recovery",
      journalState: state,
      outcome: record.outcome,
      baseCommit: record.baseCommit,
      candidateCommit: record.candidateCommit,
      expectedPrimaryHead: record.expectedPrimaryHead,
      targetCommit: record.targetCommit,
      observedPrimaryHead: primaryHead,
      grantId: record.grantId,
      recovered: true,
    },
  };
}

function integrationJournalEventId(record: IntegrationJournalRecord, state: "applied" | "abandoned") {
  const bytes = Buffer.from(createHash("sha256").update(`headless-integration-journal\0${record.projectId}\0${record.jobId}\0${state}`).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function recoveredIntegrationResult(
  job: Job,
  request: SerializedRunRequest | null,
  record: IntegrationJournalRecord,
): RunResult {
  return {
    status: "succeeded",
    error: null,
    backend: job.backend,
    output: "The daemon restarted after updating primary; the durable integration journal verified and recovered the merged result.",
    stderr: "",
    diagnostics: {
      format: "daemon-recovery",
      malformedEvents: 0,
      ignoredEvents: 0,
      messages: ["Recovered from a fsynced primary-update intent; provider usage unavailable after daemon interruption."],
    },
    exitCode: null,
    signal: null,
    usage: { input: null, output: null, reasoning: null, cached: null, providerTotal: null },
    cost: { amountUsd: null, source: "unknown", pricingId: null, observedRequests: 0 },
    containment: {
      requirement: request?.containment ?? "required",
      enforced: true,
      platform: platform(),
      mechanism: "integration-journal-recovery",
      probe: "durable-primary-update-intent",
      isolatedHome: true,
      credentialsIsolated: true,
      network: "denied",
      credentialAccess: "none",
      unsafe: false,
    },
    durationMs: 0,
    sessionId: job.sessionId,
    jobId: job.id,
    diff: null,
    commit: {
      base: record.baseCommit,
      candidate: record.candidateCommit,
      result: record.targetCommit,
      merged: true,
    },
    truncation: { stdout: false, stderr: false, output: false, events: false, artifacts: false, diff: false },
  };
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function platform(): RunResult["containment"]["platform"] {
  if (process.platform === "darwin" || process.platform === "linux" || process.platform === "win32") return process.platform;
  return "other";
}

function providerForBackend(backend: string, model?: string) {
  if (backend === "claude-code" || backend === "claude") return "anthropic";
  if (backend === "codex") return "openai";
  if (backend === "grok-build" || backend === "grok") return "xai";
  const prefix = model?.split("/", 1)[0]?.toLowerCase();
  if (prefix === "google") return "gemini";
  return prefix && getProvider(prefix) ? prefix : null;
}

function parseGateChecks(value: unknown): GateCheck[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new HeadlessError("INVALID_REQUEST", "Gate checks must be an array of configured check names.");
  }
  const configured: Record<string, GateCheck> = {
    check: { name: "check", command: "bun", args: ["run", "check"] },
    build: { name: "build", command: "bun", args: ["run", "build"] },
    test: { name: "test", command: "bun", args: ["test", "tests", "--timeout", "20000"] },
    pack: { name: "pack", command: "npm", args: ["pack", "--dry-run"] },
  };
  return value.map((name) => {
    const check = configured[name];
    if (!check) throw new HeadlessError("INVALID_REQUEST", `Unknown configured gate check: ${name}`);
    return check;
  });
}
