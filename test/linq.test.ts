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
      caption: "Neutral basic T-shirt, size M\nIllustrative sandbox image",
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
      caption: "Basic trousers, 32x30\nIllustrative sandbox image",
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
      value: "Neutral basic T-shirt, size M\nIllustrative sandbox image",
    },
    {
      type: "media",
      url: "https://tavra.example/checkout-assets/products/b-shirt-001.png",
    },
    {
      type: "text",
      value: "Basic trousers, 32x30\nIllustrative sandbox image",
    },
    {
      type: "media",
      url: "https://tavra.example/checkout-assets/products/b-trouser-001.png",
    },
  ]);
  assert.equal(message?.idempotency_key, "tavra-media-event-1");
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
      caption: "Sandbox approval complete",
      subcaption: "No live merchant order was created",
    },
  });
  assert.equal(updated?.messageId, "message-app-card-update");
  assert.equal(updates[0]?.messageId, "message-app-card");
  assert.deepEqual(updates[0]?.body, {
    url: "https://tavra.example/pay/checkout-app-card-1234567890",
    fallback_text: "Tavra approval status",
    interactive: true,
    layout: {
      caption: "Sandbox approval complete",
      subcaption: "No live merchant order was created",
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
                    handle: "+91 73187 39001",
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
    "+917318739001",
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
