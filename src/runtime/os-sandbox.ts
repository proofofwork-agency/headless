import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { WorkerEnvironmentPaths } from "./worker-environment";
import { resolveExecutable } from "./executable-read-roots";
import { secureBunUnixServe } from "./secure-socket";

export const DARWIN_SANDBOX_EXEC = "/usr/bin/sandbox-exec";
export const DARWIN_WRITE_DENIAL_PROBE = "darwin-sandbox-write-denial-v1";
export const DARWIN_MDNS_RESPONDER_SOCKET = "/private/var/run/mDNSResponder";

export interface SandboxProbeResult {
  ok: boolean;
  reason: string;
}

const LINUX_RUN_TOOL_RELAY_READY_TIMEOUT_MS = 10_000;
const LINUX_RUN_TOOL_RELAY_ECHO_TIMEOUT_MS = 15_000;
const LINUX_RUN_TOOL_RELAY_PROCESS_TIMEOUT_MS = 30_000;
const LINUX_RUN_TOOL_RELAY_SERVER_TIMEOUT_MS = 45_000;

export interface DarwinReadSandboxProfileOptions {
  workdir: string;
  worker?: WorkerEnvironmentPaths;
  runtimeReadRoots?: string[];
  denyWriteRoots?: string[];
  denyReadRoots?: string[];
  brokerPort?: number;
  network?: "denied" | "native-auth-local" | "provider-direct";
  /** Per-run daemon cooperation socket; distinct from the provider broker. */
  runToolSocket?: string;
}

export interface DarwinWriteSandboxProfileOptions {
  worktree: string;
  primaryRoot: string;
  worker?: WorkerEnvironmentPaths;
  runtimeReadRoots?: string[];
  denyWriteRoots?: string[];
  denyReadRoots?: string[];
  brokerPort?: number;
  network?: "denied" | "native-auth-local" | "provider-direct";
  /** Per-run daemon cooperation socket; distinct from the provider broker. */
  runToolSocket?: string;
}

export type DarwinSandboxProfileOptions = DarwinReadSandboxProfileOptions;

