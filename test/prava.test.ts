import assert from "node:assert/strict";
import test from "node:test";

import {
  createPravaCheckoutService,
  MerchantCheckoutPreSubmitError,
  MerchantCheckoutUncertainError,
  type MerchantCheckoutAdapter,
  type MerchantMetadata,
  type PravaStatusEvent,
} from "../src/prava.js";

// Shape-only fixtures. These are generated placeholders, never Prava test cards.
const MOCK_ONE_TIME_TOKEN = "9".repeat(16);
const MOCK_DYNAMIC_CVV = "7".repeat(3);

const simulatorMerchant: MerchantMetadata = {
  name: "Tavra Sandbox Merchant Simulator",
  url: "https://merchant-simulator.example.com/",
  countryCodeIso2: "US",
  categoryCode: "5311",
  category: "Department Stores",
};

const realSandboxMerchant: MerchantMetadata = {
  name: "Example Merchant",
  url: "https://merchant.example.com/",
  countryCodeIso2: "AE",
  categoryCode: "5311",
  category: "Department Stores",
};

function simulatorEvidence(responseCode: string, responseText: string) {
  return {
    merchantName: simulatorMerchant.name,
    merchantUrl: simulatorMerchant.url,
    attemptedAt: "2026-08-02T12:00:00.000Z",
    responseText,
    responseCode,
    reference: null,
  };
}

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
                token: MOCK_ONE_TIME_TOKEN,
                dynamic_cvv: MOCK_DYNAMIC_CVV,
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
    merchant_details: {
      name: string;
      url: string;
      country_code_iso2: string;
      category_code: string;
    };
    product_details: Array<{ product_id: string }>;
  }>;
  assert.deepEqual(purchaseContext[0]?.merchant_details, {
    name: simulatorMerchant.name,
    url: simulatorMerchant.url,
    country_code_iso2: simulatorMerchant.countryCodeIso2,
    category_code: simulatorMerchant.categoryCode,
    category: simulatorMerchant.category,
  });
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
  assert.doesNotMatch(browserPayload, /sk_test|network-token|dynamic_cvv/);
  assert.equal(browserPayload.includes(MOCK_DYNAMIC_CVV), false);

  const completed = await service.getStatus(link.checkoutId);
  assert.equal(completed?.status, "completed");
  assert.match(
    completed?.status === "completed" ? completed.merchantOrderId : "",
    /^SIM-[A-F0-9]{8}$/,
  );
  assert.deepEqual(await service.getStatus(link.checkoutId), completed);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.merchantOutcome, "simulated");
  assert.doesNotMatch(JSON.stringify(events), /dynamic_cvv/);
  assert.equal(JSON.stringify(events).includes(MOCK_ONE_TIME_TOKEN), false);
  assert.equal(JSON.stringify(events).includes(MOCK_DYNAMIC_CVV), false);
  assert.equal(calls.length, 3);
  const reportBody = JSON.parse(String(calls[2]?.init?.body)) as Record<string, unknown>;
  assert.equal(reportBody.txn_ref_id, "txn_line_123");
  assert.equal(reportBody.txn_status, "APPROVED");
  assert.equal(reportBody.amount_paid, "154.00");
  assert.doesNotMatch(JSON.stringify(reportBody), /dynamic_cvv/);
  assert.equal(JSON.stringify(reportBody).includes(MOCK_ONE_TIME_TOKEN), false);
  assert.equal(JSON.stringify(reportBody).includes(MOCK_DYNAMIC_CVV), false);
});

