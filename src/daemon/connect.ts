import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { HeadlessDaemonClient } from "./client";
import { getProjectStatePaths, type ProjectStateOptions } from "../runtime/project-state";
import { integrationTokenPath } from "../runtime/credential-store";
import { HeadlessError } from "../runtime/headless-error";
import {
  DAEMON_EXTENSION_MANIFEST_ENV,
  resolveDaemonExtensionConfig,
  serializeDaemonExtensionManifest,
  type ResolvedDaemonExtensionConfig,
} from "../runtime/daemon-extensions";
import { LEAD_ATTACHMENT_REQUIRED, leadCredentialName, readLeadBinding } from "../runtime/lead-binding";

export type ConnectDaemonOptions = {
  projectRoot: string;
  state?: ProjectStateOptions;
  credential?: { integration: string } | { observer: true };
  /** Explicitly create a missing read-only observer credential for the TUI. */
  bootstrapObserver?: boolean;
  /** Trusted startup-only extension config; it is never sent in a daemon request. */
  extensionConfigPath?: string;
  /** Trusted absolute extension entrypoints used only when bootstrapping a daemon. */
  extensionModules?: readonly string[];
  /** Start or require a daemon with the explicitly enabled experimental session routes. */
  enableExperimentalSessions?: boolean;
};

/**
 * Connect to the project daemon, starting a detached daemon process when the
 * project has no live owner. Client lifetime never owns daemon lifetime.
 */
export async function connectOrStartDaemon(options: ConnectDaemonOptions) {
  const state = getProjectStatePaths(options.projectRoot, options.state);
  const expectedExtensions = extensionConfigurationRequested(options)
    ? resolveDaemonExtensionConfig({
        configPath: options.extensionConfigPath,
        modulePaths: options.extensionModules,
        env: options.state?.env,
      })
    : null;
  const requested = await tryClient(state.canonicalProjectRoot, options, 500, expectedExtensions);
  if (requested) return requested;

  let root = await tryClient(state.canonicalProjectRoot, { ...options, credential: undefined }, 500, expectedExtensions);
  if (!root) {
    const entrypoint = daemonEntrypoint();
    const spawnExtensions = expectedExtensions ?? resolveDaemonExtensionConfig({ env: {} });
    const childEnv = { ...process.env, ...(options.state?.env ?? {}) };
    // The child receives the parent's exact canonical paths and content hashes
    // through startup-only process state. It never re-resolves a possibly
    // replaced config and no executable path enters a daemon request.
    delete childEnv.HEADLESS_EXTENSION_CONFIG;
    childEnv[DAEMON_EXTENSION_MANIFEST_ENV] = serializeDaemonExtensionManifest(spawnExtensions);
    const childArguments = [
        process.execPath,
        entrypoint,
        "daemon",
        "serve",
        "--cwd",
        state.canonicalProjectRoot,
      ];
    if (options.enableExperimentalSessions) childArguments.push("--experimental-sessions");
    const child = Bun.spawn(
      childArguments,
      {
        detached: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        env: childEnv,
      },
    );
    child.unref();
    root = await waitForRootClient(state.canonicalProjectRoot, options, child, expectedExtensions);
  }

  if (!options.credential) return root;
  const resumed = await tryClient(state.canonicalProjectRoot, options, 2_000, expectedExtensions);
  if (resumed) return resumed;
  if ("observer" in options.credential) {
    if (!options.bootstrapObserver) throw new HeadlessError("CREDENTIAL_MISSING", "Observer credential is not installed. Explicit bootstrap is required.");
    await root.call("auth.provisionObserver");
    const observer = await tryClient(state.canonicalProjectRoot, options, 2_000, expectedExtensions);
    if (!observer) throw new HeadlessError("DAEMON_AUTH_FAILED", "Provisioned observer credential could not authenticate.");
    return observer;
  }
  const integrationId = `integration:${options.credential.integration.trim().toLowerCase()}`;
  const records = await root.call<Array<{ id: string; revokedAt: number | null }>>("auth.list");
  const record = records.find((candidate) => candidate.id === integrationId);
  if (record?.revokedAt !== null && record?.revokedAt !== undefined) {
    throw new HeadlessError("CREDENTIAL_REVOKED", `Integration credential ${integrationId} was revoked.`);
  }
  const tokenPath = integrationTokenPath(state, options.credential.integration);
  if (existsSync(tokenPath)) {
    throw new HeadlessError("DAEMON_AUTH_FAILED", `Integration credential ${integrationId} could not authenticate; its existing token will not be rotated during connect.`);
  }
  throw new HeadlessError(
    "CREDENTIAL_MISSING",
    `Integration credential ${integrationId} is not installed. Configure the foreground host with \`headless lead use <host>\`; generic integration bootstrap was removed.`,
  );
}

