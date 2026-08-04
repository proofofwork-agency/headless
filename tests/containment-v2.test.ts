import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import {
  buildDarwinReadOnlyProfile,
  buildDarwinWriteProfile,
  buildLinuxReadOnlyArgs,
  buildLinuxWriteSandboxArgs,
  cleanupSandboxProfile,
  BWRAP,
  DARWIN_SANDBOX_EXEC,
  hasBwrap,
  linuxHostUnixSocketMaskArgs,
  probeHardlinkRisk,
  writeDarwinReadOnlySandboxProfile,
  writeDarwinWriteSandboxProfile,
} from "../src/runtime/os-sandbox";
import { createWorkerEnvironment } from "../src/runtime/worker-environment";
import { executableReadRoots, maybeWrapWithSandbox, resolveLinuxRelayEntry } from "../src/runner/simple";
import { backendDefinitions } from "../src/backends/registry";
import { ProviderBroker } from "../src/broker/server";
import { RunToolEndpointManager } from "../src/daemon/run-tool-endpoint";
import { installRunToolClient } from "../src/runtime/run-tool-client";
import { schedulingWindow, setTestTimeout } from "./support/timing";

setTestTimeout(5_000);

const cleanupRoots: string[] = [];
const darwinTest = process.platform === "darwin" ? test : test.skip;
// The privileged Linux containment step this escape hatch was written for was
// removed from .github/workflows/ci.yml, and nothing sets the variable now. The
// hatch stays for a self-hosted privileged runner, but no CI leg takes it: this
// is a bwrap case, so macOS cannot run it either, and the gate is registered as
// knowingly uncovered in tests/gated-coverage.test.ts rather than claiming a leg.
const HOSTED_LINUX_RELAY_INCOMPATIBLE = process.platform === "linux"
  && process.env.GITHUB_ACTIONS === "true"
  && process.env.HEADLESS_PRIVILEGED_CONTAINMENT_CI !== "1";
if (HOSTED_LINUX_RELAY_INCOMPATIBLE) {
  console.warn("Skipping the late-socket broker/run-tool relay lifecycle case: the hosted GitHub Linux runner cannot terminalize the relay child, and no CI leg covers this case. Run it on a local Linux machine, or set HEADLESS_PRIVILEGED_CONTAINMENT_CI=1 on a privileged self-hosted runner.");
}
// Real-sandbox tests spawn bwrap + relay + worker processes. The exact
// broker+run-tool capability test has reached the helper's 15s latency bound
// on loaded two-core Linux runners even though the transport remains healthy.
// Capability evidence is not a latency SLO, so give Linux a bounded 90s test
// ceiling while keeping the worker helper itself capped at 60s.
const SANDBOX_TEST_TIMEOUT_MS = process.platform === "linux" ? 90_000 : 30_000;
const linuxBwrapTest: typeof test | typeof test.skip = process.platform === "linux" && hasBwrap()
  ? ((name: string, fn: () => unknown | Promise<unknown>) => test(name, fn, SANDBOX_TEST_TIMEOUT_MS)) as typeof test
  : test.skip;
const linuxRelayLifecycleTest: typeof test | typeof test.skip = HOSTED_LINUX_RELAY_INCOMPATIBLE
  ? test.skip
  : linuxBwrapTest;
const linuxX64BwrapTest: typeof test | typeof test.skip = process.platform === "linux" && process.arch === "x64" && hasBwrap()
  ? ((name: string, fn: () => unknown | Promise<unknown>) => test(name, fn, SANDBOX_TEST_TIMEOUT_MS)) as typeof test
  : test.skip;

