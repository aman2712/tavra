import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { createSandboxAirlineClaimSubmissionProvider } from "./airline-claim.js";
import { createApp } from "./app.js";
import { SqliteCheckoutStateStore } from "./checkout-state-store.js";
import { loadServerConfig } from "./config.js";
import { demoDeliveryEstimate } from "./demo-delivery.js";
import {
  migrateJsonlProcessedEvents,
  SqliteProcessedEventStore,
} from "./event-store.js";
import { createCheckoutIMessageAppUpdate } from "./imessage-app.js";
import {
  createLinqClient,
  createLinqLocationProvider,
  createLinqMessageSender,
} from "./linq.js";
import {
  createLiveCommerceService,
  liveCommerceOrderCardLabel,
  type LiveCommerceService,
  type LiveCommerceStatusEvent,
} from "./live-commerce.js";
import { createMessageReplyProcessor } from "./message-reply.js";
import {
  createOpenAIClient,
  createOpenAIIntentRouter,
  createOpenAIRecoveryTurnInterpreter,
  createOpenAIReplyGenerator,
  type TavraReplyGenerator,
} from "./openai.js";
import { createPravaUcpCommerceProvider } from "./prava-commerce.js";
import {
  MacOsKeychainPravaTokenStore,
  PravaStreamableHttpTransport,
} from "./prava-mcp.js";
import {
  createPravaCheckoutService,
  type PravaCheckoutService,
  type PravaStatusEvent,
} from "./prava.js";
import {
  createOfficialMerchantProductMedia,
  createProductMediaResolver,
  resolveCheckoutCardMedia,
} from "./product-media.js";
import { JsonlRecoveryCaseLedger } from "./recovery-case.js";
import { createSandboxReimbursementPacketDelivery } from "./reimbursement-delivery.js";
import { SqliteRecoveryStateStore } from "./recovery-state-store.js";
import {
  MEDDU_MERCHANT_CONFIG,
  createMedduUcpClient,
} from "./sandbox-merchant.js";
import { createMedduPravaMerchantAdapter } from "./sandbox-prava-adapter.js";
import { createSensoKnowledgeProvider, loadIdentityResolver } from "./senso.js";

const config = loadServerConfig();
const commerceMode = config.commerceMode ?? "disabled";
const airlineClaimSubmissionProvider =
  commerceMode === "sandbox"
    ? createSandboxAirlineClaimSubmissionProvider()
    : undefined;
const linqClient = createLinqClient(config);
const openAIClient = createOpenAIClient(config.openAIApiKey);
const identityResolver = loadIdentityResolver(
  resolve(process.cwd(), config.sensoIdentityMapPath),
);
const knowledgeProvider = createSensoKnowledgeProvider({
  apiKey: config.sensoApiKey,
  baseUrl: config.sensoBaseUrl,
  identityResolver,
  pollIntervalMs: 500,
  findAttempts: 20,
  processingAttempts: 40,
});
const sender = createLinqMessageSender(linqClient, {
  documentUrl: ({ eventId, filename }) =>
    new URL(
      `/checkout-assets/documents/${encodeURIComponent(eventId)}/${encodeURIComponent(filename)}`,
      config.publicBaseUrl,
    ).toString(),
});
const locationProvider = createLinqLocationProvider(linqClient);
const recoveryCases = new JsonlRecoveryCaseLedger(
  resolve(process.cwd(), "data/recovery-cases.jsonl"),
);
const sqlitePath = resolve(process.cwd(), "data/tavra.sqlite");
const checkoutState = new SqliteCheckoutStateStore(sqlitePath);
const recoveryState = new SqliteRecoveryStateStore(sqlitePath);
const store = new SqliteProcessedEventStore(sqlitePath);
const importedProcessedEvents = await migrateJsonlProcessedEvents(
  resolve(process.cwd(), "data/processed-events.jsonl"),
  store,
);
if (importedProcessedEvents > 0) {
  console.info(
    JSON.stringify({
      scope: "processed_event_migration",
      imported: importedProcessedEvents,
    }),
  );
}
const productAssetsDirectory = resolve(process.cwd(), "web/public/products");
const productMediaResolver = createProductMediaResolver({
  publicBaseUrl: config.publicBaseUrl,
  assetAvailable: (assetFilename) =>
    existsSync(resolve(productAssetsDirectory, assetFilename)),
  liveMediaUrlAllowed: (url) =>
    MEDDU_MERCHANT_CONFIG.imageHosts.includes(
      url.hostname.toLowerCase() as (typeof MEDDU_MERCHANT_CONFIG.imageHosts)[number],
    ),
});
const sandboxMerchant =
  commerceMode === "sandbox" ? createMedduUcpClient() : undefined;

