import assert from "node:assert/strict";
import test from "node:test";

import {
  createPravaCheckoutService,
  type MerchantCheckoutAdapter,
  type PravaStatusEvent,
} from "../src/prava.js";

const checkoutRequest = {
  employeeId: "emp_demo_001",
  employeeEmail: "employee@example.com",
  employeePhone: "+919876543210",
  chatId: "chat-prava",
  totalAmount: "154.00",
  currency: "USD",
  description: "Tavra delayed-baggage recovery essentials",
  products: [
    {
      productRef: "b-shirt-001",
      description: "Neutral basic T-shirt, size M",
      unitPrice: "54.00",
      quantity: 1,
    },
    {
      productRef: "b-trouser-001",
      description: "Basic trousers, 32x30",
      unitPrice: "78.00",
      quantity: 1,
    },
    {
      productRef: "b-toiletry-001",
      description: "Essential toiletry kit",
      unitPrice: "22.00",
      quantity: 1,
    },
  ],
};

test("creates one Prava session and keeps payment credentials server-side", async () => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const events: PravaStatusEvent[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url =
      input instanceof URL
        ? input
        : new URL(typeof input === "string" ? input : input.url);
    calls.push({ url, init });
    if (url.pathname.endsWith("/v1/sessions") && init?.method === "POST") {
      return Response.json({
        session_id: "session_123",
        session_token: "public_session_token",
        iframe_url: "https://checkout.sandbox.prava.space/embed/session_123",
        order_id: "order_123",
        expires_at: "2099-08-01T12:15:00.000Z",
      });
    }
    if (url.pathname.endsWith("/payment-result")) {
      return Response.json({
        session_id: "session_123",
        order_id: "order_123",
        status: "awaiting_result",
        transactions: [
          {
            line_items: [
              {
                txn_ref_id: "txn_line_123",
                token: "4622943123137789",
                dynamic_cvv: "999",
                expiry_month: "12",
                expiry_year: "30",
                products: [
                  { product_ref_id: "product_1", unit_price: "54.00" },
                ],
              },
            ],
          },
        ],
      });
    }
    if (url.pathname.endsWith("/report-status") && init?.method === "POST") {
      return Response.json({
        status: "confirmed",
        txn_ref_id: "txn_line_123",
        txn_status: "APPROVED",
        visa_confirmation: "SUCCESS",
      });
    }
    throw new Error(`Unexpected Prava request: ${url}`);
  };
  const service = createPravaCheckoutService({
    backendUrl: "https://sandbox.api.prava.space/",
    publishableKey: "pk_test_browser_safe",
    secretKey: "sk_test_server_only",
    publicBaseUrl: "https://tavra.example",
    checkoutMode: "hosted",
    fetch: fetchMock,
    async onStatus(event) {
      events.push(event);
    },
  });

  const link = await service.createCheckout(checkoutRequest);
  assert.match(link.url, /^https:\/\/tavra\.example\/pay\//);
  assert.equal(calls.length, 1);
  assert.equal(new Headers(calls[0]?.init?.headers).get("authorization"), "Bearer sk_test_server_only");
  const createBody = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
  assert.equal(createBody.user_email, "employee@example.com");
  assert.equal(createBody.total_amount, "154.00");
  assert.equal(createBody.integration_type, "full_checkout");
  assert.equal(
    createBody.callback_url,
    `https://tavra.example/pay/${link.checkoutId}?prava_return=1`,
  );
  assert.equal(createBody.user_country_code_iso2, undefined);
  const purchaseContext = createBody.purchase_context as Array<{
    product_details: Array<{ product_id: string }>;
  }>;
  assert.deepEqual(
    purchaseContext[0]?.product_details.map((product) => product.product_id),
    ["b-shirt-001", "b-trouser-001", "b-toiletry-001"],
  );

  const clientSession = service.getClientSession(link.checkoutId);
  assert.ok(clientSession);
  assert.equal(clientSession.checkoutMode, "hosted");
  assert.equal(clientSession.publishableKey, "pk_test_browser_safe");
  assert.equal(clientSession.sessionToken, "public_session_token");
  const browserPayload = JSON.stringify(clientSession);
  assert.doesNotMatch(browserPayload, /sk_test|network-token|dynamic_cvv|999/);

  const completed = await service.getStatus(link.checkoutId);
  assert.equal(completed?.status, "completed");
  assert.match(
    completed?.status === "completed" ? completed.merchantOrderId : "",
    /^SIM-[A-F0-9]{8}$/,
  );
  assert.deepEqual(await service.getStatus(link.checkoutId), completed);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.merchantOutcome, "simulated");
  assert.doesNotMatch(JSON.stringify(events), /4622943123137789|dynamic_cvv|999/);
  assert.equal(calls.length, 3);
  const reportBody = JSON.parse(String(calls[2]?.init?.body)) as Record<string, unknown>;
  assert.equal(reportBody.txn_ref_id, "txn_line_123");
  assert.equal(reportBody.txn_status, "APPROVED");
  assert.equal(reportBody.amount_paid, "154.00");
  assert.doesNotMatch(JSON.stringify(reportBody), /4622943123137789|dynamic_cvv|999/);
});

