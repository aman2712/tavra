import assert from "node:assert/strict";
import test from "node:test";

import {
  MEDDU_MCP_URL,
  MEDDU_MERCHANT,
  MEDDU_MERCHANT_CONFIG,
  SHOPIFY_PUBLIC_AGENT_PROFILE,
  classifyShopifyPaymentOutcome,
  createMedduUcpClient,
  createPlaywrightShopifyBrowserExecutor,
  parseMedduSearchResponse,
  prepareCatalogCheckout,
  validateMedduCheckoutUrl,
  type MedduOffer,
  type MerchantBuyer,
  type MerchantShippingAddress,
  type PreparedMerchantCheckout,
  type SandboxMerchantPaymentRequest,
} from "../src/sandbox-merchant.js";

// Generated shape-only placeholders, never Prava sandbox credentials.
const MOCK_ONE_TIME_TOKEN = "8".repeat(16);
const MOCK_DYNAMIC_CVV = "4".repeat(3);

const fixedNow = () => new Date("2026-08-02T12:00:00.000Z");
const imageUrl =
  "https://cdn.shopify.com/s/files/1/0697/4213/3411/files/Sensodyne_Deep_Clean_Gel_Toothpaste_-_75ml_Toothpaste_1.jpg?v=1774107076";
const checkoutUrl =
  "https://edqvrb-i5.myshopify.com/cart/46624128270499:1";

function product(input?: {
  variantId?: string;
  price?: number;
  available?: boolean;
  image?: string;
  checkout?: string;
}) {
  return {
    id: "gid://shopify/Product/123",
    title: "Sensodyne Deep Clean Gel Toothpaste - 75ml",
    description: "Travel-friendly toothpaste",
    currency: "AED",
    image_url: input?.image ?? imageUrl,
    variants: [
      {
        id:
          input?.variantId ??
          "gid://shopify/ProductVariant/46624128270499",
        title: "Default Title",
        price: input?.price ?? 4781,
        available: input?.available ?? true,
        checkout_url: input?.checkout ?? checkoutUrl,
      },
    ],
  };
}

function searchResponse(...products: unknown[]): unknown {
  return {
    jsonrpc: "2.0",
    id: "tavra-search_catalog",
    result: {
      structuredContent: { products },
      content: [{ type: "text", text: JSON.stringify({ products }) }],
    },
  };
}

function offer(): MedduOffer {
  const selected = parseMedduSearchResponse(searchResponse(product()), {
    retrievedAt: fixedNow().toISOString(),
  })[0];
  assert.ok(selected);
  return selected;
}

const buyer: MerchantBuyer = {
  email: "traveler@example.com",
  firstName: "Demo",
  lastName: "Traveler",
  phone: "+971501234567",
};

const shippingAddress: MerchantShippingAddress = {
  firstName: "Demo",
  lastName: "Traveler",
  streetAddress: "MBZUAI, Masdar City",
  extendedAddress: "Front desk",
  addressLocality: "Abu Dhabi",
  addressRegion: "Abu Dhabi",
  addressCountry: "AE",
  phone: "+971501234567",
};

test("uses one immutable reviewed Meddu merchant configuration", () => {
  assert.deepEqual(MEDDU_MERCHANT_CONFIG, {
    name: "Meddu",
    domain: "meddu.com",
    origin: "https://meddu.com/",
    country: "AE",
    currency: "AED",
    ucpEndpoint: "https://meddu.com/api/ucp/mcp",
    checkoutHosts: ["meddu.com", "www.meddu.com", "edqvrb-i5.myshopify.com"],
    imageHosts: ["cdn.shopify.com", "meddu.com", "www.meddu.com"],
    maxTotalMinor: 25_000n,
    fulfillmentRef: "meddu-fulfillment",
  });
  assert.equal(Object.isFrozen(MEDDU_MERCHANT_CONFIG), true);
  assert.equal(Object.isFrozen(MEDDU_MERCHANT_CONFIG.checkoutHosts), true);
  assert.equal(Object.isFrozen(MEDDU_MERCHANT_CONFIG.imageHosts), true);
});

