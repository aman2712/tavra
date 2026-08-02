import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteCheckoutStateStore } from "../src/checkout-state-store.js";
import type {
  CommerceAddress,
  CommerceCheckoutResult,
  CommerceOffer,
  CommercePaymentStatus,
  CommerceProvider,
  CommerceQuote,
} from "../src/commerce.js";
import {
  createLiveCommerceService,
  liveCommerceOrderCardLabel,
  type LiveCommerceStatusEvent,
  type LiveCommerceRecoveryRequest,
} from "../src/live-commerce.js";

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
const address: CommerceAddress = {
  id: "addr_abu_dhabi_001",
  label: "Work",
  summary: "Masdar City, Abu Dhabi, AE",
  country: "AE",
  isDefault: true,
  contactPhoneOnFile: true,
};
const offer: CommerceOffer = {
  productId: "product_shirt_001",
  variantId: "variant_shirt_m_black",
  title: "Essential cotton T-shirt",
  description: "Black cotton T-shirt, size M",
  merchant,
  options: { Size: "M", Color: "Black" },
  unitPrice: { amount: "149.00", currency: "AED" },
  available: true,
  imageUrl: "https://cdn.essential.example/products/shirt-m.jpg",
  provenance,
};

function recoveryRequest(): LiveCommerceRecoveryRequest {
  return {
    caseId: "RCV-LIVE1234",
    chatId: "chat-live-1234",
    employeeId: "employee-demo",
    employeePhone: "+12025550123",
    employeeEmail: "traveler@example.com",
    needBy: "8:00 AM tomorrow",
    needByIso: "2027-08-03T04:00:00.000Z",
    deliveryArea: "Masdar City, Abu Dhabi",
    address,
    essentials: {
      shipsTo: "AE",
      tShirtSize: "M",
      trouserWaist: "32",
      trouserInseam: "30",
    },
    incident: {
      airline: "Etihad",
      arrivalAirport: "AUH",
      baggageReference: "AUH12345",
      noticeAttachmentIds: [],
      passengerName: "Demo Traveler",
      flightNumber: null,
      incidentDate: null,
    },
  };
}

function quote(total = "169.00"): CommerceQuote {
  return {
    quoteId: "quote_live_001",
    offer,
    addressId: address.id,
    quantity: 1,
    subtotal: { amount: "149.00", currency: "AED" },
    shipping: { amount: "15.00", currency: "AED" },
    tax: {
      amount: total === "169.00" ? "5.00" : "87.00",
      currency: "AED",
    },
    total: { amount: total, currency: "AED" },
    deliveryLabel: "Tomorrow by 7:30 AM",
    estimatedArrival: "2027-08-03T03:30:00.000Z",
    expiresAt: "2027-08-02T13:00:00.000Z",
  };
}

function providerFixture(options: {
  quoteTotal?: string;
  paymentStatus?: CommercePaymentStatus;
  checkout?: CommerceCheckoutResult | Error;
} = {}): { provider: CommerceProvider; calls: string[] } {
  const calls: string[] = [];
  const liveQuote = quote(options.quoteTotal);
  const provider: CommerceProvider = {
    mode: "live",
    async health() {
      calls.push("health");
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
      calls.push("listAddresses");
      return [address];
    },
    async addAddress() {
      calls.push("addAddress");
      return address;
    },
    async search(request) {
      calls.push(`search:${request.category}`);
      return {
        results: [
          {
            productId: offer.productId,
            title: offer.title,
            merchant,
            estimatedPrice: offer.unitPrice,
            imageUrl: offer.imageUrl,
            provenance,
          },
        ],
        nextCursor: null,
      };
    },
    async getProduct() {
      calls.push("getProduct");
      return {
        productId: offer.productId,
        title: offer.title,
        description: offer.description,
        merchant,
        images: [offer.imageUrl as string],
        offers: [offer],
        provenance,
      };
    },
    async quote(input) {
      calls.push("quote");
      assert.equal(input.userApprovedOffer, true);
      assert.equal(input.addressId, address.id);
      return liveQuote;
    },
    async createPaymentSession(input) {
      calls.push("createPaymentSession");
      assert.equal(input.userApprovedTotal, true);
      return {
        sessionId: "payment_session_live_001",
        paymentUrl: "https://pay.prava.space/session/live_001",
        expiresAt: "2027-08-02T13:00:00.000Z",
        replayed: false,
        quoteId: liveQuote.quoteId,
        total: liveQuote.total,
      };
    },
    async getPaymentStatus() {
      calls.push("getPaymentStatus");
      return options.paymentStatus ?? { status: "completed" };
    },
    async checkout(input) {
      calls.push("checkout");
      assert.equal(input.userApprovedTotal, true);
      assert.equal(input.idempotencyKey.endsWith(":merchant-checkout"), true);
      if (options.checkout instanceof Error) throw options.checkout;
      return (
        options.checkout ?? {
          status: "ordered",
          orderId: "merchant_order_001",
          amount: liveQuote.total,
          replayed: false,
        }
      );
    },
  };
  return { provider, calls };
}

