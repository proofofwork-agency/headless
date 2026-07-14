import { BaseSessionDriver, type BaseSessionDriverOptions, type OpenSessionResult, type SessionDriverRuntime } from "./base";
import { SessionEventAssembler } from "./event-assembler";
import { SessionDriverError } from "./errors";
import type { SessionExecutor, SessionTransport } from "./executor";
import { commandEnvironment, parseCliVersion, sessionTimeout } from "./options";
import { cleanupWithDiagnostic } from "../diagnostics";
import { codexProjectPolicyArguments } from "../../backends/codex";
import type { SessionDriverProbe, SessionProbeInput } from "./types";

const capabilities = {
  nativeResume: true,
  persistentTransport: true,
  replayFallback: true,
  structuredEvents: true,
  cancellation: true,
} as const;

export type CodexAppServerSessionDriverOptions = BaseSessionDriverOptions & {
  executor: SessionExecutor;
};

export class CodexAppServerSessionDriver extends BaseSessionDriver {
  readonly backend = "codex" as const;
  readonly kind = "codex-app-server" as const;
  readonly capabilities = capabilities;
  private version: string | null = null;

  constructor(
    private readonly executor: SessionExecutor,
    options: BaseSessionDriverOptions = {},
  ) {
    super(options);
  }

  async probe(input: SessionProbeInput = {}): Promise<SessionDriverProbe> {
    const cwd = input.cwd ?? process.cwd();
    const env = commandEnvironment(input.env);
    const timeoutMs = sessionTimeout(input.timeoutMs ?? 5_000);
    const controller = new AbortController();
    const removeAbortForwarder = forwardAbort(input.signal, controller);
    try {
      const version = await this.executor.execute({
        argv: ["codex", "--version"],
        cwd,
        env,
        stdin: null,
        timeoutMs,
        signal: controller.signal,
        protocol: "text",
        purpose: "capability-probe",
      });
      if (version.exitCode !== 0) return failedProbe(this.kind, this.version, "Codex version probe failed.", version.stderr);
      this.version = parseCliVersion(`${version.stdout ?? ""}\n${version.stderr ?? ""}`);
      const auth = this.executor.probeAuth
        ? await this.executor.probeAuth({ backend: "codex", cwd, env, timeoutMs, signal: controller.signal })
        : null;
      if (auth && !auth.available) {
        return failedProbe(this.kind, this.version, auth.reason ?? "Codex native login is unavailable.", undefined, {
          available: false,
          reason: auth.reason,
          profileFingerprint: auth.profileFingerprint ?? null,
        });
      }
      if (!this.executor.open) return failedProbe(this.kind, this.version, "Injected executor does not support persistent transports.");
      let transport: SessionTransport | null = null;
      try {
        transport = await this.executor.open(appServerOpenRequest(cwd, env, timeoutMs, controller.signal, "capability-probe"));
        const initialized = await transport.request({
          method: "initialize",
          params: initializeParams(),
          timeoutMs,
          signal: controller.signal,
        });
        return {
          ok: true,
          backend: this.backend,
          kind: this.kind,
          version: this.version,
          capabilities,
          auth: auth ? {
            available: true,
            reason: auth.reason,
            profileFingerprint: auth.profileFingerprint ?? null,
          } : { available: null, reason: "Auth probe unavailable.", profileFingerprint: null },
          reason: null,
          evidence: [`Codex app-server initialize handshake succeeded over ${transport.id}.`, capabilityEvidence(initialized.result)],
        };
      } catch (error) {
        return failedProbe(this.kind, this.version, `Codex app-server initialize handshake failed: ${errorMessage(error)}`);
      } finally {
        if (transport) await cleanupWithDiagnostic("codex-app-server.probe-close", () => transport!.close());
      }
    } finally {
      controller.abort("capability probe complete");
      removeAbortForwarder();
    }
  }

