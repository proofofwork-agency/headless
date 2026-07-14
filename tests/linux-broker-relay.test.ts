import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderBroker } from "../src/broker/server";
import { registerBackendDefinition, unregisterBackendDefinition, type BackendDefinition } from "../src/backends/registry";
import { runHeadless } from "../src/runner/simple";

const linuxTest = process.platform === "linux" ? test : test.skip;
const cleanup: Array<() => void> = [];
const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
  while (cleanup.length) cleanup.pop()?.();
});

describe("Linux strict broker relay", () => {
  linuxTest("a contained worker reaches the scoped broker but not the host upstream directly", async () => {
    const root = mkdtempSync(join(tmpdir(), "headless-linux-relay-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const project = join(root, "project");
    const bin = join(root, "bin");
    const brokerSocket = join(root, "broker.sock");
    mkdirSync(project);
    mkdirSync(bin);

    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ fromBroker: true }) });
    cleanup.push(() => upstream.stop(true));
    const broker = new ProviderBroker({
      unixSocketPath: brokerSocket,
      credentials: { OPENAI_API_KEY: "real-parent-key" },
      upstreams: { openai: `http://127.0.0.1:${upstream.port}` },
    });
    broker.start();
    cleanup.push(() => broker.stop());
    const lease = broker.issueLease({ runId: "linux-relay", provider: "openai", models: ["gpt-test"], endpointClasses: ["responses"], expiresAt: Date.now() + 60_000, maxRequests: 1 });

    const executable = join(bin, "relay-fixture");
    writeFileSync(executable, `#!/usr/bin/env bun
if (process.argv.includes("--version")) { console.log("1.0.0"); process.exit(0); }
if (process.argv.includes("--help")) { console.log("--relay-fixture"); process.exit(0); }
let directDenied = false;
try { await fetch(${JSON.stringify(`http://127.0.0.1:${upstream.port}/direct`)}); } catch { directDenied = true; }
const response = await fetch(process.env.OPENAI_BASE_URL + "/v1/responses", { method: "POST", headers: { authorization: "Bearer " + process.env.OPENAI_API_KEY, "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-test", input: "hello" }) });
console.log(JSON.stringify({ type: "text", text: JSON.stringify({ directDenied, status: response.status, body: await response.json() }) }));
`, { mode: 0o700 });
    chmodSync(executable, 0o700);
    process.env.PATH = `${bin}:${originalPath}`;

    const adapter: BackendDefinition = {
      id: "linux-relay-fixture",
      metadata: { id: "linux-relay-fixture", aliases: [], promptDelivery: "native", timeoutMs: 10_000, maxDepth: null, canRead: true, canWrite: false },
      capabilities: { write: false, streaming: true, structuredOutput: true, nativeResume: false, cancellation: true, tools: false, effort: false, brokerCompatible: true },
      security: { outerContainmentRequired: true, strictAuth: "broker-api-key", disablesProjectConfig: true, disablesHooks: true, disablesMcp: true, disablesSkills: true },
      probe: { versionCommand: ["relay-fixture", "--version"], helpCommand: ["relay-fixture", "--help"], requiredHelpFragments: ["--relay-fixture"], minimumVersion: "1.0.0", timeoutMs: 2_000, maxOutputBytes: 4_096 },
      stdinPrompt: false,
      credentialPrefixes: [],
      prepareCommand: () => ["relay-fixture"],
      parse(stdout) {
        const event = JSON.parse(stdout.trim()) as { text: string };
        return { output: event.text, cost: null, tokens: null, error: null };
      },
    };
    registerBackendDefinition(adapter);
    cleanup.push(() => unregisterBackendDefinition(adapter.id));

    const result = await runHeadless({
      backend: adapter.id,
      prompt: "relay",
      cwd: project,
      model: "gpt-test",
      containment: "required",
      timeoutMs: 10_000,
      broker: { provider: "openai", baseUrl: lease.baseUrl, token: lease.token, unixSocket: brokerSocket },
    });
    const output = JSON.parse(result.output) as { directDenied: boolean; status: number; body: { fromBroker: boolean } };
    expect(result.ok).toBe(true);
    expect(result.containment?.network).toBe("broker-only");
    expect(result.containment?.mechanism).toContain("broker-relay");
    expect(output).toEqual({ directDenied: true, status: 200, body: { fromBroker: true } });
    expect(broker.getLeaseObservation(lease.id)?.requests).toBe(1);
  });
});
