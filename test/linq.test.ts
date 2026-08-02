import assert from "node:assert/strict";
import test from "node:test";

import type LinqAPIV3 from "@linqapp/sdk";

import {
  createLinqLocationProvider,
  createLinqMessageSender,
  linqLocationErrorDetails,
} from "../src/linq.js";
import type { ResolvedProductMedia } from "../src/product-media.js";

test("pairs every proposed line-item caption with its own Linq media part", async () => {
  let request: Record<string, unknown> | null = null;
  const client = {
    chats: {
      messages: {
        async send(_chatId: string, value: Record<string, unknown>) {
          request = value;
          return { message: { id: "message-media" } };
        },
      },
    },
  } as unknown as LinqAPIV3;
  const items: ResolvedProductMedia[] = [
    {
      productRef: "b-shirt-001",
      lineItemDescription: "Neutral basic T-shirt, size M",
      url: "https://tavra.example/checkout-assets/products/b-shirt-001.png",
      altText: "Neutral basic T-shirt. Proposed item: size M.",
      caption: "Neutral basic T-shirt, size M\nRecovery item preview",
      source: {
        kind: "synthetic_demo_asset",
        label: "Tavra synthetic demo catalog",
        assetFilename: "b-shirt-001.png",
        mediaUrl:
          "https://tavra.example/checkout-assets/products/b-shirt-001.png",
      },
    },
    {
      productRef: "b-trouser-001",
      lineItemDescription: "Basic trousers, 32x30",
      url: "https://tavra.example/checkout-assets/products/b-trouser-001.png",
      altText: "Basic trousers. Proposed item: 32x30.",
      caption: "Basic trousers, 32x30\nRecovery item preview",
      source: {
        kind: "synthetic_demo_asset",
        label: "Tavra synthetic demo catalog",
        assetFilename: "b-trouser-001.png",
        mediaUrl:
          "https://tavra.example/checkout-assets/products/b-trouser-001.png",
      },
    },
  ];

  const sender = createLinqMessageSender(client);
  await sender.sendMedia?.("chat-1", "event-1", items);

  const message = (request as { message?: Record<string, unknown> } | null)?.message;
  assert.deepEqual(message?.parts, [
    {
      type: "text",
      value: "Neutral basic T-shirt, size M\nRecovery item preview",
    },
    {
      type: "media",
      url: "https://tavra.example/checkout-assets/products/b-shirt-001.png",
    },
    {
      type: "text",
      value: "Basic trousers, 32x30\nRecovery item preview",
    },
    {
      type: "media",
      url: "https://tavra.example/checkout-assets/products/b-trouser-001.png",
    },
  ]);
  assert.equal(message?.idempotency_key, "tavra-media-event-1");
});

test("uploads a PDF once and sends it as a private Linq attachment", async () => {
  const requests: Record<string, unknown>[] = [];
  const attachmentRequests: Record<string, unknown>[] = [];
  const uploads: Array<{
    input: string;
    init: RequestInit | undefined;
  }> = [];
  const client = {
    attachments: {
      async create(value: Record<string, unknown>) {
        attachmentRequests.push(value);
        return {
          attachment_id: "attachment-packet-1",
          upload_url: "https://uploads.linq.example/packet",
          http_method: "PUT",
          required_headers: {
            "Content-Type": "application/pdf",
            "Content-Length": "8",
          },
        };
      },
    },
    chats: {
      messages: {
        async send(_chatId: string, value: Record<string, unknown>) {
          requests.push(value);
          return { message: { id: "message-packet" } };
        },
      },
    },
  } as unknown as LinqAPIV3;
  const bytes = new TextEncoder().encode("%PDF-1.7");
  const sender = createLinqMessageSender(client, {
    async fetch(input, init) {
      uploads.push({ input: String(input), init });
      return new Response(null, { status: 200 });
    },
  });

  const sent = await sender.sendDocument?.("chat-1", "packet-1", {
    filename: "tavra-reimbursement-packet.pdf",
    contentType: "application/pdf",
    bytes,
  });

  assert.deepEqual(attachmentRequests, [
    {
      filename: "tavra-reimbursement-packet.pdf",
      content_type: "application/pdf",
      size_bytes: 8,
    },
  ]);
  assert.equal(uploads[0]?.input, "https://uploads.linq.example/packet");
  assert.equal(uploads[0]?.init?.method, "PUT");
  assert.deepEqual(uploads[0]?.init?.headers, {
    "Content-Type": "application/pdf",
    "Content-Length": "8",
  });
  assert.deepEqual(
    Array.from(uploads[0]?.init?.body as Uint8Array),
    Array.from(bytes),
  );
  const message = requests[0]?.message as Record<string, unknown>;
  assert.deepEqual(message.parts, [
    { type: "media", attachment_id: "attachment-packet-1" },
  ]);
  assert.equal(message.preferred_service, "iMessage");
  assert.equal(message.idempotency_key, "tavra-document-packet-1");
  assert.deepEqual(sent, {
    messageId: "message-packet",
    attachmentId: "attachment-packet-1",
  });
});

