import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { tool } from "@opencode-ai/plugin";
import { HeadlessDaemonClient } from "../src/daemon/client";
import { connectOrStartDaemon } from "../src/daemon/connect";
import { HeadlessDaemon } from "../src/daemon/server";
import {
  CORE_MCP_TOOL_NAMES,
  HEADLESS_MCP_TOOLSET_ENV,
  HEADLESS_TOOL_REGISTRY,
  assertMcpToolAllowed,
  filterToolsByMcpToolset,
  resolveMcpToolset,
} from "../src/contracts/tool-registry";
import {
  __handleCallToolForTest,
  __handleListToolsForTest,
  __normalizeMcpInputSchemaForTest,
  mcpToolDefinitions,
  mcpToolsForScopes,
  server,
  startMcpServer,
} from "../src/mcp/server";
import { server as openCodePluginServer } from "../plugin/index";

const MCP_EXPECTED_TOOLS = [
  "headless_run",
  "headless_deliberate",
  "headless_project_trust",
  "headless_fleet_profile",
  "headless_fleet_health",
  "headless_goal",
  "headless_collaboration",
  "headless_approval",
  "headless_candidate",
  "headless_append_note",
  "headless_record_artifact",
  "headless_read_context",
  "headless_task_state",
  "headless_propose_final",
  "headless_ask_for_work",
  "ask_for_backup",
  "headless_record_task_claim",
  "headless_record_consensus_vote",
  "headless_record_idle_action",
  "headless_record_release_gate",
  "headless_gate",
  "headless_get_cooperation_instructions",
  "send_message",
  "wait_for_handoff",
  "headless_get_messages",
  "council_deliberate",
  "headless_workflow_run",
  "headless_workflow_status",
];