test("parses available merchant UCP variants with exact provenance", () => {
  const offers = parseMedduSearchResponse(searchResponse(product()), {
    endpoint: MEDDU_MCP_URL,
    retrievedAt: "2026-08-02T12:00:00.000Z",
  });

  assert.equal(offers.length, 1);
  assert.deepEqual(offers[0], {
    merchant: MEDDU_MERCHANT,
    productId: "gid://shopify/Product/123",
    variantId: "gid://shopify/ProductVariant/46624128270499",
    title: "Sensodyne Deep Clean Gel Toothpaste - 75ml",
    variantTitle: "Default Title",
    description: "Travel-friendly toothpaste",
    available: true,
    imageUrl,
    checkoutUrl,
    price: { amount: "47.81", currency: "AED", minorAmount: "4781" },
    provenance: {
      source: "merchant_ucp",
      merchantDomain: "meddu.com",
      endpoint: MEDDU_MCP_URL,
      retrievedAt: "2026-08-02T12:00:00.000Z",
    },
  });
});

test("parses MCP content text when structured content is absent", () => {
  const response = {
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [{ type: "text", text: JSON.stringify({ products: [product()] }) }],
    },
  };
  assert.equal(parseMedduSearchResponse(response).length, 1);
});

test("rejects unavailable, image-less, untrusted, and over-cap offers", () => {
  const products = [
    product({ variantId: "variant-unavailable", available: false }),
    product({ variantId: "variant-no-image", image: "http://images.example/item.jpg" }),
    product({
      variantId: "variant-untrusted-image",
      image: "https://images.example.com/item.jpg",
    }),
    product({
      variantId: "variant-wrong-checkout",
      checkout: "https://attacker.example/cart/1:1",
    }),
    product({ variantId: "variant-over-cap", price: 25_001 }),
  ];
  assert.deepEqual(parseMedduSearchResponse(searchResponse(...products)), []);
});

test("selects the cheapest qualified offer deterministically", () => {
  const offers = parseMedduSearchResponse(
    searchResponse(
      product({
        variantId: "gid://shopify/ProductVariant/z",
        price: 9000,
        checkout: "https://edqvrb-i5.myshopify.com/cart/2:1",
      }),
      product({
        variantId: "gid://shopify/ProductVariant/a",
        price: 7000,
        checkout: "https://edqvrb-i5.myshopify.com/cart/1:1",
      }),
    ),
  );
  assert.equal(offers[0]?.variantId, "gid://shopify/ProductVariant/a");
  assert.equal(offers[0]?.price.amount, "70.00");
});

test("validates that merchant handoff URLs stay on reviewed checkout hosts", () => {
  assert.equal(validateMedduCheckoutUrl(checkoutUrl), checkoutUrl);
  assert.throws(
    () => validateMedduCheckoutUrl("https://evil.example/cart/1:1"),
    /untrusted checkout URL/i,
  );
  assert.throws(
    () => validateMedduCheckoutUrl("https://meddu.com/blog/item"),
    /does not target a checkout/i,
  );
});

test("discovers through UCP with the public Shopify profile and UAE context", async () => {
  let observed: { url: string; body: unknown; headers: Headers } | null = null;
  const client = createMedduUcpClient({
    endpoint: "https://merchant.test/api/ucp/mcp",
    now: fixedNow,
    async fetch(input, init) {
      observed = {
        url: String(input),
        body: JSON.parse(String(init?.body)) as unknown,
        headers: new Headers(init?.headers),
      };
      return Response.json(searchResponse(product()));
    },
  });

  const selected = await client.discoverRecoveryOffer();
  assert.equal(selected.price.amount, "47.81");
  const request = observed as unknown as { url: string; body: any; headers: Headers };
  assert.equal(request.url, "https://merchant.test/api/ucp/mcp");
  assert.equal(request.body.method, "tools/call");
  assert.equal(request.body.params.name, "search_catalog");
  assert.equal(
    request.body.params.arguments.meta["ucp-agent"].profile,
    SHOPIFY_PUBLIC_AGENT_PROFILE,
  );
  assert.equal(request.body.params.arguments.catalog.context.address_country, "AE");
  assert.equal(
    request.body.params.arguments.catalog.query,
    "travel toiletries toothpaste face wash",
  );
  assert.equal(request.body.params.arguments.catalog.pagination.limit, 20);
  assert.equal(request.headers.get("authorization"), null);
});

