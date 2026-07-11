import {
  BaseSessionDriver,
  type BaseSessionDriverOptions,
  type OpenSessionResult,
  type SessionDriverRuntime,
} from "./base";
import { SessionEventAssembler } from "./event-assembler";
import type { SessionEventDecoder } from "./event-decoder";
import type { SessionExecutor, SessionExecutionRequest } from "./executor";
import { SessionDriverError } from "./errors";
import { commandEnvironment, parseCliVersion, sessionTimeout } from "./options";
import type {
  SessionBackend,
  SessionDriverCapabilities,
  SessionDriverKind,
  SessionDriverProbe,
  SessionProbeInput,
} from "./types";

export type CommandDriverDefinition = {
  backend: SessionBackend;
  kind: SessionDriverKind;
  binary: string;
  capabilities: SessionDriverCapabilities;
  versionArgs: string[];
  helpArgs: string[];
  requiredHelpFragments: string[];
  decoder: SessionEventDecoder;
  initialNativeSessionId?: (runtime: SessionDriverRuntime) => string | null;
  buildInitial: (
    runtime: SessionDriverRuntime,
    prompt: string,
  ) => Omit<SessionExecutionRequest, "cwd" | "env" | "timeoutMs" | "signal">;
  buildResume: (
    runtime: SessionDriverRuntime,
    prompt: string,
    nativeSessionId: string,
  ) => Omit<SessionExecutionRequest, "cwd" | "env" | "timeoutMs" | "signal">;
  retryAfterInitialization?: (result: Awaited<ReturnType<SessionExecutor["execute"]>>) => boolean;
};

export type CommandSessionDriverOptions = BaseSessionDriverOptions & {
  executor: SessionExecutor;
};

export class CommandSessionDriver extends BaseSessionDriver {
  readonly backend;
  readonly kind;
  readonly capabilities;
  private version: string | null = null;

  constructor(
    private readonly definition: CommandDriverDefinition,
    private readonly executor: SessionExecutor,
    options: BaseSessionDriverOptions = {},
  ) {
    super(options);
    this.backend = definition.backend;
    this.kind = definition.kind;
    this.capabilities = definition.capabilities;
  }

  async probe(input: SessionProbeInput = {}): Promise<SessionDriverProbe> {
    const cwd = input.cwd ?? process.cwd();
    const env = commandEnvironment(input.env);
    const timeoutMs = sessionTimeout(input.timeoutMs ?? 5_000);
    const version = await this.executor.execute(
      executionRequest(
        [this.definition.binary, ...this.definition.versionArgs],
        cwd,
        env,
        timeoutMs,
        input.signal,
      ),
    );
    if (version.exitCode !== 0)
      return this.failedProbe("Backend version probe failed.", [
        boundedEvidence(version.stderr),
      ]);
    this.version = parseCliVersion(
      `${version.stdout ?? ""}\n${version.stderr ?? ""}`,
    );
    const help = await this.executor.execute(
      executionRequest(
        [this.definition.binary, ...this.definition.helpArgs],
        cwd,
        env,
        timeoutMs,
        input.signal,
      ),
    );
    if (help.exitCode !== 0)
      return this.failedProbe("Backend session help probe failed.", [
        boundedEvidence(help.stderr),
      ]);
    const helpText = `${help.stdout ?? ""}\n${help.stderr ?? ""}`;
    const missing = this.definition.requiredHelpFragments.filter(
      (fragment) => !helpText.includes(fragment),
    );
    if (missing.length > 0)
      return this.failedProbe(
        `Required session capabilities are unavailable: ${missing.join(", ")}.`,
        [helpText.slice(0, 2_048)],
      );
    const auth = await this.probeAuth(cwd, env, timeoutMs, input.signal);
    if (auth.available === false)
      return this.failedProbe(
        auth.reason ?? "Native backend login is unavailable.",
        [],
        auth,
      );
    return {
      ok: true,
      backend: this.backend,
      kind: this.kind,
      version: this.version,
      capabilities: this.capabilities,
      auth,
      reason: null,
      evidence: [
        `${this.definition.binary} session command capabilities verified.`,
        auth.available === true
          ? "Native authentication probe passed."
          : "Native authentication probe was not supplied by the executor.",
      ],
    };
  }

  protected async openFresh(
    runtime: SessionDriverRuntime,
  ): Promise<OpenSessionResult> {
    return {
      nativeSessionId:
        this.definition.initialNativeSessionId?.(runtime) ?? null,
      backendVersion: this.version,
    };
  }

  protected async openNative(
    _runtime: SessionDriverRuntime,
    nativeSessionId: string,
  ): Promise<OpenSessionResult> {
    return { nativeSessionId, backendVersion: this.version };
  }