export function probeDarwinSandboxWriteDenial(): SandboxProbeResult {
  if (process.platform !== "darwin") return { ok: false, reason: `unsupported platform: ${process.platform}` };
  if (!existsSync(DARWIN_SANDBOX_EXEC)) return { ok: false, reason: `${DARWIN_SANDBOX_EXEC} is missing` };

  const dir = mkdtempSync(join(tmpdir(), "headless-sandbox-probe-"));
  const profile = join(dir, "probe.sb");
  const denied = join(dir, "denied.txt");
  try {
    writeFileSync(profile, [
      "(version 1)",
      "(deny default)",
      "(allow process*)",
      "(allow file-read*)",
      "(deny file-write*)",
    ].join("\n"));
    const control = spawnSync(DARWIN_SANDBOX_EXEC, ["-f", profile, "/bin/sh", "-c", "test -r /bin/sh"], {
      encoding: "utf-8",
      timeout: 5_000,
    });
    if (control.error) return { ok: false, reason: control.error.message };
    if (control.status !== 0) {
      const detail = (control.stderr || control.stdout || `exit ${control.status}`).trim().slice(0, 300);
      return { ok: false, reason: `sandbox-exec control probe failed: ${detail}` };
    }
    const result = spawnSync(DARWIN_SANDBOX_EXEC, ["-f", profile, "/bin/sh", "-c", `printf blocked > ${shellQuote(denied)}`], {
      encoding: "utf-8",
      timeout: 5_000,
    });
    if (result.error) return { ok: false, reason: result.error.message };
    if (existsSync(denied)) return { ok: false, reason: "probe write unexpectedly succeeded" };
    if (result.status === 0) return { ok: false, reason: "probe command exited 0 despite denied write" };
    return { ok: true, reason: "sandbox-exec denied file write" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function writeDarwinSandboxProfile(options: DarwinSandboxProfileOptions): string {
  return writeDarwinReadOnlySandboxProfile(options);
}

export function writeDarwinReadOnlySandboxProfile(options: DarwinReadSandboxProfileOptions): string {
  const dir = mkdtempSync(join(tmpdir(), "headless-sandbox-profile-"));
  const profile = join(dir, "profile.sb");
  writeFileSync(profile, buildDarwinReadOnlyProfile(options), { encoding: "utf-8", mode: 0o600 });
  return profile;
}

export function writeDarwinWriteSandboxProfile(options: DarwinWriteSandboxProfileOptions): string {
  const dir = mkdtempSync(join(tmpdir(), "headless-sandbox-profile-"));
  const profile = join(dir, "profile.sb");
  writeFileSync(profile, buildDarwinWriteProfile(options), { encoding: "utf-8", mode: 0o600 });
  return profile;
}

export function buildDarwinReadOnlyProfile(options: DarwinReadSandboxProfileOptions): string {
  const workdir = canonicalizeExistingPath(options.workdir);
  return buildDarwinProfile({
    readableRoots: [workdir, ...darwinRuntimeReadRoots(options.runtimeReadRoots)],
    readableDirectories: ancestorDirectories(workdir),
    writableRoots: workerWritableRoots(options.worker),
    denyWriteRoots: options.denyWriteRoots,
    denyReadRoots: [...repositoryCredentialPaths(workdir), ...(options.denyReadRoots ?? [])],
    brokerPorts: options.brokerPort ? [options.brokerPort] : [],
    providerDirect: options.network === "provider-direct",
    nativeAuthLocal: options.network === "native-auth-local",
    unixSockets: options.runToolSocket ? [options.runToolSocket] : [],
  });
}

export function buildDarwinWriteProfile(options: DarwinWriteSandboxProfileOptions): string {
  const worktree = canonicalizeExistingPath(options.worktree);
  const primary = canonicalizeExistingPath(options.primaryRoot);
  return buildDarwinProfile({
    readableRoots: [primary, worktree, ...darwinRuntimeReadRoots(options.runtimeReadRoots)],
    readableDirectories: ancestorDirectories(worktree),
    writableRoots: [worktree, ...workerWritableRoots(options.worker)],
    linkRoots: [worktree],
    // A linked worktree's .git file points into the primary repository. It is
    // metadata, not candidate content, and must never be replaced by a worker.
    denyWriteRoots: [primary, join(worktree, ".git"), ...(options.denyWriteRoots ?? [])],
    denyReadRoots: [
      ...repositoryCredentialPaths(primary),
      ...repositoryCredentialPaths(worktree),
      ...(options.denyReadRoots ?? []),
    ],
    brokerPorts: options.brokerPort ? [options.brokerPort] : [],
    providerDirect: options.network === "provider-direct",
    nativeAuthLocal: options.network === "native-auth-local",
    unixSockets: options.runToolSocket ? [options.runToolSocket] : [],
  });
}

function buildDarwinProfile(options: {
  readableRoots: string[];
  readableDirectories?: string[];
  writableRoots: string[];
  linkRoots?: string[];
  denyWriteRoots?: string[];
  denyReadRoots?: string[];
  brokerPorts: number[];
  providerDirect: boolean;
  nativeAuthLocal: boolean;
  unixSockets: string[];
}): string {
  const readable = uniquePaths(resolveOptionalPaths(options.readableRoots));
  const readableDirectories = uniquePaths(resolveOptionalPaths(options.readableDirectories ?? []));
  const writable = uniquePaths(resolveOptionalPaths(options.writableRoots));
  const linkable = uniquePaths(resolveOptionalPaths(options.linkRoots ?? []));
  const denyWrite = uniquePaths(resolveOptionalPaths(options.denyWriteRoots ?? []));
  const denyRead = uniquePaths(resolveOptionalPaths(options.denyReadRoots ?? []));
  const unixSockets = uniquePaths(resolveOptionalPaths(options.unixSockets));
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow signal (target self))",
    "(allow signal (target children))",
    "(allow sysctl-read)",
    "(allow file-read-metadata)",
    "(allow file-read-data (literal \"/\"))",
    // Git and ordinary shells open /dev/null read-write while sanitizing
    // standard descriptors. This exact character device carries no data and
    // granting it does not expose the rest of /dev.
    "(allow file-read* (literal \"/dev/null\"))",
    "(allow file-write* (literal \"/dev/null\"))",
    "(deny network*)",
    "(deny network-bind)",
    // Native providers need ordinary IP egress, not ambient host Unix-socket
    // access. macOS libc resolves DNS through this single system socket, so
    // provider-direct grants that socket explicitly while SSH agents,
    // keychains, Docker sockets, and daemon control sockets remain denied.
    ...(options.providerDirect ? ["(allow network-outbound (remote ip))"] : []),
    ...(options.providerDirect ? [
      `(allow network-outbound (remote unix-socket (path-literal ${sbplString(DARWIN_MDNS_RESPONDER_SOCKET)})))`,
    ] : []),
    ...(options.providerDirect || options.nativeAuthLocal ? [
      "(allow mach-lookup (global-name \"com.apple.trustd\"))",
      "(allow mach-lookup (global-name \"com.apple.ocspd\"))",
      "(allow mach-lookup (global-name \"com.apple.cfprefsd.agent\"))",
    ] : []),
    // Bun's package-script resolver walks checkout ancestors looking for a
    // workspace boundary. Permit listing only those exact directories; their
    // children remain unreadable unless separately allowlisted below.
    ...readableDirectories.map((path) => `(allow file-read-data (literal ${sbplString(path)}))`),
    ...options.brokerPorts.map((port) => `(allow network-outbound (remote ip ${sbplString(`localhost:${port}`)}))`),
    ...unixSockets.map((path) => `(allow network-outbound (remote unix-socket (path-literal ${sbplString(path)})))`),
    ...readable.map((path) => `(allow file-read* ${sbplPathFilter(path)})`),
    ...writable.map((path) => `(allow file-read* ${sbplPathFilter(path)})`),
    ...writable.map((path) => `(allow file-write* ${sbplPathFilter(path)})`),
    ...linkable.map((path) => `(allow file-link ${sbplPathFilter(path)})`),
    ...denyWrite.map((path) => `(deny file-write* ${sbplPathFilter(path)})`),
    ...denyWrite.map((path) => `(deny file-link ${sbplPathFilter(path)})`),
    ...denyRead.map((path) => `(deny file-read* ${sbplPathFilter(path)})`),
  ];
  return `${lines.join("\n")}\n`;
}

function darwinRuntimeReadRoots(extra: string[] = []): string[] {
  return [
    "/System",
    "/usr",
    "/bin",
    "/sbin",
    "/Library",
    "/private/etc",
    "/private/var/db",
    "/dev",
    "/opt/homebrew",
    "/nix/store",
    ...extra,
  ];
}

function workerWritableRoots(worker?: WorkerEnvironmentPaths): string[] {
  if (!worker) return [];
  return [worker.root, worker.home, worker.config, worker.data, worker.cache, worker.runtime, worker.temp];
}

function ancestorDirectories(path: string): string[] {
  const ancestors: string[] = [];
  let current = dirname(path);
  while (true) {
    ancestors.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return ancestors;
}

export function cleanupSandboxProfile(profilePath: string): void {
  rmSync(dirname(profilePath), { recursive: true, force: true });
}

export function canonicalizeExistingPath(path: string): string {
  return realpathSync.native(path);
}

/** macOS realpath(3) rejects socket leaves, so canonicalize their parent. */
export function canonicalizeExistingSocketPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    // Socket leaves return EOPNOTSUPP on macOS; the owner-only parent still
    // gives us a canonical mount/profile pathname. Pure profile builders also
    // accept regular fixture files, while runtime issuers verify real sockets.
    return join(realpathSync.native(dirname(path)), basename(path));
  }
}

function resolveOptionalPaths(paths: string[]): string[] {
  const resolved: string[] = [];
  for (const path of paths) {
    if (!path || !existsSync(path)) continue;
    try {
      resolved.push(lstatSync(path).isSocket() ? canonicalizeExistingSocketPath(path) : canonicalizeExistingPath(path));
    } catch {
      resolved.push(path);
    }
  }
  return resolved;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean))];
}

function sbplString(value: string): string {
  return JSON.stringify(value);
}

