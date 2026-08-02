import { loadOpenAIConfig } from "../src/config.js";
import {
  createOpenAIClient,
  createOpenAIReplyGenerator,
  type IntentRouter,
  type RecoveryTurnInterpreter,
} from "../src/openai.js";
import type { SensoKnowledgeProvider } from "../src/senso.js";

const config = loadOpenAIConfig();
const client = createOpenAIClient(config.openAIApiKey);

const staticKnowledge: SensoKnowledgeProvider = {
  async getKnowledge(_sender, _message, scope) {
    const profile = [
      "Work email: employee@example.com.",
      "T-shirt size: M.",
      "Trouser waist: 32 inches.",
      "Trouser inseam: unknown.",
    ].join(" ");
    return {
      companyId: "smoke_test",
      employeeId: "smoke_test",
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
      contentIds: [],
    };
  },
};

// The broader router/interpreter matrix is covered with non-billable mocks.
// This smoke test spends credits only on the two reply drafts around the
// production regression: initial context intake, then size intake.
const recoveryRouter: IntentRouter = {
  async classify() {
    return "team_recovery";
  },
};
const recoveryInterpreter: RecoveryTurnInterpreter = {
  async interpret() {
    return {
      action: "provide_recovery_context",
      confirmsOnFileSizes: false,
      tshirtSize: null,
      trouserWaist: null,
      trouserInseam: null,
      airline: null,
      arrivalAirport: null,
      baggageReference: null,
      wantsEssentials: true,
      needBy: "before 8:00 AM",
      deliveryArea: "Boston",
      deliveryAddress: null,
      confirmsDeliveryAddress: false,
    };
  },
};

const generator = createOpenAIReplyGenerator(
  client,
  config.openAIModel,
  staticKnowledge,
  recoveryRouter,
  recoveryInterpreter,
);
const chatId = `openai-contract-smoke-${Date.now()}`;
const turn = (message: string) =>
  generator.generateReply({
    message,
    senderHandle: "+12025550123",
    chatId,
  });

const intake = await turn("My baggage is delayed.");
const sizes = await turn(
  "Yes, I need basic clothing and toiletries in Boston before 8 AM.",
);

console.log(`OpenAI contract smoke response using ${config.openAIModel}.`);
console.log(`Recovery intake:\n${intake}`);
console.log(`\nSize intake:\n${sizes}`);

for (const required of ["replacement", "claim", "where", "when"]) {
  if (!intake.toLowerCase().includes(required)) {
    throw new Error(`Recovery intake omitted required context: ${required}`);
  }
}
for (const unsupported of ["meeting", "boston", "t-shirt", "waist", "154", "175"]) {
  if (intake.toLowerCase().includes(unsupported)) {
    throw new Error(`Bare baggage report invented or exposed: ${unsupported}`);
  }
}
for (const required of ["t-shirt", "m", "trouser waist", "32", "inseam"]) {
  if (!sizes.toLowerCase().includes(required)) {
    throw new Error(`Size intake omitted required value: ${required}`);
  }
}
if (!/inseam.{0,45}\b(?:not\s+(?:currently\s+)?on\s+file|missing|unknown|unavailable|not\s+(?:available|supplied|listed))\b/is.test(sizes)) {
  throw new Error("Size intake did not clearly mark the missing inseam");
}
if ((sizes.match(/^• /gm) ?? []).length !== 3) {
  throw new Error("Size intake must contain exactly three size bullets");
}
if ((sizes.match(/\?/g) ?? []).length !== 1) {
  throw new Error("Size intake must ask exactly one next-step question");
}
if ([intake, sizes].some((reply) => reply.includes("—"))) {
  throw new Error("Tavra response contained a forbidden em dash");
}

console.log(`\nOpenAI contract smoke passed using ${config.openAIModel}.`);