  protected async performTurn(
    runtime: SessionDriverRuntime,
    prompt: string,
    timeoutMs: number,
    controller: AbortController,
  ) {
    const resume =
      runtime.recovery.status === "native-resumed" || runtime.turns > 0;
    if (resume && !runtime.nativeSessionId) {
      throw new SessionDriverError(
        "NATIVE_SESSION_LOST",
        `${this.kind} did not report a native session identifier for resume.`,
      );
    }
    const command = resume
      ? this.definition.buildResume(runtime, prompt, runtime.nativeSessionId!)
      : this.definition.buildInitial(runtime, prompt);
    const startedAt = Date.now();
    const deadlineAt = startedAt + timeoutMs;
    const deadline = new AbortController();
    const deadlineTimer = setTimeout(() => deadline.abort("session turn deadline exceeded"), timeoutMs);
    deadlineTimer.unref?.();
    const turnSignal = AbortSignal.any([controller.signal, deadline.signal]);
    let result: Awaited<ReturnType<SessionExecutor["execute"]>>;
    try {
      result = await this.executor.execute({
        ...command,
        cwd: runtime.cwd,
        env: runtime.env,
        timeoutMs: remainingTurnMs(deadlineAt),
        signal: turnSignal,
      });
      const remainingMs = deadlineAt - Date.now();
      if (
        remainingMs > 0 &&
        !turnSignal.aborted &&
        !result.timedOut &&
        !result.overflowed &&
        this.definition.retryAfterInitialization?.(result)
      ) {
        // Some CLIs finish a one-time isolated-state migration without handling
        // the requested turn. Retry that exact command once in the same worker,
        // within the original turn deadline; never turn this into a general
        // provider or process retry.
        result = await this.executor.execute({
          ...command,
          cwd: runtime.cwd,
          env: runtime.env,
          timeoutMs: remainingTurnMs(deadlineAt),
          signal: turnSignal,
        });
      }
    } finally {
      clearTimeout(deadlineTimer);
    }
    if ((deadline.signal.aborted || Date.now() >= deadlineAt) && !controller.signal.aborted) {
      result = { ...result, timedOut: true, signal: result.signal ?? "SIGTERM" };
    }
    const assembler = new SessionEventAssembler({
      backend: this.backend,
      decoder: this.definition.decoder,
      now: this.now,
    });
    assembler.beginConnection(`process-${runtime.turns + 1}`);
    // Raw JSONL is authoritative when it is available. Production executors also
    // expose parsed events, so ingesting both paths duplicates deltas without a
    // provider event id. Keeping the raw path also preserves malformed-line
    // accounting that a parsed-only path cannot reconstruct.
    if (typeof result.stdout === "string") assembler.pushJsonl(result.stdout);
    else for (const event of result.events ?? []) assembler.push(event);
    if (
      result.stderr &&
      (result.exitCode !== 0 ||
        /(?:rate.?limit|too many requests|\b429\b)/i.test(result.stderr))
    ) {
      assembler.push({ type: "error", message: result.stderr });
    }
    return assembler.finish({
      exitCode: result.exitCode,
      signal: result.signal,
      cancelled: controller.signal.aborted,
      timedOut: result.timedOut,
      overflowed: result.overflowed,
    });
  }

  private async probeAuth(
    cwd: string,
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
    signal?: AbortSignal,
  ) {
    if (!this.executor.probeAuth)
      return {
        available: null,
        reason: "Auth probe unavailable.",
        profileFingerprint: null,
      };
    const result = await this.executor.probeAuth({
      backend: this.backend,
      cwd,
      env,
      timeoutMs,
      signal: signal ?? new AbortController().signal,
    });
    return {
      available: result.available,
      reason: result.reason,
      profileFingerprint: result.profileFingerprint ?? null,
    };
  }

  private failedProbe(
    reason: string,
    evidence: string[],
    auth: SessionDriverProbe["auth"] = {
      available: null,
      reason: "Auth probe did not complete.",
      profileFingerprint: null,
    },
  ): SessionDriverProbe {
    return {
      ok: false,
      backend: this.backend,
      kind: this.kind,
      version: this.version,
      capabilities: this.capabilities,
      auth,
      reason,
      evidence: evidence.filter(Boolean).map((entry) => entry.slice(0, 2_048)),
    };
  }
}

function remainingTurnMs(deadlineAt: number) {
  return Math.max(1, deadlineAt - Date.now());
}

function executionRequest(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
): SessionExecutionRequest {
  return {
    argv,
    cwd,
    env,
    stdin: null,
    timeoutMs,
    signal: signal ?? new AbortController().signal,
    protocol: "text",
    purpose: "capability-probe",
  };
}

function boundedEvidence(value?: string) {
  return value?.slice(0, 2_048) ?? "";
}