async function stateStore() {
  const directory = await mkdtemp(join(tmpdir(), "tavra-live-commerce-"));
  return new SqliteCheckoutStateStore(join(directory, "tavra.sqlite"));
}

test("runs the documented Prava discovery, quote, approval, and checkout order exactly once", async () => {
  const { provider, calls } = providerFixture();
  const notifications: string[] = [];
  const preparedStates: string[] = [];
  let approvalIncidentAirline: string | null = null;
  const service = createLiveCommerceService({
    provider,
    store: await stateStore(),
    publicBaseUrl: "https://tavra.example",
    onPrepared: async (snapshot) => {
      preparedStates.push(snapshot.state);
      if (snapshot.state === "approval_pending") {
        approvalIncidentAirline = snapshot.payload.request.incident.airline;
      }
    },
    onStatus: async (event) => {
      notifications.push(event.state);
    },
  });

  const prepared = await service.prepareOffer(recoveryRequest());
  assert.ok(prepared);
  assert.equal(prepared.selection.category, "tshirt");
  const quoted = await service.createQuote({
    checkoutId: prepared.checkoutId,
    authorizationEventId: "event-offer-confirmed-001",
  });
  assert.equal(quoted.state, "quote_review");
  assert.equal(quoted.payload.deadlineAssessment, "meets");
  const approval = await service.createApproval({
    checkoutId: prepared.checkoutId,
    authorizationEventId: "event-total-confirmed-001",
    incident: {
      ...recoveryRequest().incident,
      airline: "Etihad Airways",
    },
  });
  assert.equal(approval.url, `https://tavra.example/pay/${prepared.checkoutId}`);
  assert.equal(await service.getProductImageSource(prepared.checkoutId, 0), offer.imageUrl);

  assert.deepEqual(await service.getStatus(prepared.checkoutId), {
    status: "completed",
    merchantOrderId: "merchant_order_001",
    merchantOutcome: "live",
  });
  assert.equal(await service.getApprovalTarget(prepared.checkoutId), null);
  await service.getStatus(prepared.checkoutId);
  assert.equal(calls.filter((call) => call === "checkout").length, 1);
  assert.deepEqual(notifications, ["order_confirmed"]);
  assert.deepEqual(preparedStates, [
    "offer_review",
    "quote_review",
    "approval_pending",
  ]);
  assert.equal(approvalIncidentAirline, "Etihad Airways");
  assert.deepEqual(calls, [
    "health",
    "search:tshirt",
    "getProduct",
    "quote",
    "createPaymentSession",
    "getPaymentStatus",
    "checkout",
  ]);
});

test("two service instances share one durable merchant-checkout execution claim", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tavra-live-commerce-claim-"));
  const path = join(directory, "tavra.sqlite");
  const { provider } = providerFixture();
  const originalCheckout = provider.checkout.bind(provider);
  let checkoutInvocations = 0;
  let enteredCheckout!: () => void;
  let releaseCheckout!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredCheckout = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseCheckout = resolve;
  });
  provider.checkout = async (input) => {
    checkoutInvocations += 1;
    enteredCheckout();
    await release;
    return originalCheckout(input);
  };
  const first = createLiveCommerceService({
    provider,
    store: new SqliteCheckoutStateStore(path),
    publicBaseUrl: "https://tavra.example",
  });
  const second = createLiveCommerceService({
    provider,
    store: new SqliteCheckoutStateStore(path),
    publicBaseUrl: "https://tavra.example",
  });
  const prepared = await first.prepareOffer(recoveryRequest());
  assert.ok(prepared);
  await first.createQuote({
    checkoutId: prepared.checkoutId,
    authorizationEventId: "event-offer-atomic-001",
  });
  await first.createApproval({
    checkoutId: prepared.checkoutId,
    authorizationEventId: "event-total-atomic-001",
  });

  const firstProgress = first.getStatus(prepared.checkoutId);
  await entered;
  assert.deepEqual(await second.getStatus(prepared.checkoutId), {
    status: "merchant_checkout_pending",
  });
  assert.equal(checkoutInvocations, 1);
  releaseCheckout();
  assert.equal((await firstProgress)?.status, "completed");
  assert.equal((await second.getStatus(prepared.checkoutId))?.status, "completed");
  assert.equal(checkoutInvocations, 1);
});

