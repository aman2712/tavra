import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { createApp } from "./app.js";
import { loadServerConfig } from "./config.js";
import { JsonlProcessedEventStore } from "./event-store.js";
import { createCheckoutIMessageAppUpdate } from "./imessage-app.js";
import {
  createLinqClient,
  createLinqLocationProvider,
  createLinqMessageSender,
} from "./linq.js";
import { createMessageReplyProcessor } from "./message-reply.js";
import {
  createOpenAIClient,
  createOpenAIIntentRouter,
  createOpenAIRecoveryTurnInterpreter,
  createOpenAIReplyGenerator,
  type TavraReplyGenerator,
} from "./openai.js";
import {
  createPravaCheckoutService,
  createSandboxMerchantCheckoutAdapter,
} from "./prava.js";
import {
  createProductMediaResolver,
  resolveCheckoutCardMedia,
} from "./product-media.js";
import { JsonlRecoveryCaseLedger } from "./recovery-case.js";
import { createSensoKnowledgeProvider, loadIdentityResolver } from "./senso.js";

const config = loadServerConfig();
const linqClient = createLinqClient(config);
const openAIClient = createOpenAIClient(config.openAIApiKey);
const identityResolver = loadIdentityResolver(
  resolve(process.cwd(), config.sensoIdentityMapPath),
);
const knowledgeProvider = createSensoKnowledgeProvider({
  apiKey: config.sensoApiKey,
  baseUrl: config.sensoBaseUrl,
  identityResolver,
});
const sender = createLinqMessageSender(linqClient);
const locationProvider = createLinqLocationProvider(linqClient);
const recoveryCases = new JsonlRecoveryCaseLedger(
  resolve(process.cwd(), "data/recovery-cases.jsonl"),
);
const productAssetsDirectory = resolve(process.cwd(), "web/public/products");
const productMediaResolver = createProductMediaResolver({
  publicBaseUrl: config.publicBaseUrl,
  assetAvailable: (assetFilename) =>
    existsSync(resolve(productAssetsDirectory, assetFilename)),
});
const checkoutAppCards = new Map<string, { messageId: string; chatId: string }>();
let generator: TavraReplyGenerator;
const prava = createPravaCheckoutService({
  backendUrl: config.pravaBackendUrl,
  publishableKey: config.pravaPublishableKey,
  secretKey: config.pravaSecretKey,
  publicBaseUrl: config.publicBaseUrl,
  checkoutMode: config.pravaCheckoutMode,
  preselectSavedCard: true,
  mode: config.pravaMode,
  merchantCheckout:
    config.pravaMode === "sandbox"
      ? createSandboxMerchantCheckoutAdapter()
      : undefined,
  async onStatus(event) {
    const recoveryCase = await recoveryCases.recordPayment(event);
    const incident = recoveryCase
      ? `${recoveryCase.incident.airline}, ${recoveryCase.incident.arrivalAirport}${recoveryCase.incident.baggageReference ? `, ref ${recoveryCase.incident.baggageReference}` : ""}`
      : null;
    const text = event.status === "completed"
      ? event.merchantOutcome === "live"
        ? [
            `The merchant accepted the $${event.totalAmount} ${event.currency} test order.`,
            recoveryCase ? `\n• Recovery case: ${recoveryCase.caseId}` : "",
            event.merchantOrderId
              ? `• Merchant order: ${event.merchantOrderId}`
              : "",
            recoveryCase?.recovery.deliveryAddress
              ? `• Delivery address: ${recoveryCase.recovery.deliveryAddress}`
              : "",
            "• Dispatch and delivery: waiting for merchant confirmation",
          ]
            .filter(Boolean)
            .join("\n")
        : [
            `Prava sandbox approval is complete for $${event.totalAmount} ${event.currency}.`,
            recoveryCase ? `\n• Recovery case: ${recoveryCase.caseId}` : "",
            recoveryCase?.recovery.deliveryAddress
              ? `• Delivery address recorded: ${recoveryCase.recovery.deliveryAddress}`
              : "",
            incident ? `• Claim evidence recorded: ${incident}` : "",
            "• Reimbursement packet: draft, waiting for a verified merchant receipt",
            "\nThe merchant step was simulated. No live order, charge, dispatch, or delivery was created.",
          ]
            .filter(Boolean)
            .join("\n")
      : event.status === "reconciliation_required"
        ? "Prava finished a secure step, but Tavra could not verify the merchant outcome. I’m not claiming an order or charge. This recovery case needs payment reconciliation before anything continues."
        : "The secure Prava approval did not complete. Nothing was ordered by Tavra. Tell me when you want a fresh link.";
    await sender.sendText(
      event.chatId,
      `prava-${event.status}-${event.checkoutId}`,
      text,
    );
    const appCard = checkoutAppCards.get(event.checkoutId);
    if (appCard && appCard.chatId === event.chatId && sender.updateAppCard) {
      try {
        const productMedia = resolveCheckoutCardMedia(
          productMediaResolver,
          event.products,
        );
        await sender.updateAppCard(
          appCard.messageId,
          createCheckoutIMessageAppUpdate({
            approvalUrl: new URL(
              `/pay/${encodeURIComponent(event.checkoutId)}`,
              config.publicBaseUrl,
            ).toString(),
            totalAmount: event.totalAmount,
            currency: event.currency,
            status: event.status,
            merchantOutcome: event.merchantOutcome,
            productMedia,
          }),
        );
        checkoutAppCards.delete(event.checkoutId);
      } catch (error) {
        console.warn(
          JSON.stringify({
            scope: "linq_imessage_app_update",
            status: "failed",
            checkoutId: event.checkoutId,
            error: error instanceof Error ? error.message : "Unknown error",
          }),
        );
      }
    }
    generator.recordExternalReply(event.chatId, text);
  },
});
generator = createOpenAIReplyGenerator(
  openAIClient,
  config.openAIModel,
  knowledgeProvider,
  createOpenAIIntentRouter(openAIClient, config.openAIRouterModel),
  createOpenAIRecoveryTurnInterpreter(openAIClient, config.openAIRouterModel),
  prava,
  {
    locationProvider,
    productMediaResolver,
    caseLedger: recoveryCases,
    iMessageAppIdentity: config.iMessageAppIdentity,
  },
);
const store = new JsonlProcessedEventStore(
  resolve(process.cwd(), "data/processed-events.jsonl"),
);
const processEvent = createMessageReplyProcessor({
  fromNumber: config.fromNumber,
  generator,
  sender,
  store,
  onAppCardSent({ checkoutId, messageId, chatId }) {
    checkoutAppCards.set(checkoutId, { messageId, chatId });
  },
});
const app = createApp({ config, client: linqClient, processEvent, prava });

const server = app.listen(config.port, "0.0.0.0", () => {
  console.info(
    JSON.stringify({
      service: "tavra",
      status: "listening",
      port: config.port,
      linqMode: config.mode,
      openAIModel: config.openAIModel,
      openAIRouterModel: config.openAIRouterModel,
      knowledge: "senso-scoped",
      payments: `prava-${config.pravaMode}`,
      messagesExtension: config.iMessageAppIdentity ? "enabled" : "link-fallback",
    }),
  );
});

function shutdown(signal: string) {
  console.info(JSON.stringify({ service: "tavra", status: "stopping", signal }));
  server.close((error) => {
    process.exit(error ? 1 : 0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