test("rejects a checkout when product prices do not match the authorized total", async () => {
  const service = createPravaCheckoutService({
    backendUrl: "https://sandbox.api.prava.space/",
    publishableKey: "pk_test_browser_safe",
    secretKey: "sk_test_server_only",
    publicBaseUrl: "https://tavra.example",
    async fetch() {
      throw new Error("Prava must not be called for invalid checkout data");
    },
  });

  await assert.rejects(
    () =>
      service.createCheckout({
        ...checkoutRequest,
        products: [{ description: "Wrong total", unitPrice: "1.00", quantity: 1 }],
      }),
    /product total must match/i,
  );
});

test("preselects the active default Prava card for a repeat approval", async () => {
  const calls: URL[] = [];
  let createBody: Record<string, unknown> | null = null;
  const service = createPravaCheckoutService({
    backendUrl: "https://sandbox.api.prava.space/",
    publishableKey: "pk_test_browser_safe",
    secretKey: "sk_test_server_only",
    publicBaseUrl: "https://tavra.example",
    preselectSavedCard: true,
    async fetch(input, init) {
      const url =
        input instanceof URL
          ? input
          : new URL(typeof input === "string" ? input : input.url);
      calls.push(url);
      if (url.pathname.endsWith("/v1/listCards")) {
        assert.equal(url.searchParams.get("customer_id"), "emp_demo_001");
        return Response.json({
          count: 2,
          cards: [
            { card_id: "card-secondary", is_default: false, status: "active" },
            { card_id: "card-default", is_default: true, status: "active" },
          ],
        });
      }
      if (url.pathname.endsWith("/v1/sessions") && init?.method === "POST") {
        createBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Response.json({
          session_id: "session_saved",
          session_token: "public_session_token",
          iframe_url: "https://checkout.sandbox.prava.space/embed/session_saved",
          order_id: "order_saved",
          expires_at: "2099-08-01T12:15:00.000Z",
        });
      }
      throw new Error(`Unexpected Prava request: ${url}`);
    },
  });

  await service.createCheckout(checkoutRequest);
  assert.deepEqual(calls.map((url) => url.pathname), [
    "/v1/listCards",
    "/v1/sessions",
  ]);
  assert.deepEqual((createBody as { card?: unknown } | null)?.card, {
    card_id: "card-default",
  });
});