test("validates an end-to-end sandbox merchant attempt after the expected test-card decline", async () => {
  let merchantCalls = 0;
  let reportCalls = 0;
  let createBody: Record<string, unknown> | null = null;
  let reportBody: Record<string, unknown> | null = null;
  const events: PravaStatusEvent[] = [];
  const adapter: MerchantCheckoutAdapter = {
    mode: "sandbox_merchant",
    merchant: realSandboxMerchant,
    async checkout(input) {
      merchantCalls += 1;
      assert.match(input.idempotencyKey, /:txn_sandbox_gate$/);
      assert.equal(input.credential.token, MOCK_ONE_TIME_TOKEN);
      assert.equal(input.credential.dynamicCvv, MOCK_DYNAMIC_CVV);
      return {
        status: "declined",
        orderId: null,
        authorizationCode: null,
        responseCode: "51",
        simulated: false,
        expectedSandboxDecline: true,
        evidence: {
          merchantName: realSandboxMerchant.name,
          merchantUrl: realSandboxMerchant.url,
          attemptedAt: "2026-08-02T12:34:56.000Z",
          responseText: "Payment declined: insufficient funds on sandbox test card",
          responseCode: "51",
          reference: "merchant-attempt-42",
        },
      };
    },
  };
  const service = createPravaCheckoutService({
    backendUrl: "https://sandbox.api.prava.space/",
    publishableKey: "pk_test_browser_safe",
    secretKey: "sk_test_server_only",
    publicBaseUrl: "https://tavra.example",
    merchantCheckout: adapter,
    async onStatus(event) {
      events.push(structuredClone(event));
    },
    async fetch(input, init) {
      const url =
        input instanceof URL
          ? input
          : new URL(typeof input === "string" ? input : input.url);
      if (url.pathname.endsWith("/v1/sessions") && init?.method === "POST") {
        createBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Response.json({
          session_id: "session_sandbox_gate",
          session_token: "public_session_token",
          iframe_url: "https://checkout.sandbox.prava.space/embed/session_sandbox_gate",
          order_id: "order_sandbox_gate",
          expires_at: "2099-08-01T12:15:00.000Z",
        });
      }
      if (url.pathname.endsWith("/payment-result")) {
        return Response.json({
          session_id: "session_sandbox_gate",
          order_id: "order_sandbox_gate",
          status: "awaiting_result",
          transactions: [{
            line_items: [{
              txn_ref_id: "txn_sandbox_gate",
              token: MOCK_ONE_TIME_TOKEN,
              dynamic_cvv: MOCK_DYNAMIC_CVV,
              expiry_month: "12",
              expiry_year: "30",
              products: [{
                product_ref_id: "product_1",
                unit_price: "154.00",
              }],
            }],
          }],
        });
      }
      if (url.pathname.endsWith("/report-status") && init?.method === "POST") {
        reportCalls += 1;
        reportBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Response.json({ status: "confirmed", visa_confirmation: "SUCCESS" });
      }
      throw new Error(`Unexpected Prava request: ${url}`);
    },
  });

  const link = await service.createCheckout(checkoutRequest);
  const [first, concurrent] = await Promise.all([
    service.getStatus(link.checkoutId),
    service.getStatus(link.checkoutId),
  ]);
  assert.deepEqual(first, concurrent);
  assert.equal(first?.status, "sandbox_validated");
  if (first?.status !== "sandbox_validated") {
    throw new Error("Expected a validated sandbox merchant attempt");
  }
  assert.deepEqual(first.merchantAttempt, {
    merchantName: realSandboxMerchant.name,
    merchantUrl: realSandboxMerchant.url,
    attemptedAt: "2026-08-02T12:34:56.000Z",
    responseText: "Payment declined: insufficient funds on sandbox test card",
    responseCode: "51",
    reference: "merchant-attempt-42",
  });
  assert.deepEqual(await service.getStatus(link.checkoutId), first);
  assert.equal(merchantCalls, 1);
  assert.equal(reportCalls, 1);

  const purchaseContext = (createBody as {
    purchase_context: Array<{ merchant_details: Record<string, unknown> }>;
  } | null)?.purchase_context;
  assert.deepEqual(purchaseContext?.[0]?.merchant_details, {
    name: realSandboxMerchant.name,
    url: realSandboxMerchant.url,
    country_code_iso2: realSandboxMerchant.countryCodeIso2,
    category_code: realSandboxMerchant.categoryCode,
    category: realSandboxMerchant.category,
  });
  assert.deepEqual(reportBody, {
    txn_ref_id: "txn_sandbox_gate",
    txn_status: "DECLINED",
    txn_type: "PURCHASE",
    response_code: "51",
    amount_paid: "0.00",
    product_statuses: [{
      product_ref_id: "product_1",
      status: "FAILED",
      amount_paid: "0.00",
    }],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.status, "sandbox_validated");
  assert.equal(events[0]?.merchantOrderId, null);
  assert.equal(events[0]?.merchantOutcome, "sandbox_merchant");
  assert.equal(events[0]?.merchantAttempt?.reference, "merchant-attempt-42");
  assert.doesNotMatch(
    JSON.stringify({ first, events, reportBody }),
    /dynamic_cvv/,
  );
});

test("treats a non-expected end-merchant decline as a failed checkout", async () => {
  let merchantCalls = 0;
  let reportCalls = 0;
  const service = createPravaCheckoutService({
    backendUrl: "https://sandbox.api.prava.space/",
    publishableKey: "pk_test_browser_safe",
    secretKey: "sk_test_server_only",
    publicBaseUrl: "https://tavra.example",
    merchantCheckout: {
      mode: "sandbox_merchant",
      merchant: realSandboxMerchant,
      async checkout() {
        merchantCalls += 1;
        return {
          status: "declined",
          orderId: null,
          authorizationCode: null,
          responseCode: "05",
          simulated: false,
          expectedSandboxDecline: false,
          evidence: {
            merchantName: realSandboxMerchant.name,
            merchantUrl: realSandboxMerchant.url,
            attemptedAt: "2026-08-02T12:34:56.000Z",
            responseText: "Payment declined: do not honor",
            responseCode: "05",
            reference: "merchant-attempt-43",
          },
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
          session_id: "session_generic_decline",
          session_token: "public_session_token",
          iframe_url: "https://checkout.sandbox.prava.space/embed/session_generic_decline",
          order_id: "order_generic_decline",
          expires_at: "2099-08-01T12:15:00.000Z",
        });
      }
      if (url.pathname.endsWith("/payment-result")) {
        return Response.json({
          status: "awaiting_result",
          transactions: [{ line_items: [{
            txn_ref_id: "txn_generic_decline",
            token: MOCK_ONE_TIME_TOKEN,
            dynamic_cvv: MOCK_DYNAMIC_CVV,
            expiry_month: "12",
            expiry_year: "30",
          }] }],
        });
      }
      if (url.pathname.endsWith("/report-status") && init?.method === "POST") {
        reportCalls += 1;
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        assert.equal(body.txn_status, "DECLINED");
        assert.equal(body.amount_paid, "0.00");
        return Response.json({ status: "confirmed" });
      }
      throw new Error(`Unexpected Prava request: ${url}`);
    },
  });

  const link = await service.createCheckout(checkoutRequest);
  const status = await service.getStatus(link.checkoutId);
  assert.equal(status?.status, "failed");
  assert.deepEqual(await service.getStatus(link.checkoutId), status);
  assert.equal(merchantCalls, 1);
  assert.equal(reportCalls, 1);
});

