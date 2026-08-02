import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface RecoveryStateStore {
  load<T>(chatId: string): Promise<T | null>;
  save<T>(chatId: string, state: T): Promise<void>;
  delete(chatId: string): Promise<void>;
  list?<T>(): Promise<Array<{ chatId: string; state: T }>>;
}

function chatIdentifier(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f]/.test(normalized)) {
    throw new Error("Recovery chat ID is invalid");
  }
  return normalized;
}

/**
 * Durable workflow state only. The SQLite file is local and permission-restricted;
 * callers remain responsible for keeping full addresses out of model prompts and logs.
 */
export class SqliteRecoveryStateStore implements RecoveryStateStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS recovery_conversation_state (
        chat_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  async load<T>(chatId: string): Promise<T | null> {
    const row = this.database
      .prepare(
        "SELECT state_json FROM recovery_conversation_state WHERE chat_id = ?",
      )
      .get(chatIdentifier(chatId)) as { state_json: string } | undefined;
    return row ? JSON.parse(row.state_json) as T : null;
  }

  async save<T>(chatId: string, state: T): Promise<void> {
    const serialized = JSON.stringify(state);
    this.database
      .prepare(`
        INSERT INTO recovery_conversation_state(chat_id, state_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET
          state_json=excluded.state_json,
          updated_at=excluded.updated_at
      `)
      .run(chatIdentifier(chatId), serialized, new Date().toISOString());
  }

  async delete(chatId: string): Promise<void> {
    this.database
      .prepare("DELETE FROM recovery_conversation_state WHERE chat_id = ?")
      .run(chatIdentifier(chatId));
  }

  async list<T>(): Promise<Array<{ chatId: string; state: T }>> {
    const rows = this.database
      .prepare(
        "SELECT chat_id, state_json FROM recovery_conversation_state ORDER BY updated_at DESC",
      )
      .all() as Array<{ chat_id: string; state_json: string }>;
    return rows.map((row) => ({
      chatId: row.chat_id,
      state: JSON.parse(row.state_json) as T,
    }));
  }
}

export class InMemoryRecoveryStateStore implements RecoveryStateStore {
  private readonly states = new Map<string, unknown>();

  async load<T>(chatId: string): Promise<T | null> {
    const value = this.states.get(chatId);
    return value === undefined ? null : structuredClone(value) as T;
  }

  async save<T>(chatId: string, state: T): Promise<void> {
    this.states.set(chatId, structuredClone(state));
  }

  async delete(chatId: string): Promise<void> {
    this.states.delete(chatId);
  }

  async list<T>(): Promise<Array<{ chatId: string; state: T }>> {
    return [...this.states.entries()].map(([chatId, state]) => ({
      chatId,
      state: structuredClone(state) as T,
    }));
  }
}
