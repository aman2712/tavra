import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadOpenAIConfig, loadSensoConfig } from "../src/config.js";
import {
  createOpenAIClient,
  createOpenAIIntentRouter,
  createOpenAIRecoveryTurnInterpreter,
  createOpenAIReplyGenerator,
} from "../src/openai.js";
import {
  createSensoKnowledgeProvider,
  loadIdentityResolver,
} from "../src/senso.js";

const openAI = loadOpenAIConfig();
const senso = loadSensoConfig();
const identityPath = resolve(process.cwd(), senso.sensoIdentityMapPath);
const identityDocument = JSON.parse(readFileSync(identityPath, "utf8")) as {
  identities?: Array<{ phone_e164?: string; status?: string }>;
};
const senderHandle = identityDocument.identities?.find(
  (identity) => identity.status === "active",
)?.phone_e164;
if (!senderHandle) throw new Error("No active sender exists in the private identity map");

const knowledgeProvider = createSensoKnowledgeProvider({
  apiKey: senso.sensoApiKey,
  baseUrl: senso.sensoBaseUrl,
  identityResolver: loadIdentityResolver(identityPath),
});
const openAIClient = createOpenAIClient(openAI.openAIApiKey);
const generator = createOpenAIReplyGenerator(
  openAIClient,
  openAI.openAIModel,
  knowledgeProvider,
  createOpenAIIntentRouter(openAIClient, openAI.openAIRouterModel),
  createOpenAIRecoveryTurnInterpreter(openAIClient, openAI.openAIRouterModel),
  {
    async createCheckout() {
      return {
        checkoutId: "smoke-checkout",
        url: "https://tavra.example/pay/smoke-checkout",
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      };
    },
  },
);
const chatId = "senso-openai-smoke";
const turn = (message: string) =>
  generator.generateReply({ senderHandle, chatId, message });
const greeting = await generator.generateReply({
  senderHandle,
  chatId,
  message: "Hi",
});
for (const forbidden of ["t-shirt", "trouser", "inseam", "175", "154", "policy"]){
  if (greeting.toLowerCase().includes(forbidden)) {
    throw new Error(`Greeting incorrectly volunteered company context: ${forbidden}`);
  }
}
const intake = await turn("My bag is delayed.");
const sizes = await turn("Yes, basic clothing and toiletries in Boston by 8 AM.");
const sizeFollowup = await turn("30");
const option = await turn("Yes, M and 32 are correct.");
const addressPrompt = await turn("That looks good. I do not want any changes.");
const addressProposal = await turn("1 Demo Hotel Drive, Boston, MA, front desk");
const incidentDetails = await turn("Yes, that is the exact delivery address.");
const airportClarification = await turn("Delta\nBoston\nRF392942");
const summary = await turn("BOS");
const checkout = await turn("Yes, create the secure approval.");
const presentation = generator.consumePresentation(chatId);

const redactEmail = (value: string) =>
  value.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[employee email]");
console.log(`Greeting: ${redactEmail(greeting)}`);
console.log(`Recovery intake: ${redactEmail(intake)}`);
console.log(`Size confirmation: ${redactEmail(sizes)}`);
console.log(`Size follow-up: ${redactEmail(sizeFollowup)}`);
console.log(`Option review: ${redactEmail(option)}`);
console.log(`Address prompt: ${redactEmail(addressPrompt)}`);
console.log(`Address proposal: ${redactEmail(addressProposal)}`);
console.log(`Incident details: ${redactEmail(incidentDetails)}`);
console.log(`Airport clarification: ${redactEmail(airportClarification)}`);
console.log(`Authorization summary: ${redactEmail(summary)}`);
console.log(`Checkout handoff: ${redactEmail(checkout)}`);

if (
  [
    greeting,
    intake,
    sizes,
    sizeFollowup,
    option,
    addressPrompt,
    addressProposal,
    incidentDetails,
    airportClarification,
    summary,
    checkout,
  ].some((reply) => reply.includes("—"))
) {
  throw new Error("Tavra response contained a forbidden em dash");
}