test("keeps monitoring after the payment page loads and retries the chat notification", async () => {
  let paymentChecks = 0;
  let statusReports = 0;
  let notificationAttempts = 0;
  const notificationEvents: PravaStatusEvent[] = [];
  let resolveNotification!: (event: PravaStatusEvent) => void;
  const notification = new Promise<PravaStatusEvent>((resolve) => {
    resolveNotification = resolve;
  });
  const service = createPravaCheckoutService({
    backendUrl: "https://sandbox.api.prava.space/",
    publishableKey: "pk_test_browser_safe",
    secretKey: "sk_test_server_only",
    publicBaseUrl: "https://tavra.example",
    statusMonitorIntervalMs: 2,
    statusMonitorWindowMs: 100,
    async fetch(input, init) {
      const url =
        input instanceof URL
          ? input
          : new URL(typeof input === "string" ? input : input.url);
      if (url.pathname.endsWith("/v1/sessions") && init?.method === "POST") {
        return Response.json({
          session_id: "session_background",
          session_token: "public_session_token",
          iframe_url: "https://checkout.sandbox.prava.space/embed/session_background",
          order_id: "order_background",
          expires_at: "2099-08-01T12:15:00.000Z",
        });
      }
      if (url.pathname.endsWith("/payment-result")) {
        paymentChecks += 1;
        return Response.json({
          session_id: "session_background",
          order_id: "order_background",
          status: "AWAITING_RESULT",
          transactions: [
            {
              line_items: [
                {
                  txn_ref_id: "txn_line_background",
                  token: "4622943123137789",
                  dynamic_cvv: "999",
                  expiry_month: "12",
                  expiry_year: "30",
                },
              ],
            },
          ],
        });
      }
      if (url.pathname.endsWith("/report-status") && init?.method === "POST") {
        statusReports += 1;
        return Response.json({
          status: "confirmed",
          visa_confirmation: "SUCCESS",
        });
      }
      throw new Error(`Unexpected Prava request: ${url}`);
    },
    async onStatus(event) {
      notificationAttempts += 1;
      notificationEvents.push(structuredClone(event));
      if (notificationAttempts === 1) throw new Error("Temporary Linq failure");
      resolveNotification(event);
    },
  });

  const link = await service.createCheckout(checkoutRequest);
  assert.ok(service.getClientSession(link.checkoutId));
  const event = await Promise.race([
    notification,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("Background notification timed out")), 500),
    ),
  ]);

  assert.equal(paymentChecks, 1);
  assert.equal(statusReports, 1);
  assert.equal(notificationAttempts, 2);
  assert.deepEqual(notificationEvents[1], notificationEvents[0]);
  assert.equal(event.status, "completed");
  assert.equal(event.chatId, "chat-prava");
  assert.match(event.merchantOrderId ?? "", /^SIM-[A-F0-9]{8}$/);
  assert.equal(event.merchantOutcome, "simulated");
});

test("uses a ready credential across all Prava transaction line items", async () => {
  let statusReports = 0;
  const service = createPravaCheckoutService({
    backendUrl: "https://sandbox.api.prava.space/",
    publishableKey: "pk_test_browser_safe",
    secretKey: "sk_test_server_only",
    publicBaseUrl: "https://tavra.example",
    async fetch(input, init) {
      const url =
        input instanceof URL
          ? input
          : new URL(typeof input === "string" ? input : input.url);
      if (url.pathname.endsWith("/v1/sessions") && init?.method === "POST") {
        return Response.json({
          session_id: "session_multi_line",
          session_token: "public_session_token",
          iframe_url: "https://checkout.sandbox.prava.space/embed/session_multi_line",
          order_id: "order_multi_line",
          expires_at: "2099-08-01T12:15:00.000Z",
        });
      }
      if (url.pathname.endsWith("/payment-result")) {
        return Response.json({
          status: "awaiting_result",
          order_id: "order_multi_line",
          transactions: [
            { line_items: [{ token: null, dynamic_cvv: null }] },
            {
              line_items: [
                {
                  txn_ref_id: "txn_line_multi",
                  token: "4622943123137789",
                  dynamic_cvv: "999",
                  expiry_month: "12",
                  expiry_year: "30",
                },
              ],
            },
          ],
        });
      }
      if (url.pathname.endsWith("/report-status") && init?.method === "POST") {
        statusReports += 1;
        return Response.json({
          status: "confirmed",
          visa_confirmation: "SUCCESS",
        });
      }
      throw new Error(`Unexpected Prava request: ${url}`);
    },
  });

  const link = await service.createCheckout(checkoutRequest);
  const completed = await service.getStatus(link.checkoutId);
  assert.equal(completed?.status, "completed");
  assert.match(
    completed?.status === "completed" ? completed.merchantOrderId : "",
    /^SIM-[A-F0-9]{8}$/,
  );
  assert.equal(statusReports, 1);
});

