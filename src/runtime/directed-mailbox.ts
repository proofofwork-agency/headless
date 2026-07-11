import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  DirectedMessageKindSchema,
  DirectedMessageSchema,
  type DirectedMessage,
} from "../contracts/collaboration";
import { IdentifierSchema, TimestampSchema } from "../contracts/common";
import { readOwnerOnlyJson, writeOwnerOnlyJson } from "./owner-json";
import { redactAndTruncate } from "./redaction";

export const DEFAULT_MAX_DIRECTED_MESSAGES = 256;
export const NON_DROPPABLE_MESSAGE_KINDS = ["lifecycle", "policy", "approval", "completion"] as const;

const CursorSchema = z.object({
  collaborationId: IdentifierSchema,
  recipientId: IdentifierSchema,
  nextSequence: z.number().int().positive(),
}).strict();

const MailboxSnapshotSchema = z.object({
  version: z.literal(1),
  maxMessagesPerAddress: z.number().int().positive().max(10_000),
  cursors: z.array(CursorSchema),
  messages: z.array(DirectedMessageSchema),
}).strict().superRefine((snapshot, context) => {
  const ids = snapshot.messages.map((message) => message.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Directed message ids must be unique.", path: ["messages"] });
  }
  const cursorKeys = snapshot.cursors.map((cursor) => addressKey(cursor.collaborationId, cursor.recipientId));
  if (new Set(cursorKeys).size !== cursorKeys.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Directed mailbox cursors must be unique.", path: ["cursors"] });
  }
  const cursors = new Map(snapshot.cursors.map((cursor) => [addressKey(cursor.collaborationId, cursor.recipientId), cursor]));
  const byAddress = new Map<string, DirectedMessage[]>();
  for (const message of snapshot.messages) {
    const key = addressKey(message.collaborationId, message.recipientId);
    const messages = byAddress.get(key) ?? [];
    messages.push(message);
    byAddress.set(key, messages);
    const cursor = cursors.get(key);
    if (!cursor || cursor.nextSequence <= message.sequence) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Mailbox cursor must advance beyond every persisted message.", path: ["cursors"] });
    }
  }
  for (const messages of byAddress.values()) {
    if (messages.length > snapshot.maxMessagesPerAddress) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Persisted mailbox exceeds its configured address bound.", path: ["messages"] });
    }
    const sequences = messages.map((message) => message.sequence);
    if (new Set(sequences).size !== sequences.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Message sequences must be unique within an addressed mailbox.", path: ["messages"] });
    }
  }
});

export type DirectedMailboxSnapshot = z.infer<typeof MailboxSnapshotSchema>;

export type DirectedMessageDraft = Pick<DirectedMessage,
  "collaborationId" | "senderId" | "recipientId" | "kind" | "content"
> & Partial<Pick<DirectedMessage, "artifactIds">>;

export type DirectedMailboxErrorCode =
  | "MAILBOX_CAPACITY_EXCEEDED"
  | "MESSAGE_NOT_FOUND"
  | "MESSAGE_ADDRESS_MISMATCH";

export class DirectedMailboxError extends Error {
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    readonly code: DirectedMailboxErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "DirectedMailboxError";
    this.retryable = options.retryable ?? false;
    this.details = Object.freeze({ ...(options.details ?? {}) });
  }
}

export class DirectedMailbox {
  readonly maxMessagesPerAddress: number;
  private state: DirectedMailboxSnapshot;
  private readonly statePath?: string;
  private readonly clock: () => number;
  private readonly idFactory: () => string;

  constructor(options: {
    statePath?: string;
    maxMessagesPerAddress?: number;
    clock?: () => number;
    idFactory?: () => string;
    snapshot?: DirectedMailboxSnapshot;
  } = {}) {
    this.statePath = options.statePath;
    this.clock = options.clock ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    const configuredMax = z.number().int().positive().max(10_000)
      .parse(options.maxMessagesPerAddress ?? DEFAULT_MAX_DIRECTED_MESSAGES);
    const persisted = options.snapshot
      ?? (this.statePath ? readOwnerOnlyJson(this.statePath, MailboxSnapshotSchema) : null);
    if (persisted && options.snapshot && this.statePath) {
      throw new TypeError("Pass either a mailbox snapshot or statePath, not both.");
    }
    this.state = MailboxSnapshotSchema.parse(persisted ?? {
      version: 1,
      maxMessagesPerAddress: configuredMax,
      cursors: [],
      messages: [],
    });
    this.maxMessagesPerAddress = this.state.maxMessagesPerAddress;
  }