test("falls back to a focused toiletries query when a verbose merchant search is empty", async () => {
  const queries: string[] = [];
  const client = createMedduUcpClient({
    endpoint: "https://merchant.test/api/ucp/mcp",
    now: fixedNow,
    async fetch(_input, init) {
      const body = JSON.parse(String(init?.body)) as any;
      queries.push(body.params.arguments.catalog.query);
      return Response.json(
        queries.length === 1 ? searchResponse() : searchResponse(product()),
      );
    },
  });

  const selected = await client.discoverRecoveryOffer({
    query: "delayed baggage recovery basics needed urgently",
  });

  assert.equal(selected.variantId, "gid://shopify/ProductVariant/46624128270499");
  assert.deepEqual(queries, [
    "delayed baggage recovery basics needed urgently",
    "travel toiletries toothpaste face wash",
  ]);
});

test("creates an anonymous UCP checkout draft with exact merchant total", async () => {
  let observedBody: any = null;
  const client = createMedduUcpClient({
    endpoint: "https://merchant.test/api/ucp/mcp",
    now: fixedNow,
    async fetch(_input, init) {
      observedBody = JSON.parse(String(init?.body));
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          structuredContent: {
            id: "gid://shopify/Checkout/checkout-1?key=secret",
            status: "incomplete",
            currency: "AED",
            totals: [
              { type: "subtotal", amount: 4781 },
              { type: "total", amount: 4781 },
            ],
            continue_url:
              "https://edqvrb-i5.myshopify.com/checkouts/checkout-1",
          },
        },
      });
    },
  });

  const draft = await client.createCheckoutDraft({
    offer: offer(),
    buyer,
    shippingAddress,
    idempotencyKey: "case-1-quote",
  });

  assert.deepEqual(draft.total, {
    amount: "47.81",
    currency: "AED",
    minorAmount: "4781",
  });
  assert.equal(draft.checkoutId, "gid://shopify/Checkout/checkout-1?key=secret");
  assert.equal(draft.source, "ucp_checkout");
  assert.equal(observedBody.params.name, "create_checkout");
  assert.equal(observedBody.params.arguments.meta["idempotency-key"], "case-1-quote");
  assert.equal(
    observedBody.params.arguments.checkout.line_items[0].item.id,
    offer().variantId,
  );
  assert.equal(
    observedBody.params.arguments.checkout.fulfillment.methods[0].destinations[0]
      .street_address,
    shippingAddress.streetAddress,
  );
});

test("rejects reserved and made-up buyer email TLDs before UCP checkout", async () => {
  let fetchCalls = 0;
  const client = createMedduUcpClient({
    endpoint: "https://merchant.example.com/api/ucp/mcp",
    now: fixedNow,
    async fetch() {
      fetchCalls += 1;
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          structuredContent: {
            id: "gid://shopify/Checkout/checkout-email",
            status: "incomplete",
            currency: "AED",
            totals: [{ type: "total", amount: 4781 }],
            continue_url:
              "https://edqvrb-i5.myshopify.com/checkouts/checkout-email",
          },
        },
      });
    },
  });

  for (const email of [
    "traveler@company.test",
    "traveler@company.local",
    "traveler@company.demo",
    "traveler@company.nep",
    "traveler@company.madeup",
  ]) {
    await assert.rejects(
      client.createCheckoutDraft({
        offer: offer(),
        buyer: { ...buyer, email },
        shippingAddress,
        idempotencyKey: `email-${email}`,
      }),
      /routable domain/i,
      email,
    );
  }
  assert.equal(fetchCalls, 0);

  await client.createCheckoutDraft({
    offer: offer(),
    buyer: { ...buyer, email: "traveler@example.com" },
    shippingAddress,
    idempotencyKey: "email-example-com",
  });
  assert.equal(fetchCalls, 1);
});