afterEach(() => {
  for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("isolated worker environment", () => {
  test("creates owner-only directories and a credential-free environment", () => {
    const base = temporaryDirectory("headless-worker-base-");
    const worker = createWorkerEnvironment({
      baseDir: base,
      sourceEnv: {
        PATH: "/usr/bin:/bin",
        LANG: "en_US.UTF-8",
        LC_ALL: "C",
        HOME: "/real/home",
        XDG_CONFIG_HOME: "/real/config",
        OPENAI_API_KEY: "secret",
        ANTHROPIC_API_KEY: "secret",
        AWS_SECRET_ACCESS_KEY: "secret",
        SSH_AUTH_SOCK: "/real/agent.sock",
        HEADLESS_LEDGER_KEY: "secret",
      },
    });

    try {
      for (const path of [worker.root, worker.home, worker.config, worker.cache, worker.runtime, worker.temp]) {
        expect(statSync(path).mode & 0o777).toBe(0o700);
      }
      expect(worker.env).toMatchObject({
        PATH: "/usr/bin:/bin",
        LANG: "en_US.UTF-8",
        LC_ALL: "C",
        HOME: worker.home,
        XDG_CONFIG_HOME: worker.config,
        XDG_CACHE_HOME: worker.cache,
        XDG_RUNTIME_DIR: worker.runtime,
        TMPDIR: worker.temp,
        USER: "headless",
        LOGNAME: "headless",
      });
      expect(worker.env.OPENAI_API_KEY).toBeUndefined();
      expect(worker.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(worker.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(worker.env.SSH_AUTH_SOCK).toBeUndefined();
      expect(worker.env.HEADLESS_LEDGER_KEY).toBeUndefined();
    } finally {
      worker.cleanup();
      worker.cleanup();
    }

    expect(existsSync(worker.root)).toBe(false);
  });
});

describe("Linux bubblewrap profiles", () => {
  test("uses a read-only host root, isolated worker mounts, and an unshared network", () => {
    const project = temporaryDirectory("headless-project-");
    writeFileSync(join(project, ".env"), "SECRET=value\n", { mode: 0o600 });
    writeFileSync(join(project, ".env.local"), "LOCAL_SECRET=value\n", { mode: 0o600 });
    writeFileSync(join(project, ".env.production.local"), "PRODUCTION_SECRET=value\n", { mode: 0o600 });
    writeFileSync(join(project, ".envrc"), "ENVRC_SECRET=value\n", { mode: 0o600 });
    mkdirSync(join(project, "packages", "api"), { recursive: true });
    writeFileSync(join(project, "packages", "api", ".env.staging"), "NESTED_SECRET=value\n", { mode: 0o600 });
    mkdirSync(join(project, ".git"));
    writeFileSync(join(project, ".git", "config"), "[credential]\nhelper = seeded-secret\n", { mode: 0o600 });
    const worker = createWorkerEnvironment({ baseDir: temporaryDirectory("headless-worker-base-") });
    const secretDirectory = temporaryDirectory("headless-secret-dir-");
    const secretFile = join(temporaryDirectory("headless-secret-file-"), "credentials");
    writeFileSync(secretFile, "secret", { mode: 0o600 });

    try {
      const args = buildLinuxReadOnlyArgs({
        workdir: project,
        worker,
        denyReadRoots: [secretDirectory, secretFile],
      });

      expect(hasArgumentPair(args, "--ro-bind", "/", "/")).toBe(true);
      expect(hasArgumentPair(args, "--bind", "/", "/")).toBe(false);
      expect(args).toContain("--unshare-net");
      expect(args).toContain("--unshare-pid");
      expect(args).toContain("--unshare-ipc");
      expect(args).toContain("--unshare-uts");
      expect(args).not.toContain("--share-net");
      expect(hasArgumentPair(args, "--bind", worker.root, worker.root)).toBe(true);
      for (const path of [worker.home, worker.config, worker.cache, worker.runtime, worker.temp]) {
        expect(hasArgumentPair(args, "--bind", path, path)).toBe(false);
      }
      expect(hasArgumentPair(args, "--tmpfs", homedir())).toBe(true);
      expect(hasArgumentPair(args, "--tmpfs", canonical(secretDirectory))).toBe(true);
      expect(hasArgumentPair(args, "--ro-bind", "/dev/null", canonical(secretFile))).toBe(true);
      expect(hasArgumentPair(args, "--ro-bind", "/dev/null", join(canonical(project), ".env"))).toBe(true);
      expect(hasArgumentPair(args, "--ro-bind", "/dev/null", join(canonical(project), ".env.local"))).toBe(true);
      expect(hasArgumentPair(args, "--ro-bind", "/dev/null", join(canonical(project), ".env.production.local"))).toBe(true);
      expect(hasArgumentPair(args, "--ro-bind", "/dev/null", join(canonical(project), ".envrc"))).toBe(true);
      expect(hasArgumentPair(args, "--ro-bind", "/dev/null", join(canonical(project), "packages", "api", ".env.staging"))).toBe(true);
      expect(hasArgumentPair(args, "--ro-bind", "/dev/null", join(canonical(project), ".git", "config"))).toBe(true);
      expect(hasArgumentPair(args, "--setenv", "HOME", worker.home)).toBe(true);
      expect(hasArgumentPair(args, "--setenv", "XDG_CONFIG_HOME", worker.config)).toBe(true);
      expect(hasArgumentPair(args, "--setenv", "XDG_CACHE_HOME", worker.cache)).toBe(true);
      expect(hasArgumentPair(args, "--setenv", "XDG_RUNTIME_DIR", worker.runtime)).toBe(true);
      expect(hasArgumentPair(args, "--setenv", "TMPDIR", worker.temp)).toBe(true);
    } finally {
      worker.cleanup();
    }
  });

  test("write mode keeps the host and primary read-only and only binds the worktree writable", () => {
    const primary = temporaryDirectory("headless-primary-");
    const worktree = temporaryDirectory("headless-worktree-");
    const worker = createWorkerEnvironment({ baseDir: temporaryDirectory("headless-worker-base-") });
    const gitPointer = join(worktree, ".git");
    const linkedGitDirectory = join(primary, ".git", "worktrees", "fixture");
    mkdirSync(linkedGitDirectory, { recursive: true });
    writeFileSync(join(primary, ".env.production"), "PRIMARY_SECRET=value\n", { mode: 0o600 });
    mkdirSync(join(primary, "services", "api"), { recursive: true });
    writeFileSync(join(primary, "services", "api", ".env.local"), "NESTED_PRIMARY_SECRET=value\n", { mode: 0o600 });
    writeFileSync(join(primary, ".git", "config"), "[credential]\nhelper = primary-secret\n", { mode: 0o600 });
    writeFileSync(join(linkedGitDirectory, "commondir"), "../..\n", { mode: 0o600 });
    writeFileSync(join(linkedGitDirectory, "config.worktree"), "[credential]\nhelper = worktree-secret\n", { mode: 0o600 });
    writeFileSync(join(worktree, ".env.local"), "WORKTREE_SECRET=value\n", { mode: 0o600 });
    mkdirSync(join(worktree, "packages", "ui"), { recursive: true });
    writeFileSync(join(worktree, "packages", "ui", ".env.test"), "NESTED_WORKTREE_SECRET=value\n", { mode: 0o600 });
    writeFileSync(gitPointer, `gitdir: ${linkedGitDirectory}\n`);

    try {
      const args = buildLinuxWriteSandboxArgs({ primaryRoot: primary, worktree, worker });
      expect(hasArgumentPair(args, "--ro-bind", "/", "/")).toBe(true);
      expect(hasArgumentPair(args, "--ro-bind", canonical(primary), canonical(primary))).toBe(true);
      expect(hasArgumentPair(args, "--bind", canonical(worktree), canonical(worktree))).toBe(true);
      expect(hasArgumentPair(args, "--ro-bind", canonical(gitPointer), canonical(gitPointer))).toBe(true);
      expect(hasArgumentPair(args, "--ro-bind", "/dev/null", join(canonical(primary), ".env.production"))).toBe(true);
      expect(hasArgumentPair(args, "--ro-bind", "/dev/null", join(canonical(primary), "services", "api", ".env.local"))).toBe(true);
      expect(hasArgumentPair(args, "--ro-bind", "/dev/null", join(canonical(primary), ".git", "config"))).toBe(true);
      expect(hasArgumentPair(args, "--ro-bind", "/dev/null", join(canonical(worktree), ".env.local"))).toBe(true);
      expect(hasArgumentPair(args, "--ro-bind", "/dev/null", join(canonical(worktree), "packages", "ui", ".env.test"))).toBe(true);
      expect(hasArgumentPair(args, "--ro-bind", "/dev/null", join(canonical(linkedGitDirectory), "config.worktree"))).toBe(true);
      expect(args).toContain("--unshare-net");
      expect(args).toContain("--unshare-pid");
      expect(args).toContain("--unshare-ipc");
      expect(args).toContain("--unshare-uts");
      expect(args).not.toContain("--share-net");
    } finally {
      worker.cleanup();
    }
  });

  test("broker mode exposes only the designated Unix socket and relay runtime", () => {
    const project = temporaryDirectory("headless-project-");
    const socket = join(temporaryDirectory("headless-broker-socket-"), "broker.sock");
    writeFileSync(socket, "fixture");
    const relay = resolveLinuxRelayEntry();
    expect(relay).toBeTruthy();
    const args = buildLinuxReadOnlyArgs({
      workdir: project,
      brokerSocket: socket,
      runtimeReadRoots: relay ? [relay] : [],
    });
    expect(hasArgumentPair(args, "--ro-bind", canonical(socket), canonical(socket))).toBe(true);
    expect(hasArgumentPair(args, "--ro-bind", canonical(relay!), canonical(relay!))).toBe(true);
    expect(args).toContain("--unshare-net");
    expect(args).not.toContain("--share-net");
  });

  test("runtime roots re-expose exact files without their sibling directories", () => {
    const project = temporaryDirectory("headless-project-");
    const runtime = temporaryDirectory("headless-linux-runtime-");
    const bun = join(runtime, "bun");
    const relay = join(runtime, "linux-relay.ts");
    const sibling = join(runtime, "host-secret");
    for (const path of [bun, relay, sibling]) writeFileSync(path, path);

    const args = buildLinuxReadOnlyArgs({ workdir: project, runtimeReadRoots: [bun, relay] });

    expect(hasArgumentPair(args, "--ro-bind", canonical(bun), canonical(bun))).toBe(true);
    expect(hasArgumentPair(args, "--ro-bind", canonical(relay), canonical(relay))).toBe(true);
    expect(hasArgumentPair(args, "--ro-bind", canonical(runtime), canonical(runtime))).toBe(false);
    expect(hasArgumentPair(args, "--ro-bind", canonical(sibling), canonical(sibling))).toBe(false);
  });

  test("masks every visible host Unix socket except the designated broker", async () => {
    const project = temporaryDirectory("headless-unix-socket-project-");
    const brokerSocket = join(project, "broker.sock");
    const forbiddenSocket = join(project, "forbidden.sock");
    const broker = createServer();
    const forbidden = createServer();
    await Promise.all([listenUnix(broker, brokerSocket), listenUnix(forbidden, forbiddenSocket)]);
    try {
      const args = linuxHostUnixSocketMaskArgs(
        brokerSocket,
        [tmpdir()],
        [brokerSocket, forbiddenSocket],
        [project],
      );
      expect(hasArgumentPair(args, "--ro-bind", "/dev/null", forbiddenSocket)).toBe(true);
      expect(hasArgumentPair(args, "--ro-bind", "/dev/null", brokerSocket)).toBe(false);
    } finally {
      broker.close();
      forbidden.close();
    }
  });

  linuxBwrapTest("cannot connect to a non-broker host Unix socket re-exposed with the project", async () => {
    const project = temporaryDirectory("headless-unix-egress-project-");
    const forbiddenSocket = join(project, "host-control.sock");
    const forbidden = createServer((socket) => socket.end("host control\n"));
    await listenUnix(forbidden, forbiddenSocket);
    try {
      const args = buildLinuxReadOnlyArgs({ workdir: project });
      expect(hasArgumentPair(args, "--ro-bind", "/dev/null", forbiddenSocket)).toBe(true);
      const script = [
        "const net=require('node:net');",
        `const socket=net.createConnection(${JSON.stringify(forbiddenSocket)});`,
        "socket.once('connect',()=>process.exit(92));",
        "socket.once('error',()=>process.exit(0));",
        "setTimeout(()=>process.exit(93),1000);",
      ].join("");
      const child = Bun.spawn([BWRAP, ...args, "--", "bun", "-e", script], {
        cwd: project,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(exitCode, stderr).toBe(0);
    } finally {
      forbidden.close();
    }
  });

  linuxBwrapTest("write containment permits candidate files but keeps the .git pointer immutable", async () => {
    const primary = temporaryDirectory("headless-linux-primary-");
    const worktree = temporaryDirectory("headless-linux-worktree-");
    const pointer = join(worktree, ".git");
    const allowed = join(worktree, "candidate.txt");
    writeFileSync(pointer, "gitdir: /daemon/owned/metadata\n");
    const args = buildLinuxWriteSandboxArgs({ primaryRoot: primary, worktree });
    const script = `printf candidate > ${shellQuote(allowed)}; if printf attacker > ${shellQuote(pointer)}; then exit 91; fi`;
    const child = Bun.spawn([BWRAP, ...args, "--", "/bin/sh", "-c", script], {
      cwd: worktree,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode, stderr).toBe(0);
    expect(readFileSync(allowed, "utf8")).toBe("candidate");
    expect(readFileSync(pointer, "utf8")).toBe("gitdir: /daemon/owned/metadata\n");
  });

  linuxBwrapTest("read containment hides repository environment and Git credentials while preserving source reads", async () => {
    const project = temporaryDirectory("headless-linux-repository-credentials-");
    const ordinary = join(project, "ordinary.txt");
    mkdirSync(join(project, "packages", "api"), { recursive: true });
    const secrets = [
      join(project, ".env"),
      join(project, ".env.local"),
      join(project, ".env.test.local"),
      join(project, ".envrc"),
      join(project, "packages", "api", ".env.production"),
      join(project, ".git", "config"),
    ];
    mkdirSync(join(project, ".git"));
    writeFileSync(ordinary, "ordinary-project-source\n");
    for (const path of secrets) writeFileSync(path, "SEEDED_REPOSITORY_SECRET\n", { mode: 0o600 });
    const args = buildLinuxReadOnlyArgs({ workdir: project });
    const script = credentialIsolationScript([ordinary], secrets);
    const child = Bun.spawn([BWRAP, ...args, "--", "/bin/sh", "-c", script], {
      cwd: project,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode, stderr).toBe(0);
  });

  linuxBwrapTest("write containment hides primary and linked-worktree credentials while preserving ordinary reads", async () => {
    const primary = temporaryDirectory("headless-linux-primary-credentials-");
    const worktree = temporaryDirectory("headless-linux-worktree-credentials-");
    const linkedGitDirectory = join(primary, ".git", "worktrees", "fixture");
    mkdirSync(linkedGitDirectory, { recursive: true });
    mkdirSync(join(primary, "services", "api"), { recursive: true });
    mkdirSync(join(worktree, "packages", "ui"), { recursive: true });
    const primarySource = join(primary, "primary-source.txt");
    const worktreeSource = join(worktree, "worktree-source.txt");
    const primaryEnv = join(primary, ".env.production.local");
    const worktreeEnv = join(worktree, ".env.local");
    const nestedPrimaryEnv = join(primary, "services", "api", ".env.local");
    const nestedWorktreeEnv = join(worktree, "packages", "ui", ".env.test");
    const primaryGitConfig = join(primary, ".git", "config");
    const worktreeGitConfig = join(linkedGitDirectory, "config.worktree");
    writeFileSync(primarySource, "ordinary-primary-source\n");
    writeFileSync(worktreeSource, "ordinary-worktree-source\n");
    writeFileSync(primaryEnv, "SEEDED_REPOSITORY_SECRET\n", { mode: 0o600 });
    writeFileSync(worktreeEnv, "SEEDED_REPOSITORY_SECRET\n", { mode: 0o600 });
    writeFileSync(nestedPrimaryEnv, "SEEDED_REPOSITORY_SECRET\n", { mode: 0o600 });
    writeFileSync(nestedWorktreeEnv, "SEEDED_REPOSITORY_SECRET\n", { mode: 0o600 });
    writeFileSync(primaryGitConfig, "SEEDED_REPOSITORY_SECRET\n", { mode: 0o600 });
    writeFileSync(join(linkedGitDirectory, "commondir"), "../..\n", { mode: 0o600 });
    writeFileSync(worktreeGitConfig, "SEEDED_REPOSITORY_SECRET\n", { mode: 0o600 });
    writeFileSync(join(worktree, ".git"), `gitdir: ${linkedGitDirectory}\n`, { mode: 0o600 });

    const args = buildLinuxWriteSandboxArgs({ primaryRoot: primary, worktree });
    const script = credentialIsolationScript(
      [primarySource, worktreeSource],
      [primaryEnv, worktreeEnv, nestedPrimaryEnv, nestedWorktreeEnv, primaryGitConfig, worktreeGitConfig],
    );
    const child = Bun.spawn([BWRAP, ...args, "--", "/bin/sh", "-c", script], {
      cwd: worktree,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode, stderr).toBe(0);
  });

  linuxBwrapTest("strict worker reaches only the scoped broker through the namespace relay", async () => {
    const project = temporaryDirectory("headless-linux-relay-project-");
    const socket = join(temporaryDirectory("headless-linux-relay-socket-"), "broker.sock");
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ relayed: true }) });
    const broker = new ProviderBroker({
      unixSocketPath: socket,
      credentials: { OPENAI_API_KEY: "parent-only-secret" },
      upstreams: { openai: `http://127.0.0.1:${upstream.port}` },
    });
    broker.start();
    const lease = broker.issueLease({
      runId: "linux-contained-relay",
      provider: "openai",
      models: ["gpt-test"],
      endpointClasses: ["responses"],
      expiresAt: Date.now() + 30_000,
      maxRequests: 1,
    });
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
    const relayPort = reservation.port;
    reservation.stop(true);
    const worker = createWorkerEnvironment({ baseDir: temporaryDirectory("headless-linux-relay-worker-") });
    const relayUrl = `http://127.0.0.1:${relayPort}`;
    const script = [
      `const brokerResponse=await fetch(${JSON.stringify(`${relayUrl}/openai/v1/responses`)},{method:"POST",headers:{authorization:${JSON.stringify(`Bearer ${lease.token}`)},"content-type":"application/json"},body:JSON.stringify({model:"gpt-test",input:"hello"})});`,
      `let direct=false;try{direct=(await fetch(${JSON.stringify(`http://127.0.0.1:${upstream.port}`)})).ok}catch{}`,
      `console.log(JSON.stringify({status:brokerResponse.status,body:await brokerResponse.text(),direct}));`,
      `if(!brokerResponse.ok||direct)process.exit(91);`,
    ].join("");
    const wrapped = maybeWrapWithSandbox(
      ["bun", "-e", script],
      { backend: "opencode", prompt: "relay", cwd: project, containment: "required", broker: { provider: "openai", baseUrl: relayUrl, token: lease.token, unixSocket: socket } },
      backendDefinitions.opencode,
      project,
      undefined,
      worker,
    );

    try {
      expect(wrapped.sandboxed, wrapped.reason).toBe(true);
      expect(wrapped.reason).toContain("broker-relay");
      const relay = canonical(resolveLinuxRelayEntry()!);
      const bun = canonical(Bun.which("bun")!);
      expect(hasArgumentPair(wrapped.cmd, "--ro-bind", relay, relay)).toBe(true);
      expect(hasArgumentPair(wrapped.cmd, "--ro-bind", bun, bun)).toBe(true);
      expect(hasArgumentPair(wrapped.cmd, "--ro-bind", dirname(relay), dirname(relay))).toBe(false);
      expect(hasArgumentPair(wrapped.cmd, "--ro-bind", dirname(bun), dirname(bun))).toBe(false);
      const child = Bun.spawn(wrapped.cmd, { cwd: project, env: worker.env, stdout: "pipe", stderr: "pipe" });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode, stderr).toBe(0);
      const observed = JSON.parse(stdout) as { status: number; body: string; direct: boolean };
      expect(observed.status).toBe(200);
      expect(observed.body).toContain('"relayed":true');
      expect(observed.direct).toBe(false);
      expect(broker.getLeaseObservation(lease.id)?.requests).toBe(1);
    } finally {
      wrapped.cleanup();
      worker.cleanup();
      broker.stop();
      upstream.stop(true);
    }
  });

  /**
   * The SECURITY invariant on its own: a host Unix socket created AFTER the
   * sandbox launched must still be unreachable from inside it.
   *
   * Split out of the combined case below deliberately. That one also requires
   * the broker relay and the run-tool helper to be reachable, and on hosted
   * x86-64 the run-tool leg is intermittent — one observed failure reported
   * `{"unixError":"ENOENT", "brokerStatus":200, "toolCode":1}`, i.e. containment
   * held and only availability broke. Gating the security property behind an
   * availability check means a flaky relay makes the security gate red, which
   * teaches people to re-run it, which is how a real breach would be waved
   * through. This case depends on nothing but bubblewrap and the seccomp
   * filter, so it can be required on hosted Linux and mean what it says.
   */
  linuxBwrapTest("denies a host Unix socket created after launch", async () => {
    const project = temporaryDirectory("headless-late-socket-pure-");
    mkdirSync(join(project, ".git"));
    const runtime = temporaryDirectory("headless-late-socket-pure-runtime-");
    // Under `project`, NOT under `runtime`. project is re-exposed into the mount
    // namespace with --ro-bind, so a socket created there after launch is
    // VISIBLE inside the sandbox and only the inherited AF_UNIX seccomp filter
    // stops the connect — which is the property under test. A path outside
    // worker.root is simply absent behind the private /tmp tmpfs, so it would
    // return ENOENT even with seccomp removed entirely: a test that cannot fail.
    const lateSocket = join(project, "late-host-pure.sock");
    const worker = createWorkerEnvironment({ baseDir: runtime });
    const marker = join(worker.temp, "worker-ready");
    const proceed = join(worker.temp, "host-socket-ready");
    const script = [
      "const {existsSync,writeFileSync}=require('node:fs');",
      "const {createConnection}=require('node:net');",
      `writeFileSync(${JSON.stringify(marker)},'ready');`,
      `for(let i=0;i<500&&!existsSync(${JSON.stringify(proceed)});i++)await Bun.sleep(10);`,
      `if(!existsSync(${JSON.stringify(proceed)}))process.exit(81);`,
      `const unixError=await new Promise((resolve)=>{const socket=createConnection(${JSON.stringify(lateSocket)});socket.once('connect',()=>resolve('CONNECTED'));socket.once('error',(error)=>resolve(error.code));});`,
      "console.log(JSON.stringify({unixError}));",
    ].join("");
    const wrapped = maybeWrapWithSandbox(
      ["bun", "-e", script],
      { backend: "opencode", prompt: "late socket", cwd: project, containment: "required" },
      backendDefinitions.opencode,
      project,
      undefined,
      worker,
    );
    const forbidden = createServer((socket) => socket.end("host control\n"));
    let forbiddenListening = false;
    try {
      expect(wrapped.sandboxed, wrapped.reason).toBe(true);
      const child = Bun.spawn(wrapped.cmd, { cwd: project, env: worker.env, stdout: "pipe", stderr: "pipe" });
      const readyDeadline = Date.now() + schedulingWindow(5_000);
      while (!existsSync(marker) && child.exitCode === null && Date.now() < readyDeadline) await Bun.sleep(10);
      expect(existsSync(marker)).toBe(true);
      // Created only now: the sandbox's mount snapshot predates it entirely.
      await listenUnix(forbidden, lateSocket);
      forbiddenListening = true;
      writeFileSync(proceed, "go");
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode, `stdout: ${stdout}\nstderr: ${stderr}`).toBe(0);
      const observed = JSON.parse(stdout) as { unixError: string };
      expect(observed.unixError, `late socket was reachable from inside the sandbox: ${stdout}`).not.toBe("CONNECTED");
    } finally {
      if (forbiddenListening) await new Promise<void>((resolve) => forbidden.close(() => resolve()));
      worker.cleanup();
    }
  });

  linuxRelayLifecycleTest("denies a host Unix socket created after launch while broker and run tools remain reachable", async () => {
    const project = temporaryDirectory("headless-linux-late-socket-project-");
    const runtime = temporaryDirectory("headless-linux-late-socket-runtime-");
    const brokerSocket = join(runtime, "broker.sock");
    const lateSocket = join(project, "late-host-control.sock");
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ broker: "ok" }) });
    const broker = new ProviderBroker({
      unixSocketPath: brokerSocket,
      credentials: { OPENAI_API_KEY: "parent-only-secret" },
      upstreams: { openai: `http://127.0.0.1:${upstream.port}` },
    });
    broker.start();
    const lease = broker.issueLease({
      runId: "linux-late-socket",
      provider: "openai",
      models: ["gpt-test"],
      endpointClasses: ["responses"],
      expiresAt: Date.now() + 90_000,
      maxRequests: 1,
    });
    const runTools = new RunToolEndpointManager({
      socketDir: runtime,
      handle: (_scope, operation) => ({ operation, transport: "run-tool-ok" }),
    });
    const endpoint = await runTools.issue({
      projectId: "a".repeat(64),
      jobId: "late-socket-job",
      sessionId: "late-socket-session",
      principal: "contained-worker",
      expiresAt: Date.now() + 90_000,
    });
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
    const relayPort = reservation.port;
    reservation.stop(true);
    const relayUrl = `http://127.0.0.1:${relayPort}`;
    const worker = createWorkerEnvironment({ baseDir: runtime });
    const marker = join(worker.temp, "worker-ready");
    const proceed = join(worker.temp, "host-socket-ready");
    Object.assign(worker.env, installRunToolClient(worker, {
      socketPath: endpoint.socketPath,
      token: endpoint.token,
      expiresAt: endpoint.scope.expiresAt,
      jobId: endpoint.scope.jobId,
      sessionId: endpoint.scope.sessionId,
    }));
    worker.env.HEADLESS_RUN_TOOL_TIMEOUT_MS = "60000";
    const script = [
      "const {existsSync,writeFileSync}=require('node:fs');",
      "const {createConnection}=require('node:net');",
      `writeFileSync(${JSON.stringify(marker)},'ready');`,
      `for(let i=0;i<500&&!existsSync(${JSON.stringify(proceed)});i++)await Bun.sleep(10);`,
      `if(!existsSync(${JSON.stringify(proceed)}))process.exit(81);`,
      `const unixError=await new Promise((resolve)=>{const socket=createConnection(${JSON.stringify(lateSocket)});socket.once('connect',()=>resolve('CONNECTED'));socket.once('error',(error)=>resolve(error.code));});`,
      `const response=await fetch(${JSON.stringify(`${relayUrl}/openai/v1/responses`)},{method:'POST',headers:{authorization:${JSON.stringify(`Bearer ${lease.token}`)},'content-type':'application/json'},body:JSON.stringify({model:'gpt-test',input:'hello'})});`,
      "const tool=Bun.spawnSync(['headless-run-tool','task_status','{}'],{env:process.env,stdout:'pipe',stderr:'pipe'});",
      "const observed={unixError,brokerStatus:response.status,brokerBody:await response.text(),toolCode:tool.exitCode,toolOutput:tool.stdout.toString(),toolError:tool.stderr.toString()};",
      "console.log(JSON.stringify(observed));",
      // Deliberately NO aggregate failure exit here. This used to exit 82 when
      // any observation was wrong, which collapsed four distinct outcomes into
      // one opaque code AND short-circuited the parent's per-field assertions
      // below, because the parent checks the exit code first. A real hosted-CI
      // failure was therefore unclassifiable: exit 82 covers both a connectable
      // late socket — a containment BREACH — and a merely unreachable broker or
      // run-tool, which is a relay-availability problem. The child now reports
      // and exits 0; the parent decides, and names which property failed.
    ].join("");
    const wrapped = maybeWrapWithSandbox(
      ["bun", "-e", script],
      {
        backend: "opencode",
        prompt: "late socket",
        cwd: project,
        containment: "required",
        broker: { provider: "openai", baseUrl: relayUrl, token: lease.token, unixSocket: brokerSocket },
        runTool: endpoint,
      },
      backendDefinitions.opencode,
      project,
      undefined,
      worker,
    );
    const forbidden = createServer((socket) => socket.end("host control\n"));
    let forbiddenListening = false;

    try {
      expect(wrapped.sandboxed, wrapped.reason).toBe(true);
      const child = Bun.spawn(wrapped.cmd, { cwd: project, env: worker.env, stdout: "pipe", stderr: "pipe" });
      const readyDeadline = Date.now() + schedulingWindow(5_000);
      while (!existsSync(marker) && child.exitCode === null && Date.now() < readyDeadline) await Bun.sleep(10);
      expect(existsSync(marker)).toBe(true);
      await listenUnix(forbidden, lateSocket);
      forbiddenListening = true;
      writeFileSync(proceed, "go");
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      // A non-zero exit now means the child crashed or never reported, which is
      // a distinct failure from any observation being wrong. Both streams are in
      // the message because this runs on hosted CI where the log is all there is.
      expect(exitCode, `stdout: ${stdout}\nstderr: ${stderr}`).toBe(0);
      const observed = JSON.parse(stdout) as { unixError: string; brokerStatus: number; brokerBody: string; toolCode: number; toolOutput: string; toolError: string };
      // THE SECURITY PROPERTY, asserted first and on its own. A connectable
      // late socket is a containment breach; everything below it is
      // availability. Keeping them separate means a flaky relay can never
      // obscure — or be mistaken for — a sandbox that leaked.
      expect(observed.unixError, `late socket was reachable from inside the sandbox: ${stdout}`).not.toBe("CONNECTED");
      expect(observed.brokerStatus).toBe(200);
      expect(observed.brokerBody).toContain('"broker":"ok"');
      // toolError is in the message because a hosted failure reported toolCode 1
      // with an empty toolOutput and nothing said WHY — the run-tool stderr was
      // captured by the child and then dropped from the report.
      expect(observed.toolCode, `run-tool failed: ${observed.toolError}`).toBe(0);
      expect(observed.toolOutput).toContain("run-tool-ok");
    } finally {
      if (forbiddenListening) await new Promise<void>((resolve) => forbidden.close(() => resolve()));
      await runTools.revokeAll();
      wrapped.cleanup();
      worker.cleanup();
      broker.stop();
      upstream.stop(true);
    }
  });

  linuxX64BwrapTest("rejects x32 syscall numbers before native seccomp dispatch", async () => {
    const project = temporaryDirectory("headless-linux-x32-project-");
    const worker = createWorkerEnvironment({ baseDir: temporaryDirectory("headless-linux-x32-worker-") });
    const script = [
      "const {dlopen,toArrayBuffer}=require('bun:ffi');",
      "const libc=dlopen('libc.so.6',{syscall:{args:['i64','i64','i64','i64','i64','i64','i64'],returns:'i64'},__errno_location:{args:[],returns:'ptr'}});",
      "const result=libc.symbols.syscall(0x40000029,1,1,0,0,0,0);",
      "const errno=new Int32Array(toArrayBuffer(libc.symbols.__errno_location(),0,4))[0];",
      "libc.close();",
      "console.log(JSON.stringify({result:String(result),errno}));",
      "process.exit(result===-1n&&errno===13?0:94);",
    ].join("");
    const wrapped = maybeWrapWithSandbox(
      ["bun", "-e", script],
      { backend: "opencode", prompt: "x32 probe", cwd: project, containment: "required" },
      backendDefinitions.opencode,
      project,
      undefined,
      worker,
    );

    try {
      expect(wrapped.sandboxed, wrapped.reason).toBe(true);
      const child = Bun.spawn(wrapped.cmd, { cwd: project, env: worker.env, stdout: "pipe", stderr: "pipe" });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode, stderr).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ result: "-1", errno: 13 });
    } finally {
      wrapped.cleanup();
      worker.cleanup();
    }
  });
});

