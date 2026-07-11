import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersistentMessageQueue } from "../src/runtime/message-queue";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("persistent daemon message queue", () => {
  test("isolates identical chat ids by authenticated principal", () => {
    const queue = createQueue();
    queue.enqueue("integration:mcp", "shared-chat", "mcp message");
    queue.enqueue("integration:plugin", "shared-chat", "plugin message");

    const mcp = queue.listUndrained("integration:mcp", "shared-chat");
    const plugin = queue.listUndrained("integration:plugin", "shared-chat");

    expect(mcp.map((message) => message.content)).toEqual(["mcp message"]);
    expect(plugin.map((message) => message.content)).toEqual(["plugin message"]);
    queue.markDrained("integration:mcp", mcp.map((message) => message.id));
    expect(queue.listUndrained("integration:mcp", "shared-chat")).toEqual([]);
    expect(queue.listUndrained("integration:plugin", "shared-chat")).toHaveLength(1);
    queue.close();
  });

  test("redacts before persistence and caps each principal/session queue", () => {
    const queue = createQueue(2);
    queue.enqueue("integration:mcp", "chat", "first");
    queue.enqueue("integration:mcp", "chat", "second");
    const inserted = queue.enqueue("integration:mcp", "chat", "secret sk-1234567890abcdefghijkl");
    const messages = queue.listUndrained("integration:mcp", "chat", 10);

    expect(inserted.droppedCount).toBe(1);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toBe("second");
    expect(messages[1]?.content).toContain("REDACTED");
    expect(messages[1]?.content).not.toContain("sk-1234567890abcdefghijkl");
    queue.close();
  });
});

function createQueue(max = 200) {
  const root = mkdtempSync(join(tmpdir(), "headless-message-queue-"));
  roots.push(root);
  return new PersistentMessageQueue(join(root, "messages.sqlite"), max);
}