  send(input: DirectedMessageDraft, at = this.clock()): DirectedMessage {
    const now = TimestampSchema.parse(at);
    const collaborationId = IdentifierSchema.parse(input.collaborationId);
    const senderId = IdentifierSchema.parse(input.senderId);
    const recipientId = IdentifierSchema.parse(input.recipientId);
    const kind = DirectedMessageKindSchema.parse(input.kind);
    const addressed = this.addressed(collaborationId, recipientId);
    if (addressed.length >= this.maxMessagesPerAddress) {
      throw new DirectedMailboxError(
        "MAILBOX_CAPACITY_EXCEEDED",
        `Mailbox for ${recipientId} is at its ${this.maxMessagesPerAddress}-message capacity.`,
        {
          retryable: true,
          details: {
            collaborationId,
            recipientId,
            maxMessagesPerAddress: this.maxMessagesPerAddress,
            protectedKind: isNonDroppableMessageKind(kind),
          },
        },
      );
    }
    const cursor = this.cursor(collaborationId, recipientId);
    const safe = redactContent(input.content);
    const message = DirectedMessageSchema.parse({
      id: IdentifierSchema.parse(this.idFactory()),
      collaborationId,
      senderId,
      recipientId,
      sequence: cursor.nextSequence,
      kind,
      content: safe.text,
      redacted: true,
      truncated: safe.truncated,
      artifactIds: input.artifactIds ?? [],
      acknowledgedAt: null,
      createdAt: now,
    });
    cursor.nextSequence += 1;
    this.state.messages.push(message);
    this.persist();
    return cloneMessage(message);
  }