  protected async openFresh(runtime: SessionDriverRuntime, timeoutMs: number): Promise<OpenSessionResult> {
    const transport = await this.openInitialized(runtime, timeoutMs, "NATIVE_AUTH_UNAVAILABLE");
    try {
      const started = await transport.request({
        method: "thread/start",
        params: {
          cwd: runtime.cwd,
          model: runtime.model,
          sandbox: runtime.approvalPolicy === "bypass" ? "danger-full-access" : runtime.mode === "write" ? "workspace-write" : "read-only",
          approvalPolicy: runtime.approvalPolicy === "ask" ? "on-request" : "never",
        },
        waitFor: ["thread/started"],
        timeoutMs,
        signal: activeSignal(runtime),
      });
      const nativeSessionId = findIdentifier(started.result, "thread") ?? findEventIdentifier(started.events, "thread");
      if (!nativeSessionId) throw new SessionDriverError("NATIVE_SESSION_LOST", "Codex app-server did not return a thread identifier.");
      return { nativeSessionId, backendVersion: this.version, resource: transport };
    } catch (error) {
      await cleanupWithDiagnostic("codex-app-server.fresh-open-rollback", () => transport.close());
      throw error;
    }
  }

  protected async openNative(runtime: SessionDriverRuntime, nativeSessionId: string, timeoutMs: number): Promise<OpenSessionResult> {
    const transport = await this.openInitialized(runtime, timeoutMs, "NATIVE_SESSION_LOST");
    try {
      const resumed = await transport.request({
        method: "thread/resume",
        params: { threadId: nativeSessionId },
        waitFor: ["thread/started"],
        timeoutMs,
        signal: activeSignal(runtime),
      });
      const resumedId = findIdentifier(resumed.result, "thread") ?? findEventIdentifier(resumed.events, "thread") ?? nativeSessionId;
      return { nativeSessionId: resumedId, backendVersion: this.version, resource: transport };
    } catch (error) {
      await cleanupWithDiagnostic("codex-app-server.resume-rollback", () => transport.close());
      throw new SessionDriverError("NATIVE_SESSION_LOST", `Codex app-server could not resume thread ${nativeSessionId}: ${errorMessage(error)}`);
    }
  }

  protected async performTurn(
    runtime: SessionDriverRuntime,
    prompt: string,
    timeoutMs: number,
    controller: AbortController,
  ) {
    const transport = requireTransport(runtime);
    const readiness = prepareNativeTurn(runtime);
    try {
      const exchange = await requestWithResponse(transport, {
        method: "turn/start",
        params: {
          threadId: runtime.nativeSessionId,
          input: [{ type: "text", text: prompt, text_elements: [] }],
          approvalPolicy: runtime.approvalPolicy === "ask" ? "on-request" : "never",
        },
        waitFor: ["turn/completed"],
        timeoutMs,
        signal: controller.signal,
      }, readiness.accept);
      readiness.accept(exchange.result);
      const assembler = new SessionEventAssembler({ backend: "codex", now: this.now });
      assembler.beginConnection(transport.id);
      for (const event of exchange.events ?? []) assembler.push(event);
      const turnId = findIdentifier(exchange.result, "turn");
      if (turnId) assembler.push({ method: "turn/started", params: { threadId: runtime.nativeSessionId, turn: { id: turnId } } });
      if (exchange.stderr) assembler.push({ type: "error", message: exchange.stderr });
      return assembler.finish({ exitCode: 0, cancelled: controller.signal.aborted });
    } finally {
      readiness.finish();
    }
  }

  protected async cancelRuntime(runtime: SessionDriverRuntime) {
    if (!runtime.resource || !runtime.activeController) return;
    const turnId = runtime.activeNativeTurnId ?? await boundedNativeTurnId(runtime.activeNativeTurnReady, 5_000);
    if (!turnId) return;
    const controller = new AbortController();
    try {
      await requireTransport(runtime).request({
        method: "turn/interrupt",
        params: {
          threadId: runtime.nativeSessionId,
          turnId,
        },
        timeoutMs: 5_000,
        signal: controller.signal,
      });
    } catch (error) {
      await cleanupWithDiagnostic("codex-app-server.cancel-close", () => requireTransport(runtime).close());
      runtime.resource = null;
      throw new SessionDriverError("PROCESS_ERROR", `Codex app-server could not acknowledge cancellation: ${errorMessage(error)}`);
    }
  }

  protected async closeRuntime(runtime: SessionDriverRuntime) {
    if (runtime.resource) await requireTransport(runtime).close();
  }

