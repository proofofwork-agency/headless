import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerBackendDefinition, unregisterBackendDefinition, type BackendDefinition } from "../src/backends/registry";
import { parseOpenCodeJsonl } from "../src/backends/opencode";
import { registerProvider, unregisterProvider } from "../src/broker/providers";
import type { Job } from "../src/contracts/durable";
import type { ApprovalRequest } from "../src/contracts/collaboration";
import { HeadlessDaemonClient } from "../src/daemon/client";
import { HeadlessDaemon } from "../src/daemon/server";
import { BudgetStore } from "../src/runtime/budget-store";
import { registerPricing, unregisterPricing } from "../src/runtime/pricing";

const ADAPTER_ID = "cost-budget-fixture";
const PROVIDER_ID = "costtest";
const PRICING_ID = "cost-budget-priced-model";
const roots: string[] = [];
const daemons: HeadlessDaemon[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];
let adapterRegistered = false;
let providerRegistered = false;
let pricingRegistered = false;
const originalPath = process.env.PATH;
const originalCredential = process.env.COST_TEST_KEY;

afterEach(async () => {
  while (daemons.length) await daemons.pop()!.stop();
  while (servers.length) servers.pop()!.stop(true);
  if (pricingRegistered) unregisterPricing(PRICING_ID);
  if (providerRegistered) unregisterProvider(PROVIDER_ID);
  if (adapterRegistered) unregisterBackendDefinition(ADAPTER_ID);
  pricingRegistered = false;
  providerRegistered = false;
  adapterRegistered = false;
  process.env.PATH = originalPath;
  if (originalCredential === undefined) delete process.env.COST_TEST_KEY;
  else process.env.COST_TEST_KEY = originalCredential;
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("daemon cost budget admission", () => {
  test("admits a priced run, attributes actual cost, and charges the broker bound once", async () => {
    const fixture = await setupFixture(true);
    await fixture.client.call("budget.upsert", {
      id: "priced-cap",
      provider: PROVIDER_ID,
      maxCostUsd: 0.01,
    });
    const submitted = await fixture.client.call<Job>("run.submit", request("priced-model"));
    const completed = await fixture.client.call<Job>("run.wait", { jobId: submitted.id, timeoutMs: 10_000 });

    expect(completed.state).toBe("succeeded");
    expect(completed.result?.cost).toMatchObject({
      amountUsd: 0.000002,
      source: "broker",
      pricingId: PRICING_ID,
      observedRequests: 1,
    });
    const budget = new BudgetStore(fixture.daemon.state).getState().budgets.find((entry) => entry.id === "priced-cap");
    expect(budget?.usedRequests).toBe(1);
    const brokerBound = (Buffer.byteLength(JSON.stringify({ model: "priced-model", input: "hello", max_output_tokens: 10 })) + 10) / 1_000_000;
    expect(budget?.usedCost.amountUsd).toBe(brokerBound);
    expect(budget?.usedCost.observedRequests).toBe(1);
    expect(fixture.upstreamCalls()).toBe(1);
  });

  test("rejects a priced run whose preflight estimate exceeds the configured cap", async () => {
    const fixture = await setupFixture(true);
    await fixture.client.call("budget.upsert", {
      id: "too-small-cap",
      provider: PROVIDER_ID,
      maxCostUsd: 0.001,
    });

    const blocked = await fixture.client.call<Job>("run.submit", request("priced-model"));

    expect(blocked.state).toBe("blocked");
    expect(blocked.result?.error?.code).toBe("BUDGET_EXCEEDED");
    expect(blocked.result?.error?.message).toContain("cost limit exceeded");
    expect(fixture.upstreamCalls()).toBe(0);
  });

  test("fails closed under a cost cap when model pricing is unavailable", async () => {
    const fixture = await setupFixture(false);
    await fixture.client.call("budget.upsert", {
      id: "unknown-price-cap",
      provider: PROVIDER_ID,
      maxCostUsd: 0.01,
    });

    const blocked = await fixture.client.call<Job>("run.submit", request("unpriced-model"));

    expect(blocked.state).toBe("blocked");
    expect(blocked.result?.error?.code).toBe("BUDGET_EXCEEDED");
    expect(blocked.result?.error?.message).toContain("cost usage is unknown");
    expect(blocked.result?.cost.amountUsd).toBeNull();
    expect(fixture.upstreamCalls()).toBe(0);
  });

  test("requires explicit per-run approval for unknown broker pricing without a cost budget", async () => {
    const fixture = await setupFixture(false);
    const submitted = await fixture.client.call<Job>("run.submit", request("unpriced-model"));

    expect(submitted).toMatchObject({ state: "queued", result: null });
    expect(fixture.upstreamCalls()).toBe(0);
    const approvals = await fixture.client.call<ApprovalRequest[]>("approval.list", { status: "pending" });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      kind: "unpriced_broker_run",
      details: {
        jobId: submitted.id,
        maxRequests: 8,
        maxInputTokens: 200_000,
        maxOutputTokens: 32_000,
        cost: "unknown",
      },
    });

    await fixture.client.call("approval.resolve", {
      approvalId: approvals[0]!.id,
      decision: "approved",
      resolution: "Allow this one bounded unpriced test run.",
    });
    const completed = await fixture.client.call<Job>("run.wait", { jobId: submitted.id, timeoutMs: 10_000 });
    expect(completed.state).toBe("succeeded");
    expect(completed.result?.cost.amountUsd).toBeNull();
    expect(fixture.upstreamCalls()).toBe(1);
  });

  test("enforces a durable cost limit against the concrete broker request", async () => {
    const fixture = await setupFixture(true, 5_000);
    await fixture.client.call("budget.upsert", {
      id: "concrete-cost-cap",
      provider: PROVIDER_ID,
      // The stable 4096-token admission estimate fits, while the worker's
      // concrete 5000-token provider request must be stopped before egress.
      maxCostUsd: 0.0045,
    });

    const submitted = await fixture.client.call<Job>("run.submit", request("priced-model"));
    expect(submitted.result).toBeNull();
    const completed = await fixture.client.call<Job>("run.wait", { jobId: submitted.id, timeoutMs: 10_000 });

    expect(completed.state).toBe("failed");
    expect(completed.result?.cost.amountUsd).toBeNull();
    expect(fixture.upstreamCalls()).toBe(0);
  });

  test("rejects an oversized concrete provider token request before egress", async () => {
    const fixture = await setupFixture(true, 5_001);
    await fixture.client.call("budget.upsert", {
      id: "provider-output-cap",
      provider: PROVIDER_ID,
      // Admission reserves the stable 4096-token planning value. The concrete
      // provider request must still be rejected against this durable cap.
      maxOutputTokens: 5_000,
    });

    const submitted = await fixture.client.call<Job>("run.submit", request("priced-model"));
    expect(submitted.result).toBeNull();
    const completed = await fixture.client.call<Job>("run.wait", { jobId: submitted.id, timeoutMs: 10_000 });

    expect(completed.state).toBe("failed");
    expect(completed.result?.output).toContain("aggregate output token budget");
    expect(fixture.upstreamCalls()).toBe(0);
  });

  test("persists conservative broker token accounting instead of under-reported usage", async () => {
    const fixture = await setupFixture(true, 100);
    await fixture.client.call("budget.upsert", {
      id: "durable-output-cap",
      provider: PROVIDER_ID,
      maxOutputTokens: 5_000,
    });

    const submitted = await fixture.client.call<Job>("run.submit", request("priced-model"));
    const completed = await fixture.client.call<Job>("run.wait", { jobId: submitted.id, timeoutMs: 10_000 });

    expect(completed.state).toBe("succeeded");
    expect(completed.result?.usage.output).toBe(1);
    const budget = new BudgetStore(fixture.daemon.state).getState().budgets.find((entry) => entry.id === "durable-output-cap");
    expect(budget?.usedUsage.output).toBe(100);
    expect(fixture.upstreamCalls()).toBe(1);
  });
});

