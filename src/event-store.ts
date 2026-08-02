import { appendFile, readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface InboundMessageCursor {
  chatId: string;
  messageId: string;
  sentAt: string;
  attachmentIds: string[];
}

export type InboundTurnReservation =
  | { status: "accepted"; revision: number }
  | { status: "duplicate_event"; revision: number | null }
  | { status: "duplicate_message"; revision: number | null }
  | { status: "stale"; revision: number };

export interface ProcessedEventStore {
  has(eventId: string): Promise<boolean>;
  hasMessage(messageId: string): Promise<boolean>;
  hasAttachment(attachmentId: string): Promise<boolean>;
  /**
   * Atomically records an inbound message before asynchronous work starts.
   * Accepted turns advance a durable, monotonically increasing chat revision.
   */
  reserve(
    eventId: string,
    cursor: InboundMessageCursor,
  ): Promise<InboundTurnReservation>;
  isCurrent(chatId: string, revision: number): Promise<boolean>;
  add(eventId: string, cursor?: InboundMessageCursor): Promise<void>;
  latestForChat(chatId: string): Promise<InboundMessageCursor | null>;
}

interface EventStoreState {
  eventIds: Set<string>;
  messageIds: Set<string>;
  attachmentIds: Set<string>;
  chatCursors: Map<string, InboundMessageCursor>;
  chatRevisions: Map<string, number>;
}

interface JsonlEventRecord {
  event_id?: unknown;
  processed_at?: unknown;
  disposition?: unknown;
  chat_id?: unknown;
  message_id?: unknown;
  sent_at?: unknown;
  attachment_ids?: unknown;
  revision?: unknown;
}

/**
 * One-time, idempotent upgrade path from the original JSONL coordinator.
 * This runs before webhook intake so provider redeliveries remain deduplicated.
 */
export async function migrateJsonlProcessedEvents(
  path: string,
  target: ProcessedEventStore,
): Promise<number> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let imported = 0;
  for (const line of contents.split("\n").filter(Boolean)) {
    const record = JSON.parse(line) as JsonlEventRecord;
    if (typeof record.event_id !== "string" || await target.has(record.event_id)) {
      continue;
    }
    const cursor = cursorFromRecord(record);
    if (cursor && !(await target.hasMessage(cursor.messageId))) {
      await target.add(record.event_id, cursor);
    } else {
      await target.add(record.event_id);
    }
    imported += 1;
  }
  return imported;
}

function cursorFromRecord(record: JsonlEventRecord): InboundMessageCursor | null {
  if (
    typeof record.chat_id !== "string" ||
    typeof record.message_id !== "string" ||
    typeof record.sent_at !== "string" ||
    !Number.isFinite(Date.parse(record.sent_at))
  ) {
    return null;
  }
  return {
    chatId: record.chat_id,
    messageId: record.message_id,
    sentAt: record.sent_at,
    attachmentIds: Array.isArray(record.attachment_ids)
      ? record.attachment_ids.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  };
}

function currentRevision(state: EventStoreState, chatId: string): number {
  return state.chatRevisions.get(chatId) ?? 0;
}

function isOlderThanLatest(
  state: EventStoreState,
  cursor: InboundMessageCursor,
): boolean {
  const latest = state.chatCursors.get(cursor.chatId);
  return Boolean(
    latest && Date.parse(cursor.sentAt) < Date.parse(latest.sentAt),
  );
}

function rememberMessageIdentity(
  state: EventStoreState,
  cursor: InboundMessageCursor,
): void {
  state.messageIds.add(cursor.messageId);
  for (const attachmentId of cursor.attachmentIds) {
    state.attachmentIds.add(attachmentId);
  }
}

export class JsonlProcessedEventStore implements ProcessedEventStore {
  private readonly loaded: Promise<EventStoreState>;
  private mutationTail: Promise<void> = Promise.resolve();

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

