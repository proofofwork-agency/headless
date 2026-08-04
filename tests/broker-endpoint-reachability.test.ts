import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROKER_UNIX_ONLY_RELAY_PORT, ProviderBroker } from "../src/broker/server";
import { registerBackendDefinition, unregisterBackendDefinition, type BackendDefinition } from "../src/backends/registry";
import {
  assertBrokerEndpointIsServed,
  maybeWrapWithSandbox,
  runHeadless,
  type BrokerWorkerAccess,
} from "../src/runner/simple";
import { createWorkerEnvironment } from "../src/runtime/worker-environment";
import { isHeadlessError } from "../src/runtime/headless-error";
import { backendDefinitions } from "../src/backends/registry";

const closers: Array<() => void> = [];

afterEach(() => {
  while (closers.length) closers.pop()?.();
});

function temporaryDirectory(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  closers.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Exactly the daemon's Unix-socket-only broker (HEADLESS_BROKER_ALLOW_LOOPBACK_TCP=0). */
function unixOnlyBroker() {
  const socket = join(temporaryDirectory("headless-unix-only-broker-"), "broker.sock");
  const broker = new ProviderBroker({
    unixSocketPath: socket,
    allowLoopbackTcp: false,
    credentials: { OPENAI_API_KEY: "parent-key", ANTHROPIC_API_KEY: "parent-key" },
  });
  broker.start();
  closers.push(() => broker.stop());
  return { broker, socket };
}

/** Build the worker lease the way RunExecutionService does, from broker facts. */
function workerAccess(broker: ProviderBroker, provider = "openai"): BrokerWorkerAccess {
  const lease = broker.issueLease({
    runId: `reachability-${provider}-${Math.random().toString(16).slice(2)}`,
    provider,
    models: ["gpt-test"],
    endpointClasses: ["responses"],
    expiresAt: Date.now() + 60_000,
    maxRequests: 1,
  });
  return {
    provider: lease.provider,
    baseUrl: lease.baseUrl,
    token: lease.token,
    unixSocket: broker.unixSocketPath ?? lease.unixSocket,
    hostLoopbackListener: broker.tcpListening,
  };
}

function portOf(baseUrl: string) {
  return Number(new URL(baseUrl).port);
}

async function hasListener(port: number) {
  return await new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const settle = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1_000);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

function expectRefusal(run: () => unknown, fragment: string) {
  let thrown: unknown = null;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).not.toBeNull();
  expect(isHeadlessError(thrown)).toBe(true);
  const typed = thrown as import("../src/runtime/headless-error").HeadlessError;
  expect(typed.code).toBe("CONTAINMENT_UNAVAILABLE");
  expect(typed.safeMessage).toContain(fragment);
  return typed;
}