for (const forbidden of ["meeting", "boston", "t-shirt", "waist", "154", "175"]) {
  if (intake.toLowerCase().includes(forbidden)) {
    throw new Error(`Bare baggage report caused an unsupported assumption: ${forbidden}`);
  }
}
for (const required of ["replacement", "claim", "where", "when"]) {
  if (!intake.toLowerCase().includes(required)) {
    throw new Error(`Recovery intake omitted required context question: ${required}`);
  }
}
for (const required of ["m", "32", "inseam"]) {
  if (!sizes.toLowerCase().includes(required)) {
    throw new Error(`Size-confirmation turn omitted required profile value: ${required}`);
  }
}
for (const forbidden of ["175", "154", "allowance", "bundle", "delivery", "airline", "airport", "baggage reference"]) {
  if (sizes.toLowerCase().includes(forbidden)) {
    throw new Error(`Size-confirmation turn jumped ahead to: ${forbidden}`);
  }
}
if ((sizes.match(/^• /gm) ?? []).length < 3) {
  throw new Error("Size-confirmation turn must use one bullet per size");
}
for (const required of ["m", "32"]) {
  if (!sizeFollowup.toLowerCase().includes(required)) {
    throw new Error(`Size follow-up omitted unconfirmed on-file value: ${required}`);
  }
}
for (const forbidden of ["175", "154", "allowance", "delivery", "eligible option"]) {
  if (sizeFollowup.toLowerCase().includes(forbidden)) {
    throw new Error(`Size follow-up fetched an option before confirmation: ${forbidden}`);
  }
}
for (const required of ["175", "154", "30", "deliver", "change"]) {
  if (!option.toLowerCase().includes(required)) {
    throw new Error(`Option-review turn omitted required value: ${required}`);
  }
}
for (const forbidden of ["airline", "airport", "baggage reference"]) {
  if (option.toLowerCase().includes(forbidden)) {
    throw new Error(`Option-review turn asked too early for: ${forbidden}`);
  }
}
if ((option.match(/^• /gm) ?? []).length < 5) {
  throw new Error("Option-review turn must use a compact five-line summary");
}
if (!/full street|hotel address/i.test(addressPrompt)) {
  throw new Error("Accepted option did not request an exact delivery address");
}
if (!addressProposal.includes("1 Demo Hotel Drive")) {
  throw new Error("Typed delivery address was not proposed for confirmation");
}
for (const required of ["airline", "airport", "baggage reference"]) {
  if (!incidentDetails.toLowerCase().includes(required)) {
    throw new Error(`Incident-details turn omitted: ${required}`);
  }
}
if ((incidentDetails.match(/^• /gm) ?? []).length < 3) {
  throw new Error("Incident-details turn must list each missing detail separately");
}
if (!/\b(?:exact|specific|airport (?:name|code)|BOS|Logan)\b/i.test(airportClarification)) {
  throw new Error("Ambiguous Boston response did not trigger exact-airport clarification");
}
if (/ready for authorization/i.test(airportClarification)) {
  throw new Error("Ambiguous Boston response was authorized before airport clarification");
}
for (const required of [
  "• Airline: Delta",
  "• Arrival airport: BOS",
  "• Baggage reference: RF392942",
  "exact approval summary",
  "1 Demo Hotel Drive",
  "nothing has been purchased",
]) {
  if (!summary.toLowerCase().includes(required.toLowerCase())) {
    throw new Error(`Authorization summary omitted: ${required}`);
  }
}
for (const required of ["154", "approval email"]) {
  if (!summary.toLowerCase().includes(required)) {
    throw new Error(`Authorization summary omitted: ${required}`);
  }
}
if (/https:\/\//i.test(checkout)) {
  throw new Error("Checkout text exposed a raw URL instead of a rich link card");
}
if (presentation?.linkUrl !== "https://tavra.example/pay/smoke-checkout") {
  throw new Error("Checkout handoff omitted the secure rich link");
}
for (const forbidden of [
  "purchase is set",
  "ordered",
  "purchased",
  "reserved",
  "submitted",
  "proceed with",
  "moving forward with",
  "arrange the",
  "secure the",
]) {
  if (incidentDetails.toLowerCase().includes(forbidden)) {
    throw new Error(`Incident-details turn made an unsupported action claim: ${forbidden}`);
  }
}
for (const forbidden of [
  "senso",
  "emp_demo",
  "client_facing_traveller",
  "team-recovery-policy",
  "demo_merchant",
  "vendor b",
  "candidate b",
  "content id",
  "profile values:",
  "policy limits:",
  "deadline:",
  "destination:",
  "i can request",
]) {
  const transcript = [
    intake,
    sizes,
    sizeFollowup,
    option,
    addressPrompt,
    addressProposal,
    incidentDetails,
    airportClarification,
    summary,
    checkout,
  ]
    .join(" ")
    .toLowerCase();
  if (transcript.includes(forbidden)) {
    throw new Error(`Combined reply exposed an internal label: ${forbidden}`);
  }
}
for (const reply of [
  intake,
  sizes,
  sizeFollowup,
  option,
  addressPrompt,
  addressProposal,
  incidentDetails,
  airportClarification,
]) {
  if ((reply.match(/\?/g) ?? []).length !== 1) {
    throw new Error("Each recovery turn must contain exactly one next-step question");
  }
}

console.log(`Senso + OpenAI smoke test passed using ${openAI.openAIModel}.`);