test("catalog checkout preparation is pure and does not invent a quoted total", () => {
  const selected = offer();
  const prepared = prepareCatalogCheckout(selected, fixedNow);
  assert.equal(prepared.checkoutUrl, checkoutUrl);
  assert.equal(prepared.checkoutId, null);
  assert.equal(prepared.total, null);
  assert.equal(prepared.source, "ucp_catalog_checkout_url");
  assert.notEqual(prepared.offer, selected);
});

test("classifies the organizer's expected merchant decline reasons", () => {
  assert.deepEqual(classifyShopifyPaymentOutcome("Your card has insufficient funds"), {
    status: "expected_decline",
    reason: "insufficient_funds",
    message: "Your card has insufficient funds",
  });
  assert.deepEqual(classifyShopifyPaymentOutcome("Test card is not accepted"), {
    status: "expected_decline",
    reason: "test_card",
    message: "Test card is not accepted",
  });
  assert.deepEqual(classifyShopifyPaymentOutcome("Your card was declined"), {
    status: "declined",
    reason: "merchant_declined",
    message: "Your card was declined",
  });
  assert.deepEqual(classifyShopifyPaymentOutcome("Please wait"), {
    status: "unknown",
  });
});

interface FakeState {
  bodyText: string;
  totalText: string | null;
  semanticTotalTexts: string[];
  afterSubmitText: string;
  submitClicks: number;
  throwAfterSubmit: boolean;
  paymentFields: boolean;
  fills: string[];
}

class FakeLocator {
  constructor(
    private readonly state: FakeState,
    private readonly kind:
      | "missing"
      | "field"
      | "body"
      | "total"
      | "continue"
      | "pay",
    private readonly texts: string[] = [],
    private readonly index = 0,
  ) {}

  async count(): Promise<number> {
    if (this.kind === "missing") return 0;
    if (this.kind === "total") return this.texts.length;
    if (this.kind === "field" && !this.state.paymentFields) return 0;
    if (this.kind === "continue") return 0;
    return 1;
  }

  nth(index: number): FakeLocator {
    return new FakeLocator(this.state, this.kind, this.texts, index);
  }

  async isVisible(): Promise<boolean> {
    return (await this.count()) > 0;
  }

  async fill(value: string): Promise<void> {
    this.state.fills.push(value);
  }

  async selectOption(value: string): Promise<unknown> {
    this.state.fills.push(value);
    return [];
  }

  async click(): Promise<void> {
    if (this.kind !== "pay") return;
    this.state.submitClicks += 1;
    if (this.state.throwAfterSubmit) throw new Error("navigation closed");
    this.state.bodyText = this.state.afterSubmitText;
  }

  async textContent(): Promise<string | null> {
    if (this.kind === "body") return this.state.bodyText;
    if (this.kind === "total") return this.texts[this.index] ?? null;
    return "";
  }
}

class FakeFrame {
  constructor(private readonly state: FakeState) {}

  locator(selector: string): FakeLocator {
    const payment = /cc-|verification_value|name="(?:number|expiry|name)"/.test(selector);
    return new FakeLocator(this.state, payment ? "field" : "missing");
  }
}

class FakePage {
  private readonly paymentFrame: FakeFrame;

  constructor(private readonly state: FakeState) {
    this.paymentFrame = new FakeFrame(state);
  }

  async goto(): Promise<unknown> {
    return null;
  }

  frames(): FakeFrame[] {
    return [this.paymentFrame];
  }