describe("broker endpoint reachability", () => {
  test("a Unix-socket-only broker mints a lease whose port has no host owner", async () => {
    const { broker } = unixOnlyBroker();
    const access = workerAccess(broker);
    expect(broker.tcpListening).toBe(false);
    expect(portOf(access.baseUrl)).toBe(BROKER_UNIX_ONLY_RELAY_PORT);
    // The defect in one line: the URL the worker would receive is unowned.
    expect(await hasListener(portOf(access.baseUrl))).toBe(false);
  });

  test("refuses the endpoint on a platform with no in-namespace relay", () => {
    const { broker } = unixOnlyBroker();
    const access = workerAccess(broker);
    for (const containment of ["required", "unsafe"] as const) {
      const error = expectRefusal(
        () => assertBrokerEndpointIsServed(access, { containment, platform: "darwin" }),
        "no host loopback listener",
      );
      expect(error.details).toMatchObject({ port: BROKER_UNIX_ONLY_RELAY_PORT, platform: "darwin", containment });
    }
  });

  test("refuses the endpoint for an uncontained Linux run, which gets no namespace and no relay", () => {
    const { broker } = unixOnlyBroker();
    const access = workerAccess(broker);
    expectRefusal(
      () => assertBrokerEndpointIsServed(access, { containment: "unsafe", platform: "linux" }),
      "unsafe containment creates no namespace and no relay",
    );
  });

  test("refuses the endpoint when the broker Unix socket the relay would dial is gone", () => {
    const { broker, socket } = unixOnlyBroker();
    const access = workerAccess(broker);
    broker.stop();
    expect(existsSync(socket)).toBe(false);
    expectRefusal(
      () => assertBrokerEndpointIsServed(access, { containment: "required", platform: "linux" }),
      "Unix socket is unavailable",
    );
  });

  test("still allows the legitimate Linux contained relay path", () => {
    const { broker, socket } = unixOnlyBroker();
    const access = workerAccess(broker);
    expect(existsSync(socket)).toBe(true);
    expect(() => assertBrokerEndpointIsServed(access, { containment: "required", platform: "linux" })).not.toThrow();
  });

  test("allows a broker that owns a real host loopback listener, and that port answers", async () => {
    const socket = join(temporaryDirectory("headless-dual-edge-broker-"), "broker.sock");
    const broker = new ProviderBroker({
      unixSocketPath: socket,
      allowLoopbackTcp: true,
      credentials: { OPENAI_API_KEY: "parent-key" },
    });
    broker.start();
    closers.push(() => broker.stop());
    const access = workerAccess(broker);

    expect(broker.tcpListening).toBe(true);
    expect(access.hostLoopbackListener).toBe(true);
    expect(portOf(access.baseUrl)).not.toBe(BROKER_UNIX_ONLY_RELAY_PORT);
    // The invariant the guard protects: whatever a worker receives, answers.
    expect(await hasListener(portOf(access.baseUrl))).toBe(true);
    for (const platform of ["darwin", "linux"] as const) {
      for (const containment of ["required", "unsafe"] as const) {
        expect(() => assertBrokerEndpointIsServed(access, { containment, platform })).not.toThrow();
      }
    }
  });

  test("treats the reserved relay port as relay-only even when the issuer states nothing", () => {
    const { broker, socket } = unixOnlyBroker();
    const { hostLoopbackListener: _omitted, ...silent } = workerAccess(broker);
    expect(silent.hostLoopbackListener).toBeUndefined();
    expectRefusal(
      () => assertBrokerEndpointIsServed(silent, { containment: "unsafe", platform: "darwin" }),
      "no host loopback listener",
    );
    expect(() => assertBrokerEndpointIsServed({ ...silent, unixSocket: socket }, { containment: "required", platform: "linux" })).not.toThrow();
  });

  test("no sandbox profile or command is built around an unowned endpoint", () => {
    const { broker } = unixOnlyBroker();
    const access = workerAccess(broker);
    const project = temporaryDirectory("headless-unowned-endpoint-project-");
    const worker = createWorkerEnvironment({ baseDir: temporaryDirectory("headless-unowned-endpoint-worker-") });
    closers.push(() => worker.cleanup());

    // On darwin this is the call that would emit
    // `(allow network-outbound (remote ip "localhost:38471"))` into the Seatbelt
    // profile; on any platform it is the call that builds the worker argv.
    if (process.platform !== "linux") {
      expectRefusal(
        () => maybeWrapWithSandbox(
          ["bun", "-e", "0"],
          { backend: "opencode", prompt: "unowned", cwd: project, containment: "required", broker: access },
          backendDefinitions.opencode,
          project,
          undefined,
          worker,
        ),
        "no host loopback listener",
      );
    }
    expectRefusal(
      () => maybeWrapWithSandbox(
        ["bun", "-e", "0"],
        { backend: "opencode", prompt: "unowned", cwd: project, containment: "unsafe", broker: access },
        backendDefinitions.opencode,
        project,
        undefined,
        worker,
      ),
      "no host loopback listener",
    );
  });

  test("a worker is never spawned, and never handed the token, for an unowned endpoint", async () => {
    const { broker } = unixOnlyBroker();
    const access = workerAccess(broker, "anthropic");
    const project = temporaryDirectory("headless-unowned-endpoint-run-");
    mkdirSync(join(project, "work"));
    let prepared = 0;
    const adapter: BackendDefinition = {
      id: "unreachable-broker-fixture",
      metadata: { id: "unreachable-broker-fixture", aliases: [], promptDelivery: "native", timeoutMs: 5_000, maxDepth: null, canRead: true, canWrite: false },
      capabilities: { write: false, streaming: true, structuredOutput: true, nativeResume: false, cancellation: true, tools: false, effort: false, brokerCompatible: true },
      security: { outerContainmentRequired: true, strictAuth: "broker-api-key", disablesProjectConfig: true, disablesHooks: true, disablesMcp: true, disablesSkills: true },
      probe: { versionCommand: ["unreachable-fixture", "--version"], helpCommand: ["unreachable-fixture", "--help"], requiredHelpFragments: ["--unreachable-fixture"], minimumVersion: "1.0.0", timeoutMs: 2_000, maxOutputBytes: 4_096 },
      stdinPrompt: false,
      credentialPrefixes: [],
      prepareCommand: () => {
        prepared += 1;
        return ["unreachable-fixture"];
      },
      decodeOutput: (stdout) => ({ output: stdout, cost: null, tokens: null, error: null }),
    };
    registerBackendDefinition(adapter);
    closers.push(() => unregisterBackendDefinition(adapter.id));

    // On Linux, required containment IS the legitimate relay path, so only
    // unsafe containment is unreachable there.
    const unreachable = process.platform === "linux" ? (["unsafe"] as const) : (["required", "unsafe"] as const);
    for (const containment of unreachable) {
      const result = await runHeadless({
        backend: adapter.id,
        prompt: "unowned endpoint",
        cwd: join(project, "work"),
        containment,
        timeoutMs: 5_000,
        broker: access,
      });
      expect(result.ok).toBe(false);
      expect(result.status).toBe("blocked");
      expect(result.error?.code).toBe("CONTAINMENT_UNAVAILABLE");
      expect(result.error?.message).toContain("no host loopback listener");
      expect(result.error?.message).not.toContain(access.token);
      expect(result.exitCode).toBeNull();
    }
    // No command was built, so no process, no env, and no ANTHROPIC_API_KEY.
    expect(prepared).toBe(0);
  });
});
