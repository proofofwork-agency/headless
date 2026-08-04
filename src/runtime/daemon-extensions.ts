import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  getBackendDefinition,
  listBackendDefinitions,
  registerBackendDefinition,
  unregisterBackendDefinition,
  validateBackendDefinition,
  type BackendDefinition,
} from "../backends/registry";
import {
  getProvider,
  listProviders,
  normalizeProviderDefinition,
  registerProvider,
  unregisterProvider,
  type ProviderDefinition,
} from "../broker/providers";
import {
  listPricing,
  PricingEntrySchema,
  registerPricing,
  unregisterPricing,
  type PricingEntry,
} from "./pricing";
import { assertTrustedAncestorChain } from "./trusted-path";

export { assertTrustedAncestorChain } from "./trusted-path";

const MAX_EXTENSION_CONFIG_BYTES = 65_536;
const MAX_EXTENSION_MODULE_BYTES = 1_048_576;
const MAX_EXTENSION_MODULES = 16;
const MAX_EXTENSION_MANIFEST_BYTES = 131_072;
const EXTENSION_LOAD_TIMEOUT_MS = 10_000;
export const DAEMON_EXTENSION_MANIFEST_ENV = "HEADLESS_EXTENSION_MANIFEST" as const;

const ExtensionConfigFileSchema = z.object({
  version: z.literal(1),
  modules: z.array(z.string().trim().min(1).max(4_096)).min(1).max(MAX_EXTENSION_MODULES),
}).strict();

