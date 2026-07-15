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
import { LeadBindingStore, leadCredentialName } from "../runtime/lead-binding";

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
  const binding = new LeadBindingStore(state).status();
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

  async client(options: Omit<ConnectDaemonOptions, "credential" | "bootstrapObserver"> & { host: string }) {
    const state = getProjectStatePaths(options.projectRoot, options.state);
    const host = options.host.trim().toLowerCase();
    const key = `${state.canonicalProjectRoot}\0${host}`;
    let connection = this.connections.get(key);
    if (!connection) {
      connection = connectLeadDaemon({ ...options, projectRoot: state.canonicalProjectRoot, host }).then(async ({ client, binding }) => {
        await client.call("lead.attach", { generation: binding.generation });
        const timer = setInterval(() => {
          void client.call("lead.heartbeat", { generation: binding.generation }, 5_000).catch(() => {});
        }, 15_000);
        timer.unref?.();
        this.heartbeats.set(key, timer);
        return { client, generation: binding.generation };
      }).catch((error) => {
        this.connections.delete(key);
        throw error;
      });
      this.connections.set(key, connection);
    }
    return (await connection).client;
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
    const client = new HeadlessDaemonClient({ projectRoot, state: options.state, timeoutMs, credential: options.credential });
    const ping = await client.call<{ extensionConfigDigest?: string; experimentalSessionsEnabled?: boolean }>("ping", {}, timeoutMs);
    if (expectedExtensions && ping.extensionConfigDigest !== expectedExtensions.digest) {
      throw new HeadlessError("EXTENSION_CONFIG_MISMATCH", "The running Headless daemon uses a different extension configuration. Stop it before changing trusted extension modules.");
    }
    if (options.enableExperimentalSessions && ping.experimentalSessionsEnabled !== true) {
      throw new HeadlessError(
        "CONFLICT",
        "The running daemon does not enable experimental persistent sessions. Stop it before using the experimental session namespace.",
      );
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
