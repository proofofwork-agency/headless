import { describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin";
import plugin, { id, server } from "../plugin/index";

const EXPECTED_TOOLS = [
  "headless_append_note",
  "headless_deliberate",
  "headless_propose_final",
  "headless_read_context",
  "headless_record_artifact",
  "headless_run",
  "headless_task_state",
];

describe("OpenCode plugin loadability", () => {
  test("exports the legacy server plugin shape OpenCode accepts", () => {
    expect(id).toBe("headless");
    expect(plugin).toEqual({ id: "headless", server });
    expect(typeof plugin.server).toBe("function");
  });

  test("server returns exactly the Headless tools with registry-accepted shape", async () => {
    const hooks = await server({} as never);
    const tools = hooks.tool ?? {};

    expect(Object.keys(tools).sort()).toEqual(EXPECTED_TOOLS);
    for (const definition of Object.values(tools)) {
      expect(isPluginTool(definition)).toBe(true);
    }
  });

  test("each tool args object converts to JSON schema like the OpenCode registry path", async () => {
    const hooks = await server({} as never);

    for (const [name, definition] of Object.entries(hooks.tool ?? {})) {
      const jsonSchema = registryStyleJsonSchema(definition);
      expect(jsonSchema.type).toBe("object");
      expect(jsonSchema.properties).toBeDefined();
      expect(jsonSchema).not.toHaveProperty("$defs");
      expect(name).toStartWith("headless_");
    }
  });

  test("ledger tools use ToolContext.directory as the runtime root", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "headless-plugin-load-"));
    const context = pluginContext(cwd, "plugin-load-session");
    const hooks = await server({} as never);
    const append = hooks.tool?.headless_append_note;
    const read = hooks.tool?.headless_read_context;

    expect(append).toBeDefined();
    expect(read).toBeDefined();

    const note = await append!.execute({ text: "hello from plugin" }, context);
    const contextResult = await read!.execute({ view: "raw" }, context);
    const ledgerPath = join(cwd, ".headless", "sessions", "plugin-load-session", "ledger.jsonl");

    expect(note).toMatchObject({ title: "headless_append_note" });
    expect(existsSync(ledgerPath)).toBe(true);
    expect(JSON.parse(contextResult.output).entries.some((entry: { content?: string }) => entry.content === "hello from plugin")).toBe(true);
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
