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
import { validationErrorDetails, validationErrorMessage } from "../runtime/validation-error";
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
import { LedgerV2, ledgerIntegrityOptionsFromEnv, repairLedgerPartialTail, verifyLedgerChain } from "../runtime/ledger-v2";
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
import { getBackendDefinition, requiredContainmentSecurityGaps, resolveBackendId } from "../backends/registry";
import { backendMetadata } from "../backends/metadata";
import { BudgetSchema, type Job, type Task } from "../contracts/durable";
import type { AgentProfile, FleetProfile } from "../contracts/collaboration";
import { AuthorityStore } from "../runtime/authority-store";
import { BudgetStore } from "../runtime/budget-store";
import { FinalityStore } from "../runtime/finality-store";
import { appendEvent, getOrCreateSession } from "../runtime/session";
import { CouncilStore } from "../runtime/council-store";
import { CouncilService } from "./council-service";
import { DEFAULT_GATES, runReleaseGate, type GateCheck } from "../runtime/release-gate";
import { OrchestrationStateStore } from "../runtime/orchestration-state";
import { SkillRegistry } from "../runtime/skill-registry";
import { LoopStore } from "../runtime/loop-store";
import { LoopService } from "./loop-service";
import { listBackendDefinitions } from "../backends/registry";
import { atomicWriteFile } from "../runtime/atomic-write";
import { getProcessStartIdentity } from "../runtime/ledger-v2";
import { getHeadSha, runGitStrict } from "../runtime/git";
import { WorktreeLeaseStore } from "../runtime/worktree-leases";
import { IntegrationJournal, type IntegrationJournalRecord } from "../runtime/integration-journal";
import { WorkflowService } from "./workflow-service";
import { WorkflowDraftStore } from "../runtime/workflow-draft-store";
import {
  JobAdmissionService,
  estimateRequestResources,
} from "./job-admission-service";
import { TaskStore } from "./task-store";
import { RunEventStore } from "./run-event-store";
import { ReceiptStore } from "../runtime/receipt-store";
import type { ReceiptProvenanceContext } from "../runtime/receipt-service";
import { ExportedReceiptSchema, verifyReceipt as verifyStoredReceipt } from "../runtime/receipt-verify";
import { PersistentMessageQueue } from "../runtime/message-queue";
import { CredentialStore, type AuthenticatedCredential } from "../runtime/credential-store";
import { LeadBindingStore, leadCredentialName } from "../runtime/lead-binding";
import { migrateSingleLeadState } from "../runtime/project-state-migration";
import { assertPrincipalOwns } from "./auth";
import { RunToolEndpointManager } from "./run-tool-endpoint";
import { buildRunEvent } from "../runtime/run-event";
import { createRunToolCallHandler } from "./run-tool-operations";
import { dispatchDaemonRoute, type DaemonRouteHandlerMap } from "./route-dispatcher";
import { createDaemonRouteHandlers } from "./route-handlers";
import { optionalString, optionalTimeout, stringArray, stringParam } from "./route-params";
import { createCandidateIntegrationService } from "./candidate-service";
import { RunExecutionService } from "./run-execution-service";
import { DurableBrokerQuotaStore } from "../runtime/broker-quota-store";
import { recoverLinkedProviderHolds } from "./linked-hold-recovery";
import {
  loadDaemonExtensions,
  resolveDaemonExtensionConfig,
  type LoadedDaemonExtensions,
} from "../runtime/daemon-extensions";
import { HEADLESS_VERSION } from "../version";

const receiptBackendVersionCache = new Map<string, string | null>();
const JOB_COMPLETION_GRACE_MS = 10_000;
const TERMINAL_JOB_STATES = new Set<Job["state"]>(["succeeded", "failed", "timed_out", "cancelled", "blocked"]);

type JobWaiter = {
  callback: (job: Job) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

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
  /** Beta 1 compatibility switch. Persistent execution routes are off by default. */
  enableExperimentalSessions?: boolean;
};

export class HeadlessDaemon {
  readonly state;
  readonly principal: string;
  jobs!: JobStore;
  private token = "";
  private readonly configuredToken?: string;
  private readonly stateOptions?: ProjectStateOptions;
  private readonly waiters = new Map<string, JobWaiter[]>();
  private broker!: ProviderBroker;
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
  private receipts!: ReceiptStore;
  private ledger!: LedgerV2;
  private authority!: AuthorityStore;
  private budgets!: BudgetStore;
  private finality!: FinalityStore;
  private readonly jobAdmissionLimits: Pick<HeadlessDaemonOptions, "maxConcurrency" | "maxQueued">;
  private readonly coordinator: string;
  private councils!: CouncilStore;
  private orchestration!: OrchestrationStateStore;
  private skills!: SkillRegistry;
  private loopService!: LoopService;
  private messages!: PersistentMessageQueue;
  private credentials!: CredentialStore;
  private leads!: LeadBindingStore;
  private worktreeLeases!: WorktreeLeaseStore;
  private integrationJournal!: IntegrationJournal;
  private workflowService!: WorkflowService;
  private workflowDrafts!: WorkflowDraftStore;
  private jobAdmission!: JobAdmissionService;
  private runTools!: RunToolEndpointManager;
  private councilService!: CouncilService;
  private runExecution!: RunExecutionService;
  private readonly writeGateChecks: GateCheck[];
  private readonly extensionConfig;
  private readonly enableExperimentalSessions: boolean;
  private loadedExtensions: LoadedDaemonExtensions;
  private readonly executions = new Set<Promise<void>>();
  private stopping = false;
  private ready = false;
  private ownedStateInitialized = false;
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private routeHandlers!: DaemonRouteHandlerMap;

