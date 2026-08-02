import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  InMemoryProcessedEventStore,
  JsonlProcessedEventStore,
  SqliteProcessedEventStore,
  migrateJsonlProcessedEvents,
  type InboundMessageCursor,
  type ProcessedEventStore,
} from "../src/event-store.js";

function cursor(
  messageId: string,
  sentAt: string,
  attachmentIds: string[] = [],
): InboundMessageCursor {
  return { chatId: "chat-1", messageId, sentAt, attachmentIds };
}

async function exerciseRevisionContract(store: ProcessedEventStore) {
  const first = await store.reserve(
    "event-1",
    cursor("message-1", "2026-08-02T12:00:00Z", ["attachment-1"]),
  );
  assert.deepEqual(first, { status: "accepted", revision: 1 });
  assert.equal(await store.isCurrent("chat-1", 1), true);
  assert.equal(await store.hasAttachment("attachment-1"), true);

  const second = await store.reserve(
    "event-2",
    cursor("message-2", "2026-08-02T12:00:01Z"),
  );
  assert.deepEqual(second, { status: "accepted", revision: 2 });
  assert.equal(await store.isCurrent("chat-1", 1), false);
  assert.equal(await store.isCurrent("chat-1", 2), true);

  assert.deepEqual(
    await store.reserve(
      "event-old",
      cursor("message-old", "2026-08-02T11:59:59Z", ["attachment-old"]),
    ),
    { status: "stale", revision: 2 },
  );
  assert.equal(await store.hasAttachment("attachment-old"), true);
  assert.deepEqual(await store.latestForChat("chat-1"), {
    chatId: "chat-1",
    messageId: "message-2",
    sentAt: "2026-08-02T12:00:01Z",
    attachmentIds: [],
  });

  assert.deepEqual(
    await store.reserve(
      "event-message-redelivery",
      cursor("message-2", "2026-08-02T12:00:02Z"),
    ),
    { status: "duplicate_message", revision: 2 },
  );
  assert.deepEqual(
    await store.reserve(
      "event-2",
      cursor("some-other-message", "2026-08-02T12:00:03Z"),
    ),
    { status: "duplicate_event", revision: 2 },
  );
}

test("in-memory event store allocates revisions and deduplicates identities", async () => {
  await exerciseRevisionContract(new InMemoryProcessedEventStore());
});

test("JSONL event store persists revisions and identities across restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tavra-events-jsonl-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "events.jsonl");
  await exerciseRevisionContract(new JsonlProcessedEventStore(path));

  const restored = new JsonlProcessedEventStore(path);
  assert.equal(await restored.has("event-1"), true);
  assert.equal(await restored.hasMessage("message-2"), true);
  assert.equal(await restored.isCurrent("chat-1", 2), true);
  assert.deepEqual(
    await restored.reserve(
      "event-3",
      cursor("message-3", "2026-08-02T12:00:03Z"),
    ),
    { status: "accepted", revision: 3 },
  );
});

test("SQLite event store atomically persists revisions and identities", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tavra-events-sqlite-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "tavra.sqlite");
  const store = new SqliteProcessedEventStore(path);
  await exerciseRevisionContract(store);
  store.close();

  const restored = new SqliteProcessedEventStore(path);
  t.after(() => restored.close());
  assert.equal(await restored.has("event-1"), true);
  assert.equal(await restored.hasMessage("message-2"), true);
  assert.equal(await restored.isCurrent("chat-1", 2), true);
  assert.deepEqual(
    await restored.reserve(
      "event-3",
      cursor("message-3", "2026-08-02T12:00:03Z"),
    ),
    { status: "accepted", revision: 3 },
  );
});

test("migrates legacy JSONL dedupe history into SQLite idempotently", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tavra-events-migration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const legacyPath = join(directory, "processed-events.jsonl");
  await writeFile(
    legacyPath,
    [
      JSON.stringify({
        event_id: "legacy-event-1",
        disposition: "reserved",
        chat_id: "legacy-chat",
        message_id: "legacy-message-1",
        sent_at: "2026-08-02T12:00:00Z",
        attachment_ids: ["legacy-attachment-1"],
      }),
      JSON.stringify({
        event_id: "legacy-event-2",
        disposition: "reserved",
        chat_id: "legacy-chat",
        message_id: "legacy-message-2",
        sent_at: "2026-08-02T12:00:01Z",
        attachment_ids: [],
      }),
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const store = new SqliteProcessedEventStore(join(directory, "tavra.sqlite"));
  t.after(() => store.close());
  assert.equal(await migrateJsonlProcessedEvents(legacyPath, store), 2);
  assert.equal(await migrateJsonlProcessedEvents(legacyPath, store), 0);
  assert.equal(await store.has("legacy-event-1"), true);
  assert.equal(await store.hasMessage("legacy-message-2"), true);
  assert.equal(await store.hasAttachment("legacy-attachment-1"), true);
  assert.equal(await store.isCurrent("legacy-chat", 2), true);
});