const ExtensionManifestSchema = z.object({
  version: z.literal(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  modules: z.array(z.object({
    path: z.string().min(1).max(4_096),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).max(MAX_EXTENSION_MODULES),
}).strict();

export type HeadlessExtensionApi = Readonly<{
  version: 1;
  registerBackendDefinition(adapter: BackendDefinition): BackendDefinition;
  registerProvider(provider: ProviderDefinition): ProviderDefinition;
  registerPricing(entry: Parameters<typeof registerPricing>[0]): PricingEntry;
}>;

export type HeadlessExtensionRegistration = (api: HeadlessExtensionApi) => void | Promise<void>;

export type ResolvedDaemonExtensionModule = Readonly<{
  path: string;
  sha256: string;
}>;

export type ResolvedDaemonExtensionConfig = Readonly<{
  /** Canonical config path, or null for an explicit programmatic module list. */
  configPath: string | null;
  modules: readonly ResolvedDaemonExtensionModule[];
  digest: string;
}>;

export type LoadedDaemonExtensions = Readonly<{
  digest: string;
  adapters: readonly string[];
  providers: readonly string[];
  pricing: readonly string[];
}>;

export type ResolveDaemonExtensionConfigOptions = {
  /** An absolute, explicitly trusted JSON config path. */
  configPath?: string;
  /** Absolute entry modules supplied by trusted embedded-daemon code. */
  modulePaths?: readonly string[];
  env?: Readonly<NodeJS.ProcessEnv>;
};

/**
 * Resolve and fingerprint daemon extension entrypoints before process launch.
 * Nothing in the daemon request protocol calls this function: executable paths
 * are accepted only from trusted startup options or HEADLESS_EXTENSION_CONFIG.
 */
export function resolveDaemonExtensionConfig(
  options: ResolveDaemonExtensionConfigOptions = {},
): ResolvedDaemonExtensionConfig {
  const env = options.env ?? process.env;
  const envPath = env.HEADLESS_EXTENSION_CONFIG;
  const expectedManifest = nonEmpty(env[DAEMON_EXTENSION_MANIFEST_ENV]);
  if (nonEmpty(options.configPath) && nonEmpty(envPath) && options.configPath!.trim() !== envPath!.trim()) {
    throw new Error("Daemon extension config startup option conflicts with HEADLESS_EXTENSION_CONFIG.");
  }
  const requestedConfigPath = nonEmpty(options.configPath) ?? nonEmpty(envPath);
  if (expectedManifest && (requestedConfigPath || options.modulePaths?.length)) {
    throw new Error("Daemon extension manifest cannot be combined with config or module startup options.");
  }
  if (expectedManifest) return resolveExpectedManifest(expectedManifest);
  if (options.modulePaths?.length && requestedConfigPath) {
    throw new Error("Choose either a daemon extension config or explicit startup modules, not both.");
  }

  let configPath: string | null = null;
  let baseDir = process.cwd();
  let requestedModules: readonly string[] = options.modulePaths ?? [];
  if (requestedConfigPath) {
    if (!isAbsolute(requestedConfigPath)) {
      throw new Error("HEADLESS_EXTENSION_CONFIG and daemon extension config paths must be absolute.");
    }
    configPath = secureCanonicalFile(requestedConfigPath, "Daemon extension config", MAX_EXTENSION_CONFIG_BYTES);
    const raw = readFileBounded(configPath, MAX_EXTENSION_CONFIG_BYTES, "Daemon extension config");
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new Error(`Daemon extension config is not valid JSON: ${configPath}`);
    }
    requestedModules = ExtensionConfigFileSchema.parse(decoded).modules;
    baseDir = dirname(configPath);
  }

  if (requestedModules.length > MAX_EXTENSION_MODULES) {
    throw new Error(`Daemon extension config may contain at most ${MAX_EXTENSION_MODULES} modules.`);
  }
  const modules: ResolvedDaemonExtensionModule[] = [];
  const seen = new Set<string>();
  for (const requested of requestedModules) {
    if (!requested.trim()) throw new Error("Daemon extension module paths must not be empty.");
    if (!configPath && !isAbsolute(requested)) {
      throw new Error("Programmatic daemon extension module paths must be absolute.");
    }
    const candidate = isAbsolute(requested) ? requested : resolve(baseDir, requested);
    const canonical = secureCanonicalFile(candidate, "Daemon extension module", MAX_EXTENSION_MODULE_BYTES);
    if (!/\.(?:[cm]?js|[cm]?ts)$/.test(canonical)) {
      throw new Error(`Daemon extension module must be a JavaScript or TypeScript entrypoint: ${canonical}`);
    }
    if (seen.has(canonical)) throw new Error(`Duplicate daemon extension module: ${canonical}`);
    seen.add(canonical);
    const content = readFileBounded(canonical, MAX_EXTENSION_MODULE_BYTES, "Daemon extension module");
    modules.push({ path: canonical, sha256: sha256(content) });
  }

  const digest = extensionDigest(modules);
  return Object.freeze({ configPath, modules: Object.freeze(modules), digest });
}

/** Serialize an already-resolved manifest for a trusted detached-child startup channel. */
export function serializeDaemonExtensionManifest(config: ResolvedDaemonExtensionConfig) {
  const manifest = JSON.stringify({
    version: 1,
    digest: config.digest,
    modules: config.modules.map((module) => ({ path: module.path, sha256: module.sha256 })),
  });
  if (Buffer.byteLength(manifest) > MAX_EXTENSION_MANIFEST_BYTES) {
    throw new Error(`Daemon extension manifest exceeds ${MAX_EXTENSION_MANIFEST_BYTES} bytes.`);
  }
  return manifest;
}

const loadedModules = new Map<string, Promise<LoadedDaemonExtensions>>();
let processExtensionDigest: string | null = null;

/** Load every configured extension before the daemon becomes ready. */
export async function loadDaemonExtensions(
  config: ResolvedDaemonExtensionConfig,
): Promise<LoadedDaemonExtensions> {
  if (processExtensionDigest !== null && processExtensionDigest !== config.digest) {
    throw new Error(
      "A Headless process cannot host daemons with different extension configurations. Start the daemon in a fresh process.",
    );
  }
  // Adapter/provider registries are process-global. Claim the digest before
  // the first await so concurrent embedded daemons cannot observe one
  // another's configured executable extensions.
  processExtensionDigest = config.digest;
  const adapters = new Set<string>();
  const providers = new Set<string>();
  const pricing = new Set<string>();
  for (const module of config.modules) {
    const key = `${module.path}\0${module.sha256}`;
    let pending = loadedModules.get(key);
    if (!pending) {
      pending = loadExtensionModule(module);
      loadedModules.set(key, pending);
      void pending.catch(() => loadedModules.delete(key));
    }
    const loaded = await pending;
    for (const id of loaded.adapters) {
      if (!getBackendDefinition(id)) throw new Error(`Daemon extension adapter ${id} was removed after startup registration.`);
      adapters.add(id);
    }
    for (const id of loaded.providers) {
      if (!getProvider(id)) throw new Error(`Daemon extension provider ${id} was removed after startup registration.`);
      providers.add(id);
    }
    for (const id of loaded.pricing) {
      if (!listPricing().some((entry) => entry.id === id)) {
        throw new Error(`Daemon extension pricing entry ${id} was removed after startup registration.`);
      }
      pricing.add(id);
    }
  }
  return Object.freeze({
    digest: config.digest,
    adapters: Object.freeze([...adapters].sort()),
    providers: Object.freeze([...providers].sort()),
    pricing: Object.freeze([...pricing].sort()),
  });
}

async function loadExtensionModule(
  module: ResolvedDaemonExtensionModule,
): Promise<LoadedDaemonExtensions> {
  const adaptersBefore = new Map(listBackendDefinitions().map((adapter) => [adapter.id, adapter]));
  const providersBefore = new Map(listProviders().map((provider) => [provider.id, provider]));
  const pricingBefore = new Map(listPricing().map((entry) => [entry.id, entry]));
  // Revalidate the canonical path, trusted ancestor chain, and exact bytes at
  // the last possible point before import. The detached bootstrap manifest
  // supplies the expected values rather than allowing the child to re-resolve.
  verifyResolvedModule(module);
  let imported: Record<string, unknown>;
  try {
    imported = await withTimeout(
      import(`${pathToFileURL(module.path).href}?headless_sha256=${module.sha256}`),
      `Timed out importing daemon extension module: ${module.path}`,
    ) as Record<string, unknown>;
  } catch (error) {
    if (registryChanged(adaptersBefore, providersBefore, pricingBefore)) restoreRegistry(adaptersBefore, providersBefore, pricingBefore);
    throw error;
  }
  const registration = imported.registerHeadlessExtension ?? imported.default;
  if (typeof registration !== "function") {
    if (registryChanged(adaptersBefore, providersBefore, pricingBefore)) restoreRegistry(adaptersBefore, providersBefore, pricingBefore);
    throw new Error(`Daemon extension module must export default or registerHeadlessExtension as a function: ${module.path}`);
  }

  const stagedAdapters: BackendDefinition[] = [];
  const stagedProviders: ProviderDefinition[] = [];
  const stagedPricing: PricingEntry[] = [];
  const stagedAdapterIds = new Set<string>();
  const stagedProviderIds = new Set<string>();
  const stagedPricingIds = new Set<string>();
  const api: HeadlessExtensionApi = Object.freeze({
    version: 1 as const,
    registerBackendDefinition(adapter: BackendDefinition) {
      validateBackendDefinition(adapter);
      if (getBackendDefinition(adapter.id) || stagedAdapterIds.has(adapter.id)) {
        throw new Error(`Backend adapter already registered: ${adapter.id}`);
      }
      stagedAdapterIds.add(adapter.id);
      stagedAdapters.push(adapter);
      return adapter;
    },
    registerProvider(provider: ProviderDefinition) {
      const normalized = normalizeProviderDefinition(provider);
      if (getProvider(normalized.id) || stagedProviderIds.has(normalized.id)) {
        throw new Error(`Provider ${normalized.id} is already registered.`);
      }
      stagedProviderIds.add(normalized.id);
      stagedProviders.push(normalized);
      return normalized;
    },
    registerPricing(input: Parameters<typeof registerPricing>[0]) {
      const entry = PricingEntrySchema.parse(input);
      if (listPricing().some((candidate) => candidate.id === entry.id) || stagedPricingIds.has(entry.id)) {
        throw new Error(`Pricing entry ${entry.id} is already registered.`);
      }
      stagedPricingIds.add(entry.id);
      stagedPricing.push(entry);
      return { ...entry };
    },
  });
  try {
    await withTimeout(
      Promise.resolve((registration as HeadlessExtensionRegistration)(api)),
      `Timed out registering daemon extension module: ${module.path}`,
    );
  } catch (error) {
    if (registryChanged(adaptersBefore, providersBefore, pricingBefore)) restoreRegistry(adaptersBefore, providersBefore, pricingBefore);
    throw error;
  }
  const outOfBand = registryChanged(adaptersBefore, providersBefore, pricingBefore);
  if (outOfBand) {
    restoreRegistry(adaptersBefore, providersBefore, pricingBefore);
    throw new Error(
      `Daemon extension module mutated a registry outside the supplied startup API (${outOfBand}): ${module.path}`,
    );
  }
  if (stagedAdapters.length === 0 && stagedProviders.length === 0 && stagedPricing.length === 0) {
    throw new Error(`Daemon extension module did not register an adapter, provider, or pricing entry through the supplied API: ${module.path}`);
  }

  const committedAdapters: string[] = [];
  const committedProviders: string[] = [];
  const committedPricing: string[] = [];
  try {
    for (const adapter of stagedAdapters) {
      registerBackendDefinition(adapter);
      committedAdapters.push(adapter.id);
    }
    for (const provider of stagedProviders) {
      registerProvider(provider);
      committedProviders.push(provider.id);
    }
    for (const entry of stagedPricing) {
      registerPricing(entry);
      committedPricing.push(entry.id);
    }
  } catch (error) {
    for (const id of committedPricing.reverse()) unregisterPricing(id);
    for (const id of committedProviders.reverse()) unregisterProvider(id);
    for (const id of committedAdapters.reverse()) unregisterBackendDefinition(id);
    throw error;
  }
  return Object.freeze({
    digest: module.sha256,
    adapters: Object.freeze(committedAdapters),
    providers: Object.freeze(committedProviders),
    pricing: Object.freeze(committedPricing),
  });
}

function registryChanged(
  adaptersBefore: ReadonlyMap<string, BackendDefinition>,
  providersBefore: ReadonlyMap<string, ProviderDefinition>,
  pricingBefore: ReadonlyMap<string, PricingEntry>,
) {
  const adaptersAfter = new Map(listBackendDefinitions().map((adapter) => [adapter.id, adapter]));
  const providersAfter = new Map(listProviders().map((provider) => [provider.id, provider]));
  if (
    adaptersAfter.size !== adaptersBefore.size
    || [...adaptersBefore].some(([id, adapter]) => adaptersAfter.get(id) !== adapter)
  ) return "adapter registry";
  if (
    providersAfter.size !== providersBefore.size
    || [...providersBefore].some(([id, provider]) => providersAfter.get(id) !== provider)
  ) return "provider registry";
  const pricingAfter = new Map(listPricing().map((entry) => [entry.id, entry]));
  if (
    pricingAfter.size !== pricingBefore.size
    || [...pricingBefore].some(([id, entry]) => JSON.stringify(pricingAfter.get(id)) !== JSON.stringify(entry))
  ) return "pricing registry";
  return null;
}

function restoreRegistry(
  adaptersBefore: ReadonlyMap<string, BackendDefinition>,
  providersBefore: ReadonlyMap<string, ProviderDefinition>,
  pricingBefore: ReadonlyMap<string, PricingEntry>,
) {
  for (const adapter of listBackendDefinitions()) {
    if (!adaptersBefore.has(adapter.id)) unregisterBackendDefinition(adapter.id);
  }
  for (const [id, adapter] of adaptersBefore) {
    if (getBackendDefinition(id) !== adapter) registerBackendDefinition(adapter, { replace: true });
  }
  for (const provider of listProviders()) {
    if (!providersBefore.has(provider.id)) unregisterProvider(provider.id);
  }
  // Provider registration cannot replace or remove built-ins and extensions;
  // restoring a missing pre-existing custom provider is therefore sufficient.
  for (const [id, provider] of providersBefore) {
    if (!getProvider(id)) registerProvider(provider);
  }
  for (const entry of listPricing()) {
    if (!pricingBefore.has(entry.id)) unregisterPricing(entry.id);
  }
  for (const [id, entry] of pricingBefore) {
    if (!listPricing().some((candidate) => candidate.id === id)) registerPricing(entry);
  }
}

function secureCanonicalFile(path: string, label: string, maximumBytes: number) {
  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch {
    throw new Error(`${label} does not exist: ${path}`);
  }
  const info = lstatSync(canonical);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} is not a regular file: ${canonical}`);
  if (info.size > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes: ${canonical}`);
  if ((info.mode & 0o022) !== 0) throw new Error(`${label} must not be writable by group or other users: ${canonical}`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid() && info.uid !== 0) {
    throw new Error(`${label} must be owned by the daemon user or root: ${canonical}`);
  }
  assertTrustedAncestorChain(canonical, label);
  return canonical;
}

