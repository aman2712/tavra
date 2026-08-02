import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type LinqAPIV3 from "@linqapp/sdk";
import type { MessageReceivedWebhookEvent } from "@linqapp/sdk/resources/webhooks";

import {
  createApp,
  hasSafeImageDimensions,
  isPublicImageAddress,
  resolvePublicImageAddress,
} from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import type { LiveCommerceService } from "../src/live-commerce.js";
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
  commerceMode: "sandbox",
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

  const preview = await fetch(
    `${origin}/checkout-assets/products/recovery-bundle.png`,
  );
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("content-type"), "image/png");
  assert.ok((await preview.arrayBuffer()).byteLength > 0);

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

test("serves the reimbursement PDF at the opaque Linq media URL", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tavra-packet-route-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packetPath = join(directory, "packet.pdf");
  const packet = Buffer.from("%PDF-1.7\nreimbursement packet\n");
  await writeFile(packetPath, packet);
  const app = createApp({
    config,
    client: {} as LinqAPIV3,
    reimbursementPacketPath: packetPath,
    async processEvent(event) {
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

  const response = await fetch(
    `${origin}/checkout-assets/documents/reimbursement-packet-checkout_123/tavra-emirates-reimbursement-packet.pdf`,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.match(
    response.headers.get("content-disposition") ?? "",
    /tavra-emirates-reimbursement-packet\.pdf/,
  );
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), packet);

  const guess = await fetch(
    `${origin}/checkout-assets/documents/not-a-valid-delivery/tavra-emirates-reimbursement-packet.pdf`,
  );
  assert.equal(guess.status, 404);
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
  const commerceHealth = await fetch(`${origin}/health/commerce`);
  assert.equal(commerceHealth.status, 200);
  assert.deepEqual(await commerceHealth.json(), {
    status: "ready",
    mode: "sandbox",
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

test("proxies the exact sandbox merchant image for the iMessage extension", async (t) => {
  const checkoutId = "checkout-sandbox-image-001";
  const merchantImageUrl =
    "https://cdn.shopify.com/s/files/1/0697/4213/3411/files/Sensodyne_Deep_Clean_Gel_Toothpaste_-_75ml_Toothpaste_1.jpg?v=1774107076";
  const imageBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const prava: PravaCheckoutService = {
    async createCheckout() {
      throw new Error("not used");
    },
    getClientSession(requestedCheckoutId) {
      if (requestedCheckoutId !== checkoutId) return null;
      return {
        checkoutMode: "hosted",
        publishableKey: "pk_test_browser_safe",
        sessionToken: "session-token",
        iframeUrl: "https://checkout.sandbox.prava.space/embed/session",
        expiresAt: "2099-08-01T12:15:00.000Z",
        order: {
          description: "Recovery essential from Meddu",
          totalAmount: "47.81",
          currency: "AED",
          products: [
            {
              productRef: "merchant-46624128270499",
              merchantVariantId: "gid://shopify/ProductVariant/46624128270499",
              merchantName: "Meddu",
              merchantUrl: "https://meddu.com/",
              checkoutUrl:
                "https://edqvrb-i5.myshopify.com/cart/46624128270499:1",
              description: "Sensodyne Deep Clean Gel Toothpaste - 75ml",
              unitPrice: "47.81",
              quantity: 1,
              imageUrl: merchantImageUrl,
            },
          ],
        },
      };
    },
    async getStatus(requestedCheckoutId) {
      return requestedCheckoutId === checkoutId
        ? {
            status: "sandbox_validated",
            merchantAttempt: {
              merchantName: "Meddu",
              merchantUrl: "https://meddu.com/",
              attemptedAt: "2026-08-02T18:00:00.000Z",
              responseText: "Test credential declined",
              responseCode: "test_card",
              reference: null,
            },
          }
        : null;
    },
    async revoke() {
      return false;
    },
  };
  let upstreamFetches = 0;
  const app = createApp({
    config,
    client: {} as LinqAPIV3,
    prava,
    async processEvent(event) {
      return { status: "duplicate", eventId: event.event_id };
    },
    async productImageResolve() {
      return [{ address: "23.227.38.74", family: 4 }];
    },
    async productImageFetch(input, init) {
      upstreamFetches += 1;
      assert.equal(String(input), merchantImageUrl);
      assert.equal(init?.redirect, "error");
      return new Response(imageBytes, {
        status: 200,
        headers: { "content-type": "image/png" },
      });
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

  const summary = await (
    await fetch(`${origin}/api/prava/checkouts/${checkoutId}/summary`)
  ).json() as {
    order: {
      products: Array<{ imageUrl?: string }>;
      merchant?: { name: string; domain: string; provenance: string };
    };
  };
  assert.equal(
    summary.order.products[0]?.imageUrl,
    `https://tavra.example/api/prava/checkouts/${checkoutId}/products/0/image`,
  );
  assert.deepEqual(summary.order.merchant, {
    name: "Meddu",
    domain: "meddu.com",
    provenance: "Prava UCP sandbox merchant",
  });
  assert.doesNotMatch(JSON.stringify(summary), /cdn\.shopify\.com/);

  const image = await fetch(
    `${origin}/api/prava/checkouts/${checkoutId}/products/0/image`,
  );
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), imageBytes);
  assert.equal(upstreamFetches, 1);

  const missing = await fetch(
    `${origin}/api/prava/checkouts/${checkoutId}/products/1/image`,
  );
  assert.equal(missing.status, 404);
});

test("serves a live UCP summary, trusted redirect, and checkout-scoped image", async (t) => {
  const merchant = {
    name: "Essential Goods UAE",
    domain: "essential.example",
    country: "AE",
  };
  const provenance = {
    source: "prava_ucp" as const,
    merchantDomain: merchant.domain,
    retrievedAt: "2026-08-02T12:00:00.000Z",
  };
  const offer = {
    productId: "product_shirt_001",
    variantId: "variant_shirt_m_black",
    title: "Essential cotton T-shirt",
    description: "Black cotton T-shirt",
    merchant,
    options: { Size: "M", Color: "Black" },
    unitPrice: { amount: "149.00", currency: "AED" as const },
    available: true,
    imageUrl: "https://cdn.essential.example/shirt.jpg",
    provenance,
  };
  const workflow = {
    checkoutId: "checkout_live_summary_001",
    caseId: "RCV-LIVE1234",
    chatId: "chat-live-1234",
    state: "approval_pending" as const,
    updatedAt: "2026-08-02T12:05:00.000Z",
    payload: {
      schemaVersion: 1 as const,
      request: {
        caseId: "RCV-LIVE1234",
        chatId: "chat-live-1234",
        employeeId: "employee-demo",
        employeePhone: "+12025550123",
        employeeEmail: "traveler@example.com",
        employeeAllowance: { amount: "250.00", currency: "AED" as const },
        needBy: "8 AM tomorrow",
        needByIso: "2026-08-03T04:00:00.000Z",
        deliveryArea: "Masdar City, Abu Dhabi",
        address: {
          id: "addr_abu_dhabi_001",
          label: "Work",
          summary: "Masdar City, Abu Dhabi, AE",
          country: "AE",
          isDefault: true,
          contactPhoneOnFile: true,
        },
        essentials: { shipsTo: "AE", tShirtSize: "M" },
        incident: {
          airline: null,
          arrivalAirport: null,
          baggageReference: null,
          noticeAttachmentIds: [],
          passengerName: null,
          flightNumber: null,
          incidentDate: null,
        },
      },
      selection: {
        category: "tshirt" as const,
        result: {
          productId: offer.productId,
          title: offer.title,
          merchant,
          estimatedPrice: offer.unitPrice,
          imageUrl: offer.imageUrl,
          provenance,
        },
        product: {
          productId: offer.productId,
          title: offer.title,
          description: offer.description,
          merchant,
          images: [offer.imageUrl],
          offers: [offer],
          provenance,
        },
        offer,
      },
      quote: {
        quoteId: "quote_live_001",
        offer,
        addressId: "addr_abu_dhabi_001",
        quantity: 1,
        subtotal: { amount: "149.00", currency: "AED" as const },
        shipping: { amount: "15.00", currency: "AED" as const },
        tax: { amount: "5.00", currency: "AED" as const },
        total: { amount: "169.00", currency: "AED" as const },
        deliveryLabel: "Tomorrow by 7:30 AM",
        estimatedArrival: "2026-08-03T03:30:00.000Z",
        expiresAt: "2099-08-02T12:30:00.000Z",
      },
      paymentSession: {
        sessionId: "payment_session_live_001",
        paymentUrl: "https://pay.prava.space/session/live_001",
        expiresAt: "2099-08-02T12:30:00.000Z",
        replayed: false,
        quoteId: "quote_live_001",
        total: { amount: "169.00", currency: "AED" as const },
      },
      checkoutResult: null,
      deadlineAssessment: "meets" as const,
      offerAuthorizationEventId: "event_offer_001",
      purchaseAuthorizationEventId: "event_total_001",
      terminalNotified: false,
    },
  };
  const liveCommerce: LiveCommerceService = {
    async health() {
      return {
        ready: true,
        mode: "live",
        connectedAgentCount: 1,
        savedAddressCount: 1,
        missingScopes: [],
        message: null,
      };
    },
    async listAddresses() {
      return [workflow.payload.request.address];
    },
    async addAddress() {
      return workflow.payload.request.address;
    },
    async prepareOffer() {
      throw new Error("not used");
    },
    async createQuote() {
      throw new Error("not used");
    },
    async createApproval() {
      throw new Error("not used");
    },
    async getWorkflow(checkoutId) {
      return checkoutId === workflow.checkoutId ? workflow : null;
    },
    async getStatus(checkoutId) {
      return checkoutId === workflow.checkoutId
        ? { status: "approval_pending" }
        : null;
    },
    async getApprovalTarget(checkoutId) {
      return checkoutId === workflow.checkoutId
        ? workflow.payload.paymentSession.paymentUrl
        : null;
    },
    async getProductImageSource(checkoutId, index) {
      return checkoutId === workflow.checkoutId && index === 0
        ? offer.imageUrl
        : null;
    },
    async revoke(checkoutId) {
      return checkoutId === workflow.checkoutId;
    },
    async resume() {},
  };
  const imageBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  let productImageFetches = 0;
  const app = createApp({
    config,
    client: {} as LinqAPIV3,
    async processEvent(event) {
      return { status: "duplicate", eventId: event.event_id };
    },
    liveCommerce,
    now: () => new Date("2099-08-02T12:00:00.000Z"),
    async productImageResolve() {
      return [{ address: "93.184.216.34", family: 4 }];
    },
    async productImageFetch(input, init) {
      productImageFetches += 1;
      assert.equal(String(input), offer.imageUrl);
      assert.equal(init?.redirect, "error");
      return new Response(imageBytes, {
        status: 200,
        headers: { "content-type": "image/png" },
      });
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

  const summaryResponse = await fetch(
    `${origin}/api/prava/checkouts/${workflow.checkoutId}/summary`,
  );
  assert.equal(summaryResponse.status, 200);
  const summary = await summaryResponse.json() as Record<string, unknown>;
  const serialized = JSON.stringify(summary);
  assert.match(serialized, /Essential Goods UAE/);
  assert.match(serialized, /Masdar City, Abu Dhabi, AE/);
  assert.match(serialized, /Tomorrow by 7:30 AM/);
  assert.match(serialized, /"totalAmount":"169.00"/);
  assert.match(serialized, new RegExp(`/products/0/image`));
  assert.doesNotMatch(
    serialized,
    /payment_session_live|pay\.prava\.space|employeePhone|street|card|cvv/i,
  );

  const image = await fetch(
    `${origin}/api/prava/checkouts/${workflow.checkoutId}/products/0/image`,
  );
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), imageBytes);
  const cachedImage = await fetch(
    `${origin}/api/prava/checkouts/${workflow.checkoutId}/products/0/image`,
  );
  assert.equal(cachedImage.status, 200);
  assert.equal(productImageFetches, 1);

  for (let requestIndex = 2; requestIndex < 30; requestIndex += 1) {
    const cachedRequest = await fetch(
      `${origin}/api/prava/checkouts/${workflow.checkoutId}/products/0/image`,
    );
    assert.equal(cachedRequest.status, 200);
  }
  const rateLimitedImage = await fetch(
    `${origin}/api/prava/checkouts/${workflow.checkoutId}/products/0/image`,
  );
  assert.equal(rateLimitedImage.status, 429);
  assert.equal(rateLimitedImage.headers.get("retry-after"), "60");
  assert.equal(productImageFetches, 1);

  const approval = await fetch(`${origin}/pay/${workflow.checkoutId}`, {
    redirect: "manual",
  });
  assert.equal(approval.status, 303);
  assert.equal(approval.headers.get("location"), workflow.payload.paymentSession.paymentUrl);

  const status = await fetch(
    `${origin}/api/prava/checkouts/${workflow.checkoutId}/status`,
  );
  assert.deepEqual(await status.json(), { status: "approval_pending" });

  Object.assign(workflow, {
    state: "order_confirmed" as const,
    updatedAt: "2099-07-20T12:00:00.000Z",
  });
  Object.assign(workflow.payload, {
    checkoutResult: {
      status: "ordered" as const,
      orderId: "merchant_order_retained",
      amount: workflow.payload.quote.total,
      replayed: false,
    },
  });
  const expiredDetails = await fetch(
    `${origin}/api/prava/checkouts/${workflow.checkoutId}/summary`,
  );
  assert.equal(expiredDetails.status, 410);
  const retainedStatus = await fetch(
    `${origin}/api/prava/checkouts/${workflow.checkoutId}/status`,
  );
  assert.equal(retainedStatus.status, 200);

  workflow.updatedAt = "2099-06-01T12:00:00.000Z";
  const expiredStatus = await fetch(
    `${origin}/api/prava/checkouts/${workflow.checkoutId}/status`,
  );
  assert.equal(expiredStatus.status, 410);
  const expiredImage = await fetch(
    `${origin}/api/prava/checkouts/${workflow.checkoutId}/products/0/image`,
  );
  assert.equal(expiredImage.status, 404);
});

test("rejects private, mapped, mixed, and non-global product image addresses", async () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
  ]) {
    assert.equal(isPublicImageAddress(address), false, address);
  }
  assert.equal(isPublicImageAddress("93.184.216.34"), true);
  assert.equal(isPublicImageAddress("2606:4700:4700::1111"), true);

  await assert.rejects(
    () =>
      resolvePublicImageAddress("cdn.merchant.example", async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]),
    /only to public addresses/i,
  );
});

test("accepts only bounded images whose bytes match their declared format", () => {
  const onePixelPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  assert.equal(hasSafeImageDimensions("image/png", onePixelPng), true);
  assert.equal(
    hasSafeImageDimensions("image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
    false,
  );
  const oversizedPng = Buffer.from(onePixelPng);
  oversizedPng.writeUInt32BE(9_000, 16);
  oversizedPng.writeUInt32BE(9_000, 20);
  assert.equal(hasSafeImageDimensions("image/png", oversizedPng), false);
});