describe("macOS Seatbelt profiles", () => {
  darwinTest("stages standalone Bun scripts without copying or exposing their siblings", async () => {
    const root = temporaryDirectory("headless-darwin-stage-");
    const project = join(root, "project");
    const bin = join(root, "bin");
    const script = join(bin, "fixture-bun");
    const sibling = join(bin, "sibling.ts");
    mkdirSync(project);
    mkdirSync(bin);
    writeFileSync(sibling, "export const secret = 'host-sibling';\n");
    writeFileSync(script, [
      "#!/usr/bin/env bun",
      "let relative=false;",
      "try{await import(new URL('./sibling.ts',import.meta.url).href);relative=true}catch{}",
      "let absolute=false;",
      `try{absolute=(await Bun.file(${JSON.stringify(sibling)}).text()).includes('host-sibling')}catch{}`,
      "if(process.argv.includes('--fail'))process.exit(23);",
      "console.log(JSON.stringify({relative,absolute}));",
    ].join("\n"), { mode: 0o700 });
    const worker = createWorkerEnvironment({
      baseDir: temporaryDirectory("headless-darwin-stage-worker-"),
      sourceEnv: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
    });
    const roots = executableReadRoots(["fixture-bun"], worker.env);
    const wrapped = maybeWrapWithSandbox(
      ["fixture-bun"],
      { backend: "opencode", prompt: "stage", cwd: project, containment: "required", authMode: "broker" },
      backendDefinitions.opencode,
      project,
      undefined,
      worker,
      roots,
    );
    const stagedScript = wrapped.cmd.find((value) => value.includes("darwin-bun-stage-") && value.endsWith("entry.ts"));
    const stagedDirectory = stagedScript ? dirname(stagedScript) : undefined;

    try {
      expect(wrapped.sandboxed, wrapped.reason).toBe(true);
      expect(stagedScript).toBeTruthy();
      expect(readdirSync(stagedDirectory!)).toEqual(["entry.ts"]);
      const profile = readFileSync(wrapped.cmd[2]!, "utf8");
      expect(profile).toContain(`(literal ${JSON.stringify(canonical(script))})`);
      expect(profile).not.toContain(`(subpath ${JSON.stringify(canonical(bin))})`);
      expect(profile).not.toContain(JSON.stringify(canonical(sibling)));
      const child = Bun.spawn(wrapped.cmd, { cwd: project, env: worker.env, stdout: "pipe", stderr: "pipe" });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode, stderr).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ relative: false, absolute: false });
      const failed = Bun.spawn([...wrapped.cmd, "--fail"], { cwd: project, env: worker.env, stdout: "ignore", stderr: "pipe" });
      const [failedCode, failedError] = await Promise.all([failed.exited, new Response(failed.stderr).text()]);
      expect(failedCode, failedError).toBe(23);
    } finally {
      wrapped.cleanup();
      if (stagedDirectory) expect(existsSync(stagedDirectory)).toBe(false);
      worker.cleanup();
    }
  });

  test("read mode is default-deny and writes only to isolated worker storage", () => {
    const project = temporaryDirectory("headless-project-");
    writeFileSync(join(project, ".env.local"), "SEEDED_REPOSITORY_SECRET\n", { mode: 0o600 });
    mkdirSync(join(project, ".git"));
    writeFileSync(join(project, ".git", "config"), "SEEDED_REPOSITORY_SECRET\n", { mode: 0o600 });
    const worker = createWorkerEnvironment({ baseDir: temporaryDirectory("headless-worker-base-") });

    try {
      const profile = buildDarwinReadOnlyProfile({ workdir: project, worker });
      expect(profile).toContain("(deny default)");
      expect(profile).not.toContain("(allow default)");
      expect(profile).not.toContain("(allow mach-lookup)");
      expect(profile).toContain(`(allow file-read* (subpath ${JSON.stringify(canonical(project))}))`);
      expect(profile).toContain(`(allow file-read-data (literal ${JSON.stringify(canonical(dirname(project)))}))`);
      expect(profile).not.toContain(`(allow file-read-data (subpath ${JSON.stringify(canonical(dirname(project)))}))`);
      expect(profile).toContain(`(allow file-write* (subpath ${JSON.stringify(worker.root)}))`);
      expect(profile).not.toContain(`(allow file-write* (subpath ${JSON.stringify(canonical(project))}))`);
      expect(profile).toContain(`(deny file-read* (literal ${JSON.stringify(join(canonical(project), ".env.local"))}))`);
      expect(profile).toContain(`(deny file-read* (literal ${JSON.stringify(join(canonical(project), ".git", "config"))}))`);
      expect(profile).toContain("(deny network*)");
      expect(profile).toContain('(allow file-write* (literal "/dev/null"))');
      expect(profile).toContain("(allow signal (target self))");
      expect(profile).toContain("(allow signal (target children))");
      expect(profile).not.toContain("(allow signal)");
    } finally {
      worker.cleanup();
    }
  });

  test("write mode permits the leased worktree but explicitly protects the primary", () => {
    const primary = temporaryDirectory("headless-primary-");
    const worktree = temporaryDirectory("headless-worktree-");
    writeFileSync(join(primary, ".env.production"), "SEEDED_REPOSITORY_SECRET\n", { mode: 0o600 });
    writeFileSync(join(worktree, ".env.local"), "SEEDED_REPOSITORY_SECRET\n", { mode: 0o600 });
    const worker = createWorkerEnvironment({ baseDir: temporaryDirectory("headless-worker-base-") });

    try {
      const profile = buildDarwinWriteProfile({ primaryRoot: primary, worktree, worker });
      expect(profile).toContain("(deny default)");
      expect(profile).toContain(`(allow file-write* (subpath ${JSON.stringify(canonical(worktree))}))`);
      expect(profile).toContain(`(allow file-read-data (literal ${JSON.stringify(canonical(dirname(worktree)))}))`);
      expect(profile).toContain(`(deny file-write* (subpath ${JSON.stringify(canonical(primary))}))`);
      expect(profile).not.toContain(`(allow file-write* (subpath ${JSON.stringify(canonical(primary))}))`);
      expect(profile).toContain(`(deny file-read* (literal ${JSON.stringify(join(canonical(primary), ".env.production"))}))`);
      expect(profile).toContain(`(deny file-read* (literal ${JSON.stringify(join(canonical(worktree), ".env.local"))}))`);
    } finally {
      worker.cleanup();
    }
  });

  darwinTest("write profile enforces the worktree/primary boundary", () => {
    const primary = temporaryDirectory("headless-primary-");
    const worktree = temporaryDirectory("headless-worktree-");
    const worker = createWorkerEnvironment({ baseDir: temporaryDirectory("headless-worker-base-") });
    const gitPointer = join(worktree, ".git");
    writeFileSync(gitPointer, "gitdir: /daemon/owned/metadata\n", { mode: 0o600 });
    const profile = writeDarwinWriteSandboxProfile({ primaryRoot: primary, worktree, worker });
    const allowed = join(worktree, "allowed.txt");
    const denied = join(primary, "denied.txt");
    const protectedFile = join(primary, "protected.txt");
    const hardlinkAlias = join(worktree, "protected-alias.txt");
    const symlinkAlias = join(worktree, "protected-symlink.txt");
    const siblingSecret = join(dirname(worktree), "sibling-secret.txt");
    const nullProbe = join(worktree, "null-probe.txt");
    writeFileSync(protectedFile, "original", { mode: 0o600 });
    writeFileSync(siblingSecret, "SEEDED_SIBLING_SECRET", { mode: 0o600 });
    symlinkSync(protectedFile, symlinkAlias);

    try {
      const allowedResult = spawnSync(DARWIN_SANDBOX_EXEC, ["-f", profile, "/bin/sh", "-c", `printf allowed > ${shellQuote(allowed)}`], {
        cwd: worktree,
        encoding: "utf-8",
      });
      const deniedResult = spawnSync(DARWIN_SANDBOX_EXEC, ["-f", profile, "/bin/sh", "-c", `printf denied > ${shellQuote(denied)}`], {
        cwd: worktree,
        encoding: "utf-8",
      });
      const hardlinkResult = spawnSync(DARWIN_SANDBOX_EXEC, ["-f", profile, "/bin/sh", "-c", `ln ${shellQuote(protectedFile)} ${shellQuote(hardlinkAlias)} && printf changed > ${shellQuote(hardlinkAlias)}`], {
        cwd: worktree,
        encoding: "utf-8",
      });
      const symlinkResult = spawnSync(DARWIN_SANDBOX_EXEC, ["-f", profile, "/bin/sh", "-c", `printf changed > ${shellQuote(symlinkAlias)}`], {
        cwd: worktree,
        encoding: "utf-8",
      });
      const gitPointerResult = spawnSync(DARWIN_SANDBOX_EXEC, ["-f", profile, "/bin/sh", "-c", `printf 'gitdir: /attacker' > ${shellQuote(gitPointer)}`], {
        cwd: worktree,
        encoding: "utf-8",
      });
      const nullResult = spawnSync(DARWIN_SANDBOX_EXEC, ["-f", profile, "/bin/sh", "-c", `printf ignored > /dev/null && printf allowed > ${shellQuote(nullProbe)}`], {
        cwd: worktree,
        encoding: "utf-8",
      });
      const siblingReadResult = spawnSync(DARWIN_SANDBOX_EXEC, ["-f", profile, "/bin/cat", siblingSecret], {
        cwd: worktree,
        encoding: "utf-8",
      });

      expect(allowedResult.status).toBe(0);
      expect(readFileSync(allowed, "utf-8")).toBe("allowed");
      expect(deniedResult.status).not.toBe(0);
      expect(existsSync(denied)).toBe(false);
      expect(hardlinkResult.status).not.toBe(0);
      expect(readFileSync(protectedFile, "utf-8")).toBe("original");
      expect(gitPointerResult.status).not.toBe(0);
      expect(readFileSync(gitPointer, "utf-8")).toBe("gitdir: /daemon/owned/metadata\n");
      expect(nullResult.status, nullResult.stderr).toBe(0);
      expect(readFileSync(nullProbe, "utf-8")).toBe("allowed");
      expect(siblingReadResult.status).not.toBe(0);
      expect(siblingReadResult.stdout).not.toContain("SEEDED_SIBLING_SECRET");
      expect(existsSync(hardlinkAlias)).toBe(false);
      expect(symlinkResult.status).not.toBe(0);
      expect(readFileSync(protectedFile, "utf-8")).toBe("original");
    } finally {
      cleanupSandboxProfile(profile);
      worker.cleanup();
    }
  });

  darwinTest("read profile hides repository environment and Git credentials while preserving source reads", () => {
    const parent = temporaryDirectory("headless-darwin-repository-credentials-");
    const project = join(parent, "project");
    const ordinary = join(project, "ordinary.txt");
    const siblingSecret = join(parent, "sibling-secret.txt");
    mkdirSync(project);
    mkdirSync(join(project, "packages", "api"), { recursive: true });
    const secrets = [
      join(project, ".env"),
      join(project, ".env.local"),
      join(project, ".env.test.local"),
      join(project, ".envrc"),
      join(project, "packages", "api", ".env.production"),
      join(project, ".git", "config"),
    ];
    mkdirSync(join(project, ".git"));
    writeFileSync(ordinary, "ordinary-project-source\n");
    writeFileSync(siblingSecret, "SEEDED_REPOSITORY_SECRET\n", { mode: 0o600 });
    for (const path of secrets) writeFileSync(path, "SEEDED_REPOSITORY_SECRET\n", { mode: 0o600 });
    const profile = writeDarwinReadOnlySandboxProfile({ workdir: project });
    try {
      const script = [
        `ls ${shellQuote(parent)} >/dev/null || exit 31`,
        credentialIsolationScript([ordinary], [...secrets, siblingSecret]),
      ].join("; ");
      const result = spawnSync(DARWIN_SANDBOX_EXEC, ["-f", profile, "/bin/sh", "-c", script], {
        cwd: project,
        encoding: "utf-8",
      });
      expect(result.status, result.stderr).toBe(0);
    } finally {
      cleanupSandboxProfile(profile);
    }
  });

  darwinTest("write profile hides primary and linked-worktree credentials while preserving ordinary reads", () => {
    const primary = temporaryDirectory("headless-darwin-primary-credentials-");
    const worktree = temporaryDirectory("headless-darwin-worktree-credentials-");
    const linkedGitDirectory = join(primary, ".git", "worktrees", "fixture");
    mkdirSync(linkedGitDirectory, { recursive: true });
    mkdirSync(join(primary, "services", "api"), { recursive: true });
    mkdirSync(join(worktree, "packages", "ui"), { recursive: true });
    const primarySource = join(primary, "primary-source.txt");
    const worktreeSource = join(worktree, "worktree-source.txt");
    const primaryEnv = join(primary, ".env.production.local");
    const worktreeEnv = join(worktree, ".env.local");
    const nestedPrimaryEnv = join(primary, "services", "api", ".env.local");
    const nestedWorktreeEnv = join(worktree, "packages", "ui", ".env.test");
    const primaryGitConfig = join(primary, ".git", "config");
    const worktreeGitConfig = join(linkedGitDirectory, "config.worktree");
    writeFileSync(primarySource, "ordinary-primary-source\n");
    writeFileSync(worktreeSource, "ordinary-worktree-source\n");
    writeFileSync(primaryEnv, "SEEDED_REPOSITORY_SECRET\n", { mode: 0o600 });
    writeFileSync(worktreeEnv, "SEEDED_REPOSITORY_SECRET\n", { mode: 0o600 });
    writeFileSync(nestedPrimaryEnv, "SEEDED_REPOSITORY_SECRET\n", { mode: 0o600 });
    writeFileSync(nestedWorktreeEnv, "SEEDED_REPOSITORY_SECRET\n", { mode: 0o600 });
    writeFileSync(primaryGitConfig, "SEEDED_REPOSITORY_SECRET\n", { mode: 0o600 });
    writeFileSync(join(linkedGitDirectory, "commondir"), "../..\n", { mode: 0o600 });
    writeFileSync(worktreeGitConfig, "SEEDED_REPOSITORY_SECRET\n", { mode: 0o600 });
    writeFileSync(join(worktree, ".git"), `gitdir: ${linkedGitDirectory}\n`, { mode: 0o600 });
    const profile = writeDarwinWriteSandboxProfile({ primaryRoot: primary, worktree });
    try {
      const result = spawnSync(DARWIN_SANDBOX_EXEC, [
        "-f", profile, "/bin/sh", "-c",
        credentialIsolationScript(
          [primarySource, worktreeSource],
          [primaryEnv, worktreeEnv, nestedPrimaryEnv, nestedWorktreeEnv, primaryGitConfig, worktreeGitConfig],
        ),
      ], { cwd: worktree, encoding: "utf-8" });
      expect(result.status, result.stderr).toBe(0);
    } finally {
      cleanupSandboxProfile(profile);
    }
  });

  darwinTest("signals only the sandbox process and its children", () => {
    const project = temporaryDirectory("headless-signal-project-");
    const profile = writeDarwinReadOnlySandboxProfile({ workdir: project });
    try {
      const result = spawnSync(DARWIN_SANDBOX_EXEC, [
        "-f", profile, "/bin/sh", "-c",
        "kill -0 $$ || exit 71; sleep 30 & child=$!; kill $child || exit 72; kill -0 1 && exit 73; exit 0",
      ], { cwd: project, encoding: "utf-8", timeout: 3_000 });
      expect(result.status, result.stderr).toBe(0);
    } finally {
      cleanupSandboxProfile(profile);
    }
  });

  darwinTest("permits only the configured loopback broker port", () => {
    const project = temporaryDirectory("headless-project-");
    const allowedServer = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const blockedServer = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const profile = writeDarwinReadOnlySandboxProfile({ workdir: project, brokerPort: allowedServer.port });

    try {
      const allowed = spawnSync(DARWIN_SANDBOX_EXEC, ["-f", profile, "/usr/bin/nc", "-z", "127.0.0.1", String(allowedServer.port)], {
        cwd: project,
        encoding: "utf-8",
        timeout: 2_000,
      });
      const blocked = spawnSync(DARWIN_SANDBOX_EXEC, ["-f", profile, "/usr/bin/nc", "-z", "127.0.0.1", String(blockedServer.port)], {
        cwd: project,
        encoding: "utf-8",
        timeout: 2_000,
      });

      expect(allowed.status).toBe(0);
      expect(blocked.status).not.toBe(0);
    } finally {
      cleanupSandboxProfile(profile);
      allowedServer.stop(true);
      blockedServer.stop(true);
    }
  });
});