async function setupFixture(withPricing: boolean, workerMaxOutputTokens = 10) {
  const root = mkdtempSync(join(tmpdir(), "headless-cost-budget-"));
  roots.push(root);
  const project = join(root, "project");
  const bin = join(root, "bin");
  mkdirSync(project);
  mkdirSync(bin);
  process.env.PATH = `${bin}:${originalPath}`;
  process.env.COST_TEST_KEY = "parent-only-secret";

  let calls = 0;
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls += 1;
      return Response.json({ usage: { input_tokens: 1, output_tokens: 1 } });
    },
  });
  servers.push(upstream);
  registerProvider({
    id: PROVIDER_ID,
    upstream: `http://127.0.0.1:${upstream.port}`,
    credentialEnv: "COST_TEST_KEY",
    routePrefixes: ["/v1/responses"],
    authenticate(headers, credential) {
      headers.set("authorization", `Bearer ${credential}`);
    },
    validateBoundedInput() {
      return null;
    },
  });
  providerRegistered = true;
  if (withPricing) {
    registerPricing({
      id: PRICING_ID,
      provider: PROVIDER_ID,
      model: "priced-model",
      effectiveFrom: 0,
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 1,
    });
    pricingRegistered = true;
  }
  registerBackendDefinition(fixtureAdapter());
  adapterRegistered = true;

  const executable = join(bin, "cost-runner");
  writeFileSync(executable, `#!/usr/bin/env bun
const base = process.env.OPENAI_BASE_URL;
const token = process.env.HEADLESS_BROKER_TOKEN;
const model = process.argv.at(-2);
const response = await fetch(base + "/v1/responses", {
  method: "POST",
  headers: { authorization: "Bearer " + token, "content-type": "application/json" },
  body: JSON.stringify({ model, input: "hello", max_output_tokens: ${workerMaxOutputTokens} }),
});
if (!response.ok) {
  console.error(await response.text());
  process.exit(1);
}
await response.text();
console.log(JSON.stringify({ type: "text", text: "priced result", usage: { input_tokens: 1, output_tokens: 1 } }));
`, { mode: 0o700 });
  chmodSync(executable, 0o700);

  const state = { env: { ...process.env, HEADLESS_STATE_HOME: join(root, "state") } };
  const daemon = new HeadlessDaemon({ projectRoot: project, state, token: "a".repeat(48), principal: "coordinator" });
  daemons.push(daemon);
  await daemon.start();
  const client = new HeadlessDaemonClient({ projectRoot: project, state, token: "a".repeat(48) });
  return {
    daemon,
    client,
    project,
    state,
    upstreamCalls: () => calls,
  };
}

