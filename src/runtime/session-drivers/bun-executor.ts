import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { terminateProcessTree } from "../process-tree";
import { cleanupWithDiagnostic, recordRuntimeDiagnostic } from "../diagnostics";
import type {
  SessionAuthProbeRequest,
  SessionAuthProbeResult,
  SessionExecutionRequest,
  SessionExecutionResult,
  SessionExecutor,
  SessionTransport,
  SessionTransportOpenRequest,
  SessionTransportRequest,
  SessionTransportResult,
} from "./executor";

const MAX_EXECUTOR_OUTPUT_BYTES = 1_000_000;
const MAX_TRANSPORT_MESSAGE_BYTES = 1_000_000;
const MAX_TRANSPORT_EVENTS = 2_048;

export type PreparedSessionCommand = {
  argv: string[];
  cleanup?: () => void | Promise<void>;
};

export type BunSessionExecutorOptions = {
  prepare?: (
    request: SessionExecutionRequest | SessionTransportOpenRequest,
  ) => PreparedSessionCommand | Promise<PreparedSessionCommand>;
  maxOutputBytes?: number;
};

/** Production executor with bounded output, cancellation, and process-tree teardown. */
export class BunSessionExecutor implements SessionExecutor {
  private readonly prepare: NonNullable<BunSessionExecutorOptions["prepare"]>;
  private readonly maxOutputBytes;

  constructor(options: BunSessionExecutorOptions = {}) {
    this.prepare = options.prepare ?? ((request): PreparedSessionCommand => ({ argv: request.argv }));
    this.maxOutputBytes = boundedBytes(options.maxOutputBytes ?? MAX_EXECUTOR_OUTPUT_BYTES);
  }

  async execute(input: SessionExecutionRequest): Promise<SessionExecutionResult> {
    if (input.signal.aborted) return { exitCode: null, signal: "SIGTERM", stderr: "Session command was cancelled before launch." };
    const prepared = await this.prepare(input);
    let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let termination: ReturnType<typeof terminateProcessTree> | null = null;
    let timedOut = false;
    let overflowed = false;
    const stop = () => {
      if (!child) return null;
      termination ??= terminateProcessTree(child, { graceMs: 500 });
      return termination;
    };
    const abort = () => {
      void stop()?.catch((error) => recordRuntimeDiagnostic("state", "session-executor.abort-termination", error));
    };
    input.signal.addEventListener("abort", abort, { once: true });
    try {
      if (input.signal.aborted) {
        return {
          exitCode: null,
          signal: "SIGTERM",
          stderr: "Session command was cancelled during preparation.",
          timedOut: false,
          overflowed: false,
        };
      }
      child = Bun.spawn(prepared.argv, {
        cwd: input.cwd,
        env: input.env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      });
      timeout = setTimeout(() => {
        timedOut = true;
        void stop()?.catch((error) => recordRuntimeDiagnostic("state", "session-executor.timeout-termination", error));
      }, input.timeoutMs);
      timeout.unref?.();
      if (input.stdin) child.stdin.write(input.stdin);
      child.stdin.end();
      const budget = { remaining: this.maxOutputBytes };
      const overflow = () => {
        overflowed = true;
        void stop()?.catch((error) => recordRuntimeDiagnostic("state", "session-executor.overflow-termination", error));
      };
      let exitFailure = false;
      const [stdout, stderr, exitCode] = await Promise.all([
        readBounded(child.stdout, budget, overflow),
        readBounded(child.stderr, budget, overflow),
        child.exited.catch((error) => {
          exitFailure = true;
          recordRuntimeDiagnostic("transport", "session-executor.exit", error);
          return null;
        }),
      ]);
      const events = input.protocol === "text" ? undefined : parseJsonLines(stdout);
      const diagnostic = timedOut
        ? "Session command timed out."
        : overflowed
          ? "Session command exceeded its output bound."
          : exitFailure
            ? "Session command exit status was unavailable."
            : stderr;
      return {
        exitCode,
        signal: child.signalCode ?? (input.signal.aborted || timedOut || overflowed ? "SIGKILL" : null),
        stdout,
        stderr: diagnostic,
        events,
        timedOut,
        overflowed,
      };
    } finally {
      if (timeout) clearTimeout(timeout);
      input.signal.removeEventListener("abort", abort);
      let terminationError: Error | null = null;
      if (child) {
        try {
          const outcome = await (stop()!);
          if (!outcome.exited) {
            terminationError = new Error("Session command process tree did not exit after TERM to KILL escalation.");
            recordRuntimeDiagnostic("state", "session-executor.termination", terminationError);
          }
        } catch (error) {
          terminationError = error instanceof Error ? error : new Error(String(error));
          recordRuntimeDiagnostic("state", "session-executor.termination", terminationError);
        }
      }
      await cleanupWithDiagnostic("session-executor.prepared-command", prepared.cleanup);
      if (terminationError) throw terminationError;
    }
  }

