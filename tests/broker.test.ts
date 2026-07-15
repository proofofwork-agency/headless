import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderBroker, type BrokerLinkedOperation } from "../src/broker/server";
import { getProvider, registerProvider, unregisterProvider } from "../src/broker/providers";
import { registerPricing, unregisterPricing } from "../src/runtime/pricing";
import { DurableBrokerQuotaStore } from "../src/runtime/broker-quota-store";
import { ensureProjectStateDirectories, getProjectStatePaths } from "../src/runtime/project-state";

const closers: Array<() => void> = [];
const pricingIds: string[] = [];

afterEach(() => {
  while (closers.length) closers.pop()?.();
  while (pricingIds.length) unregisterPricing(pricingIds.pop()!);
});

describe("provider broker", () => {
  test("warns once when a cost-capped lease has no trusted pricing", () => {
    const warnings: string[] = [];
    const broker = new ProviderBroker({ warning: (message) => warnings.push(message) });
    broker.start();
    closers.push(() => broker.stop());
    const lease = (runId: string, maxCostUsd: number | null) => broker.issueLease({
      runId,
      provider: "openai",
      models: ["gpt-test"],
      endpointClasses: ["responses"],
      expiresAt: Date.now() + 60_000,
      maxRequests: 1,
      maxCostUsd,
    });

    lease("uncapped", null);
    expect(warnings).toEqual([]);
    lease("capped", 1);
    lease("second-cap", 2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("pricing registry is empty");
    expect(warnings[0]).toContain("fail closed");

    const nonfatal = new ProviderBroker({ warning: () => { throw new Error("diagnostic sink failed"); } });
    nonfatal.start();
    closers.push(() => nonfatal.stop());
    expect(() => nonfatal.issueLease({
      runId: "warning-failure",
      provider: "openai",
      models: ["gpt-test"],
      endpointClasses: ["responses"],
      expiresAt: Date.now() + 60_000,
      maxRequests: 1,
      maxCostUsd: 1,
    })).not.toThrow();

    const pricingId = "warning-priced-model";
    pricingIds.push(pricingId);
    registerPricing({
      id: pricingId,
      provider: "openai",
      model: "gpt-test",
      effectiveFrom: 0,
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 1,
    });
    const pricedWarnings: string[] = [];
    const priced = new ProviderBroker({ warning: (message) => pricedWarnings.push(message) });
    priced.start();
    closers.push(() => priced.stop());
    priced.issueLease({
      runId: "priced-cap",
      provider: "openai",
      models: ["gpt-test"],
      endpointClasses: ["responses"],
      expiresAt: Date.now() + 60_000,
      maxRequests: 1,
      maxCostUsd: 1,
    });
    expect(pricedWarnings).toEqual([]);
  });

  test("replaces an opaque OpenAI lease with the parent credential", async () => {
    let observedAuthorization = "";
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        observedAuthorization = request.headers.get("authorization") ?? "";
        return Response.json({ id: "ok", usage: { input_tokens: 1, output_tokens: 2 } });
      },
    });
    closers.push(() => upstream.stop(true));
    const broker = new ProviderBroker({
      credentials: { OPENAI_API_KEY: "real-parent-secret" },
      upstreams: { openai: `http://127.0.0.1:${upstream.port}` },
    });
    broker.start();
    closers.push(() => broker.stop());
    const lease = broker.issueLease({
      runId: "run-1",
      provider: "openai",
      models: ["gpt-test"],
      endpointClasses: ["chat"],
      expiresAt: Date.now() + 60_000,
      maxRequests: 2,
    });

    const response = await fetch(`${lease.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${lease.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", messages: [] }),
    });

    expect(response.status).toBe(200);
    expect(observedAuthorization).toBe("Bearer real-parent-secret");
    expect(observedAuthorization).not.toContain(lease.token);
    expect(JSON.stringify(broker.getLogs())).not.toContain("real-parent-secret");
    expect(broker.getLeaseObservation(lease.id)).toMatchObject({ runId: "run-1", provider: "openai", requests: 1, observedCostUsd: 0 });
  });

  test("serves the same scoped broker over an owner-only Unix socket for Linux namespace relays", async () => {
    const root = mkdtempSync(join(tmpdir(), "headless-broker-unix-"));
    closers.push(() => rmSync(root, { recursive: true, force: true }));
    const socket = join(root, "broker.sock");
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true }) });
    closers.push(() => upstream.stop(true));
    const broker = new ProviderBroker({
      unixSocketPath: socket,
      credentials: { OPENAI_API_KEY: "parent-key" },
      upstreams: { openai: `http://127.0.0.1:${upstream.port}` },
    });
    broker.start();
    closers.push(() => broker.stop());
    const lease = broker.issueLease({ runId: "unix-run", provider: "openai", models: ["gpt-test"], endpointClasses: ["responses"], expiresAt: Date.now() + 60_000, maxRequests: 1 });

    const response = await fetch("http://headless-broker/openai/v1/responses", {
      unix: socket,
      method: "POST",
      headers: { authorization: `Bearer ${lease.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", input: "hello" }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as { ok: boolean }).toEqual({ ok: true });
  });

  test.skipIf(process.platform !== "linux")("the Linux loopback relay forwards only through the designated broker socket", async () => {
    const root = mkdtempSync(join(tmpdir(), "headless-broker-relay-"));
    closers.push(() => rmSync(root, { recursive: true, force: true }));
    const socket = join(root, "broker.sock");
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ relayed: true }) });
    closers.push(() => upstream.stop(true));
    const broker = new ProviderBroker({ unixSocketPath: socket, credentials: { OPENAI_API_KEY: "parent-key" }, upstreams: { openai: `http://127.0.0.1:${upstream.port}` } });
    broker.start();
    closers.push(() => broker.stop());
    const lease = broker.issueLease({ runId: "relay-run", provider: "openai", models: ["gpt-test"], endpointClasses: ["responses"], expiresAt: Date.now() + 60_000, maxRequests: 1 });
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") });
    const relayPort = reservation.port;
    reservation.stop(true);
    const childScript = `const r=await fetch('http://127.0.0.1:${relayPort}/openai/v1/responses',{method:'POST',headers:{authorization:'Bearer ${lease.token}','content-type':'application/json'},body:JSON.stringify({model:'gpt-test'})}); console.log(await r.text()); process.exit(r.ok?0:1)`;
    const relay = Bun.spawn(["bun", join(import.meta.dir, "../src/broker/linux-relay.ts"), socket, String(relayPort), "--", "bun", "-e", childScript], { stdout: "pipe", stderr: "pipe" });
    const [code, output, stderr] = await Promise.all([relay.exited, new Response(relay.stdout).text(), new Response(relay.stderr).text()]);

    expect(code, stderr).toBe(0);
    expect(output).toContain('"relayed":true');
    expect(broker.getLeaseObservation(lease.id)?.requests).toBe(1);
  });

  test("rejects invalid tokens, models, routes, bodies, and exhausted leases", async () => {
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true }) });
    closers.push(() => upstream.stop(true));
    const broker = new ProviderBroker({
      credentials: { OPENAI_API_KEY: "secret" },
      upstreams: { openai: `http://127.0.0.1:${upstream.port}` },
    });
    broker.start();
    closers.push(() => broker.stop());
    const lease = broker.issueLease({
      runId: "run-2",
      provider: "openai",
      models: ["allowed"],
      endpointClasses: ["chat"],
      expiresAt: Date.now() + 60_000,
      maxRequests: 2,
      maxBodyBytes: 128,
    });

    const post = (path: string, token: string, body: unknown) => fetch(`${broker.endpoint}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    expect((await post("/openai/v1/chat/completions", "wrong", { model: "allowed" })).status).toBe(401);
    expect((await post("/openai/v1/chat/completions", lease.token, { model: "wrong" })).status).toBe(403);
    expect((await post("/openai/v1/unknown", lease.token, { model: "allowed" })).status).toBe(403);
    expect((await post("/openai/v1/chat/completions", lease.token, { model: "allowed", padding: "x".repeat(256) })).status).toBe(413);
    expect((await post("/openai/v1/chat/completions", lease.token, { model: "allowed" })).status).toBe(200);
    expect((await post("/openai/v1/chat/completions", lease.token, { model: "allowed" })).status).toBe(429);
  });

  test("atomically reserves request slots across concurrent lease use", async () => {
    let upstreamCalls = 0;
    const broker = new ProviderBroker({
      credentials: { OPENAI_API_KEY: "secret" },
      upstreams: { openai: "http://127.0.0.1:9" },
      fetch: (async () => {
        upstreamCalls += 1;
        await Bun.sleep(30);
        return Response.json({ ok: true });
      }) as typeof fetch,
    });
    broker.start();
    closers.push(() => broker.stop());
    const lease = broker.issueLease({
      runId: "concurrent-slot",
      provider: "openai",
      models: ["allowed"],
      endpointClasses: ["responses"],
      expiresAt: Date.now() + 60_000,
      maxRequests: 1,
    });
    const send = () => fetch(`${lease.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${lease.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "allowed" }),
    });
    const responses = await Promise.all([send(), send()]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 429]);
    expect(upstreamCalls).toBe(1);
    expect(broker.getLeaseObservation(lease.id)?.requests).toBe(1);
  });

  test("carves a child slice from the live parent lease and restores proven unused capacity once", async () => {
    const broker = new ProviderBroker({
      credentials: { OPENAI_API_KEY: "secret" },
      upstreams: { openai: "http://127.0.0.1:9" },
      fetch: (async () => Response.json({ ok: true })) as typeof fetch,
    });
    broker.start();
    closers.push(() => broker.stop());
    const lease = broker.issueLease({
      runId: "delegating-parent",
      provider: "openai",
      models: ["allowed"],
      endpointClasses: ["responses"],
      expiresAt: Date.now() + 60_000,
      maxRequests: 4,
    });
    const carve = broker.carveRunLease("delegating-parent", { requests: 2, inputTokens: null, outputTokens: null, costUsd: null });
    const send = () => fetch(`${lease.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${lease.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "allowed" }),
    });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);
    expect(broker.settleRunLeaseCarve(carve, { requests: 1 })).toBe(true);
    expect(broker.settleRunLeaseCarve(carve, { requests: 0 })).toBe(false);
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);
  });

  test("replays one deterministic linked parent carve and settles proven-unused authority once", async () => {
    const operations: BrokerLinkedOperation[] = [];
    const broker = new ProviderBroker({
      credentials: { ANTHROPIC_API_KEY: "secret" },
      upstreams: { anthropic: "http://127.0.0.1:9" },
      fetch: (async () => Response.json({ ok: true })) as typeof fetch,
      persistLinkedOperation: (operation) => replaceOperation(operations, operation),
    });
    broker.start();
    closers.push(() => broker.stop());
    const lease = broker.issueLease({
      runId: "linked-parent",
      provider: "anthropic",
      models: ["claude-test"],
      endpointClasses: ["messages"],
      expiresAt: Date.now() + 60_000,
      maxRequests: 4,
      budgetQuotas: [{
        id: "headless-run-linked-parent",
        maxRequests: 4,
        usedRequests: 0,
        maxInputTokens: null,
        usedInputTokens: 0,
        maxOutputTokens: null,
        usedOutputTokens: 0,
      }],
    });
    const linkId = "a".repeat(64);
    const allocation = { requests: 2, inputTokens: null, outputTokens: null, costUsd: null };
    const first = broker.carveLinkedParent(linkId, "linked-parent", allocation);
    const replay = broker.carveLinkedParent(linkId, "linked-parent", allocation);
    expect(first).toEqual(replay);
    expect(first.id).toBe(`${linkId}:parent`);
    expect(() => broker.carveLinkedParent(linkId, "linked-parent", { ...allocation, requests: 1 })).toThrow("conflicts");

    const send = () => fetch(`${lease.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": lease.token, "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-test" }),
    });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);
    const unused = { requests: 1, inputTokens: null, outputTokens: null, costUsd: null };
    expect(broker.settleLinkedParent(linkId, unused)).toBe(true);
    expect(broker.settleLinkedParent(linkId, unused)).toBe(false);
    expect(() => broker.settleLinkedParent(linkId, { ...unused, requests: 0 })).toThrow("conflicts");
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);
    expect(operations).toContainEqual(expect.objectContaining({
      kind: "parent",
      operationId: `${linkId}:parent`,
      phase: "settled",
      unused,
    }));
    expect(JSON.stringify(operations)).not.toContain(lease.token);
  });

  test("mints one target bearer without retaining it and keeps provider and quota scopes separate", async () => {
    const operations: BrokerLinkedOperation[] = [];
    const broker = new ProviderBroker({
      credentials: { ANTHROPIC_API_KEY: "anthropic-secret", OPENAI_API_KEY: "openai-secret" },
      upstreams: { anthropic: "http://127.0.0.1:9", openai: "http://127.0.0.1:9" },
      fetch: (async () => Response.json({ ok: true })) as typeof fetch,
      initialBudgetQuotas: [{
        id: "target-provider-budget",
        maxRequests: 1,
        usedRequests: 0,
        maxInputTokens: 80,
        usedInputTokens: 0,
        maxOutputTokens: 8,
        usedOutputTokens: 0,
        maxCostUsd: null,
        usedCostUsd: 0,
      }],
      persistLinkedOperation: (operation) => replaceOperation(operations, operation),
    });
    broker.start();
    closers.push(() => broker.stop());
    const parent = broker.issueLease({
      runId: "provider-parent",
      provider: "anthropic",
      models: ["claude-test"],
      endpointClasses: ["messages"],
      expiresAt: Date.now() + 60_000,
      maxRequests: 2,
      budgetQuotas: [{
        id: "headless-run-provider-parent",
        maxRequests: 2,
        usedRequests: 0,
        maxInputTokens: null,
        usedInputTokens: 0,
        maxOutputTokens: null,
        usedOutputTokens: 0,
      }],
    });
    const linkId = "b".repeat(64);
    const childDeadlineAt = Date.now() + 20_000;
    const scope = linkedTargetScope(childDeadlineAt);
    const first = broker.issueLinkedTarget(linkId, "target-child", scope);
    expect(first.status).toBe("issued");
    if (first.status !== "issued") throw new Error("Expected first linked target issuance.");
    expect(first.lease.provider).toBe("openai");
    expect(first.lease.expiresAt).toBeLessThanOrEqual(childDeadlineAt + scope.replyMarginMs);
    expect(first.evidence.targetQuotaScope.budgetQuotas.map((quota) => quota.id)).toEqual([
      `headless-linked-target-${linkId}`,
      "target-provider-budget",
      "global-budget",
    ]);
    expect(first.evidence.targetQuotaScope.budgetQuotas.map((quota) => quota.id)).not.toContain("headless-run-provider-parent");
    expect(first.evidence.targetQuotaScope.budgetQuotas.find((quota) => quota.id === "target-provider-budget")).toMatchObject({
      maxRequests: 1,
      maxInputTokens: 80,
      maxOutputTokens: 8,
    });

    const replay = broker.issueLinkedTarget(linkId, "target-child", scope);
    expect(replay).toEqual({ status: "already_leased", evidence: first.evidence });
    expect(JSON.stringify(replay)).not.toContain(first.lease.token);
    expect((replay as Record<string, unknown>).token).toBeUndefined();
    expect(() => broker.issueLinkedTarget(linkId, "target-child", { ...scope, models: ["changed"] })).toThrow("conflicts");

    const targetOnParent = await fetch(`${broker.endpoint}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": first.lease.token, "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-test" }),
    });
    const parentOnTarget = await fetch(`${broker.endpoint}/openai/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${parent.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", input: "x", max_output_tokens: 1 }),
    });
    expect(targetOnParent.status).toBe(403);
    expect(parentOnTarget.status).toBe(403);

    const targetResponse = await fetch(`${first.lease.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${first.lease.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", input: "x", max_output_tokens: 1 }),
    });
    expect(targetResponse.status).toBe(200);
    const observation = broker.observeLinkedTarget(linkId);
    expect(observation).toMatchObject({ requests: 1, forwardedRequests: 1, activeRequests: 0, revoked: false });
    expect(JSON.stringify(observation)).not.toContain(first.lease.token);
    expect(broker.getLeaseObservation(parent.id)).toMatchObject({ provider: "anthropic", requests: 0 });
    expect(broker.getLeaseObservation(first.lease.id)).toMatchObject({ provider: "openai", requests: 1 });

    expect(broker.revokeLinkedTarget(linkId)).toBe(true);
    expect(broker.revokeLinkedTarget(linkId)).toBe(false);
    expect(broker.observeLinkedTarget(linkId)).toMatchObject({ revoked: true, activeRequests: 0 });
    expect((await fetch(`${first.lease.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${first.lease.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", input: "x", max_output_tokens: 1 }),
    })).status).toBe(401);
    expect(JSON.stringify(operations)).not.toContain(first.lease.token);
  });

  test("persists token-free target issuance evidence and never remints it after restart", () => {
    const root = mkdtempSync(join(tmpdir(), "headless-linked-broker-"));
    closers.push(() => rmSync(root, { recursive: true, force: true }));
    const project = join(root, "project");
    mkdirSync(project);
    const paths = ensureProjectStateDirectories(getProjectStatePaths(project, {
      env: { ...process.env, HEADLESS_STATE_HOME: join(root, "state"), HEADLESS_RUNTIME_HOME: undefined },
    }));
    const createBroker = () => {
      const store = new DurableBrokerQuotaStore(paths);
      const broker = new ProviderBroker({
        credentials: { OPENAI_API_KEY: "secret" },
        initialBudgetQuotas: store.snapshot(),
        persistBudgetQuota: (quota, expiresAt) => store.update(quota, expiresAt),
        initialLinkedOperations: store.linkedSnapshot(),
        persistLinkedOperation: (operation) => store.updateLinkedOperation(operation),
      });
      broker.start();
      return broker;
    };
    const linkId = "c".repeat(64);
    const scope = linkedTargetScope(Date.now() + 20_000);
    const firstBroker = createBroker();
    const first = firstBroker.issueLinkedTarget(linkId, "restart-child", scope);
    expect(first.status).toBe("issued");
    if (first.status !== "issued") throw new Error("Expected first linked target issuance.");
    const persisted = readFileSync(paths.brokerQuotasPath, "utf8");
    expect(persisted).not.toContain(first.lease.token);
    expect(persisted).toContain(first.evidence.targetTokenHash);
    firstBroker.stop();

    const reopened = createBroker();
    closers.push(() => reopened.stop());
    const replay = reopened.issueLinkedTarget(linkId, "restart-child", scope);
    expect(replay).toEqual({ status: "already_leased", evidence: first.evidence });
    expect(JSON.stringify(replay)).not.toContain(first.lease.token);
    expect(reopened.observeLinkedTarget(linkId)).toEqual({
      leaseId: `${linkId}:target`,
      requests: 0,
      forwardedRequests: 0,
      observedCostUsd: 0,
      accountedCostUsd: 0,
      accountedInputTokens: 0,
      accountedOutputTokens: 0,
      activeRequests: 0,
      revoked: false,
      expiresAt: first.evidence.targetExpiresAt,
    });
  });

  test("upgrades the durable quota envelope without changing existing quota evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "headless-broker-quota-upgrade-"));
    closers.push(() => rmSync(root, { recursive: true, force: true }));
    const project = join(root, "project");
    mkdirSync(project);
    const paths = ensureProjectStateDirectories(getProjectStatePaths(project, {
      env: { ...process.env, HEADLESS_STATE_HOME: join(root, "state"), HEADLESS_RUNTIME_HOME: undefined },
    }));
    const quota = {
      id: "existing-quota",
      maxRequests: 3,
      usedRequests: 1,
      maxInputTokens: 100,
      usedInputTokens: 20,
      maxOutputTokens: 10,
      usedOutputTokens: 2,
      maxCostUsd: 2,
      usedCostUsd: 0.5,
      expiresAt: Date.now() + 60_000,
      updatedAt: 123,
    };
    writeFileSync(paths.brokerQuotasPath, `${JSON.stringify({
      version: 1,
      projectId: paths.projectId,
      quotas: [quota],
      updatedAt: 123,
    })}\n`, { mode: 0o600 });

    const store = new DurableBrokerQuotaStore(paths);
    expect(store.snapshot()).toEqual([expect.objectContaining({
      id: quota.id,
      maxRequests: quota.maxRequests,
      usedRequests: quota.usedRequests,
      maxInputTokens: quota.maxInputTokens,
      usedInputTokens: quota.usedInputTokens,
      maxOutputTokens: quota.maxOutputTokens,
      usedOutputTokens: quota.usedOutputTokens,
      maxCostUsd: quota.maxCostUsd,
      usedCostUsd: quota.usedCostUsd,
    })]);
    expect(store.linkedSnapshot()).toEqual([]);
    expect(JSON.parse(readFileSync(paths.brokerQuotasPath, "utf8"))).toMatchObject({
      version: 2,
      quotas: [quota],
      linkedOperations: [],
    });
  });

  test("enforces one aggregate request cap across leases issued at different times", async () => {
    let upstreamCalls = 0;
    const broker = new ProviderBroker({
      credentials: { OPENAI_API_KEY: "secret" },
      upstreams: { openai: "http://127.0.0.1:9" },
      fetch: (async () => {
        upstreamCalls += 1;
        await Bun.sleep(20);
        return Response.json({ ok: true });
      }) as typeof fetch,
    });
    broker.start();
    closers.push(() => broker.stop());
    const quota = {
      id: "shared-request-budget",
      maxRequests: 2,
      usedRequests: 0,
      maxInputTokens: null,
      usedInputTokens: 0,
      maxOutputTokens: null,
      usedOutputTokens: 0,
    };
    const issue = (runId: string) => broker.issueLease({
      runId,
      provider: "openai",
      models: ["allowed"],
      endpointClasses: ["responses", "chat"],
      expiresAt: Date.now() + 60_000,
      maxRequests: 2,
      budgetQuotas: [quota],
    });
    // The second lease arrives after the first has already received its own
    // immutable per-run cap. The shared durable-budget quota remains atomic.
    const first = issue("aggregate-first");
    const second = issue("aggregate-late");
    const send = (token: string) => fetch(`${broker.endpoint}/openai/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "allowed" }),
    });

    const responses = await Promise.all([send(first.token), send(first.token), send(second.token)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 429]);
    expect(upstreamCalls).toBe(2);
    expect((broker.getLeaseObservation(first.id)?.requests ?? 0) + (broker.getLeaseObservation(second.id)?.requests ?? 0)).toBe(2);
  });

  test("persists aggregate run ceilings before egress and restores them after broker restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "headless-broker-quota-"));
    closers.push(() => rmSync(root, { recursive: true, force: true }));
    const project = join(root, "project");
    mkdirSync(project);
    const paths = ensureProjectStateDirectories(getProjectStatePaths(project, {
      env: { ...process.env, HEADLESS_STATE_HOME: join(root, "state"), HEADLESS_RUNTIME_HOME: undefined },
    }));
    let upstreamCalls = 0;
    const createBroker = () => {
      const store = new DurableBrokerQuotaStore(paths);
      const broker = new ProviderBroker({
        credentials: { OPENAI_API_KEY: "secret" },
        upstreams: { openai: "http://127.0.0.1:9" },
        fetch: (async () => {
          upstreamCalls += 1;
          return Response.json({ ok: true });
        }) as typeof fetch,
        initialBudgetQuotas: store.snapshot(),
        persistBudgetQuota: (quota, expiresAt) => store.update(quota, expiresAt),
      });
      broker.start();
      return broker;
    };
    const quota = {
      id: "durable-run-ceiling",
      maxRequests: 2,
      usedRequests: 0,
      maxInputTokens: 1_000,
      usedInputTokens: 0,
      maxOutputTokens: 10,
      usedOutputTokens: 0,
      maxCostUsd: null,
      usedCostUsd: 0,
    };
    const issue = (broker: ProviderBroker) => broker.issueLease({
      runId: "same-logical-run",
      provider: "openai",
      models: ["gpt-4o-mini"],
      endpointClasses: ["responses"],
      expiresAt: Date.now() + 60_000,
      maxRequests: 8,
      budgetQuotas: [quota],
    });
    const send = (lease: ReturnType<typeof issue>) => fetch(`${lease.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${lease.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", input: "x", max_output_tokens: 1 }),
    });

    const firstBroker = createBroker();
    const first = issue(firstBroker);
    const firstResponse = await send(first);
    expect(firstResponse.status, await firstResponse.text()).toBe(200);
    firstBroker.stop();

    const secondBroker = createBroker();
    closers.push(() => secondBroker.stop());
    const second = issue(secondBroker);
    expect((await send(second)).status).toBe(200);
    expect((await send(second)).status).toBe(429);
    expect(upstreamCalls).toBe(2);
  });

  test("rejects provider requests that exceed aggregate input or output token caps before egress", async () => {
    let upstreamCalls = 0;
    const broker = new ProviderBroker({
      credentials: { OPENAI_API_KEY: "secret" },
      upstreams: { openai: "http://127.0.0.1:9" },
      fetch: (async () => {
        upstreamCalls += 1;
        return Response.json({ ok: true });
      }) as typeof fetch,
    });
    broker.start();
    closers.push(() => broker.stop());
    const issue = (runId: string, quota: {
      id: string;
      maxInputTokens: number | null;
      maxOutputTokens: number | null;
    }) => broker.issueLease({
      runId,
      provider: "openai",
      models: ["gpt-4o-mini"],
      endpointClasses: ["responses", "chat"],
      expiresAt: Date.now() + 60_000,
      maxRequests: 6,
      budgetQuotas: [{
        ...quota,
        maxRequests: null,
        usedRequests: 0,
        usedInputTokens: 0,
        usedOutputTokens: 0,
      }],
    });
    const outputLease = issue("output-token-cap", {
      id: "output-token-budget",
      maxInputTokens: null,
      maxOutputTokens: 10,
    });
    const post = (token: string, body: unknown, path = "/v1/responses") => fetch(`${broker.endpoint}/openai${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    expect((await post(outputLease.token, {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "x" }],
      max_tokens: 6,
      n: 2,
    }, "/v1/chat/completions")).status).toBe(429);
    expect((await post(outputLease.token, { model: "gpt-4o-mini", input: "x", max_output_tokens: 10, max_tokens: 11 })).status).toBe(429);
    expect((await post(outputLease.token, { model: "gpt-4o-mini", input: "x", max_output_tokens: 0 })).status).toBe(429);
    expect((await post(outputLease.token, {
      model: "gpt-4o-mini",
      input: "speak",
      max_output_tokens: 10,
      modalities: ["text", "audio"],
    })).status).toBe(429);
    expect(upstreamCalls).toBe(0);
    expect((await post(outputLease.token, { model: "gpt-4o-mini", input: "x", max_output_tokens: 10 })).status).toBe(200);
    expect(broker.getLeaseObservation(outputLease.id)).toMatchObject({ accountedOutputTokens: 10 });

    const inputLease = issue("input-token-cap", {
      id: "input-token-budget",
      maxInputTokens: 10,
      maxOutputTokens: null,
    });
    expect((await post(inputLease.token, { model: "gpt-4o-mini", input: "serialized body exceeds ten bytes" })).status).toBe(429);
    expect(upstreamCalls).toBe(1);
    expect(broker.getLeaseObservation(inputLease.id)).toMatchObject({ accountedInputTokens: 0 });
  });

  test("rejects opaque provider-side context before enforcing input or cost caps", async () => {
    let upstreamCalls = 0;
    const broker = new ProviderBroker({
      credentials: { OPENAI_API_KEY: "secret", GEMINI_API_KEY: "gemini-secret" },
      upstreams: { openai: "http://127.0.0.1:9", gemini: "http://127.0.0.1:9" },
      fetch: (async () => {
        upstreamCalls += 1;
        return Response.json({ ok: true });
      }) as typeof fetch,
    });
    broker.start();
    closers.push(() => broker.stop());
    const lease = broker.issueLease({
      runId: "opaque-context-cap",
      provider: "openai",
      models: ["gpt-4o-mini", "gpt-4o-search-preview"],
      endpointClasses: ["responses", "chat"],
      expiresAt: Date.now() + 60_000,
      maxRequests: 16,
      budgetQuotas: [{
        id: "opaque-input-budget",
        maxRequests: null,
        usedRequests: 0,
        maxInputTokens: 100_000,
        usedInputTokens: 0,
        maxOutputTokens: null,
        usedOutputTokens: 0,
      }],
    });
    const post = (body: unknown, path = "/v1/responses") => fetch(`${lease.baseUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${lease.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const opaqueBodies = [
      { model: "gpt-4o-mini", input: "continue", previous_response_id: "resp_123" },
      { model: "gpt-4o-mini", input: "continue", conversation: "conv_123" },
      { model: "gpt-4o-mini", input: "continue", prompt: { id: "pmpt_123" } },
      { model: "gpt-4o-mini", input: [{ type: "input_file", file_id: "file_123" }] },
      { model: "gpt-4o-mini", input: [{ type: "input_file", file_url: "https://example.test/large.pdf" }] },
      { model: "gpt-4o-mini", input: [{ type: "item_reference", id: "item_large_prior_context" }] },
      { model: "gpt-4o-mini", input: "search", tools: [{ type: "web_search_preview" }] },
      { model: "gpt-4o-mini", input: [{ type: "input_image", image_url: "https://example.test/image.png" }] },
    ];
    for (const body of opaqueBodies) {
      const response = await post(body);
      expect(response.status).toBe(429);
      expect(await response.text()).toContain("unavailable under an input or cost cap");
    }
    const search = await post({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "latest" }],
      max_tokens: 1,
      web_search_options: { search_context_size: "high" },
    }, "/v1/chat/completions");
    expect(search.status).toBe(429);
    expect(await search.text()).toContain("web_search_options");
    const priorAudio = await post({
      model: "gpt-4o-mini",
      messages: [
        { role: "assistant", audio: { id: "audio_large_prior_response" } },
        { role: "user", content: "continue" },
      ],
      max_tokens: 1,
    }, "/v1/chat/completions");
    expect(priorAudio.status).toBe(429);
    expect(await priorAudio.text()).toContain("audio.id");
    const searchModel = await post({
      model: "gpt-4o-search-preview",
      messages: [{ role: "user", content: "latest" }],
      max_tokens: 1,
    }, "/v1/chat/completions");
    expect(searchModel.status).toBe(429);
    expect(await searchModel.text()).toContain("bounded text-generation policy");
    const audio = await post({ model: "gpt-4o-mini", input: "speak", modalities: ["text", "audio"] });
    expect(audio.status).toBe(429);
    expect(await audio.text()).toContain("output modality audio");
    const automaticTier = await post({ model: "gpt-4o-mini", input: "hello", service_tier: "auto" });
    expect(automaticTier.status).toBe(429);
    expect(await automaticTier.text()).toContain("service tiers");

    const geminiLease = broker.issueLease({
      runId: "gemini-service-tier-cap",
      provider: "gemini",
      models: ["gemini-2.5-flash", "gemini-image"],
      endpointClasses: ["generate"],
      expiresAt: Date.now() + 60_000,
      maxRequests: 4,
      budgetQuotas: [{
        id: "gemini-input-budget",
        maxRequests: null,
        usedRequests: 0,
        maxInputTokens: 100_000,
        usedInputTokens: 0,
        maxOutputTokens: 100,
        usedOutputTokens: 0,
      }],
    });
    const priority = await fetch(`${geminiLease.baseUrl}/v1beta/models/gemini-2.5-flash:generateContent`, {
      method: "POST",
      headers: { authorization: `Bearer ${geminiLease.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
        generationConfig: { maxOutputTokens: 1 },
        serviceTier: "priority",
      }),
    });
    expect(priority.status).toBe(429);
    expect(await priority.text()).toContain("service tiers");
    const candidates = await fetch(`${geminiLease.baseUrl}/v1beta/models/gemini-2.5-flash:generateContent`, {
      method: "POST",
      headers: { authorization: `Bearer ${geminiLease.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
        generationConfig: { maxOutputTokens: 100, candidateCount: 2 },
      }),
    });
    expect(candidates.status).toBe(429);
    expect(await candidates.text()).toContain("aggregate output token budget");
    const imageModel = await fetch(`${geminiLease.baseUrl}/v1beta/models/gemini-image:generateContent`, {
      method: "POST",
      headers: { authorization: `Bearer ${geminiLease.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "draw" }] }],
        generationConfig: { maxOutputTokens: 1 },
      }),
    });
    expect(imageModel.status).toBe(429);
    expect(await imageModel.text()).toContain("bounded text-generation policy");
    const geminiAuto = await fetch(`${geminiLease.baseUrl}/v1beta/models/gemini-2.5-flash:generateContent`, {
      method: "POST",
      headers: { authorization: `Bearer ${geminiLease.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
        generationConfig: { maxOutputTokens: 1 },
        serviceTier: "auto",
      }),
    });
    expect(geminiAuto.status).toBe(429);
    expect(await geminiAuto.text()).toContain("service tiers");
    expect(upstreamCalls).toBe(0);

    const inline = await post({
      model: "gpt-4o-mini",
      input: "inline only",
      tools: [{ type: "function", function: { name: "local", parameters: { type: "object" } } }],
    });
    expect(inline.status).toBe(200);
    expect(upstreamCalls).toBe(1);
  });

  test("conservatively accounts priced requests and stops a run before mid-run cost exhaustion", async () => {
    const pricingId = "broker-mid-run-budget";
    pricingIds.push(pricingId);
    registerPricing({
      id: pricingId,
      provider: "openai",
      model: "gpt-4o-mini",
      effectiveFrom: 0,
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 1,
    });
    let upstreamCalls = 0;
    const broker = new ProviderBroker({
      credentials: { OPENAI_API_KEY: "secret" },
      upstreams: { openai: "http://127.0.0.1:9" },
      fetch: (async () => {
        upstreamCalls += 1;
        return Response.json({ usage: { input_tokens: 1, output_tokens: 1 } });
      }) as typeof fetch,
    });
    broker.start();
    closers.push(() => broker.stop());
    const requestPayload = {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 100,
      n: 2,
    };
    const requestBody = JSON.stringify(requestPayload);
    const normalizedRequestBytes = Buffer.byteLength(JSON.stringify({ ...requestPayload, service_tier: "default" }));
    const perRequestMaximum = (normalizedRequestBytes + 200) / 1_000_000;
    const lease = broker.issueLease({
      runId: "cost-capped-run",
      provider: "openai",
      models: ["gpt-4o-mini"],
      endpointClasses: ["chat"],
      expiresAt: Date.now() + 60_000,
      maxRequests: 3,
      maxCostUsd: perRequestMaximum * 1.5,
    });
    const send = () => fetch(`${lease.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${lease.token}`, "content-type": "application/json" },
      body: requestBody,
    });

    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);
    expect(upstreamCalls).toBe(1);
    expect(broker.getLeaseObservation(lease.id)).toMatchObject({
      requests: 2,
      observedCostUsd: 0,
      accountedCostUsd: perRequestMaximum,
    });
  });

  test("forces deterministic standard service tiers when a cost-capped request omits them", async () => {
    const entries = [
      { id: "tier-openai", provider: "openai", model: "gpt-4o-mini" },
      { id: "tier-anthropic", provider: "anthropic", model: "claude-test" },
      { id: "tier-gemini", provider: "gemini", model: "gemini-2.5-flash" },
      { id: "tier-xai", provider: "xai", model: "grok-test" },
    ];
    for (const entry of entries) {
      pricingIds.push(entry.id);
      registerPricing({
        ...entry,
        effectiveFrom: 0,
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 1,
      });
    }
    const forwarded = new Map<string, Record<string, unknown>>();
    const broker = new ProviderBroker({
      credentials: {
        OPENAI_API_KEY: "openai-secret",
        ANTHROPIC_API_KEY: "anthropic-secret",
        GEMINI_API_KEY: "gemini-secret",
        XAI_API_KEY: "xai-secret",
      },
      upstreams: {
        openai: "http://127.0.0.1:9",
        anthropic: "http://127.0.0.1:9",
        gemini: "http://127.0.0.1:9",
        xai: "http://127.0.0.1:9",
      },
      fetch: (async (_input, init) => {
        const body = JSON.parse(await new Response(init?.body).text()) as Record<string, unknown>;
        const model = typeof body.model === "string" ? body.model : "gemini-2.5-flash";
        forwarded.set(model, body);
        return Response.json({ ok: true });
      }) as typeof fetch,
    });
    broker.start();
    closers.push(() => broker.stop());
    const lease = (provider: "openai" | "anthropic" | "gemini" | "xai", model: string, endpointClass: "chat" | "messages" | "generate") => broker.issueLease({
      runId: `tier-${provider}`,
      provider,
      models: [model],
      endpointClasses: [endpointClass],
      expiresAt: Date.now() + 60_000,
      maxRequests: 1,
      maxCostUsd: 1,
    });
    const openai = lease("openai", "gpt-4o-mini", "chat");
    const anthropic = lease("anthropic", "claude-test", "messages");
    const gemini = lease("gemini", "gemini-2.5-flash", "generate");
    const xai = lease("xai", "grok-test", "chat");
    const requests = [
      fetch(`${openai.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${openai.token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini", messages: [], max_tokens: 1 }),
      }),
      fetch(`${anthropic.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${anthropic.token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-test", messages: [], max_tokens: 1 }),
      }),
      fetch(`${gemini.baseUrl}/v1beta/models/gemini-2.5-flash:generateContent`, {
        method: "POST",
        headers: { authorization: `Bearer ${gemini.token}`, "content-type": "application/json" },
        body: JSON.stringify({ contents: [], generationConfig: { maxOutputTokens: 1 } }),
      }),
      fetch(`${xai.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${xai.token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "grok-test", messages: [], max_tokens: 1 }),
      }),
    ];
    const responses = await Promise.all(requests);
    await Promise.all(responses.map((response) => response.text()));

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    expect(forwarded.get("gpt-4o-mini")?.service_tier).toBe("default");
    expect(forwarded.get("claude-test")?.service_tier).toBe("standard_only");
    expect(forwarded.get("gemini-2.5-flash")?.serviceTier).toBe("STANDARD");
    expect(forwarded.get("grok-test")?.service_tier).toBe("default");
  });

  test("caps in-flight lease concurrency and releases every body-memory reservation", async () => {
    let entered!: () => void;
    let release!: () => void;
    const upstreamEntered = new Promise<void>((resolve) => { entered = resolve; });
    const upstreamRelease = new Promise<void>((resolve) => { release = resolve; });
    const broker = new ProviderBroker({
      credentials: { OPENAI_API_KEY: "secret" },
      upstreams: { openai: "http://127.0.0.1:9" },
      fetch: (async () => {
        entered();
        await upstreamRelease;
        return Response.json({ ok: true });
      }) as typeof fetch,
    });
    broker.start();
    closers.push(() => broker.stop());
    const lease = broker.issueLease({
      runId: "lease-concurrency",
      provider: "openai",
      models: ["allowed"],
      endpointClasses: ["responses"],
      expiresAt: Date.now() + 60_000,
      maxRequests: 4,
      maxBodyBytes: 128,
      maxConcurrentRequests: 1,
      maxInFlightBodyBytes: 128,
    });
    const send = () => fetch(`${lease.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${lease.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "allowed" }),
    });

    const first = send();
    await upstreamEntered;
    expect(broker.getResourceUsage()).toMatchObject({ activeRequests: 1, inFlightBodyBytes: 128 });
    expect((await send()).status).toBe(429);
    expect(broker.getLeaseObservation(lease.id)).toMatchObject({ requests: 1, activeRequests: 1, inFlightBodyBytes: 128 });

    release();
    expect((await first).status).toBe(200);
    await Bun.sleep(0);
    expect(broker.getResourceUsage()).toMatchObject({ activeRequests: 0, inFlightBodyBytes: 0 });
    expect(broker.revokeLease(lease.id)).toBe(true);
    expect(broker.getResourceUsage().leases).toBe(0);
  });

  test("caps aggregate broker body memory across otherwise independent leases", async () => {
    let entered!: () => void;
    let release!: () => void;
    const upstreamEntered = new Promise<void>((resolve) => { entered = resolve; });
    const upstreamRelease = new Promise<void>((resolve) => { release = resolve; });
    const broker = new ProviderBroker({
      credentials: { OPENAI_API_KEY: "secret" },
      upstreams: { openai: "http://127.0.0.1:9" },
      maxConcurrentRequests: 4,
      maxInFlightBodyBytes: 128,
      fetch: (async () => {
        entered();
        await upstreamRelease;
        return Response.json({ ok: true });
      }) as typeof fetch,
    });
    broker.start();
    closers.push(() => broker.stop());
    const issue = (runId: string) => broker.issueLease({
      runId,
      provider: "openai",
      models: ["allowed"],
      endpointClasses: ["responses"],
      expiresAt: Date.now() + 60_000,
      maxRequests: 1,
      maxBodyBytes: 128,
      maxInFlightBodyBytes: 128,
    });
    const firstLease = issue("global-memory-1");
    const secondLease = issue("global-memory-2");
    const send = (token: string) => fetch(`${broker.endpoint}/openai/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "allowed" }),
    });

    const first = send(firstLease.token);
    await upstreamEntered;
    expect((await send(secondLease.token)).status).toBe(503);
    expect(broker.getLeaseObservation(secondLease.id)?.requests).toBe(0);
    release();
    expect((await first).status).toBe(200);
    await Bun.sleep(0);
    expect(broker.getResourceUsage()).toMatchObject({ activeRequests: 0, inFlightBodyBytes: 0 });
  });

  test("prunes expired lease material before authenticating another request", async () => {
    const broker = new ProviderBroker({ credentials: { OPENAI_API_KEY: "secret" } });
    broker.start();
    closers.push(() => broker.stop());
    const expiresAt = Date.now() + 500;
    const lease = broker.issueLease({
      runId: "expiring-lease",
      provider: "openai",
      models: ["allowed"],
      endpointClasses: ["responses"],
      expiresAt,
      maxRequests: 1,
    });
    expect(broker.getResourceUsage().leases).toBe(1);
    while (Date.now() <= expiresAt) await Bun.sleep(10);

    const response = await fetch(`${lease.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${lease.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "allowed" }),
    });
    expect(response.status).toBe(401);
    expect(broker.getResourceUsage().leases).toBe(0);
  });

  test("bounds chunked request bodies before buffering the complete payload", async () => {
    let upstreamCalled = false;
    const broker = new ProviderBroker({
      credentials: { OPENAI_API_KEY: "secret" },
      upstreams: { openai: "http://127.0.0.1:9" },
      fetch: (async () => {
        upstreamCalled = true;
        return Response.json({ ok: true });
      }) as typeof fetch,
    });
    broker.start();
    closers.push(() => broker.stop());
    const lease = broker.issueLease({
      runId: "chunked-body",
      provider: "openai",
      models: ["allowed"],
      endpointClasses: ["chat"],
      expiresAt: Date.now() + 60_000,
      maxRequests: 1,
      maxBodyBytes: 128,
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(96)));
        controller.enqueue(new TextEncoder().encode("y".repeat(96)));
        controller.close();
      },
    });
    const response = await fetch(`${lease.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${lease.token}`, "content-type": "application/json" },
      body,
    });
    expect(response.status).toBe(413);
    expect(upstreamCalled).toBe(false);
  });

  test("keeps the stream lease timer active until the response body terminates", async () => {
    let upstreamCancelled = false;
    const broker = new ProviderBroker({
      credentials: { OPENAI_API_KEY: "secret" },
      upstreams: { openai: "http://127.0.0.1:9" },
      fetch: (async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("first"));
        },
        cancel() {
          upstreamCancelled = true;
        },
      }), { headers: { "content-type": "text/event-stream" } })) as typeof fetch,
    });
    broker.start();
    closers.push(() => broker.stop());
    const lease = broker.issueLease({
      runId: "stream-timeout",
      provider: "openai",
      models: ["allowed"],
      endpointClasses: ["responses"],
      expiresAt: Date.now() + 60_000,
      maxRequests: 1,
      maxStreamMs: 40,
    });
    const response = await fetch(`${lease.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${lease.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "allowed", stream: true }),
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect(await reader.read()).toMatchObject({ done: false });
    expect(await reader.read()).toMatchObject({ done: true });
    expect(upstreamCancelled).toBe(true);
    expect(broker.getLogs().at(-1)).toMatchObject({ status: 504, error: "Provider stream exceeded its duration limit." });
  });

  test("supports Anthropic, Gemini, and xAI authentication protocols", async () => {
    const seen: Array<{ path: string; authorization: string | null; apiKey: string | null; googleKey: string | null }> = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        seen.push({
          path: url.pathname,
          authorization: request.headers.get("authorization"),
          apiKey: request.headers.get("x-api-key"),
          googleKey: request.headers.get("x-goog-api-key"),
        });
        return Response.json({ ok: true });
      },
    });
    closers.push(() => upstream.stop(true));
    const base = `http://127.0.0.1:${upstream.port}`;
    const broker = new ProviderBroker({
      credentials: { ANTHROPIC_API_KEY: "anthropic-real", GEMINI_API_KEY: "gemini-real", XAI_API_KEY: "xai-real" },
      upstreams: { anthropic: base, gemini: base, xai: base },
    });
    broker.start();
    closers.push(() => broker.stop());

    const anthropic = broker.issueLease({ runId: "a", provider: "anthropic", models: ["claude-test"], endpointClasses: ["messages"], expiresAt: Date.now() + 60_000, maxRequests: 1 });
    const gemini = broker.issueLease({ runId: "g", provider: "gemini", models: ["gemini-test"], endpointClasses: ["generate"], expiresAt: Date.now() + 60_000, maxRequests: 1 });
    const xai = broker.issueLease({ runId: "x", provider: "xai", models: ["grok-test"], endpointClasses: ["chat"], expiresAt: Date.now() + 60_000, maxRequests: 1 });

    await fetch(`${anthropic.baseUrl}/v1/messages`, { method: "POST", headers: { "x-api-key": anthropic.token, "content-type": "application/json" }, body: JSON.stringify({ model: "claude-test" }) });
    await fetch(`${gemini.baseUrl}/v1beta/models/gemini-test:generateContent?key=${gemini.token}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    await fetch(`${xai.baseUrl}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${xai.token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "grok-test" }) });

    expect(seen[0]?.apiKey).toBe("anthropic-real");
    expect(seen[1]?.googleKey).toBe("gemini-real");
    expect(seen[2]?.authorization).toBe("Bearer xai-real");
  });

  test("allows bounded provider extensions without permitting built-in replacement", () => {
    expect(() => registerProvider({
      id: "openai",
      upstream: "https://example.com",
      credentialEnv: "EVIL_KEY",
      routePrefixes: ["/v1/chat/completions"],
      authenticate() {},
      validateBoundedInput() { return null; },
    })).toThrow("already registered");

    registerProvider({
      id: "custom-test",
      upstream: "https://example.com",
      credentialEnv: "CUSTOM_TEST_KEY",
      routePrefixes: ["/v1/chat/completions"],
      authenticate(headers, credential) { headers.set("authorization", `Bearer ${credential}`); },
      validateBoundedInput() { return null; },
    });
    expect(getProvider("custom-test")?.credentialEnv).toBe("CUSTOM_TEST_KEY");
    expect(unregisterProvider("custom-test")).toBe(true);
  });
});