  reserve(
    eventId: string,
    cursor: InboundMessageCursor,
  ): Promise<InboundTurnReservation> {
    return this.mutate(async (state) => {
      const revision = currentRevision(state, cursor.chatId);
      if (state.eventIds.has(eventId)) {
        return { status: "duplicate_event", revision: revision || null };
      }
      if (state.messageIds.has(cursor.messageId)) {
        await this.append({
          event_id: eventId,
          processed_at: new Date().toISOString(),
          disposition: "duplicate_message",
        });
        state.eventIds.add(eventId);
        return { status: "duplicate_message", revision: revision || null };
      }

      if (isOlderThanLatest(state, cursor)) {
        await this.append({
          event_id: eventId,
          processed_at: new Date().toISOString(),
          disposition: "stale",
          chat_id: cursor.chatId,
          message_id: cursor.messageId,
          sent_at: cursor.sentAt,
          attachment_ids: cursor.attachmentIds,
          revision,
        });
        state.eventIds.add(eventId);
        rememberMessageIdentity(state, cursor);
        return { status: "stale", revision };
      }

      const nextRevision = revision + 1;
      await this.append({
        event_id: eventId,
        processed_at: new Date().toISOString(),
        disposition: "reserved",
        chat_id: cursor.chatId,
        message_id: cursor.messageId,
        sent_at: cursor.sentAt,
        attachment_ids: cursor.attachmentIds,
        revision: nextRevision,
      });
      state.eventIds.add(eventId);
      rememberMessageIdentity(state, cursor);
      state.chatCursors.set(cursor.chatId, cursor);
      state.chatRevisions.set(cursor.chatId, nextRevision);
      return { status: "accepted", revision: nextRevision };
    });
  }

  async isCurrent(chatId: string, revision: number): Promise<boolean> {
    return currentRevision(await this.loaded, chatId) === revision;
  }

  add(eventId: string, cursor?: InboundMessageCursor): Promise<void> {
    return this.mutate(async (state) => {
      if (state.eventIds.has(eventId)) return;

      const revision = cursor
        ? currentRevision(state, cursor.chatId) + 1
        : undefined;
      await this.append({
        event_id: eventId,
        processed_at: new Date().toISOString(),
        disposition: "processed",
        ...(cursor
          ? {
              chat_id: cursor.chatId,
              message_id: cursor.messageId,
              sent_at: cursor.sentAt,
              attachment_ids: cursor.attachmentIds,
              revision,
            }
          : {}),
      });
      state.eventIds.add(eventId);
      if (!cursor) return;
      rememberMessageIdentity(state, cursor);
      if (!isOlderThanLatest(state, cursor)) {
        state.chatCursors.set(cursor.chatId, cursor);
        state.chatRevisions.set(cursor.chatId, revision as number);
      }
    });
  }

  async latestForChat(chatId: string): Promise<InboundMessageCursor | null> {
    return (await this.loaded).chatCursors.get(chatId) ?? null;
  }

  private mutate<T>(operation: (state: EventStoreState) => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(async () => operation(await this.loaded));
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async append(record: Record<string, unknown>): Promise<void> {
    await appendFile(this.path, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  private async load(): Promise<EventStoreState> {
    try {
      const contents = await readFile(this.path, "utf8");
      const records = contents
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as JsonlEventRecord);
      const state: EventStoreState = {
        eventIds: new Set(),
        messageIds: new Set(),
        attachmentIds: new Set(),
        chatCursors: new Map(),
        chatRevisions: new Map(),
      };
      for (const record of records) {
        if (typeof record.event_id === "string") {
          state.eventIds.add(record.event_id);
        }
        const cursor = cursorFromRecord(record);
        if (!cursor) continue;
        rememberMessageIdentity(state, cursor);
        if (record.disposition === "stale") continue;

        const explicitRevision =
          typeof record.revision === "number" &&
          Number.isSafeInteger(record.revision) &&
          record.revision > 0
            ? record.revision
            : null;
        const existingRevision = currentRevision(state, cursor.chatId);
        const recordRevision = explicitRevision ?? existingRevision + 1;
        const latest = state.chatCursors.get(cursor.chatId);
        if (
          recordRevision > existingRevision ||
          (!latest || Date.parse(cursor.sentAt) >= Date.parse(latest.sentAt))
        ) {
          state.chatCursors.set(cursor.chatId, cursor);
          state.chatRevisions.set(
            cursor.chatId,
            Math.max(existingRevision, recordRevision),
          );
        }
      }
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          eventIds: new Set(),
          messageIds: new Set(),
          attachmentIds: new Set(),
          chatCursors: new Map(),
          chatRevisions: new Map(),
        };
      }
      throw error;
    }
  }
}

interface SqliteEventRow {
  event_id: string;
}

interface SqliteMessageRow {
  message_id: string;
}

interface SqliteCursorRow {
  chat_id: string;
  message_id: string;
  sent_at: string;
  revision: number;
}

/**
 * Durable coordinator used by the live webhook service. SQLite constraints make
 * event and message claims process-safe, while BEGIN IMMEDIATE serializes chat
 * revision allocation across concurrent webhook deliveries.
 */
