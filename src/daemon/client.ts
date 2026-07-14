import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { ensureOwnerOnlyFile, getProjectStatePaths, type ProjectStateOptions } from "../runtime/project-state";
import { integrationTokenPath } from "../runtime/credential-store";
import { HeadlessError } from "../runtime/headless-error";
import { safeJsonParse } from "../runtime/safe-json";
import { DAEMON_PROTOCOL_VERSION, DaemonResponseSchema, MAX_DAEMON_MESSAGE_BYTES, type DaemonMethod } from "./protocol";

// Council calls can contain four sequential run phases. This is transport
// lifetime only; public run timeouts remain capped at 24 hours by the schema.
export const MAX_DAEMON_TRANSPORT_TIMEOUT_MS = 4 * 86_400_000 + 120_000;

export type HeadlessDaemonClientOptions = {
  projectRoot: string;
  state?: ProjectStateOptions;
  token?: string;
  credential?: { integration: string } | { observer: true };
  timeoutMs?: number;
};

export { connectLeadDaemon, connectOrStartDaemon, LeadDaemonClientPool } from "./connect";
export type { ConnectDaemonOptions } from "./connect";

export class HeadlessDaemonClient {
  readonly state;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(options: HeadlessDaemonClientOptions) {
    this.state = getProjectStatePaths(options.projectRoot, options.state);
    const tokenPath = options.credential && "observer" in options.credential
      ? this.state.observerTokenPath
      : options.credential
        ? integrationTokenPath(this.state, options.credential.integration)
        : this.state.tokenPath;
    if (!options.token) ensureOwnerOnlyFile(tokenPath);
    this.token = options.token ?? readFileSync(tokenPath, "utf8").trim();
    this.timeoutMs = boundedTimeout(options.timeoutMs ?? 180_000);
  }

  call<T = unknown>(method: DaemonMethod, params: Record<string, unknown> = {}, timeoutMs = this.timeoutMs) {
    const id = randomUUID();
    const request = `${JSON.stringify({ version: DAEMON_PROTOCOL_VERSION, id, token: this.token, method, params })}\n`;
    const timeout = boundedTimeout(timeoutMs);
    return new Promise<T>((resolve, reject) => {
      const socket = createConnection(this.state.socketPath);
      socket.setEncoding("utf8");
      let buffer = "";
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new HeadlessError("DAEMON_UNAVAILABLE", "Timed out waiting for Headless daemon.", { retryable: true }));
      }, timeout);
      socket.once("connect", () => socket.write(request));
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > MAX_DAEMON_MESSAGE_BYTES) {
          socket.destroy();
          clearTimeout(timer);
          reject(new HeadlessError("OUTPUT_OVERFLOW", "Daemon response exceeded the message limit."));
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timer);
        socket.end();
        try {
          const response = DaemonResponseSchema.parse(safeJsonParse(buffer.slice(0, newline)));
          // The daemon mints a fresh response id when it cannot validate the
          // request envelope, so on this single-request connection an error
          // with a foreign id still describes this request's failure. Only a
          // success envelope must never be accepted across an id mismatch.
          if (response.id !== id && response.ok) {
            throw new HeadlessError("DAEMON_UNAVAILABLE", "Daemon response id mismatch.");
          }
          if (!response.ok) {
            const error = response.error;
            const staleDaemonHint = response.id !== id
              ? " The daemon answered under a different request id, which usually means it is running an older build that could not parse this request; restart it with `headless daemon serve`."
              : "";
            throw new HeadlessError(error?.code ?? "INTERNAL_ERROR", `${error?.message ?? "Daemon request failed."}${staleDaemonHint}`, {
              retryable: error?.retryable,
              details: error?.details,
            });
          }
          resolve(response.result as T);
        } catch (error) {
          reject(error);
        }
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(new HeadlessError("DAEMON_UNAVAILABLE", `Headless daemon is unavailable: ${error.message}`, { retryable: true, cause: error }));
      });
    });
  }
}

function boundedTimeout(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_DAEMON_TRANSPORT_TIMEOUT_MS) throw new TypeError("Daemon transport timeout must be a positive bounded integer.");
  return value;
}
