import assert from "node:assert/strict";
import test from "node:test";

import type OpenAI from "openai";

import type {
  CommerceAddress,
  CommerceOffer,
  CommerceQuote,
} from "../src/commerce.js";
import type {
  LiveCommerceRecoveryRequest,
  LiveCommerceService,
  LiveCommerceWorkflowPayload,
  PreparedLiveCommerceOffer,
} from "../src/live-commerce.js";
import {
  createOpenAIReplyGenerator,
  type ConversationTurn,
  type IntentRouter,
  type RecoveryTurnInterpreter,
  type RecoveryTurnUpdate,
} from "../src/openai.js";
import type { CheckoutWorkflowSnapshot } from "../src/checkout-state-store.js";
import type { SensoKnowledgeProvider } from "../src/senso.js";
import { InMemoryRecoveryStateStore } from "../src/recovery-state-store.js";

const EMPTY_UPDATE: RecoveryTurnUpdate = {
  action: "unclear",
  confirmsOnFileSizes: false,
  tshirtSize: null,
  trouserWaist: null,
  trouserInseam: null,
  airline: null,
  arrivalAirport: null,
  baggageReference: null,
  wantsEssentials: null,
  needBy: null,
  deliveryArea: null,
  deliveryAddress: null,
  confirmsDeliveryAddress: false,
};

const LIVE_ADDRESS: CommerceAddress = {
  id: "addr-mbzuai",
  label: "MBZUAI",
  summary: "Masdar City, Abu Dhabi, AE",
  country: "AE",
  isDefault: true,
  contactPhoneOnFile: true,
};

const LIVE_OFFER: CommerceOffer = {
  productId: "product-shirt-1",
  variantId: "variant-shirt-m",
  title: "Everyday cotton T-shirt",
  description: "Neutral crew-neck cotton T-shirt",
  merchant: {
    name: "Abu Dhabi Essentials",
    domain: "merchant.example",
    country: "AE",
  },
  options: { Size: "M", Color: "Navy" },
  unitPrice: { amount: "54.00", currency: "AED" },
  available: true,
  imageUrl: "https://cdn.merchant.example/products/shirt-m.jpg",
  provenance: {
    source: "prava_ucp",
    merchantDomain: "merchant.example",
    retrievedAt: "2026-08-02T12:00:00.000Z",
  },
};

const LIVE_QUOTE: CommerceQuote = {
  quoteId: "quote-live-1",
  offer: LIVE_OFFER,
  addressId: LIVE_ADDRESS.id,
  quantity: 1,
  subtotal: { amount: "54.00", currency: "AED" },
  shipping: { amount: "8.00", currency: "AED" },
  tax: { amount: "3.10", currency: "AED" },
  total: { amount: "65.10", currency: "AED" },
  deliveryLabel: "Tomorrow, 7:30 AM to 8:30 AM",
  estimatedArrival: "2099-08-03T04:30:00.000Z",
  expiresAt: "2099-08-03T00:00:00.000Z",
};

function fixedRouter(): IntentRouter {
  return {
    async classify() {
      return "team_recovery";
    },
  };
}

function fixedKnowledge(): SensoKnowledgeProvider {
  return {
    async getKnowledge() {
      return {
        companyId: "company-1",
        employeeId: "employee-1",
        context: [
          "Work email: employee@example.com.",
          "T-shirt size: M.",
          "Trouser waist: 32 inches.",
          "Trouser inseam: unknown.",
        ].join(" "),
        contentIds: ["profile-1"],
      };
    },
  };
}

function fixedInterpreter(
  updates: RecoveryTurnUpdate[],
  histories?: ConversationTurn[][],
): RecoveryTurnInterpreter {
  let index = 0;
  return {
    async interpret({ history }) {
      histories?.push(structuredClone(history));
      return updates[index++] ?? EMPTY_UPDATE;
    },
  };
}

function replyClient(requests: Record<string, unknown>[]): OpenAI {
  const replies = [
    "Sorry, that’s a pain. I can help with replacement essentials and the baggage claim. Do you want basic clothing and toiletries, and where and when should they arrive?",
    "Got it. Here are the sizes on file:\n\n• T-shirt: M\n• Trouser waist: 32\n• Trouser inseam: not on file\n\nCan you confirm M and 32 and tell me your inseam?",
  ];
  let index = 0;
  return {
    responses: {
      async create(request: Record<string, unknown>) {
        requests.push(request);
        return { output_text: replies[index++] ?? replies.at(-1) };
      },
    },
  } as unknown as OpenAI;
}