function sbplPathFilter(path: string): string {
  try {
    return statSync(path).isDirectory()
      ? `(subpath ${sbplString(path)})`
      : `(literal ${sbplString(path)})`;
  } catch {
    return `(subpath ${sbplString(path)})`;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export const BWRAP = "bwrap";

export interface LinuxSandboxOptions {
  workdir: string;
  worker?: WorkerEnvironmentPaths;
  denyWriteRoots?: string[];
  denyReadRoots?: string[];
  runtimeReadRoots?: string[];
  brokerSocket?: string;
  runToolSocket?: string;
  network?: "denied" | "native-auth-local" | "provider-direct";
}

export interface LinuxWriteSandboxOptions {
  worktree: string;
  primaryRoot: string;
  worker?: WorkerEnvironmentPaths;
  denyWriteRoots?: string[];
  denyReadRoots?: string[];
  runtimeReadRoots?: string[];
  brokerSocket?: string;
  runToolSocket?: string;
  network?: "denied" | "native-auth-local" | "provider-direct";
}

export function hasBwrap(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const res = spawnSync(BWRAP, ["--version"], { encoding: "utf-8", timeout: 2000 });
    return !res.error && (res.status === 0 || (res.stdout || "").includes("bubblewrap"));
  } catch {
    return false;
  }
}

// Credential roots expanded for common secrets, shells, container/k8s, cloud, git, package managers etc.
// Used for both deny-write and deny-read in read-only sandboxes. Only existing paths are returned.
export function sandboxCredentialRoots(): string[] {
  const home = homedir();
  const candidates = [
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".gnupg"),
    join(home, ".config", "gcloud"),
    join(home, ".docker"),
    join(home, ".kube"),
    join(home, ".netrc"),
    join(home, ".git-credentials"),
    join(home, ".npmrc"),
    join(home, ".claude"),
    join(home, ".codex"),
    join(home, ".config", "gh"),
    join(home, ".config", "openai"),
    join(home, ".openai"),
    join(home, ".config", "anthropic"),
    join(home, ".config", "xai"),
    join(home, ".pypirc"),
    join(home, ".pgpass"),
    join(home, ".s3cfg"),
    join(home, ".boto"),
    join(home, ".config", "huggingface"),
    join(home, ".cache", "huggingface"),
    join(home, ".gem", "credentials"),
    join(home, ".local", "share", "keyrings"),
    join(home, ".config", "sops"),
    join(home, ".age"),
    join(home, ".config", "1password"),
    join(home, "Library", "Application Support", "1Password"),
    join(home, ".cursor"),
    join(home, ".windsurf"),
    join(home, ".config", "astral"),
    // Common browser/cookie dirs (best effort)
    join(home, "Library", "Application Support", "Google", "Chrome"),
    join(home, ".config", "google-chrome"),
    // Shell RC for persistence prevention (include .zshenv which is sourced early by zsh)
    join(home, ".zshenv"),
    join(home, ".zshrc"),
    join(home, ".bashrc"),
    join(home, ".bash_profile"),
    join(home, ".profile"),
    join(home, ".zprofile"),
    join(home, ".zlogin"),
    // gitconfig and opencode config (persistence / rule bypass vectors)
    join(home, ".gitconfig"),
    join(home, ".config", "opencode"),
    join(home, ".config", "fish", "config.fish"),
    // Additional expansions
    join(home, ".bash_login"),
    join(home, ".kshrc"),
    join(home, ".shrc"),
    join(home, ".cargo", "credentials.toml"),
    join(home, ".config", "hub"),
    join(home, ".local", "share", "opencode"),
    // Expanded for .docker/.kube/.netrc/shell rcs + etc (P linux-containment)
    join(home, ".config", "aws"),
    join(home, ".gitconfig"),
    join(home, ".config", "git", "config"),
    join(home, ".config", "git", "credentials"),
    join(home, ".m2", "settings.xml"),
    join(home, ".gradle", "gradle.properties"),
    join(home, ".pip", "pip.conf"),
    join(home, ".config", "pip", "pip.conf"),
    join(home, ".yarnrc"),
    join(home, ".yarnrc.yml"),
    join(home, ".authinfo"),
    join(home, ".netrc.gpg"),
    join(home, ".secrets"),
    join(home, ".password-store"),
    join(home, ".local", "share", "gnome-keyring"),
    join(home, ".config", "libsecret"),
    join(home, ".azure"),
    join(home, ".config", "doctl"),
    join(home, ".minikube"),
    join(home, ".config", "containers"),
    join(home, ".local", "share", "containers"),
    // more shell envs
    join(home, ".zshenv"),
    join(home, ".zlogin"),
    join(home, ".zlogout"),
    join(home, ".bash_logout"),
    join(home, ".config", "bash", "bash_aliases"),
  ];
  return uniquePaths(candidates.filter((path) => existsSync(path)));
}

/**
 * Existing repository-local files that can carry provider credentials or Git
 * credential helpers. They are discovered before the sandbox starts and are
 * denied after the broader project mount/read rule, so a normal checkout stays
 * readable without exposing its local secret overlays.
 */
export function repositoryCredentialPaths(projectRoot: string): string[] {
  const root = canonicalizeExistingPath(projectRoot);
  const candidates = repositoryEnvironmentPaths(root);
  candidates.push(...gitConfigurationPaths(root));
  return uniquePaths(resolveOptionalPaths(candidates));
}

function repositoryEnvironmentPaths(root: string) {
  const credentials: string[] = [];
  const pending = [root];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      // The root was canonicalized above. A concurrent replacement makes
      // strict profile construction fail rather than broadening reads.
      throw new Error(`Unable to enumerate repository credential files: ${current}`);
    }
    visited += entries.length;
    if (visited > 250_000) {
      throw new Error(`Repository credential discovery exceeds its entry limit: ${root}`);
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (isDotEnvCredentialName(entry.name)) credentials.push(path);
      // Git metadata has a dedicated bounded resolver below. Do not traverse
      // symlinked directories or escape the canonical project tree.
      if (entry.name !== ".git" && entry.isDirectory() && !entry.isSymbolicLink()) pending.push(path);
    }
  }
  return credentials;
}