  locator(selector: string): FakeLocator {
    if (selector === "body") return new FakeLocator(this.state, "body");
    if (selector === "[data-checkout-payment-due-target]") {
      return new FakeLocator(
        this.state,
        "total",
        this.state.totalText === null ? [] : [this.state.totalText],
      );
    }
    if (selector.includes('div[role="row"]') && /total/i.test(selector)) {
      return new FakeLocator(this.state, "total", this.state.semanticTotalTexts);
    }
    const address = /email|firstName|lastName|address1|address2|city|postalCode|phone|countryCode/.test(
      selector,
    );
    return new FakeLocator(this.state, address ? "field" : "missing");
  }

  getByRole(_role: "button", options: { name: RegExp }): FakeLocator {
    return new FakeLocator(
      this.state,
      options.name.test("Pay now") ? "pay" : "continue",
    );
  }

  async waitForTimeout(): Promise<void> {}

  url(): string {
    return checkoutUrl;
  }
}

function fakePlaywright(state: FakeState) {
  return {
    chromium: {
      async launch() {
        return {
          async newContext() {
            return {
              async newPage() {
                return new FakePage(state);
              },
              async close() {},
            };
          },
          async close() {},
        };
      },
    },
  };
}

function paymentRequest(
  prepared: PreparedMerchantCheckout = prepareCatalogCheckout(offer(), fixedNow),
): SandboxMerchantPaymentRequest {
  return {
    idempotencyKey: "payment-attempt-1",
    checkout: prepared,
    buyer,
    shippingAddress,
    credential: {
      token: MOCK_ONE_TIME_TOKEN,
      dynamicCvv: MOCK_DYNAMIC_CVV,
      expiryMonth: "12",
      expiryYear: "30",
    },
    expectedTotal: offer().price,
  };
}

function fakeState(input?: Partial<FakeState>): FakeState {
  return {
    bodyText: "Order total AED 47.81",
    totalText: "Total AED 47.81",
    semanticTotalTexts: [],
    afterSubmitText: "Payment failed: insufficient funds",
    submitClicks: 0,
    throwAfterSubmit: false,
    paymentFields: true,
    fills: [],
    ...input,
  };
}

test("submits the Prava credential once and returns expected sandbox decline evidence", async () => {
  const state = fakeState();
  const executor = createPlaywrightShopifyBrowserExecutor({
    now: fixedNow,
    postSubmitWaitMs: 1,
    loadPlaywright: async () => fakePlaywright(state),
  });
  const request = paymentRequest();
  const first = await executor.attempt(request);
  const replay = await executor.attempt(request);

  assert.deepEqual(first, {
    status: "expected_decline",
    reason: "insufficient_funds",
    responseCode: "sandbox_expected_decline",
    message: "Payment failed: insufficient funds",
    merchant: MEDDU_MERCHANT,
    checkoutHost: "edqvrb-i5.myshopify.com",
    attemptedAt: "2026-08-02T12:00:00.000Z",
    paymentSubmitted: true,
  });
  assert.deepEqual(replay, first);
  assert.equal(state.submitClicks, 1);
  assert.equal(JSON.stringify(first).includes(MOCK_ONE_TIME_TOKEN), false);
  assert.equal(JSON.stringify(first).includes(MOCK_DYNAMIC_CVV), false);
});

test("reads the current Shopify semantic Total row when legacy selectors are absent", async () => {
  const state = fakeState({
    totalText: null,
    semanticTotalTexts: ["AED 47.81"],
  });
  const executor = createPlaywrightShopifyBrowserExecutor({
    now: fixedNow,
    postSubmitWaitMs: 1,
    loadPlaywright: async () => fakePlaywright(state),
  });

  const result = await executor.attempt(paymentRequest());
  assert.equal(result.status, "expected_decline");
  assert.equal(state.submitClicks, 1);
});

