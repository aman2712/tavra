import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type OpenAI from "openai";
import { createSandboxAirlineClaimSubmissionProvider } from "../src/airline-claim.js";
import type {
  CreatePravaCheckoutRequest,
  PravaCheckoutProvider,
} from "../src/prava.js";
import type {
  MedduOffer,
  MedduUcpClient,
} from "../src/sandbox-merchant.js";
import { createProductMediaResolver } from "../src/product-media.js";
import {
  JsonlRecoveryCaseLedger,
  resolveAirlineSubmissionTarget,
  type RecoveryCaseRecord,
} from "../src/recovery-case.js";
import { InMemoryRecoveryStateStore } from "../src/recovery-state-store.js";

import {
  createOpenAIIntentRouter,
  createOpenAIRecoveryTurnInterpreter,
  createOpenAIReplyGenerator,
  type ConversationTurn,
  type IntentRouter,
  type RecoveryTurnInterpreter,
  type RecoveryTurnUpdate,
  TAVRA_RECOVERY_INTERPRETER_INSTRUCTIONS,
  TAVRA_ROUTER_INSTRUCTIONS,
  type TavraIntent,
  UNKNOWN_EMPLOYEE_REPLY,
} from "../src/openai.js";
import type {
  KnowledgeScope,
  SensoKnowledgeProvider,
  SensoRecoveryOutcome,
} from "../src/senso.js";

const CONTEXT_REPLY =
  "Sorry, that’s a pain. I can help with replacement essentials and organize the baggage claim. Do you want basic clothing and toiletries, and where and when should they arrive?";
const SIZE_REPLY =
  "I can help with that. My knowledge base has these sizes on file:\n\n• T-shirt: M\n• Trouser waist: 32\n• Trouser inseam: not on file\n\nCan you confirm M and 32 and tell me your inseam?";
const OPTION_REPLY =
  "Perfect, thanks. Here’s the policy-matched recovery option:\n\n• T-shirt: M\n• Trousers: 32x30\n• Toiletries: essential kit\n• Delivery: estimated before 07:00 local time\n• Total: $154 of your $175 allowance\n\nWant to change anything?";
const INCIDENT_REPLY =
  "Perfect, I’ll keep that option as-is. I just need:\n\n• Airline\n• Arrival airport\n• Baggage reference, if you have one\n\nWhat should I put down?";
const AIRLINE_REFERENCE_REPLY =
  "Thanks, I have JFK. I still need:\n\n• Airline\n• Baggage reference, if you have one\n\nWhat should I put down?";

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

function requireRequest(value: Record<string, unknown> | null): Record<string, unknown> {
  assert.ok(value, "expected an OpenAI request");
  return value;
}

function fixedRouter(intent: TavraIntent): IntentRouter {
  return {
    async classify() {
      return intent;
    },
  };
}

function fixedInterpreter(
  updates: RecoveryTurnUpdate[] = [],
  onHistory?: (history: ConversationTurn[]) => void,
): RecoveryTurnInterpreter {
  let index = 0;
  return {
    async interpret({ history }) {
      onHistory?.(history);
      return updates[index++] ?? EMPTY_UPDATE;
    },
  };
}

function knowledgeProvider(
  onScope?: (scope: KnowledgeScope) => void,
): SensoKnowledgeProvider {
  return {
    async getKnowledge(_sender, _message, scope) {
      onScope?.(scope);
      const profile = [
        "Work email: employee@example.com.",
        "T-shirt size: M.",
        "Trouser waist: 32 inches.",
        "Trouser inseam: unknown.",
      ].join(" ");
      return {
        companyId: "northstar_demo",
        employeeId: "emp_demo_001",
        context:
          scope === "profile"
            ? profile
            : [
                profile,
                "Incident allowance: USD 175.",
                "Rejected option quoted total: USD 132. Eligibility: Not eligible.",
                "Eligible option quoted total: USD 154. Eligibility: Eligible after confirmation.",
                "Items: neutral T-shirt, trousers, and essential toiletries.",
                "Delivery promise: before 07:00 local time.",
              ].join(" "),
        contentIds: scope === "profile" ? ["profile-id"] : ["profile-id", "policy-id"],
      };
    },
  };
}

function bostonCatalogKnowledgeProvider(): SensoKnowledgeProvider {
  const provider = knowledgeProvider();
  return {
    async getKnowledge(sender, message, scope) {
      const knowledge = await provider.getKnowledge(sender, message, scope);
      if (!knowledge || scope === "profile") return knowledge;
      return {
        ...knowledge,
        context: `Boston Delayed-Baggage Demo Catalog. ${knowledge.context}`,
      };
    },
  };
}

function sequenceClient(outputs: string[], requests?: Record<string, unknown>[]): OpenAI {
  let index = 0;
  return {
    responses: {
      async create(value: Record<string, unknown>) {
        requests?.push(value);
        return { output_text: outputs[index++] ?? outputs.at(-1) ?? "" };
      },
    },
  } as unknown as OpenAI;
}

function scriptedClient(
  outputs: Array<string | Error | Record<string, unknown>>,
  requests?: Record<string, unknown>[],
): OpenAI {
  let index = 0;
  return {
    responses: {
      async create(value: Record<string, unknown>) {
        requests?.push(value);
        const output = outputs[index++] ?? outputs.at(-1) ?? "";
        if (output instanceof Error) throw output;
        if (typeof output === "string") return { output_text: output };
        return output;
      },
    },
  } as unknown as OpenAI;
}

function knowledgeProviderWithSizes(sizes: {
  tshirtSize: string | null;
  trouserWaist: string | null;
  trouserInseam: string | null;
}): SensoKnowledgeProvider {
  const profile = [
    "Work email: employee@example.com.",
    `T-shirt size: ${sizes.tshirtSize ?? "unknown"}.`,
    `Trouser waist: ${sizes.trouserWaist ?? "unknown"}.`,
    `Trouser inseam: ${sizes.trouserInseam ?? "unknown"}.`,
  ].join(" ");
  return {
    async getKnowledge(_sender, _message, scope) {
      return {
        companyId: "northstar_demo",
        employeeId: "emp_demo_001",
        context:
          scope === "profile"
            ? profile
            : [
                profile,
                "Incident allowance: USD 175.",
                "Eligible option quoted total: USD 154. Eligibility: Eligible after confirmation.",
                "Items: neutral T-shirt, trousers, and essential toiletries.",
                "Delivery promise: before 07:00 local time.",
              ].join(" "),
        contentIds: ["profile-id"],
      };
    },
  };
}

test("fast-routes a simple greeting without an OpenAI classification call", async () => {
  const client = {
    responses: {
      async create() {
        throw new Error("classification should not be called");
      },
    },
  } as unknown as OpenAI;
  const router = createOpenAIIntentRouter(client, "router-model");

  assert.equal(await router.classify({ message: "Hi", history: [] }), "social");
});

test("uses structured output for ambiguous intent classification", async () => {
  let request: Record<string, unknown> | null = null;
  const client = {
    responses: {
      async create(value: Record<string, unknown>) {
        request = value;
        return { output_text: '{"intent":"policy"}' };
      },
    },
  } as unknown as OpenAI;
  const router = createOpenAIIntentRouter(client, "router-model");

  assert.equal(
    await router.classify({ message: "What can I spend?", history: [] }),
    "policy",
  );
  const captured = requireRequest(request);
  assert.equal(captured.model, "router-model");
  assert.equal(captured.instructions, TAVRA_ROUTER_INSTRUCTIONS);
  assert.equal(
    (captured.text as { format?: { type?: string } }).format?.type,
    "json_schema",
  );
});

test("falls back to conservative local intent routing when OpenAI routing fails", async () => {
  const client = scriptedClient([new Error("router unavailable")]);
  const router = createOpenAIIntentRouter(client, "router-model");

  assert.equal(
    await router.classify({ message: "My baggage is delayed", history: [] }),
    "team_recovery",
  );
  assert.equal(
    await router.classify({ message: "What is my reimbursement allowance?", history: [] }),
    "policy",
  );
  assert.equal(
    await router.classify({ message: "Write me a poem", history: [] }),
    "out_of_scope",
  );
});

test("uses structured output to interpret an active recovery turn", async () => {
  let request: Record<string, unknown> | null = null;
  const client = {
    responses: {
      async create(value: Record<string, unknown>) {
        request = value;
        return {
          output_text: JSON.stringify({
            action: "confirm_sizes",
            confirms_on_file_sizes: true,
            tshirt_size: null,
            trouser_waist: null,
            trouser_inseam: "30",
            airline: "null",
            arrival_airport: null,
            baggage_reference: "unknown",
            wants_essentials: null,
            need_by: null,
            delivery_area: null,
            delivery_address: null,
            confirms_delivery_address: false,
          }),
        };
      },
    },
  } as unknown as OpenAI;
  const interpreter = createOpenAIRecoveryTurnInterpreter(client, "router-model");

  const update = await interpreter.interpret({
    message: "Yes, those are right. Inseam 30.",
    history: [],
    stage: "awaiting_size_confirmation",
    currentSizes: {
      tshirtSize: "M",
      trouserWaist: "32",
      trouserInseam: null,
    },
  });

  assert.equal(update.confirmsOnFileSizes, true);
  assert.equal(update.trouserInseam, "30");
  assert.equal(update.airline, null);
  assert.equal(update.baggageReference, null);
  const captured = requireRequest(request);
  assert.equal(captured.instructions, TAVRA_RECOVERY_INTERPRETER_INSTRUCTIONS);
  assert.equal(
    (captured.text as { format?: { type?: string } }).format?.type,
    "json_schema",
  );
});

test("falls back to conservative local recovery parsing when structured output fails", async () => {
  const interpreter = createOpenAIRecoveryTurnInterpreter(
    scriptedClient([{ output_text: "not json" }]),
    "router-model",
  );
  const currentSizes = {
    tshirtSize: "M",
    trouserWaist: "32",
    trouserInseam: null,
  };
  const interpret = (message: string, stage: Parameters<RecoveryTurnInterpreter["interpret"]>[0]["stage"]) =>
    interpreter.interpret({ message, history: [], stage, currentSizes });

  const context = await interpret(
    "Yes, clothing in Boston before 8 AM",
    "awaiting_recovery_context",
  );
  assert.equal(context.action, "provide_recovery_context");
  assert.equal(context.wantsEssentials, true);
  assert.equal(context.deliveryArea, "Boston");
  assert.match(context.needBy ?? "", /8 AM/i);

  const sizes = await interpret(
    "M and waist 32 are correct, inseam is 30",
    "awaiting_size_confirmation",
  );
  assert.equal(sizes.action, "confirm_sizes");
  assert.equal(sizes.confirmsOnFileSizes, true);
  assert.equal(sizes.trouserInseam, "30");

  const option = await interpret("Nah, looks good", "awaiting_bundle_review");
  assert.equal(option.action, "accept_bundle");

  const incident = await interpret(
    "Airline: Delta\nAirport: BOS\nBaggage reference: RF392942",
    "awaiting_incident_details",
  );
  assert.equal(incident.action, "provide_incident_details");
  assert.equal(incident.airline, "Delta");
  assert.equal(incident.arrivalAirport, "BOS");
  assert.equal(incident.baggageReference, "RF392942");
});