test("requires reconciliation instead of retrying an uncertain merchant submission", async () => {
  let merchantCalls = 0;
  let reportCalls = 0;
  const events: PravaStatusEvent[] = [];
  const service = createPravaCheckoutService({
    backendUrl: "https://sandbox.api.prava.space/",
    publishableKey: "pk_test_browser_safe",
    secretKey: "sk_test_server_only",
    publicBaseUrl: "https://tavra.example",
    merchantCheckout: {
      mode: "sandbox_merchant",
      merchant: realSandboxMerchant,
      async checkout() {
        merchantCalls += 1;
        throw new MerchantCheckoutUncertainError("Timed out after submit");
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
          session_id: "session_uncertain",
          session_token: "public_session_token",
          iframe_url: "https://checkout.sandbox.prava.space/embed/session_uncertain",
          order_id: "order_uncertain",
          expires_at: "2099-08-01T12:15:00.000Z",
        });
      }
      if (url.pathname.endsWith("/payment-result")) {
        return Response.json({
          status: "awaiting_result",
          transactions: [{ line_items: [{
            txn_ref_id: "txn_uncertain",
            token: MOCK_ONE_TIME_TOKEN,
            dynamic_cvv: MOCK_DYNAMIC_CVV,
            expiry_month: "12",
            expiry_year: "30",
          }] }],
        });
      }
      if (url.pathname.endsWith("/report-status")) reportCalls += 1;
      throw new Error(`Unexpected Prava request: ${url}`);
    },
  });

  const link = await service.createCheckout(checkoutRequest);
  const status = await service.getStatus(link.checkoutId);
  assert.equal(status?.status, "reconciliation_required");
  assert.match(
    status?.status === "reconciliation_required" ? status.message : "",
    /will not retry/i,
  );
  assert.deepEqual(await service.getStatus(link.checkoutId), status);
  assert.equal(merchantCalls, 1);
  assert.equal(reportCalls, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.status, "reconciliation_required");
});