/** Connect to an already-running daemon without ever bootstrapping one. */
export async function connectExistingDaemon(options: ConnectDaemonOptions) {
  const state = getProjectStatePaths(options.projectRoot, options.state);
  const expectedExtensions = extensionConfigurationRequested(options)
    ? resolveDaemonExtensionConfig({
        configPath: options.extensionConfigPath,
        modulePaths: options.extensionModules,
        env: options.state?.env,
      })
    : null;
  return tryClient(state.canonicalProjectRoot, options, 750, expectedExtensions);
}

export async function connectLeadDaemon(options: Omit<ConnectDaemonOptions, "credential" | "bootstrapObserver"> & { host: string }) {
  const state = getProjectStatePaths(options.projectRoot, options.state);
  // Read, never construct: `new LeadBindingStore(...)` materializes the whole
  // project state tree from its constructor, so probing a root that turns out to
  // be wrong would leave real-looking state behind for a project nobody created.
  const binding = readLeadBinding(state);
  const host = options.host.trim().toLowerCase();
  if (!binding || binding.host !== host) {
    throw new HeadlessError("CREDENTIAL_MISSING", `No active ${host} foreground lead is configured. Run \`headless lead use ${host}\` first.`);
  }
  const client = await connectOrStartDaemon({
    ...options,
    credential: { integration: leadCredentialName(binding.host, binding.generation) },
  });
  return { client, binding };
}

/** Shared attach/heartbeat lifecycle used by foreground-host MCP and plugin clients. */
export class LeadDaemonClientPool {
  private readonly connections = new Map<string, Promise<{ client: HeadlessDaemonClient; generation: number }>>();
  private readonly heartbeats = new Map<string, ReturnType<typeof setInterval>>();

  /**
   * `heartbeatIntervalMs` exists so the recovery path can be observed without a
   * 15s wall-clock wait. Both recovery mechanisms — this timer and the one-shot
   * retry in `selfHealing` — must be independently provable, or a regression in
   * either hides behind the other.
   */
  constructor(private readonly heartbeatIntervalMs = 15_000) {}

  async client(options: Omit<ConnectDaemonOptions, "credential" | "bootstrapObserver"> & { host: string }) {
    const state = getProjectStatePaths(options.projectRoot, options.state);
    const host = options.host.trim().toLowerCase();
    const key = `${state.canonicalProjectRoot}\0${host}`;
    let connection = this.connections.get(key);
    if (!connection) {
      connection = connectLeadDaemon({ ...options, projectRoot: state.canonicalProjectRoot, host }).then(async ({ client, binding }) => {
        await client.call("lead.attach", { generation: binding.generation });
        const timer = setInterval(() => {
          void this.beat(key, client, binding.generation);
        }, this.heartbeatIntervalMs);
        timer.unref?.();
        this.heartbeats.set(key, timer);
        return { client, generation: binding.generation };
      }).catch((error) => {
        this.connections.delete(key);
        throw error;
      });
      this.connections.set(key, connection);
    }
    const { client, generation } = await connection;
    return this.selfHealing(key, client, generation);
  }