test("blocks live mode unless a real merchant checkout adapter is configured", () => {
  assert.throws(
    () =>
      createPravaCheckoutService({
        backendUrl: "https://api.prava.space/",
        publishableKey: "pk_live_browser_safe",
        secretKey: "sk_live_server_only",
        publicBaseUrl: "https://tavra.example",
        mode: "live",
        fetch: async () => {
          throw new Error("Network must not be called during configuration");
        },
      }),
    /does not match merchant adapter mode/i,
  );
});

test("passes the bounded order and recovery context to the merchant adapter", async () => {
  let merchantInput: Parameters<MerchantCheckoutAdapter["checkout"]>[0] | null = null;
  const merchantCheckout: MerchantCheckoutAdapter = {
    mode: "sandbox_simulator",
    async checkout(input) {
      merchantInput = input;
      return {
        status: "approved",
        orderId: "SIM-BOUNDARY",
        authorizationCode: "SIMAUTHBOUNDARY",
        responseCode: "00",
        simulated: true,
      };
    },
  };
  const recovery = {
    caseId: "RCV-BOUNDARY",
    needBy: "8:00 AM",
    deliveryArea: "Boston",
    deliveryAddress: "1 Hotel Drive, Boston, MA, front desk",
    deliveryAddressSource: "message" as const,
    airline: "Delta",
    arrivalAirport: "BOS",
    baggageReference: "RF392942",
    noticeAttachmentIds: ["notice-1"],
  };
  const service = createPravaCheckoutService({
    backendUrl: "https://sandbox.api.prava.space/",
    publishableKey: "pk_test_browser_safe",
    secretKey: "sk_test_server_only",
    publicBaseUrl: "https://tavra.example",
    merchantCheckout,
    async fetch(input, init) {
      const url =
        input instanceof URL
          ? input
          : new URL(typeof input === "string" ? input : input.url);
      if (url.pathname.endsWith("/v1/sessions") && init?.method === "POST") {
        return Response.json({
          session_id: "session_boundary",
          session_token: "public_session_token",
          iframe_url: "https://checkout.sandbox.prava.space/embed/session_boundary",
          order_id: "prava_boundary",
          expires_at: "2099-08-01T12:15:00.000Z",
        });
      }
      if (url.pathname.endsWith("/payment-result")) {
        return Response.json({
          status: "awaiting_result",
          transactions: [{
            line_items: [{
              txn_ref_id: "txn_boundary",
              token: "4622943123137789",
              dynamic_cvv: "999",
              expiry_month: "12",
              expiry_year: "30",
            }],
          }],
        });
      }
      if (url.pathname.endsWith("/report-status") && init?.method === "POST") {
        return Response.json({ status: "confirmed" });
      }
      throw new Error(`Unexpected Prava request: ${url}`);
    },
  });

  const link = await service.createCheckout({ ...checkoutRequest, recovery });
  assert.deepEqual(await service.getStatus(link.checkoutId), {
    status: "completed",
    merchantOrderId: "SIM-BOUNDARY",
    merchantOutcome: "simulated",
  });
  const observed = merchantInput as unknown as {
    amount: string;
    currency: string;
    recovery: typeof recovery;
    credential: { token: string; dynamicCvv: string };
  };
  assert.equal(observed.amount, "154.00");
  assert.equal(observed.currency, "USD");
  assert.equal(observed.recovery.deliveryAddress, recovery.deliveryAddress);
  assert.equal(observed.credential.token, "4622943123137789");
  assert.equal(observed.credential.dynamicCvv, "999");
});

