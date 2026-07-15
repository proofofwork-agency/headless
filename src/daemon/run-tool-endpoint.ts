import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import { BackendIdSchema, BoundedTextSchema, IdentifierSchema, PositiveTimeoutSchema, PrincipalIdSchema, ProjectIdSchema, TimestampSchema } from "../contracts/common";
import { ensureOwnerOnlyDirectory } from "../runtime/project-state";
import { redactAndTruncate, redactDeep } from "../runtime/redaction";
import { runToolCallTimeoutMs } from "../runtime/run-tool-client";
import { safeJsonParse } from "../runtime/safe-json";

export const RUN_TOOL_PROTOCOL_VERSION = 1 as const;
export const MAX_RUN_TOOL_REQUEST_BYTES = 131_072;
export const MAX_RUN_TOOL_RESPONSE_BYTES = 524_288;

class RunToolEndpointError extends Error {
  constructor(readonly code: string, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RunToolEndpointError";
  }
}

export const RunToolOperationSchema = z.enum([
  "context",
  "task_status",
  "note",
  "artifact",
  "propose_final",
  "message_send",
  "messages_pull",
  "ask_for_more_work",
  "ask_for_backup",
  "run.delegate",
]);
export type RunToolOperation = z.infer<typeof RunToolOperationSchema>;
export const DEPTH_ZERO_RUN_TOOL_OPERATIONS = RunToolOperationSchema.options;
export const DELEGATED_RUN_TOOL_OPERATIONS = RunToolOperationSchema.options.filter((operation) => operation !== "run.delegate");

export const RunToolScopeSchema = z.object({
  projectId: ProjectIdSchema,
  jobId: IdentifierSchema,
  sessionId: IdentifierSchema,
  principal: PrincipalIdSchema,
  expiresAt: TimestampSchema,
}).strict();
export type RunToolScope = z.infer<typeof RunToolScopeSchema>;

const RunToolRequestSchema = z.object({
  version: z.literal(RUN_TOOL_PROTOCOL_VERSION),
  id: z.string().uuid(),
  token: z.string().min(40).max(512),
  operation: RunToolOperationSchema,
  params: z.record(z.unknown()).default({}),
}).strict();