function resolveExpectedManifest(serialized: string): ResolvedDaemonExtensionConfig {
  if (Buffer.byteLength(serialized) > MAX_EXTENSION_MANIFEST_BYTES) {
    throw new Error(`Daemon extension manifest exceeds ${MAX_EXTENSION_MANIFEST_BYTES} bytes.`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized);
  } catch {
    throw new Error("Daemon extension manifest is not valid JSON.");
  }
  const manifest = ExtensionManifestSchema.parse(decoded);
  if (extensionDigest(manifest.modules) !== manifest.digest) {
    throw new Error("Daemon extension manifest digest does not match its canonical module entries.");
  }
  const seen = new Set<string>();
  const modules = manifest.modules.map((expected) => {
    if (!isAbsolute(expected.path)) throw new Error("Daemon extension manifest module paths must be absolute.");
    if (seen.has(expected.path)) throw new Error(`Duplicate daemon extension manifest module: ${expected.path}`);
    seen.add(expected.path);
    const canonical = secureCanonicalFile(expected.path, "Daemon extension module", MAX_EXTENSION_MODULE_BYTES);
    if (canonical !== expected.path) {
      throw new Error(`Daemon extension manifest path is not canonical: ${expected.path}`);
    }
    const content = readFileBounded(canonical, MAX_EXTENSION_MODULE_BYTES, "Daemon extension module");
    if (sha256(content) !== expected.sha256) {
      throw new Error(`Daemon extension module changed after parent startup resolution: ${canonical}`);
    }
    return Object.freeze({ path: canonical, sha256: expected.sha256 });
  });
  return Object.freeze({
    configPath: null,
    modules: Object.freeze(modules),
    digest: manifest.digest,
  });
}

