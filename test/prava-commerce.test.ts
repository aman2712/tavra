import assert from "node:assert/strict";
import test from "node:test";

import { selectRecoveryEssential, type CommerceOffer } from "../src/commerce.js";
import {
  createPravaUcpCommerceProvider,
  type PravaCommerceToolName,
  type PravaCommerceTransport,
} from "../src/prava-commerce.js";

interface ToolCall {
  name: PravaCommerceToolName;
  args: Record<string, unknown>;
}

function mockTransport(input?: {
  scopes?: string[];
  handlers?: Partial<Record<PravaCommerceToolName, (args: Record<string, unknown>) => unknown>>;
}): PravaCommerceTransport & { calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  const scopes = new Set(
    input?.scopes ?? ["payments:read", "payments:write", "checkout:run"],
  );
  return {
    calls,
    async getGrantedScopes() {
      return scopes;
    },
    async callTool(name, args) {
      calls.push({ name, args: structuredClone(args) });
      const handler = input?.handlers?.[name];
      if (!handler) throw new Error(`Missing mock handler for ${name}`);
      return handler(args);
    },
  };
}

const fixedNow = () => new Date("2026-08-02T08:00:00.000Z");

function searchPayload(imageUrl = "https://cdn.store.example.com/shirt-m.png") {
  return {
    results: [
      {
        product_id: "prod-shirt",
        title: "Essential cotton T-shirt",
        merchant: {
          name: "Example Outfitters",
          domain: "store.example.com",
          country: "AE",
        },
        price_estimate: { amount: "40.00", currency: "USD" },
        image_url: imageUrl,
      },
    ],
    next_cursor: null,
  };
}

function productPayload(imageUrl = "https://cdn.store.example.com/shirt-m.png") {
  return {
    product: {
      product_id: "prod-shirt",
      title: "Essential cotton T-shirt",
      description: "Neutral cotton T-shirt, size M",
      merchant: {
        name: "Example Outfitters",
        domain: "store.example.com",
        country: "AE",
      },
      images: [imageUrl],
    },
    offers: [
      {
        variant_id: "var-shirt-m",
        title: "Black / M",
        description: "Neutral cotton T-shirt, size M",
        options: { Color: "Black", Size: "M" },
        price: { amount: "40.00", currency: "USD" },
        available: true,
        image_url: imageUrl,
      },
    ],
  };
}

function quotePayload(input?: {
  total?: string;
  currency?: "AED" | "USD";
  expiresAt?: string;
  deliveryVerified?: boolean;
}) {
  const currency = input?.currency ?? "USD";
  const total = input?.total ?? "50.00";
  return {
    checkout_session_id: "ches-live-1",
    totals: {
      currency,
      subtotal: "40.00",
      shipping: "8.00",
      tax: total === "50.00" ? "2.00" : "202.01",
      total,
    },
    shipping_label: "Express",
    estimated_arrival: "2026-08-03T03:30:00.000Z",
    ...(input?.deliveryVerified === undefined
      ? {}
      : { delivery_estimate_verified: input.deliveryVerified }),
    expires_at: input?.expiresAt ?? "2026-08-02T08:15:00.000Z",
  };
}

async function selectedOffer(
  transport: PravaCommerceTransport,
): Promise<CommerceOffer> {
  const provider = createPravaUcpCommerceProvider({ transport, now: fixedNow });
  const selection = await selectRecoveryEssential(provider, {
    shipsTo: "AE",
    tShirtSize: "M",
  });
  assert.ok(selection);
  return selection.offer;
}

test("fails the access gate before calling tools when commerce scopes are missing", async () => {
  const transport = mockTransport({ scopes: ["payments:read"] });
  const provider = createPravaUcpCommerceProvider({ transport, now: fixedNow });

  assert.deepEqual(await provider.health(), {
    ready: false,
    mode: "live",
    connectedAgentCount: 0,
    savedAddressCount: 0,
    missingScopes: ["payments:write", "checkout:run"],
    message: "Reconnect Prava and approve: payments:write, checkout:run",
  });
  assert.equal(transport.calls.length, 0);
  await assert.rejects(
    () =>
      provider.addAddress({
        firstName: "Demo",
        lastName: "Traveler",
        street: "MBZUAI",
        city: "Abu Dhabi",
        region: "Abu Dhabi",
        postalCode: "00000",
        country: "AE",
      }),
    /missing required scope payments:write/i,
  );
  assert.equal(transport.calls.length, 0);
});