const RunToolResponseSchema = z.object({
  version: z.literal(RUN_TOOL_PROTOCOL_VERSION),
  id: z.string().uuid(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.object({ code: z.string().min(1).max(64), message: z.string().min(1).max(16_384) }).strict().optional(),
}).strict();

const StatusSchema = z.enum(["passed", "failed", "blocked", "unknown", "skipped", "timed_out"]);
const paramSchemas = {
  context: z.object({
    view: z.enum(["summary", "recent"]).default("summary"),
    limit: z.number().int().min(1).max(100).default(40),
  }).strict(),
  task_status: z.object({}).strict(),
  note: z.object({
    text: z.string().min(1).max(20_000),
    handlesHandoffId: IdentifierSchema.optional(),
  }).strict(),
  artifact: z.object({
    kind: z.string().trim().min(1).max(128),
    title: z.string().trim().min(1).max(512),
    summary: z.string().min(1).max(20_000),
    status: StatusSchema.default("unknown"),
    evidence: z.array(z.string().max(4_096)).max(128).default([]),
  }).strict(),
  propose_final: z.object({
    summary: z.string().min(1).max(20_000),
    evidence: z.string().min(1).max(20_000),
    remainingRisk: z.string().max(20_000).optional(),
    handlesHandoffIds: z.array(IdentifierSchema).max(128).default([]),
  }).strict(),
  message_send: z.object({
    content: z.string().min(1).max(65_536),
    to: z.string().trim().min(1).max(160).default("channel"),
    meta: z.record(z.unknown()).default({}),
  }).strict().refine((value) => boundedJson(value.meta, 32_768), "Message metadata exceeds the serialized byte limit."),
  messages_pull: z.object({ limit: z.number().int().min(1).max(50).default(20) }).strict(),
  ask_for_more_work: z.object({ completed: z.string().min(1).max(16_384) }).strict(),
  ask_for_backup: z.object({ reason: z.string().min(1).max(16_384) }).strict(),
  "run.delegate": z.object({
    backend: BackendIdSchema,
    prompt: BoundedTextSchema,
    model: z.string().trim().min(1).max(256).optional(),
    agent: z.string().trim().min(1).max(256).optional(),
    timeoutMs: PositiveTimeoutSchema.optional(),
    budgetFraction: z.number().positive().max(0.5).default(0.25),
  }).strict(),
} satisfies Record<RunToolOperation, z.ZodTypeAny>;

export type RunToolCallHandler = (
  scope: Readonly<RunToolScope>,
  operation: RunToolOperation,
  params: Record<string, unknown>,
  requestId: string,
) => unknown | Promise<unknown>;

export type RunToolEndpoint = {
  id: string;
  socketPath: string;
  token: string;
  scope: RunToolScope;
  operations: RunToolOperation[];
};

type EndpointRecord = {
  id: string;
  socketPath: string;
  tokenDigest: Buffer;
  scope: RunToolScope;
  server: Server;
  sockets: Set<Socket>;
  timer: ReturnType<typeof setTimeout>;
  active: boolean;
  requests: number;
  inFlight: number;
  maxRequests: number;
  operations: ReadonlySet<RunToolOperation>;
};

export type RunToolEndpointManagerOptions = {
  socketDir: string;
  handle: RunToolCallHandler;
  now?: () => number;
  maxRequestsPerRun?: number;
};

/**
 * Daemon-owned, per-run cooperation endpoint.
 *
 * Each listener has its own owner-only Unix socket and opaque credential. The
 * credential is never persisted, the immutable scope is supplied by the
 * daemon rather than the caller, and revocation destroys all live sockets.
 */
export class RunToolEndpointManager {
  private readonly records = new Map<string, EndpointRecord>();
  private readonly now: () => number;
  private readonly maxRequestsPerRun: number;

  constructor(private readonly options: RunToolEndpointManagerOptions) {
    ensureOwnerOnlyDirectory(options.socketDir);
    this.now = options.now ?? Date.now;
    this.maxRequestsPerRun = boundedPositive(options.maxRequestsPerRun ?? 128, 1_024, "maxRequestsPerRun");
  }

  async issue(input: RunToolScope, operations: readonly RunToolOperation[] = RunToolOperationSchema.options): Promise<RunToolEndpoint> {
    const scope = RunToolScopeSchema.parse(input);
    const allowed = operations.map((operation) => RunToolOperationSchema.parse(operation));
    if (new Set(allowed).size !== allowed.length || allowed.length === 0) throw new TypeError("Run tool operation allowlist must be non-empty and unique.");
    if (scope.expiresAt <= this.now()) throw new TypeError("Run tool credential expiry must be in the future.");
    const id = randomUUID();
    const socketPath = join(this.options.socketDir, `${process.pid}-${id.slice(0, 8)}.tool.sock`);
    if (Buffer.byteLength(socketPath) > 103) throw new Error("Run tool Unix socket path exceeds the platform limit.");
    if (existsSync(socketPath)) throw new Error("Run tool Unix socket path already exists.");
    const token = `hlt_${randomBytes(48).toString("base64url")}`;
    const server = createServer();
    const record = {
      id,
      socketPath,
      tokenDigest: digest(token),
      scope,
      server,
      sockets: new Set<Socket>(),
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
      active: true,
      requests: 0,
      inFlight: 0,
      maxRequests: this.maxRequestsPerRun,
      operations: new Set(allowed),
    } satisfies EndpointRecord;
    server.on("connection", (socket) => this.accept(record, socket));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
      chmodSync(socketPath, 0o600);
      record.timer = setTimeout(() => { void this.revoke(id); }, Math.max(1, scope.expiresAt - this.now()));
      record.timer.unref?.();
      this.records.set(id, record);
      server.on("error", () => { void this.revoke(id); });
      return { id, socketPath, token, scope: structuredClone(scope), operations: [...allowed] };
    } catch (error) {
      server.close();
      rmSync(socketPath, { force: true });
      throw error;
    }
  }

  async revoke(id: string) {
    const record = this.records.get(id);
    if (!record) return false;
    this.records.delete(id);
    record.active = false;
    clearTimeout(record.timer);
    for (const socket of record.sockets) socket.destroy();
    await new Promise<void>((resolve) => record.server.close(() => resolve())).catch(() => {});
    record.tokenDigest.fill(0);
    rmSync(record.socketPath, { force: true });
    return true;
  }

  async revokeAll() {
    await Promise.all([...this.records.keys()].map((id) => this.revoke(id)));
  }

  private accept(record: EndpointRecord, socket: Socket) {
    if (!record.active || record.scope.expiresAt <= this.now()) {
      socket.destroy();
      void this.revoke(record.id);
      return;
    }
    record.sockets.add(socket);
    socket.setEncoding("utf8");
    socket.setTimeout(runToolCallTimeoutMs(), () => socket.destroy());
    socket.once("close", () => record.sockets.delete(socket));
    let buffer = "";
    let handled = false;
    socket.on("data", (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_RUN_TOOL_REQUEST_BYTES) {
        handled = true;
        this.respond(socket, failure(randomUUID(), "INVALID_REQUEST", "Run tool request exceeded the byte limit."));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      void this.dispatch(record, socket, buffer.slice(0, newline));
    });
  }

  private async dispatch(record: EndpointRecord, socket: Socket, line: string) {
    let id: string = randomUUID();
    try {
      const request = RunToolRequestSchema.parse(safeJsonParse(line));
      id = request.id;
      if (!record.active || record.scope.expiresAt <= this.now()) {
        void this.revoke(record.id);
        throw policyError("RUN_TOOL_EXPIRED", "Run tool credential expired or was revoked.");
      }
      if (!safeTokenEqual(record.tokenDigest, request.token)) throw policyError("RUN_TOOL_AUTH_FAILED", "Run tool authentication failed.");
      if (record.requests >= record.maxRequests) throw policyError("RUN_TOOL_LIMIT", "Run tool request limit exhausted.");
      if (record.inFlight >= 4) throw policyError("RUN_TOOL_BUSY", "Run tool concurrency limit reached.");
      if (!record.operations.has(request.operation)) throw policyError("POLICY_DENIED", "Run tool operation is not allowed for this credential.");
      const params = paramSchemas[request.operation].parse(request.params) as Record<string, unknown>;
      if (request.operation === "run.delegate") {
        const requested = typeof params.timeoutMs === "number" ? params.timeoutMs : 60_000;
        socket.setTimeout(Math.max(runToolCallTimeoutMs(), Math.min(record.scope.expiresAt - this.now(), requested + 10_000)), () => socket.destroy());
      }
      // Reserve before the first await so concurrent callers cannot race the cap.
      record.requests += 1;
      record.inFlight += 1;
      try {
        const result = await this.options.handle(Object.freeze(structuredClone(record.scope)), request.operation, params, request.id);
        if (!record.active || record.scope.expiresAt <= this.now()) {
          throw policyError("RUN_TOOL_EXPIRED", "Run tool credential expired or was revoked.");
        }
        this.respond(socket, { version: RUN_TOOL_PROTOCOL_VERSION, id, ok: true, result: redactDeep(result).value });
      } finally {
        record.inFlight -= 1;
      }
    } catch (error) {
      const code = errorCode(error);
      this.respond(socket, failure(id, code, messageOf(error)));
    }
  }

  private respond(socket: Socket, value: z.input<typeof RunToolResponseSchema>) {
    let response: z.infer<typeof RunToolResponseSchema>;
    try {
      response = RunToolResponseSchema.parse(value);
    } catch {
      response = failure(randomUUID(), "INTERNAL_ERROR", "Run tool response validation failed.");
    }
    let encoded = `${JSON.stringify(response)}\n`;
    if (Buffer.byteLength(encoded) > MAX_RUN_TOOL_RESPONSE_BYTES) {
      encoded = `${JSON.stringify(failure(response.id, "OUTPUT_OVERFLOW", "Run tool response exceeded the byte limit."))}\n`;
    }
    socket.end(encoded);
  }
}

