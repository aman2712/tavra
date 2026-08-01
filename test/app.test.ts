import assert from "node:assert/strict";
import test from "node:test";

import type LinqAPIV3 from "@linqapp/sdk";
import type { MessageReceivedWebhookEvent } from "@linqapp/sdk/resources/webhooks";

import { createApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";

const config: ServerConfig = {
  apiKey: "test-key",
  fromNumber: "+919876543210",
  openAIApiKey: "test-openai-key",
  openAIModel: "test-model",
  mode: "mock",
  port: 3000,
  webhookSecret: null,
};

const fixture = {
  api_version: "v3",
  webhook_version: "2026-02-03",
  event_type: "message.received",
  event_id: "evt-http-1",
  created_at: "2026-08-01T12:00:00Z",
  trace_id: "trace-http-1",
  partner_id: "partner-1",
  data: {
    id: "message-http-1",
    direction: "inbound",
    service: "iMessage",
    parts: [{ type: "text", value: "ping" }],
    chat: { id: "chat-http-1" },
    sender_handle: {},
  },
} as unknown as MessageReceivedWebhookEvent;

test("serves health and accepts a webhook in mock mode", async (t) => {
  let receivedEventId: string | null = null;
  const app = createApp({
    config,
    client: {} as LinqAPIV3,
    async processEvent(event) {
      receivedEventId = event.event_id;
      return { status: "ignored", eventId: event.event_id, reason: "empty_text" };
    },
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());

  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${origin}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  const webhook = await fetch(`${origin}/webhooks/linq`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(fixture),
  });
  assert.equal(webhook.status, 200);
  assert.deepEqual(await webhook.json(), { ok: true, status: "ignored" });
  assert.equal(receivedEventId, "evt-http-1");
});