test("health verifies ping, a linked agent, and a masked address in order", async () => {
  const transport = mockTransport({
    handlers: {
      ping: () => ({ pong: true, server_time: "2026-08-02T08:00:00Z" }),
      list_agents: () => ({ agents: [{ id: "agent-tavra" }] }),
      shop_list_addresses: () => ({
        addresses: [
          {
            address_id: "addr-mbzuai",
            label: "MBZUAI",
            masked_summary: "Masdar City, Abu Dhabi, AE",
            country: "AE",
          },
        ],
      }),
    },
  });
  const provider = createPravaUcpCommerceProvider({ transport, now: fixedNow });

  assert.deepEqual(await provider.health(), {
    ready: true,
    mode: "live",
    connectedAgentCount: 1,
    savedAddressCount: 1,
    missingScopes: [],
    message: null,
  });
  assert.deepEqual(
    transport.calls.map((call) => call.name),
    ["ping", "list_agents", "shop_list_addresses"],
  );
});

test("health fails closed when no agent or masked address is connected", async () => {
  const noAgent = mockTransport({
    handlers: {
      ping: () => ({ pong: true }),
      list_agents: () => ({ agents: [] }),
      shop_list_addresses: () => ({
        addresses: [
          {
            address_id: "addr-mbzuai",
            masked_summary: "Masdar City, Abu Dhabi, AE",
            country: "AE",
          },
        ],
      }),
    },
  });
  const withoutAgent = await createPravaUcpCommerceProvider({
    transport: noAgent,
    now: fixedNow,
  }).health();
  assert.equal(withoutAgent.ready, false);
  assert.equal(withoutAgent.connectedAgentCount, 0);
  assert.equal(withoutAgent.savedAddressCount, 1);
  assert.match(withoutAgent.message ?? "", /connected Prava shopping agent/i);

  const noMaskedAddress = mockTransport({
    handlers: {
      ping: () => ({ pong: true }),
      list_agents: () => ({ agents: [{ id: "agent-tavra" }] }),
      shop_list_addresses: () => ({
        addresses: [
          {
            address_id: "addr-full-only",
            summary: "Full private address that health must not accept",
            country: "AE",
          },
        ],
      }),
    },
  });
  const withoutMaskedAddress = await createPravaUcpCommerceProvider({
    transport: noMaskedAddress,
    now: fixedNow,
  }).health();
  assert.equal(withoutMaskedAddress.ready, false);
  assert.equal(withoutMaskedAddress.connectedAgentCount, 1);
  assert.equal(withoutMaskedAddress.savedAddressCount, 0);
  assert.match(withoutMaskedAddress.message ?? "", /saved masked Prava delivery address/i);
  assert.doesNotMatch(JSON.stringify(withoutMaskedAddress), /Full private address/i);
});

test("uses masked address records and sends a full address only to Prava", async () => {
  const transport = mockTransport({
    handlers: {
      shop_list_addresses: () => ({
        addresses: [
          {
            address_id: "addr-mbzuai",
            label: "MBZUAI",
            summary:
              "Mohamed bin Zayed University of Artificial Intelligence, Front desk, Masdar City, Abu Dhabi",
            masked_summary: "Masdar City, Abu Dhabi, AE",
            country: "AE",
            is_default: true,
            phone_on_file: true,
            street: "must never escape parser",
          },
        ],
      }),
      shop_add_address: () => ({
        address: {
          address_id: "addr-mbzuai",
          label: "MBZUAI",
          summary:
            "Mohamed bin Zayed University of Artificial Intelligence, Front desk, Masdar City, Abu Dhabi",
          short_summary: "MBZUAI, Abu Dhabi, AE",
          country: "AE",
          is_default: true,
          phone_on_file: true,
        },
      }),
    },
  });
  const provider = createPravaUcpCommerceProvider({ transport, now: fixedNow });

  const listed = await provider.listAddresses();
  assert.equal(listed[0]?.summary, "Masdar City, Abu Dhabi, AE");
  assert.doesNotMatch(
    JSON.stringify(listed),
    /Mohamed bin Zayed University of Artificial Intelligence/i,
  );
  assert.doesNotMatch(JSON.stringify(listed), /must never escape parser/i);
  const added = await provider.addAddress({
    firstName: "Demo",
    lastName: "Traveler",
    street: "Mohamed bin Zayed University of Artificial Intelligence",
    street2: "Front desk",
    city: "Abu Dhabi",
    region: "Abu Dhabi",
    postalCode: "00000",
    country: "AE",
    phone: "+12025550123",
    setDefault: true,
  });
  assert.equal(added.summary, "MBZUAI, Abu Dhabi, AE");
  assert.doesNotMatch(
    JSON.stringify(added),
    /Mohamed bin Zayed University of Artificial Intelligence/i,
  );
  assert.deepEqual(transport.calls[1]?.args, {
    first_name: "Demo",
    last_name: "Traveler",
    street: "Mohamed bin Zayed University of Artificial Intelligence",
    street2: "Front desk",
    city: "Abu Dhabi",
    region: "Abu Dhabi",
    postal_code: "00000",
    country: "AE",
    phone: "+12025550123",
    set_default: true,
  });
});