test("terminalizes a proven pre-submit failure without reporting or retrying it", async () => {
  let merchantCalls = 0;
  let reportCalls = 0;
  const events: PravaStatusEvent[] = [];
  const service = createPravaCheckoutService({
    backendUrl: "https://sandbox.api.prava.space/",
    publishableKey: "pk_test_browser_safe",
    secretKey: "sk_test_server_only",
    publicBaseUrl: "https://tavra.example",
    merchantCheckout: {
      mode: "sandbox_merchant",
      merchant: realSandboxMerchant,
      async checkout() {
        merchantCalls += 1;
        throw new MerchantCheckoutPreSubmitError("Checkout form was unavailable");
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
          session_id: "session_pre_submit",
          session_token: "public_session_token",
          iframe_url: "https://checkout.sandbox.prava.space/embed/session_pre_submit",
          order_id: "order_pre_submit",
          expires_at: "2099-08-01T12:15:00.000Z",
        });
      }
      if (url.pathname.endsWith("/payment-result")) {
        return Response.json({
          status: "awaiting_result",
          transactions: [{ line_items: [{
            txn_ref_id: "txn_pre_submit",
            token: MOCK_ONE_TIME_TOKEN,
            dynamic_cvv: MOCK_DYNAMIC_CVV,
            expiry_month: "12",
            expiry_year: "30",
          }] }],
        });
      }
      if (url.pathname.endsWith("/report-status")) reportCalls += 1;
      throw new Error(`Unexpected Prava request: ${url}`);
    },
  });

  const link = await service.createCheckout(checkoutRequest);
  const first = await service.getStatus(link.checkoutId);
  assert.equal(first?.status, "failed");
  assert.match(first?.status === "failed" ? first.message : "", /will not retry/i);
  assert.deepEqual(await service.getStatus(link.checkoutId), first);
  assert.equal(merchantCalls, 1);
  assert.equal(reportCalls, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.status, "failed");
  assert.equal(events[0]?.merchantOutcome, "not_attempted");
  assert.equal(events[0]?.merchantAttempt, null);
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

test("rejects reserved or made-up employee email domains before contacting Prava", async () => {
  let fetchCalls = 0;
  const service = createPravaCheckoutService({
    backendUrl: "https://sandbox.api.prava.space/",
    publishableKey: "pk_test_browser_safe",
    secretKey: "sk_test_server_only",
    publicBaseUrl: "https://tavra.example",
    async fetch() {
      fetchCalls += 1;
      throw new Error("Prava must not be contacted");
    },
  });

  for (const email of [
    "traveler@company.test",
    "traveler@company.local",
    "traveler@company.notarealtld",
  ]) {
    await assert.rejects(
      () => service.createCheckout({ ...checkoutRequest, employeeEmail: email }),
      /valid employee email/i,
    );
  }
  assert.equal(fetchCalls, 0);
});

test("requires a public bare HTTPS merchant origin", () => {
  const adapter = (url: string): MerchantCheckoutAdapter => ({
    mode: "sandbox_merchant",
    merchant: { ...realSandboxMerchant, url },
    async checkout() {
      throw new Error("not used");
    },
  });
  for (const url of [
    "https://merchant.example.com/checkout",
    "https://merchant.example.com/?source=tavra",
    "https://merchant.example/",
    "http://merchant.example.com/",
  ]) {
    assert.throws(
      () => createPravaCheckoutService({
        backendUrl: "https://sandbox.api.prava.space/",
        publishableKey: "pk_test_browser_safe",
        secretKey: "sk_test_server_only",
        publicBaseUrl: "https://tavra.example",
        merchantCheckout: adapter(url),
      }),
      /merchant checkout url/i,
    );
  }
});