function isDotEnvCredentialName(name: string) {
  return name === ".env" || name === ".envrc" || name.startsWith(".env.");
}

function gitConfigurationPaths(root: string) {
  const marker = join(root, ".git");
  if (!existsSync(marker)) return [];
  const gitDirectories: string[] = [];
  try {
    const info = statSync(marker);
    if (info.isDirectory()) {
      gitDirectories.push(canonicalizeExistingPath(marker));
    } else if (info.isFile() && info.size <= 4_096) {
      const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(marker, "utf8"));
      if (match?.[1]) {
        const candidate = resolve(dirname(marker), match[1]);
        if (existsSync(candidate) && statSync(candidate).isDirectory()) {
          gitDirectories.push(canonicalizeExistingPath(candidate));
        }
      }
    }
  } catch {
    throw new Error(`Unable to resolve repository Git metadata: ${marker}`);
  }

  const commonDirectories = new Set<string>();
  for (const gitDirectory of gitDirectories) {
    commonDirectories.add(gitDirectory);
    const commonMarker = join(gitDirectory, "commondir");
    if (!existsSync(commonMarker)) continue;
    try {
      const info = statSync(commonMarker);
      if (!info.isFile() || info.size > 4_096) throw new Error("invalid commondir marker");
      const value = readFileSync(commonMarker, "utf8").trim();
      const candidate = resolve(gitDirectory, value);
      if (!value || !existsSync(candidate) || !statSync(candidate).isDirectory()) {
        throw new Error("invalid commondir target");
      }
      commonDirectories.add(canonicalizeExistingPath(candidate));
    } catch {
      throw new Error(`Unable to resolve repository Git common directory: ${commonMarker}`);
    }
  }

  const candidates: string[] = [];
  for (const gitDirectory of new Set([...gitDirectories, ...commonDirectories])) {
    candidates.push(join(gitDirectory, "config"), join(gitDirectory, "config.worktree"));
  }
  for (const commonDirectory of commonDirectories) {
    candidates.push(...linkedWorktreeConfigPaths(commonDirectory));
    candidates.push(...nestedModuleConfigPaths(join(commonDirectory, "modules")));
  }
  return candidates;
}

function linkedWorktreeConfigPaths(commonDirectory: string) {
  const worktrees = join(commonDirectory, "worktrees");
  if (!existsSync(worktrees)) return [];
  let entries;
  try {
    entries = readdirSync(worktrees, { withFileTypes: true });
  } catch {
    throw new Error(`Unable to enumerate linked-worktree Git configuration: ${worktrees}`);
  }
  if (entries.length > 4_096) throw new Error(`Linked-worktree Git configuration exceeds its discovery limit: ${worktrees}`);
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .flatMap((entry) => [
      join(worktrees, entry.name, "config"),
      join(worktrees, entry.name, "config.worktree"),
    ]);
}

function nestedModuleConfigPaths(modulesRoot: string) {
  if (!existsSync(modulesRoot)) return [];
  const configs: string[] = [];
  const pending = [modulesRoot];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      throw new Error(`Unable to enumerate submodule Git configuration: ${current}`);
    }
    visited += entries.length;
    if (visited > 4_096) throw new Error(`Submodule Git configuration exceeds its discovery limit: ${modulesRoot}`);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const moduleDirectory = join(current, entry.name);
      configs.push(join(moduleDirectory, "config"), join(moduleDirectory, "config.worktree"));
      const nested = join(moduleDirectory, "modules");
      if (existsSync(nested)) pending.push(nested);
    }
  }
  return configs;
}

export function buildLinuxReadOnlyArgs(opts: LinuxSandboxOptions): string[] {
  const workdir = canonicalizeExistingPath(opts.workdir);
  const denyWrite = uniquePaths([workdir, ...resolveOptionalPaths(opts.denyWriteRoots ?? [])]);
  const denyRead = uniquePaths(resolveOptionalPaths(opts.denyReadRoots ?? []));

  const args: string[] = [
    "--ro-bind", "/", "/",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--tmpfs", homedir(),
    ...linuxMountTargetParentArgs(workdir),
    "--ro-bind", workdir, workdir,
    ...(opts.network === "provider-direct" ? [] : ["--unshare-net"]),
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
  ];
  if (existsSync("/run")) args.push("--tmpfs", "/run");

  args.push(...linuxRuntimeReadArgs(opts.runtimeReadRoots));
  if (opts.brokerSocket) {
    const brokerSocket = canonicalizeExistingSocketPath(opts.brokerSocket);
    args.push(...linuxMountTargetParentArgs(brokerSocket), "--ro-bind", brokerSocket, brokerSocket);
  }
  if (opts.runToolSocket) {
    const runToolSocket = canonicalizeExistingSocketPath(opts.runToolSocket);
    args.push(...linuxMountTargetParentArgs(runToolSocket), "--ro-bind", runToolSocket, runToolSocket);
  }

  args.push(...linuxWorkerMountArgs(opts.worker));

  for (const p of denyWrite) {
    if (p !== workdir) args.push("--ro-bind", p, p);
  }
  for (const p of denyRead) {
    args.push(...linuxMaskPathArgs(p));
  }
  args.push(...linuxHostUnixSocketMaskArgs(
    [opts.brokerSocket, opts.runToolSocket].filter((path): path is string => !!path),
    [homedir(), "/tmp", "/run", ...denyRead],
    discoverLinuxHostUnixSockets(),
    [workdir, ...(opts.runtimeReadRoots ?? []), ...(opts.worker ? [opts.worker.root] : []), ...denyWrite],
  ));

  args.push("--die-with-parent", "--new-session");
  for (const path of repositoryCredentialPaths(workdir)) args.push(...linuxMaskPathArgs(path));

  return args;
}