test("rejects Prava addresses without an explicit masked representation", async () => {
  const transport = mockTransport({
    handlers: {
      shop_list_addresses: () => ({
        addresses: [
          {
            address_id: "addr-full-only",
            label: "Full address only",
            summary:
              "Mohamed bin Zayed University of Artificial Intelligence, Front desk, Masdar City, Abu Dhabi",
            country: "AE",
          },
        ],
      }),
    },
  });
  const provider = createPravaUcpCommerceProvider({ transport, now: fixedNow });

  await assert.rejects(
    () => provider.listAddresses(),
    /explicit masked_summary or short_summary/i,
  );
});

test("runs the documented discovery, quote, approval, status, checkout chain", async () => {
  const transport = mockTransport({
    handlers: {
      shop_search: () => searchPayload(),
      shop_product: () => productPayload(),
      shop_quote: () => quotePayload({ deliveryVerified: true }),
      create_payment_session: () => ({
        session_id: "pays-live-1",
        payment_url: "https://pay.prava.space/approve/pays-live-1",
        expires_at: "2026-08-02T08:10:00.000Z",
        replayed: false,
      }),
      get_payment_status: () => ({ status: "completed" }),
      shop_checkout: () => ({
        status: "ordered",
        order_id: "ord-live-1",
        amount: "50.00",
        currency: "USD",
        replayed: false,
      }),
    },
  });
  const provider = createPravaUcpCommerceProvider({ transport, now: fixedNow });
  const selection = await selectRecoveryEssential(provider, {
    shipsTo: "AE",
    tShirtSize: "M",
    trouserWaist: "32",
    trouserInseam: "30",
  });
  assert.ok(selection);
  const quote = await provider.quote({
    offer: selection.offer,
    addressId: "addr-mbzuai",
    userApprovedOffer: true,
  });
  const payment = await provider.createPaymentSession({
    quote,
    idempotencyKey: "pay-case-1",
    userApprovedTotal: true,
  });
  assert.equal(quote.deliveryEstimateVerified, true);
  const checkout = await provider.checkout({
    quote,
    paymentSession: payment,
    idempotencyKey: "checkout-case-1",
    userApprovedTotal: true,
  });

  assert.deepEqual(checkout, {
    status: "ordered",
    orderId: "ord-live-1",
    amount: { amount: "50.00", currency: "USD" },
    replayed: false,
  });
  assert.deepEqual(
    transport.calls.map((call) => call.name),
    [
      "shop_search",
      "shop_product",
      "shop_quote",
      "create_payment_session",
      "get_payment_status",
      "shop_checkout",
    ],
  );
  assert.match(String(transport.calls[0]?.args.query), /delivery to AE/i);
  assert.deepEqual(transport.calls[2]?.args, {
    variant_id: "var-shirt-m",
    merchant: "store.example.com",
    quantity: 1,
    address_id: "addr-mbzuai",
  });
  assert.equal(
    transport.calls[3]?.args.merchant_url,
    "https://store.example.com/",
  );
  const serializedCalls = JSON.stringify(transport.calls);
  assert.doesNotMatch(serializedCalls, /dynamic_cvv|cryptogram|\bcvv\b|\bpan\b|card_number/i);
});