export async function callRunToolEndpoint(
  endpoint: Pick<RunToolEndpoint, "socketPath" | "token">,
  operation: RunToolOperation,
  params: Record<string, unknown> = {},
  timeoutMs = 5_000,
) {
  const { createConnection } = await import("node:net");
  const id = randomUUID();
  const request = `${JSON.stringify({ version: RUN_TOOL_PROTOCOL_VERSION, id, token: endpoint.token, operation, params })}\n`;
  return new Promise<unknown>((resolve, reject) => {
    const socket = createConnection(endpoint.socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new RunToolEndpointError("RUN_TOOL_UNAVAILABLE", "Timed out waiting for run tool endpoint."));
    }, boundedPositive(timeoutMs, 60_000, "timeoutMs"));
    socket.once("connect", () => socket.write(request));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_RUN_TOOL_RESPONSE_BYTES) {
        clearTimeout(timer);
        socket.destroy();
        reject(new Error("Run tool response exceeded the byte limit."));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      socket.end();
      try {
        const response = RunToolResponseSchema.parse(safeJsonParse(buffer.slice(0, newline)));
        if (response.id !== id) throw new Error("Run tool response id mismatch.");
        if (!response.ok) throw new RunToolEndpointError(response.error?.code ?? "INTERNAL_ERROR", response.error?.message ?? "Run tool call failed.");
        resolve(response.result);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(new RunToolEndpointError("RUN_TOOL_UNAVAILABLE", `Run tool endpoint is unavailable: ${error.message}`, { cause: error }));
    });
  });
}

function failure(id: string, code: string, message: string) {
  return {
    version: RUN_TOOL_PROTOCOL_VERSION,
    id,
    ok: false,
    error: { code: code.slice(0, 64) || "INTERNAL_ERROR", message: redactAndTruncate(message, 16_384).text || "Run tool call failed." },
  } as const;
}

function digest(token: string) {
  return createHash("sha256").update(token).digest();
}

function safeTokenEqual(expected: Buffer, token: string) {
  const actual = digest(typeof token === "string" && token.length <= 512 ? token : "invalid");
  return timingSafeEqual(expected, actual);
}

function policyError(code: string, message: string) {
  return new RunToolEndpointError(code, message);
}

function errorCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  if (error instanceof z.ZodError || error instanceof TypeError) return "INVALID_REQUEST";
  return "INTERNAL_ERROR";
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function boundedPositive(value: number, max: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) throw new TypeError(`${name} must be a positive bounded integer.`);
  return value;
}

function boundedJson(value: unknown, maxBytes: number) {
  try {
    return Buffer.byteLength(JSON.stringify(value)) <= maxBytes;
  } catch {
    return false;
  }
}