/** Legacy sandbox cards do not have a live workflow row to bind in SQLite. */
const sandboxCheckoutAppCards = new Map<
  string,
  { messageId: string; chatId: string }
>();
let generator: TavraReplyGenerator;
let prava: PravaCheckoutService | undefined;
let liveCommerce: LiveCommerceService | undefined;

function compactVariant(options: Record<string, string>): string | undefined {
  const value = Object.entries(options)
    .map(([name, option]) => `${name} ${option}`)
    .join(", ")
    .replace(/\s+/g, " ")
    .trim();
  return value || undefined;
}

function compactStatusValue(value: string, maximum = 180): string {
  const normalized = value
    .replace(/[—–]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length <= maximum
    ? normalized
    : `${normalized.slice(0, maximum - 1).trimEnd()}…`;
}

function sanitizeStatusText(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(?:pk|sk)_(?:test|live)_[A-Za-z0-9_-]+\b/g, "[redacted-key]")
    .replace(/\b\d{12,19}\b/g, "[redacted-card]")
    .replace(
      /\b(?:dynamic[_ -]?cvv|cvv|security code)\s*[:=]?\s*\d{3,4}\b/gi,
      "[redacted-security-code]",
    )
    .replace(/\s*[—–]\s*/g, " - ")
    .trim()
    .slice(0, 2_000);
}

const deliverSandboxReimbursementPacket =
  createSandboxReimbursementPacketDelivery({
    sender,
    recoveryCases,
  });

function liveProductMedia(event: LiveCommerceStatusEvent) {
  const offer = event.selection.offer;
  if (!offer.imageUrl) return [];
  const productRef =
    offer.variantId
      .replace(/[^A-Za-z0-9._:-]/g, "-")
      .replace(/^[^A-Za-z0-9]+/, "")
      .slice(0, 128) || "live-product";
  const exactMedia = createOfficialMerchantProductMedia({
    productRef,
    lineItemDescription: offer.title || offer.description,
    imageUrl: offer.imageUrl,
    imageDescription: `Product image for ${offer.title || offer.description}`,
    merchantName: offer.merchant.name,
  });
  if (!exactMedia) return [];
  return [
    {
      ...exactMedia,
      url: new URL(
        `/api/prava/checkouts/${encodeURIComponent(event.checkoutId)}/products/0/image`,
        config.publicBaseUrl,
      ).toString(),
    },
  ];
}