test("rejects a merchant domain with a reserved or made-up TLD", async () => {
  for (const domain of ["merchant.demo", "merchant.nep", "merchant.notarealtld"]) {
    const transport = mockTransport({
      handlers: {
        shop_search: () => ({
          ...searchPayload(),
          results: [
            {
              ...searchPayload().results[0],
              merchant: {
                name: "Invalid Merchant",
                domain,
                country: "AE",
              },
            },
          ],
        }),
      },
    });
    const provider = createPravaUcpCommerceProvider({ transport, now: fixedNow });

    await assert.rejects(
      () =>
        provider.search({
          query: "recovery shirt",
          category: "tshirt",
          shipsTo: "AE",
        }),
      /recognized public TLD/i,
    );
  }
});

test("preserves Prava payment failure code and message", async () => {
  const transport = mockTransport({
    handlers: {
      get_payment_status: () => ({
        status: "failed",
        error: {
          code: "PASSKEY_REG_FAILED",
          message: "Passkey registration failed for this browser",
        },
      }),
    },
  });
  const provider = createPravaUcpCommerceProvider({ transport, now: fixedNow });

  assert.deepEqual(await provider.getPaymentStatus("pays-failed-1"), {
    status: "failed",
    code: "PASSKEY_REG_FAILED",
    message: "Passkey registration failed for this browser",
  });
});

test("rejects over-cap and expired quotes before payment", async () => {
  const overCapTransport = mockTransport({
    handlers: {
      shop_search: () => searchPayload(),
      shop_product: () => productPayload(),
      shop_quote: () => quotePayload({ total: "250.01", currency: "AED" }),
    },
  });
  const overCapProvider = createPravaUcpCommerceProvider({
    transport: overCapTransport,
    now: fixedNow,
  });
  const offer = await selectedOffer(overCapTransport);
  await assert.rejects(
    () =>
      overCapProvider.quote({
        offer,
        addressId: "addr-mbzuai",
        userApprovedOffer: true,
      }),
    /exceeds.*250\.00 AED cap/i,
  );

  const expiredTransport = mockTransport({
    handlers: {
      shop_search: () => searchPayload(),
      shop_product: () => productPayload(),
      shop_quote: () =>
        quotePayload({ expiresAt: "2026-08-02T07:59:59.000Z" }),
    },
  });
  const expiredProvider = createPravaUcpCommerceProvider({
    transport: expiredTransport,
    now: fixedNow,
  });
  const expiredOffer = await selectedOffer(expiredTransport);
  await assert.rejects(
    () =>
      expiredProvider.quote({
        offer: expiredOffer,
        addressId: "addr-mbzuai",
        userApprovedOffer: true,
      }),
    /expired quote expiry/i,
  );
});

test("rejects an offer without a UCP HTTPS image before quote", async () => {
  const transport = mockTransport();
  const provider = createPravaUcpCommerceProvider({ transport, now: fixedNow });
  const invalid: CommerceOffer = {
    productId: "prod-shirt",
    variantId: "var-shirt-m",
    title: "Shirt",
    description: "Shirt",
    merchant: { name: "Store", domain: "store.example.com", country: "AE" },
    options: { Size: "M" },
    unitPrice: { amount: "40.00", currency: "USD" },
    available: true,
    imageUrl: "http://store.example.com/shirt.png",
    provenance: {
      source: "prava_ucp",
      merchantDomain: "store.example.com",
      retrievedAt: "2026-08-02T08:00:00.000Z",
    },
  };
  await assert.rejects(
    () =>
      provider.quote({
        offer: invalid,
        addressId: "addr-mbzuai",
        userApprovedOffer: true,
      }),
    /trusted UCP product image/i,
  );
  assert.equal(transport.calls.length, 0);
});

test("checkout is idempotent and rejects key reuse for another approval", async () => {
  let checkoutCalls = 0;
  const transport = mockTransport({
    handlers: {
      shop_search: () => searchPayload(),
      shop_product: () => productPayload(),
      shop_quote: () => quotePayload(),
      create_payment_session: () => ({
        session_id: "pays-live-1",
        payment_url: "https://pay.prava.space/approve/pays-live-1",
        expires_at: "2026-08-02T08:10:00.000Z",
      }),
      get_payment_status: () => ({ status: "completed" }),
      shop_checkout: () => {
        checkoutCalls += 1;
        return {
          status: "ordered",
          order_id: "ord-live-1",
          amount: "50.00",
          currency: "USD",
        };
      },
    },
  });
  const provider = createPravaUcpCommerceProvider({ transport, now: fixedNow });
  const offer = await selectedOffer(transport);
  const quote = await provider.quote({
    offer,
    addressId: "addr-mbzuai",
    userApprovedOffer: true,
  });
  const payment = await provider.createPaymentSession({
    quote,
    idempotencyKey: "pay-case-1",
    userApprovedTotal: true,
  });
  const request = {
    quote,
    paymentSession: payment,
    idempotencyKey: "checkout-case-1",
    userApprovedTotal: true,
  } as const;
  const [first, second] = await Promise.all([
    provider.checkout(request),
    provider.checkout(request),
  ]);
  assert.deepEqual(second, first);
  assert.equal(checkoutCalls, 1);
  await assert.rejects(
    () =>
      provider.checkout({
        ...request,
        paymentSession: { ...payment, sessionId: "pays-live-2" },
      }),
    /idempotency key was reused/i,
  );
});