function turn(revision: number) {
  return { revision, async isCurrent() { return true; } };
}

function fixedReplyClient(output: string): OpenAI {
  return {
    responses: {
      async create() {
        return { output_text: output };
      },
    },
  } as unknown as OpenAI;
}

function liveCommerceStub(input: {
  addresses?: CommerceAddress[];
  calls: string[];
  authorizationIds: string[];
  requests: LiveCommerceRecoveryRequest[];
}): LiveCommerceService {
  let preparedRequest: LiveCommerceRecoveryRequest | null = null;
  const prepared: PreparedLiveCommerceOffer = {
    checkoutId: "live-checkout-1",
    selection: {
      category: "tshirt",
      result: {
        productId: LIVE_OFFER.productId,
        title: LIVE_OFFER.title,
        merchant: LIVE_OFFER.merchant,
        estimatedPrice: LIVE_OFFER.unitPrice,
        imageUrl: LIVE_OFFER.imageUrl,
        provenance: LIVE_OFFER.provenance,
      },
      product: {
        productId: LIVE_OFFER.productId,
        title: LIVE_OFFER.title,
        description: LIVE_OFFER.description,
        merchant: LIVE_OFFER.merchant,
        images: [LIVE_OFFER.imageUrl as string],
        offers: [LIVE_OFFER],
        provenance: LIVE_OFFER.provenance,
      },
      offer: LIVE_OFFER,
    },
    address: LIVE_ADDRESS,
  };

  const workflow = (
    state: CheckoutWorkflowSnapshot<LiveCommerceWorkflowPayload>["state"],
    quote: CommerceQuote | null,
  ): CheckoutWorkflowSnapshot<LiveCommerceWorkflowPayload> => {
    assert.ok(preparedRequest);
    return {
      checkoutId: prepared.checkoutId,
      caseId: preparedRequest.caseId,
      chatId: preparedRequest.chatId,
      state,
      payload: {
        schemaVersion: 1,
        request: preparedRequest,
        selection: prepared.selection,
        quote,
        paymentSession: null,
        checkoutResult: null,
        deadlineAssessment: "unverified",
        offerAuthorizationEventId: null,
        purchaseAuthorizationEventId: null,
        terminalNotified: false,
      },
      updatedAt: "2026-08-02T12:00:00.000Z",
    };
  };

  return {
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
      input.calls.push("listAddresses");
      return input.addresses ?? [LIVE_ADDRESS];
    },
    async addAddress() {
      throw new Error("Conversation flow must not fabricate or add an address");
    },
    async prepareOffer(request) {
      input.calls.push("prepareOffer");
      input.requests.push(structuredClone(request));
      preparedRequest = structuredClone(request);
      return prepared;
    },
    async createQuote(request) {
      input.calls.push("createQuote");
      input.authorizationIds.push(request.authorizationEventId);
      return workflow("quote_review", LIVE_QUOTE);
    },
    async createApproval(request) {
      input.calls.push("createApproval");
      input.authorizationIds.push(request.authorizationEventId);
      return {
        checkoutId: request.checkoutId,
        url: `https://tavra.example/pay/${request.checkoutId}`,
        expiresAt: "2099-08-03T00:00:00.000Z",
      };
    },
    async getWorkflow() {
      return workflow("quote_review", LIVE_QUOTE);
    },
    async getStatus() {
      return { status: "quote_review" };
    },
    async getApprovalTarget() {
      return null;
    },
    async getProductImageSource(_checkoutId, index) {
      return index === 0 ? LIVE_OFFER.imageUrl : null;
    },
    async revoke() {
      input.calls.push("revoke");
      return true;
    },
    async resume() {},
  };
}

function recoveryUpdates(): RecoveryTurnUpdate[] {
  return [
    {
      ...EMPTY_UPDATE,
      action: "provide_recovery_context",
      wantsEssentials: true,
      deliveryArea: "Abu Dhabi",
      needBy: "8 AM tomorrow",
    },
    {
      ...EMPTY_UPDATE,
      action: "confirm_sizes",
      confirmsOnFileSizes: true,
      trouserInseam: "30",
    },
    {
      ...EMPTY_UPDATE,
      action: "provide_incident_details",
      airline: "Etihad",
      arrivalAirport: "AUH",
    },
  ];
}

