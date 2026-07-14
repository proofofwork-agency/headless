/**
 * PersistentMessageQueue (headless port of CR pattern for channel push/pull).
 */
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { dirname } from "node:path";
import assert from "node:assert/strict";
import { safeJsonParse } from "./safe-json";
import { redactDeep } from "./redaction";
import { ensureOwnerOnlyDirectory } from "./project-state";

export interface QueueMessage {
  id: string; principal: string; chatId: string; content: string; meta?: unknown; createdAt: number; pushedAt?: number | null; pushError?: string | null; drainedAt?: number | null;
}

export class PersistentMessageQueue {
  private db: Database; private max: number;
  constructor(dbPath: string, maxBufferedMessages = 200) {
    ensureOwnerOnlyDirectory(dirname(dbPath));
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode=WAL");
    this.max = maxBufferedMessages;
    this.migrate();
    // Queue contents may contain private collaboration messages. Refuse to
    // continue when owner-only permissions cannot be enforced.
    chmodSync(dbPath, 0o600);
  }
  private migrate() {
    this.db.run(`CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, principal TEXT NOT NULL, chat_id TEXT NOT NULL, content TEXT NOT NULL, meta TEXT, created_at INTEGER NOT NULL, pushed_at INTEGER, push_error TEXT, drained_at INTEGER)`);
    const columns = this.db.query("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "principal")) {
      this.db.run("ALTER TABLE messages ADD COLUMN principal TEXT NOT NULL DEFAULT 'legacy'");
    }
    this.db.run("CREATE INDEX IF NOT EXISTS messages_principal_chat_pending ON messages(principal, chat_id, drained_at, created_at)");
  }
  enqueue(principal: string, chatId: string, content: string, meta?: unknown) {
    const id = `q_${randomUUID()}`;
    const now = Date.now();
    // Enforce cap BEFORE insert so queue never exceeds this.max undrained for the chat.
    // Drop oldest undrained to make room for the incoming message (LRU-style cap).
    let droppedCount = 0;
    const current = this.countUndrained(principal, chatId);
    if (current >= this.max) {
      const toDrop = current - this.max + 1;
      const oldest = this.db.query(`SELECT id FROM messages WHERE principal=? AND chat_id=? AND drained_at IS NULL ORDER BY created_at LIMIT ?`).all(principal, chatId, toDrop) as Array<{ id: string }>;
      if (oldest.length) {
        const ids = oldest.map((r) => r.id);
        const ph = ids.map(() => "?").join(",");
        this.db.run(`DELETE FROM messages WHERE id IN (${ph})`, ids);
        droppedCount = ids.length;
      }
    }
    const safe = redactDeep({ content, meta }).value as { content: string; meta?: unknown };
    this.db.run(`INSERT OR IGNORE INTO messages (id,principal,chat_id,content,meta,created_at) VALUES (?,?,?,?,?,?)`, [id, principal, chatId, safe.content, safe.meta ? JSON.stringify(safe.meta) : null, now]);
    const after = this.countUndrained(principal, chatId);
    assert(after <= this.max, `message queue cap violated for ${chatId}: ${after} > ${this.max}`);
    return { id, inserted: true, droppedCount };
  }
  listUndrained(principal: string, chatId: string, limit = 50): QueueMessage[] {
    const rows = this.db.query(`SELECT id,principal,chat_id,content,meta,created_at FROM messages WHERE principal=? AND chat_id=? AND drained_at IS NULL ORDER BY created_at LIMIT ?`).all(principal, chatId, limit) as Array<{ id: string; principal: string; chat_id: string; content: string; meta?: string | null; created_at: number }>;
    return rows.map(r => ({ id: r.id, principal: r.principal, chatId: r.chat_id, content: r.content, meta: r.meta ? safeJsonParse(r.meta) : undefined, createdAt: r.created_at }));
  }
  countUndrained(principal: string, chatId: string) { const r = this.db.query(`SELECT COUNT(*) c FROM messages WHERE principal=? AND chat_id=? AND drained_at IS NULL`).get(principal, chatId) as { c?: number } | null; return r?.c || 0; }
  markDrained(principal: string, ids: string[]) { if (!ids.length) return; const ph = ids.map(()=> '?').join(','); this.db.run(`UPDATE messages SET drained_at=? WHERE principal=? AND id IN (${ph})`, [Date.now(), principal, ...ids]); }
  markPushed(principal: string, id?: string) { if (id) this.db.run(`UPDATE messages SET pushed_at=? WHERE principal=? AND id=?`, [Date.now(), principal, id]); }
  close() { this.db.close(false); }
}
export function contentHash(s: string) { return createHash("sha256").update(s).digest("hex").slice(0,16); }
