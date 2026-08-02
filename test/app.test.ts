import assert from "node:assert/strict";
import test from "node:test";

import type LinqAPIV3 from "@linqapp/sdk";
import type { MessageReceivedWebhookEvent } from "@linqapp/sdk/resources/webhooks";

import { createApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import type { PravaCheckoutService } from "../src/prava.js";

const config: ServerConfig = {
  apiKey: "test-key",
  fromNumber: "+919876543210",
  openAIApiKey: "test-openai-key",
  openAIModel: "test-model",
  openAIRouterModel: "test-router-model",
  sensoApiKey: "test-senso-key",
  sensoBaseUrl: "https://senso.test/api/v1/",
  sensoIdentityMapPath: "senso/demo-config/identity-map.local.json",
  pravaPublishableKey: "pk_test_example",
  pravaSecretKey: "sk_test_example",
  pravaMode: "sandbox",
  pravaBackendUrl: "https://sandbox.api.prava.space/",
  pravaCheckoutMode: "embedded",
  publicBaseUrl: "https://tavra.example",
  iMessageAppIdentity: null,
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
  const receivedEventTypes: string[] = [];
  const app = createApp({
    config,
    client: {} as LinqAPIV3,
    async processEvent(event) {
      receivedEventId = event.event_id;
      receivedEventTypes.push(event.event_type);
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

  const locationWebhook = await fetch(`${origin}/webhooks/linq`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...fixture,
      event_type: "location.sharing.started",
      event_id: "evt-http-location",
      data: {
        shared_by: "+971501234567",
        shared_with: config.fromNumber,
        began_at: "2026-08-02T12:00:00Z",
      },
    }),
  });
  assert.equal(locationWebhook.status, 200);
  assert.deepEqual(await locationWebhook.json(), {
    ok: true,
    status: "ignored",
  });
  assert.equal(receivedEventId, "evt-http-location");
  assert.deepEqual(receivedEventTypes, [
    "message.received",
    "location.sharing.started",
  ]);
});

test("serves only browser-safe Prava checkout state", async (t) => {
  const prava: PravaCheckoutService = {
    async createCheckout() {
      throw new Error("not used");
    },
    getClientSession(checkoutId) {
      if (checkoutId !== "checkout-safe") return null;
      return {
        checkoutMode: "hosted",
        publishableKey: "pk_test_browser_safe",
        sessionToken: "session-token",
        iframeUrl: "https://checkout.sandbox.prava.space/embed/session",
        expiresAt: "2099-08-01T12:15:00.000Z",
        order: {
          description: "Recovery essentials",
          totalAmount: "154.00",
          currency: "USD",
          products: [
            {
              productRef: "b-toiletry-001",
              description: "Essential toiletry kit",
              unitPrice: "22.00",
              quantity: 1,
            },
          ],
        },
      };
    },
    async getStatus(checkoutId) {
      return checkoutId === "checkout-safe"
        ? {
            status: "completed",
            merchantOrderId: "SIM-order-safe",
            merchantOutcome: "simulated",
          }
        : null;
    },
    async revoke(checkoutId) {
      return checkoutId === "checkout-safe";
    },
  };
  const app = createApp({
    config,
    client: {} as LinqAPIV3,
    async processEvent(event) {
      return { status: "duplicate", eventId: event.event_id };
    },
    prava,
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

  const session = await fetch(`${origin}/api/prava/checkouts/checkout-safe/session`);
  assert.equal(session.status, 200);
  assert.equal(session.headers.get("cache-control"), "no-store");
  const payload = JSON.stringify(await session.json());
  assert.match(payload, /pk_test_browser_safe/);
  assert.doesNotMatch(payload, /sk_test|dynamic_cvv|network.token/i);

  const summary = await fetch(
    `${origin}/api/prava/checkouts/checkout-safe/summary`,
  );
  assert.equal(summary.status, 200);
  assert.equal(summary.headers.get("cache-control"), "no-store");
  assert.deepEqual(await summary.json(), {
    checkoutId: "checkout-safe",
    approvalUrl: "https://tavra.example/pay/checkout-safe",
    expiresAt: "2099-08-01T12:15:00.000Z",
    order: {
      description: "Recovery essentials",
      totalAmount: "154.00",
      currency: "USD",
      products: [
        {
          productRef: "b-toiletry-001",
          description: "Essential toiletry kit",
          unitPrice: "22.00",
          quantity: 1,
          imageUrl:
            "https://tavra.example/checkout-assets/products/b-toiletry-001.png",
        },
      ],
    },
  });
  const summaryPayload = JSON.stringify(
    await (
      await fetch(`${origin}/api/prava/checkouts/checkout-safe/summary`)
    ).json(),
  );
  assert.doesNotMatch(
    summaryPayload,
    /session-token|pk_test|sk_test|iframe|dynamic_cvv|network.token/i,
  );

  const status = await fetch(`${origin}/api/prava/checkouts/checkout-safe/status`);
  assert.deepEqual(await status.json(), {
    status: "completed",
    merchantOrderId: "SIM-order-safe",
    merchantOutcome: "simulated",
  });
  const missing = await fetch(`${origin}/api/prava/checkouts/missing/session`);
  assert.equal(missing.status, 404);
  const missingSummary = await fetch(
    `${origin}/api/prava/checkouts/missing/summary`,
  );
  assert.equal(missingSummary.status, 404);

  const paymentPage = await fetch(`${origin}/pay/checkout-safe`);
  assert.equal(paymentPage.status, 200);
  const html = await paymentPage.text();
  const stylesheetPath = html.match(/<link[^>]+href="([^"]+\.css)"/)?.[1];
  assert.ok(stylesheetPath, "payment page should reference its built stylesheet");
  const stylesheet = await fetch(new URL(stylesheetPath, origin));
  assert.equal(stylesheet.status, 200);
  assert.match(stylesheet.headers.get("content-type") ?? "", /text\/css/);
  const stylesheetText = await stylesheet.text();
  assert.match(stylesheetText, /\.checkout\{/);
  assert.match(stylesheetText, /\[hidden\]\{display:none!important\}/);
  assert.match(
    stylesheetText,
    /\.prava-frame iframe\{[^}]*min-height:410px[^}]*\}/,
  );

  for (const filename of [
    "b-shirt-001.png",
    "b-trouser-001.png",
    "b-toiletry-001.png",
    "recovery-bundle.png",
  ]) {
    const productImage = await fetch(
      `${origin}/checkout-assets/products/${filename}`,
    );
    assert.equal(productImage.status, 200);
    assert.match(productImage.headers.get("content-type") ?? "", /image\/png/);
    assert.ok((await productImage.arrayBuffer()).byteLength > 1_000);
  }
});