  async open(input: SessionTransportOpenRequest) {
    const prepared = await this.prepare(input);
    try {
      return await BunJsonRpcSessionTransport.open(input, prepared, this.maxOutputBytes);
    } catch (error) {
      await cleanupWithDiagnostic("session-executor.open-rollback", prepared.cleanup);
      throw error;
    }
  }

  async probeAuth(input: SessionAuthProbeRequest): Promise<SessionAuthProbeResult> {
    const file = authFile(input.backend, input.env);
    if (file && existsSync(file)) {
      const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) {
        return { available: false, reason: "Native authentication capsule is invalid.", profileFingerprint: null };
      }
      const fingerprint = createHash("sha256").update(input.backend).update("\0").update(readFileSync(file)).digest("hex");
      return { available: true, reason: "Backend-native authentication capsule is present.", profileFingerprint: fingerprint };
    }
    return { available: false, reason: `No native authentication capsule is available for ${input.backend}.`, profileFingerprint: null };
  }
}

class BunJsonRpcSessionTransport implements SessionTransport {
  readonly id = `stdio-${randomUUID()}`;
  private readonly pending = new Map<number, TransportPending>();
  private readonly events: TransportEvent[] = [];
  private readonly activeEventOffsets = new Map<number, number>();
  private readonly waiters = new Set<TransportWaiter>();
  private nextId = 1;
  private nextEventSequence = 0;
  private retainedEventBytes = 0;
  private stderr = "";
  private closed = false;
  private closing: Promise<void> | null = null;
  private failure: Error | null = null;
  private abortSignal: AbortSignal | null = null;
  private abortListener: (() => void) | null = null;

  private constructor(
    private readonly child: Bun.Subprocess<"pipe", "pipe", "pipe">,
    private readonly cleanup: (() => void | Promise<void>) | undefined,
    private readonly maxOutputBytes: number,
  ) {
    void this.readStdout();
    void this.readStderr().catch((error) => {
      this.failAll(error);
      recordRuntimeDiagnostic("transport", "session-transport.stderr", error);
      void this.close().catch((closeError) => recordRuntimeDiagnostic("state", "session-transport.stderr-close", closeError));
    });
    void child.exited.then((code) => this.failAll(new Error(`Session transport exited ${code}.`)), (error) => this.failAll(error));
  }

