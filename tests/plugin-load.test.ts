import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin";
import { HeadlessDaemonClient } from "../src/daemon/client";
import { connectOrStartDaemon } from "../src/daemon/connect";
import { HeadlessDaemon } from "../src/daemon/server";
import { getProjectStatePaths } from "../src/runtime/project-state";
import { CORE_MCP_TOOL_NAMES } from "../src/contracts/tool-registry";
import plugin, { id, server } from "../plugin/index";

const EXPECTED_TOOLS = [
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

describe("OpenCode plugin loadability", () => {
  test("exports the plugin shape OpenCode accepts", () => {
    expect(id).toBe("headless");
    expect(plugin).toEqual({ id: "headless", server });
    expect(typeof plugin.server).toBe("function");
  });

  test("returns exactly the Headless tools with registry-accepted schemas", async () => {
    const previous = process.env.HEADLESS_MCP_TOOLSET;
    process.env.HEADLESS_MCP_TOOLSET = "full";
    try {
    const hooks = await server({} as never);
    const tools = hooks.tool ?? {};

    expect(Object.keys(tools).sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const [name, definition] of Object.entries(tools)) {
      expect(isPluginTool(definition)).toBe(true);
      const jsonSchema = registryStyleJsonSchema(definition);
      expect(jsonSchema.type).toBe("object");
      expect(jsonSchema.properties).toBeDefined();
      expect(jsonSchema).not.toHaveProperty("$defs");
      const isFleetTool = ["ask_for_backup", "send_message", "wait_for_handoff", "headless_get_messages", "council_deliberate"].includes(name);
      if (!isFleetTool) expect(name).toStartWith("headless_");
    }

    const goalSchema = registryStyleJsonSchema(tools.headless_goal!);
    expect(JSON.stringify(goalSchema)).toContain('"mode"');
    expect(JSON.stringify(goalSchema)).toContain('"read-only"');
    expect(JSON.stringify(goalSchema)).toContain('"write"');
    const goalProperties = goalSchema.properties as Record<string, Record<string, unknown>>;
    expect(goalProperties.authMode).not.toHaveProperty("default");
    expect(goalProperties.approvalPolicy).not.toHaveProperty("default");
    } finally {
      if (previous === undefined) delete process.env.HEADLESS_MCP_TOOLSET;
      else process.env.HEADLESS_MCP_TOOLSET = previous;
    }
  });

  test("defaults to the round-trip lead-core toolset", async () => {
    const previous = process.env.HEADLESS_MCP_TOOLSET;
    delete process.env.HEADLESS_MCP_TOOLSET;
    try {
      const hooks = await server({} as never);
      const names = Object.keys(hooks.tool ?? {}).sort();
      expect(names).toEqual([...CORE_MCP_TOOL_NAMES].sort());
      expect(names).toContain("headless_read_context");
      expect(names).toContain("headless_append_note");
      expect(names).toContain("headless_get_messages");
      expect(names).toContain("send_message");
      expect(names).toContain("headless_propose_final");
    } finally {
      if (previous === undefined) delete process.env.HEADLESS_MCP_TOOLSET;
      else process.env.HEADLESS_MCP_TOOLSET = previous;
    }
  });
});

describe("OpenCode plugin authenticated daemon integration", () => {
  let fixture: DaemonFixture | undefined;

  afterEach(async () => {
    if (!fixture) return;
    await fixture.daemon.stop();
    restoreEnv(fixture.previousEnv);
    rmSync(fixture.runtime, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
    fixture = undefined;
  });

  test("uses ToolContext.directory with a scoped, attributable integration credential", async () => {
    fixture = await startDaemonFixture();
    const context = pluginContext(fixture.project, "plugin-attribution");
    const hooks = await server({} as never);
    const append = hooks.tool?.headless_append_note;
    const send = hooks.tool?.send_message;
    const read = hooks.tool?.headless_read_context;

    expect(append).toBeDefined();
    expect(send).toBeDefined();
    expect(read).toBeDefined();

    await append!.execute({ text: "hello from plugin" }, context);
    await send!.execute({ to: "reviewer", content: "plugin identity message" }, context);
    const readResult = await read!.execute({ view: "raw" }, context);
    const state = getProjectStatePaths(fixture.project);
    const ledger = JSON.parse(readResult.output) as RawContext;
    const note = ledger.entries.find((entry) => entry.content === "hello from plugin");
    const message = ledger.entries.find((entry) => entry.content === "plugin identity message");

    expect(existsSync(state.ledgerPath)).toBe(true);
    expect(note?.source).toBe("integration:lead-opencode-g1");
    expect(message?.source).toBe("integration:lead-opencode-g1");
    expect(message?.message?.from).toBe("integration:lead-opencode-g1");

    const integration = await connectOrStartDaemon({
      projectRoot: fixture.project,
      credential: { integration: "lead-opencode-g1" },
    });
    const ping = await integration.call<{ principal: string }>("ping");
    expect(ping.principal).toBe("integration:lead-opencode-g1");
    await expect(integration.call("auth.list")).rejects.toMatchObject({ code: "POLICY_DENIED" });
  });

  test("pulls redacted session messages from the daemon queue", async () => {
    fixture = await startDaemonFixture();
    const context = pluginContext(fixture.project, "plugin-queue");
    const hooks = await server({} as never);
    const append = hooks.tool?.headless_append_note;
    const getMessages = hooks.tool?.headless_get_messages;
    expect(append).toBeDefined();
    expect(getMessages).toBeDefined();

    // The first plugin call attaches the configured foreground-lead credential.
    await append!.execute({ text: "provision plugin credential" }, context);
    const integration = new HeadlessDaemonClient({
      projectRoot: fixture.project,
      credential: { integration: "lead-opencode-g1" },
    });
    const secret = "sk-1234567890abcdefghijkl";
    await integration.call("messages.push", {
      chatId: context.sessionID,
      content: `plugin queue ${secret}`,
      meta: { source: "coordinator", actor: "coordinator" },
    });

    const first = await getMessages!.execute({ limit: 10 }, context);
    const messages = (JSON.parse(first.output) as { messages: Array<{ content: string }> }).messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain("REDACTED");
    expect(messages[0]?.content).not.toContain(secret);

    const second = await getMessages!.execute({ limit: 10 }, context);
    expect((JSON.parse(second.output) as { messages: unknown[] }).messages).toEqual([]);

    const ledger = await fixture.rootClient.call<RawContext>("ledger.context", {
      view: "raw",
      limit: 50,
      sessionId: context.sessionID,
    });
    const queued = ledger.entries.find((entry) => entry.content?.includes("plugin queue"));
    expect(queued?.source).toBe("integration:lead-opencode-g1");
    expect(queued?.message?.from).toBe("integration:lead-opencode-g1");
    expect(JSON.stringify(queued)).not.toContain(secret);
  });
});

function isPluginTool(value: unknown): value is ToolDefinition {
  return typeof value === "object" && value !== null && "args" in value && "description" in value && "execute" in value;
}

function registryStyleJsonSchema(definition: ToolDefinition) {
  const entries = Object.entries(definition.args ?? {});
  expect(entries.every((entry) => isZodType(entry[1]))).toBe(true);
  const zodObject = tool.schema.object(definition.args ?? {});
  const result = tool.schema.toJSONSchema(zodObject, { io: "input" });
  expect(typeof result).toBe("object");
  expect(result).not.toBeNull();
  expect(Array.isArray(result)).toBe(false);
  const { $defs, ...rest } = result as Record<string, unknown>;
  return $defs && typeof $defs === "object" && !Array.isArray($defs)
    ? { ...rest, definitions: $defs }
    : rest;
}

function isZodType(value: unknown) {
  return typeof value === "object" && value !== null && "_zod" in value;
}

function pluginContext(cwd: string, sessionID: string): ToolContext {
  return {
    sessionID,
    messageID: "message",
    agent: "build",
    directory: cwd,
    worktree: "/wrong-root",
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  };
}

type RawContext = {
  entries: Array<{
    source?: string;
    content?: string;
    message?: { from?: string };
  }>;
};

type DaemonFixture = {
  root: string;
  runtime: string;
  project: string;
  daemon: HeadlessDaemon;
  rootClient: HeadlessDaemonClient;
  previousEnv: Record<"HEADLESS_STATE_HOME" | "HEADLESS_RUNTIME_HOME", string | undefined>;
};

async function startDaemonFixture(): Promise<DaemonFixture> {
  const root = mkdtempSync(join(tmpdir(), "headless-plugin-test-"));
  const runtime = mkdtempSync("/tmp/hp-");
  const project = join(root, "project");
  mkdirSync(project);
  const previousEnv = {
    HEADLESS_STATE_HOME: process.env.HEADLESS_STATE_HOME,
    HEADLESS_RUNTIME_HOME: process.env.HEADLESS_RUNTIME_HOME,
    HEADLESS_MCP_TOOLSET: process.env.HEADLESS_MCP_TOOLSET,
  };
  process.env.HEADLESS_STATE_HOME = join(root, "state");
  process.env.HEADLESS_RUNTIME_HOME = runtime;
  process.env.HEADLESS_MCP_TOOLSET = "full";

  const daemon = new HeadlessDaemon({ projectRoot: project, principal: "owner" });
  await daemon.start();
  const rootClient = new HeadlessDaemonClient({ projectRoot: project });
  await rootClient.call("lead.use", { host: "opencode" });
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