  /**
   * One heartbeat, with recovery.
   *
   * A lead that is merely idle past the 45s window is marked `disconnected`
   * (`lead-binding.ts:127-135`), and every later heartbeat then fails. Attach is
   * legal from `disconnected` — `assertCurrent` checks principal and generation
   * and never looks at status — so the lapse is recoverable in one call. The
   * previous `.catch(() => {})` swallowed it instead, and because the cache entry
   * was only ever deleted on INITIAL connect failure, the pool then handed out a
   * permanently unusable client for the life of the process. That is the whole of
   * defect #1: the daemon was always willing to take the lead back.
   */
  private async beat(key: string, client: HeadlessDaemonClient, generation: number) {
    try {
      await client.call("lead.heartbeat", { generation }, 5_000);
    } catch {
      try {
        await client.call("lead.attach", { generation }, 5_000);
      } catch {
        // The binding is gone for good (rotated, released, revoked). Drop the
        // connection so the next caller rebuilds against current state rather
        // than inheriting a credential the daemon will keep refusing.
        this.evict(key);
      }
    }
  }

  private evict(key: string) {
    const timer = this.heartbeats.get(key);
    if (timer) clearInterval(timer);
    this.heartbeats.delete(key);
    this.connections.delete(key);
  }

  /**
   * The heartbeat closes the lapse within one interval, but a tool call landing
   * inside that window would still fail. Give the caller a client that re-attaches
   * and retries exactly once, so an idle harness's next request succeeds instead of
   * surfacing POLICY_DENIED for something the operator did not do wrong.
   */
  private selfHealing(key: string, client: HeadlessDaemonClient, generation: number): HeadlessDaemonClient {
    const pool = this;
    return new Proxy(client, {
      get(target, property) {
        // Everything else is read from, and bound to, the REAL client. Passing
        // the proxy as the receiver would re-bind `this` for any accessor or
        // method, which is the standard way these wrappers break a class that
        // uses genuine `#private` fields. Nothing here needs that, so do not
        // take on the hazard.
        if (property !== "call") {
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async function call(this: unknown, ...args: Parameters<HeadlessDaemonClient["call"]>) {
          try {
            return await target.call(...args);
          } catch (error) {
            // `lead.*` is the recovery path itself; retrying it would recurse.
            if (!lapsedLeadAttachment(error) || String(args[0]).startsWith("lead.")) throw error;
            try {
              await target.call("lead.attach", { generation }, 5_000);
            } catch {
              pool.evict(key);
              throw error;
            }
            return await target.call(...args);
          }
        };
      },
    });
  }

  async disconnectAll() {
    for (const timer of this.heartbeats.values()) clearInterval(timer);
    this.heartbeats.clear();
    const connections = await Promise.all([...this.connections.values()].map((value) => value.catch(() => null)));
    this.connections.clear();
    await Promise.all(connections.filter((value) => value !== null).map(({ client, generation }) =>
      client.call("lead.disconnect", { generation }, 2_000).catch(() => {}),
    ));
  }
}

/**
 * A lapsed attachment, as opposed to a genuine refusal.
 *
 * This deliberately keys on the daemon's structured reason rather than on the
 * POLICY_DENIED code. Treating every POLICY_DENIED as a lapse re-issued
 * genuinely forbidden requests: a lead calling an admin-only route (say
 * `approval.resolve`) would be denied, silently re-attached, and the forbidden
 * call sent a second time. DAEMON_AUTH_FAILED is likewise not repairable —
 * attaching with the same rejected token cannot succeed.
 */
export function lapsedLeadAttachment(error: unknown) {
  if (!error || typeof error !== "object" || !("details" in error)) return false;
  const details = (error as { details?: { reason?: unknown } }).details;
  return details?.reason === LEAD_ATTACHMENT_REQUIRED;
}

async function tryClient(
  projectRoot: string,
  options: ConnectDaemonOptions,
  timeoutMs: number,
  expectedExtensions: ResolvedDaemonExtensionConfig | null,
) {
  const state = getProjectStatePaths(projectRoot, options.state);
  const tokenPath = options.credential && "observer" in options.credential
    ? state.observerTokenPath
    : options.credential
      ? integrationTokenPath(state, options.credential.integration)
      : state.tokenPath;
  if (!existsSync(tokenPath) || !existsSync(state.socketPath)) return null;
  try {
    // `timeoutMs` bounds the LIVENESS PROBE, so it is passed to the ping alone.
    // Constructing the client with it made that probe deadline the client's
    // default for every later call, and this client is the one the caller gets
    // back — so an ordinary run.submit inherited 500ms and failed
    // DAEMON_UNAVAILABLE under any load, on an operator's machine, not only in
    // tests. The client keeps its own operational default instead.
    const client = new HeadlessDaemonClient({ projectRoot, state: options.state, credential: options.credential });
    const ping = await client.call<{ extensionConfigDigest?: string; experimentalSessionsEnabled?: boolean }>("ping", {}, timeoutMs);
    if (expectedExtensions && ping.extensionConfigDigest !== expectedExtensions.digest) {
      throw new HeadlessError("EXTENSION_CONFIG_MISMATCH", "The running Headless daemon uses a different extension configuration. Stop it before changing trusted extension modules.");
    }
    if (options.enableExperimentalSessions && ping.experimentalSessionsEnabled !== true) {
      // Availability used to depend on which command happened to start the
      // daemon first, and the remedy was to stop a healthy one — turning a
      // `session status` read into process mutation. Invoking the session
      // namespace is the consent signal; activate over the already
      // owner-authenticated socket instead, without disturbing running jobs.
      try {
        await client.call("capability.activate", {}, timeoutMs);
      } catch (error) {
        throw new HeadlessError(
          "CONFLICT",
          "The running daemon cannot enable experimental persistent sessions. It is likely an older build; finish its work, then stop it and retry.",
          { cause: error },
        );
      }
      const reping = await client.call<{ experimentalSessionsEnabled?: boolean }>("ping", {}, timeoutMs);
      if (reping.experimentalSessionsEnabled !== true) {
        throw new HeadlessError(
          "CONFLICT",
          "The running daemon reported experimental persistent sessions as still disabled after activation.",
        );
      }
    }
    return client;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error.code === "EXTENSION_CONFIG_MISMATCH" || error.code === "CONFLICT")) throw error;
    return null;
  }
}