test("answers a greeting naturally without querying Senso", async () => {
  let request: Record<string, unknown> | null = null;
  const client = {
    responses: {
      async create(value: Record<string, unknown>) {
        request = value;
        return { output_text: "Hi — how can I help with your work trip?" };
      },
    },
  } as unknown as OpenAI;
  const provider: SensoKnowledgeProvider = {
    async getKnowledge() {
      throw new Error("Senso should not be called for a greeting");
    },
  };
  const generator = createOpenAIReplyGenerator(
    client,
    "reply-model",
    provider,
    fixedRouter("social"),
    fixedInterpreter(),
  );

  const reply = await generator.generateReply({
    message: "Hi",
    senderHandle: "+919876543210",
    chatId: "chat-social",
  });

  assert.equal(reply, "Hi - how can I help with your work trip?");
  assert.doesNotMatch(reply, /—/);
  const captured = requireRequest(request);
  assert.match(String(captured.instructions), /current message is social/i);
  assert.doesNotMatch(String(captured.input), /company context/i);
});

test("a bare baggage delay asks for the recovery goal without inventing a meeting", async () => {
  const scopes: KnowledgeScope[] = [];
  const requests: Record<string, unknown>[] = [];
  const generator = createOpenAIReplyGenerator(
    sequenceClient([CONTEXT_REPLY], requests),
    "reply-model",
    knowledgeProvider((scope) => scopes.push(scope)),
    fixedRouter("team_recovery"),
    fixedInterpreter(),
  );

  const reply = await generator.generateReply({
    message: "My baggage is delayed",
    senderHandle: "+919876543210",
    chatId: "chat-grounded-intake",
  });

  assert.deepEqual(scopes, ["profile"]);
  assert.equal(reply, CONTEXT_REPLY);
  assert.match(reply, /replacement essentials/i);
  assert.match(reply, /where and when/i);
  assert.doesNotMatch(reply, /meeting|Boston|T-shirt: M|waist|\$154|allowance/i);
  assert.doesNotMatch(String(requests[0]?.input), /Work email|T-shirt size|Incident allowance/i);
});

test("does not source until goal, area, deadline, and sizes are confirmed", async () => {
  const scopes: KnowledgeScope[] = [];
  const generator = createOpenAIReplyGenerator(
    sequenceClient([CONTEXT_REPLY, SIZE_REPLY, OPTION_REPLY]),
    "reply-model",
    knowledgeProvider((scope) => scopes.push(scope)),
    fixedRouter("team_recovery"),
    fixedInterpreter([
      { ...EMPTY_UPDATE, action: "provide_recovery_context", wantsEssentials: true },
      {
        ...EMPTY_UPDATE,
        action: "provide_recovery_context",
        wantsEssentials: true,
        deliveryArea: "Boston",
        needBy: "8:00 AM",
      },
      {
        ...EMPTY_UPDATE,
        action: "confirm_sizes",
        confirmsOnFileSizes: true,
        trouserInseam: "30",
      },
    ]),
  );
  const turn = (message: string) =>
    generator.generateReply({
      message,
      senderHandle: "+919876543210",
      chatId: "chat-policy-gates",
    });

  await turn("My baggage is delayed");
  const missingContext = await turn("Yes, please");
  assert.match(missingContext, /where.*when|where should.*when/i);
  assert.deepEqual(scopes, ["profile"]);

  const sizes = await turn("Boston, before 8 AM");
  assert.equal(sizes, SIZE_REPLY);
  assert.deepEqual(scopes, ["profile"]);

  const option = await turn("M and 32 are right. Inseam 30");
  assert.equal(option, OPTION_REPLY);
  assert.deepEqual(scopes, ["profile", "team_recovery"]);
});

test("only an explicit stop command cancels recovery even when the interpreter is unclear", async () => {
  const generator = createOpenAIReplyGenerator(
    sequenceClient([CONTEXT_REPLY, SIZE_REPLY]),
    "reply-model",
    knowledgeProvider(),
    fixedRouter("team_recovery"),
    fixedInterpreter([
      {
        ...EMPTY_UPDATE,
        action: "provide_recovery_context",
        wantsEssentials: true,
        deliveryArea: "Boston",
        needBy: "8:00 AM",
      },
      EMPTY_UPDATE,
    ]),
  );
  const turn = (message: string) =>
    generator.generateReply({
      message,
      senderHandle: "+919876543210",
      chatId: "chat-explicit-stop",
    });

  await turn("My baggage is delayed");
  await turn("Yes, Boston by 8 AM");
  const stopped = await turn("stop");
  assert.match(stopped, /stop here/i);
  assert.match(stopped, /nothing has been ordered or submitted/i);
});

test("keeps an arbitrary destination without exposing or forcing the catalog city", async () => {
  const generator = createOpenAIReplyGenerator(
    sequenceClient([CONTEXT_REPLY, SIZE_REPLY, OPTION_REPLY]),
    "reply-model",
    bostonCatalogKnowledgeProvider(),
    fixedRouter("team_recovery"),
    fixedInterpreter([
      {
        ...EMPTY_UPDATE,
        action: "provide_recovery_context",
        wantsEssentials: true,
        needBy: "before 7 AM",
      },
      {
        ...EMPTY_UPDATE,
        action: "provide_recovery_context",
        deliveryArea: "Abu Dhabi",
      },
      {
        ...EMPTY_UPDATE,
        action: "confirm_sizes",
        confirmsOnFileSizes: true,
        trouserInseam: "30",
      },
      { ...EMPTY_UPDATE, action: "accept_bundle" },
    ]),
  );
  const turn = (message: string) =>
    generator.generateReply({
      message,
      senderHandle: "+919876543210",
      chatId: "chat-location-neutral-sandbox",
    });

  await turn("My baggage got delayed");
  await turn("Yeah, before 7am");
  await turn("Abu Dhabi");
  const option = await turn("Confirmed. 30.");
  assert.match(option, /recovery option/i);
  assert.match(option, /Delivery: being confirmed for your requested destination/i);
  assert.match(option, /• Total: \$154 of your \$175 allowance/i);
  assert.doesNotMatch(option, /Boston|before 7|sandbox|simulat|no live/i);

  const addressPrompt = await turn("Looks good");
  assert.match(addressPrompt, /Where should I send it/i);
  assert.doesNotMatch(addressPrompt, /Boston/i);
});

test("migrates a persisted city-switch session without repeating or exposing the old loop", async () => {
  const recoveryStateStore = new InMemoryRecoveryStateStore();
  const chatId = "chat-retired-sandbox-city-gate";
  await recoveryStateStore.save(chatId, {
    caseId: "RCV-LEGACY1",
    senderHandle: "+919876543210",
    startedAt: Date.now(),
    stage: "awaiting_recovery_context",
    employeeId: "emp_demo_001",
    employeeAllowance: null,
    originalMessage: "My baggage got delayed",
    sizes: { tshirtSize: "M", trouserWaist: "32", trouserInseam: "30" },
    confirmed: { tshirtSize: true, trouserWaist: true, trouserInseam: true },
    airline: null,
    arrivalAirport: null,
    baggageReference: null,
    noticeEvidence: null,
    noticeConfirmed: false,
    wantsEssentials: true,
    needBy: "before 8 AM",
    needByIso: null,
    deliveryArea: null,
    catalogAreaRequired: "Boston",
    deliveryAddress: null,
    deliveryAddressSource: null,
    deliveryAddressConfirmed: false,
    locationRequestedAt: null,
    email: "employee@example.com",
    emailConfirmed: false,
    optionTotal: null,
    proposedProducts: null,
    checkout: null,
    liveAddress: null,
    liveOffer: null,
    liveQuote: null,
    liveRejectedVariantIds: [],
    liveResumeAfterIncident: false,
    livePurchaseAuthorizationEventId: null,
  });
  const generator = createOpenAIReplyGenerator(
    sequenceClient([OPTION_REPLY]),
    "reply-model",
    bostonCatalogKnowledgeProvider(),
    fixedRouter("team_recovery"),
    fixedInterpreter([
      {
        ...EMPTY_UPDATE,
        action: "provide_recovery_context",
        deliveryArea: "Abu Dhabi",
      },
    ]),
    undefined,
    { recoveryStateStore },
  );

  const reply = await generator.generateReply({
    message: "Abu Dhabi",
    senderHandle: "+919876543210",
    chatId,
  });

  assert.match(reply, /Delivery: being confirmed for your requested destination/i);
  assert.doesNotMatch(reply, /Boston|sandbox|simulat|no live/i);
  const migrated = await recoveryStateStore.load<{
    catalogAreaRequired: string | null;
    deliveryArea: string | null;
  }>(chatId);
  assert.equal(migrated?.catalogAreaRequired, null);
  assert.equal(migrated?.deliveryArea, "Abu Dhabi");
});