test("does not choose between multiple ready Prava credentials", async () => {
  let merchantCalls = 0;
  const events: PravaStatusEvent[] = [];
  const service = createPravaCheckoutService({
    backendUrl: "https://sandbox.api.prava.space/",
    publishableKey: "pk_test_browser_safe",
    secretKey: "sk_test_server_only",
    publicBaseUrl: "https://tavra.example",
    merchantCheckout: {
      mode: "sandbox_simulator",
      async checkout() {
        merchantCalls += 1;
        throw new Error("merchant must not be called");
      },
    },
    async onStatus(event) {
      events.push(event);
    },
    async fetch(input, init) {
      const url =
        input instanceof URL
          ? input
          : new URL(typeof input === "string" ? input : input.url);
      if (url.pathname.endsWith("/v1/sessions") && init?.method === "POST") {
        return Response.json({
          session_id: "session_multiple",
          session_token: "public_session_token",
          iframe_url: "https://checkout.sandbox.prava.space/embed/session_multiple",
          order_id: "order_multiple",
          expires_at: "2099-08-01T12:15:00.000Z",
        });
      }
      if (url.pathname.endsWith("/payment-result")) {
        const ready = (suffix: string) => ({
          txn_ref_id: `txn_${suffix}`,
          token: "4622943123137789",
          dynamic_cvv: "999",
          expiry_month: "12",
          expiry_year: "30",
        });
        return Response.json({
          session_id: "session_multiple",
          order_id: "order_multiple",
          status: "awaiting_result",
          transactions: [{ line_items: [ready("one"), ready("two")] }],
        });
      }
      throw new Error(`Unexpected Prava request: ${url}`);
    },
  });

  const link = await service.createCheckout(checkoutRequest);
  const status = await service.getStatus(link.checkoutId);
  assert.equal(status?.status, "reconciliation_required");
  assert.equal(merchantCalls, 0);
  assert.equal(events[0]?.status, "reconciliation_required");
  assert.equal(events[0]?.merchantOutcome, "not_attempted");
});

test("does not terminalize when Prava fails to acknowledge the merchant report", async () => {
  let merchantCalls = 0;
  let reportCalls = 0;
  const service = createPravaCheckoutService({
    backendUrl: "https://sandbox.api.prava.space/",
    publishableKey: "pk_test_browser_safe",
    secretKey: "sk_test_server_only",
    publicBaseUrl: "https://tavra.example",
    merchantCheckout: {
      mode: "sandbox_simulator",
      async checkout() {
        merchantCalls += 1;
        return {
          status: "approved",
          orderId: "SIM-ACK",
          authorizationCode: "SIMAUTHACK",
          responseCode: "00",
          simulated: true,
        };
      },
    },
    async fetch(input, init) {
      const url =
        input instanceof URL
          ? input
          : new URL(typeof input === "string" ? input : input.url);
      if (url.pathname.endsWith("/v1/sessions") && init?.method === "POST") {
        return Response.json({
          session_id: "session_ack",
          session_token: "public_session_token",
          iframe_url: "https://checkout.sandbox.prava.space/embed/session_ack",
          order_id: "order_ack",
          expires_at: "2099-08-01T12:15:00.000Z",
        });
      }
      if (url.pathname.endsWith("/payment-result")) {
        return Response.json({
          session_id: "session_ack",
          order_id: "order_ack",
          status: "awaiting_result",
          transactions: [{
            line_items: [{
              txn_ref_id: "txn_ack",
              token: "4622943123137789",
              dynamic_cvv: "999",
              expiry_month: "12",
              expiry_year: "30",
            }],
          }],
        });
      }
      if (url.pathname.endsWith("/report-status") && init?.method === "POST") {
        reportCalls += 1;
        return Response.json({ status: "failed" });
      }
      throw new Error(`Unexpected Prava request: ${url}`);
    },
  });

  const link = await service.createCheckout(checkoutRequest);
  await assert.rejects(() => service.getStatus(link.checkoutId), /did not acknowledge/i);
  await assert.rejects(() => service.getStatus(link.checkoutId), /did not acknowledge/i);
  assert.equal(merchantCalls, 1);
  assert.equal(reportCalls, 2);
});

test("rejects an adapter whose mode does not match the Prava environment", () => {
  const liveAdapter: MerchantCheckoutAdapter = {
    mode: "live",
    async checkout() {
      throw new Error("not used");
    },
  };
  assert.throws(
    () =>
      createPravaCheckoutService({
        backendUrl: "https://sandbox.api.prava.space/",
        publishableKey: "pk_test_browser_safe",
        secretKey: "sk_test_server_only",
        publicBaseUrl: "https://tavra.example",
        mode: "sandbox",
        merchantCheckout: liveAdapter,
      }),
    /does not match merchant adapter mode live/i,
  );
});