test("sends a one-time PDF through Linq's documented media URL shape", async () => {
  const requests: Record<string, unknown>[] = [];
  const client = {
    chats: {
      messages: {
        async send(_chatId: string, value: Record<string, unknown>) {
          requests.push(value);
          return { message: { id: "message-document-url" } };
        },
      },
    },
  } as unknown as LinqAPIV3;
  const bytes = new TextEncoder().encode("%PDF-1.7");
  const sender = createLinqMessageSender(client, {
    documentUrl: ({ eventId, filename }) =>
      `https://tavra.example/checkout-assets/documents/${eventId}/${filename}`,
  });

  const sent = await sender.sendDocument?.("chat-1", "reimbursement-packet-checkout-1", {
    filename: "tavra-emirates-reimbursement-packet.pdf",
    contentType: "application/pdf",
    bytes,
  });

  const message = requests[0]?.message as Record<string, unknown>;
  assert.deepEqual(message.parts, [
    {
      type: "media",
      url: "https://tavra.example/checkout-assets/documents/reimbursement-packet-checkout-1/tavra-emirates-reimbursement-packet.pdf",
    },
  ]);
  assert.equal(message.preferred_service, "iMessage");
  assert.equal(
    message.idempotency_key,
    "tavra-document-reimbursement-packet-checkout-1",
  );
  assert.equal(sent?.messageId, "message-document-url");
  assert.match(sent?.attachmentId ?? "", /^url-[a-f0-9]{64}$/);
});

test("serializes a Linq iMessage app as the only message part and updates it in place", async () => {
  const sends: Record<string, unknown>[] = [];
  const updates: Array<{ messageId: string; body: Record<string, unknown> }> = [];
  const client = {
    chats: {
      messages: {
        async send(_chatId: string, value: Record<string, unknown>) {
          sends.push(value);
          return { message: { id: "message-app-card" } };
        },
      },
    },
    messages: {
      async updateAppCard(messageId: string, body: Record<string, unknown>) {
        updates.push({ messageId, body });
        return { message: { id: "message-app-card-update" } };
      },
    },
  } as unknown as LinqAPIV3;
  const sender = createLinqMessageSender(client);

  const sent = await sender.sendAppCard?.("chat-1", "event-app", {
    checkoutId: "checkout-app-card-1234567890",
    identity: {
      name: "Tavra",
      teamId: "A1B2C3D4E5",
      bundleId: "com.example.tavra.MessagesExtension",
    },
    url: "https://tavra.example/pay/checkout-app-card-1234567890",
    fallbackText: "Open secure Tavra approval",
    interactive: true,
    layout: {
      caption: "Tavra recovery",
      subcaption: "3 items ready for review",
      trailingCaption: "USD 154.00",
      imageUrl:
        "https://tavra.example/checkout-assets/products/b-shirt-001.png",
    },
  });
  assert.equal(sent?.messageId, "message-app-card");
  const message = sends[0]?.message as {
    parts?: Array<Record<string, unknown>>;
    preferred_service?: string;
  };
  assert.equal(message.parts?.length, 1);
  assert.deepEqual(message.parts?.[0], {
    type: "imessage_app",
    app: {
      name: "Tavra",
      team_id: "A1B2C3D4E5",
      bundle_id: "com.example.tavra.MessagesExtension",
    },
    url: "https://tavra.example/pay/checkout-app-card-1234567890",
    fallback_text: "Open secure Tavra approval",
    interactive: true,
    layout: {
      caption: "Tavra recovery",
      subcaption: "3 items ready for review",
      trailing_caption: "USD 154.00",
      image_url:
        "https://tavra.example/checkout-assets/products/b-shirt-001.png",
    },
  });
  assert.equal(message.preferred_service, "iMessage");

  const updated = await sender.updateAppCard?.("message-app-card", {
    url: "https://tavra.example/pay/checkout-app-card-1234567890",
    fallbackText: "Tavra approval status",
    interactive: true,
    layout: {
      caption: "Recovery approval complete",
      subcaption: "Recovery case updated",
    },
  });
  assert.equal(updated?.messageId, "message-app-card-update");
  assert.equal(updates[0]?.messageId, "message-app-card");
  assert.deepEqual(updates[0]?.body, {
    url: "https://tavra.example/pay/checkout-app-card-1234567890",
    fallback_text: "Tavra approval status",
    interactive: true,
    layout: {
      caption: "Recovery approval complete",
      subcaption: "Recovery case updated",
    },
  });
});

test("normalizes phone handles when retrieving a shared Linq location", async () => {
  const client = {
    chats: {
      location: {
        async retrieve() {
          return {
            success: true,
            data: {
              type: "FeatureCollection",
              features: [
                {
                  type: "Feature",
                  geometry: { type: "Point", coordinates: [-71.0589, 42.3601] },
                  properties: {
                    handle: "+1 202 555 0123",
                    address: "50 Park Plaza, Boston, MA 02116",
                    locality: "Boston",
                    updated_at: "2026-08-02T12:00:00Z",
                  },
                },
              ],
            },
          };
        },
      },
    },
  } as unknown as LinqAPIV3;

  const location = await createLinqLocationProvider(client).getCurrent(
    "chat-1",
    "+12025550123",
  );
  assert.deepEqual(location, {
    address: "50 Park Plaza, Boston, MA 02116",
    locality: "Boston",
    coordinates: [-71.0589, 42.3601],
    updatedAt: "2026-08-02T12:00:00Z",
  });
});

test("extracts Linq account capability details without exposing credentials", () => {
  const details = linqLocationErrorDetails({
    status: 403,
    error: {
      success: false,
      trace_id: "trace-location",
      error: {
        code: 2011,
        message: "Location features are not available for your account",
        doc_url: "https://docs.linqapp.com/error/codes/2xxx/2011/",
      },
    },
  });
  assert.deepEqual(details, {
    status: 403,
    code: 2011,
    message: "Location features are not available for your account",
    docUrl: "https://docs.linqapp.com/error/codes/2xxx/2011/",
    traceId: "trace-location",
  });
});