  constructor(options: HeadlessDaemonOptions) {
    this.state = ensureProjectStateDirectories(getProjectStatePaths(options.projectRoot, options.state));
    this.principal = (options.principal?.trim() || localPrincipal()).slice(0, 128);
    this.configuredToken = options.token;
    this.stateOptions = options.state;
    this.coordinator = options.coordinator ?? this.principal;
    this.writeGateChecks = options.writeGateChecks ?? DEFAULT_GATES;
    this.jobAdmissionLimits = { maxConcurrency: options.maxConcurrency, maxQueued: options.maxQueued };
    this.enableExperimentalSessions = options.enableExperimentalSessions === true;
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
      recoverLinkedProviderHolds({ budgets: this.budgets, broker: this.broker, jobs: this.jobs });
      this.reconcileManualLinkedRecoveries();
      this.broker.start();
      // The socket elects the local daemon; durable worktree leases additionally
      // fail closed on a live or foreign-host owner before recovery/admission.
      this.worktreeLeases.reconcile();
      await this.candidateIntegrations.reconcile();
      this.reconcileIntegrationJournal();
      this.jobs.recoverInterruptedJobs(true);
      this.reconcileTerminalRunEvents();
      this.jobAdmission.recoverBudgetReservations();
      this.reconcilePersistentSessions();
      this.reconcileSkillInvocations();
      this.reconcileTasks();
      this.ready = true;
      this.server = server;
      this.writeMetadata(true);
    } catch (error) {
      this.ready = false;
      await cleanupWithDiagnostic("daemon.start.socket-close", async () => {
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        for (const socket of this.sockets) socket.destroy();
        await closed;
        this.sockets.clear();
      });
      if (bound) await cleanupWithDiagnostic("daemon.start.socket-remove", () => { rmSync(this.state.socketPath, { force: true }); });
      await cleanupWithDiagnostic("daemon.start.run-tools-revoke", () => this.runTools?.revokeAll());
      await cleanupWithDiagnostic("daemon.start.goal-runtime-dispose", () => this.goalRuntime?.dispose());
      await cleanupWithDiagnostic("daemon.start.job-admission-dispose", () => this.jobAdmission?.dispose());
      await cleanupWithDiagnostic("daemon.start.broker-stop", () => this.broker?.stop());
      await cleanupWithDiagnostic("daemon.start.message-queue-close", () => this.messages?.close());
      this.ownedStateInitialized = false;
      throw error;
    }
    this.jobAdmission.recoverQueuedJobs();
    this.workflowService.recover();
    this.councilService.recover();
    this.goalRuntime.recover();
    this.loopService.recover();
    return this.state.socketPath;
  }

  async stop() {
    this.stopping = true;
    this.jobAdmission?.dispose();
    this.runExecution?.cancelAll("daemon stopping");
    this.drainWaiters(new HeadlessError("DAEMON_UNAVAILABLE", "Daemon is stopping before the job wait completed.", { retryable: true }));
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
      this.loopService.dispose();
      await this.goalRuntime.waitForIdle();
      this.goalRuntime.dispose();
    }
    if (this.ownedStateInitialized) await this.nativeSessions.closeAll();
    if (this.ownedStateInitialized) await this.runTools.revokeAll();
    if (this.server) {
      this.ready = false;
      const server = this.server;
      this.server = null;
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of this.sockets) socket.destroy();
      await closed;
      this.sockets.clear();
      rmSync(this.state.socketPath, { force: true });
    }
    this.broker?.stop();
    if (this.ownedStateInitialized) {
      this.messages.close();
      this.writeMetadata(false);
      this.ownedStateInitialized = false;
    }
  }

  private accept(socket: Socket) {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    socket.once("error", () => {
      this.sockets.delete(socket);
      if (!socket.destroyed) socket.destroy();
    });
    socket.setEncoding("utf8");
    let buffer = "";
    let handled = false;
    socket.on("data", (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_DAEMON_MESSAGE_BYTES) {
        handled = true;
        socket.destroy();
        return;
      }
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      const line = lines.find((candidate) => candidate.trim());
      if (!line) return;
      // The daemon protocol is deliberately one request per connection. Do
      // not dispatch pipelined lines that would race multiple half-closes.
      handled = true;
      buffer = "";
      void this.respond(socket, line);
    });
  }

  private async respond(socket: Socket, line: string) {
    let request: DaemonRequest;
    try {
      request = DaemonRequestSchema.parse(safeJsonParse(line));
    } catch (error) {
      const validation = error instanceof ZodError;
      endSocketResponse(socket, `${JSON.stringify(failure(crypto.randomUUID(), error, {
        code: "INVALID_REQUEST",
        safeMessage: validation ? validationErrorMessage(error) : messageOf(error),
        details: validation ? validationErrorDetails(error) : undefined,
      }))}\n`);
      return;
    }
    if (!this.ready) {
      endSocketResponse(socket, `${JSON.stringify(failure(request.id, new HeadlessError("DAEMON_UNAVAILABLE", "Daemon is still acquiring or releasing project ownership.", { retryable: true })))}\n`);
      return;
    }
    const credential = this.credentials.authenticate(request.token);
    if (!credential) {
      endSocketResponse(socket, `${JSON.stringify(failure(request.id, new HeadlessError("DAEMON_AUTH_FAILED", "Daemon authentication failed.")))}\n`);
      return;
    }
    if (credential.kind === "observer" && request.method !== "ping" && !request.method.startsWith("observer.")) {
      endSocketResponse(socket, `${JSON.stringify(failure(request.id, new HeadlessError("POLICY_DENIED", "Observer credentials are read-only and may only use observer operations.")))}\n`);
      return;
    }
    if (credential.kind === "integration" && credential.id.startsWith("integration:lead-")) {
      try {
        const binding = this.leads.assertCurrent(credential.principal);
        if (binding.status !== "connected" && leadMutationRequiresAttachment(request.method)) {
          throw new HeadlessError("POLICY_DENIED", "The configured foreground lead must attach before changing project state.");
        }
      } catch (error) {
        endSocketResponse(socket, `${JSON.stringify(failure(request.id, error))}\n`);
        return;
      }
    }
    if (request.method.startsWith("session.") && !this.enableExperimentalSessions) {
      endSocketResponse(socket, `${JSON.stringify(failure(
        request.id,
        new HeadlessError(
          "BACKEND_UNSUPPORTED",
          "Persistent execution sessions are experimental and disabled. Use one-shot run.submit or restart the daemon with the explicit experimental session option.",
        ),
      ))}\n`);
      return;
    }
    try {
      const result = await dispatchDaemonRoute(this.routeHandlers, request.method, request.params, credential);
      endSocketResponse(socket, `${JSON.stringify({ version: DAEMON_PROTOCOL_VERSION, id: request.id, ok: true, result } satisfies DaemonResponse)}\n`);
    } catch (error) {
      const fallback = error instanceof ZodError || error instanceof TypeError
        ? {
            code: "INVALID_REQUEST" as const,
            safeMessage: error instanceof ZodError ? validationErrorMessage(error) : messageOf(error),
            details: error instanceof ZodError ? validationErrorDetails(error) : undefined,
          }
        : { code: "INTERNAL_ERROR" as const, safeMessage: "The daemon could not complete the request." };
      endSocketResponse(socket, `${JSON.stringify(failure(request.id, error, fallback))}\n`);
    }
  }

  private fleetHealth(profile: FleetProfile) {
    const probed = profile.agents.map((agent) => ({ agent, availability: this.agentAvailability(agent) }));
    const alternatives = probed.filter(({ agent, availability }) => {
      const adapter = getBackendDefinition(resolveBackendId(agent.backend));
      return agent.enabled && availability.authenticated && availability.health === "healthy" && adapter && requiredContainmentSecurityGaps(adapter, "read-only").length === 0;
    }).map(({ agent }) => agent.id);
    const agents = probed.map(({ agent, availability }) => {
      const adapter = getBackendDefinition(resolveBackendId(agent.backend));
      const gaps = adapter ? requiredContainmentSecurityGaps(adapter, "read-only") : ["registered backend"];
      const writeGaps = adapter ? requiredContainmentSecurityGaps(adapter, "write") : ["registered backend"];
      const login = adapter && adapter.id in backendMetadata ? backendMetadata[adapter.id as keyof typeof backendMetadata].login : undefined;
      const presentation = fleetPresentation(
        agent,
        availability,
        gaps,
        writeGaps,
        alternatives.filter((id) => id !== agent.id),
        this.state.canonicalProjectRoot,
        login,
      );
      return { agent, ...availability, executable: adapter?.probe.versionCommand[0] ?? null, detail: presentation.reason, presentation };
    });
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
    try {
      const adapter = getBackendDefinition(resolveBackendId(agent.backend));
      executable = !!adapter && (
        Bun.which(adapter.probe.versionCommand[0]) !== null
        || (adapter.managedExecutable?.(this.stateOptions?.homeDir) ?? null) !== null
      );
    } catch (error) {
      recordRuntimeDiagnostic("transport", "fleet-agent-probe", error, "warning");
      executable = false;
    }
    let authenticated = false;
    let trustRequired = false;
    if (executable) {
      if (security.authMode === "native-login") {
        const trust = this.trust.status();
        trustRequired = !trust.trusted
          || !trust.nativeLoginAllowed
          || !trust.nativeDirectUnrestrictedAcknowledged
          || (security.approvalPolicy === "bypass" && !trust.bypassAllowed);
        if (!trustRequired) {
          const worker = createWorkerEnvironment();
          try {
            authenticated = installNativeAuthCapsule(worker, resolveBackendId(agent.backend)).available;
          } catch (error) {
            console.error(redactAndTruncate(`Native fleet auth probe failed for ${agent.id}: ${messageOf(error)}`, 2_048).text);
          } finally {
            worker.cleanup();
          }
        }
      } else {
        const provider = providerForBackend(agent.backend, agent.model);
        const definition = provider ? getProvider(provider) : null;
        authenticated = getBackendDefinition(resolveBackendId(agent.backend))?.security.strictAuth === "credential-free"
          || (!!definition && !!process.env[definition.credentialEnv]);
      }
    }
    const sessions = this.sessions.list().filter((session) => session.backend === resolveBackendId(agent.backend));
    const rateLimitedUntil = sessions.reduce<number | null>((latest, session) => {
      const rate = session.native?.rateLimit;
      if (!rate?.limited || rate.retryAfterMs === null || rate.detectedAt === null) return latest;
      const until = rate.detectedAt + rate.retryAfterMs;
      return latest === null || until > latest ? until : latest;
    }, null);
    const recent = this.jobs.list().filter((job) => job.backend === resolveBackendId(agent.backend)).slice(-20);
    const recentFailures = recent.filter((job) => job.state === "failed" || job.state === "timed_out").length;
    const activeTurns = sessions.filter((session) => session.state === "running" || session.state === "cancelling").length;
    const adapter = executable ? getBackendDefinition(resolveBackendId(agent.backend)) : null;
    const containmentReady = !!adapter && requiredContainmentSecurityGaps(adapter, security.mode ?? "read-only").length === 0;
    const health: GoalAgentAvailability["health"] = !executable
      ? "offline"
      : !authenticated || !containmentReady ? "unhealthy" : rateLimitedUntil !== null && rateLimitedUntil > Date.now() ? "degraded" : "healthy";
    return { authenticated, trustRequired, health, rateLimitedUntil, activeTurns, recentFailures };
  }

  private wait(jobId: string, timeoutMs = 180_000): Promise<Job> {
    const job = this.requireJob(jobId);
    if (TERMINAL_JOB_STATES.has(job.state)) return Promise.resolve(job);
    return new Promise<Job>((resolve, reject) => {
      let settled = false;
      const settle = (completed?: Job, error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(waiter.timer);
        this.removeWaiter(jobId, waiter);
        if (completed) resolve(completed);
        else reject(error);
      };
      const waiter: JobWaiter = {
        callback: (completed) => settle(completed),
        reject: (error) => settle(undefined, error),
        timer: setTimeout(() => {
          const current = this.jobs.get(jobId);
          if (current && TERMINAL_JOB_STATES.has(current.state)) {
            this.reconcileSessionCompletion(current);
            this.reconcileSkillCompletion(current);
            settle(current);
            return;
          }
          settle(undefined, new HeadlessError("TIMED_OUT", "Timed out waiting for the daemon job."));
        }, timeoutMs),
      };
      const waiting = this.waiters.get(jobId) ?? [];
      waiting.push(waiter);
      this.waiters.set(jobId, waiting);
    });
  }

  private removeWaiter(jobId: string, waiter: JobWaiter) {
    const active = this.waiters.get(jobId);
    if (!active) return;
    const index = active.indexOf(waiter);
    if (index >= 0) active.splice(index, 1);
    if (active.length === 0) this.waiters.delete(jobId);
  }

  private drainWaiters(error: unknown) {
    for (const waiting of [...this.waiters.values()]) {
      for (const waiter of [...waiting]) waiter.reject(error);
    }
    this.waiters.clear();
  }

  private completionWatchTimeout(jobId: string) {
    return (this.jobs.request(jobId)?.timeoutMs ?? 180_000) + JOB_COMPLETION_GRACE_MS;
  }

  private watchSessionCompletion(sessionId: string, jobId: string) {
    const current = this.jobs.get(jobId);
    if (current && TERMINAL_JOB_STATES.has(current.state)) this.reconcileSessionCompletion(current);
    void this.wait(jobId, this.completionWatchTimeout(jobId)).catch((error) => {
      const latest = this.jobs.get(jobId);
      if (latest && TERMINAL_JOB_STATES.has(latest.state)) {
        this.reconcileSessionCompletion(latest);
        return;
      }
      if (!this.stopping && latest) this.jobAdmission.cancel(jobId);
      if (this.stopping) return;
      const detail = redactAndTruncate(`Persistent session completion guard expired: ${messageOf(error)}`, 2_048).text;
      try {
        this.runEvents.append({ jobId, sessionId }, {
          kind: "policy",
          decision: "deferred",
          rule: "session-completion-recovery",
          reason: detail,
        });
      } catch (diagnosticError) {
        console.error(redactAndTruncate(`Unable to persist session recovery diagnostic: ${messageOf(diagnosticError)}`, 2_048).text);
      }
    });
  }

  private watchSkillCompletion(auditId: string, jobId: string, principal: string) {
    this.skills.markInvocationPending(auditId, jobId);
    const current = this.jobs.get(jobId);
    if (current && TERMINAL_JOB_STATES.has(current.state)) this.reconcileSkillCompletion(current);
    void this.wait(jobId, this.completionWatchTimeout(jobId)).catch((error) => {
      const latest = this.jobs.get(jobId);
      if (latest && TERMINAL_JOB_STATES.has(latest.state)) {
        this.reconcileSkillCompletion(latest);
        return;
      }
      if (!this.stopping && latest) this.jobAdmission.cancel(jobId);
      if (!this.stopping) {
        this.recordSkillAudit("portable_skill_completion_deferred", principal, {
          auditId,
          jobId,
          reason: messageOf(error),
        });
      }
    });
  }

  private reconcileSessionCompletion(job: Job) {
    if (!job.result || !job.sessionId || !TERMINAL_JOB_STATES.has(job.state)) return;
    const session = this.sessions.get(job.sessionId);
    if (!session || session.lastJobId !== job.id || (session.state !== "running" && session.state !== "cancelling")) return;
    this.sessions.complete(session.id, job.result);
  }

  private reconcileSkillCompletion(job: Job) {
    if (!job.result || !TERMINAL_JOB_STATES.has(job.state)) return;
    for (const pending of this.skills.pendingInvocations().filter((entry) => entry.jobId === job.id)) {
      this.skills.completeJobInvocation(pending.auditId, job);
      this.recordSkillAudit("portable_skill_completed", pending.principal, { auditId: pending.auditId, jobId: job.id, status: job.state });
    }
  }

  private reconcileSkillInvocations() {
    for (const pending of this.skills.pendingInvocations()) {
      const job = this.jobs.get(pending.jobId);
      if (!job) {
        this.skills.failPendingInvocation(pending.auditId, "Skill invocation job is missing during daemon recovery.");
        this.recordSkillAudit("portable_skill_completed", pending.principal, { auditId: pending.auditId, jobId: pending.jobId, status: "failed" });
        continue;
      }
      if (TERMINAL_JOB_STATES.has(job.state)) this.reconcileSkillCompletion(job);
    }
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
    const backend = resolveBackendId(stringParam(params, "backend"));
    const adapter = getBackendDefinition(backend);
    const requestedAgent = optionalString(params.agent);
    const agent = requestedAgent ? safeAgentName(requestedAgent, backend) : undefined;
    if (agent && !adapter?.supportsNamedAgent) {
      throw new HeadlessError("BACKEND_UNSUPPORTED", `Backend ${backend} does not support named agents in contained Headless sessions.`);
    }
    const authMode = params.authMode === "native-login" ? "native-login" : "broker";
    const approvalPolicy = params.approvalPolicy === "auto" || params.approvalPolicy === "bypass" ? params.approvalPolicy : "ask";
    if (authMode === "native-login" && adapter?.security.strictAuth !== "credential-free") {
      const trust = this.trust.status();
      if (!trust.trusted || !trust.nativeLoginAllowed || !trust.nativeDirectUnrestrictedAcknowledged || (approvalPolicy === "bypass" && !trust.bypassAllowed)) {
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
    this.watchSessionCompletion(session.id, job.id);
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

  private useSkill(params: Record<string, unknown>, credential: AuthenticatedCredential) {
    const backend = optionalString(params.backend);
    if (!backend) throw new HeadlessError("INVALID_REQUEST", "Skill use requires an explicit backend.");
    const invocation = this.skills.invocation(stringParam(params, "skill"), String(params.arguments ?? ""), credential.principal, [backend]);
    this.recordSkillAudit("portable_skill_invoked", credential.principal, { auditId: invocation.auditId, skillId: invocation.skill.id, version: invocation.skill.version, contentHash: invocation.skill.contentHash, receivers: [backend] });
    const session = this.createSession({ backend, containment: "required", approvalPolicy: "ask" }, credential.principal);
    const response = this.sendSession({ sessionId: session.id, prompt: invocation.prompt, timeoutMs: params.timeoutMs }, credential);
    this.recordSkillCompletion(invocation.auditId, response.job.id, credential.principal);
    return response;
  }

  private recordSkillCompletion(auditId: string, jobId: string, principal: string) {
    this.watchSkillCompletion(auditId, jobId, principal);
  }

  private recordSkillAudit(type: string, principal: string, payload: Record<string, unknown>) {
    try {
      const session = getOrCreateSession({ cwd: this.state.canonicalProjectRoot, state: this.stateOptions, authenticatedPrincipal: principal });
      appendEvent(session, { type: "note", source: principal, content: `${type}: ${redactAndTruncate(JSON.stringify(payload), 16_384).text}`, meta: { eventType: type, ...payload } });
    } catch (error) {
      recordRuntimeDiagnostic("state", "skill-audit", error, "error");
    }
  }

  private assertRequestedSessionOwnership(params: Record<string, unknown>, credential: AuthenticatedCredential) {
    const sessionId = optionalString(params.sessionId);
    if (!sessionId) return;
    const session = this.sessions.get(sessionId);
    if (session) assertPrincipalOwns(credential, session.principal, "Session");
  }

  private resolveWaiters(job: Job) {
    this.reconcileSessionCompletion(job);
    this.reconcileSkillCompletion(job);
    for (const waiter of [...(this.waiters.get(job.id) ?? [])]) waiter.callback(job);
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
      if (job) this.reconcileSessionCompletion(job);
    }
  }

  private reconcileTerminalRunEvents() {
    for (const job of this.jobs.list()) {
      if (!job.result || !TERMINAL_JOB_STATES.has(job.state)) continue;
      try {
        this.runEvents.reconcileTerminal(
          { jobId: job.id, sessionId: job.sessionId },
          job.result,
          job.updatedAt,
        );
      } catch (error) {
        recordRuntimeDiagnostic("state", `daemon.start.terminal-events:${job.id}`, error);
      }
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
      if (!job.result || !TERMINAL_JOB_STATES.has(job.state)) continue;
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
    migrateSingleLeadState(this.state);
    const brokerQuotas = new DurableBrokerQuotaStore(this.state);
    this.broker = new ProviderBroker({
      unixSocketPath: join(this.state.daemonRuntimeDir, `${this.state.projectId.slice(0, 16)}-${process.pid}-${randomBytes(4).toString("hex")}.broker.sock`),
      initialBudgetQuotas: brokerQuotas.snapshot(),
      persistBudgetQuota: (quota, expiresAt) => brokerQuotas.update(quota, expiresAt),
      initialLinkedOperations: brokerQuotas.linkedSnapshot(),
      persistLinkedOperation: (operation) => brokerQuotas.updateLinkedOperation(operation),
      warning: (message) => {
        const bounded = redactAndTruncate(message, 2_048).text;
        console.warn(bounded);
        recordRuntimeDiagnostic("state", "broker.pricing-registry", bounded, "warning");
      },
    });
    this.jobs = new JobStore(this.state.jobsDir);
    this.tasks = new TaskStore(this.state.tasksDir, { recoverOnOpen: false });
    this.runEvents = new RunEventStore(this.state.runEventsPath, { compactOnOpen: false });
    this.ledger = new LedgerV2({
      ledgerPath: this.state.ledgerPath,
      readModelPath: this.state.readModelPath,
      projectId: this.state.projectId,
      principal: this.principal,
      ...ledgerIntegrityOptionsFromEnv(this.stateOptions?.env ?? process.env),
    });
    this.receipts = new ReceiptStore(this.state.receiptsDir);
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
        agents: listBackendDefinitions().map((adapter) => ({
          id: adapter.id,
          backend: adapter.id,
          name: adapter.id,
          priority: adapter.fleetPriority ?? 0,
          capabilities: [
            "read",
            ...(adapter.capabilities.write ? ["write"] : []),
            ...(adapter.capabilities.tools ? ["tools"] : []),
            ...(adapter.capabilities.nativeResume ? ["native-resume"] : []),
          ],
        })),
      });
    }
    this.credentials = new CredentialStore(this.state, { token: this.token, principal: this.principal });
    this.leads = new LeadBindingStore(this.state);
    this.credentials.revokeLegacyIntegrations(this.credentials.authenticate(this.token)!);
    this.goals = new GoalStore(this.state);
    this.approvals = new ApprovalStore(this.state, { expiryActor: this.principal });
    this.directedMailbox = new DirectedMailbox({ statePath: join(this.state.projectDir, "directed-mailbox.json") });
    this.authority = new AuthorityStore(this.state, {
      rootPrincipal: this.coordinator,
      foregroundLead: () => this.leads.status()?.integrationPrincipal ?? null,
    });
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
      sessions: this.sessions,
      trust: this.trust,
      authority: this.authority,
      budgets: this.budgets,
      broker: this.broker,
      activeLeadBackend: () => this.leads.status()?.backendId ?? null,
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
      auditDelegation: (type, parent, child, metadata) => {
        const session = getOrCreateSession({
          cwd: this.state.canonicalProjectRoot,
          state: this.stateOptions,
          authenticatedPrincipal: parent.principal,
          sessionId: parent.sessionId ?? parent.id,
        });
        appendEvent(session, {
          type,
          source: parent.principal,
          runId: parent.id,
          workerId: child.id,
          content: type === "worker_spawned" ? `Delegated child ${child.id} admitted.` : `Delegated child ${child.id} completed as ${child.state}.`,
          meta: metadata,
        });
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
      resolveBackend: resolveBackendId,
      getBackend: (backend) => getBackendDefinition(backend) ?? null,
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
    this.skills = new SkillRegistry(this.state);
    this.messages = new PersistentMessageQueue(join(this.state.projectDir, "message-queue.sqlite"));
    this.worktreeLeases = new WorktreeLeaseStore(this.state.worktreesDir, this.state.projectId, {
      // Bun and Git inspect checkout ancestors. Keeping executable worktrees
      // beneath the short owner-only runtime root avoids macOS TCC-protected
      // ~/Library ancestors while durable lease manifests remain in state.
      checkoutBase: join(this.state.daemonRuntimeDir, "worktrees", this.state.projectId),
    });
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
    this.workflowDrafts = new WorkflowDraftStore(this.state);
    this.runTools = new RunToolEndpointManager({
      socketDir: this.state.daemonRuntimeDir,
      handle: createRunToolCallHandler({
        projectRoot: this.state.canonicalProjectRoot,
        state: this.stateOptions,
        getJob: (jobId) => this.jobs.get(jobId),
        getTask: (jobId) => this.taskForJob(jobId),
        messages: this.messages,
        delegate: async (scope, requestId, params) => {
          let childJobId: string | null = null;
          try {
            const admitted = this.jobAdmission.admitDelegation({
              parentJobId: scope.jobId,
              requestId,
              backend: params.backend as string,
              prompt: params.prompt as string,
              model: params.model as string | undefined,
              agent: params.agent as string | undefined,
              timeoutMs: params.timeoutMs as number | undefined,
              budgetFraction: params.budgetFraction as number,
            });
            childJobId = admitted.job.id;
            const request = this.jobs.request(admitted.job.id);
            if (!request) throw new HeadlessError("INTERNAL_ERROR", "Delegated child request is unavailable.");
            const child = await this.wait(admitted.job.id, request.timeoutMs + 10_000);
            await this.jobAdmission.settleDelegation(child);
            if (!child.result) throw new HeadlessError("INTERNAL_ERROR", "Delegated child completed without a result.");
            const completion = buildRunEvent(
              { jobId: child.id, sessionId: child.sessionId, sequence: 0 },
              { kind: "completion", result: child.result },
            );
            if (completion.kind !== "completion") throw new HeadlessError("INTERNAL_ERROR", "Delegated child projection produced the wrong event kind.");
            const projected = completion.result;
            return projected.status === "succeeded"
              ? { ok: true, childJobId: child.id, result: projected }
              : { ok: false, childJobId: child.id, error: projected.error ?? toStructuredError(new HeadlessError("INTERNAL_ERROR", "Delegated child failed without a structured error.")), result: projected };
          } catch (error) {
            return { ok: false, childJobId, error: toStructuredError(error) };
          }
        },
      }),
    });
    this.runExecution = new RunExecutionService({
      paths: this.state,
      stateOptions: this.stateOptions,
      jobs: this.jobs,
      tasks: this.tasks,
      runEvents: this.runEvents,
      receipts: this.receipts,
      receiptProvenance: receiptProvenanceContext(
        this.state.canonicalProjectRoot,
        this.stateOptions?.env ?? process.env,
      ),
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
      activeLeadBackend: () => this.leads.status()?.backendId ?? null,
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
    this.loopService = new LoopService({
      store: new LoopStore(this.state),
      startGoal: (target, principal, workId) => {
        const existing = this.goals.get(workId);
        if (existing) return { id: existing.goal.id };
        return { id: this.goalRuntime.coordinator.start({ id: workId, principal, objective: target.objective, mode: target.mode, fleetProfileId: target.fleetProfileId, autonomous: false }).goal.id };
      },
      goalStatus: (id) => {
        const record = this.goals.get(id);
        if (!record) throw new HeadlessError("INVALID_REQUEST", `Loop goal disappeared: ${id}`);
        return { state: record.goal.state, terminal: record.result !== null, succeeded: record.goal.state === "succeeded" };
      },
      startWorkflow: (definition, principal, workId) => {
        const existing = this.workflowService.store.get(workId);
        if (existing) return { id: existing.id };
        return { id: this.workflowService.create({ ...definition, id: workId }, internalCredential(principal)).id };
      },
      workflowStatus: (id) => {
        const workflow = this.workflowService.store.get(id);
        if (!workflow) throw new HeadlessError("INVALID_REQUEST", `Loop workflow disappeared: ${id}`);
        return { state: workflow.state, terminal: ["succeeded", "failed", "blocked", "cancelled"].includes(workflow.state), succeeded: workflow.state === "succeeded" };
      },
      cancelGoal: (id, principal) => this.goalRuntime.cancelGoalAs(id, principal),
      cancelWorkflow: (id) => this.workflowService.cancel(id),
    });
    this.initializeRouteHandlers();
    this.ownedStateInitialized = true;
  }

  private reconcileManualLinkedRecoveries() {
    for (const marker of this.budgets.manualRecoveryMarkers()) {
      const operations = this.broker.linkedOperationSnapshot(marker.linkId);
      if (operations.target?.kind === "target" && operations.target.phase !== "prepared") {
        this.broker.revokeLinkedTarget(marker.linkId);
      }
      if (operations.parent?.kind === "parent") {
        this.broker.recoverLinkedParentSettlement(marker.linkId, marker.parentUnused);
      }
      this.runEvents.appendIdempotent({ jobId: marker.parentJobId }, {
        kind: "policy",
        decision: "allowed",
        rule: "linked-hold-manual-recovery",
        reason: JSON.stringify({
          linkId: marker.linkId,
          recordDigest: marker.recordDigest,
          actor: marker.actor,
          resolution: marker.resolution,
          affectedReservationIds: marker.affectedReservationIds,
          affectedBudgetIds: marker.affectedBudgetIds,
          quotaOutcome: marker.resolution === "exhaust" ? "exhausted" : "released",
        }),
      }, marker.auditEventId, marker.decidedAt);
      this.budgets.markManualRecoveryAudited(marker.linkId, marker.auditEventId);
    }
  }

  private initializeRouteHandlers() {
    this.routeHandlers = createDaemonRouteHandlers({
      projectId: this.state.projectId,
      projectRoot: this.state.canonicalProjectRoot,
      experimentalSessionsEnabled: this.enableExperimentalSessions,
      stateOptions: this.stateOptions,
      extensionInfo: () => ({
        digest: this.loadedExtensions.digest,
        adapters: this.loadedExtensions.adapters,
        providers: this.loadedExtensions.providers,
        pricing: this.loadedExtensions.pricing,
      }),
      leads: this.leads,
      useLead: (host, credential) => this.useLead(host, credential),
      releaseLead: (credential) => this.releaseLead(credential),
      provisionObserver: (credential) => this.credentials.provisionObserver(credential),
      observerSnapshot: () => this.observerSnapshot(),
      observerEvents: (params) => this.runEvents.snapshot(params),
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
      pauseWorkflow: (workflowId) => this.workflowService.pause(workflowId),
      resumeWorkflow: (workflowId) => this.workflowService.resume(workflowId),
      validateWorkflow: (params, credential) => this.workflowService.validate(params, credential),
      createWorkflowDraft: (params, credential) => {
        const validated = this.workflowService.validate(params, credential);
        return this.workflowDrafts.create(validated.parsed, credential.principal);
      },
      listWorkflowDrafts: (credential) => this.workflowDrafts.list().filter((draft) => credential.scopes.includes("admin") || draft.principal === credential.principal),
      getWorkflowDraft: (draftId, credential) => {
        const draft = this.workflowDrafts.get(draftId);
        if (!draft) throw new HeadlessError("INVALID_REQUEST", `Unknown workflow draft: ${draftId}`);
        assertPrincipalOwns(credential, draft.principal, "Workflow draft"); return draft;
      },
      launchWorkflowDraft: (draftId, credential) => {
        const draft = this.workflowDrafts.get(draftId);
        if (!draft) throw new HeadlessError("INVALID_REQUEST", `Unknown workflow draft: ${draftId}`);
        assertPrincipalOwns(credential, draft.principal, "Workflow draft");
        if (draft.state !== "draft") throw new HeadlessError("INVALID_REQUEST", "Workflow draft was already launched.");
        const workflow = this.workflowService.create(draft.definition, credential);
        return { draft: this.workflowDrafts.launched(draft.id, workflow.id), workflow };
      },
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
      listSkills: () => this.skills.list(),
      inspectSkill: (skill) => this.skills.inspect(skill),
      importSkill: (source, actor) => this.skills.import(source, actor),
      enableSkill: (skill, actor) => this.skills.enable(skill, actor),
      useSkill: (params, credential) => this.useSkill(params, credential),
      revokeSkill: (skill) => this.skills.revoke(skill),
      startLoop: (policy, credential) => this.loopService.start(policy, credential.principal),
      listLoops: (credential) => this.loopService.store.list().filter((loop) => credential.scopes.includes("admin") || loop.principal === credential.principal),
      statusLoop: (loopId, credential) => {
        const loop = this.loopService.store.get(loopId);
        if (!loop) throw new HeadlessError("INVALID_REQUEST", `Unknown loop: ${loopId}`);
        assertPrincipalOwns(credential, loop.principal, "Loop"); return loop;
      },
      pauseLoop: (loopId, credential) => this.loopService.pause(loopId, credential.principal),
      resumeLoop: (loopId, credential) => this.loopService.resume(loopId, credential.principal),
      cancelLoop: (loopId, credential) => this.loopService.cancel(loopId, credential.principal),
      verifyLedger: (evidence) => verifyLedgerChain({
        ledgerPath: this.state.ledgerPath,
        projectId: this.state.projectId,
        ...ledgerIntegrityOptionsFromEnv(this.stateOptions?.env ?? process.env),
        ...(evidence ? { evidenceRoot: this.state.canonicalProjectRoot } : {}),
      }),
      repairLedgerTail: (principal) => repairLedgerPartialTail({
        ledgerPath: this.state.ledgerPath,
        readModelPath: this.state.readModelPath,
        projectId: this.state.projectId,
        principal,
        ...ledgerIntegrityOptionsFromEnv(this.stateOptions?.env ?? process.env),
      }),
      getReceipt: (runId) => this.receipts.get(runId),
      listReceipts: (opts) => this.receipts.list(opts),
      verifyReceipt: (runId) => {
        const receipt = this.receipts.get(runId);
        if (!receipt) throw new HeadlessError("INVALID_REQUEST", `Unknown receipt: ${runId}`);
        return verifyStoredReceipt({
          receipt,
          records: this.ledger.readAllForVerification(),
          ...ledgerIntegrityOptionsFromEnv(this.stateOptions?.env ?? process.env),
        });
      },
      exportReceipt: (runId) => {
        const receipt = this.receipts.get(runId);
        if (!receipt) throw new HeadlessError("INVALID_REQUEST", `Unknown receipt: ${runId}`);
        const records = this.ledger.readAllForVerification();
        const anchorRecord = records.find((record) => record.sequence === receipt.integrity.ledgerAnchor.sequence);
        if (!anchorRecord) {
          throw new HeadlessError("INVALID_REQUEST", `Receipt anchor record ${receipt.integrity.ledgerAnchor.sequence} is missing for run ${runId}.`);
        }
        const verdict = verifyLedgerChain({ records, projectId: this.state.projectId, ...ledgerIntegrityOptionsFromEnv(this.stateOptions?.env ?? process.env) });
        const ledgerHead = verdict.head ?? { sequence: anchorRecord.sequence, hash: anchorRecord.hash };
        return ExportedReceiptSchema.parse({
          receipt,
          anchorRecord,
          exportEnvelope: {
            exportedAt: new Date().toISOString(),
            exporterVersion: HEADLESS_VERSION,
            ledgerHead: { sequence: ledgerHead.sequence, hash: ledgerHead.hash },
          },
        });
      },
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

  private useLead(host: string, credential: AuthenticatedCredential) {
    const backendId = resolveBackendId(host);
    const generation = this.leads.nextGeneration();
    const provisioned = this.credentials.provisionIntegration(credential, leadCredentialName(host, generation));
    const previous = this.leads.status();
    const binding = this.leads.use({
      host,
      backendId,
      integrationPrincipal: provisioned.credential.principal,
      generation,
    });
    if (previous) this.credentials.revoke(credential, previous.integrationPrincipal);
    return { binding, credentialId: provisioned.credential.id, tokenPath: provisioned.tokenPath };
  }

  private releaseLead(credential: AuthenticatedCredential) {
    const previous = this.leads.release();
    if (previous) this.credentials.revoke(credential, previous.integrationPrincipal);
    return { released: previous, binding: null };
  }

  private observerSnapshot() {
    const fleetState = this.fleets.snapshot();
    const goals = this.goals.listRecords();
    const jobs = this.jobs.list();
    return {
      version: 1,
      projectId: this.state.projectId,
      projectRoot: this.state.canonicalProjectRoot,
      observedAt: Date.now(),
      lead: this.leads.status(),
      projectTrust: this.trust.status(),
      fleetProfiles: this.fleets.list(),
      activeFleetProfileId: fleetState.activeProfileId,
      fleetHealth: this.fleets.getActive() ? this.fleetHealth(this.fleets.getActive()!) : null,
      goals: goals.map((record) => record.goal),
      goalTurns: Object.fromEntries(goals.map((record) => [record.goal.id, record.turns])),
      goalMessages: Object.fromEntries(goals.map((record) => [record.goal.id, this.directedMailbox.snapshot().messages.filter((message) => message.collaborationId === record.goal.id)])),
      approvals: this.approvals.list({}),
      budgets: this.budgets.getState().budgets,
      jobs,
      delegations: jobs.flatMap((job) => {
        if (!job.delegationOf) return [];
        const request = this.jobs.request(job.id);
        return [{
          parentJobId: job.delegationOf.parentJobId,
          childJobId: job.id,
          requestId: job.delegationOf.requestId,
          backend: job.backend,
          state: job.state,
          createdAt: job.createdAt,
          deadlineAt: request ? job.createdAt + request.timeoutMs : null,
          budgetFraction: job.delegationOf.budgetFraction,
          usage: job.result?.usage ?? null,
          cost: job.result?.cost ?? null,
          error: job.result?.error ?? null,
        }];
      }),
      tasks: this.tasks.list(),
      sessions: this.sessions.list(),
      orchestration: this.goalRuntime.autonomyStatus(),
    };
  }
}

function leadMutationRequiresAttachment(method: DaemonRequest["method"]) {
  return !new Set<DaemonRequest["method"]>([
    "ping",
    "lead.status",
    "lead.attach",
    "lead.heartbeat",
    "lead.disconnect",
    "project.trust.status",
    "fleet.profile.get",
    "fleet.profile.list",
    "fleet.health",
    "goal.status",
    "goal.list",
    "goal.result",
    "collaboration.turns",
    "collaboration.messages",
    "approval.list",
    "candidate.inspect",
    "authority.grant.list",
    "budget.list",
    "run.status",
    "events.snapshot",
    "events.wait",
    "task.status",
    "task.list",
    "ledger.context",
    "ledger.task",
    "receipt.get",
    "receipt.list",
    "receipt.verify",
    "receipt.export",
    "messages.pull",
    "council.status",
    "workflow.status",
    "workflow.list",
    "workflow.wait",
    "workflow.validate",
    "workflow.draft.list",
    "workflow.draft.get",
    "orchestrator.status",
    "session.status",
    "session.result",
    "skill.list",
    "skill.inspect",
    "loop.list",
    "loop.status",
  ]).has(method);
}

function internalCredential(principal: string): AuthenticatedCredential {
  return {
    id: "headless-loop-service", principal, kind: "root",
    scopes: ["admin", "run", "task", "ledger:read", "ledger:write", "messages", "council", "gate", "orchestrator", "session"],
    createdAt: Date.now(), expiresAt: null, revokedAt: null,
  };
}

function fleetPresentation(
  agent: AgentProfile,
  availability: GoalAgentAvailability,
  containmentGaps: string[],
  writeContainmentGaps: string[],
  alternatives: string[],
  projectRoot: string,
  login?: { argv?: [string, ...string[]]; instructions: string; brokerMode: boolean },
) {
  const common = { alternatives, brokerAvailable: login?.brokerMode ?? false, credentialForm: "supported provider CLI regular-file login state", loginCommand: login?.argv ?? null, loginInstructions: login?.instructions ?? null };
  if (!agent.enabled) return { code: "disabled", reason: "Agent is disabled in the active fleet profile.", recovery: "Enable the agent or activate another fleet profile.", ...common };
  if (containmentGaps.length) return { code: "blocked_by_containment", reason: `Required project-safety controls are unsupported: ${containmentGaps.join(", ")}.`, recovery: "Exclude this provider from required runs or select a compatible alternative; containment cannot be unblocked from the TUI.", ...common };
  if (availability.rateLimitedUntil && availability.rateLimitedUntil > Date.now()) return { code: "rate_limited", reason: `Provider retry is unavailable until ${new Date(availability.rateLimitedUntil).toISOString()}.`, recovery: "Wait until the retry time or reassign work to an available alternative.", retryAt: availability.rateLimitedUntil, ...common };
  if (availability.trustRequired) {
    const bypass = agent.approvalPolicy === "bypass" ? " --allow-bypass" : "";
    return {
      code: "trust_required",
      reason: "Project trust with native acknowledgement is not granted.",
      recovery: `headless project trust grant --allow-native-direct-unrestricted${bypass} --cwd ${JSON.stringify(projectRoot)}`,
      ...common,
    };
  }
  if (!availability.authenticated) return { code: "login_required", reason: "Supported provider login state was not found.", recovery: login?.instructions ?? "Run the provider's declared login flow, then refresh Fleet health.", ...common };
  if (availability.health === "offline") return { code: "provider_unavailable", reason: "Provider executable is unavailable on PATH.", recovery: "Install or restore the declared provider CLI, inspect Events, then refresh health.", ...common };
  if (availability.health !== "healthy") return { code: "provider_unavailable", reason: "Provider health checks did not report ready.", recovery: "Retry health, inspect Events, or reassign to an available alternative.", ...common };
  if (writeContainmentGaps.length) return { code: "ready", reason: "Ready for read-only planning, worker, and review roles. Direct candidate writes use another compatible provider.", recovery: "Assign read-only fleet work; keep writable leadership and candidate turns on a compatible provider.", writeCapable: false, ...common };
  return { code: "ready", reason: "Provider is authenticated and satisfies required project-safety controls.", recovery: "Start a session, make it the future lead, or assign work.", ...common };
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

function endSocketResponse(socket: Socket, response: string) {
  if (socket.destroyed || socket.writableEnded) return;
  socket.end(response);
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

/** Resolve immutable process/toolchain provenance once while the daemon owns state. */
function receiptProvenanceContext(projectRoot: string, env: NodeJS.ProcessEnv): ReceiptProvenanceContext {
  const configuredCommit = env.HEADLESS_COMMIT?.trim();
  const commit = configuredCommit && /^[a-f0-9]{40,64}$/.test(configuredCommit)
    ? configuredCommit
    : getHeadSha(projectRoot);
  const backendVersions: Record<string, string | null> = {};
  for (const adapter of listBackendDefinitions()) {
    // A daemon process loads one definition per backend id. Keying by the
    // declared command (not each project's PATH string) prevents repeated CLI
    // probes across daemon instances while still separating replacements.
    const key = JSON.stringify([adapter.id, adapter.probe.versionCommand]);
    let version = receiptBackendVersionCache.get(key);
    if (version === undefined && !receiptBackendVersionCache.has(key)) {
      version = probeReceiptBackendVersion(adapter.probe.versionCommand, adapter.probe.timeoutMs, projectRoot, env);
      receiptBackendVersionCache.set(key, version);
    }
    backendVersions[adapter.id] = version ?? null;
  }
  return {
    headlessVersion: HEADLESS_VERSION,
    platform: `${process.platform}-${process.arch}`,
    commit: commit && /^[a-f0-9]{40,64}$/.test(commit) ? commit : null,
    backendVersions,
  };
}

function probeReceiptBackendVersion(
  command: readonly string[],
  timeoutMs: number,
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  try {
    const result = Bun.spawnSync([...command], {
      cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: Math.min(timeoutMs, 5_000),
    });
    if (result.exitCode !== 0) return null;
    const raw = result.stdout.toString("utf8").trim() || result.stderr.toString("utf8").trim();
    if (!raw) return null;
    return redactAndTruncate(raw.split(/\r?\n/, 1)[0] ?? raw, 256).text;
  } catch (error) {
    recordRuntimeDiagnostic("state", "receipt.backend-version", error, "warning");
    return null;
  }
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function platform(): RunResult["containment"]["platform"] {
  if (process.platform === "darwin" || process.platform === "linux" || process.platform === "win32") return process.platform;
  return "other";
}

function providerForBackend(backend: string, model?: string) {
  try {
    const provider = getBackendDefinition(resolveBackendId(backend))?.provider;
    if (provider) return provider;
  } catch {}
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