test("exposes the Prava URL only while approval is pending", async () => {
  const { provider } = providerFixture();
  const store = await stateStore();
  let currentTime = new Date("2026-08-02T12:00:00.000Z");
  const service = createLiveCommerceService({
    provider,
    store,
    publicBaseUrl: "https://tavra.example",
    now: () => currentTime,
  });
  const prepared = await service.prepareOffer(recoveryRequest());
  assert.ok(prepared);
  await service.createQuote({
    checkoutId: prepared.checkoutId,
    authorizationEventId: "event-offer-confirmed-target",
  });
  await service.createApproval({
    checkoutId: prepared.checkoutId,
    authorizationEventId: "event-total-confirmed-target",
  });
  assert.equal(
    await service.getApprovalTarget(prepared.checkoutId),
    "https://pay.prava.space/session/live_001",
  );

  currentTime = new Date("2028-08-02T12:00:00.000Z");
  assert.equal(await service.getApprovalTarget(prepared.checkoutId), null);
  await assert.rejects(
    () =>
      service.createApproval({
        checkoutId: prepared.checkoutId,
        authorizationEventId: "event-total-confirmed-replay",
      }),
    /no longer active/i,
  );
  currentTime = new Date("2026-08-02T12:00:00.000Z");

  const checkoutPending = await service.getWorkflow(prepared.checkoutId);
  assert.ok(checkoutPending);
  checkoutPending.state = "merchant_checkout_pending";
  await store.saveWorkflow(checkoutPending);
  assert.equal(await service.getApprovalTarget(prepared.checkoutId), null);

  checkoutPending.state = "order_confirmed";
  checkoutPending.payload.checkoutResult = {
    status: "ordered",
    orderId: "merchant_order_001",
    amount: quote().total,
    replayed: false,
  };
  await store.saveWorkflow(checkoutPending);
  assert.equal(await service.getApprovalTarget(prepared.checkoutId), null);
});

test("terminal card label preserves selected variant and merchant order ID", () => {
  const event: LiveCommerceStatusEvent = {
    checkoutId: "checkout_live_card_001",
    caseId: "RCV-LIVE1234",
    chatId: "chat-live-1234",
    employeeId: "employee-demo",
    employeePhone: "+12025550123",
    state: "order_confirmed",
    selection: {
      category: "tshirt",
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
        images: [offer.imageUrl as string],
        offers: [offer],
        provenance,
      },
      offer,
    },
    quote: quote(),
    paymentSessionId: "payment_session_live_001",
    checkoutResult: {
      status: "ordered",
      orderId: "merchant_order_001",
      amount: quote().total,
      replayed: false,
    },
  };

  assert.equal(
    liveCommerceOrderCardLabel(event),
    "Size M, Color Black | Order merchant_order_001",
  );
  assert.equal(
    liveCommerceOrderCardLabel({
      ...event,
      state: "failed",
      checkoutResult: { status: "failed", message: "declined" },
    }),
    null,
  );
});

test("rejects an all-in quote above AED 250 before payment creation", async () => {
  const { provider, calls } = providerFixture({ quoteTotal: "251.00" });
  const service = createLiveCommerceService({
    provider,
    store: await stateStore(),
    publicBaseUrl: "https://tavra.example",
  });
  const prepared = await service.prepareOffer(recoveryRequest());
  assert.ok(prepared);
  await assert.rejects(
    service.createQuote({
      checkoutId: prepared.checkoutId,
      authorizationEventId: "event-offer-confirmed-002",
    }),
    /exceeds the 250\.00 AED cap/,
  );
  assert.equal(calls.includes("createPaymentSession"), false);
  assert.equal(calls.includes("checkout"), false);
});