test("runs live discovery only after address confirmation and binds both approvals to chat revisions", async () => {
  const calls: string[] = [];
  const authorizationIds: string[] = [];
  const commerceRequests: LiveCommerceRecoveryRequest[] = [];
  const modelRequests: Record<string, unknown>[] = [];
  const interpreterHistories: ConversationTurn[][] = [];
  const generator = createOpenAIReplyGenerator(
    replyClient(modelRequests),
    "reply-model",
    fixedKnowledge(),
    fixedRouter(),
    fixedInterpreter(recoveryUpdates(), interpreterHistories),
    undefined,
    {
      liveCommerce: liveCommerceStub({
        calls,
        authorizationIds,
        requests: commerceRequests,
      }),
      iMessageAppIdentity: {
        name: "Tavra",
        teamId: "ABCDEFGHIJ",
        bundleId: "com.example.tavra.MessagesExtension",
      },
    },
  );
  const send = (message: string, revision: number) =>
    generator.generateReply({
      message,
      senderHandle: "+971501234567",
      chatId: "chat-live",
      turn: turn(revision),
    });

  const replies = [
    await send("My baggage got delayed", 1),
    await send("Yes, Abu Dhabi by 8 AM tomorrow", 2),
    await send("Confirmed, inseam 30", 3),
    await send(
      "Mohamed bin Zayed University of Artificial Intelligence, Masdar City, Abu Dhabi",
      4,
    ),
  ];
  assert.deepEqual(calls, []);
  assert.match(replies.at(-1) as string, /exact delivery address/i);

  replies.push(await send("Yes", 5));
  assert.deepEqual(calls, ["listAddresses", "prepareOffer"]);
  assert.match(replies.at(-1) as string, /live merchant option/i);
  assert.match(replies.at(-1) as string, /Abu Dhabi Essentials/);
  assert.match(replies.at(-1) as string, /shipping and tax are not quoted/i);

  replies.push(await send("How much is it with shipping?", 6));
  assert.deepEqual(calls, ["listAddresses", "prepareOffer"]);
  assert.match(replies.at(-1) as string, /selected saved Prava address.*estimate shipping/i);

  replies.push(await send("Yes", 7));
  assert.deepEqual(calls, ["listAddresses", "prepareOffer", "createQuote"]);
  assert.match(replies.at(-1) as string, /AED 65\.10/);
  assert.match(replies.at(-1) as string, /Nothing has been purchased/i);
  assert.match(replies.at(-1) as string, /unverified delivery timing/i);

  replies.push(await send("I need a moment", 8));
  assert.deepEqual(calls, ["listAddresses", "prepareOffer", "createQuote"]);
  assert.match(replies.at(-1) as string, /Nothing has been purchased/i);

  replies.push(await send("Approve", 9));
  assert.deepEqual(calls, ["listAddresses", "prepareOffer", "createQuote"]);
  assert.match(replies.at(-1) as string, /Airline/);
  assert.match(replies.at(-1) as string, /arrival airport/i);
  assert.match(replies.at(-1) as string, /approval of the quoted estimate/i);

  replies.push(
    await send("Etihad, arrival airport AUH, no baggage reference", 10),
  );
  assert.deepEqual(calls, [
    "listAddresses",
    "prepareOffer",
    "createQuote",
    "createApproval",
  ]);
  assert.deepEqual(authorizationIds, [
    "offer:chat-live:revision:7",
    "purchase:chat-live:revision:9",
  ]);
  assert.match(replies.at(-1) as string, /secure Prava approval is ready/i);
  assert.match(replies.at(-1) as string, /Nothing has been purchased yet/i);
  assert.doesNotMatch(replies.join("\n"), /Boston|—/);

  assert.equal(commerceRequests.length, 1);
  assert.equal(commerceRequests[0]?.address.id, LIVE_ADDRESS.id);
  assert.equal(commerceRequests[0]?.essentials.shipsTo, "AE");
  assert.equal(commerceRequests[0]?.essentials.tShirtSize, "M");
  assert.equal(commerceRequests[0]?.incident.airline, null);
  assert.equal(commerceRequests[0]?.incident.arrivalAirport, null);
  assert.equal(commerceRequests[0]?.incident.baggageReference, null);
  assert.equal(
    Object.prototype.hasOwnProperty.call(commerceRequests[0], "deliveryAddress"),
    false,
  );

  const presentation = generator.consumePresentation("chat-live");
  assert.ok(presentation?.appCard);
  assert.equal(presentation.productMedia, undefined);
  assert.equal(presentation.appCard.layout.caption, "Abu Dhabi Essentials");
  assert.equal(presentation.appCard.layout.trailingCaption, "AED 65.10");
  assert.equal(presentation.appCard.layout.trailingSubcaption, "Approval pending");
  assert.equal(
    presentation.appCard.layout.imageUrl,
    "https://tavra.example/api/prava/checkouts/live-checkout-1/products/0/image",
  );
  assert.doesNotMatch(
    JSON.stringify(presentation.appCard),
    /cdn\.merchant\.example|—/,
  );

  const sensitiveAddress =
    "Mohamed bin Zayed University of Artificial Intelligence, Masdar City, Abu Dhabi";
  assert.doesNotMatch(JSON.stringify(modelRequests), new RegExp(sensitiveAddress));
  assert.doesNotMatch(
    JSON.stringify(interpreterHistories),
    new RegExp(sensitiveAddress),
  );
});