function replaceOperation(operations: BrokerLinkedOperation[], operation: BrokerLinkedOperation) {
  const index = operations.findIndex((candidate) => candidate.operationId === operation.operationId);
  if (index < 0) operations.push(operation);
  else operations[index] = operation;
}

function linkedTargetScope(childDeadlineAt: number) {
  return {
    provider: "openai",
    models: ["gpt-test"],
    endpointClasses: ["responses"] as const,
    expiresAt: childDeadlineAt + 60_000,
    childDeadlineAt,
    replyMarginMs: 2_000,
    maxRequests: 2,
    maxInputTokens: 100,
    maxOutputTokens: 10,
    maxCostUsd: null,
    budgetQuotas: [
      {
        id: "target-provider-budget",
        maxRequests: 2,
        usedRequests: 0,
        maxInputTokens: 100,
        usedInputTokens: 0,
        maxOutputTokens: 10,
        usedOutputTokens: 0,
        maxCostUsd: null,
        usedCostUsd: 0,
      },
      {
        id: "global-budget",
        maxRequests: 4,
        usedRequests: 0,
        maxInputTokens: 200,
        usedInputTokens: 0,
        maxOutputTokens: 20,
        usedOutputTokens: 0,
        maxCostUsd: null,
        usedCostUsd: 0,
      },
    ],
  };
}