describe("MCP server surface", () => {
  test("exports a deferred stdio server", () => {
    expect(typeof startMcpServer).toBe("function");
    expect(server).toBeDefined();
  });

  /**
   * Headless shares an MCP session with other servers, and a client picks a
   * tool by name. An unprefixed name is therefore a collision waiting to
   * happen: `get_messages` was exposed by three servers at once, and
   * `headless_run` collided with a ContextRelay tool of the same name, so an
   * agent told to "use headless" reached for the wrong product.
   *
   * Every tool must claim the product namespace unless it is listed here as a
   * deliberate exception. Adding a new unprefixed tool fails this test.
   */
  test("keeps every tool inside the headless namespace or declares the exception", () => {
    const acknowledgedUnprefixed = new Set([
      "ask_for_backup",
      "send_message",
      "wait_for_handoff",
      "council_deliberate",
    ]);
    const names = mcpToolDefinitions.map((tool) => tool.name);
    const unprefixed = names.filter((name) => !name.startsWith("headless_") && !acknowledgedUnprefixed.has(name));
    expect(unprefixed, "new MCP tools must be headless_-prefixed or acknowledged").toEqual([]);
    // The exception list must not rot: every entry still has to be a real tool.
    expect([...acknowledgedUnprefixed].filter((name) => !names.includes(name))).toEqual([]);
  });

  test("matches the OpenCode plugin tool names, schemas, and defaults", async () => {
    const previous = process.env[HEADLESS_MCP_TOOLSET_ENV];
    process.env[HEADLESS_MCP_TOOLSET_ENV] = "full";
    try {
    const names = mcpToolDefinitions.map((tool) => tool.name).sort();
    expect(names).toEqual([...MCP_EXPECTED_TOOLS].sort());
    const plugin = await openCodePluginServer({} as never);
    const pluginTools = plugin.tool ?? {};
    expect(names).toEqual(Object.keys(pluginTools).sort());
    const mcpSchemas = Object.fromEntries(mcpToolDefinitions.map((definition) => [
      definition.name,
      canonicalSchema(definition.inputSchema),
    ]));
    const pluginSchemas = Object.fromEntries(Object.entries(pluginTools).map(([name, definition]) => [
      name,
      canonicalSchema(toolSchema(definition)),
    ]));
    expect(pluginSchemas).toEqual(mcpSchemas);
    expect(mcpSchemas.headless_deliberate).toMatchObject({
      properties: {
        backends: { default: "opencode,codex" },
        authMode: { default: "native-login" },
        contextRefs: { type: "string" },
        mode: { default: "read-only" },
      },
    });
    expect(mcpSchemas.headless_record_task_claim).toMatchObject({ properties: { leaseMs: { default: 300_000 } } });
    } finally {
      if (previous === undefined) delete process.env[HEADLESS_MCP_TOOLSET_ENV];
      else process.env[HEADLESS_MCP_TOOLSET_ENV] = previous;
    }
  });

  test("advertises only tools and actions available to the authenticated scope set", () => {
    const runOnly = mcpToolsForScopes(["run"], "full");
    expect(runOnly.map((tool) => tool.name)).toContain("headless_run");
    expect(runOnly.map((tool) => tool.name)).not.toContain("headless_append_note");
    const schemas = Object.fromEntries(mcpToolDefinitions.map((tool) => [tool.name, JSON.stringify(tool.inputSchema)]));
    expect(schemas.headless_project_trust).toContain("status");
    expect(schemas.headless_project_trust).not.toContain("grant");
    expect(schemas.headless_approval).not.toContain("resolve");
    expect(schemas.headless_candidate).not.toContain("integrate");
    expect(schemas.headless_collaboration).not.toContain("transferSynthesizer");
  });

  test("defaults the lead MCP toolset to core and restores full on demand", () => {
    expect(CORE_MCP_TOOL_NAMES.length).toBeLessThanOrEqual(10);
    expect(resolveMcpToolset(undefined)).toBe("core");
    expect(resolveMcpToolset("core")).toBe("core");
    expect(resolveMcpToolset("full")).toBe("full");
    expect(() => resolveMcpToolset("maybe")).toThrow(/core" or "full/);

    const core = filterToolsByMcpToolset(HEADLESS_TOOL_REGISTRY, "core");
    const full = filterToolsByMcpToolset(HEADLESS_TOOL_REGISTRY, "full");
    expect(core.length).toBe(CORE_MCP_TOOL_NAMES.length);
    expect(core.every((tool) => CORE_MCP_TOOL_NAMES.includes(tool.name as typeof CORE_MCP_TOOL_NAMES[number]))).toBe(true);
    expect(full.map((tool) => tool.name).sort()).toEqual(HEADLESS_TOOL_REGISTRY.map((tool) => tool.name).sort());

    expect(() => assertMcpToolAllowed("headless_run", "core")).not.toThrow();
    expect(() => assertMcpToolAllowed("headless_append_note", "core")).toThrow(/HEADLESS_MCP_TOOLSET=full/);
    expect(() => assertMcpToolAllowed("headless_append_note", "full")).not.toThrow();

    const scopedCore = mcpToolsForScopes(["run", "ledger:read", "task", "messages"], "core");
    expect(scopedCore.length).toBeLessThanOrEqual(10);
    expect(scopedCore.map((tool) => tool.name)).toContain("headless_run");
    expect(scopedCore.map((tool) => tool.name)).not.toContain("headless_workflow_run");

    const previous = process.env[HEADLESS_MCP_TOOLSET_ENV];
    process.env[HEADLESS_MCP_TOOLSET_ENV] = "core";
    try {
      expect(mcpToolsForScopes(["admin"]).length).toBe(CORE_MCP_TOOL_NAMES.length);
    } finally {
      if (previous === undefined) delete process.env[HEADLESS_MCP_TOOLSET_ENV];
      else process.env[HEADLESS_MCP_TOOLSET_ENV] = previous;
    }
  });

  test("rejects non-core tool calls when the lead toolset is core", async () => {
    const previous = process.env[HEADLESS_MCP_TOOLSET_ENV];
    process.env[HEADLESS_MCP_TOOLSET_ENV] = "core";
    try {
      const response = await __handleCallToolForTest({
        params: { name: "headless_append_note", arguments: { text: "blocked" } },
      });
      expect(response.isError).toBe(true);
      expect(response.content[0]?.text).toContain("HEADLESS_MCP_TOOLSET=full");
    } finally {
      if (previous === undefined) delete process.env[HEADLESS_MCP_TOOLSET_ENV];
      else process.env[HEADLESS_MCP_TOOLSET_ENV] = previous;
    }
  });
});

