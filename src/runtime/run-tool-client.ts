import { chmodSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { WorkerEnvironment } from "./worker-environment";
import type { RunToolOperation } from "../daemon/run-tool-endpoint";

export type RunToolWorkerAccess = {
  socketPath: string;
  token: string;
  expiresAt: number;
  jobId: string;
  sessionId: string;
  operations: RunToolOperation[];
};

export const DEFAULT_RUN_TOOL_TIMEOUT_MS = 5_000;
export const MIN_RUN_TOOL_TIMEOUT_MS = 1_000;
export const MAX_RUN_TOOL_TIMEOUT_MS = 60_000;

export function runToolCallTimeoutMs(env: Readonly<Record<string, string | undefined>> = process.env) {
  const configured = Number(env.HEADLESS_RUN_TOOL_TIMEOUT_MS);
  if (!Number.isSafeInteger(configured)) return DEFAULT_RUN_TOOL_TIMEOUT_MS;
  return Math.max(MIN_RUN_TOOL_TIMEOUT_MS, Math.min(MAX_RUN_TOOL_TIMEOUT_MS, configured));
}

/** Install a disposable client inside this worker's isolated runtime root. */
export function installRunToolClient(worker: WorkerEnvironment, access: RunToolWorkerAccess) {
  if (!statSync(access.socketPath).isSocket()) throw new Error("Daemon run tool socket is unavailable.");
  if (!/^hlt_[A-Za-z0-9_-]{40,}$/.test(access.token)) throw new Error("Daemon run tool credential is invalid.");
  if (!Number.isSafeInteger(access.expiresAt) || access.expiresAt <= Date.now()) throw new Error("Daemon run tool credential has expired.");
  const clientPath = join(worker.runtime, "headless-run-tool");
  writeFileSync(clientPath, RUN_TOOL_CLIENT_SOURCE, { encoding: "utf8", mode: 0o700, flag: "wx" });
  chmodSync(clientPath, 0o700);
  return {
    ...worker.env,
    PATH: `${worker.runtime}${delimiter}${worker.env.PATH ?? ""}`,
    HEADLESS_RUN_TOOL_SOCKET: access.socketPath,
    HEADLESS_RUN_TOOL_TOKEN: access.token,
    HEADLESS_RUN_TOOL_EXPIRES_AT: String(access.expiresAt),
    HEADLESS_RUN_JOB_ID: access.jobId,
    HEADLESS_RUN_SESSION_ID: access.sessionId,
    HEADLESS_RUN_TOOL_TIMEOUT_MS: String(runToolCallTimeoutMs()),
    HEADLESS_RUN_TOOL_OPERATIONS: access.operations.join(","),
  } satisfies NodeJS.ProcessEnv;
}

export function withRunToolInstructions(prompt: string, operations: readonly RunToolOperation[] = []) {
  return [
    "HEADLESS AUTHENTICATED RUN TOOLS",
    "A short-lived, run-scoped cooperation endpoint is provisioned only during this worker run.",
    "Call it through the protected helper: headless-run-tool <operation> '<json-params>'.",
    `Allowed operations: ${(operations.length > 0 ? operations : ["context", "task_status", "note", "artifact", "propose_final", "message_send", "messages_pull", "ask_for_more_work", "ask_for_backup"]).join(", ")}.`,
    "Examples:",
    `  headless-run-tool context '{"view":"summary","limit":40}'`,
    `  headless-run-tool note '{"text":"Concrete progress and evidence."}'`,
    `  headless-run-tool ask_for_backup '{"reason":"Concrete blocker and required capability."}'`,
    `  headless-run-tool ask_for_more_work '{"completed":"What was completed and verified."}'`,
    "The helper authenticates from protected environment variables. Never print those variables or copy their values.",
    "If transport is unavailable, the helper fails loudly; report that cooperation failure without bypassing containment.",
    "The endpoint cannot start runs, change policy or budgets, grant authority, choose a filesystem root, merge writes, or administer credentials.",
    "",
    "ORIGINAL REQUEST",
    prompt,
  ].join("\n");
}

const RUN_TOOL_CLIENT_SOURCE = `#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

const socketPath = process.env.HEADLESS_RUN_TOOL_SOCKET;
const relayHost = process.env.HEADLESS_RUN_TOOL_HOST;
const relayPort = Number(process.env.HEADLESS_RUN_TOOL_PORT);
const token = process.env.HEADLESS_RUN_TOOL_TOKEN;
const operation = process.argv[2];
const allowedOperations = (process.env.HEADLESS_RUN_TOOL_OPERATIONS || "").split(",").filter(Boolean);
const hasRelay = relayHost === "127.0.0.1" && Number.isSafeInteger(relayPort) && relayPort > 0 && relayPort <= 65535;
if ((!socketPath && !hasRelay) || !token || !operation) {
  console.error("usage: headless-run-tool <operation> '<json-params>'");
  process.exit(2);
}
if (!allowedOperations.includes(operation)) {
  console.error(\`run tool operation is not allowed by this credential: \${operation}\`);
  process.exit(2);
}
let params = {};
try {
  params = process.argv[3] ? JSON.parse(process.argv[3]) : {};
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("params must be an object");
} catch (error) {
  console.error(\`invalid params: \${error instanceof Error ? error.message : String(error)}\`);
  process.exit(2);
}
const id = randomUUID();
const request = JSON.stringify({ version: 1, id, token, operation, params }) + "\\n";
const socket = hasRelay ? createConnection({ host: relayHost, port: relayPort }) : createConnection(socketPath);
socket.setEncoding("utf8");
let buffer = "";
let settled = false;
const configuredTimeoutMs = Number(process.env.HEADLESS_RUN_TOOL_TIMEOUT_MS);
const baseTimeoutMs = Number.isSafeInteger(configuredTimeoutMs)
  ? Math.max(${MIN_RUN_TOOL_TIMEOUT_MS}, Math.min(${MAX_RUN_TOOL_TIMEOUT_MS}, configuredTimeoutMs))
  : ${DEFAULT_RUN_TOOL_TIMEOUT_MS};
const requestedDelegateMs = operation === "run.delegate" && Number.isSafeInteger(params.timeoutMs) ? params.timeoutMs : 60000;
const expiresAt = Number(process.env.HEADLESS_RUN_TOOL_EXPIRES_AT);
const timeoutMs = operation === "run.delegate"
  ? Math.max(baseTimeoutMs, Math.min(Number.isSafeInteger(expiresAt) ? Math.max(1, expiresAt - Date.now()) : 86400000, requestedDelegateMs + 10000))
  : baseTimeoutMs;
const timeout = setTimeout(() => socket.destroy(new Error("run tool timeout")), timeoutMs);
socket.once("connect", () => socket.write(request));
socket.on("data", (chunk) => {
  if (settled) return;
  buffer += chunk;
  if (Buffer.byteLength(buffer) > 524288) socket.destroy(new Error("run tool response exceeded limit"));
  const newline = buffer.indexOf("\\n");
  if (newline < 0) return;
  settled = true;
  clearTimeout(timeout);
  socket.end();
  try {
    const response = JSON.parse(buffer.slice(0, newline));
    if (response.id !== id) throw new Error("response id mismatch");
    if (!response.ok) throw new Error(response.error?.message || "run tool call failed");
    console.log(JSON.stringify(response.result ?? null));
    process.exitCode = 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
});
socket.once("error", (error) => {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  console.error(\`run tool unavailable: \${error.message}\`);
  process.exitCode = 1;
});
socket.once("close", () => {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  console.error("run tool unavailable: connection closed before a response");
  process.exitCode = 1;
});
`;