function request(model: string) {
  return {
    backend: ADAPTER_ID,
    prompt: "test",
    model: `${PROVIDER_ID}/${model}`,
    authMode: "broker" as const,
    containment: "unsafe",
    timeoutMs: 5_000,
  };
}

function fixtureAdapter(): BackendDefinition {
  return {
    id: ADAPTER_ID,
    metadata: { id: ADAPTER_ID, aliases: [], promptDelivery: "argv", timeoutMs: 10_000, maxDepth: null, canRead: true, canWrite: false },
    capabilities: { write: false, streaming: true, structuredOutput: true, nativeResume: false, cancellation: true, tools: false, effort: false, brokerCompatible: true },
    security: { outerContainmentRequired: true, strictAuth: "broker-api-key", disablesProjectConfig: true, disablesHooks: true, disablesMcp: true, disablesSkills: true },
    probe: { versionCommand: ["/usr/bin/true"], helpCommand: ["/usr/bin/true"], requiredHelpFragments: [], timeoutMs: 1_000, maxOutputBytes: 1_024 },
    stdinPrompt: false,
    credentialPrefixes: ["COST_TEST_KEY"],
    prepareCommand: (options) => ["cost-runner", options.model?.replace(`${PROVIDER_ID}/`, "") ?? "", options.prompt],
    decodeOutput: parseOpenCodeJsonl,
  };
}