export function buildLinuxWriteSandboxArgs(opts: LinuxWriteSandboxOptions): string[] {
  const worktree = canonicalizeExistingPath(opts.worktree);
  const primary = canonicalizeExistingPath(opts.primaryRoot);
  const denyWriteExtra = uniquePaths(resolveOptionalPaths(opts.denyWriteRoots ?? []).filter((p) => p !== primary && p !== worktree));
  const denyRead = uniquePaths(resolveOptionalPaths(opts.denyReadRoots ?? []));

  const args: string[] = [
    "--ro-bind", "/", "/",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--tmpfs", homedir(),
    ...linuxMountTargetParentArgs(primary),
    "--ro-bind", primary, primary,
    ...linuxMountTargetParentArgs(worktree),
    "--bind", worktree, worktree,
    ...(opts.network === "provider-direct" ? [] : ["--unshare-net"]),
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
  ];
  if (existsSync("/run")) args.push("--tmpfs", "/run");

  args.push(...linuxRuntimeReadArgs(opts.runtimeReadRoots));
  if (opts.brokerSocket) {
    const brokerSocket = canonicalizeExistingSocketPath(opts.brokerSocket);
    args.push(...linuxMountTargetParentArgs(brokerSocket), "--ro-bind", brokerSocket, brokerSocket);
  }
  if (opts.runToolSocket) {
    const runToolSocket = canonicalizeExistingSocketPath(opts.runToolSocket);
    args.push(...linuxMountTargetParentArgs(runToolSocket), "--ro-bind", runToolSocket, runToolSocket);
  }

  args.push(...linuxWorkerMountArgs(opts.worker));

  // The worktree itself is writable, but its linked-repository pointer is
  // daemon metadata and is over-mounted read-only.
  const gitPointer = join(worktree, ".git");
  if (existsSync(gitPointer)) args.push("--ro-bind", gitPointer, gitPointer);

  for (const p of denyWriteExtra) {
    args.push("--ro-bind", p, p);
  }
  for (const p of denyRead) {
    args.push(...linuxMaskPathArgs(p));
  }
  args.push(...linuxHostUnixSocketMaskArgs(
    [opts.brokerSocket, opts.runToolSocket].filter((path): path is string => !!path),
    [homedir(), "/tmp", "/run", ...denyRead],
    discoverLinuxHostUnixSockets(),
    [primary, worktree, ...(opts.runtimeReadRoots ?? []), ...(opts.worker ? [opts.worker.root] : []), ...denyWriteExtra],
  ));

  args.push("--die-with-parent", "--new-session");
  for (const path of uniquePaths([
    ...repositoryCredentialPaths(primary),
    ...repositoryCredentialPaths(worktree),
  ])) args.push(...linuxMaskPathArgs(path));

  return args;
}

/**
 * Mask active host filesystem Unix sockets as defense in depth. A network
 * namespace does not isolate pathname-based AF_UNIX sockets and this snapshot
 * cannot cover later-created paths; the inherited backend seccomp filter is
 * the fail-closed TOCTOU boundary. Only daemon capability sockets are exempted.
 */
export function linuxHostUnixSocketMaskArgs(
  allowedSocket?: string | string[],
  alreadyHiddenRoots: string[] = [homedir(), "/tmp", "/run"],
  socketPaths: string[] = discoverLinuxHostUnixSockets(),
  reexposedRoots: string[] = [],
) {
  const allowed = new Set((Array.isArray(allowedSocket) ? allowedSocket : allowedSocket ? [allowedSocket] : []).map(canonicalPathIfPresent));
  const hidden = uniquePaths(alreadyHiddenRoots.map(canonicalPathIfPresent));
  const reexposed = uniquePaths(reexposedRoots.map(canonicalPathIfPresent));
  const args: string[] = [];
  for (const candidate of uniquePaths(socketPaths.map(canonicalPathIfPresent))) {
    if (!candidate.startsWith("/") || allowed.has(candidate)) continue;
    if (hidden.some((root) => isPathWithin(candidate, root)) && !reexposed.some((root) => isPathWithin(candidate, root))) continue;
    try {
      if (!statSync(candidate).isSocket()) continue;
    } catch {
      continue;
    }
    args.push("--ro-bind", "/dev/null", candidate);
  }
  return args;
}

export function discoverLinuxHostUnixSockets() {
  if (process.platform !== "linux" || !existsSync("/proc/net/unix")) return [];
  try {
    const paths: string[] = [];
    for (const line of readFileSync("/proc/net/unix", "utf8").split("\n").slice(1)) {
      const match = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/.exec(line.trim());
      const path = match?.[1];
      if (path?.startsWith("/")) paths.push(path);
    }
    return uniquePaths(paths);
  } catch {
    return [];
  }
}

