import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { SessionSchema, type DurableSession } from "../contracts/durable";
import type { RunResult } from "../contracts/run";
import { NativeSessionMetadataSchema, type NativeSessionMetadata } from "../contracts/native";
import { redactAndTruncate } from "./redaction";
import { ensureOwnerOnlyDirectory, type ProjectStatePaths } from "./project-state";
import { readOwnerOnlyJson, writeOwnerOnlyJson } from "./owner-json";
import { decodePersistedRunResult } from "./persisted-run-result";

const MAX_TRANSCRIPT_BYTES = 1_000_000;
const MAX_REPLAY_BYTES = 200_000;
const MAX_TRANSCRIPT_ENTRIES = 1_000;

const TranscriptEntrySchema = z.object({
  id: z.string().uuid(),
  role: z.enum(["user", "assistant", "tool", "summary"]),
  content: z.string().max(200_000),
  timestamp: z.number().int().nonnegative(),
  jobId: z.string().max(160).nullable(),
  truncated: z.boolean(),
}).strict();

const SessionFileSchema = z.object({
  version: z.literal(2),
  session: SessionSchema,
  transcript: z.array(TranscriptEntrySchema).max(MAX_TRANSCRIPT_ENTRIES),
}).strict();

export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

export class PersistentSessionStore {
  constructor(private readonly paths: ProjectStatePaths) {
    ensureOwnerOnlyDirectory(paths.sessionsDir);
  }

  create(input: {
    principal: string;
    backend: string;
    model?: string;
    agent?: string;
    containment?: "required" | "unsafe";
    authMode?: "native-login" | "broker";
    approvalPolicy?: "ask" | "auto" | "bypass";
    nativeSessionId?: string | null;
  }) {
    const now = Date.now();
    const session = SessionSchema.parse({
      id: randomUUID(),
      projectId: this.paths.projectId,
      principal: input.principal,
      backend: input.backend,
      model: input.model ?? null,
      agent: input.agent ?? null,
      containment: input.containment ?? "required",
      authMode: input.authMode ?? "broker",
      approvalPolicy: input.approvalPolicy ?? "ask",
      state: "idle",
      nativeSessionId: input.nativeSessionId ?? null,
      replay: !input.nativeSessionId,
      transcriptBytes: 0,
      truncated: false,
      lastJobId: null,
      result: null,
      native: null,
      createdAt: now,
      updatedAt: now,
    });
    this.write({ version: 2, session, transcript: [] });
    return session;
  }

  get(id: string) {
    return this.read(id)?.session ?? null;
  }

  list() {
    return readdirSync(this.paths.sessionsDir)
      .filter((name) => name.endsWith(".json"))
      .flatMap((name) => {
        const session = this.get(name.slice(0, -".json".length));
        return session ? [session] : [];
      })
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  transcript(id: string) {
    return this.require(id).transcript.map((entry) => ({ ...entry }));
  }

  append(id: string, role: TranscriptEntry["role"], content: string, jobId: string | null = null) {
    const file = this.require(id);
    const safe = redactAndTruncate(content, 200_000);
    const entry = TranscriptEntrySchema.parse({ id: randomUUID(), role, content: safe.text, timestamp: Date.now(), jobId, truncated: safe.truncated });
    file.transcript.push(entry);
    while (file.transcript.length > MAX_TRANSCRIPT_ENTRIES || transcriptBytes(file.transcript) > MAX_TRANSCRIPT_BYTES) {
      file.transcript.shift();
      file.session.truncated = true;
    }
    file.session.transcriptBytes = transcriptBytes(file.transcript);
    file.session.truncated ||= safe.truncated;
    file.session.updatedAt = Date.now();
    this.write(file);
    return entry;
  }

  start(id: string, jobId: string) {
    return this.update(id, { state: "running", lastJobId: jobId, result: null });
  }

  cancelling(id: string) {
    return this.update(id, { state: "cancelling" });
  }

  complete(id: string, result: RunResult) {
    const current = this.require(id).session;
    if (current.result?.jobId === result.jobId && current.state !== "running" && current.state !== "cancelling") return current;
    const state: DurableSession["state"] = result.status === "succeeded" ? "completed" : result.status === "cancelled" ? "cancelled" : "failed";
    this.append(id, "assistant", result.output, result.jobId);
    return this.update(id, { state, result });
  }

  setNativeMetadata(id: string, native: NativeSessionMetadata | null) {
    const parsed = native ? NativeSessionMetadataSchema.parse(native) : null;
    return this.update(id, {
      native: parsed,
      nativeSessionId: parsed?.nativeSessionId ?? null,
      replay: parsed === null,
    });
  }

  replay(id: string) {
    const file = this.require(id);
    const lines: string[] = [];
    let bytes = 0;
    let truncated = file.session.truncated;
    for (let index = file.transcript.length - 1; index >= 0; index -= 1) {
      const entry = file.transcript[index];
      const line = `${entry.role.toUpperCase()}: ${entry.content}`;
      const size = Buffer.byteLength(line) + 1;
      if (bytes + size > MAX_REPLAY_BYTES) {
        truncated = true;
        break;
      }
      lines.unshift(line);
      bytes += size;
    }
    if (truncated && !lines[0]?.startsWith("SUMMARY:")) {
      lines.unshift("SUMMARY: Earlier redacted transcript entries were omitted because the replay bound was reached.");
    }
    if (truncated && !file.session.truncated) this.update(id, { truncated: true });
    return { text: lines.join("\n\n"), truncated, bytes };
  }

  private update(id: string, patch: Partial<DurableSession>) {
    const file = this.require(id);
    file.session = SessionSchema.parse({ ...file.session, ...patch, id: file.session.id, projectId: this.paths.projectId, updatedAt: Date.now() });
    this.write(file);
    return file.session;
  }

  private require(id: string) {
    const file = this.read(id);
    if (!file) throw new Error(`Unknown session: ${id}`);
    return file;
  }

  private read(id: string) {
    const path = this.path(id);
    if (!existsSync(path)) return null;
    return readOwnerOnlyJson(path, { parse: parsePersistedSessionFile });
  }

  private write(value: z.infer<typeof SessionFileSchema>) {
    const file = SessionFileSchema.parse(value);
    writeOwnerOnlyJson(this.path(file.session.id), file);
  }

  private path(id: string) {
    if (!/^[a-zA-Z0-9-]{1,160}$/.test(id)) throw new Error("Invalid session id.");
    return join(this.paths.sessionsDir, `${id}.json`);
  }
}

function parsePersistedSessionFile(value: unknown) {
  if (!isRecord(value) || !isRecord(value.session)) return SessionFileSchema.parse(value);
  return SessionFileSchema.parse({
    ...value,
    session: {
      ...value.session,
      result: value.session.result === null ? null : decodePersistedRunResult(value.session.result),
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function transcriptBytes(entries: TranscriptEntry[]) {
  return entries.reduce((total, entry) => total + Buffer.byteLength(entry.content), 0);
}
