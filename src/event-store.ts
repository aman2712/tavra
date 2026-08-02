import { appendFile, readFile } from "node:fs/promises";

export interface ProcessedEventStore {
  has(eventId: string): Promise<boolean>;
  hasMessage(messageId: string): Promise<boolean>;
  hasAttachment(attachmentId: string): Promise<boolean>;
  add(eventId: string, cursor?: InboundMessageCursor): Promise<void>;
  latestForChat(chatId: string): Promise<InboundMessageCursor | null>;
}

export interface InboundMessageCursor {
  chatId: string;
  messageId: string;
  sentAt: string;
  attachmentIds: string[];
}

export class JsonlProcessedEventStore implements ProcessedEventStore {
  private readonly loaded: Promise<{
    eventIds: Set<string>;
    messageIds: Set<string>;
    attachmentIds: Set<string>;
    chatCursors: Map<string, InboundMessageCursor>;
  }>;

  constructor(private readonly path: string) {
    this.loaded = this.load();
  }

  async has(eventId: string): Promise<boolean> {
    return (await this.loaded).eventIds.has(eventId);
  }

  async hasMessage(messageId: string): Promise<boolean> {
    return (await this.loaded).messageIds.has(messageId);
  }

  async hasAttachment(attachmentId: string): Promise<boolean> {
    return (await this.loaded).attachmentIds.has(attachmentId);
  }

  async add(eventId: string, cursor?: InboundMessageCursor): Promise<void> {
    const state = await this.loaded;
    if (state.eventIds.has(eventId)) return;

    await appendFile(
      this.path,
      `${JSON.stringify({
        event_id: eventId,
        processed_at: new Date().toISOString(),
        ...(cursor
          ? {
              chat_id: cursor.chatId,
              message_id: cursor.messageId,
              sent_at: cursor.sentAt,
              attachment_ids: cursor.attachmentIds,
            }
          : {}),
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    state.eventIds.add(eventId);
    if (cursor) {
      state.messageIds.add(cursor.messageId);
      for (const attachmentId of cursor.attachmentIds) {
        state.attachmentIds.add(attachmentId);
      }
      const current = state.chatCursors.get(cursor.chatId);
      if (!current || Date.parse(cursor.sentAt) >= Date.parse(current.sentAt)) {
        state.chatCursors.set(cursor.chatId, cursor);
      }
    }
  }

  async latestForChat(chatId: string): Promise<InboundMessageCursor | null> {
    return (await this.loaded).chatCursors.get(chatId) ?? null;
  }

  private async load(): Promise<{
    eventIds: Set<string>;
    messageIds: Set<string>;
    attachmentIds: Set<string>;
    chatCursors: Map<string, InboundMessageCursor>;
  }> {
    try {
      const contents = await readFile(this.path, "utf8");
      const records = contents
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              event_id?: unknown;
              chat_id?: unknown;
              message_id?: unknown;
              sent_at?: unknown;
              attachment_ids?: unknown;
            },
        );
      const eventIds = new Set<string>();
      const messageIds = new Set<string>();
      const attachmentIds = new Set<string>();
      const chatCursors = new Map<string, InboundMessageCursor>();
      for (const record of records) {
        if (typeof record.event_id === "string") eventIds.add(record.event_id);
        if (typeof record.message_id === "string") {
          messageIds.add(record.message_id);
        }
        const recordAttachmentIds = Array.isArray(record.attachment_ids)
          ? record.attachment_ids.filter(
              (value): value is string => typeof value === "string",
            )
          : [];
        for (const attachmentId of recordAttachmentIds) {
          attachmentIds.add(attachmentId);
        }
        if (
          typeof record.chat_id !== "string" ||
          typeof record.message_id !== "string" ||
          typeof record.sent_at !== "string" ||
          !Number.isFinite(Date.parse(record.sent_at))
        ) {
          continue;
        }
        const cursor = {
          chatId: record.chat_id,
          messageId: record.message_id,
          sentAt: record.sent_at,
          attachmentIds: recordAttachmentIds,
        };
        const current = chatCursors.get(cursor.chatId);
        if (!current || Date.parse(cursor.sentAt) >= Date.parse(current.sentAt)) {
          chatCursors.set(cursor.chatId, cursor);
        }
      }
      return { eventIds, messageIds, attachmentIds, chatCursors };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          eventIds: new Set(),
          messageIds: new Set(),
          attachmentIds: new Set(),
          chatCursors: new Map(),
        };
      }
      throw error;
    }
  }
}

export class InMemoryProcessedEventStore implements ProcessedEventStore {
  private readonly events = new Set<string>();
  private readonly messageIds = new Set<string>();
  private readonly attachmentIds = new Set<string>();
  private readonly chatCursors = new Map<string, InboundMessageCursor>();

  async has(eventId: string): Promise<boolean> {
    return this.events.has(eventId);
  }

  async hasMessage(messageId: string): Promise<boolean> {
    return this.messageIds.has(messageId);
  }

  async hasAttachment(attachmentId: string): Promise<boolean> {
    return this.attachmentIds.has(attachmentId);
  }

  async add(eventId: string, cursor?: InboundMessageCursor): Promise<void> {
    this.events.add(eventId);
    if (!cursor) return;
    this.messageIds.add(cursor.messageId);
    for (const attachmentId of cursor.attachmentIds) {
      this.attachmentIds.add(attachmentId);
    }
    const current = this.chatCursors.get(cursor.chatId);
    if (!current || Date.parse(cursor.sentAt) >= Date.parse(current.sentAt)) {
      this.chatCursors.set(cursor.chatId, cursor);
    }
  }

  async latestForChat(chatId: string): Promise<InboundMessageCursor | null> {
    return this.chatCursors.get(chatId) ?? null;
  }
}
