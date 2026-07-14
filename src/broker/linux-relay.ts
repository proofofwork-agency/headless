import { dlopen, ptr, type Library } from "bun:ffi";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createConnection, createServer } from "node:net";

const RUN_TOOL_RELAY_PORT = 38_471;
const activeProxyServers = new Set<object>();

type ProxyHandle = { server?: object; close: () => void };

type SupervisorOptions = {
  broker?: { socketPath: string; port: number };
  runTool?: { socketPath: string; port: number };
  command: string[];
};

/**
 * Linux strict-containment supervisor.
 *
 * Pathname AF_UNIX sockets are not isolated by a network namespace, and bind
 * mounts reflect socket dentries created after the namespace starts. Only the
 * non-dumpable trusted supervisor can therefore create AF_UNIX sockets. The
 * supervisor launches a dedicated helper that installs a seccomp filter and
 * replaces itself with the backend via execve. The backend reaches two scoped
 * capabilities over loopback inside its otherwise-private network namespace.
 */
export async function runLinuxBrokerRelay(argv = process.argv.slice(2)) {
  disableProcessDumping();
  const options = parseSupervisorArguments(argv);
  const proxies: ProxyHandle[] = [];
  const env = { ...process.env };
  if (options.runTool) {
    delete env.HEADLESS_RUN_TOOL_SOCKET;
    env.HEADLESS_RUN_TOOL_HOST = "127.0.0.1";
    env.HEADLESS_RUN_TOOL_PORT = String(options.runTool.port);
  }
  const backend = await prepareFilteredBackend(options.command, env);
  try {
    if (options.broker) {
      proxies.push(await startHttpProxy(options.broker.socketPath, options.broker.port));
    }
    if (options.runTool) {
      proxies.push(await startStreamProxy(options.runTool.socketPath, options.runTool.port));
    }
    return await backend.releaseAndWait();
  } finally {
    for (const proxy of proxies) proxy.close();
    backend.cleanup();
  }
}

export function linuxRunToolRelayPort(brokerPort?: number) {
  return brokerPort === RUN_TOOL_RELAY_PORT ? RUN_TOOL_RELAY_PORT + 1 : RUN_TOOL_RELAY_PORT;
}

function parseSupervisorArguments(argv: string[]): SupervisorOptions {
  // Preserve the v0.2 relay's original private CLI for callers that package
  // the entry point directly: <broker-socket> <port> -- <command...>.
  if (argv[0]?.startsWith("/") && argv[2] === "--") {
    return {
      broker: { socketPath: argv[0], port: validPort(argv[1]) },
      command: validCommand(argv.slice(3)),
    };
  }

  if (argv[0] !== "supervise") throw new Error("Linux containment supervisor received an unknown operation.");
  const separator = argv.indexOf("--");
  if (separator < 1) throw new Error("Linux containment supervisor requires a command delimiter.");
  let broker: SupervisorOptions["broker"];
  let runTool: SupervisorOptions["runTool"];
  for (let index = 1; index < separator;) {
    const option = argv[index];
    const socketPath = argv[index + 1];
    const portText = argv[index + 2];
    if ((option !== "--broker" && option !== "--run-tool") || !socketPath?.startsWith("/") || !portText) {
      throw new Error("Linux containment supervisor received invalid bounded arguments.");
    }
    const endpoint = { socketPath, port: validPort(portText) };
    if (option === "--broker") {
      if (broker) throw new Error("Linux containment supervisor received duplicate broker arguments.");
      broker = endpoint;
    } else {
      if (runTool) throw new Error("Linux containment supervisor received duplicate run-tool arguments.");
      runTool = endpoint;
    }
    index += 3;
  }
  if (broker && runTool && broker.port === runTool.port) throw new Error("Linux containment relay ports must be distinct.");
  return { broker, runTool, command: validCommand(argv.slice(separator + 1)) };
}

function validPort(value: string | undefined) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("Linux containment supervisor received an invalid relay port.");
  }
  return port;
}

function validCommand(command: string[]) {
  if (command.length === 0 || !command[0]) throw new Error("Linux containment supervisor requires a backend command.");
  return command;
}