describe("hardlink containment probe", () => {
  test("uses a real link-and-mutate attempt and removes every probe artifact", () => {
    const root = temporaryDirectory("headless-hardlink-parent-");
    const project = join(root, "project");
    mkdirSync(project, { mode: 0o700 });
    for (let i = 0; i < 5; i += 1) mkdirSync(join(project, `directory-${i}`));

    const result = probeHardlinkRisk(project);
    const leftovers = readdirSync(root).filter((name) => name.startsWith(".headless-hardlink-probe-"));
    expect(leftovers).toEqual([]);

    if (process.platform === "darwin" || (process.platform === "linux" && hasBwrap())) {
      expect(result.ok).toBe(true);
      expect(result.reason).toContain("denied hardlink creation");
    } else {
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/unsupported platform|bwrap not found/);
    }
  });
});

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  cleanupRoots.push(path);
  return path;
}

function hasArgumentPair(args: string[], option: string, first: string, second?: string): boolean {
  return args.some((value, index) => {
    if (value !== option || args[index + 1] !== first) return false;
    return second === undefined || args[index + 2] === second;
  });
}

function canonical(path: string): string {
  return realpathSync.native(path);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function credentialIsolationScript(readable: string[], credentials: string[]) {
  return [
    ...readable.map((path, index) => `grep -q ordinary ${shellQuote(path)} || exit ${70 + index}`),
    ...credentials.map((path) => `if grep -q SEEDED_REPOSITORY_SECRET ${shellQuote(path)} 2>/dev/null; then exit 91; fi`),
    "exit 0",
  ].join("; ");
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