describe("MCP authenticated daemon integration", () => {
  let fixture!: DaemonFixture;

  beforeEach(async () => {
    fixture = await startDaemonFixture();
  });

  afterEach(async () => {
    if (!fixture) return;
    await fixture.daemon.stop();
    restoreEnv(fixture.previousEnv);
    rmSync(fixture.runtime, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
    fixture = undefined!;
  });

  test("uses a scoped MCP principal and ignores client identity claims", async () => {
    const response = await callTool("send_message", {
      from: "spoofed-lead",
      to: "reviewer",
      content: "identity-bound message",
      source: "spoofed-lead",
      actor: "spoofed-lead",
      sessionId: "mcp-attribution",
    });

    expect(response.isError).not.toBe(true);

    const integration = await connectOrStartDaemon({
      projectRoot: fixture.project,
      credential: { integration: "lead-codex-g1" },
    });
    const ping = await integration.call<{ principal: string }>("ping");
    expect(ping.principal).toBe("integration:lead-codex-g1");
    await expect(integration.call("auth.list")).rejects.toMatchObject({ code: "POLICY_DENIED" });
    await expect(integration.call("ledger.event", {
      type: "finality_decision",
      sessionId: "mcp-attribution",
      payload: { content: "client declared completion", source: "coordinator" },
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    const context = await fixture.rootClient.call<RawContext>("ledger.context", {
      view: "raw",
      limit: 50,
      sessionId: "mcp-attribution",
    });
    const message = context.entries.find((entry) => entry.content === "identity-bound message");

    expect(message?.source).toBe("integration:lead-codex-g1");
    expect(message?.message?.from).toBe("integration:lead-codex-g1");
    expect(message?.source).not.toBe("coordinator");
  });

  test("returns SDK-conformant object input schemas from the authenticated tools/list path", async () => {
    const listed = ListToolsResultSchema.parse(await __handleListToolsForTest());
    expect(listed.tools.length).toBeGreaterThan(0);
    expect(listed.tools.every((tool) => tool.inputSchema.type === "object")).toBe(true);
    const composed = __normalizeMcpInputSchemaForTest({
      oneOf: [
        { type: "object", properties: { action: { const: "start" } } },
        { type: "object", properties: { action: { const: "status" } } },
      ],
    });
    expect(composed.type).toBe("object");
    expect(composed.oneOf).toHaveLength(2);
  });

  test("persists a redacted durable message and drains it without a host-channel fallback", async () => {
    const chatId = "mcp-redaction";
    const secret = "sk-1234567890abcdefghijkl";

    await callTool("headless_append_note", { text: "attach lead", sessionId: chatId });
    const integration = await connectOrStartDaemon({
      projectRoot: fixture.project,
      credential: { integration: "lead-codex-g1" },
    });
    await integration.call("messages.push", {
      chatId,
      content: `durable message ${secret}`,
    });

    const pulled = await callTool("headless_get_messages", { sessionId: chatId, limit: 10 });
    const pulledText = pulled.content[0]?.text ?? "";
    expect(pulled.isError).not.toBe(true);
    expect(pulledText).toContain("REDACTED");
    expect(pulledText).not.toContain(secret);

    const drained = await callTool("headless_get_messages", { sessionId: chatId, limit: 10 });
    expect(drained.content[0]?.text).toBe("no messages");

    const context = await fixture.rootClient.call<RawContext>("ledger.context", {
      view: "raw",
      limit: 50,
      sessionId: chatId,
    });
    const queued = context.entries.find((entry) => entry.type === "message" && entry.content?.includes("durable message"));
    expect(queued?.source).toBe("integration:lead-codex-g1");
    expect(queued?.message?.from).toBe("integration:lead-codex-g1");
    expect(JSON.stringify(queued)).not.toContain(secret);
  });

  test("ledger tools operate through the daemon instead of process-local state", async () => {
    const note = await callTool("headless_append_note", {
      text: "daemon-owned MCP note",
      source: "self-declared-principal",
      sessionId: "mcp-ledger",
    });
    const artifact = await callTool("headless_record_artifact", {
      kind: "test_report",
      title: "MCP boundary",
      summary: "daemon persisted",
      status: "passed",
      sessionId: "mcp-ledger",
    });
    const read = await callTool("headless_read_context", {
      view: "raw",
      limit: 50,
      sessionId: "mcp-ledger",
    });

    expect(note.isError).not.toBe(true);
    expect(artifact.isError).not.toBe(true);
    expect(read.isError).not.toBe(true);

    const context = JSON.parse(read.content[0]?.text ?? "{}") as RawContext;
    const persisted = context.entries.find((entry) => entry.content === "daemon-owned MCP note");
    expect(persisted?.source).toBe("integration:lead-codex-g1");
    expect(context.entries.some((entry) => entry.artifact?.title === "MCP boundary")).toBe(true);
  });
});

type ToolResponse = Awaited<ReturnType<typeof __handleCallToolForTest>>;

function toolSchema(definition: { args: Record<string, unknown> }) {
  return tool.schema.toJSONSchema(tool.schema.object(definition.args), { io: "input" });
}

function canonicalSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalSchema);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== "$schema")
    .map(([key, entry]) => [key, canonicalSchema(entry)]));
}