  listInbox(
    collaborationId: string,
    recipientId: string,
    options: { afterSequence?: number; includeAcknowledged?: boolean; limit?: number } = {},
  ): DirectedMessage[] {
    const afterSequence = z.number().int().nonnegative().parse(options.afterSequence ?? 0);
    const limit = z.number().int().positive().max(10_000).parse(options.limit ?? this.maxMessagesPerAddress);
    return this.addressed(IdentifierSchema.parse(collaborationId), IdentifierSchema.parse(recipientId))
      .filter((message) => message.sequence > afterSequence)
      .filter((message) => options.includeAcknowledged === true || message.acknowledgedAt === null)
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, limit)
      .map(cloneMessage);
  }

  acknowledge(
    collaborationId: string,
    recipientId: string,
    messageIds: string[],
    at = this.clock(),
  ): DirectedMessage[] {
    const parsedCollaborationId = IdentifierSchema.parse(collaborationId);
    const parsedRecipientId = IdentifierSchema.parse(recipientId);
    const ids = z.array(IdentifierSchema).min(1).max(this.maxMessagesPerAddress).parse(messageIds);
    if (new Set(ids).size !== ids.length) throw new TypeError("Message acknowledgement ids must be unique.");
    const messages = ids.map((id) => {
      const message = this.state.messages.find((candidate) => candidate.id === id);
      if (!message) throw new DirectedMailboxError("MESSAGE_NOT_FOUND", `Unknown directed message: ${id}`);
      if (message.collaborationId !== parsedCollaborationId || message.recipientId !== parsedRecipientId) {
        throw new DirectedMailboxError(
          "MESSAGE_ADDRESS_MISMATCH",
          `Message ${id} is not addressed to ${parsedRecipientId} in ${parsedCollaborationId}.`,
        );
      }
      return message;
    });
    const now = TimestampSchema.parse(at);
    for (const message of messages) {
      if (message.acknowledgedAt === null) message.acknowledgedAt = Math.max(now, message.createdAt);
      DirectedMessageSchema.parse(message);
    }
    this.persist();
    return messages.map(cloneMessage);
  }

  /** Atomically acknowledge a bounded cross-recipient batch after daemon authorization. */
  acknowledgeBatch(
    collaborationId: string,
    messageIds: string[],
    options: { prune?: boolean; at?: number } = {},
  ) {
    const parsedCollaborationId = IdentifierSchema.parse(collaborationId);
    const ids = z.array(IdentifierSchema).min(1).max(1_000).parse(messageIds);
    if (new Set(ids).size !== ids.length) throw new TypeError("Message acknowledgement ids must be unique.");
    const selected = ids.map((id) => {
      const message = this.state.messages.find((candidate) => candidate.id === id);
      if (!message) throw new DirectedMailboxError("MESSAGE_NOT_FOUND", `Unknown directed message: ${id}`);
      if (message.collaborationId !== parsedCollaborationId) {
        throw new DirectedMailboxError(
          "MESSAGE_ADDRESS_MISMATCH",
          `Message ${id} is not part of collaboration ${parsedCollaborationId}.`,
        );
      }
      return message;
    });
    const now = TimestampSchema.parse(options.at ?? this.clock());
    for (const message of selected) {
      if (message.acknowledgedAt === null) message.acknowledgedAt = Math.max(now, message.createdAt);
      DirectedMessageSchema.parse(message);
    }
    const clones = selected.map(cloneMessage);
    let pruned = 0;
    if (options.prune !== false) {
      const selectedIds = new Set(ids);
      const before = this.state.messages.length;
      this.state.messages = this.state.messages.filter((message) => !selectedIds.has(message.id));
      pruned = before - this.state.messages.length;
    }
    this.persist();
    return { messages: clones, pruned };
  }

  pruneAcknowledged(collaborationId: string, recipientId: string, throughSequence = Number.MAX_SAFE_INTEGER) {
    const parsedCollaborationId = IdentifierSchema.parse(collaborationId);
    const parsedRecipientId = IdentifierSchema.parse(recipientId);
    const through = z.number().int().nonnegative().parse(throughSequence);
    const before = this.state.messages.length;
    this.state.messages = this.state.messages.filter((message) =>
      message.collaborationId !== parsedCollaborationId
      || message.recipientId !== parsedRecipientId
      || message.acknowledgedAt === null
      || message.sequence > through);
    const removed = before - this.state.messages.length;
    if (removed > 0) this.persist();
    return removed;
  }

  pendingCount(collaborationId: string, recipientId: string) {
    return this.addressed(IdentifierSchema.parse(collaborationId), IdentifierSchema.parse(recipientId))
      .filter((message) => message.acknowledgedAt === null).length;
  }

  snapshot(): DirectedMailboxSnapshot {
    return structuredClone(MailboxSnapshotSchema.parse(this.state));
  }

  private addressed(collaborationId: string, recipientId: string) {
    return this.state.messages.filter((message) =>
      message.collaborationId === collaborationId && message.recipientId === recipientId);
  }

  private cursor(collaborationId: string, recipientId: string) {
    let cursor = this.state.cursors.find((candidate) =>
      candidate.collaborationId === collaborationId && candidate.recipientId === recipientId);
    if (!cursor) {
      cursor = { collaborationId, recipientId, nextSequence: 1 };
      this.state.cursors.push(cursor);
    }
    return cursor;
  }

  private persist() {
    this.state = MailboxSnapshotSchema.parse(this.state);
    if (this.statePath) writeOwnerOnlyJson(this.statePath, this.state);
  }
}

export function isNonDroppableMessageKind(kind: DirectedMessage["kind"]): boolean {
  return (NON_DROPPABLE_MESSAGE_KINDS as readonly string[]).includes(kind);
}

function addressKey(collaborationId: string, recipientId: string) {
  return `${collaborationId}\u0000${recipientId}`;
}

function redactContent(content: string) {
  try {
    const result = redactAndTruncate(content, 16_384);
    if (!result || typeof result.text !== "string") throw new Error("Invalid redaction result.");
    return result;
  } catch {
    return { text: "[SUPPRESSED: REDACTION FAILURE]", redacted: true, truncated: true };
  }
}

function cloneMessage(message: DirectedMessage) {
  return structuredClone(message);
}