test("refuses live discovery when the confirmed destination has no matching linked address", async () => {
  const calls: string[] = [];
  const generator = createOpenAIReplyGenerator(
    replyClient([]),
    "reply-model",
    fixedKnowledge(),
    fixedRouter(),
    fixedInterpreter(recoveryUpdates()),
    undefined,
    {
      liveCommerce: liveCommerceStub({
        addresses: [
          {
            ...LIVE_ADDRESS,
            id: "addr-london",
            label: "London office",
            summary: "Westminster, London, GB",
            country: "GB",
          },
        ],
        calls,
        authorizationIds: [],
        requests: [],
      }),
    },
  );
  const send = (message: string, revision: number) =>
    generator.generateReply({
      message,
      senderHandle: "+971501234567",
      chatId: "chat-no-address",
      turn: turn(revision),
    });

  await send("My baggage got delayed", 1);
  await send("Yes, Abu Dhabi by 8 AM tomorrow", 2);
  await send("Confirmed, inseam 30", 3);
  await send("MBZUAI campus, Masdar City, Abu Dhabi", 4);
  const reply = await send("Yes", 5);

  assert.deepEqual(calls, ["listAddresses"]);
  assert.match(reply, /can’t match it to one existing masked address/i);
  assert.match(reply, /won’t invent a postal code/i);
  assert.doesNotMatch(reply, /Boston|sandbox|—/i);
  assert.equal(generator.consumePresentation("chat-no-address"), null);
});

test("restores the deterministic recovery stage after a server restart", async () => {
  const state = new InMemoryRecoveryStateStore();
  const first = createOpenAIReplyGenerator(
    fixedReplyClient(
      "Sorry that happened. I can help with replacement essentials and the baggage claim. Do you want clothing and toiletries, and where and when should they arrive?",
    ),
    "reply-model",
    fixedKnowledge(),
    fixedRouter(),
    fixedInterpreter([]),
    undefined,
    { recoveryStateStore: state },
  );
  await first.generateReply({
    message: "My baggage got delayed",
    senderHandle: "+971501234567",
    chatId: "chat-restart",
    turn: turn(1),
  });

  const restarted = createOpenAIReplyGenerator(
    fixedReplyClient(
      "Got it. Here are the sizes on file:\n\n• T-shirt: M\n• Trouser waist: 32\n• Trouser inseam: not on file\n\nCan you confirm M and 32 and tell me your inseam?",
    ),
    "reply-model",
    fixedKnowledge(),
    fixedRouter(),
    fixedInterpreter([
      {
        ...EMPTY_UPDATE,
        action: "provide_recovery_context",
        wantsEssentials: true,
        deliveryArea: "Abu Dhabi",
        needBy: "8 AM tomorrow",
      },
    ]),
    undefined,
    { recoveryStateStore: state },
  );
  const reply = await restarted.generateReply({
    message: "Yes, Abu Dhabi by 8 AM tomorrow",
    senderHandle: "+971501234567",
    chatId: "chat-restart",
    turn: turn(2),
  });
  assert.match(reply, /T-shirt: M/);
  assert.match(reply, /Trouser inseam: not on file/);
  assert.doesNotMatch(reply, /Sorry that happened|Boston|—/);
  const persisted = await state.load<{ stage: string }>("chat-restart");
  assert.equal(persisted?.stage, "awaiting_size_confirmation");
});