test("fails closed when visible authoritative totals are ambiguous", async () => {
  const state = fakeState({
    totalText: "AED 47.81",
    semanticTotalTexts: ["AED 99.00"],
  });
  const executor = createPlaywrightShopifyBrowserExecutor({
    now: fixedNow,
    loadPlaywright: async () => fakePlaywright(state),
  });

  const result = await executor.attempt(paymentRequest());
  assert.equal(result.status, "failed_pre_submit");
  assert.equal(
    result.status === "failed_pre_submit" ? result.message : "",
    "The merchant checkout showed ambiguous final totals",
  );
  assert.equal(state.submitClicks, 0);
});

test("redacts payment credentials from preserved processor decline evidence", () => {
  const groupedToken = MOCK_ONE_TIME_TOKEN.match(/.{4}/g)?.join(" ");
  const result = classifyShopifyPaymentOutcome(
    `Payment failed: insufficient funds for card ${groupedToken}, CVV ${MOCK_DYNAMIC_CVV}`,
  );
  assert.equal(result.status, "expected_decline");
  assert.match(result.status === "expected_decline" ? result.message : "", /insufficient funds/i);
  assert.equal(JSON.stringify(result).includes(MOCK_ONE_TIME_TOKEN.slice(0, 4)), false);
  assert.equal(JSON.stringify(result).includes(`CVV ${MOCK_DYNAMIC_CVV}`), false);
});

test("treats a post-submit browser failure as reconciliation, never as a retry", async () => {
  const state = fakeState({ throwAfterSubmit: true });
  const executor = createPlaywrightShopifyBrowserExecutor({
    now: fixedNow,
    loadPlaywright: async () => fakePlaywright(state),
  });
  const result = await executor.attempt(paymentRequest());
  assert.equal(result.status, "reconciliation_required");
  assert.equal(result.paymentSubmitted, true);
  assert.equal(state.submitClicks, 1);
});

test("fails closed before submit when final merchant total differs from approval", async () => {
  const state = fakeState({
    bodyText: "Item subtotal AED 47.81, shipping AED 25.00, total AED 72.81",
    totalText: "Total AED 72.81",
  });
  const executor = createPlaywrightShopifyBrowserExecutor({
    now: fixedNow,
    loadPlaywright: async () => fakePlaywright(state),
  });
  const result = await executor.attempt(paymentRequest());
  assert.equal(result.status, "failed_pre_submit");
  assert.equal(result.paymentSubmitted, false);
  assert.equal(state.submitClicks, 0);
});

test("fails closed when no authoritative final merchant total is available", async () => {
  const state = fakeState({
    bodyText: "Item subtotal AED 47.81",
    totalText: null,
  });
  const executor = createPlaywrightShopifyBrowserExecutor({
    now: fixedNow,
    loadPlaywright: async () => fakePlaywright(state),
  });
  const result = await executor.attempt(paymentRequest());
  assert.equal(result.status, "failed_pre_submit");
  assert.equal(
    result.status === "failed_pre_submit" ? result.message : "",
    "The merchant final total could not be verified",
  );
  assert.equal(state.submitClicks, 0);
});

test("fails before submit when Shopify payment fields are unavailable", async () => {
  const state = fakeState({ paymentFields: false });
  const executor = createPlaywrightShopifyBrowserExecutor({
    now: fixedNow,
    loadPlaywright: async () => fakePlaywright(state),
  });
  const result = await executor.attempt(paymentRequest());
  assert.equal(result.status, "failed_pre_submit");
  assert.equal(
    result.status === "failed_pre_submit" ? result.code : null,
    "payment_form_unavailable",
  );
  assert.equal(state.submitClicks, 0);
});

test("never launches a browser for malformed transient credentials", async () => {
  let loaded = false;
  const executor = createPlaywrightShopifyBrowserExecutor({
    now: fixedNow,
    loadPlaywright: async () => {
      loaded = true;
      return fakePlaywright(fakeState());
    },
  });
  const request = paymentRequest();
  request.credential.dynamicCvv = "bad";
  const result = await executor.attempt(request);
  assert.equal(result.status, "failed_pre_submit");
  assert.equal(loaded, false);
});