function verifyResolvedModule(module: ResolvedDaemonExtensionModule) {
  const canonical = secureCanonicalFile(module.path, "Daemon extension module", MAX_EXTENSION_MODULE_BYTES);
  if (canonical !== module.path) {
    throw new Error(`Daemon extension module path changed after startup resolution: ${module.path}`);
  }
  const current = readFileBounded(canonical, MAX_EXTENSION_MODULE_BYTES, "Daemon extension module");
  if (sha256(current) !== module.sha256) {
    throw new Error(`Daemon extension module changed after startup resolution: ${module.path}`);
  }
}

function readFileBounded(path: string, maximumBytes: number, label: string) {
  const before = statSync(path);
  if (!before.isFile() || before.size > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes: ${path}`);
  const content = readFileSync(path);
  const after = statSync(path);
  if (
    content.byteLength > maximumBytes
    || before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs
  ) {
    throw new Error(`${label} changed while it was being read: ${path}`);
  }
  return content;
}

function withTimeout<T>(pending: Promise<T>, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), EXTENSION_LOAD_TIMEOUT_MS);
    timer.unref?.();
  });
  return Promise.race([pending, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function extensionDigest(modules: readonly ResolvedDaemonExtensionModule[]) {
  return sha256(JSON.stringify({
    version: 1,
    modules: modules.map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
  }));
}

function nonEmpty(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