test("preserves Prava's specific API error code and message", async () => {
  const service = createPravaCheckoutService({
    backendUrl: "https://sandbox.api.prava.space/",
    publishableKey: "pk_test_browser_safe",
    secretKey: "sk_test_server_only",
    publicBaseUrl: "https://tavra.example",
    async fetch() {
      return Response.json(
        { error: { code: "SESSION_POLICY_DENIED", message: "Policy denied purchase" } },
        { status: 400 },
      );
    },
  });
  await assert.rejects(
    () => service.createCheckout(checkoutRequest),
    /SESSION_POLICY_DENIED: Policy denied purchase/,
  );
});

test("preserves a terminal Prava payment failure in public status and notification", async () => {
  const events: PravaStatusEvent[] = [];
  const service = createPravaCheckoutService({
    backendUrl: "https://sandbox.api.prava.space/",
    publishableKey: "pk_test_browser_safe",
    secretKey: "sk_test_server_only",
    publicBaseUrl: "https://tavra.example",
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
          session_id: "session_failed_detail",
          session_token: "public_session_token",
          iframe_url: "https://checkout.sandbox.prava.space/embed/session_failed_detail",
          order_id: "order_failed_detail",
          expires_at: "2099-08-01T12:15:00.000Z",
        });
      }
      if (url.pathname.endsWith("/payment-result")) {
        return Response.json({
          session_id: "session_failed_detail",
          order_id: "order_failed_detail",
          status: "failed",
          error: {
            code: "PASSKEY_REG_FAILED",
            message: "Passkey registration failed for this browser",
          },
        });
      }
      throw new Error(`Unexpected Prava request: ${url}`);
    },
  });

  const link = await service.createCheckout(checkoutRequest);
  const status = await service.getStatus(link.checkoutId);
  assert.deepEqual(status, {
    status: "failed",
    code: "PASSKEY_REG_FAILED",
    message: "Passkey registration failed for this browser Nothing was ordered.",
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.failureCode, "PASSKEY_REG_FAILED");
  assert.equal(
    events[0]?.failureMessage,
    "Passkey registration failed for this browser Nothing was ordered.",
  );
});

