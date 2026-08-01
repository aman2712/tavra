import assert from "node:assert/strict";
import test from "node:test";

import type { MessageReceivedWebhookEvent } from "@linqapp/sdk/resources/webhooks";

import { InMemoryProcessedEventStore } from "../src/event-store.js";
import {
  createMessageReplyProcessor,
  textFromMessage,
  type LinqMessageSender,
  type ReplyGenerator,
} from "../src/message-reply.js";

const tavraNumber = "+919876543210";

function event(overrides: {
  eventId?: string;
  text?: string;
  direction?: "inbound" | "outbound";
  service?: "iMessage" | "SMS" | "RCS";
  owner?: string;
} = {}): MessageReceivedWebhookEvent {
  return {
    api_version: "v3",
    webhook_version: "2026-02-03",
    event_type: "message.received",
    event_id: overrides.eventId ?? "evt-1",
    created_at: "2026-08-01T12:00:00Z",
    trace_id: "trace-1",
    partner_id: "partner-1",
    data: {
      id: "message-1",
      direction: overrides.direction ?? "inbound",
      service: overrides.service ?? "iMessage",
      sender_handle: {
        id: "sender-1",
        handle: "+971501234567",
        is_me: false,
        joined_at: "2026-08-01T12:00:00Z",
        left_at: null,
        service: "iMessage",
      },
      chat: {
        id: "chat-1",
        is_group: false,
        health_status: {
          status: "HEALTHY",
          doc_url: "https://docs.linqapp.com/",
          updated_at: "2026-08-01T12:00:00Z",
        },
        owner_handle: {
          id: "owner-1",
          handle: overrides.owner ?? tavraNumber,
          is_me: true,
          joined_at: "2026-08-01T12:00:00Z",
          left_at: null,
          service: "iMessage",
        },
      },
      parts: [{ type: "text", value: overrides.text ?? "My flight is delayed" }],
    },
  };
}

test("extracts and trims inbound text", () => {
  assert.equal(textFromMessage(event({ text: "  hello  " })), "hello");
});

test("generates and sends one reply for duplicate deliveries", async () => {
  const generations: string[] = [];
  const sends: Array<{ chatId: string; eventId: string; text: string }> = [];
  const generator: ReplyGenerator = {
    async generateReply(message) {
      generations.push(message);
      return "Check your airline's app for the latest departure time.";
    },
  };
  const sender: LinqMessageSender = {
    async sendText(chatId, eventId, text) {
      sends.push({ chatId, eventId, text });
      return { messageId: "out-1" };
    },
  };
  const processEvent = createMessageReplyProcessor({
    fromNumber: tavraNumber,
    generator,
    sender,
    store: new InMemoryProcessedEventStore(),
  });

  const first = await processEvent(event());
  const duplicate = await processEvent(event());

  assert.equal(first.status, "sent");
  assert.equal(duplicate.status, "duplicate");
  assert.deepEqual(generations, ["My flight is delayed"]);
  assert.deepEqual(sends, [
    {
      chatId: "chat-1",
      eventId: "evt-1",
      text: "Check your airline's app for the latest departure time.",
    },
  ]);
});

test("ignores empty messages and non-iMessage traffic", async () => {
  const generator: ReplyGenerator = {
    async generateReply() {
      throw new Error("generation should not be called");
    },
  };
  const sender: LinqMessageSender = {
    async sendText() {
      throw new Error("send should not be called");
    },
  };
  const processEvent = createMessageReplyProcessor({
    fromNumber: tavraNumber,
    generator,
    sender,
    store: new InMemoryProcessedEventStore(),
  });

  assert.deepEqual(await processEvent(event({ text: "   ", eventId: "evt-2" })), {
    status: "ignored",
    eventId: "evt-2",
    reason: "empty_text",
  });
  assert.deepEqual(
    await processEvent(event({ service: "SMS", eventId: "evt-3" })),
    { status: "ignored", eventId: "evt-3", reason: "not_imessage" },
  );
});
