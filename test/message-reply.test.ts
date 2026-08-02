import assert from "node:assert/strict";
import test from "node:test";

import type { MessageReceivedWebhookEvent } from "@linqapp/sdk/resources/webhooks";

import { InMemoryProcessedEventStore } from "../src/event-store.js";
import type {
  LocationSharingStartedWebhookEvent,
  LocationSharingStoppedWebhookEvent,
} from "../src/linq-events.js";
import {
  createMessageReplyProcessor,
  textFromMessage,
  type LinqMessageSender,
  type ReplyGenerator,
} from "../src/message-reply.js";

const tavraNumber = "+919876543210";

function event(overrides: {
  eventId?: string;
  messageId?: string;
  text?: string;
  sentAt?: string;
  chatId?: string;
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
      id: overrides.messageId ?? "message-1",
      sent_at: overrides.sentAt ?? "2026-08-01T12:00:00Z",
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
        id: overrides.chatId ?? "chat-1",
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

function locationStartedEvent(
  overrides: Partial<LocationSharingStartedWebhookEvent["data"]> & {
    eventId?: string;
  } = {},
): LocationSharingStartedWebhookEvent {
  return {
    api_version: "v3",
    webhook_version: "2026-02-03",
    event_type: "location.sharing.started",
    event_id: overrides.eventId ?? "evt-location-started",
    created_at: "2026-08-02T12:00:00Z",
    trace_id: "trace-location-started",
    partner_id: "partner-1",
    data: {
      shared_by: overrides.shared_by ?? "+971501234567",
      shared_with: overrides.shared_with ?? tavraNumber,
      began_at: overrides.began_at ?? "2026-08-02T12:00:00Z",
      ends_at: overrides.ends_at ?? "2026-08-02T13:00:00Z",
    },
  };
}

test("extracts and trims inbound text", () => {
  assert.equal(textFromMessage(event({ text: "  hello  " })), "hello");
});

test("passes sender and chat context and sends one reply for duplicate deliveries", async () => {
  const generations: Array<{
    message: string;
    senderHandle: string;
    chatId: string;
  }> = [];
  const sends: Array<{ chatId: string; eventId: string; text: string }> = [];
  const activity: string[] = [];
  const generator: ReplyGenerator = {
    async generateReply(request) {
      activity.push("generate");
      generations.push(request);
      return "Check your airline's app for the latest departure time.";
    },
  };
  const sender: LinqMessageSender = {
    async startTyping() {
      activity.push("typing:start");
    },
    async stopTyping() {
      activity.push("typing:stop");
    },
    async sendText(chatId, eventId, text) {
      activity.push("send");
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
  assert.deepEqual(generations, [
    {
      message: "My flight is delayed",
      senderHandle: "+971501234567",
      chatId: "chat-1",
      attachments: [],
    },
  ]);
  assert.deepEqual(sends, [
    {
      chatId: "chat-1",
      eventId: "evt-1",
      text: "Check your airline's app for the latest departure time.",
    },
  ]);
  assert.deepEqual(activity, ["typing:start", "generate", "send"]);
});

test("turns a Linq location-sharing webhook into one deterministic chat reply", async () => {
  const sends: Array<{ chatId: string; eventId: string; text: string }> = [];
  const locationCalls: Array<{
    chatId: string;
    senderHandle: string;
    eventAt: string;
  }> = [];
  const generator: ReplyGenerator = {
    async generateReply() {
      throw new Error("ordinary message generation should not run");
    },
    chatForLocationShare(senderHandle) {
      return senderHandle === "+971501234567" ? "chat-location" : null;
    },
    async generateLocationShareReply(request) {
      locationCalls.push(request);
      return "I found 50 Park Plaza. Is this the exact delivery address?";
    },
  };
  const sender: LinqMessageSender = {
    async sendText(chatId, eventId, text) {
      sends.push({ chatId, eventId, text });
      return { messageId: "out-location" };
    },
  };
  const processEvent = createMessageReplyProcessor({
    fromNumber: tavraNumber,
    generator,
    sender,
    store: new InMemoryProcessedEventStore(),
  });

  const first = await processEvent(locationStartedEvent());
  const duplicate = await processEvent(locationStartedEvent());

  assert.deepEqual(first, {
    status: "sent",
    eventId: "evt-location-started",
    chatId: "chat-location",
    messageId: "out-location",
  });
  assert.deepEqual(duplicate, {
    status: "duplicate",
    eventId: "evt-location-started",
  });
  assert.deepEqual(locationCalls, [
    {
      chatId: "chat-location",
      senderHandle: "+971501234567",
      eventAt: "2026-08-02T12:00:00Z",
    },
  ]);
  assert.deepEqual(sends, [
    {
      chatId: "chat-location",
      eventId: "evt-location-started",
      text: "I found 50 Park Plaza. Is this the exact delivery address?",
    },
  ]);
});

test("ignores location events for another Linq line and clears stopped shares", async () => {
  const stopped: string[] = [];
  const generator: ReplyGenerator = {
    async generateReply() {
      throw new Error("not used");
    },
    chatForLocationShare() {
      return "chat-location";
    },
    async generateLocationShareReply() {
      throw new Error("wrong-line location must not be used");
    },
    locationSharingStopped(senderHandle) {
      stopped.push(senderHandle);
    },
  };
  const sender: LinqMessageSender = {
    async sendText() {
      throw new Error("location lifecycle events should not send here");
    },
  };
  const processEvent = createMessageReplyProcessor({
    fromNumber: tavraNumber,
    generator,
    sender,
    store: new InMemoryProcessedEventStore(),
  });

  assert.deepEqual(
    await processEvent(
      locationStartedEvent({
        eventId: "evt-location-wrong-line",
        shared_with: "+12025550123",
      }),
    ),
    {
      status: "ignored",
      eventId: "evt-location-wrong-line",
      reason: "wrong_line",
    },
  );

  const stoppedEvent: LocationSharingStoppedWebhookEvent = {
    api_version: "v3",
    webhook_version: "2026-02-03",
    event_type: "location.sharing.stopped",
    event_id: "evt-location-stopped",
    created_at: "2026-08-02T12:10:00Z",
    trace_id: "trace-location-stopped",
    partner_id: "partner-1",
    data: {
      shared_by: "+971501234567",
      shared_with: tavraNumber,
    },
  };
  assert.deepEqual(await processEvent(stoppedEvent), {
    status: "ignored",
    eventId: "evt-location-stopped",
    reason: "location_stopped",
  });
  assert.deepEqual(stopped, ["+971501234567"]);
});

test("passes an image-only notice to the generator instead of discarding it", async () => {
  const imageEvent = event({ eventId: "evt-image", text: "" });
  imageEvent.data.parts = [
    {
      type: "media",
      id: "attachment-1",
      filename: "delay-notice.png",
      mime_type: "image/png",
      size_bytes: 12345,
      url: "https://cdn.linqapp.com/attachments/partners/p/a/delay-notice.png",
    },
  ];
  let attachmentCount = 0;
  const processEvent = createMessageReplyProcessor({
    fromNumber: tavraNumber,
    generator: {
      async generateReply(request) {
        attachmentCount = request.attachments?.length ?? 0;
        return "I read the baggage notice. Are these details correct?";
      },
    },
    sender: {
      async sendText() {
        return { messageId: "out-image" };
      },
    },
    store: new InMemoryProcessedEventStore(),
  });

  const result = await processEvent(imageEvent);
  assert.equal(result.status, "sent");
  assert.equal(attachmentCount, 1);
});

test("ignores a delayed attachment webhook older than the latest turn in that chat", async () => {
  const generated: string[] = [];
  const sent: string[] = [];
  const processEvent = createMessageReplyProcessor({
    fromNumber: tavraNumber,
    generator: {
      async generateReply(request) {
        generated.push(request.message || "[attachment]");
        return "reply";
      },
    },
    sender: {
      async sendText(_chatId, eventId) {
        sent.push(eventId);
        return { messageId: `out-${eventId}` };
      },
    },
    store: new InMemoryProcessedEventStore(),
  });

  await processEvent(
    event({
      eventId: "evt-newer",
      messageId: "message-newer",
      text: "Boston by 7am",
      sentAt: "2026-08-01T12:05:00Z",
    }),
  );
  const delayedAttachment = event({
    eventId: "evt-older-image",
    messageId: "message-older-image",
    text: "",
    sentAt: "2026-08-01T12:01:00Z",
  });
  delayedAttachment.data.parts = [
    {
      type: "media",
      id: "attachment-old",
      filename: "old-delay-notice.png",
      mime_type: "image/png",
      size_bytes: 12345,
      url: "https://cdn.linqapp.com/attachments/old-delay-notice.png",
    },
  ];

  assert.deepEqual(await processEvent(delayedAttachment), {
    status: "ignored",
    eventId: "evt-older-image",
    reason: "stale_message",
  });
  assert.deepEqual(generated, ["Boston by 7am"]);
  assert.deepEqual(sent, ["evt-newer"]);
});

test("deduplicates the same Linq message and attachment across new event ids", async () => {
  let generations = 0;
  const store = new InMemoryProcessedEventStore();
  const processEvent = createMessageReplyProcessor({
    fromNumber: tavraNumber,
    generator: {
      async generateReply() {
        generations += 1;
        return "reply";
      },
    },
    sender: {
      async sendText() {
        return { messageId: "out" };
      },
    },
    store,
  });
  const first = event({
    eventId: "evt-original",
    messageId: "message-shared",
    text: "",
  });
  first.data.parts = [
    {
      type: "media",
      id: "attachment-shared",
      filename: "notice.png",
      mime_type: "image/png",
      size_bytes: 12345,
      url: "https://cdn.linqapp.com/attachments/notice.png",
    },
  ];
  const replay = structuredClone(first);
  replay.event_id = "evt-redelivery-with-new-id";

  assert.equal((await processEvent(first)).status, "sent");
  assert.deepEqual(await processEvent(replay), {
    status: "duplicate",
    eventId: "evt-redelivery-with-new-id",
  });
  assert.equal(generations, 1);
  assert.equal(await store.hasAttachment("attachment-shared"), true);
});

test("serializes simultaneous messages from the same chat", async () => {
  const order: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstCanFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const processEvent = createMessageReplyProcessor({
    fromNumber: tavraNumber,
    generator: {
      async generateReply(request) {
        order.push(`start:${request.message}`);
        if (request.message === "first") await firstCanFinish;
        order.push(`finish:${request.message}`);
        return request.message;
      },
    },
    sender: {
      async sendText(_chatId, _eventId, text) {
        order.push(`send:${text}`);
        return { messageId: `out-${text}` };
      },
    },
    store: new InMemoryProcessedEventStore(),
  });

  const first = processEvent(
    event({
      eventId: "evt-first",
      messageId: "message-first",
      text: "first",
      sentAt: "2026-08-01T12:00:00Z",
    }),
  );
  const second = processEvent(
    event({
      eventId: "evt-second",
      messageId: "message-second",
      text: "second",
      sentAt: "2026-08-01T12:00:01Z",
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["start:first"]);
  releaseFirst?.();
  await Promise.all([first, second]);
  assert.deepEqual(order, [
    "start:first",
    "finish:first",
    "send:first",
    "start:second",
    "finish:second",
    "send:second",
  ]);
});

test("sends media and a rich link after the conversational text", async () => {
  const activity: string[] = [];
  const processEvent = createMessageReplyProcessor({
    fromNumber: tavraNumber,
    generator: {
      async generateReply() {
        return "Here is the option and its secure approval.";
      },
      consumePresentation() {
        return {
          productMedia: [
            {
              productRef: "b-shirt-001",
              lineItemDescription: "Neutral basic T-shirt, size M",
              url: "https://tavra.example/products/b-shirt-001.png",
              altText: "Neutral basic T-shirt. Proposed item: size M.",
              caption: "Neutral basic T-shirt, size M\nIllustrative sandbox image",
              source: {
                kind: "synthetic_demo_asset",
                label: "Tavra synthetic demo catalog",
                assetFilename: "b-shirt-001.png",
                mediaUrl: "https://tavra.example/products/b-shirt-001.png",
              },
            },
            {
              productRef: "b-toiletry-001",
              lineItemDescription: "Essential toiletry kit",
              url: "https://tavra.example/products/b-toiletry-001.png",
              altText: "Travel-size toiletries. Proposed item: essential kit.",
              caption: "Essential toiletry kit\nIllustrative sandbox image",
              source: {
                kind: "synthetic_demo_asset",
                label: "Tavra synthetic demo catalog",
                assetFilename: "b-toiletry-001.png",
                mediaUrl: "https://tavra.example/products/b-toiletry-001.png",
              },
            },
          ],
          linkUrl: "https://tavra.example/pay/checkout",
        };
      },
    },
    sender: {
      async sendText() {
        activity.push("text");
        return { messageId: "out-text" };
      },
      async sendMedia(_chatId, _eventId, items) {
        activity.push(
          `media:${items.map((item) => item.productRef).join(",")}`,
        );
        return { messageId: "out-media" };
      },
      async sendLink(_chatId, _eventId, url) {
        activity.push(`link:${url}`);
        return { messageId: "out-link" };
      },
    },
    store: new InMemoryProcessedEventStore(),
  });

  await processEvent(event({ eventId: "evt-presentation" }));
  assert.deepEqual(activity, [
    "text",
    "media:b-shirt-001,b-toiletry-001",
    "link:https://tavra.example/pay/checkout",
  ]);
});

test("sends an interactive app card instead of its ordinary link fallback", async () => {
  const activity: string[] = [];
  const processEvent = createMessageReplyProcessor({
    fromNumber: tavraNumber,
    generator: {
      async generateReply() {
        return "Your secure approval is ready.";
      },
      consumePresentation() {
        return {
          appCard: {
            checkoutId: "checkout-app-card-1234567890",
            identity: {
              name: "Tavra",
              teamId: "A1B2C3D4E5",
              bundleId: "com.example.tavra.MessagesExtension",
            },
            url: "https://tavra.example/pay/checkout-app-card-1234567890",
            fallbackText: "Open secure Tavra approval",
            interactive: true,
            layout: { caption: "Tavra recovery" },
          },
          linkUrl: "https://tavra.example/pay/link-must-not-send",
        };
      },
    },
    sender: {
      async sendText() {
        activity.push("text");
        return { messageId: "out-text" };
      },
      async sendAppCard(_chatId, _eventId, card) {
        activity.push(`app:${card.checkoutId}`);
        return { messageId: "out-app" };
      },
      async sendLink() {
        activity.push("link");
        return { messageId: "out-link" };
      },
    },
    store: new InMemoryProcessedEventStore(),
    onAppCardSent({ checkoutId, messageId }) {
      activity.push(`record:${checkoutId}:${messageId}`);
    },
  });

  await processEvent(event({ eventId: "evt-app-card" }));
  assert.deepEqual(activity, [
    "text",
    "app:checkout-app-card-1234567890",
    "record:checkout-app-card-1234567890:out-app",
  ]);
});

test("clears the typing indicator when reply generation fails", async () => {
  const activity: string[] = [];
  const processEvent = createMessageReplyProcessor({
    fromNumber: tavraNumber,
    generator: {
      async generateReply() {
        activity.push("generate");
        throw new Error("OpenAI unavailable");
      },
    },
    sender: {
      async startTyping() {
        activity.push("typing:start");
      },
      async stopTyping() {
        activity.push("typing:stop");
      },
      async sendText() {
        throw new Error("send should not be called");
      },
    },
    store: new InMemoryProcessedEventStore(),
  });

  await assert.rejects(() => processEvent(event()), /OpenAI unavailable/);
  assert.deepEqual(activity, ["typing:start", "generate", "typing:stop"]);
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