async function waitForRootClient(
  projectRoot: string,
  options: ConnectDaemonOptions,
  child: ReturnType<typeof Bun.spawn>,
  expectedExtensions: ResolvedDaemonExtensionConfig | null,
) {
  let childExitCode: number | null = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const client = await tryClient(projectRoot, { ...options, credential: undefined }, 2_000, expectedExtensions);
    if (client) return client;
    if (child.exitCode !== null) childExitCode = child.exitCode;
    await Bun.sleep(25);
  }
  const detail = childExitCode === null ? "" : ` The bootstrap process exited with code ${childExitCode}; another concurrent bootstrap may also have failed.`;
  throw new HeadlessError("DAEMON_UNAVAILABLE", `Timed out waiting for the detached Headless daemon.${detail} Run \`headless daemon serve --cwd ${projectRoot}\` for diagnostics.`);
}

function extensionConfigurationRequested(options: ConnectDaemonOptions) {
  const env = options.state?.env ?? process.env;
  return Boolean(
    options.extensionConfigPath?.trim()
    || options.extensionModules?.length
    || env.HEADLESS_EXTENSION_CONFIG?.trim()
    || env[DAEMON_EXTENSION_MANIFEST_ENV]?.trim(),
  );
}

function daemonEntrypoint() {
  const candidates = [
    resolve(import.meta.dir, "../cli.ts"),
    resolve(import.meta.dir, "cli.js"),
    resolve(import.meta.dir, "../cli.js"),
  ];
  const entrypoint = candidates.find((candidate) => existsSync(candidate));
  if (!entrypoint) {
    throw new HeadlessError("DAEMON_UNAVAILABLE", "Cannot locate the installed Headless CLI needed to start the project daemon.");
  }
  return entrypoint;
}