test("keeps safe merchant provenance for the adapter and UI but not Prava product_details", async () => {
  let createBody: Record<string, unknown> | null = null;
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
        createBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Response.json({
          session_id: "session_provenance",
          session_token: "public_session_token",
          iframe_url: "https://checkout.sandbox.prava.space/embed/session_provenance",
          order_id: "order_provenance",
          expires_at: "2099-08-01T12:15:00.000Z",
        });
      }
      throw new Error(`Unexpected Prava request: ${url}`);
    },
  });
  const product = {
    productRef: "gid://shopify/ProductVariant/46624128270499",
    description: "Travel toiletries",
    unitPrice: "154.00",
    quantity: 1,
    imageUrl: "https://cdn.example/product.jpg",
    merchantName: simulatorMerchant.name,
    merchantUrl: simulatorMerchant.url,
    merchantVariantId: "gid://shopify/ProductVariant/46624128270499",
    checkoutUrl: "https://merchant-simulator.example.com/cart/variant:1",
  };

  const link = await service.createCheckout({
    ...checkoutRequest,
    products: [product],
  });
  assert.deepEqual(service.getClientSession(link.checkoutId)?.order.products, [product]);
  const context = (createBody as {
    purchase_context: Array<{ product_details: Array<Record<string, unknown>> }>;
  } | null)?.purchase_context;
  assert.deepEqual(context?.[0]?.product_details, [{
    product_id: product.productRef,
    description: product.description,
    unit_price: product.unitPrice,
    quantity: product.quantity,
  }]);
  assert.doesNotMatch(
    JSON.stringify(context?.[0]?.product_details),
    /imageUrl|merchantName|merchantUrl|merchantVariantId|checkoutUrl|cdn\.example|\/cart\//,
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

test("keeps monitoring after the payment page loads and retries the chat notification on the next check", async () => {
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
                  token: MOCK_ONE_TIME_TOKEN,
                  dynamic_cvv: MOCK_DYNAMIC_CVV,
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
  assert.equal((await service.getStatus(link.checkoutId))?.status, "completed");
  assert.equal((await service.getStatus(link.checkoutId))?.status, "completed");
  const event = await notification;

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
                  token: MOCK_ONE_TIME_TOKEN,
                  dynamic_cvv: MOCK_DYNAMIC_CVV,
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
    merchant: simulatorMerchant,
    async checkout(input) {
      merchantInput = input;
      return {
        status: "approved",
        orderId: "SIM-BOUNDARY",
        authorizationCode: "SIMAUTHBOUNDARY",
        responseCode: "00",
        simulated: true,
        expectedSandboxDecline: false,
        evidence: simulatorEvidence("00", "Simulator approved"),
      };
    },
  };
  const recovery = {
    caseId: "RCV-BOUNDARY",
    passengerName: "Demo Traveler",
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
              token: MOCK_ONE_TIME_TOKEN,
              dynamic_cvv: MOCK_DYNAMIC_CVV,
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
    buyer: { email: string; phone: string; firstName?: string; lastName?: string };
    credential: { token: string; dynamicCvv: string };
  };
  assert.equal(observed.amount, "154.00");
  assert.equal(observed.currency, "USD");
  assert.equal(observed.recovery.deliveryAddress, recovery.deliveryAddress);
  assert.deepEqual(observed.buyer, {
    email: checkoutRequest.employeeEmail,
    phone: checkoutRequest.employeePhone,
    firstName: "Demo",
    lastName: "Traveler",
  });
  assert.equal(observed.credential.token, MOCK_ONE_TIME_TOKEN);
  assert.equal(observed.credential.dynamicCvv, MOCK_DYNAMIC_CVV);
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
      merchant: simulatorMerchant,
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
          token: MOCK_ONE_TIME_TOKEN,
          dynamic_cvv: MOCK_DYNAMIC_CVV,
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

test("does not terminalize or tight-poll when Prava fails to acknowledge the merchant report", async () => {
  let merchantCalls = 0;
  let reportCalls = 0;
  const service = createPravaCheckoutService({
    backendUrl: "https://sandbox.api.prava.space/",
    publishableKey: "pk_test_browser_safe",
    secretKey: "sk_test_server_only",
    publicBaseUrl: "https://tavra.example",
    merchantCheckout: {
      mode: "sandbox_simulator",
      merchant: simulatorMerchant,
      async checkout() {
        merchantCalls += 1;
        return {
          status: "approved",
          orderId: "SIM-ACK",
          authorizationCode: "SIMAUTHACK",
          responseCode: "00",
          simulated: true,
          expectedSandboxDecline: false,
          evidence: simulatorEvidence("00", "Simulator approved"),
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
              token: MOCK_ONE_TIME_TOKEN,
              dynamic_cvv: MOCK_DYNAMIC_CVV,
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
  assert.equal((await service.getStatus(link.checkoutId))?.status, "awaiting_result");
  assert.equal(merchantCalls, 1);
  assert.equal(reportCalls, 1);
});

test("rejects an adapter whose mode does not match the Prava environment", () => {
  const liveAdapter: MerchantCheckoutAdapter = {
    mode: "live",
    merchant: {
      name: "Live Merchant",
      url: "https://live-merchant.example.com/",
      countryCodeIso2: "US",
      categoryCode: "5311",
      category: "Department Stores",
    },
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
      merchant: simulatorMerchant,
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
        assert.equal(init.body, undefined);
        assert.equal(new Headers(init.headers).get("content-type"), null);
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
        token: MOCK_ONE_TIME_TOKEN,
        dynamic_cvv: MOCK_DYNAMIC_CVV,
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