function liveStatusText(
  event: LiveCommerceStatusEvent,
  recoveryCaseId: string,
): string {
  const total = `${event.quote.total.currency} ${event.quote.total.amount}`;
  if (
    event.state === "order_confirmed" &&
    event.checkoutResult?.status === "ordered"
  ) {
    const merchantName = compactStatusValue(event.selection.offer.merchant.name);
    const orderId = compactStatusValue(event.checkoutResult.orderId);
    const delivery = event.quote.estimatedArrival
      ? `• Estimated arrival: ${event.quote.estimatedArrival}`
      : event.quote.deliveryLabel
        ? `• Delivery: ${compactStatusValue(event.quote.deliveryLabel)}`
        : "• Delivery: waiting for merchant confirmation";
    return [
      `Your order is confirmed with ${merchantName}.`,
      "",
      `• Merchant order: ${orderId}`,
      `• Total: ${total}`,
      delivery,
      `• Recovery case: ${recoveryCaseId}`,
      "• Reimbursement: expense recorded, itemized receipt still required",
      "",
      "Dispatch and delivery are not confirmed until the merchant provides those updates.",
    ].join("\n");
  }
  if (event.state === "reconciliation_required") {
    const detail =
      event.checkoutResult?.status === "reconciliation_required"
        ? sanitizeStatusText(event.checkoutResult.message)
        : null;
    return [
      "Prava finished the secure step, but Tavra could not verify the merchant checkout outcome.",
      "",
      detail ? `• Prava detail: ${detail}` : "",
      "• No merchant order is being claimed",
      "• Tavra will not retry checkout automatically",
      `• Recovery case: ${recoveryCaseId}`,
      "",
      "Manual reconciliation is required before this purchase can continue.",
    ].filter(Boolean).join("\n");
  }
  if (event.state === "canceled") {
    return [
      "The purchase approval was canceled.",
      "",
      "• No merchant order was placed by Tavra",
      `• Recovery case: ${recoveryCaseId}`,
    ].join("\n");
  }
  const detail =
    event.checkoutResult?.status === "failed"
      ? sanitizeStatusText(event.checkoutResult.message)
      : null;
  return [
    "The secure purchase did not complete.",
    "",
    detail ? `• Prava detail: ${detail}` : "",
    "• No merchant order is confirmed",
    `• Recovery case: ${recoveryCaseId}`,
    "",
    "Nothing will be retried unless you review and approve a new attempt.",
  ].filter(Boolean).join("\n");
}

async function ensurePreparedLiveRecoveryCase(
  event: LiveCommerceStatusEvent,
) {
  const existing = await recoveryCases.get(event.caseId);
  if (!existing?.commerce) {
    const workflow = await liveCommerce?.getWorkflow(event.checkoutId);
    if (!workflow) {
      throw new Error("Live commerce workflow is missing for recovery evidence");
    }
    await recoveryCases.saveLiveCommercePrepared({
      checkoutId: workflow.checkoutId,
      request: workflow.payload.request,
      selection: workflow.payload.selection,
      quote: workflow.payload.quote,
      paymentSessionId: workflow.payload.paymentSession?.sessionId ?? null,
      status: workflow.payload.paymentSession
        ? "approval_pending"
        : workflow.payload.quote
          ? "quote_review"
          : "offer_review",
    });
  }
  return recoveryCases.recordLiveCommerce(event);
}

async function handleLiveCommerceStatus(
  event: LiveCommerceStatusEvent,
): Promise<void> {
  const recoveryCase = await ensurePreparedLiveRecoveryCase(event);
  const text = sanitizeStatusText(
    liveStatusText(event, recoveryCase.caseId),
  );
  await sender.sendText(
    event.chatId,
    `live-commerce-${event.state}-${event.checkoutId}`,
    text,
  );

  const appCard = await checkoutState.getCard(event.checkoutId);
  if (appCard && appCard.chatId === event.chatId && sender.updateAppCard) {
    const merchantOrderId =
      event.state === "order_confirmed" &&
      event.checkoutResult?.status === "ordered"
        ? event.checkoutResult.orderId
        : null;
    const completed = merchantOrderId !== null;
    const completedOrderLabel = liveCommerceOrderCardLabel(event);
    try {
      await sender.updateAppCard(
        appCard.messageId,
        createCheckoutIMessageAppUpdate({
          approvalUrl: new URL(
            `/pay/${encodeURIComponent(event.checkoutId)}`,
            config.publicBaseUrl,
          ).toString(),
          totalAmount: event.quote.total.amount,
          currency: event.quote.total.currency,
          status: completed
            ? "completed"
            : event.state === "reconciliation_required"
              ? "reconciliation_required"
              : "failed",
          merchantOutcome: completed ? "live" : "not_attempted",
          productMedia: liveProductMedia(event),
          merchantName: event.selection.offer.merchant.name,
          ...(merchantOrderId
            ? {
                merchantOrderId,
                primaryVariant:
                  completedOrderLabel ?? `Order ${merchantOrderId}`,
              }
            : {
                primaryVariant: compactVariant(
                  event.selection.offer.options,
                ),
              }),
        }),
      );
    } catch (error) {
      console.warn(
        JSON.stringify({
          scope: "linq_live_imessage_app_update",
          status: "failed_best_effort",
          checkoutRef: event.checkoutId.slice(0, 8),
          error: error instanceof Error ? error.message : "Unknown error",
        }),
      );
    }
  }
  generator.recordExternalReply(event.chatId, text);
}

