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

export type ConnectDaemonOptions = {
  projectRoot: string;
  state?: ProjectStateOptions;
  credential?: { integration: string };
  /** Explicitly create a missing integration credential during trusted local first-install bootstrap. */
  bootstrapIntegration?: boolean;
  /** Trusted startup-only extension config; it is never sent in a daemon request. */
  extensionConfigPath?: string;
  /** Trusted absolute extension entrypoints used only when bootstrapping a daemon. */
  extensionModules?: readonly string[];
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
    const child = Bun.spawn(
      [
        process.execPath,
        entrypoint,
        "daemon",
        "serve",
        "--cwd",
        state.canonicalProjectRoot,
      ],
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
  if (!options.bootstrapIntegration) {
    throw new HeadlessError("CREDENTIAL_MISSING", `Integration credential ${integrationId} is not installed. Explicit bootstrap is required.`);
  }
  await root.call("auth.provisionIntegration", { name: options.credential.integration });
  const integration = await tryClient(state.canonicalProjectRoot, options, 2_000, expectedExtensions);
  if (!integration) throw new HeadlessError("DAEMON_AUTH_FAILED", "Provisioned integration credential could not authenticate.");
  return integration;
}

async function tryClient(
  projectRoot: string,
  options: ConnectDaemonOptions,
  timeoutMs: number,
  expectedExtensions: ResolvedDaemonExtensionConfig | null,
) {
  const state = getProjectStatePaths(projectRoot, options.state);
  const tokenPath = options.credential
    ? integrationTokenPath(state, options.credential.integration)
    : state.tokenPath;
  if (!existsSync(tokenPath) || !existsSync(state.socketPath)) return null;
  try {
    const client = new HeadlessDaemonClient({ projectRoot, state: options.state, timeoutMs, credential: options.credential });
    const ping = await client.call<{ extensionConfigDigest?: string }>("ping", {}, timeoutMs);
    if (expectedExtensions && ping.extensionConfigDigest !== expectedExtensions.digest) {
      throw new HeadlessError("EXTENSION_CONFIG_MISMATCH", "The running Headless daemon uses a different extension configuration. Stop it before changing trusted extension modules.");
    }
    return client;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EXTENSION_CONFIG_MISMATCH") throw error;
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