test("an unknown checkout result requires reconciliation and blocks retries", async () => {
  let checkoutCalls = 0;
  const transport = mockTransport({
    handlers: {
      shop_search: () => searchPayload(),
      shop_product: () => productPayload(),
      shop_quote: () => quotePayload(),
      create_payment_session: () => ({
        session_id: "pays-live-1",
        payment_url: "https://pay.prava.space/approve/pays-live-1",
        expires_at: "2026-08-02T08:10:00.000Z",
      }),
      get_payment_status: () => ({ status: "completed" }),
      shop_checkout: () => {
        checkoutCalls += 1;
        return { status: "processing", amount: "50.00", currency: "USD" };
      },
    },
  });
  const provider = createPravaUcpCommerceProvider({ transport, now: fixedNow });
  const offer = await selectedOffer(transport);
  const quote = await provider.quote({
    offer,
    addressId: "addr-mbzuai",
    userApprovedOffer: true,
  });
  const payment = await provider.createPaymentSession({
    quote,
    idempotencyKey: "pay-case-1",
    userApprovedTotal: true,
  });
  const request = {
    quote,
    paymentSession: payment,
    idempotencyKey: "checkout-case-unknown",
    userApprovedTotal: true,
  } as const;
  const first = await provider.checkout(request);
  const second = await provider.checkout(request);
  assert.equal(first.status, "reconciliation_required");
  assert.deepEqual(second, first);
  assert.equal(checkoutCalls, 1);
});

test("known pre-checkout failures do not become unknown merchant outcomes", async () => {
  let checkoutCalls = 0;
  let paymentStatus: "completed" | "pending" = "completed";
  const transport = mockTransport({
    handlers: {
      shop_search: () => searchPayload(),
      shop_product: () => productPayload(),
      shop_quote: () => quotePayload(),
      create_payment_session: () => ({
        session_id: "pays-live-preflight",
        payment_url: "https://pay.prava.space/approve/pays-live-preflight",
        expires_at: "2026-08-02T08:10:00.000Z",
      }),
      get_payment_status: () => ({ status: paymentStatus }),
      shop_checkout: () => {
        checkoutCalls += 1;
        return {
          status: "ordered",
          order_id: "ord-must-not-exist",
          amount: "50.00",
          currency: "USD",
        };
      },
    },
  });
  const provider = createPravaUcpCommerceProvider({ transport, now: fixedNow });
  const selected = await selectedOffer(transport);
  const liveQuote = await provider.quote({
    offer: selected,
    addressId: "addr-mbzuai",
    userApprovedOffer: true,
  });
  const payment = await provider.createPaymentSession({
    quote: liveQuote,
    idempotencyKey: "pay-preflight",
    userApprovedTotal: true,
  });

  const expired = await provider.checkout({
    quote: { ...liveQuote, expiresAt: "2026-08-02T07:59:59.000Z" },
    paymentSession: payment,
    idempotencyKey: "checkout-expired-preflight",
    userApprovedTotal: true,
  });
  assert.equal(expired.status, "failed");
  assert.match(expired.status === "failed" ? expired.message : "", /not attempted/i);

  paymentStatus = "pending";
  const unverified = await provider.checkout({
    quote: liveQuote,
    paymentSession: payment,
    idempotencyKey: "checkout-payment-preflight",
    userApprovedTotal: true,
  });
  assert.equal(unverified.status, "failed");
  assert.match(
    unverified.status === "failed" ? unverified.message : "",
    /not complete.*not attempted/i,
  );
  assert.equal(checkoutCalls, 0);
});