async function handleSandboxStatus(event: PravaStatusEvent): Promise<void> {
  const recoveryCase =
    event.status === "sandbox_validated" && event.recovery
      ? await recoveryCases.get(event.recovery.caseId)
      : await recoveryCases.recordPayment(event);
  const incident = recoveryCase
    ? `${recoveryCase.incident.airline}, ${recoveryCase.incident.arrivalAirport}${recoveryCase.incident.baggageReference ? `, ref ${recoveryCase.incident.baggageReference}` : ""}`
    : null;
  const total = `${event.currency} ${event.totalAmount}`;
  const text = sanitizeStatusText(event.status === "sandbox_validated"
    ? [
        "End-to-end payment capability check complete.",
        "",
        event.products[0]?.description
          ? `• Product: ${compactStatusValue(event.products[0].description)}`
          : "",
        event.merchantAttempt?.merchantName
          ? `• Merchant: ${compactStatusValue(event.merchantAttempt.merchantName)}`
          : "",
        `• Approved amount: ${total}`,
        "• Prava approval: complete",
        "• One-time card: issued for this purchase",
        "• End-merchant checkout: attempted once",
        "• Merchant result: expected test-card or insufficient-funds decline",
        "• Outcome reported back to Prava",
        recoveryCase ? `• Recovery case: ${recoveryCase.caseId}` : "",
        "",
        "This is the expected end-to-end sandbox result. No merchant order is being claimed.",
      ]
        .filter(Boolean)
        .join("\n")
    : event.status === "completed"
    ? event.merchantOutcome === "live"
      ? [
          `The merchant accepted the ${total} order.`,
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
          `Approval complete. Your recovery order has been placed for ${total}.`,
          recoveryCase ? `\n• Recovery case: ${recoveryCase.caseId}` : "",
          event.merchantOrderId
            ? `• Order reference: ${event.merchantOrderId}`
            : "",
          recoveryCase?.recovery.deliveryAddress
            ? `• Delivery address: ${recoveryCase.recovery.deliveryAddress}`
            : "",
          `• Delivery expected by: ${demoDeliveryEstimate(recoveryCase?.recovery.needBy)}`,
          incident ? `• Claim evidence recorded: ${incident}` : "",
          "• Reimbursement packet: approval recorded",
        ]
          .filter(Boolean)
          .join("\n")
    : event.status === "reconciliation_required"
      ? `Prava finished a secure step, but Tavra could not verify the merchant outcome.${event.failureCode || event.failureMessage ? `\n\n• Prava detail: ${[event.failureCode, event.failureMessage].filter(Boolean).join(": ")}` : ""}\n\nI’m not claiming an order or charge. This recovery case needs payment reconciliation before anything continues.`
      : `The secure Prava approval did not complete.${event.failureCode || event.failureMessage ? `\n\n• Prava detail: ${[event.failureCode, event.failureMessage].filter(Boolean).join(": ")}` : ""}\n\nNothing was ordered by Tavra. Tell me when you want a fresh link.`);
  await sender.sendText(
    event.chatId,
    `prava-${event.status}-${event.checkoutId}`,
    text,
  );
  let reimbursementOffer: string | null = null;
  if (recoveryCase && event.status === "completed") {
    try {
      reimbursementOffer = await deliverSandboxReimbursementPacket(
        event,
        recoveryCase,
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          scope: "linq_reimbursement_packet",
          status: "retrying",
          caseRef: recoveryCase.caseId.slice(0, 12),
          error: error instanceof Error ? error.message : "Unknown packet error",
        }),
      );
      try {
        await sender.sendText(
          event.chatId,
          `reimbursement-packet-processing-${event.checkoutId}`,
          "Your approval is complete. The reimbursement PDF is still processing, and I’m retrying the attachment automatically.",
        );
      } catch {
        // The Prava status monitor retries the entire idempotent notification.
      }
      throw error;
    }
  }
  const appCard = sandboxCheckoutAppCards.get(event.checkoutId);
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
          merchantOrderId: event.merchantOrderId,
        }),
      );
      sandboxCheckoutAppCards.delete(event.checkoutId);
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
  generator.recordExternalReply(
    event.chatId,
    reimbursementOffer ? `${text}\n\n${reimbursementOffer}` : text,
  );
}

