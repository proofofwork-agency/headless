import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildLinuxReadOnlyArgs,
  buildDarwinReadOnlyProfile,
  cleanupSandboxProfile,
  DARWIN_MDNS_RESPONDER_SOCKET,
  DARWIN_SANDBOX_EXEC,
  writeDarwinReadOnlySandboxProfile,
} from "../src/runtime/os-sandbox";
import {
  CLAUDE_SETUP_TOKEN_ENV,
  CLAUDE_SETUP_TOKEN_LOGICAL_ENTRY,
  installNativeAuthCapsule,
  MAX_CLAUDE_SETUP_TOKEN_BYTES,
} from "../src/runtime/native-auth-capsule";
import { createWorkerEnvironment } from "../src/runtime/worker-environment";

const roots: string[] = [];
const darwinTest = process.platform === "darwin" ? test : test.skip;
const realDarwinNetworkTest = process.platform === "darwin" && process.env.HEADLESS_REAL_NETWORK_TEST === "1"
  ? test
  : test.skip;

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("native authentication capsules", () => {
  test("copies only the backend auth file into an isolated worker and fingerprints it", () => {
    const home = fixtureRoot("headless-native-home-");
    const base = fixtureRoot("headless-native-worker-");
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ account: "subscription", token: "private" }));
    writeFileSync(join(home, ".ssh", "id_ed25519"), "must-not-copy");
    const first = createWorkerEnvironment({ baseDir: base });
    const second = createWorkerEnvironment({ baseDir: base });
    try {
      const one = installNativeAuthCapsule(first, "codex", { homeDir: home });
      const two = installNativeAuthCapsule(second, "codex", { homeDir: home });
      expect(one.available).toBe(true);
      expect(one.manifest?.fingerprint).toBe(two.manifest?.fingerprint);
      expect(one.manifest?.files).toEqual(["home/.codex/auth.json"]);
      expect(JSON.parse(readFileSync(join(first.home, ".codex", "auth.json"), "utf8"))).toEqual({ account: "subscription", token: "private" });
      expect(existsSync(join(first.home, ".ssh", "id_ed25519"))).toBe(false);
      expect(first.env.XDG_DATA_HOME).toBe(first.data);
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });

  test("gives every backend only its allowlisted login state and strips host credentials", () => {
    const home = fixtureRoot("headless-native-matrix-home-");
    const base = fixtureRoot("headless-native-matrix-worker-");
    const sources = [
      [".codex/auth.json", "codex-secret"],
      [".claude/.credentials.json", "claude-secret"],
      [".local/share/opencode/auth.json", "opencode-secret"],
      [".grok/auth.json", "grok-secret"],
      [".config/grok/auth.json", "grok-config-secret"],
      [".ssh/id_ed25519", "ssh-secret"],
      [".git-credentials", "git-secret"],
    ] as const;
    for (const [relative, contents] of sources) {
      mkdirSync(join(home, relative, ".."), { recursive: true });
      writeFileSync(join(home, relative), contents);
    }

    const expected = {
      codex: ["home/.codex/auth.json"],
      "claude-code": ["home/.claude/.credentials.json"],
      opencode: ["data/opencode/auth.json"],
      "grok-build": ["config/grok/auth.json", "home/.grok/auth.json"],
    } as const;
    const allDestinations = [...new Set(Object.values(expected).flat())];

    for (const [backend, destinations] of Object.entries(expected)) {
      const worker = createWorkerEnvironment({
        baseDir: base,
        sourceEnv: {
          PATH: process.env.PATH,
          OPENAI_API_KEY: "must-not-pass",
          ANTHROPIC_API_KEY: "must-not-pass",
          GIT_ASKPASS: "/host/askpass",
          SSH_AUTH_SOCK: "/host/agent.sock",
        },
      });
      try {
        const result = installNativeAuthCapsule(worker, backend, { homeDir: home });
        expect(result.available).toBe(true);
        expect(result.manifest?.files).toEqual(destinations);
        expect(worker.env.HOME).toBe(worker.home);
        expect(worker.env.HOME).not.toBe(home);
        expect(worker.env.OPENAI_API_KEY).toBeUndefined();
        expect(worker.env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(worker.env.GIT_ASKPASS).toBeUndefined();
        expect(worker.env.SSH_AUTH_SOCK).toBeUndefined();
        expect(statSync(worker.root).mode & 0o777).toBe(0o700);
        for (const destination of allDestinations) {
          const installed = join(worker.root, destination);
          expect(existsSync(installed)).toBe((destinations as readonly string[]).includes(destination));
          if (existsSync(installed)) expect(statSync(installed).mode & 0o777).toBe(0o600);
        }
        expect(existsSync(join(worker.home, ".ssh", "id_ed25519"))).toBe(false);
        expect(existsSync(join(worker.home, ".git-credentials"))).toBe(false);
      } finally {
        worker.cleanup();
      }
    }
  });

  test("fails closed for Claude when no supported regular-file login state exists", () => {
    const home = fixtureRoot("headless-native-claude-keychain-only-");
    const base = fixtureRoot("headless-native-claude-worker-");
    const worker = createWorkerEnvironment({ baseDir: base });
    try {
      const result = installNativeAuthCapsule(worker, "claude-code", { homeDir: home });
      expect(result).toMatchObject({
        available: false,
        manifest: null,
        reason: "Claude native login requires supported regular-file state; keychain-only login is unavailable in required containment. Run `claude setup-token`, store its output at ~/.claude/.headless-setup-token, and run `chmod 600 ~/.claude/.headless-setup-token`.",
      });
      expect(worker.env.HOME).toBe(worker.home);
      expect(worker.env.USER).toBe("headless");
      expect(worker.env.LOGNAME).toBe("headless");
    } finally {
      worker.cleanup();
    }
  });

  test("accepts Claude's bounded regular-file login capsule", () => {
    const home = fixtureRoot("headless-native-claude-file-");
    const base = fixtureRoot("headless-native-claude-file-worker-");
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ oauth: "fixture" }));
    const worker = createWorkerEnvironment({ baseDir: base });
    try {
      expect(installNativeAuthCapsule(worker, "claude-code", { homeDir: home })).toMatchObject({
        available: true,
        manifest: { files: ["home/.claude/.credentials.json"] },
      });
    } finally {
      worker.cleanup();
    }
  });

  test("prefers a valid Claude setup-token as an env-only fingerprinted capsule", () => {
    const home = fixtureRoot("headless-native-claude-setup-token-");
    const base = fixtureRoot("headless-native-claude-setup-token-worker-");
    const token = `sk-ant-oat${"A".repeat(32)}_fixture-token`;
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", ".headless-setup-token"), `  ${token}\n`, { mode: 0o600 });
    writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ oauth: "stale-file" }), { mode: 0o600 });
    const worker = createWorkerEnvironment({
      baseDir: base,
      sourceEnv: { PATH: process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: "ambient-must-not-pass" },
    });
    try {
      expect(worker.env[CLAUDE_SETUP_TOKEN_ENV]).toBeUndefined();
      const result = installNativeAuthCapsule(worker, "claude-code", { homeDir: home });
      expect(result).toMatchObject({
        available: true,
        reason: null,
        manifest: {
          backend: "claude-code",
          files: [CLAUDE_SETUP_TOKEN_LOGICAL_ENTRY],
        },
      });
      expect(result.manifest?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(worker.env[CLAUDE_SETUP_TOKEN_ENV]).toBeUndefined();
      expect(worker.credentialEnv[CLAUDE_SETUP_TOKEN_ENV]).toBe(token);
      expect(existsSync(join(worker.home, ".claude", ".credentials.json"))).toBe(false);
      expect(existsSync(join(worker.home, ".claude", ".headless-setup-token"))).toBe(false);
    } finally {
      worker.cleanup();
      expect(worker.env[CLAUDE_SETUP_TOKEN_ENV]).toBeUndefined();
      expect(worker.credentialEnv[CLAUDE_SETUP_TOKEN_ENV]).toBeUndefined();
    }
  });

  test("fails closed on malformed or empty Claude setup-token files without falling back", () => {
    const cases = [
      ["empty", "", "Claude setup-token must not be empty."],
      ["malformed", "not-a-setup-token", "Claude setup-token must match the expected sk-ant-oat token format."],
    ] as const;
    for (const [name, contents, reason] of cases) {
      const home = fixtureRoot(`headless-native-claude-setup-${name}-`);
      const base = fixtureRoot(`headless-native-claude-setup-${name}-worker-`);
      mkdirSync(join(home, ".claude"));
      writeFileSync(join(home, ".claude", ".headless-setup-token"), contents, { mode: 0o600 });
      writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ oauth: "must-not-fallback" }), { mode: 0o600 });
      const worker = createWorkerEnvironment({ baseDir: base });
      try {
        expect(installNativeAuthCapsule(worker, "claude-code", { homeDir: home })).toEqual({
          available: false,
          manifest: null,
          reason,
          model: null,
        });
        expect(worker.credentialEnv[CLAUDE_SETUP_TOKEN_ENV]).toBeUndefined();
        expect(existsSync(join(worker.home, ".claude", ".credentials.json"))).toBe(false);
      } finally {
        worker.cleanup();
      }
    }
  });

  test("rejects oversized and non-owner-only Claude setup-token files", () => {
    const cases = [
      ["oversized", Buffer.alloc(MAX_CLAUDE_SETUP_TOKEN_BYTES + 1, 65), 0o600, `Claude setup-token exceeds its ${MAX_CLAUDE_SETUP_TOKEN_BYTES}-byte limit.`],
      ["permissions", Buffer.from(`sk-ant-oat${"P".repeat(32)}`), 0o644, "Claude setup-token must be owned by the current user and accessible only to that user (chmod 600)."],
    ] as const;
    for (const [name, contents, mode, reason] of cases) {
      const home = fixtureRoot(`headless-native-claude-setup-${name}-`);
      const base = fixtureRoot(`headless-native-claude-setup-${name}-worker-`);
      mkdirSync(join(home, ".claude"));
      const source = join(home, ".claude", ".headless-setup-token");
      writeFileSync(source, contents, { mode });
      chmodSync(source, mode);
      const worker = createWorkerEnvironment({ baseDir: base });
      try {
        expect(installNativeAuthCapsule(worker, "claude-code", { homeDir: home })).toMatchObject({
          available: false,
          manifest: null,
          reason,
        });
      } finally {
        worker.cleanup();
      }
    }
  });

  test("rejects symlinked and multi-hardlink Claude setup-token sources", () => {
    const symlinkHome = fixtureRoot("headless-native-claude-setup-symlink-");
    const symlinkBase = fixtureRoot("headless-native-claude-setup-symlink-worker-");
    mkdirSync(join(symlinkHome, ".claude"));
    const target = join(symlinkHome, "setup-token-target");
    writeFileSync(target, `sk-ant-oat${"S".repeat(32)}`, { mode: 0o600 });
    symlinkSync(target, join(symlinkHome, ".claude", ".headless-setup-token"));
    const symlinkWorker = createWorkerEnvironment({ baseDir: symlinkBase });
    try {
      expect(installNativeAuthCapsule(symlinkWorker, "claude-code", { homeDir: symlinkHome })).toMatchObject({
        available: false,
        manifest: null,
        reason: "Claude setup-token must be a canonical non-symlinked file at ~/.claude/.headless-setup-token.",
      });
    } finally {
      symlinkWorker.cleanup();
    }

    const hardlinkHome = fixtureRoot("headless-native-claude-setup-hardlink-");
    const hardlinkBase = fixtureRoot("headless-native-claude-setup-hardlink-worker-");
    mkdirSync(join(hardlinkHome, ".claude"));
    const alias = join(hardlinkHome, "setup-token-alias");
    writeFileSync(alias, `sk-ant-oat${"H".repeat(32)}`, { mode: 0o600 });
    linkSync(alias, join(hardlinkHome, ".claude", ".headless-setup-token"));
    const hardlinkWorker = createWorkerEnvironment({ baseDir: hardlinkBase });
    try {
      expect(installNativeAuthCapsule(hardlinkWorker, "claude-code", { homeDir: hardlinkHome })).toMatchObject({
        available: false,
        manifest: null,
        reason: "Claude setup-token must be a single-link regular file.",
      });
    } finally {
      hardlinkWorker.cleanup();
    }
  });

  test("rejects oversized login state before copying any capsule content", () => {
    const home = fixtureRoot("headless-native-oversized-");
    const base = fixtureRoot("headless-native-worker-");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), Buffer.alloc(2 * 1024 * 1024 + 1, 1));
    const worker = createWorkerEnvironment({ baseDir: base });
    try {
      const result = installNativeAuthCapsule(worker, "codex", { homeDir: home });
      expect(result).toMatchObject({ available: false, manifest: null });
      expect(result.reason).toContain("exceeds its capsule limit");
      expect(existsSync(join(worker.home, ".codex", "auth.json"))).toBe(false);
    } finally {
      worker.cleanup();
    }
  });

  test("rejects symlinked authentication state", () => {
    const home = fixtureRoot("headless-native-symlink-");
    const base = fixtureRoot("headless-native-worker-");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, "outside.json"), "{}");
    symlinkSync(join(home, "outside.json"), join(home, ".codex", "auth.json"));
    const worker = createWorkerEnvironment({ baseDir: base });
    try {
      expect(installNativeAuthCapsule(worker, "codex", { homeDir: home })).toMatchObject({
        available: false,
        manifest: null,
      });
    } finally {
      worker.cleanup();
    }
  });

  test("rejects a symlinked auth directory instead of following it to another home location", () => {
    const home = fixtureRoot("headless-native-parent-symlink-");
    const base = fixtureRoot("headless-native-worker-");
    const redirected = join(home, "redirected-codex");
    mkdirSync(redirected);
    writeFileSync(join(redirected, "auth.json"), JSON.stringify({ token: "must-not-copy" }));
    symlinkSync(redirected, join(home, ".codex"));
    const worker = createWorkerEnvironment({ baseDir: base });
    try {
      const result = installNativeAuthCapsule(worker, "codex", { homeDir: home });
      expect(result).toMatchObject({ available: false, manifest: null });
      expect(result.reason).toContain("allowlisted regular path");
      expect(existsSync(join(worker.home, ".codex", "auth.json"))).toBe(false);
    } finally {
      worker.cleanup();
    }
  });

  test("rejects hardlinked authentication state instead of copying an aliased host file", () => {
    const home = fixtureRoot("headless-native-hardlink-");
    const base = fixtureRoot("headless-native-worker-");
    const hostFile = join(home, "unrelated-host-secret");
    mkdirSync(join(home, ".codex"));
    writeFileSync(hostFile, JSON.stringify({ token: "must-not-copy" }));
    linkSync(hostFile, join(home, ".codex", "auth.json"));
    const worker = createWorkerEnvironment({ baseDir: base });
    try {
      const result = installNativeAuthCapsule(worker, "codex", { homeDir: home });
      expect(result).toMatchObject({ available: false, manifest: null });
      expect(result.reason).toContain("regular");
      expect(existsSync(join(worker.home, ".codex", "auth.json"))).toBe(false);
    } finally {
      worker.cleanup();
    }
  });

  test("keeps outer filesystem containment while enabling provider-direct egress", () => {
    const workdir = fixtureRoot("headless-native-project-");
    const base = fixtureRoot("headless-native-worker-");
    const worker = createWorkerEnvironment({ baseDir: base });
    try {
      const darwin = buildDarwinReadOnlyProfile({ workdir, worker, network: "provider-direct" });
      expect(darwin).toContain("(deny default)");
      expect(darwin).not.toContain(`(allow file-write* (subpath ${JSON.stringify(workdir)})`);
      expect(darwin).toContain("(allow network-outbound (remote ip))");
      expect(darwin).toContain(`(allow network-outbound (remote unix-socket (path-literal ${JSON.stringify(DARWIN_MDNS_RESPONDER_SOCKET)})))`);
      expect(darwin).not.toContain("(allow network-outbound)\n");
      expect(darwin).not.toContain("(allow network-outbound (remote unix-socket))");
      expect(darwin).not.toContain("com.apple.SecurityServer");
      expect(darwin).toContain("com.apple.trustd");

      const direct = buildLinuxReadOnlyArgs({ workdir, worker, network: "provider-direct" });
      const denied = buildLinuxReadOnlyArgs({ workdir, worker, network: "denied" });
      expect(direct).not.toContain("--unshare-net");
      expect(denied).toContain("--unshare-net");
      expect(direct).toContain("XDG_DATA_HOME");
      expect(direct.slice(0, 3)).toEqual(["--ro-bind", "/", "/"]);
      const canonicalWorkdir = realpathSync.native(workdir);
      expect(direct.join("\0")).toContain(["--ro-bind", canonicalWorkdir, canonicalWorkdir].join("\0"));
      expect(direct.join("\0")).toContain(["--bind", worker.root, worker.root].join("\0"));
      expect(direct.join("\0")).not.toContain(["--bind", canonicalWorkdir, canonicalWorkdir].join("\0"));
    } finally {
      worker.cleanup();
    }
  });

  darwinTest("provider-direct Seatbelt permits local IP traffic while rejecting an ambient host Unix socket", async () => {
    const workdir = fixtureRoot("headless-native-provider-direct-");
    const base = fixtureRoot("headless-native-worker-");
    const socketPath = join(workdir, "host-agent.sock");
    const socket = createServer((connection) => connection.end("host-agent-secret"));
    await listenUnix(socket, socketPath);
    const tcp = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("provider-ok") });
    const worker = createWorkerEnvironment({ baseDir: base });
    const profile = writeDarwinReadOnlySandboxProfile({ workdir, worker, network: "provider-direct" });
    try {
      const ip = Bun.spawn([DARWIN_SANDBOX_EXEC, "-f", profile, "/usr/bin/nc", "-z", "127.0.0.1", String(tcp.port)], {
        cwd: workdir,
        env: worker.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await ip.exited, await new Response(ip.stderr).text()).toBe(0);

      const unix = Bun.spawn([DARWIN_SANDBOX_EXEC, "-f", profile, "/usr/bin/nc", "-w", "1", "-U", socketPath], {
        cwd: workdir,
        env: worker.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, output] = await Promise.all([unix.exited, new Response(unix.stdout).text()]);
      expect(exitCode).not.toBe(0);
      expect(output).not.toContain("host-agent-secret");
    } finally {
      cleanupSandboxProfile(profile);
      worker.cleanup();
      tcp.stop(true);
      await new Promise<void>((resolve) => socket.close(() => resolve()));
    }
  });

  realDarwinNetworkTest("provider-direct Seatbelt resolves a public hostname through the exact mDNSResponder socket", async () => {
    const workdir = fixtureRoot("headless-native-provider-dns-");
    const base = fixtureRoot("headless-native-provider-dns-worker-");
    const worker = createWorkerEnvironment({ baseDir: base });
    const profile = writeDarwinReadOnlySandboxProfile({ workdir, worker, network: "provider-direct" });
    try {
      const hostname = Bun.spawn([
        DARWIN_SANDBOX_EXEC,
        "-f",
        profile,
        "/usr/bin/curl",
        "-sS",
        "-I",
        "--connect-timeout",
        "5",
        "--max-time",
        "10",
        "https://example.com/",
      ], {
        cwd: workdir,
        env: worker.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, output, error] = await Promise.all([
        hostname.exited,
        new Response(hostname.stdout).text(),
        new Response(hostname.stderr).text(),
      ]);
      expect(exitCode, error).toBe(0);
      expect(output).toContain("HTTP/");
    } finally {
      cleanupSandboxProfile(profile);
      worker.cleanup();
    }
  });

  realDarwinNetworkTest("provider-direct Seatbelt reaches the Codex responses WebSocket endpoint", async () => {
    const workdir = fixtureRoot("headless-native-codex-network-");
    const base = fixtureRoot("headless-native-codex-network-worker-");
    const worker = createWorkerEnvironment({ baseDir: base });
    const profile = writeDarwinReadOnlySandboxProfile({ workdir, worker, network: "provider-direct" });
    try {
      const endpoint = Bun.spawn([
        DARWIN_SANDBOX_EXEC,
        "-f",
        profile,
        "/usr/bin/curl",
        "--http1.1",
        "-sS",
        "-D",
        "-",
        "-o",
        "/dev/null",
        "--connect-timeout",
        "5",
        "--max-time",
        "10",
        "-H",
        "Connection: Upgrade",
        "-H",
        "Upgrade: websocket",
        "-H",
        "Sec-WebSocket-Version: 13",
        "-H",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "https://chatgpt.com/backend-api/codex/responses",
      ], {
        cwd: workdir,
        env: worker.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, output, error] = await Promise.all([
        endpoint.exited,
        new Response(endpoint.stdout).text(),
        new Response(endpoint.stderr).text(),
      ]);
      expect(exitCode, error).toBe(0);
      expect(output).toContain("HTTP/");
    } finally {
      cleanupSandboxProfile(profile);
      worker.cleanup();
    }
  });

  test("does not grant keychain services or provider egress to local auth probes", () => {
    const workdir = fixtureRoot("headless-native-auth-probe-");
    const base = fixtureRoot("headless-native-auth-worker-");
    const worker = createWorkerEnvironment({ baseDir: base });
    try {
      const darwin = buildDarwinReadOnlyProfile({ workdir, worker, network: "native-auth-local" });
      expect(darwin).not.toContain("com.apple.SecurityServer");
      expect(darwin).not.toContain("(allow network-outbound)\n");

      const linux = buildLinuxReadOnlyArgs({ workdir, worker, network: "native-auth-local" });
      expect(linux).toContain("--unshare-net");
    } finally {
      worker.cleanup();
    }
  });
});

function fixtureRoot(prefix: string) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

function listenUnix(server: ReturnType<typeof createServer>, path: string) {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