test("unknown checkout outcomes enter reconciliation and never retry", async () => {
  const { provider, calls } = providerFixture({
    checkout: new Error("connection closed after request"),
  });
  const service = createLiveCommerceService({
    provider,
    store: await stateStore(),
    publicBaseUrl: "https://tavra.example",
  });
  const prepared = await service.prepareOffer(recoveryRequest());
  assert.ok(prepared);
  await service.createQuote({
    checkoutId: prepared.checkoutId,
    authorizationEventId: "event-offer-confirmed-003",
  });
  await service.createApproval({
    checkoutId: prepared.checkoutId,
    authorizationEventId: "event-total-confirmed-003",
  });
  const first = await service.getStatus(prepared.checkoutId);
  assert.equal(first?.status, "reconciliation_required");
  await service.getStatus(prepared.checkoutId);
  assert.equal(calls.filter((call) => call === "checkout").length, 1);
});

test("polls Prava payment status no faster than every three seconds", async () => {
  const { provider, calls } = providerFixture({
    paymentStatus: { status: "pending" },
  });
  let currentTime = new Date("2026-08-02T12:00:00.000Z");
  const service = createLiveCommerceService({
    provider,
    store: await stateStore(),
    publicBaseUrl: "https://tavra.example",
    monitorIntervalMs: 1,
    now: () => currentTime,
  });
  const prepared = await service.prepareOffer(recoveryRequest());
  assert.ok(prepared);
  await service.createQuote({
    checkoutId: prepared.checkoutId,
    authorizationEventId: "event-poll-offer",
  });
  await service.createApproval({
    checkoutId: prepared.checkoutId,
    authorizationEventId: "event-poll-total",
  });

  const first = await Promise.all([
    service.getStatus(prepared.checkoutId),
    service.getStatus(prepared.checkoutId),
  ]);
  assert.deepEqual(first.map((status) => status?.status), [
    "approval_pending",
    "approval_pending",
  ]);
  assert.equal(calls.filter((call) => call === "getPaymentStatus").length, 1);

  currentTime = new Date(currentTime.getTime() + 2_999);
  await service.getStatus(prepared.checkoutId);
  assert.equal(calls.filter((call) => call === "getPaymentStatus").length, 1);

  currentTime = new Date(currentTime.getTime() + 1);
  await service.getStatus(prepared.checkoutId);
  assert.equal(calls.filter((call) => call === "getPaymentStatus").length, 2);
});

test("blocks monitoring when approval evidence cannot be persisted", async () => {
  const { provider, calls } = providerFixture();
  const service = createLiveCommerceService({
    provider,
    store: await stateStore(),
    publicBaseUrl: "https://tavra.example",
    onPrepared: async (snapshot) => {
      if (snapshot.state === "approval_pending") {
        throw new Error("ledger unavailable");
      }
    },
  });
  const prepared = await service.prepareOffer(recoveryRequest());
  assert.ok(prepared);
  await service.createQuote({
    checkoutId: prepared.checkoutId,
    authorizationEventId: "event-offer-confirmed-ledger",
  });
  await assert.rejects(
    service.createApproval({
      checkoutId: prepared.checkoutId,
      authorizationEventId: "event-total-confirmed-ledger",
    }),
    /ledger unavailable/,
  );
  assert.equal((await service.getStatus(prepared.checkoutId))?.status, "failed");
  assert.equal(calls.includes("getPaymentStatus"), false);
  assert.equal(calls.includes("checkout"), false);
});

test("a persisted checkout-in-progress is fail-closed after restart", async () => {
  const { provider, calls } = providerFixture();
  const store = await stateStore();
  const first = createLiveCommerceService({
    provider,
    store,
    publicBaseUrl: "https://tavra.example",
  });
  const prepared = await first.prepareOffer(recoveryRequest());
  assert.ok(prepared);
  await first.createQuote({
    checkoutId: prepared.checkoutId,
    authorizationEventId: "event-offer-confirmed-004",
  });
  await first.createApproval({
    checkoutId: prepared.checkoutId,
    authorizationEventId: "event-total-confirmed-004",
  });
  const snapshot = await first.getWorkflow(prepared.checkoutId);
  assert.ok(snapshot);
  snapshot.state = "merchant_checkout_pending";
  await store.saveWorkflow(snapshot);

  const restarted = createLiveCommerceService({
    provider,
    store,
    publicBaseUrl: "https://tavra.example",
  });
  await restarted.resume();
  assert.equal((await restarted.getStatus(prepared.checkoutId))?.status, "reconciliation_required");
  assert.equal(calls.includes("checkout"), false);
});