  static async open(
    input: SessionTransportOpenRequest,
    prepared: PreparedSessionCommand,
    maxOutputBytes: number,
  ) {
    if (input.signal.aborted) throw new Error("Session transport was cancelled before launch.");
    const child = Bun.spawn(prepared.argv, {
      cwd: input.cwd,
      env: input.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    const transport = new BunJsonRpcSessionTransport(child, prepared.cleanup, maxOutputBytes);
    transport.abortSignal = input.signal;
    transport.abortListener = () => {
      void transport.close().catch((error) => recordRuntimeDiagnostic("state", "session-transport.abort-close", error));
    };
    input.signal.addEventListener("abort", transport.abortListener, { once: true });
    return transport;
  }

  async request(input: ResponseAwareTransportRequest): Promise<SessionTransportResult> {
    if (this.closed) throw new Error("Session transport is closed.");
    if (this.failure) throw this.failure;
    const id = this.nextId++;
    const eventOffset = this.nextEventSequence;
    this.activeEventOffsets.set(id, eventOffset);
    let entry!: TransportPending;
    const response = new Promise<unknown>((resolve, reject) => {
      entry = { resolve, reject, onResponse: input.onResponse };
      this.pending.set(id, entry);
    });
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: input.method, params: input.params })}\n`);
      const result = await withTimeout(response, input.timeoutMs, input.signal, `Session transport request ${input.method} timed out.`);
      if (this.failure) throw this.failure;
      if (input.waitFor?.length) {
        await this.waitForMethods(input.waitFor, eventOffset, input.timeoutMs, input.signal);
      }
      if (this.failure) throw this.failure;
      return {
        result,
        events: this.eventsSince(eventOffset),
        stderr: this.stderr || undefined,
      };
    } finally {
      if (this.pending.get(id) === entry) this.pending.delete(id);
      this.activeEventOffsets.delete(id);
      this.pruneEvents();
    }
  }

  async inspect() {
    return {
      id: this.id,
      pid: this.child.pid,
      closed: this.closed,
      pendingRequests: this.pending.size,
      pendingWaiters: this.waiters.size,
      retainedEvents: this.events.length,
      retainedEventBytes: this.retainedEventBytes,
      stderrBytes: Buffer.byteLength(this.stderr),
    };
  }

  close() {
    this.closing ??= this.closeInternal();
    return this.closing;
  }

  private async closeInternal() {
    this.closed = true;
    if (this.abortSignal && this.abortListener) this.abortSignal.removeEventListener("abort", this.abortListener);
    this.abortSignal = null;
    this.abortListener = null;
    this.failAll(new Error("Session transport closed."));
    this.child.stdin.end();
    let termination: Awaited<ReturnType<typeof terminateProcessTree>> | null = null;
    let terminationError: Error | null = null;
    try {
      termination = await terminateProcessTree(this.child, { graceMs: 500 });
    } catch (error) {
      terminationError = error instanceof Error ? error : new Error(String(error));
      recordRuntimeDiagnostic("state", "session-transport.close", terminationError);
    }
    await cleanupWithDiagnostic("session-transport.prepared-command", this.cleanup);
    if (terminationError) throw terminationError;
    if (!termination?.exited) {
      const error = new Error("Session transport process tree did not exit after TERM to KILL escalation.");
      recordRuntimeDiagnostic("state", "session-transport.close", error);
      throw error;
    }
  }

  private async readStdout() {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of this.child.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        if (Buffer.byteLength(buffer) > MAX_TRANSPORT_MESSAGE_BYTES) throw new Error("Session transport frame exceeded its bound.");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) this.acceptLine(line);
      }
      buffer += decoder.decode();
      if (buffer.trim()) this.acceptLine(buffer);
    } catch (error) {
      this.failAll(error);
      await this.close().catch((closeError) => recordRuntimeDiagnostic("state", "session-transport.stdout-close", closeError));
    }
  }

  private async readStderr() {
    const budget = { remaining: this.maxOutputBytes };
    this.stderr = await readBounded(this.child.stderr, budget, () => {
      void this.close().catch((error) => recordRuntimeDiagnostic("state", "session-transport.stderr-overflow-close", error));
    });
  }

  private acceptLine(line: string) {
    if (!line.trim()) return;
    let value: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("non-object frame");
      value = parsed as Record<string, unknown>;
    } catch {
      this.pushEvent({ type: "diagnostic", message: "Malformed JSON-RPC transport frame." }, Buffer.byteLength(line));
      return;
    }
    if (typeof value.id === "number" && this.pending.has(value.id)) {
      const pending = this.pending.get(value.id)!;
      this.pending.delete(value.id);
      if (value.error) {
        pending.reject(new Error(safeJson(value.error)));
      } else {
        try {
          pending.onResponse?.(value.result);
        } catch (error) {
          recordRuntimeDiagnostic("transport", "session-transport.response-callback", error);
        }
        pending.resolve(value.result);
      }
      return;
    }
    this.pushEvent(value, Buffer.byteLength(line));
  }

  private pushEvent(value: unknown, bytes: number) {
    if (this.closed || this.failure) return;
    if (this.events.length >= MAX_TRANSPORT_EVENTS || this.retainedEventBytes + bytes > this.maxOutputBytes) {
      const error = new Error("Session transport event buffer exceeded its bound.");
      this.failAll(error);
      void this.close().catch((closeError) => recordRuntimeDiagnostic("state", "session-transport.event-overflow-close", closeError));
      return;
    }
    this.events.push({ sequence: this.nextEventSequence++, value, bytes });
    this.retainedEventBytes += bytes;
    for (const waiter of this.waiters) waiter.wake();
  }

  private async waitForMethods(methods: string[], offset: number, timeoutMs: number, signal: AbortSignal) {
    const wanted = new Set(methods);
    const found = () => this.eventsSince(offset).some((event) => {
      if (!event || typeof event !== "object" || Array.isArray(event)) return false;
      return wanted.has(String((event as Record<string, unknown>).method ?? (event as Record<string, unknown>).type ?? ""));
    });
    if (this.failure) throw this.failure;
    if (found()) return;
    let waiter!: TransportWaiter;
    const pending = new Promise<void>((resolve, reject) => {
      waiter = {
        wake: () => {
          if (found()) resolve();
        },
        reject,
      };
      this.waiters.add(waiter);
    });
    try {
      await withTimeout(pending, timeoutMs, signal, `Session transport did not receive ${methods.join(" or ")}.`);
    } finally {
      this.waiters.delete(waiter);
    }
  }

  private failAll(error: unknown) {
    const failure = error instanceof Error ? error : new Error(String(error));
    this.failure ??= failure;
    for (const pending of this.pending.values()) pending.reject(failure);
    this.pending.clear();
    for (const waiter of this.waiters) waiter.reject(failure);
    this.waiters.clear();
  }

  private eventsSince(offset: number) {
    const oldest = this.events[0]?.sequence ?? this.nextEventSequence;
    if (offset < oldest) throw new Error("Session transport event cursor fell behind the retained window.");
    return this.events.filter((event) => event.sequence >= offset).map((event) => event.value);
  }

  private pruneEvents() {
    const offsets = [...this.activeEventOffsets.values()];
    if (offsets.length === 0) {
      this.events.length = 0;
      this.retainedEventBytes = 0;
      return;
    }
    const oldestRequired = Math.min(...offsets);
    let remove = 0;
    while (remove < this.events.length && this.events[remove]!.sequence < oldestRequired) {
      this.retainedEventBytes -= this.events[remove]!.bytes;
      remove += 1;
    }
    if (remove > 0) this.events.splice(0, remove);
  }
}

type ResponseAwareTransportRequest = SessionTransportRequest & {
  onResponse?: (value: unknown) => void;
};

type TransportPending = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  onResponse?: (value: unknown) => void;
};

type TransportEvent = {
  sequence: number;
  value: unknown;
  bytes: number;
};

type TransportWaiter = {
  wake: () => void;
  reject: (error: unknown) => void;
};

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  budget: { remaining: number },
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
        if (budget.remaining > 0) output += decoder.decode(value.subarray(0, budget.remaining), { stream: true });
        budget.remaining = 0;
        overflow();
        break;
      }
      budget.remaining -= value.byteLength;
      output += decoder.decode(value, { stream: true });
    }
  } finally {
    try {
      reader.releaseLock();
    } catch (error) {
      recordRuntimeDiagnostic("cleanup", "session-executor.reader-release", error);
    }
  }
  return output + decoder.decode();
}

function parseJsonLines(value: string) {
  const events: unknown[] = [];
  for (const line of value.split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { events.push({ type: "diagnostic", message: "Malformed structured session event." }); }
  }
  return events;
}

function authFile(backend: SessionAuthProbeRequest["backend"], env: NodeJS.ProcessEnv) {
  const home = env.HOME;
  const data = env.XDG_DATA_HOME;
  const config = env.XDG_CONFIG_HOME;
  if (backend === "codex" && home) return join(home, ".codex", "auth.json");
  if (backend === "claude-code" && home) return join(home, ".claude", ".credentials.json");
  if (backend === "opencode" && data) return join(data, "opencode", "auth.json");
  if (backend === "grok-build" && home && existsSync(join(home, ".grok", "auth.json"))) return join(home, ".grok", "auth.json");
  if (backend === "grok-build" && config) return join(config, "grok", "auth.json");
  return null;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal, message: string) {
  let timeout: ReturnType<typeof setTimeout>;
  let abort: () => void;
  const boundary = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    timeout.unref?.();
    abort = () => reject(new Error("Session transport request was cancelled."));
    signal.addEventListener("abort", abort, { once: true });
  });
  return Promise.race([promise, boundary]).finally(() => {
    clearTimeout(timeout!);
    signal.removeEventListener("abort", abort!);
  });
}

function boundedBytes(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 16_000_000) throw new TypeError("Session executor output bound is invalid.");
  return value;
}

function safeJson(value: unknown) {
  try { return JSON.stringify(value).slice(0, 2_048); } catch { return "JSON-RPC error"; }
}