if (commerceMode === "live") {
  const tokenStore = new MacOsKeychainPravaTokenStore();
  const transport = new PravaStreamableHttpTransport({
    tokenStore,
    endpoint: config.pravaMcpUrl,
  });
  const provider = createPravaUcpCommerceProvider({ transport });
  liveCommerce = createLiveCommerceService({
    provider,
    store: checkoutState,
    publicBaseUrl: config.publicBaseUrl,
    async onPrepared(snapshot) {
      if (
        snapshot.state !== "offer_review" &&
        snapshot.state !== "quote_review" &&
        snapshot.state !== "approval_pending"
      ) {
        return;
      }
      await recoveryCases.saveLiveCommercePrepared({
        checkoutId: snapshot.checkoutId,
        request: snapshot.payload.request,
        selection: snapshot.payload.selection,
        quote: snapshot.payload.quote,
        paymentSessionId: snapshot.payload.paymentSession?.sessionId ?? null,
        status: snapshot.state,
      });
    },
    onStatus: handleLiveCommerceStatus,
  });
} else if (commerceMode === "sandbox") {
  if (
    config.pravaMode !== "sandbox" ||
    !config.pravaBackendUrl ||
    !config.pravaPublishableKey ||
    !config.pravaSecretKey
  ) {
    throw new Error(
      "TAVRA_COMMERCE_MODE=sandbox requires complete Prava sandbox credentials",
    );
  }
  prava = createPravaCheckoutService({
    backendUrl: config.pravaBackendUrl,
    publishableKey: config.pravaPublishableKey,
    secretKey: config.pravaSecretKey,
    publicBaseUrl: config.publicBaseUrl,
    checkoutMode: config.pravaCheckoutMode,
    mode: "sandbox",
    merchantCheckout: createMedduPravaMerchantAdapter(),
    onStatus: handleSandboxStatus,
  });
}

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
    liveCommerce,
    recoveryStateStore: recoveryState,
    airlineClaimSubmissionProvider,
    sandboxMerchant,
  },
);

const processEvent = createMessageReplyProcessor({
  fromNumber: config.fromNumber,
  generator,
  sender,
  store,
  async onAppCardSent({ checkoutId, messageId, chatId }) {
    if (commerceMode === "live") {
      await checkoutState.saveCard({
        checkoutId,
        messageId,
        chatId,
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    if (commerceMode === "sandbox") {
      sandboxCheckoutAppCards.set(checkoutId, { messageId, chatId });
    }
  },
});
const app = createApp({
  config,
  client: linqClient,
  processEvent,
  ...(prava ? { prava } : {}),
  ...(liveCommerce ? { liveCommerce } : {}),
});

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
      commerce: commerceMode,
      payments:
        commerceMode === "live"
          ? "prava-mcp-ucp-live"
          : commerceMode === "sandbox"
            ? "prava-sandbox"
            : "disabled",
      messagesExtension: config.iMessageAppIdentity ? "enabled" : "link-fallback",
    }),
  );
  if (liveCommerce) {
    void liveCommerce.resume().catch((error) => {
      console.error(
        JSON.stringify({
          scope: "live_commerce_resume",
          status: "failed",
          error: error instanceof Error ? error.message : "Unknown error",
        }),
      );
    });
  }
});

function shutdown(signal: string) {
  console.info(JSON.stringify({ service: "tavra", status: "stopping", signal }));
  server.close((error) => {
    process.exit(error ? 1 : 0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