function canonicalPathIfPresent(path: string) {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function linuxWorkerMountArgs(worker?: WorkerEnvironmentPaths): string[] {
  if (!worker) return [];
  const args: string[] = [];
  // One mount for the owner-only worker root covers HOME/config/cache/runtime/tmp
  // and avoids overlapping bind mounts inside the new namespace.
  for (const path of uniquePaths(resolveOptionalPaths([worker.root]))) {
    args.push(...linuxMountTargetParentArgs(path), "--bind", path, path);
  }
  args.push(
    "--setenv", "HOME", worker.home,
    "--setenv", "XDG_CONFIG_HOME", worker.config,
    "--setenv", "XDG_DATA_HOME", worker.data,
    "--setenv", "XDG_CACHE_HOME", worker.cache,
    "--setenv", "XDG_RUNTIME_DIR", worker.runtime,
    "--setenv", "TMPDIR", worker.temp,
    "--setenv", "TMP", worker.temp,
    "--setenv", "TEMP", worker.temp,
  );
  return args;
}

function linuxRuntimeReadArgs(paths: string[] = []) {
  const args: string[] = [];
  for (const path of uniquePaths(resolveOptionalPaths(paths))) args.push(...linuxMountTargetParentArgs(path), "--ro-bind", path, path);
  return args;
}

function linuxMountTargetParentArgs(path: string) {
  const absolute = resolve(path);
  const maskedRoot = [homedir(), "/tmp", "/run"]
    .filter((root) => isPathWithin(absolute, root))
    .sort((left, right) => right.length - left.length)[0];
  if (!maskedRoot) return [];
  const parent = dirname(absolute);
  const rel = parent === maskedRoot ? "" : parent.slice(maskedRoot.length + 1);
  if (!rel) return [];
  const args: string[] = [];
  let current = maskedRoot;
  for (const component of rel.split("/").filter(Boolean)) {
    current = join(current, component);
    args.push("--dir", current);
  }
  return args;
}

function isPathWithin(path: string, root: string) {
  const rel = path === root ? "" : path.slice(root.length + (root.endsWith("/") ? 0 : 1));
  return path === root || (path.startsWith(`${root.replace(/\/$/, "")}/`) && !rel.startsWith(".."));
}

function linuxMaskPathArgs(path: string): string[] {
  try {
    return statSync(path).isDirectory()
      ? ["--tmpfs", path]
      : ["--ro-bind", "/dev/null", path];
  } catch {
    return [];
  }
}

/**
 * wrapWithBwrap — produce bwrap-wrapped command + noop cleanup for read-only Linux sandbox.
 * Completes the linux-containment API. Use after probe success for best results.
 */
export function wrapWithBwrap(cmd: string[], opts: LinuxSandboxOptions): { cmd: string[]; cleanup: () => void; sandboxed: boolean; reason?: string } {
  if (process.platform !== "linux") {
    return { cmd, cleanup: () => {}, sandboxed: false, reason: `unsupported platform: ${process.platform}` };
  }
  if (!hasBwrap()) {
    return { cmd, cleanup: () => {}, sandboxed: false, reason: `${BWRAP} not found in PATH` };
  }
  const bwrapArgs = buildLinuxReadOnlyArgs(opts);
  return {
    cmd: [BWRAP, ...bwrapArgs, "--", ...cmd],
    cleanup: () => {},
    sandboxed: true,
    reason: "linux-bwrap",
  };
}

export function probeLinuxBwrap(): SandboxProbeResult {
  if (process.platform !== "linux") return { ok: false, reason: `unsupported platform: ${process.platform}` };
  if (!hasBwrap()) return { ok: false, reason: `${BWRAP} not found in PATH` };
  try {
    readFileSync("/proc/net/unix", "utf8");
  } catch {
    return { ok: false, reason: "host Unix socket table is unavailable; pathname socket isolation cannot be proven" };
  }

  const dir = mkdtempSync(join(tmpdir(), "headless-bwrap-probe-"));
  const denied = join(dir, "denied.txt");
  let socketListener: ReturnType<typeof Bun.listen> | undefined;
  try {
    const bwrapArgs = [
      ...buildLinuxReadOnlyArgs({ workdir: dir }),
      "--",
      "/bin/sh",
      "-c",
      `printf blocked > ${shellQuote(denied)} || exit 42`,
    ];
    const result = spawnSync(BWRAP, bwrapArgs, {
      encoding: "utf-8",
      timeout: 5_000,
    });
    if (result.error) return { ok: false, reason: result.error.message };
    if (existsSync(denied)) return { ok: false, reason: "probe write unexpectedly succeeded" };
    if (result.status !== 42) {
      const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim().slice(0, 300);
      return { ok: false, reason: `bwrap capability probe did not reach the expected write denial: ${detail}` };
    }

    const supervisor = resolveLinuxContainmentSupervisorEntry();
    const bun = process.execPath;
    if (!supervisor || !existsSync(bun)) {
      return { ok: false, reason: "Linux containment seccomp supervisor runtime is unavailable" };
    }
    const probeSocket = join(dir, "live-host.sock");
    // Same umask guard + post-bind ownership gate as every other in-process bind,
    // even though `dir` is a 0700 mkdtemp: an exempt bind here would be the one
    // socket whose creation mode nothing verifies.
    socketListener = secureBunUnixServe(probeSocket, () => Bun.listen({ unix: probeSocket, socket: { data() {} } }));
    const socketProbe = [
      "const {createConnection}=require('node:net');",
      `const socket=createConnection(${JSON.stringify(probeSocket)});`,
      "socket.once('connect',()=>process.exit(71));",
      "socket.once('error',()=>process.exit(0));",
      "setTimeout(()=>process.exit(73),1000);",
    ].join("");
    const seccomp = spawnSync(BWRAP, [
      ...buildLinuxReadOnlyArgs({
        workdir: dir,
        runtimeReadRoots: [supervisor, bun],
        runToolSocket: probeSocket,
      }),
      "--",
      bun,
      supervisor,
      "supervise",
      "--",
      bun,
      "-e",
      socketProbe,
    ], { encoding: "utf-8", timeout: 5_000 });
    if (seccomp.error) return { ok: false, reason: `Linux seccomp capability probe failed: ${seccomp.error.message}` };
    if (seccomp.status !== 0) {
      const detail = (seccomp.stderr || seccomp.stdout || `exit ${seccomp.status}`).trim().slice(0, 300);
      return { ok: false, reason: `Linux seccomp capability probe did not deny AF_UNIX socket creation: ${detail}` };
    }
    if (process.arch === "x64") {
      const x32Probe = [
        "const {dlopen,toArrayBuffer}=require('bun:ffi');",
        "const libc=dlopen('libc.so.6',{syscall:{args:['i64','i64','i64','i64','i64','i64','i64'],returns:'i64'},__errno_location:{args:[],returns:'ptr'}});",
        "const result=libc.symbols.syscall(0x40000029,1,1,0,0,0,0);",
        "const errno=new Int32Array(toArrayBuffer(libc.symbols.__errno_location(),0,4))[0];",
        "libc.close();",
        "process.exit(result===-1n&&errno===13?0:74);",
      ].join("");
      const x32 = spawnSync(BWRAP, [
        ...buildLinuxReadOnlyArgs({
          workdir: dir,
          runtimeReadRoots: [supervisor, bun],
          runToolSocket: probeSocket,
        }),
        "--",
        bun,
        supervisor,
        "supervise",
        "--",
        bun,
        "-e",
        x32Probe,
      ], { encoding: "utf-8", timeout: 5_000 });
      if (x32.error) return { ok: false, reason: `Linux x32 seccomp probe failed: ${x32.error.message}` };
      if (x32.status !== 0) {
        const detail = (x32.stderr || x32.stdout || `exit ${x32.status}`).trim().slice(0, 300);
        return { ok: false, reason: `Linux seccomp capability probe did not reject the x32 syscall ABI: ${detail}` };
      }
    }
    return { ok: true, reason: "bwrap denied writes and seccomp denied native and alternate-ABI backend Unix sockets" };
  } finally {
    socketListener?.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Prove the complete Linux run-tool transport, not merely socket visibility.
 *
 * The filtered backend is intentionally unable to create AF_UNIX sockets. Its
 * helper therefore connects over private loopback to the trusted containment
 * supervisor, which forwards to the one read-only-bound daemon socket. Some
 * hosts admit bwrap while rejecting that later supervisor connection, so the
 * generic write/seccomp probe is not sufficient evidence for run tools.
 * This is a fresh diagnostic, not a containment or run-admission gate.
 */
export function probeLinuxRunToolRelay(): SandboxProbeResult {
  try {
    return runLinuxRunToolRelayProbe();
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    return {
      ok: false,
      reason: `Linux run-tool relay probe failed unexpectedly: ${detail}`,
    };
  }
}

function runLinuxRunToolRelayProbe(): SandboxProbeResult {
  if (process.platform !== "linux") return { ok: false, reason: `unsupported platform: ${process.platform}` };
  if (!hasBwrap()) return { ok: false, reason: `${BWRAP} not found in PATH` };
  const supervisor = resolveLinuxContainmentSupervisorEntry();
  const bun = process.execPath;
  if (!supervisor || !existsSync(bun)) {
    return { ok: false, reason: "Linux containment run-tool relay runtime is unavailable" };
  }

  const dir = mkdtempSync(join(tmpdir(), "headless-run-tool-relay-probe-"));
  const socketPath = join(dir, "probe.tool.sock");
  const readyPath = join(dir, "ready");
  const nonce = `headless-run-tool-relay-${process.pid}-${Date.now()}`;
  // Documented exemption from secure-socket.ts: this listener lives in a separate
  // `bun -e` child, which cannot import the shared helper in a bundled build, so
  // the umask guard and the post-bind ownership gate are restated inline here.
  // The child owns the whole sequence — bind under umask 0o077 (no
  // chmod-after-listen TOCTOU), restore, then refuse to publish the ready marker
  // unless the on-disk socket is genuinely owner-only. An async bind failure
  // arrives as an 'error' event that the try/catch below can never see, so it
  // gets its own handler rather than becoming an uncaught exception.
  const serverSource = [
    "const {lstatSync,writeFileSync}=require('node:fs');",
    "const {createServer}=require('node:net');",
    `const expected=${JSON.stringify(nonce)};`,
    "const server=createServer((socket)=>{",
    "let buffer='';socket.setEncoding('utf8');",
    "socket.on('data',(chunk)=>{buffer+=chunk;const newline=buffer.indexOf('\\n');if(newline<0)return;",
    "const value=buffer.slice(0,newline);socket.end((value===expected?expected:'mismatch')+'\\n');server.close();});",
    "});",
    "const previousUmask=process.umask(0o077);",
    "server.once('error',()=>{process.umask(previousUmask);process.exit(76);});",
    "try{",
    `server.listen(${JSON.stringify(socketPath)},()=>{process.umask(previousUmask);`,
    `const info=lstatSync(${JSON.stringify(socketPath)});`,
    "if(!info.isSocket()||(info.mode&0o077)!==0||typeof process.getuid!=='function'||info.uid!==process.getuid())process.exit(77);",
    `writeFileSync(${JSON.stringify(readyPath)},'ready',{mode:0o600});});`,
    "}catch(error){process.umask(previousUmask);throw error;}",
    `setTimeout(()=>process.exit(78),${LINUX_RUN_TOOL_RELAY_SERVER_TIMEOUT_MS});`,
  ].join("");
  const server = spawn(bun, ["-e", serverSource], { cwd: dir, stdio: "ignore" });
  // A launch failure is reported by the bounded readiness check below. Keep
  // Node's ChildProcess error event from becoming an unrelated process-level
  // exception while this synchronous capability probe is waiting.
  server.once("error", () => {});
  try {
    const readyDeadline = Date.now() + LINUX_RUN_TOOL_RELAY_READY_TIMEOUT_MS;
    while (!existsSync(readyPath) && Date.now() < readyDeadline) sleepSync(5);
    if (!existsSync(readyPath) || !existsSync(socketPath) || !statSync(socketPath).isSocket()) {
      return { ok: false, reason: "Linux run-tool relay probe server did not become ready" };
    }

    const clientSource = [
      "const {createConnection}=require('node:net');",
      `const expected=${JSON.stringify(nonce)};`,
      "const host=process.env.HEADLESS_RUN_TOOL_HOST;const port=Number(process.env.HEADLESS_RUN_TOOL_PORT);",
      "if(host!=='127.0.0.1'||!Number.isSafeInteger(port)){console.error('stage=configuration invalid relay endpoint');process.exit(79);}",
      "let stage='connect';const socket=createConnection({host,port});let buffer='';socket.setEncoding('utf8');",
      `const timeout=setTimeout(()=>{console.error('stage='+stage+' timeout after ${LINUX_RUN_TOOL_RELAY_ECHO_TIMEOUT_MS}ms');socket.destroy();process.exit(80);},${LINUX_RUN_TOOL_RELAY_ECHO_TIMEOUT_MS});`,
      "socket.once('connect',()=>{stage='echo';socket.write(expected+'\\n');});",
      "socket.on('data',(chunk)=>{buffer+=chunk;const newline=buffer.indexOf('\\n');if(newline<0)return;clearTimeout(timeout);socket.end();const actual=buffer.slice(0,newline);if(actual!==expected)console.error('stage=echo foreign response');process.exit(actual===expected?0:81);});",
      "socket.once('error',(error)=>{clearTimeout(timeout);console.error('stage='+stage+' error '+(error.code||error.message));process.exit(82);});",
      "socket.once('close',()=>{if(buffer.indexOf('\\n')<0){clearTimeout(timeout);console.error('stage='+stage+' closed before response');process.exit(83);}});",
    ].join("");
    const result = spawnSync(BWRAP, [
      ...buildLinuxReadOnlyArgs({
        workdir: dir,
        runtimeReadRoots: [supervisor, bun],
        runToolSocket: socketPath,
      }),
      "--",
      bun,
      supervisor,
      "supervise",
      "--run-tool",
      socketPath,
      "38471",
      "--",
      bun,
      "-e",
      clientSource,
    ], { encoding: "utf-8", timeout: LINUX_RUN_TOOL_RELAY_PROCESS_TIMEOUT_MS });
    if (result.error) return { ok: false, reason: `Linux run-tool relay probe failed: ${result.error.message}` };
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim().slice(0, 300);
      return { ok: false, reason: `Linux run-tool relay did not complete a contained round-trip: ${detail}` };
    }
    return { ok: true, reason: "Linux run-tool relay completed a contained loopback-to-Unix round-trip" };
  } finally {
    if (server.exitCode === null) server.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
}

export function resolveLinuxContainmentSupervisorEntry() {
  const candidates = [
    join(import.meta.dir, "../broker/linux-relay.ts"),
    join(import.meta.dir, "broker/linux-relay.js"),
    join(import.meta.dir, "../broker/linux-relay.js"),
  ];
  for (const candidate of candidates) {
    const resolved = resolveExecutable(candidate, undefined);
    if (resolved) return resolved;
  }
  return null;
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Back-compat alias (probeLinuxBwrap is the canonical name per linux-containment slice)
export const probeLinuxBwrapWriteDenial = probeLinuxBwrap;

export function getLinuxKernelVersion(): { major: number; minor: number; raw: string } | null {
  if (process.platform !== "linux") return null;
  try {
    const res = spawnSync("uname", ["-r"], { encoding: "utf-8", timeout: 1000 });
    if (res.error || res.status !== 0) return null;
    const raw = (res.stdout || "").trim();
    const m = raw.match(/^(\d+)\.(\d+)/);
    if (!m) return null;
    return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10), raw };
  } catch {
    return null;
  }
}

export function hasLandlockKernelSupport(): boolean {
  const v = getLinuxKernelVersion();
  if (!v) return false;
  return v.major > 5 || (v.major === 5 && v.minor >= 13);
}

export function probeLinuxLandlock(): SandboxProbeResult {
  if (process.platform !== "linux") return { ok: false, reason: `unsupported platform: ${process.platform}` };
  return { ok: false, reason: "Landlock rules are not implemented; required Linux containment uses bubblewrap" };
}

export function probeHardlinkRisk(workdir: string, _sensitiveRoots: string[] = []): SandboxProbeResult {
  if (!workdir || !existsSync(workdir)) return { ok: false, reason: "workdir does not exist" };
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return { ok: false, reason: `unsupported platform: ${process.platform}` };
  }
  if (process.platform === "linux" && !hasBwrap()) {
    return { ok: false, reason: `${BWRAP} not found in PATH` };
  }

  let probeRoot: string;
  try {
    probeRoot = mkdtempSync(join(dirname(canonicalizeExistingPath(workdir)), ".headless-hardlink-probe-"));
  } catch {
    probeRoot = mkdtempSync(join(tmpdir(), "headless-hardlink-probe-"));
  }

  let profilePath: string | undefined;
  try {
    const protectedRoot = join(probeRoot, "protected");
    const worker = createProbeWorkerPaths(join(probeRoot, "worker"));
    const protectedFile = join(protectedRoot, "protected.txt");
    const alias = join(worker.temp, "alias.txt");
    const marker = "hardlink-mutation";
    mkdirSync(protectedRoot, { mode: 0o700 });
    writeFileSync(protectedFile, "original", { mode: 0o600 });

    let prefix: string[];
    if (process.platform === "darwin") {
      profilePath = writeDarwinReadOnlySandboxProfile({ workdir: protectedRoot, worker });
      prefix = [DARWIN_SANDBOX_EXEC, "-f", profilePath];
    } else {
      prefix = [BWRAP, ...buildLinuxReadOnlyArgs({ workdir: protectedRoot, worker }), "--"];
    }

    const controlFile = join(worker.temp, "control.txt");
    const control = [...prefix, "/bin/sh", "-c", `test -r ${shellQuote(protectedFile)} && printf control > ${shellQuote(controlFile)} && rm ${shellQuote(controlFile)}`];
    const controlResult = spawnSync(control[0], control.slice(1), { cwd: protectedRoot, encoding: "utf-8", timeout: 5_000 });
    if (controlResult.error) return { ok: false, reason: `hardlink control probe failed to launch: ${controlResult.error.message}` };
    if (controlResult.status !== 0) {
      return { ok: false, reason: `hardlink control probe could not use the sandbox: ${(controlResult.stderr || "unknown failure").trim().slice(0, 300)}` };
    }

    const command = [...prefix, "/bin/sh", "-c", `ln ${shellQuote(protectedFile)} ${shellQuote(alias)} && printf ${shellQuote(marker)} > ${shellQuote(alias)}`];
    const result = spawnSync(command[0], command.slice(1), { cwd: protectedRoot, encoding: "utf-8", timeout: 5_000 });
    if (result.error) return { ok: false, reason: `hardlink mutation probe failed to launch: ${result.error.message}` };
    if (readFileSync(protectedFile, "utf-8") !== "original") {
      return { ok: false, reason: "sandbox allowed hardlink alias mutation of a protected file" };
    }
    if (existsSync(alias)) {
      return { ok: false, reason: "sandbox allowed a hardlink from protected project data into worker-writable storage" };
    }
    return { ok: true, reason: "sandbox denied hardlink creation and protected-file mutation" };
  } finally {
    if (profilePath) cleanupSandboxProfile(profilePath);
    rmSync(probeRoot, { recursive: true, force: true });
  }
}

function createProbeWorkerPaths(root: string): WorkerEnvironmentPaths {
  const worker = {
    root,
    home: join(root, "home"),
    config: join(root, "config"),
    data: join(root, "data"),
    cache: join(root, "cache"),
    runtime: join(root, "runtime"),
    temp: join(root, "tmp"),
  };
  for (const path of Object.values(worker)) mkdirSync(path, { recursive: true, mode: 0o700 });
  return worker;
}