function callTool(name: string, args: Record<string, unknown>): Promise<ToolResponse> {
  return __handleCallToolForTest({ params: { name, arguments: args } });
}

type RawContext = {
  entries: Array<{
    type?: string;
    source?: string;
    content?: string;
    message?: { from?: string };
    artifact?: { title?: string };
  }>;
};

type DaemonFixture = {
  root: string;
  runtime: string;
  project: string;
  daemon: HeadlessDaemon;
  rootClient: HeadlessDaemonClient;
  previousEnv: Record<"HEADLESS_PROJECT_ROOT" | "HEADLESS_STATE_HOME" | "HEADLESS_RUNTIME_HOME" | "HEADLESS_LEAD_HOST" | "HEADLESS_MCP_TOOLSET", string | undefined>;
};

async function startDaemonFixture(): Promise<DaemonFixture> {
  const root = mkdtempSync(join(tmpdir(), "headless-mcp-test-"));
  const runtime = mkdtempSync("/tmp/hm-");
  const project = join(root, "project");
  mkdirSync(project);
  const previousEnv = {
    HEADLESS_PROJECT_ROOT: process.env.HEADLESS_PROJECT_ROOT,
    HEADLESS_STATE_HOME: process.env.HEADLESS_STATE_HOME,
    HEADLESS_RUNTIME_HOME: process.env.HEADLESS_RUNTIME_HOME,
    HEADLESS_LEAD_HOST: process.env.HEADLESS_LEAD_HOST,
    HEADLESS_MCP_TOOLSET: process.env.HEADLESS_MCP_TOOLSET,
  };
  process.env.HEADLESS_PROJECT_ROOT = project;
  process.env.HEADLESS_STATE_HOME = join(root, "state");
  process.env.HEADLESS_RUNTIME_HOME = runtime;
  process.env.HEADLESS_LEAD_HOST = "codex";
  // Integration fixtures exercise the full registry; product default remains core.
  process.env.HEADLESS_MCP_TOOLSET = "full";

  const daemon = new HeadlessDaemon({ projectRoot: project, principal: "owner" });
  await daemon.start();
  const rootClient = new HeadlessDaemonClient({ projectRoot: project });
  await rootClient.call("lead.use", { host: "codex" });
  return {
    root,
    runtime,
    project,
    daemon,
    rootClient,
    previousEnv,
  };
}

function restoreEnv(values: DaemonFixture["previousEnv"]) {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
