import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  callRunToolEndpoint,
  RunToolEndpointManager,
  type RunToolOperation,
  type RunToolScope,
} from "../src/daemon/run-tool-endpoint";
import { createRunToolCallHandler } from "../src/daemon/run-tool-operations";
import { JobSchema, TaskSchema } from "../src/contracts/durable";
import { PersistentMessageQueue } from "../src/runtime/message-queue";
import {
  buildDarwinReadOnlyProfile,
  buildLinuxReadOnlyArgs,
  cleanupSandboxProfile,
  DARWIN_SANDBOX_EXEC,
  writeDarwinReadOnlySandboxProfile,
} from "../src/runtime/os-sandbox";
import { installRunToolClient, runToolCallTimeoutMs } from "../src/runtime/run-tool-client";
import { createWorkerEnvironment } from "../src/runtime/worker-environment";
import { ensureProjectStateDirectories, getProjectStatePaths } from "../src/runtime/project-state";

const roots: string[] = [];
const servers: Server[] = [];
const managers: RunToolEndpointManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.revokeAll()));
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => {});
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("run-scoped daemon tool endpoint", () => {
  test("bounds the runtime call timeout override", () => {
    expect(runToolCallTimeoutMs({})).toBe(5_000);
    expect(runToolCallTimeoutMs({ HEADLESS_RUN_TOOL_TIMEOUT_MS: "999" })).toBe(1_000);
    expect(runToolCallTimeoutMs({ HEADLESS_RUN_TOOL_TIMEOUT_MS: "15000" })).toBe(15_000);
    expect(runToolCallTimeoutMs({ HEADLESS_RUN_TOOL_TIMEOUT_MS: "60001" })).toBe(60_000);
    expect(runToolCallTimeoutMs({ HEADLESS_RUN_TOOL_TIMEOUT_MS: "invalid" })).toBe(5_000);
  });

  test("authenticates an immutable scope, bounds calls, redacts replies, and revokes the socket", async () => {
    const root = temporaryDirectory();
    let observed: { scope: Readonly<RunToolScope>; operation: RunToolOperation; params: Record<string, unknown> } | null = null;
    let leakedToken = "";
    const manager = new RunToolEndpointManager({
      socketDir: root,
      maxRequestsPerRun: 2,
      handle: (scope, operation, params) => {
        observed = { scope, operation, params };
        return { accepted: true, echoedSecret: leakedToken };
      },
    });
    managers.push(manager);
    const endpoint = await manager.issue(scope(Date.now() + 10_000));
    leakedToken = endpoint.token;

    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(endpoint.socketPath).mode & 0o777).toBe(0o600);
    expect(await callRunToolEndpoint(endpoint, "note", { text: "bounded progress" })).toEqual({
      accepted: true,
      echoedSecret: "[REDACTED_HEADLESS_RUN_TOOL_TOKEN]",
    });
    expect(observed).toMatchObject({
      scope: { projectId: "a".repeat(64), jobId: "job-1", sessionId: "session-1", principal: "worker-principal" },
      operation: "note",
      params: { text: "bounded progress" },
    });

    await expect(callRunToolEndpoint({ ...endpoint, token: `hlt_${"x".repeat(64)}` }, "context")).rejects.toMatchObject({ code: "RUN_TOOL_AUTH_FAILED" });
    await callRunToolEndpoint(endpoint, "task_status");
    await expect(callRunToolEndpoint(endpoint, "task_status")).rejects.toMatchObject({ code: "RUN_TOOL_LIMIT" });

    expect(await manager.revoke(endpoint.id)).toBe(true);
    expect(existsSync(endpoint.socketPath)).toBe(false);
    await expect(callRunToolEndpoint(endpoint, "context", {}, 250)).rejects.toMatchObject({ code: "RUN_TOOL_UNAVAILABLE" });
  });

  test("the disposable helper works cross-process and loses access after revocation", async () => {
    const root = temporaryDirectory();
    const manager = new RunToolEndpointManager({ socketDir: root, handle: (_scope, operation, params) => ({ operation, params }) });
    managers.push(manager);
    const endpoint = await manager.issue(scope(Date.now() + 10_000));
    const worker = createWorkerEnvironment({ baseDir: root });
    const deniedWorker = createWorkerEnvironment({ baseDir: root });
    const env = installRunToolClient(worker, {
      socketPath: endpoint.socketPath,
      token: endpoint.token,
      expiresAt: endpoint.scope.expiresAt,
      jobId: endpoint.scope.jobId,
      sessionId: endpoint.scope.sessionId,
      operations: endpoint.operations,
    });
    try {
      expect(env.HEADLESS_RUN_TOOL_TIMEOUT_MS).toBe(String(runToolCallTimeoutMs()));
      const helper = join(worker.runtime, "headless-run-tool");
      const first = Bun.spawn([helper, "note", JSON.stringify({ text: "from child" })], { env, stdout: "pipe", stderr: "pipe" });
      expect(await first.exited).toBe(0);
      expect(JSON.parse(await new Response(first.stdout).text())).toEqual({ operation: "note", params: { text: "from child" } });

      const deniedEnv = installRunToolClient(deniedWorker, {
        socketPath: endpoint.socketPath,
        token: endpoint.token,
        expiresAt: endpoint.scope.expiresAt,
        jobId: endpoint.scope.jobId,
        sessionId: endpoint.scope.sessionId,
        operations: ["note"],
      });
      const denied = Bun.spawn([join(deniedWorker.runtime, "headless-run-tool"), "run.delegate", "{}"], {
        env: deniedEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await denied.exited).toBe(2);
      expect(await new Response(denied.stderr).text()).toContain("operation is not allowed by this credential");

      await manager.revoke(endpoint.id);
      const revoked = Bun.spawn([helper, "note", JSON.stringify({ text: "too late" })], { env, stdout: "pipe", stderr: "pipe" });
      expect(await revoked.exited).not.toBe(0);
      const output = `${await new Response(revoked.stdout).text()}${await new Response(revoked.stderr).text()}`;
      expect(output).not.toContain(endpoint.token);
    } finally {
      deniedWorker.cleanup();
      worker.cleanup();
    }
  });

  test("automatically removes an expired listener without retaining the credential", async () => {
    const root = temporaryDirectory();
    const manager = new RunToolEndpointManager({ socketDir: root, handle: () => ({ unreachable: true }) });
    managers.push(manager);
    const endpoint = await manager.issue(scope(Date.now() + 50));
    expect(existsSync(endpoint.socketPath)).toBe(true);
    await Bun.sleep(100);
    expect(existsSync(endpoint.socketPath)).toBe(false);
    await expect(callRunToolEndpoint(endpoint, "context", {}, 250)).rejects.toMatchObject({ code: "RUN_TOOL_UNAVAILABLE" });
  });

  test("the disposable helper fails closed when a socket closes without a response", async () => {
    const root = temporaryDirectory();
    const manager = new RunToolEndpointManager({
      socketDir: root,
      handle: () => new Promise(() => {}),
    });
    managers.push(manager);
    const endpoint = await manager.issue(scope(Date.now() + 500));
    const worker = createWorkerEnvironment({ baseDir: root });
    try {
      const env = installRunToolClient(worker, {
        socketPath: endpoint.socketPath,
        token: endpoint.token,
        expiresAt: endpoint.scope.expiresAt,
        jobId: endpoint.scope.jobId,
        sessionId: endpoint.scope.sessionId,
        operations: endpoint.operations,
      });
      const child = Bun.spawn([join(worker.runtime, "headless-run-tool"), "note", JSON.stringify({ text: "never answered" })], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await child.exited).toBe(1);
      expect(await new Response(child.stderr).text()).toContain("connection closed before a response");
    } finally {
      worker.cleanup();
    }
  });

  test("validates delegation strictly and enforces each credential operation allowlist", async () => {
    const root = temporaryDirectory();
    let observedRequestId = "";
    const manager = new RunToolEndpointManager({
      socketDir: root,
      handle: (_scope, operation, params, requestId) => {
        observedRequestId = requestId;
        return { operation, params };
      },
    });
    managers.push(manager);
    const childEndpoint = await manager.issue(scope(Date.now() + 10_000), ["context"]);
    await expect(callRunToolEndpoint(childEndpoint, "run.delegate", { backend: "other", prompt: "forged" })).rejects.toMatchObject({ code: "POLICY_DENIED" });

    const parentEndpoint = await manager.issue(scope(Date.now() + 10_000));
    const result = await callRunToolEndpoint(parentEndpoint, "run.delegate", { backend: "other", prompt: "bounded" }) as { params: Record<string, unknown> };
    expect(result.params).toMatchObject({ backend: "other", prompt: "bounded", budgetFraction: 0.25 });
    expect(observedRequestId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(callRunToolEndpoint(parentEndpoint, "run.delegate", { backend: "other", prompt: "bounded", budgetFraction: 0.51 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(callRunToolEndpoint(parentEndpoint, "run.delegate", { backend: "other", prompt: "bounded", parentJobId: "forged" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  test("cooperation operations stay bound to the daemon-owned job, session, task, and principal", async () => {
    const root = temporaryDirectory();
    const project = join(root, "project");
    mkdirSync(project);
    const stateOptions = { env: { ...process.env, HEADLESS_STATE_HOME: join(root, "state") } };
    const state = ensureProjectStateDirectories(getProjectStatePaths(project, stateOptions));
    const now = Date.now();
    let job = JobSchema.parse({
      id: "bound-job",
      projectId: state.projectId,
      principal: "bound-principal",
      sessionId: "bound-session",
      workflowId: null,
      backend: "fixture",
      mode: "read-only",
      mergePolicy: "authorized",
      state: "running",
      attempt: 1,
      maxAttempts: 1,
      createdAt: now,
      updatedAt: now,
      leaseOwner: "daemon:fixture",
      leaseExpiresAt: now + 10_000,
      result: null,
    });
    const task = TaskSchema.parse({
      id: "bound-task",
      jobId: job.id,
      projectId: state.projectId,
      capability: "read-only:fixture",
      state: "claimed",
      claimedBy: job.principal,
      leaseExpiresAt: now + 10_000,
      createdAt: now,
      updatedAt: now,
    });
    const messages = new PersistentMessageQueue(join(state.projectDir, "run-tool-messages.sqlite"));
    const handler = createRunToolCallHandler({
      projectRoot: project,
      state: stateOptions,
      getJob: () => job,
      getTask: () => task,
      messages,
    });
    const boundScope = { projectId: state.projectId, jobId: job.id, sessionId: "bound-session", principal: job.principal, expiresAt: now + 10_000 };
    try {
      const note = await handler(boundScope, "note", { text: "verified from worker" }) as { principal: string; sessionId: string; content: string };
      expect(note).toMatchObject({ principal: "bound-principal", sessionId: "bound-session", content: "verified from worker" });
      expect(await handler(boundScope, "task_status", {})).toEqual(task);

      await handler(boundScope, "message_send", {
        content: "scoped message",
        to: "coordinator",
        meta: { principal: "forged", source: "forged", safe: "kept" },
      });
      const pulled = await handler(boundScope, "messages_pull", { limit: 20 }) as { messages: Array<{ principal: string; chatId: string; meta: Record<string, unknown> }> };
      expect(pulled.messages).toHaveLength(1);
      expect(pulled.messages[0]).toMatchObject({
        principal: "bound-principal",
        chatId: "bound-session",
        meta: { safe: "kept", runToolJobId: "bound-job" },
      });
      expect(pulled.messages[0]?.meta).not.toHaveProperty("source");

      await expect(Promise.resolve().then(() => handler({ ...boundScope, sessionId: "other-session" }, "context", { view: "summary", limit: 1 }))).rejects.toMatchObject({ code: "POLICY_DENIED" });
      job = JobSchema.parse({ ...job, state: "succeeded", result: null, updatedAt: now + 1 });
      await expect(Promise.resolve().then(() => handler(boundScope, "note", { text: "too late" }))).rejects.toMatchObject({ code: "POLICY_DENIED" });
    } finally {
      messages.close();
    }
  });

  test("containment grants only the distinct run socket and keeps unrelated Unix sockets masked", async () => {
    const root = temporaryDirectory();
    const project = join(root, "project");
    mkdirSync(project);
    writeFileSync(join(project, ".keep"), "");
    const brokerSocket = join(root, "broker.sock");
    const toolSocket = join(root, "tool.sock");
    const unrelatedSocket = join(project, "unrelated.sock");
    await Promise.all([listen(brokerSocket), listen(toolSocket), listen(unrelatedSocket)]);

    const darwin = buildDarwinReadOnlyProfile({ workdir: project, runToolSocket: toolSocket });
    expect(darwin).toContain(`(remote unix-socket (path-literal ${JSON.stringify(real(toolSocket))}))`);
    expect(darwin).not.toContain("(allow network-outbound)\n");

    const linux = buildLinuxReadOnlyArgs({ workdir: project, brokerSocket, runToolSocket: toolSocket });
    expect(hasMount(linux, real(brokerSocket), real(brokerSocket))).toBe(true);
    expect(hasMount(linux, real(toolSocket), real(toolSocket))).toBe(true);
    if (process.platform === "linux") expect(hasMount(linux, "/dev/null", real(unrelatedSocket))).toBe(true);
  });

  test.skipIf(process.platform !== "darwin")("Seatbelt permits the scoped Unix endpoint without opening general networking", async () => {
    const root = temporaryDirectory();
    const project = join(root, "project");
    mkdirSync(project);
    const manager = new RunToolEndpointManager({ socketDir: root, handle: (_scope, operation) => ({ operation }) });
    managers.push(manager);
    const endpoint = await manager.issue(scope(Date.now() + 10_000));
    const worker = createWorkerEnvironment({ baseDir: root });
    const bun = Bun.which("bun");
    expect(bun).toBeTruthy();
    const env = installRunToolClient(worker, {
      socketPath: endpoint.socketPath,
      token: endpoint.token,
      expiresAt: endpoint.scope.expiresAt,
      jobId: endpoint.scope.jobId,
      sessionId: endpoint.scope.sessionId,
      operations: endpoint.operations,
    });
    const profile = writeDarwinReadOnlySandboxProfile({
      workdir: project,
      worker,
      runtimeReadRoots: [bun!, dirname(bun!)],
      runToolSocket: endpoint.socketPath,
    });
    try {
      const helper = join(worker.runtime, "headless-run-tool");
      const child = Bun.spawn([DARWIN_SANDBOX_EXEC, "-f", profile, helper, "task_status", "{}"], {
        cwd: project,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode, stderr).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ operation: "task_status" });
    } finally {
      cleanupSandboxProfile(profile);
      worker.cleanup();
    }
  });
});

function temporaryDirectory() {
  const root = mkdtempSync(join(tmpdir(), "headless-run-tool-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function scope(expiresAt: number): RunToolScope {
  return { projectId: "a".repeat(64), jobId: "job-1", sessionId: "session-1", principal: "worker-principal", expiresAt };
}

async function listen(path: string) {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function hasMount(args: string[], source: string, target: string) {
  return args.some((value, index) => value === "--ro-bind" && args[index + 1] === source && args[index + 2] === target);
}

function real(path: string) {
  try {
    return realpathSync.native(path);
  } catch {
    return join(realpathSync.native(dirname(path)), basename(path));
  }
}