async function startHttpProxy(socketPath: string, port: number): Promise<ProxyHandle> {
  const connections = new Set<ReturnType<typeof createConnection>>();
  const relay = createHttpServer((incoming, response) => {
    const upstream = httpRequest({
      socketPath,
      path: incoming.url ?? "/",
      method: incoming.method,
      headers: incoming.headers,
    }, (providerResponse) => {
      response.writeHead(providerResponse.statusCode ?? 502, providerResponse.headers);
      providerResponse.pipe(response);
    });
    upstream.once("error", () => {
      if (response.headersSent) response.destroy();
      else {
        response.writeHead(502, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: "BROKER_RELAY_FAILED", message: "The local provider broker was unavailable." } }));
      }
    });
    incoming.pipe(upstream);
  });
  relay.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    relay.once("error", reject);
    relay.listen(port, "127.0.0.1", () => {
      relay.off("error", reject);
      resolve();
    });
  });
  activeProxyServers.add(relay);
  return {
    server: relay,
    close: () => {
      activeProxyServers.delete(relay);
      for (const connection of connections) connection.destroy();
      relay.close();
    },
  };
}

async function startStreamProxy(socketPath: string, port: number): Promise<ProxyHandle> {
  const connections = new Set<ReturnType<typeof createConnection>>();
  const server = createServer((client) => {
    connections.add(client);
    client.once("close", () => connections.delete(client));
    client.pause();
    const upstream = createConnection(socketPath);
    connections.add(upstream);
    upstream.once("close", () => connections.delete(upstream));
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.once("error", close);
    upstream.once("error", close);
    upstream.once("connect", () => {
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  activeProxyServers.add(server);
  return {
    server,
    close: () => {
      activeProxyServers.delete(server);
      for (const connection of connections) connection.destroy();
      server.close();
    },
  };
}

type Libc = Library<{
  prctl: { args: ["i32", "u64", "u64", "u64", "u64"]; returns: "i32" };
  unshare: { args: ["i32"]; returns: "i32" };
}>;

async function prepareFilteredBackend(command: string[], env: NodeJS.ProcessEnv) {
  if (process.platform !== "linux") throw new Error("Linux seccomp filter requested on another platform.");
  const synchronizationDirectory = mkdtempSync("/tmp/headless-filtered-exec-");
  const readyPath = `${synchronizationDirectory}/ready`;
  const releasePath = `${synchronizationDirectory}/release`;
  const child = Bun.spawn([process.execPath, import.meta.path, "exec-filtered", synchronizationDirectory, "--", ...command], {
    cwd: process.cwd(),
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const deadline = Date.now() + 5_000;
  while (!existsSync(readyPath) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(5);
  if (!existsSync(readyPath)) {
    child.kill("SIGKILL");
    rmSync(synchronizationDirectory, { recursive: true, force: true });
    throw new Error("Linux filtered backend did not isolate its file-descriptor table before proxy startup.");
  }
  let released = false;
  return {
    releaseAndWait: async () => {
      if (!released) {
        released = true;
        writeFileSync(releasePath, "release", { flag: "wx", mode: 0o600 });
      }
      return child.exited;
    },
    cleanup: () => {
      if (child.exitCode === null) child.kill("SIGKILL");
      rmSync(synchronizationDirectory, { recursive: true, force: true });
    },
  };
}

function disableProcessDumping() {
  if (process.platform !== "linux") throw new Error("Linux containment supervisor cannot run on another platform.");
  let lastError: unknown;
  for (const name of ["libc.so.6", "libc.so"]) {
    try {
      const libc: Libc = dlopen(name, {
        prctl: { args: ["i32", "u64", "u64", "u64", "u64"], returns: "i32" },
        unshare: { args: ["i32"], returns: "i32" },
      });
      try {
        if (libc.symbols.prctl(4, 0, 0, 0, 0) !== 0) throw new Error("PR_SET_DUMPABLE failed.");
        return;
      } finally {
        libc.close();
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Linux containment could not disable process dumping: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function execFilteredBackend(synchronizationDirectory: string, command: string[]) {
  if (process.platform !== "linux") throw new Error("Linux filtered exec requested on another platform.");
  if (!process.execve) throw new Error("Linux containment runtime does not support in-place execve.");
  const executable = command[0];
  if (!executable) throw new Error("Linux filtered exec requires a backend command.");
  const libc = openPrctlLibrary();
  try {
    if (libc.symbols.unshare(0x400) !== 0) throw new Error("Unable to isolate the filtered backend file-descriptor table.");
  } finally {
    libc.close();
  }
  const readyPath = `${synchronizationDirectory}/ready`;
  const releasePath = `${synchronizationDirectory}/release`;
  writeFileSync(readyPath, "ready", { flag: "wx", mode: 0o600 });
  const releaseDeadline = Date.now() + 30_000;
  while (!existsSync(releasePath) && Date.now() < releaseDeadline) await Bun.sleep(5);
  if (!existsSync(releasePath)) throw new Error("Linux filtered backend was not released before its deadline.");
  const instructions = buildSeccompProgram(seccompDefinition());
  const program = new Uint8Array(16);
  const view = new DataView(program.buffer);
  view.setUint16(0, instructions.byteLength / 8, true);
  view.setBigUint64(8, BigInt(ptr(instructions)), true);
  const filterLibc = openPrctlLibrary();
  try {
    if (filterLibc.symbols.prctl(38, 1, 0, 0, 0) !== 0) throw new Error("Unable to enable no-new-privileges before seccomp.");
    if (filterLibc.symbols.prctl(22, 2, ptr(program), 0, 0) !== 0) throw new Error("Unable to install the backend Unix-socket seccomp filter.");
  } finally {
    filterLibc.close();
  }
  process.execve("/usr/bin/env", ["env", ...command], process.env);
}

function openPrctlLibrary() {
  let lastError: unknown;
  for (const name of ["libc.so.6", "libc.so"]) {
    try {
      return dlopen(name, {
        prctl: { args: ["i32", "u64", "u64", "u64", "u64"], returns: "i32" },
        unshare: { args: ["i32"], returns: "i32" },
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Linux containment could not load libc for seccomp: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function seccompDefinition() {
  if (process.arch === "x64") {
    return {
      arch: 0xc000003e,
      socket: 41,
      denied: [101, 310, 311, 425, 438],
      // x32 shares AUDIT_ARCH_X86_64 but sets this bit on every syscall
      // number. Reject the ABI before comparing native syscall numbers so an
      // x32 socket()/ptrace()/io_uring call cannot bypass the native table.
      rejectedSyscallMask: 0x40000000,
    };
  }
  if (process.arch === "arm64") {
    return {
      arch: 0xc00000b7,
      socket: 198,
      denied: [117, 270, 271, 425, 438],
      rejectedSyscallMask: null,
    };
  }
  throw new Error(`Linux strict containment does not support seccomp on ${process.arch}.`);
}

function buildSeccompProgram(definition: ReturnType<typeof seccompDefinition>) {
  const load = (offset: number) => ({ code: 0x20, jt: 0, jf: 0, value: offset });
  const equal = (value: number, jt: number, jf: number) => ({ code: 0x15, jt, jf, value });
  const bitSet = (value: number, jt: number, jf: number) => ({ code: 0x45, jt, jf, value });
  const returnValue = (value: number) => ({ code: 0x06, jt: 0, jf: 0, value });
  const deny = 0x00050000 | 13;
  const filters = [
    load(4),
    equal(definition.arch, 1, 0),
    returnValue(0x80000000),
    load(0),
    ...(definition.rejectedSyscallMask === null
      ? []
      : [bitSet(definition.rejectedSyscallMask, 0, 1), returnValue(deny)]),
    equal(definition.socket, 0, 3),
    load(16),
    equal(1, 0, 1),
    returnValue(deny),
    load(0),
    ...definition.denied.flatMap((syscall) => [equal(syscall, 0, 1), returnValue(deny)]),
    returnValue(0x7fff0000),
  ];
  const bytes = new Uint8Array(filters.length * 8);
  const view = new DataView(bytes.buffer);
  filters.forEach((filter, index) => {
    const offset = index * 8;
    view.setUint16(offset, filter.code, true);
    view.setUint8(offset + 2, filter.jt);
    view.setUint8(offset + 3, filter.jf);
    view.setUint32(offset + 4, filter.value, true);
  });
  return bytes;
}

async function main(argv: string[]) {
  if (argv[0] === "exec-filtered") {
    const separator = argv.indexOf("--");
    const synchronizationDirectory = argv[1];
    if (separator !== 2 || !synchronizationDirectory?.startsWith("/tmp/headless-filtered-exec-")) {
      throw new Error("Linux filtered exec received invalid arguments.");
    }
    await execFilteredBackend(synchronizationDirectory, validCommand(argv.slice(separator + 1)));
  }
  return runLinuxBrokerRelay(argv);
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(125);
  });
}