test("repairs a persisted privacy placeholder before payment approval", async () => {
  const recoveryStateStore = new InMemoryRecoveryStateStore();
  const checkouts: CreatePravaCheckoutRequest[] = [];
  const chatId = "chat-corrupt-private-address";
  await recoveryStateStore.save(chatId, {
    caseId: "RCV-PRIVATE1",
    senderHandle: "+919876543210",
    startedAt: Date.now(),
    stage: "awaiting_payment_authorization",
    employeeId: "emp_demo_001",
    employeeAllowance: null,
    originalMessage: "My baggage got delayed",
    sizes: { tshirtSize: "M", trouserWaist: "32", trouserInseam: "30" },
    confirmed: { tshirtSize: true, trouserWaist: true, trouserInseam: true },
    airline: "Emirates",
    arrivalAirport: "AUH",
    baggageReference: "RF4929",
    noticeEvidence: null,
    noticeConfirmed: false,
    wantsEssentials: true,
    needBy: "8:00 AM tomorrow",
    needByIso: null,
    deliveryArea: "Abu Dhabi",
    catalogAreaRequired: null,
    deliveryAddress: "[delivery address omitted]",
    deliveryAddressSource: "message",
    deliveryAddressConfirmed: false,
    locationRequestedAt: Date.now(),
    email: "employee@example.com",
    emailConfirmed: true,
    optionTotal: "154.00",
    proposedProducts: [
      {
        productRef: "demo-recovery-essentials",
        description: "Recovery essentials",
        unitPrice: "154.00",
        quantity: 1,
      },
    ],
    checkout: null,
    liveAddress: null,
    liveOffer: null,
    liveQuote: null,
    liveRejectedVariantIds: [],
    liveResumeAfterIncident: false,
    livePurchaseAuthorizationEventId: null,
  });
  const generator = createOpenAIReplyGenerator(
    sequenceClient([]),
    "reply-model",
    knowledgeProvider(),
    fixedRouter("team_recovery"),
    fixedInterpreter(),
    {
      async createCheckout(request) {
        checkouts.push(request);
        return {
          checkoutId: "checkout-should-not-exist",
          url: "https://tavra.example/pay/checkout-should-not-exist",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
    },
    { recoveryStateStore },
  );

  const reply = await generator.generateReply({
    message: "Yes",
    senderHandle: "+919876543210",
    chatId,
  });

  assert.match(reply, /Where should I send it/i);
  assert.doesNotMatch(reply, /temporary issue|delivery address omitted/i);
  assert.equal(checkouts.length, 0);
  const repaired = await recoveryStateStore.load<{
    stage: string;
    deliveryAddress: string | null;
    deliveryAddressConfirmed: boolean;
  }>(chatId);
  assert.equal(repaired?.stage, "awaiting_delivery_address");
  assert.equal(repaired?.deliveryAddress, null);
  assert.equal(repaired?.deliveryAddressConfirmed, false);
});

test("offers claim-only help without asking the employee to relocate", async () => {
  const generator = createOpenAIReplyGenerator(
    sequenceClient([CONTEXT_REPLY, SIZE_REPLY, OPTION_REPLY]),
    "reply-model",
    bostonCatalogKnowledgeProvider(),
    fixedRouter("team_recovery"),
    fixedInterpreter([
      {
        ...EMPTY_UPDATE,
        action: "provide_recovery_context",
        wantsEssentials: true,
        needBy: "before 7 AM",
      },
      {
        ...EMPTY_UPDATE,
        action: "provide_recovery_context",
        deliveryArea: "Abu Dhabi",
      },
      {
        ...EMPTY_UPDATE,
        action: "confirm_sizes",
        confirmsOnFileSizes: true,
        trouserInseam: "30",
      },
      { ...EMPTY_UPDATE, action: "accept_bundle" },
      {
        ...EMPTY_UPDATE,
        action: "provide_incident_details",
        airline: "Delta",
        arrivalAirport: "JFK",
        baggageReference: "RF392942",
      },
    ]),
  );
  const turn = (message: string) =>
    generator.generateReply({
      message,
      senderHandle: "+919876543210",
      chatId: "chat-catalog-claim-only",
    });

  await turn("My baggage got delayed");
  await turn("Yeah, before 7am");
  await turn("Abu Dhabi");
  await turn("Confirmed. 30.");
  await turn("Looks good");
  const claimPrompt = await turn("Claim only");
  assert.match(claimPrompt, /won.t continue with the purchase flow/i);
  assert.match(claimPrompt, /baggage-claim evidence/i);
  assert.match(claimPrompt, /• Airline/);
  assert.doesNotMatch(claimPrompt, /Boston|sandbox|simulat|no live/i);

  const draft = await turn("Delta, JFK, RF392942");
  assert.match(draft, /claim draft/i);
  assert.match(draft, /• Airline: Delta/);
  assert.match(draft, /• Arrival airport: JFK/);
  assert.match(draft, /No claim has been submitted/i);
});

test("refuses a catalog estimate that does not meet the employee deadline", async () => {
  const generator = createOpenAIReplyGenerator(
    sequenceClient([CONTEXT_REPLY, SIZE_REPLY, OPTION_REPLY]),
    "reply-model",
    knowledgeProvider(),
    fixedRouter("team_recovery"),
    fixedInterpreter([
      {
        ...EMPTY_UPDATE,
        action: "provide_recovery_context",
        wantsEssentials: true,
        deliveryArea: "Boston",
        needBy: "6:00 AM",
      },
      {
        ...EMPTY_UPDATE,
        action: "confirm_sizes",
        confirmsOnFileSizes: true,
        trouserInseam: "30",
      },
      {
        ...EMPTY_UPDATE,
        action: "provide_recovery_context",
        needBy: "8:00 AM",
      },
    ]),
  );
  const turn = (message: string) =>
    generator.generateReply({
      message,
      senderHandle: "+919876543210",
      chatId: "chat-deadline",
    });

  await turn("My baggage is delayed");
  await turn("Yes, Boston by 6 AM");
  const rejected = await turn("M and 32 are right. Inseam 30");
  assert.match(rejected, /does not reliably meet 6:00 AM/i);
  assert.match(rejected, /won.t present it as suitable/i);
  assert.doesNotMatch(rejected, /Anything you.d like to change/i);

  const option = await turn("8 AM can work");
  assert.equal(option, OPTION_REPLY);
});

test("collects and confirms an exact delivery address before incident or payment details", async () => {
  const generator = createOpenAIReplyGenerator(
    sequenceClient([CONTEXT_REPLY, SIZE_REPLY, OPTION_REPLY, INCIDENT_REPLY]),
    "reply-model",
    knowledgeProvider(),
    fixedRouter("team_recovery"),
    fixedInterpreter([
      {
        ...EMPTY_UPDATE,
        action: "provide_recovery_context",
        wantsEssentials: true,
        deliveryArea: "Boston",
        needBy: "8:00 AM",
      },
      {
        ...EMPTY_UPDATE,
        action: "confirm_sizes",
        confirmsOnFileSizes: true,
        trouserInseam: "30",
      },
      { ...EMPTY_UPDATE, action: "accept_bundle" },
      {
        ...EMPTY_UPDATE,
        action: "provide_incident_details",
        airline: "Emirates",
        arrivalAirport: "AUH",
        baggageReference: "RF392942",
      },
    ]),
  );
  const turn = (message: string) =>
    generator.generateReply({
      message,
      senderHandle: "+919876543210",
      chatId: "chat-delivery",
    });

  await turn("My baggage is delayed");
  await turn("Yes. Boston by 8 AM");
  await turn("M and 32 are right, inseam 30");
  const addressPrompt = await turn("Looks good");
  assert.match(addressPrompt, /full street or hotel address/i);
  assert.doesNotMatch(addressPrompt, /airline|payment|ordered/i);

  const proposal = await turn("1 Hotel Drive, Boston, MA, front desk");
  assert.match(proposal, /1 Hotel Drive/);
  assert.match(proposal, /exact delivery address/i);

  const incidentPrompt = await turn("Yes, add room 308");
  assert.equal(incidentPrompt, INCIDENT_REPLY);

  const summary = await turn("Emirates, AUH, RF392942");
  assert.match(summary, /Deliver to: 1 Hotel Drive, Boston, MA, front desk, Room 308/i);
});

test("automatically proposes a fresh address when Linq reports location sharing", async () => {
  const activity: string[] = [];
  const generator = createOpenAIReplyGenerator(
    sequenceClient([CONTEXT_REPLY, SIZE_REPLY, OPTION_REPLY]),
    "reply-model",
    knowledgeProvider(),
    fixedRouter("team_recovery"),
    fixedInterpreter([
      {
        ...EMPTY_UPDATE,
        action: "provide_recovery_context",
        wantsEssentials: true,
        deliveryArea: "Boston",
        needBy: "8:00 AM",
      },
      {
        ...EMPTY_UPDATE,
        action: "confirm_sizes",
        confirmsOnFileSizes: true,
        trouserInseam: "30",
      },
      { ...EMPTY_UPDATE, action: "accept_bundle" },
      EMPTY_UPDATE,
      EMPTY_UPDATE,
    ]),
    undefined,
    {
      locationProvider: {
        async request() {
          activity.push("request");
        },
        async getCurrent() {
          activity.push("retrieve");
          return {
            address: "10 Beacon Street, Boston, MA",
            locality: "Boston",
            coordinates: [-71.06, 42.36],
            updatedAt: new Date().toISOString(),
          };
        },
      },
    },
  );
  const turn = (message: string) =>
    generator.generateReply({
      message,
      senderHandle: "+919876543210",
      chatId: "chat-location",
    });

  await turn("My baggage is delayed");
  await turn("Yes, Boston by 8 AM");
  await turn("Sizes are right, inseam 30");
  await turn("Looks good");
  const requested = await turn("Share my location");
  assert.match(requested, /location request/i);
  assert.equal(
    generator.chatForLocationShare("+91 98765 43210"),
    "chat-location",
  );
  const proposal = await generator.generateLocationShareReply({
    chatId: "chat-location",
    senderHandle: "+919876543210",
    eventAt: new Date().toISOString(),
  });
  assert.ok(proposal);
  assert.match(proposal, /10 Beacon Street/);
  assert.match(proposal, /is this the exact delivery address/i);
  assert.deepEqual(activity, ["request", "retrieve"]);
  assert.equal(generator.chatForLocationShare("+919876543210"), null);
});

test("retries a delayed Linq location when the employee replies shared", async () => {
  const activity: string[] = [];
  let reads = 0;
  const generator = createOpenAIReplyGenerator(
    sequenceClient([CONTEXT_REPLY, SIZE_REPLY, OPTION_REPLY]),
    "reply-model",
    knowledgeProvider(),
    fixedRouter("team_recovery"),
    fixedInterpreter([
      {
        ...EMPTY_UPDATE,
        action: "provide_recovery_context",
        wantsEssentials: true,
        deliveryArea: "Abu Dhabi",
        needBy: "8:00 AM tomorrow",
      },
      {
        ...EMPTY_UPDATE,
        action: "confirm_sizes",
        confirmsOnFileSizes: true,
        trouserInseam: "30",
      },
      { ...EMPTY_UPDATE, action: "accept_bundle" },
    ]),
    undefined,
    {
      locationProvider: {
        async request() {
          activity.push("request");
        },
        async getCurrent() {
          reads += 1;
          activity.push(`retrieve-${reads}`);
          if (reads === 1) return null;
          return {
            address: "Solar Building, MBZUAI, Masdar City, Abu Dhabi",
            locality: "Abu Dhabi",
            coordinates: [54.616, 24.431] as [number, number],
            updatedAt: new Date().toISOString(),
          };
        },
      },
    },
  );
  const turn = (message: string) =>
    generator.generateReply({
      message,
      senderHandle: "+919876543210",
      chatId: "chat-location-shared-retry",
    });

  await turn("My baggage is delayed");
  await turn("Yes, Abu Dhabi by 8 AM tomorrow");
  await turn("Sizes are right, inseam 30");
  await turn("Looks good");
  await turn("Share my location");
  const proposal = await turn("Shared");

  assert.match(proposal, /Solar Building, MBZUAI/i);
  assert.match(proposal, /exact delivery address/i);
  assert.deepEqual(activity, ["request", "retrieve-1", "retrieve-2"]);
  assert.equal(generator.chatForLocationShare("+919876543210"), null);
});

test("creates one address-bound checkout and exposes the Prava URL as a rich link", async () => {
  const checkouts: CreatePravaCheckoutRequest[] = [];
  const checkoutProvider: PravaCheckoutProvider = {
    async createCheckout(request) {
      checkouts.push(request);
      return {
        checkoutId: "checkout-test",
        url: "https://tavra.example/pay/checkout-test",
        expiresAt: "2026-08-01T12:15:00.000Z",
      };
    },
  };
  const generator = createOpenAIReplyGenerator(
    sequenceClient([CONTEXT_REPLY, SIZE_REPLY, OPTION_REPLY, INCIDENT_REPLY]),
    "reply-model",
    knowledgeProvider(),
    fixedRouter("team_recovery"),
    fixedInterpreter([
      {
        ...EMPTY_UPDATE,
        action: "provide_recovery_context",
        wantsEssentials: true,
        deliveryArea: "Boston",
        needBy: "8:00 AM",
      },
      {
        ...EMPTY_UPDATE,
        action: "confirm_sizes",
        confirmsOnFileSizes: true,
        trouserInseam: "30",
      },
      { ...EMPTY_UPDATE, action: "accept_bundle" },
      {
        ...EMPTY_UPDATE,
        action: "provide_incident_details",
        airline: "Delta",
        arrivalAirport: "BOS",
        baggageReference: "RF392942",
        deliveryAddress: "[delivery address omitted]",
      },
    ]),
    checkoutProvider,
  );
  const turn = (message: string) =>
    generator.generateReply({
      message,
      senderHandle: "+919876543210",
      chatId: "chat-prava",
    });

  await turn("My baggage is delayed");
  assert.equal(
    await generator.generateReactionReply?.({
      chatId: "chat-prava",
      senderHandle: "+919876543210",
      targetMessageId: "not-an-approval-summary",
      eventId: "reaction-too-early",
      reactedAt: "2026-08-01T12:00:00.000Z",
    }),
    null,
  );
  await turn("Yes, Boston by 8 AM");
  await turn("M and 32 are right, inseam 30");
  await turn("Looks good");
  await turn("1 Hotel Drive, Boston, MA, front desk");
  await turn("Yes");
  const summary = await turn("Delta, BOS, RF392942");
  assert.match(summary, /exact approval summary/i);
  assert.match(summary, /1 Hotel Drive/);
  assert.match(summary, /employee@example\.com/i);
  assert.match(
    summary,
    /Reply yes or react with 👍 to create the Prava approval for this summary, or tell me what to change\./,
  );
  assert.equal(checkouts.length, 0);

  await generator.recordSentReply?.({
    chatId: "chat-prava",
    eventId: "summary-event",
    messageId: "summary-message",
    reply: summary,
  });
  assert.equal(
    await generator.generateReactionReply?.({
      chatId: "chat-prava",
      senderHandle: "+919876543210",
      targetMessageId: "older-summary-message",
      eventId: "stale-reaction",
      reactedAt: "2026-08-01T12:01:00.000Z",
    }),
    null,
  );
  assert.equal(checkouts.length, 0);

  const approval = await generator.generateReactionReply?.({
    chatId: "chat-prava",
    senderHandle: "+919876543210",
    targetMessageId: "summary-message",
    eventId: "thumbs-up-reaction",
    reactedAt: "2026-08-01T12:02:00.000Z",
  });
  assert.equal(typeof approval, "string");
  if (typeof approval !== "string") throw new Error("Expected approval reply");
  assert.match(approval, /Tap the single card below/i);
  assert.doesNotMatch(approval, /https:\/\//);
  assert.deepEqual(generator.consumePresentation?.("chat-prava"), {
    linkUrl: "https://tavra.example/pay/checkout-test",
  });
  assert.equal(checkouts.length, 1);
  assert.equal(checkouts[0]?.recovery?.deliveryAddress, "1 Hotel Drive, Boston, MA, front desk");
  assert.equal(checkouts[0]?.recovery?.airline, "Delta");
  assert.equal(checkouts[0]?.recovery?.arrivalAirport, "BOS");
  assert.equal(checkouts[0]?.recovery?.baggageReference, "RF392942");
  assert.deepEqual(
    checkouts[0]?.products.map((product) => product.unitPrice),
    ["54.00", "78.00", "22.00"],
  );
  assert.deepEqual(
    checkouts[0]?.products.map((product) => product.productRef),
    ["b-shirt-001", "b-trouser-001", "b-toiletry-001"],
  );
  assert.equal(
    await generator.generateReactionReply?.({
      chatId: "chat-prava",
      senderHandle: "+919876543210",
      targetMessageId: "summary-message",
      eventId: "second-thumbs-up-reaction",
      reactedAt: "2026-08-01T12:03:00.000Z",
    }),
    null,
  );
  assert.equal(checkouts.length, 1);
});

test("shows one combined product preview before approval without environment disclosures", async () => {
  const generator = createOpenAIReplyGenerator(
    sequenceClient([CONTEXT_REPLY, SIZE_REPLY, OPTION_REPLY]),
    "reply-model",
    knowledgeProvider(),
    fixedRouter("team_recovery"),
    fixedInterpreter([
      {
        ...EMPTY_UPDATE,
        action: "provide_recovery_context",
        wantsEssentials: true,
        deliveryArea: "Boston",
        needBy: "8:00 AM",
      },
      {
        ...EMPTY_UPDATE,
        action: "confirm_sizes",
        confirmsOnFileSizes: true,
        trouserInseam: "30",
      },
    ]),
    undefined,
    {
      productMediaResolver: createProductMediaResolver({
        publicBaseUrl: "https://tavra.example",
        assetAvailable: () => true,
      }),
    },
  );

  await generator.generateReply({
    message: "My baggage is delayed",
    senderHandle: "+919876543210",
    chatId: "chat-product-image",
  });
  assert.equal(generator.consumePresentation?.("chat-product-image"), null);
  await generator.generateReply({
    message: "Yes, Boston by 8 AM",
    senderHandle: "+919876543210",
    chatId: "chat-product-image",
  });
  await generator.generateReply({
    message: "M and 32 are right, inseam 30",
    senderHandle: "+919876543210",
    chatId: "chat-product-image",
  });
  const presentation = generator.consumePresentation?.("chat-product-image");
  assert.ok(presentation);
  assert.equal(presentation.productMedia?.length, 1);
  assert.equal(
    presentation.productMedia?.[0]?.productRef,
    "demo-recovery-essentials",
  );
  assert.match(
    presentation.productMedia?.[0]?.url ?? "",
    /\/checkout-assets\/products\/recovery-bundle\.png$/,
  );
  assert.equal(
    presentation.productMedia?.[0]?.caption,
    "Recovery essentials preview",
  );
  assert.doesNotMatch(
    presentation.productMedia?.[0]?.caption ?? "",
    /sandbox|simulat|no live/i,
  );
  assert.equal(presentation.appCard, undefined);
  assert.equal(presentation.linkUrl, undefined);
  assert.equal(generator.consumePresentation?.("chat-product-image"), null);
});

test("binds a real merchant image and address-aware AED total into Prava approval", async () => {
  const checkouts: CreatePravaCheckoutRequest[] = [];
  const checkoutProvider: PravaCheckoutProvider = {
    async createCheckout(request) {
      checkouts.push(structuredClone(request));
      return {
        checkoutId: "merchant-checkout-test",
        url: "https://tavra.example/pay/merchant-checkout-test",
        expiresAt: "2026-08-02T20:00:00.000Z",
      };
    },
  };
  const offer: MedduOffer = {
    merchant: { name: "Meddu", domain: "meddu.com", country: "AE" },
    productId: "gid://shopify/Product/123",
    variantId: "gid://shopify/ProductVariant/46624128270499",
    title: "Sensodyne Deep Clean Gel Toothpaste - 75ml",
    variantTitle: "Default Title",
    description: "Travel recovery toiletry essential",
    available: true,
    imageUrl: "https://cdn.shopify.com/s/files/1/product.jpg",
    checkoutUrl: "https://edqvrb-i5.myshopify.com/cart/46624128270499:1",
    price: { amount: "47.81", currency: "AED", minorAmount: "4781" },
    provenance: {
      source: "merchant_ucp",
      merchantDomain: "meddu.com",
      endpoint: "https://meddu.com/api/ucp/mcp",
      retrievedAt: "2026-08-02T12:00:00.000Z",
    },
  };
  let draftAddress = "";
  const sandboxMerchant: MedduUcpClient = {
    async discoverRecoveryOffer() {
      return structuredClone(offer);
    },
    async createCheckout(input) {
      return this.createCheckoutDraft(input);
    },
    async createCheckoutDraft(input) {
      draftAddress = input.shippingAddress.streetAddress;
      return {
        merchant: offer.merchant,
        offer: structuredClone(offer),
        checkoutUrl: "https://edqvrb-i5.myshopify.com/checkouts/example",
        checkoutId: "ucp-checkout-1",
        status: "incomplete",
        total: { amount: "63.81", currency: "AED", minorAmount: "6381" },
        source: "ucp_checkout",
        preparedAt: "2026-08-02T12:01:00.000Z",
      };
    },
  };
  const generator = createOpenAIReplyGenerator(
    sequenceClient([CONTEXT_REPLY, SIZE_REPLY, INCIDENT_REPLY]),
    "reply-model",
    knowledgeProvider(),
    fixedRouter("team_recovery"),
    fixedInterpreter([
      {
        ...EMPTY_UPDATE,
        action: "provide_recovery_context",
        wantsEssentials: true,
        deliveryArea: "Abu Dhabi",
        needBy: "8:00 AM tomorrow",
      },
      {
        ...EMPTY_UPDATE,
        action: "confirm_sizes",
        confirmsOnFileSizes: true,
        trouserInseam: "30",
      },
      {
        ...EMPTY_UPDATE,
        action: "accept_bundle",
      },
      {
        ...EMPTY_UPDATE,
        action: "provide_incident_details",
        airline: "Emirates",
        arrivalAirport: "AUH",
        baggageReference: "RF392942",
      },
    ]),
    checkoutProvider,
    {
      sandboxMerchant,
      productMediaResolver: createProductMediaResolver({
        publicBaseUrl: "https://tavra.example",
        liveMediaUrlAllowed: (url) => url.hostname === "cdn.shopify.com",
      }),
    },
  );
  const turn = (message: string) =>
    generator.generateReply({
      message,
      senderHandle: "+971501234567",
      chatId: "chat-real-sandbox-merchant",
    });

  await turn("My baggage is delayed");
  await turn("Yes, Abu Dhabi by 8 AM tomorrow");
  const option = await turn("M and 32 are correct, inseam 30");
  assert.match(option, /Meddu/i);
  assert.match(option, /AED 47\.81/i);
  const preview = generator.consumePresentation("chat-real-sandbox-merchant");
  assert.equal(preview?.productMedia?.[0]?.url, offer.imageUrl);
  assert.equal(preview?.productMedia?.[0]?.source.kind, "official_merchant_asset");

  await turn("Looks good");
  await turn("MBZUAI, Masdar City, Abu Dhabi, Building 1, front desk");
  await turn("Yes");
  assert.match(draftAddress, /MBZUAI/i);
  const summary = await turn("Emirates, AUH, RF392942");
  assert.match(summary, /AED 63\.81/i);
  await turn("Yes");

  assert.equal(checkouts.length, 1);
  assert.equal(checkouts[0]?.currency, "AED");
  assert.equal(checkouts[0]?.totalAmount, "63.81");
  assert.deepEqual(
    checkouts[0]?.products.map((product) => product.unitPrice),
    ["47.81", "16.00"],
  );
  assert.equal(checkouts[0]?.products[0]?.imageUrl, offer.imageUrl);
  assert.equal(
    checkouts[0]?.products[0]?.checkoutUrl,
    "https://edqvrb-i5.myshopify.com/checkouts/example",
  );
});

test("reads an image-only baggage notice and asks the employee to confirm extracted facts", async () => {
  const requests: Record<string, unknown>[] = [];
  const evidence = JSON.stringify({
    is_baggage_notice: true,
    incident_type: "delayed_baggage",
    airline: "Delta",
    arrival_airport: "BOS",
    baggage_reference: "RF392942",
    flight_number: "DL123",
    passenger_name: "Demo Traveler",
    incident_date: "2026-08-02",
    summary: "Delayed baggage notice",
    uncertain_fields: [
      "passenger_name",
      "airline",
      "flight_number",
      "arrival_airport",
      "incident_date",
      "baggage_reference",
    ],
  });
  const generator = createOpenAIReplyGenerator(
    sequenceClient([evidence], requests),
    "reply-model",
    knowledgeProvider(),
    fixedRouter("team_recovery"),
    fixedInterpreter([{ ...EMPTY_UPDATE, action: "confirm_notice" }]),
  );

  const review = await generator.generateReply({
    message: "",
    senderHandle: "+919876543210",
    chatId: "chat-image-notice",
    attachments: [
      {
        id: "attachment-1",
        filename: "notice.png",
        mimeType: "image/png",
        sizeBytes: 120_000,
        url: "https://cdn.linqapp.com/attachments/notice.png",
      },
    ],
  });
  assert.match(review, /baggage-disruption notice/i);
  assert.match(review, /• Airline: Delta/);
  assert.match(review, /• Arrival airport: BOS/);
  assert.match(review, /• Baggage reference: RF392942/);
  assert.match(review, /correct\?/i);
  assert.doesNotMatch(review, /couldn.t read with confidence/i);
  assert.doesNotMatch(review, /passenger_name|flight_number|incident_date/i);
  const input = requests[0]?.input as Array<{ content?: Array<{ type?: string }> }>;
  assert.equal(input[0]?.content?.some((part) => part.type === "input_image"), true);

  const next = await generator.generateReply({
    message: "Yes",
    senderHandle: "+919876543210",
    chatId: "chat-image-notice",
  });
  assert.match(next, /replacement essentials/i);
  assert.doesNotMatch(next, /meeting/i);
});

test("silently saves a notice during active intake without resetting the current question", async () => {
  const evidence = JSON.stringify({
    is_baggage_notice: true,
    incident_type: "delayed_baggage",
    airline: "Delta",
    arrival_airport: "BOS",
    baggage_reference: "RF392942",
    flight_number: "DL123",
    passenger_name: "Demo Traveler",
    incident_date: "2026-08-02",
    summary: "Delayed baggage notice",
    uncertain_fields: [],
  });
  const generator = createOpenAIReplyGenerator(
    sequenceClient([CONTEXT_REPLY, evidence, SIZE_REPLY]),
    "reply-model",
    knowledgeProvider(),
    fixedRouter("team_recovery"),
    fixedInterpreter([
      {
        ...EMPTY_UPDATE,
        action: "provide_recovery_context",
        wantsEssentials: true,
        deliveryArea: "Boston",
        needBy: "7:00 AM",
      },
    ]),
  );

  await generator.generateReply({
    message: "My baggage is delayed",
    senderHandle: "+919876543210",
    chatId: "chat-active-notice",
  });
  const noticeReply = await generator.generateReply({
    message: "",
    senderHandle: "+919876543210",
    chatId: "chat-active-notice",
    attachments: [
      {
        id: "attachment-active",
        filename: "notice.png",
        mimeType: "image/png",
        sizeBytes: 120_000,
        url: "https://cdn.linqapp.com/attachments/active-notice.png",
      },
    ],
  });
  assert.equal(noticeReply, "");

  const next = await generator.generateReply({
    message: "Boston by 7 AM",
    senderHandle: "+919876543210",
    chatId: "chat-active-notice",
  });
  assert.match(next, /T-shirt/i);
  assert.match(next, /trouser/i);
});

test("uses an image-only notice at incident intake and resumes with the extracted facts", async () => {
  const requests: Record<string, unknown>[] = [];
  const evidence = JSON.stringify({
    is_baggage_notice: true,
    incident_type: "delayed_baggage",
    airline: "Emirates",
    arrival_airport: "AUH",
    baggage_reference: "RF392942",
    flight_number: "EY123",
    passenger_name: "Demo Traveler",
    incident_date: "2026-08-02",
    summary: "Delayed baggage notice",
    uncertain_fields: [],
  });
  const generator = createOpenAIReplyGenerator(
    sequenceClient(
      [CONTEXT_REPLY, SIZE_REPLY, OPTION_REPLY, INCIDENT_REPLY, evidence],
      requests,
    ),
    "reply-model",
    knowledgeProvider(),
    fixedRouter("team_recovery"),
    fixedInterpreter([
      {
        ...EMPTY_UPDATE,
        action: "provide_recovery_context",
        wantsEssentials: true,
        deliveryArea: "Boston",
        needBy: "8:00 AM",
      },
      {
        ...EMPTY_UPDATE,
        action: "confirm_sizes",
        confirmsOnFileSizes: true,
        trouserInseam: "30",
      },
      { ...EMPTY_UPDATE, action: "accept_bundle" },
    ]),
  );
  const turn = (message: string) =>
    generator.generateReply({
      message,
      senderHandle: "+919876543210",
      chatId: "chat-notice-at-incident-intake",
    });

  await turn("My baggage is delayed");
  await turn("Yes, Boston by 8 AM");
  await turn("Confirmed. Inseam 30.");
  await turn("Looks good");
  await turn("1 Hotel Drive, Boston, MA, front desk");
  const incidentPrompt = await turn("Yes, that is exact");
  assert.equal(incidentPrompt, INCIDENT_REPLY);

  const review = await generator.generateReply({
    message: "",
    senderHandle: "+919876543210",
    chatId: "chat-notice-at-incident-intake",
    attachments: [
      {
        id: "attachment-incident-notice",
        filename: "baggage-delay.png",
        mimeType: "image/png",
        sizeBytes: 120_000,
        url: "https://cdn.linqapp.com/attachments/baggage-delay.png",
      },
    ],
  });

  assert.match(review, /baggage-disruption notice/i);
  assert.match(review, /• Airline: Emirates/);
  assert.match(review, /• Arrival airport: AUH/);
  assert.match(review, /• Baggage reference: RF392942/);
  assert.match(review, /correct\?/i);
  const imageRequest = requests.at(-1)?.input as Array<{
    content?: Array<{ type?: string }>;
  }>;
  assert.equal(
    imageRequest?.[0]?.content?.some((part) => part.type === "input_image"),
    true,
  );

  const summary = await turn("Yes");
  assert.match(summary, /exact approval summary/i);
  assert.match(summary, /• Airline: Emirates/);
  assert.match(summary, /• Arrival airport: AUH/);
  assert.match(summary, /• Baggage reference: RF392942/);
  assert.match(summary, /employee@example\.com/i);
  assert.doesNotMatch(
    summary,
    /I just need|What should I put down|missing.*(?:airline|airport|reference)/i,
  );
});

test("retries a baggage notice when image extraction exhausts its output budget", async () => {
  const requests: Record<string, unknown>[] = [];
  const evidence = JSON.stringify({
    is_baggage_notice: true,
    incident_type: "delayed_baggage",
    airline: "Delta",
    arrival_airport: "BOS",
    baggage_reference: "RF392942",
    flight_number: null,
    passenger_name: null,
    incident_date: null,
    summary: "Delayed baggage notice",
    uncertain_fields: [],
  });
  let requestCount = 0;
  const client = {
    responses: {
      async create(value: Record<string, unknown>) {
        requests.push(value);
        requestCount += 1;
        if (requestCount === 1) {
          return {
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            output_text: "",
            output: [],
          };
        }
        return {
          status: "completed",
          incomplete_details: null,
          output_text: evidence,
          output: [],
        };
      },
    },
  } as unknown as OpenAI;
  const generator = createOpenAIReplyGenerator(
    client,
    "gpt-5-mini",
    knowledgeProvider(),
    fixedRouter("team_recovery"),
    fixedInterpreter(),
  );

  const reply = await generator.generateReply({
    message: "",
    senderHandle: "+919876543210",
    chatId: "chat-image-retry",
    attachments: [
      {
        id: "attachment-retry",
        filename: "notice.png",
        mimeType: "image/png",
        sizeBytes: 120_000,
        url: "https://cdn.linqapp.com/attachments/notice.png",
      },
    ],
  });

  assert.match(reply, /baggage-disruption notice/i);
  assert.deepEqual(
    requests.map((request) => request.max_output_tokens),
    [800, 1_600],
  );
  assert.equal(
    (requests[0]?.reasoning as { effort?: string } | undefined)?.effort,
    "minimal",
  );
});

test("falls back safely when baggage notice extraction remains malformed", async () => {
  let requestCount = 0;
  const client = {
    responses: {
      async create() {
        requestCount += 1;
        return {
          status: "completed",
          incomplete_details: null,
          output_text: "not-json",
          output: [],
        };
      },
    },
  } as unknown as OpenAI;
  const generator = createOpenAIReplyGenerator(
    client,
    "gpt-5-mini",
    knowledgeProvider(),
    fixedRouter("team_recovery"),
    fixedInterpreter(),
  );

  const reply = await generator.generateReply({
    message: "",
    senderHandle: "+919876543210",
    chatId: "chat-image-malformed",
    attachments: [
      {
        id: "attachment-malformed",
        filename: "notice.png",
        mimeType: "image/png",
        sizeBytes: 120_000,
        url: "https://cdn.linqapp.com/attachments/notice.png",
      },
    ],
  });

  assert.equal(requestCount, 2);
  assert.match(reply, /could not be read safely/i);
});

test("falls back safely when baggage notice image analysis is refused", async () => {
  let requestCount = 0;
  const client = {
    responses: {
      async create() {
        requestCount += 1;
        return {
          status: "completed",
          incomplete_details: null,
          output_text: "",
          output: [
            {
              type: "message",
              content: [{ type: "refusal", refusal: "Unable to analyze image" }],
            },
          ],
        };
      },
    },
  } as unknown as OpenAI;
  const generator = createOpenAIReplyGenerator(
    client,
    "gpt-5-mini",
    knowledgeProvider(),
    fixedRouter("team_recovery"),
    fixedInterpreter(),
  );

  const reply = await generator.generateReply({
    message: "",
    senderHandle: "+919876543210",
    chatId: "chat-image-refusal",
    attachments: [
      {
        id: "attachment-refusal",
        filename: "notice.png",
        mimeType: "image/png",
        sizeBytes: 120_000,
        url: "https://cdn.linqapp.com/attachments/notice.png",
      },
    ],
  });

  assert.equal(requestCount, 1);
  assert.match(reply, /could not be read safely/i);
});

test("repairs an early option and falls back to a grounded intake", async () => {
  const requests: Record<string, unknown>[] = [];
  const invalid = "Sorry about that. I found a bundle for $154. What is your inseam?";
  const generator = createOpenAIReplyGenerator(
    sequenceClient([invalid, invalid], requests),
    "reply-model",
    knowledgeProvider(),
    fixedRouter("team_recovery"),
    fixedInterpreter(),
  );

  const reply = await generator.generateReply({
    message: "My baggage is delayed",
    senderHandle: "+919876543210",
    chatId: "chat-repair",
  });

  assert.equal(requests.length, 2);
  assert.match(String(requests[1]?.input), /Required corrections/);
  assert.match(reply, /replacement essentials/i);
  assert.doesNotMatch(reply, /meeting|\$154|T-shirt size/i);
});

test("uses a valid deterministic size intake when both model drafts miss the opening contract", async () => {
  const requests: Record<string, unknown>[] = [];
  const invalidOpening =
    "Boston by 8 AM is noted.\n\n• T-shirt: M\n• Trouser waist: 32\n• Trouser inseam: not on file\n\nCan you confirm M and 32 and tell me your inseam?";
  const generator = createOpenAIReplyGenerator(
    sequenceClient([CONTEXT_REPLY, invalidOpening, invalidOpening], requests),
    "reply-model",
    knowledgeProvider(),
    fixedRouter("team_recovery"),
    fixedInterpreter([
      {
        ...EMPTY_UPDATE,
        action: "provide_recovery_context",
        wantsEssentials: true,
        deliveryArea: "Boston",
        needBy: "8:00 AM",
      },
    ]),
  );

  await generator.generateReply({
    message: "My baggage is delayed",
    senderHandle: "+919876543210",
    chatId: "chat-size-opening-contract",
  });
  const reply = await generator.generateReply({
    message: "Yes, Boston by 8 AM",
    senderHandle: "+919876543210",
    chatId: "chat-size-opening-contract",
  });

  assert.equal(requests.length, 3);
  assert.match(reply, /^Got it\. I can help/i);
  assert.equal(reply.match(/^• /gm)?.length, 3);
  assert.equal(reply.match(/\?/g)?.length, 1);
  assert.match(reply, /knowledge base/i);
  assert.match(reply, /• T-shirt: M/);
  assert.match(reply, /• Trouser waist: 32/);
  assert.match(reply, /• Trouser inseam: not on file/);
});

test("rejects a size-intake draft that claims sourcing has started", async () => {
  const premature =
    "Thanks - I’ll source those.\n\n• T-shirt: M\n• Trouser waist: 32\n• Trouser inseam: not on file\n\nCan you confirm M and 32 and tell me your inseam?";
  const generator = createOpenAIReplyGenerator(
    sequenceClient([CONTEXT_REPLY, premature, premature]),
    "reply-model",
    knowledgeProvider(),
    fixedRouter("team_recovery"),
    fixedInterpreter([
      {
        ...EMPTY_UPDATE,
        action: "provide_recovery_context",
        wantsEssentials: true,
        deliveryArea: "Boston",
        needBy: "8:00 AM",
      },
    ]),
  );

  await generator.generateReply({
    message: "My baggage is delayed",
    senderHandle: "+919876543210",
    chatId: "chat-no-premature-sourcing",
  });
  const reply = await generator.generateReply({
    message: "I need essentials in Boston before 8 AM",
    senderHandle: "+919876543210",
    chatId: "chat-no-premature-sourcing",
  });

  assert.match(reply, /^Got it\. I can help/i);
  assert.doesNotMatch(reply, /I(?:'|’)ll source|sourcing/i);
  assert.match(reply, /knowledge base/i);
});

test("rejects a size-intake draft that omits knowledge-base provenance", async () => {
  const noProvenance =
    "Got it. Here are the sizes on file:\n\n• T-shirt: M\n• Trouser waist: 32\n• Trouser inseam: not on file\n\nCan you confirm M and 32 and tell me your inseam?";
  const generator = createOpenAIReplyGenerator(
    sequenceClient([CONTEXT_REPLY, noProvenance, noProvenance]),
    "reply-model",
    knowledgeProvider(),
    fixedRouter("team_recovery"),
    fixedInterpreter([
      {
        ...EMPTY_UPDATE,
        action: "provide_recovery_context",
        wantsEssentials: true,
        deliveryArea: "Boston",
        needBy: "8:00 AM",
      },
    ]),
  );

  await generator.generateReply({
    message: "My baggage is delayed",
    senderHandle: "+919876543210",
    chatId: "chat-size-knowledge-provenance",
  });
  const reply = await generator.generateReply({
    message: "I need essentials in Boston before 8 AM",
    senderHandle: "+919876543210",
    chatId: "chat-size-knowledge-provenance",
  });

  assert.match(reply, /^Got it\. I can help.*knowledge base/is);
  assert.match(reply, /• Trouser inseam: not on file/i);
  assert.doesNotMatch(reply, /—/);
});

test("rejects a size draft that mentions a missing field without marking it missing", async () => {
  const unclearMissingValue =
    "Got it. Here are the sizes:\n\n• T-shirt: M\n• Trouser waist: 32\n• Trouser inseam: please provide\n\nCan you confirm M and 32 and send the inseam?";
  const generator = createOpenAIReplyGenerator(
    sequenceClient([CONTEXT_REPLY, unclearMissingValue, unclearMissingValue]),
    "reply-model",
    knowledgeProvider(),
    fixedRouter("team_recovery"),
    fixedInterpreter([
      {
        ...EMPTY_UPDATE,
        action: "provide_recovery_context",
        wantsEssentials: true,
        deliveryArea: "Boston",
        needBy: "8:00 AM",
      },
    ]),
  );

  await generator.generateReply({
    message: "My baggage is delayed",
    senderHandle: "+919876543210",
    chatId: "chat-explicit-missing-size",
  });
  const reply = await generator.generateReply({
    message: "I need essentials in Boston before 8 AM",
    senderHandle: "+919876543210",
    chatId: "chat-explicit-missing-size",
  });

  assert.match(reply, /• Trouser inseam: not on file/i);
});

test("uses the recovery fallback for every non-usable OpenAI reply shape", async () => {
  const failures: Array<{ name: string; output: Error | Record<string, unknown> }> = [
    { name: "request error", output: new Error("temporary OpenAI failure") },
    {
      name: "empty completion",
      output: { status: "completed", output_text: "", output: [] },
    },
    {
      name: "incomplete completion",
      output: {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output_text: "partial",
        output: [],
      },
    },
    {
      name: "refusal",
      output: {
        status: "completed",
        output_text: "",
        output: [
          {
            type: "message",
            content: [{ type: "refusal", refusal: "Unable to draft" }],
          },
        ],
      },
    },
  ];

  for (const [index, failure] of failures.entries()) {
    const generator = createOpenAIReplyGenerator(
      scriptedClient([CONTEXT_REPLY, failure.output]),
      "reply-model",
      knowledgeProvider(),
      fixedRouter("team_recovery"),
      fixedInterpreter([
        {
          ...EMPTY_UPDATE,
          action: "provide_recovery_context",
          wantsEssentials: true,
          deliveryArea: "Boston",
          needBy: "8:00 AM",
        },
      ]),
    );
    const chatId = `chat-model-failure-${index}`;
    await generator.generateReply({
      message: "My baggage is delayed",
      senderHandle: "+919876543210",
      chatId,
    });
    const reply = await generator.generateReply({
      message: "Yes, Boston by 8 AM",
      senderHandle: "+919876543210",
      chatId,
    });

    assert.match(reply, /^Got it\. I can help/i, failure.name);
    assert.equal(reply.match(/^• /gm)?.length, 3, failure.name);
    assert.equal(reply.match(/\?/g)?.length, 1, failure.name);
  }
});

test("uses the recovery fallback when the OpenAI rewrite call fails", async () => {
  const invalid = "Here are your sizes. What is missing?";
  const generator = createOpenAIReplyGenerator(
    scriptedClient([CONTEXT_REPLY, invalid, new Error("rewrite unavailable")]),
    "reply-model",
    knowledgeProvider(),
    fixedRouter("team_recovery"),
    fixedInterpreter([
      {
        ...EMPTY_UPDATE,
        action: "provide_recovery_context",
        wantsEssentials: true,
        deliveryArea: "Boston",
        needBy: "8:00 AM",
      },
    ]),
  );

  await generator.generateReply({
    message: "My baggage is delayed",
    senderHandle: "+919876543210",
    chatId: "chat-rewrite-failure",
  });
  const reply = await generator.generateReply({
    message: "Yes, Boston by 8 AM",
    senderHandle: "+919876543210",
    chatId: "chat-rewrite-failure",
  });

  assert.match(reply, /^Got it\. I can help/i);
  assert.equal(reply.match(/^• /gm)?.length, 3);
});

test("accepts a corrected OpenAI rewrite before using the deterministic fallback", async () => {
  const invalid = "Here are your sizes. What is missing?";
  const generator = createOpenAIReplyGenerator(
    scriptedClient([CONTEXT_REPLY, invalid, SIZE_REPLY]),
    "reply-model",
    knowledgeProvider(),
    fixedRouter("team_recovery"),
    fixedInterpreter([
      {
        ...EMPTY_UPDATE,
        action: "provide_recovery_context",
        wantsEssentials: true,
        deliveryArea: "Boston",
        needBy: "8:00 AM",
      },
    ]),
  );

  await generator.generateReply({
    message: "My baggage is delayed",
    senderHandle: "+919876543210",
    chatId: "chat-valid-rewrite",
  });
  const reply = await generator.generateReply({
    message: "Yes, Boston by 8 AM",
    senderHandle: "+919876543210",
    chatId: "chat-valid-rewrite",
  });

  assert.equal(reply, SIZE_REPLY);
});

test("validates deterministic size intake for every stored-size combination", async () => {
  const combinations = [
    [null, null, null],
    ["M", null, null],
    [null, "32", null],
    [null, null, "30"],
    ["M", "32", null],
    ["M", null, "30"],
    [null, "32", "30"],
    ["M", "32", "30"],
  ] as const;
  const invalid = "Sizes are listed. Which ones are right?";

  for (const [index, values] of combinations.entries()) {
    const sizes = {
      tshirtSize: values[0],
      trouserWaist: values[1],
      trouserInseam: values[2],
    };
    const generator = createOpenAIReplyGenerator(
      sequenceClient([CONTEXT_REPLY, invalid, invalid]),
      "reply-model",
      knowledgeProviderWithSizes(sizes),
      fixedRouter("team_recovery"),
      fixedInterpreter([
        {
          ...EMPTY_UPDATE,
          action: "provide_recovery_context",
          wantsEssentials: true,
          deliveryArea: "Boston",
          needBy: "8:00 AM",
        },
      ]),
    );
    const chatId = `chat-size-combination-${index}`;
    await generator.generateReply({
      message: "My baggage is delayed",
      senderHandle: "+919876543210",
      chatId,
    });
    const reply = await generator.generateReply({
      message: "Yes, Boston by 8 AM",
      senderHandle: "+919876543210",
      chatId,
    });

    assert.equal(reply.match(/^• /gm)?.length, 3, `combination ${index}`);
    assert.equal(reply.match(/\?/g)?.length, 1, `combination ${index}`);
    assert.match(reply, /knowledge base/i, `combination ${index}`);
    assert.doesNotMatch(reply, /unknown/i, `combination ${index}`);
    for (const [label, value] of [
      ["T-shirt", sizes.tshirtSize],
      ["Trouser waist", sizes.trouserWaist],
      ["Trouser inseam", sizes.trouserInseam],
    ] as const) {
      assert.match(
        reply,
        new RegExp(`• ${label}: ${value ?? "not on file"}`, "i"),
        `combination ${index} ${label}`,
      );
    }
  }
});

test("uses a focused deterministic follow-up after only the inseam is supplied", async () => {
  const invalid = "I still need more information. What else?";
  const generator = createOpenAIReplyGenerator(
    sequenceClient([CONTEXT_REPLY, SIZE_REPLY, invalid, invalid]),
    "reply-model",
    knowledgeProvider(),
    fixedRouter("team_recovery"),
    fixedInterpreter([
      {
        ...EMPTY_UPDATE,
        action: "provide_recovery_context",
        wantsEssentials: true,
        deliveryArea: "Boston",
        needBy: "8:00 AM",
      },
      {
        ...EMPTY_UPDATE,
        action: "confirm_sizes",
        trouserInseam: "30",
      },
    ]),
  );
  const chatId = "chat-partial-size-fallback";

  await generator.generateReply({
    message: "My baggage is delayed",
    senderHandle: "+919876543210",
    chatId,
  });
  await generator.generateReply({
    message: "Yes, Boston by 8 AM",
    senderHandle: "+919876543210",
    chatId,
  });
  const reply = await generator.generateReply({
    message: "30",
    senderHandle: "+919876543210",
    chatId,
  });

  assert.match(reply, /confirm T-shirt M/i);
  assert.match(reply, /confirm trouser waist 32/i);
  assert.doesNotMatch(reply, /inseam|airline|airport|allowance|\$/i);
  assert.equal(reply.match(/\?/g)?.length, 1);
});

test("uses a complete deterministic incident-details prompt when both drafts fail", async () => {
  const invalid = "What else do you need?";
  const generator = createOpenAIReplyGenerator(
    sequenceClient([CONTEXT_REPLY, SIZE_REPLY, OPTION_REPLY, invalid, invalid]),
    "reply-model",
    knowledgeProvider(),
    fixedRouter("team_recovery"),
    fixedInterpreter([
      {
        ...EMPTY_UPDATE,
        action: "provide_recovery_context",
        wantsEssentials: true,
        deliveryArea: "Boston",
        needBy: "8:00 AM",
      },
      {
        ...EMPTY_UPDATE,
        action: "confirm_sizes",
        confirmsOnFileSizes: true,
        trouserInseam: "30",
      },
      { ...EMPTY_UPDATE, action: "accept_bundle" },
    ]),
  );
  const chatId = "chat-incident-fallback";
  const turn = (message: string) =>
    generator.generateReply({
      message,
      senderHandle: "+919876543210",
      chatId,
    });

  await turn("My baggage is delayed");
  await turn("Yes, Boston by 8 AM");
  await turn("M and 32 are right, inseam 30");
  await turn("Looks good");
  await turn("1 Hotel Drive, Boston, MA, front desk");
  const reply = await turn("Yes, that is exact");

  assert.match(reply, /• Airline/);
  assert.match(reply, /• Arrival airport/);
  assert.match(reply, /• Baggage reference, if you have one/);
  assert.equal(reply.match(/^• /gm)?.length, 3);
  assert.equal(reply.match(/\?/g)?.length, 1);
  assert.doesNotMatch(reply, /T-shirt|waist|inseam|allowance|\$/i);
});

test("falls back safely when option drafts select a rejected candidate", async () => {
  const rejectedOption =
    "Thanks. I found an eligible option with a T-shirt in M, trousers in 32x30, and toiletries for $132, delivered before 7:00 AM and within your $175 allowance. Anything you want to change?";
  const generator = createOpenAIReplyGenerator(
    sequenceClient([CONTEXT_REPLY, SIZE_REPLY, rejectedOption, rejectedOption]),
    "reply-model",
    knowledgeProvider(),
    fixedRouter("team_recovery"),
    fixedInterpreter([
      {
        ...EMPTY_UPDATE,
        action: "provide_recovery_context",
        wantsEssentials: true,
        deliveryArea: "Boston",
        needBy: "8:00 AM",
      },
      {
        ...EMPTY_UPDATE,
        action: "confirm_sizes",
        confirmsOnFileSizes: true,
        trouserInseam: "30",
      },
    ]),
  );

  await generator.generateReply({
    message: "My baggage is delayed",
    senderHandle: "+919876543210",
    chatId: "chat-rejected-option",
  });
  await generator.generateReply({
    message: "Yes, Boston by 8 AM",
    senderHandle: "+919876543210",
    chatId: "chat-rejected-option",
  });
  const reply = await generator.generateReply({
    message: "M and 32 are right. My inseam is 30",
    senderHandle: "+919876543210",
    chatId: "chat-rejected-option",
  });

  assert.match(reply, /154/);
  assert.doesNotMatch(reply, /132/);
  assert.match(reply, /change.*\?/i);
});

test("uses a safe intent reply when the model returns an empty completion", async () => {
  const generator = createOpenAIReplyGenerator(
    sequenceClient(["   "]),
    "reply-model",
    knowledgeProvider(),
    fixedRouter("social"),
    fixedInterpreter(),
  );

  const reply = await generator.generateReply({
    message: "hello",
    senderHandle: "+919876543210",
    chatId: "chat-empty",
  });

  assert.equal(reply, "Hey - how can I help with your work trip?");
});

test("does not call the reply model for an unknown sender needing profile data", async () => {
  const client = {
    responses: {
      async create() {
        throw new Error("reply model should not be called");
      },
    },
  } as unknown as OpenAI;
  const provider: SensoKnowledgeProvider = {
    async getKnowledge() {
      return null;
    },
  };
  const generator = createOpenAIReplyGenerator(
    client,
    "reply-model",
    provider,
    fixedRouter("team_recovery"),
    fixedInterpreter(),
  );

  assert.equal(
    await generator.generateReply({
      message: "My bag is delayed",
      senderHandle: "+12025550123",
      chatId: "chat-unknown",
    }),
    UNKNOWN_EMPLOYEE_REPLY,
  );
});

test("reports the latest durable recovery and reimbursement status", async () => {
  const submissionTarget = resolveAirlineSubmissionTarget("Delta");
  const record: RecoveryCaseRecord = {
    caseId: "RCV-STATUS1",
    chatId: "chat-status",
    employeeId: "emp_demo_001",
    employeePhone: "+919876543210",
    status: "sandbox_authorization_complete",
    incident: {
      airline: "Delta",
      arrivalAirport: "BOS",
      baggageReference: "RF392942",
      passengerName: null,
      flightNumber: null,
      incidentDate: null,
      noticeAttachmentIds: ["notice-1"],
    },
    recovery: {
      needBy: "8:00 AM",
      deliveryArea: "Boston",
      deliveryAddress: "1 Demo Hotel Drive, Boston, MA",
      deliveryAddressSource: "message",
      products: [{ description: "Toiletries", unitPrice: "22.00", quantity: 1 }],
      totalAmount: "22.00",
      currency: "USD",
    },
    payment: {
      checkoutId: "checkout-1",
      pravaReference: "prava-order-1",
      status: "approved",
    },
    fulfillment: {
      status: "not_started",
      merchantOrderId: null,
      disclosure: "No live merchant order.",
    },
    commerce: null,
    reimbursement: {
      airlineClaimStatus: "draft",
      employerExpenseStatus: "draft",
      blockers: ["verified itemized merchant receipt"],
      evidence: [],
      expenses: [],
      submissionTarget,
      claimPacket: {
        schemaVersion: 1,
        caseId: "RCV-STATUS1",
        generatedAt: "2026-08-02T10:05:00.000Z",
        incident: {
          airline: "Delta",
          arrivalAirport: "BOS",
          baggageReference: "RF392942",
          passengerName: null,
          flightNumber: null,
          incidentDate: null,
        },
        expenses: [],
        evidenceIds: [],
        submissionTarget,
        packetHash: "test-packet-hash",
      },
      authorization: null,
      submission: null,
      automationBoundary: "Manual airline handoff only.",
    },
    createdAt: "2026-08-02T10:00:00.000Z",
    updatedAt: "2026-08-02T10:05:00.000Z",
  };
  const generator = createOpenAIReplyGenerator(
    {
      responses: {
        async create() {
          throw new Error("reply model should not be called for stored status");
        },
      },
    } as unknown as OpenAI,
    "reply-model",
    knowledgeProvider(),
    fixedRouter("team_recovery"),
    fixedInterpreter(),
    undefined,
    {
      caseLedger: {
        async savePrepared() {
          throw new Error("not used");
        },
        async saveClaimDraft() {
          throw new Error("not used");
        },
        async addClaimEvidence() {
          throw new Error("not used");
        },
        async addClaimExpense() {
          throw new Error("not used");
        },
        async authorizeAirlineClaim() {
          throw new Error("not used");
        },
        async recordExternalClaimSubmission() {
          throw new Error("not used");
        },
        async recordPayment() {
          throw new Error("not used");
        },
        async saveLiveCommercePrepared() {
          throw new Error("not used");
        },
        async recordLiveCommerce() {
          throw new Error("not used");
        },
        async get() {
          return null;
        },
        async getLatestForChat(chatId) {
          return chatId === record.chatId ? record : null;
        },
      },
    },
  );

  const reply = await generator.generateReply({
    message: "What is the status of my recovery case?",
    senderHandle: record.employeePhone,
    chatId: record.chatId,
  });
  assert.match(reply, /RCV-STATUS1/);
  assert.match(reply, /secure Prava approval complete; recovery case updated/i);
  assert.doesNotMatch(reply, /sandbox|simulat|no live/i);
  assert.match(reply, /Airline claim: draft, not submitted/i);
  assert.match(reply, /verified itemized merchant receipt/i);
});

test("prepares and authorizes only a manual airline claim handoff from chat", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tavra-claim-chat-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = new JsonlRecoveryCaseLedger(join(directory, "cases.jsonl"));
  const caseId = "RCV-CHATCLAIM";
  await ledger.saveClaimDraft({
    caseId,
    chatId: "chat-claim-handoff",
    employeeId: "emp-claim",
    employeePhone: "+15555550123",
    airline: "Delta",
    arrivalAirport: "BOS",
    baggageReference: "BOSDL12345",
    passengerName: "Demo Passenger",
    noticeAttachmentIds: ["notice-1"],
  });
  await ledger.addClaimEvidence({
    caseId,
    evidenceId: "EVD-CHAT-NOTICE",
    kind: "baggage_delay_notice",
    source: "linq_attachment",
    description: "Employee-confirmed delayed baggage notice",
    verification: "verified",
    attachmentId: "notice-1",
  });
  await ledger.addClaimEvidence({
    caseId,
    evidenceId: "EVD-CHAT-RECEIPT",
    kind: "itemized_receipt",
    source: "merchant",
    description: "Verified emergency purchase receipt",
    verification: "verified",
    sha256: "a".repeat(64),
  });
  await ledger.addClaimExpense({
    caseId,
    description: "Emergency baggage-delay essentials",
    amount: "22.00",
    currency: "USD",
    receiptEvidenceId: "EVD-CHAT-RECEIPT",
    status: "incurred",
  });

  const generator = createOpenAIReplyGenerator(
    {
      responses: {
        async create() {
          throw new Error("model should not run for deterministic claim handoff");
        },
      },
    } as unknown as OpenAI,
    "reply-model",
    knowledgeProvider(),
    fixedRouter("team_recovery"),
    fixedInterpreter(),
    undefined,
    { caseLedger: ledger },
  );
  const request = {
    senderHandle: "+1 (555) 555-0123",
    chatId: "chat-claim-handoff",
  };

  const prepare = await generator.generateReply({
    ...request,
    message: "Please submit my airline claim",
  });
  assert.match(prepare, /packet RCV-CHATCLAIM is complete/i);
  assert.match(prepare, /cannot submit/i);
  assert.match(prepare, /nothing has been submitted/i);
  assert.equal(
    (await ledger.get(caseId))?.reimbursement.airlineClaimStatus,
    "ready_for_authorization",
  );

  const authorize = await generator.generateReply({
    ...request,
    message: "Authorize claim handoff",
  });
  assert.match(authorize, /packet is locked/i);
  assert.match(authorize, /https:\/\/www\.delta\.com\/bag-claim/);
  assert.match(authorize, /no claim has been filed/i);
  const stored = await ledger.get(caseId);
  assert.equal(
    stored?.reimbursement.airlineClaimStatus,
    "authorized_for_handoff",
  );
  assert.equal(stored?.reimbursement.submission, null);
});

test("a bare yes submits only an awaiting sandbox packet and writes the outcome to Senso", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tavra-sandbox-claim-chat-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = new JsonlRecoveryCaseLedger(join(directory, "cases.jsonl"));
  const caseId = "RCV-CLAIMDEMO";
  const chatId = "chat-sandbox-claim";
  const senderHandle = "+15555550123";
  const products = [
    {
      productRef: "b-shirt-001",
      description: "Neutral basic T-shirt, size M",
      unitPrice: "54.00",
      quantity: 1,
    },
  ];
  await ledger.savePrepared({
    caseId,
    chatId,
    employeeId: "emp-claim",
    employeePhone: senderHandle,
    recovery: {
      caseId,
      needBy: "8 AM tomorrow",
      deliveryArea: "Abu Dhabi",
      deliveryAddress: "Masdar City, Abu Dhabi",
      deliveryAddressSource: "message",
      airline: "Emirates",
      arrivalAirport: "AUH",
      baggageReference: "RF392942",
      noticeAttachmentIds: ["notice-1"],
    },
    products,
    totalAmount: "54.00",
    currency: "USD",
    checkoutId: "checkout-sandbox-claim",
    incidentEvidence: {
      passengerName: "Demo Traveler",
      flightNumber: "EK202",
      incidentDate: "2026-08-02",
    },
  });
  await ledger.addClaimEvidence({
    caseId,
    evidenceId: "EVD-SANDBOX-NOTICE",
    kind: "baggage_delay_notice",
    source: "linq_attachment",
    description: "Employee-confirmed delayed baggage notice",
    verification: "verified",
    attachmentId: "notice-1",
  });
  const paid = await ledger.recordPayment({
    chatId,
    checkoutId: "checkout-sandbox-claim",
    status: "completed",
    pravaOrderId: "prava-order-1",
    merchantOrderId: "demo-order-1",
    totalAmount: "54.00",
    currency: "USD",
    employeeId: "emp-claim",
    employeePhone: senderHandle,
    products,
    recovery: {
      caseId,
      needBy: "8 AM tomorrow",
      deliveryArea: "Abu Dhabi",
      deliveryAddress: "Masdar City, Abu Dhabi",
      deliveryAddressSource: "message",
      airline: "Emirates",
      arrivalAirport: "AUH",
      baggageReference: "RF392942",
      noticeAttachmentIds: ["notice-1"],
    },
    merchantOutcome: "simulated",
  });
  assert.ok(paid);
  assert.deepEqual(paid.reimbursement.blockers, []);
  await ledger.recordReimbursementPacketUploaded({
    caseId,
    environment: "sandbox",
    packetHash: paid.reimbursement.claimPacket.packetHash,
    attachmentId: "attachment-packet-1",
    filename: "tavra-emirates-reimbursement-packet.pdf",
    sha256: "b".repeat(64),
  });
  await ledger.markReimbursementAwaitingConfirmation({
    caseId,
    packetHash: paid.reimbursement.claimPacket.packetHash,
  });

  const recordedOutcomes: SensoRecoveryOutcome[] = [];
  const baseKnowledge = knowledgeProvider();
  const provider = {
    getKnowledge: baseKnowledge.getKnowledge.bind(baseKnowledge),
    async recordRecoveryOutcome(
      _senderHandle: string,
      outcome: SensoRecoveryOutcome,
    ) {
      recordedOutcomes.push(outcome);
      return {
        employeeId: "emp-claim",
        contentId: "22222222-2222-4222-8222-222222222222",
      };
    },
  };
  const generator = createOpenAIReplyGenerator(
    {
      responses: {
        async create() {
          throw new Error("model should not run for sandbox claim confirmation");
        },
      },
    } as unknown as OpenAI,
    "reply-model",
    provider,
    fixedRouter("social"),
    fixedInterpreter(),
    undefined,
    {
      caseLedger: ledger,
      airlineClaimSubmissionProvider:
        createSandboxAirlineClaimSubmissionProvider({
          now: () => new Date("2026-08-02T18:00:00.000Z"),
        }),
    },
  );

  const no = await generator.generateReply({
    message: "No",
    senderHandle,
    chatId,
  });
  assert.match(no, /keep the reimbursement packet ready/i);
  assert.equal(
    (await ledger.get(caseId))?.reimbursement.handoff?.state,
    "awaiting_confirmation",
  );

  const reply = await generator.generateReply({
    message: "Yes",
    senderHandle,
    chatId,
  });
  assert.match(reply, /sent reimbursement packet RCV-CLAIMDEMO to Emirates/i);
  assert.match(reply, /3-5 business days/i);
  assert.match(reply, /knowledge record: updated/i);
  assert.doesNotMatch(reply, /sandbox|simulat|—/i);
  assert.equal(recordedOutcomes.length, 1);
  assert.equal(recordedOutcomes[0]?.status, "reimbursement_submitted");
  assert.equal(recordedOutcomes[0]?.companyNotified, true);
  const stored = await ledger.get(caseId);
  assert.equal(stored?.reimbursement.handoff?.state, "submitted");
  assert.equal(stored?.reimbursement.submission?.environment, "sandbox");
  assert.equal(
    stored?.reimbursement.submission?.companyNotificationId,
    "22222222-2222-4222-8222-222222222222",
  );
});