  private async openInitialized(
    runtime: SessionDriverRuntime,
    timeoutMs: number,
    code: "NATIVE_AUTH_UNAVAILABLE" | "NATIVE_SESSION_LOST",
  ) {
    if (!this.executor.open) throw new SessionDriverError("BACKEND_UNAVAILABLE", "Injected executor does not support Codex app-server transports.");
    const controller = new AbortController();
    let transport: SessionTransport | null = null;
    try {
      transport = await this.executor.open(appServerOpenRequest(runtime.cwd, runtime.env, timeoutMs, controller.signal));
      await transport.request({ method: "initialize", params: initializeParams(), timeoutMs, signal: controller.signal });
      return transport;
    } catch (error) {
      if (transport) await cleanupWithDiagnostic("codex-app-server.initialize-rollback", () => transport!.close());
      throw new SessionDriverError(code, `Codex app-server initialization failed: ${errorMessage(error)}`, code === "NATIVE_AUTH_UNAVAILABLE");
    }
  }
}

function appServerOpenRequest(
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal: AbortSignal,
  purpose: "capability-probe" | "turn" = "turn",
) {
  return {
    argv: [
      "codex", "app-server", "--listen", "stdio://", "--strict-config",
      ...codexProjectPolicyArguments(cwd),
    ],
    cwd,
    env,
    timeoutMs,
    signal,
    protocol: "json-rpc-jsonl" as const,
    purpose,
  };
}

function initializeParams() {
  return { clientInfo: { name: "headless", title: "Headless", version: "0.2.0-alpha.0" } };
}

function requireTransport(runtime: SessionDriverRuntime) {
  const value = runtime.resource;
  if (!value || typeof value !== "object" || !("request" in value) || !("close" in value)) {
    throw new SessionDriverError("NATIVE_SESSION_LOST", "Codex app-server transport is unavailable.");
  }
  return value as SessionTransport;
}

function activeSignal(runtime: SessionDriverRuntime) {
  return runtime.activeController?.signal ?? new AbortController().signal;
}

function prepareNativeTurn(runtime: SessionDriverRuntime) {
  let settled = false;
  let resolve!: (value: string | null) => void;
  runtime.activeNativeTurnId = null;
  runtime.activeNativeTurnReady = new Promise<string | null>((done) => { resolve = done; });
  const settle = (value: string | null) => {
    if (settled) return;
    settled = true;
    resolve(value);
  };
  return {
    accept: (value: unknown) => {
      const turnId = findIdentifier(value, "turn");
      if (!turnId) return;
      runtime.activeNativeTurnId = turnId;
      settle(turnId);
    },
    finish: () => settle(runtime.activeNativeTurnId),
  };
}

function requestWithResponse(
  transport: SessionTransport,
  input: Parameters<SessionTransport["request"]>[0],
  onResponse: (value: unknown) => void,
) {
  return transport.request({ ...input, onResponse } as Parameters<SessionTransport["request"]>[0]);
}

async function boundedNativeTurnId(ready: Promise<string | null> | null, timeoutMs: number) {
  if (!ready) return null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      ready,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function forwardAbort(signal: AbortSignal | undefined, controller: AbortController) {
  if (!signal) return () => {};
  const abort = () => controller.abort(signal.reason ?? "session probe cancelled");
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function findIdentifier(value: unknown, kind: "thread" | "turn") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  const nested = object[kind];
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const id = (nested as Record<string, unknown>).id;
    if (typeof id === "string" && id) return id;
  }
  const direct = object[`${kind}Id`] ?? object[`${kind}_id`];
  return typeof direct === "string" && direct ? direct : null;
}

function findEventIdentifier(events: unknown[] | undefined, kind: "thread" | "turn") {
  for (const event of events ?? []) {
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const object = event as Record<string, unknown>;
    const found = findIdentifier(object.params ?? object, kind);
    if (found) return found;
  }
  return null;
}

function capabilityEvidence(value: unknown) {
  if (!value || typeof value !== "object") return "initialize response received";
  const text = JSON.stringify(value);
  return text.length > 1_024 ? `${text.slice(0, 1_024)}…` : text;
}

function failedProbe(
  kind: "codex-app-server",
  version: string | null,
  reason: string,
  evidence?: string,
  auth: SessionDriverProbe["auth"] = { available: null, reason: "Auth probe did not complete.", profileFingerprint: null },
): SessionDriverProbe {
  return {
    ok: false,
    backend: "codex",
    kind,
    version,
    capabilities,
    auth,
    reason,
    evidence: evidence ? [evidence.slice(0, 2_048)] : [],
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