test("a concurrent cancellation blocks a not-yet-started merchant checkout", async () => {
  let resolvePayment!: (response: Response) => void;
  const paymentResponse = new Promise<Response>((resolve) => {
    resolvePayment = resolve;
  });
  let merchantCalls = 0;
  let revokeCalls = 0;
  const service = createPravaCheckoutService({
    backendUrl: "https://sandbox.api.prava.space/",
    publishableKey: "pk_test_browser_safe",
    secretKey: "sk_test_server_only",
    publicBaseUrl: "https://tavra.example",
    merchantCheckout: {
      mode: "sandbox_simulator",
      async checkout() {
        merchantCalls += 1;
        throw new Error("merchant must not be called after cancellation starts");
      },
    },
    async fetch(input, init) {
      const url =
        input instanceof URL
          ? input
          : new URL(typeof input === "string" ? input : input.url);
      if (url.pathname.endsWith("/v1/sessions") && init?.method === "POST") {
        return Response.json({
          session_id: "session_cancel",
          session_token: "public_session_token",
          iframe_url: "https://checkout.sandbox.prava.space/embed/session_cancel",
          order_id: "order_cancel",
          expires_at: "2099-08-01T12:15:00.000Z",
        });
      }
      if (url.pathname.endsWith("/payment-result")) return paymentResponse;
      if (url.pathname.endsWith("/revoke") && init?.method === "POST") {
        revokeCalls += 1;
        return Response.json({ revoked: true });
      }
      throw new Error(`Unexpected Prava request: ${url}`);
    },
  });

  const link = await service.createCheckout(checkoutRequest);
  const statusPromise = service.getStatus(link.checkoutId);
  const revokePromise = service.revoke(link.checkoutId);
  resolvePayment(Response.json({
    session_id: "session_cancel",
    order_id: "order_cancel",
    status: "awaiting_result",
    transactions: [{
      line_items: [{
        txn_ref_id: "txn_cancel",
        token: "4622943123137789",
        dynamic_cvv: "999",
        expiry_month: "12",
        expiry_year: "30",
      }],
    }],
  }));

  assert.deepEqual(await statusPromise, { status: "pending" });
  assert.equal(await revokePromise, true);
  assert.equal(merchantCalls, 0);
  assert.equal(revokeCalls, 1);
  assert.equal(service.getClientSession(link.checkoutId), null);
});

test("requires reconciliation when Prava is completed without a local merchant outcome", async () => {
  let paymentChecks = 0;
  const service = createPravaCheckoutService({
    backendUrl: "https://sandbox.api.prava.space/",
    publishableKey: "pk_test_browser_safe",
    secretKey: "sk_test_server_only",
    publicBaseUrl: "https://tavra.example",
    async fetch(input, init) {
      const url =
        input instanceof URL
          ? input
          : new URL(typeof input === "string" ? input : input.url);
      if (url.pathname.endsWith("/v1/sessions") && init?.method === "POST") {
        return Response.json({
          session_id: "session_terminal",
          session_token: "public_session_token",
          iframe_url: "https://checkout.sandbox.prava.space/embed/session_terminal",
          order_id: "order_terminal",
          expires_at: "2099-08-01T12:15:00.000Z",
        });
      }
      if (url.pathname.endsWith("/payment-result")) {
        paymentChecks += 1;
        return Response.json({
          status: "completed",
          order_id: "order_terminal",
          transactions: [
            { line_items: [{ token: null, dynamic_cvv: null }] },
          ],
        });
      }
      throw new Error(`Unexpected Prava request: ${url}`);
    },
  });

  const link = await service.createCheckout(checkoutRequest);
  assert.deepEqual(await service.getStatus(link.checkoutId), {
    status: "reconciliation_required",
    message:
      "Prava completed the approval, but Tavra has no verified merchant outcome for this process. No order is being claimed; support must reconcile the session.",
  });
  assert.deepEqual(await service.getStatus(link.checkoutId), {
    status: "reconciliation_required",
    message:
      "Prava completed the approval, but Tavra has no verified merchant outcome for this process. No order is being claimed; support must reconcile the session.",
  });
  assert.equal(paymentChecks, 1);
});