export class SqliteProcessedEventStore implements ProcessedEventStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = FULL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS tavra_inbound_events (
        event_id TEXT PRIMARY KEY,
        message_id TEXT UNIQUE,
        chat_id TEXT,
        sent_at TEXT,
        revision INTEGER,
        disposition TEXT NOT NULL,
        processed_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS tavra_inbound_attachments (
        attachment_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES tavra_inbound_events(event_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS tavra_chat_cursors (
        chat_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0)
      ) STRICT;
    `);
  }

  async has(eventId: string): Promise<boolean> {
    return Boolean(
      this.database
        .prepare("SELECT event_id FROM tavra_inbound_events WHERE event_id = ?")
        .get(eventId) as SqliteEventRow | undefined,
    );
  }

  async hasMessage(messageId: string): Promise<boolean> {
    return Boolean(
      this.database
        .prepare("SELECT message_id FROM tavra_inbound_events WHERE message_id = ?")
        .get(messageId) as SqliteMessageRow | undefined,
    );
  }

  async hasAttachment(attachmentId: string): Promise<boolean> {
    return Boolean(
      this.database
        .prepare(
          "SELECT attachment_id FROM tavra_inbound_attachments WHERE attachment_id = ?",
        )
        .get(attachmentId),
    );
  }

  async reserve(
    eventId: string,
    cursor: InboundMessageCursor,
  ): Promise<InboundTurnReservation> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (
        this.database
          .prepare("SELECT event_id FROM tavra_inbound_events WHERE event_id = ?")
          .get(eventId)
      ) {
        const revision = this.sqliteRevision(cursor.chatId);
        this.database.exec("COMMIT");
        return { status: "duplicate_event", revision: revision || null };
      }
      if (
        this.database
          .prepare("SELECT message_id FROM tavra_inbound_events WHERE message_id = ?")
          .get(cursor.messageId)
      ) {
        this.insertSqliteEvent(eventId, null, null, null, null, "duplicate_message");
        const revision = this.sqliteRevision(cursor.chatId);
        this.database.exec("COMMIT");
        return { status: "duplicate_message", revision: revision || null };
      }

      const latest = this.sqliteCursor(cursor.chatId);
      const revision = latest?.revision ?? 0;
      const stale = Boolean(
        latest && Date.parse(cursor.sentAt) < Date.parse(latest.sent_at),
      );
      if (stale) {
        this.insertSqliteEvent(
          eventId,
          cursor.messageId,
          cursor.chatId,
          cursor.sentAt,
          revision,
          "stale",
        );
        this.insertSqliteAttachments(eventId, cursor.attachmentIds);
        this.database.exec("COMMIT");
        return { status: "stale", revision };
      }

      const nextRevision = revision + 1;
      this.insertSqliteEvent(
        eventId,
        cursor.messageId,
        cursor.chatId,
        cursor.sentAt,
        nextRevision,
        "reserved",
      );
      this.insertSqliteAttachments(eventId, cursor.attachmentIds);
      this.database
        .prepare(
          `INSERT INTO tavra_chat_cursors (chat_id, message_id, sent_at, revision)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(chat_id) DO UPDATE SET
             message_id = excluded.message_id,
             sent_at = excluded.sent_at,
             revision = excluded.revision`,
        )
        .run(cursor.chatId, cursor.messageId, cursor.sentAt, nextRevision);
      this.database.exec("COMMIT");
      return { status: "accepted", revision: nextRevision };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async isCurrent(chatId: string, revision: number): Promise<boolean> {
    return this.sqliteRevision(chatId) === revision;
  }

  async add(eventId: string, cursor?: InboundMessageCursor): Promise<void> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (
        this.database
          .prepare("SELECT event_id FROM tavra_inbound_events WHERE event_id = ?")
          .get(eventId)
      ) {
        this.database.exec("COMMIT");
        return;
      }
      if (!cursor) {
        this.insertSqliteEvent(eventId, null, null, null, null, "processed");
        this.database.exec("COMMIT");
        return;
      }

      const latest = this.sqliteCursor(cursor.chatId);
      const revision = (latest?.revision ?? 0) + 1;
      const stale = Boolean(
        latest && Date.parse(cursor.sentAt) < Date.parse(latest.sent_at),
      );
      this.insertSqliteEvent(
        eventId,
        cursor.messageId,
        cursor.chatId,
        cursor.sentAt,
        stale ? latest?.revision ?? 0 : revision,
        stale ? "stale" : "processed",
      );
      this.insertSqliteAttachments(eventId, cursor.attachmentIds);
      if (!stale) {
        this.database
          .prepare(
            `INSERT INTO tavra_chat_cursors (chat_id, message_id, sent_at, revision)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(chat_id) DO UPDATE SET
               message_id = excluded.message_id,
               sent_at = excluded.sent_at,
               revision = excluded.revision`,
          )
          .run(cursor.chatId, cursor.messageId, cursor.sentAt, revision);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async latestForChat(chatId: string): Promise<InboundMessageCursor | null> {
    const cursor = this.sqliteCursor(chatId);
    if (!cursor) return null;
    const attachmentRows = this.database
      .prepare(
        `SELECT attachment_id
         FROM tavra_inbound_attachments
         WHERE event_id = (
           SELECT event_id FROM tavra_inbound_events WHERE message_id = ?
         )
         ORDER BY attachment_id`,
      )
      .all(cursor.message_id) as Array<{ attachment_id: string }>;
    return {
      chatId: cursor.chat_id,
      messageId: cursor.message_id,
      sentAt: cursor.sent_at,
      attachmentIds: attachmentRows.map((row) => row.attachment_id),
    };
  }

  close(): void {
    this.database.close();
  }

  private sqliteCursor(chatId: string): SqliteCursorRow | null {
    return (
      (this.database
        .prepare(
          "SELECT chat_id, message_id, sent_at, revision FROM tavra_chat_cursors WHERE chat_id = ?",
        )
        .get(chatId) as SqliteCursorRow | undefined) ?? null
    );
  }

  private sqliteRevision(chatId: string): number {
    return this.sqliteCursor(chatId)?.revision ?? 0;
  }

  private insertSqliteEvent(
    eventId: string,
    messageId: string | null,
    chatId: string | null,
    sentAt: string | null,
    revision: number | null,
    disposition: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO tavra_inbound_events
         (event_id, message_id, chat_id, sent_at, revision, disposition, processed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        messageId,
        chatId,
        sentAt,
        revision,
        disposition,
        new Date().toISOString(),
      );
  }

  private insertSqliteAttachments(eventId: string, attachmentIds: string[]): void {
    const statement = this.database.prepare(
      "INSERT OR IGNORE INTO tavra_inbound_attachments (attachment_id, event_id) VALUES (?, ?)",
    );
    for (const attachmentId of attachmentIds) {
      statement.run(attachmentId, eventId);
    }
  }
}

export class InMemoryProcessedEventStore implements ProcessedEventStore {
  private readonly state: EventStoreState = {
    eventIds: new Set(),
    messageIds: new Set(),
    attachmentIds: new Set(),
    chatCursors: new Map(),
    chatRevisions: new Map(),
  };

  async has(eventId: string): Promise<boolean> {
    return this.state.eventIds.has(eventId);
  }

  async hasMessage(messageId: string): Promise<boolean> {
    return this.state.messageIds.has(messageId);
  }

  async hasAttachment(attachmentId: string): Promise<boolean> {
    return this.state.attachmentIds.has(attachmentId);
  }

  async reserve(
    eventId: string,
    cursor: InboundMessageCursor,
  ): Promise<InboundTurnReservation> {
    const revision = currentRevision(this.state, cursor.chatId);
    if (this.state.eventIds.has(eventId)) {
      return { status: "duplicate_event", revision: revision || null };
    }
    if (this.state.messageIds.has(cursor.messageId)) {
      this.state.eventIds.add(eventId);
      return { status: "duplicate_message", revision: revision || null };
    }
    this.state.eventIds.add(eventId);
    rememberMessageIdentity(this.state, cursor);
    if (isOlderThanLatest(this.state, cursor)) {
      return { status: "stale", revision };
    }
    const nextRevision = revision + 1;
    this.state.chatCursors.set(cursor.chatId, cursor);
    this.state.chatRevisions.set(cursor.chatId, nextRevision);
    return { status: "accepted", revision: nextRevision };
  }

  async isCurrent(chatId: string, revision: number): Promise<boolean> {
    return currentRevision(this.state, chatId) === revision;
  }

  async add(eventId: string, cursor?: InboundMessageCursor): Promise<void> {
    if (this.state.eventIds.has(eventId)) return;
    this.state.eventIds.add(eventId);
    if (!cursor) return;
    rememberMessageIdentity(this.state, cursor);
    if (!isOlderThanLatest(this.state, cursor)) {
      this.state.chatCursors.set(cursor.chatId, cursor);
      this.state.chatRevisions.set(
        cursor.chatId,
        currentRevision(this.state, cursor.chatId) + 1,
      );
    }
  }

  async latestForChat(chatId: string): Promise<InboundMessageCursor | null> {
    return this.state.chatCursors.get(chatId) ?? null;
  }
}
