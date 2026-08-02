import { randomBytes } from "node:crypto";

import {
  assertWithinRecoveryCap,
  commerceAmountMinor,
  isValidHttpsProductImage,
  normalizeCommerceAmount,
  selectRecoveryEssential,
  type CommerceAddress,
  type AddCommerceAddressRequest,
  type CommerceCheckoutResult,
  type CommerceMoney,
  type CommercePaymentSession,
  type CommerceProvider,
  type CommerceQuote,
  type RecoveryEssentialRequest,
  type RecoveryEssentialSelection,
} from "./commerce.js";
import {
  type CheckoutStateStore,
  type CheckoutWorkflowSnapshot,
} from "./checkout-state-store.js";

export type DeliveryDeadlineAssessment = "meets" | "misses" | "unverified";

export interface LiveCommerceRecoveryRequest {
  caseId: string;
  chatId: string;
  employeeId: string;
  employeePhone: string;
  employeeEmail: string | null;
  employeeAllowance?: CommerceMoney | null;
  needBy: string;
  needByIso?: string | null;
  deliveryArea: string;
  address: CommerceAddress;
  essentials: RecoveryEssentialRequest;
  incident: {
    airline: string | null;
    arrivalAirport: string | null;
    baggageReference: string | null;
    noticeAttachmentIds: string[];
    passengerName: string | null;
    flightNumber: string | null;
    incidentDate: string | null;
  };
}

export interface LiveCommerceWorkflowPayload {
  schemaVersion: 1;
  request: LiveCommerceRecoveryRequest;
  selection: RecoveryEssentialSelection;
  quote: CommerceQuote | null;
  paymentSession: CommercePaymentSession | null;
  checkoutResult: CommerceCheckoutResult | null;
  deadlineAssessment: DeliveryDeadlineAssessment;
  offerAuthorizationEventId: string | null;
  purchaseAuthorizationEventId: string | null;
  terminalNotified: boolean;
}

export interface PreparedLiveCommerceOffer {
  checkoutId: string;
  selection: RecoveryEssentialSelection;
  address: CommerceAddress;
}

export interface LiveCommerceStatusEvent {
  checkoutId: string;
  caseId: string;
  chatId: string;
  employeeId: string;
  employeePhone: string;
  state:
    | "order_confirmed"
    | "failed"
    | "reconciliation_required"
    | "canceled";
  selection: RecoveryEssentialSelection;
  quote: CommerceQuote;
  paymentSessionId: string | null;
  checkoutResult: CommerceCheckoutResult | null;
}

export type LiveCommercePublicStatus =
  | { status: "offer_review" | "quote_review" | "approval_pending" }
  | { status: "merchant_checkout_pending" }
  | {
      status: "completed";
      merchantOrderId: string;
      merchantOutcome: "live";
    }
  | { status: "reconciliation_required"; code?: string | null; message: string }
  | { status: "failed"; code?: string | null; message: string }
  | { status: "canceled"; message: string };

export interface LiveCommerceService {
  health(): ReturnType<CommerceProvider["health"]>;
  listAddresses(): ReturnType<CommerceProvider["listAddresses"]>;
  addAddress(
    request: AddCommerceAddressRequest,
  ): ReturnType<CommerceProvider["addAddress"]>;
  prepareOffer(
    request: LiveCommerceRecoveryRequest,
  ): Promise<PreparedLiveCommerceOffer | null>;
  createQuote(input: {
    checkoutId: string;
    authorizationEventId: string;
  }): Promise<CheckoutWorkflowSnapshot<LiveCommerceWorkflowPayload>>;
  createApproval(input: {
    checkoutId: string;
    authorizationEventId: string;
    incident?: LiveCommerceRecoveryRequest["incident"];
  }): Promise<{ checkoutId: string; url: string; expiresAt: string }>;
  getWorkflow(
    checkoutId: string,
  ): Promise<CheckoutWorkflowSnapshot<LiveCommerceWorkflowPayload> | null>;
  getStatus(checkoutId: string): Promise<LiveCommercePublicStatus | null>;
  getApprovalTarget(checkoutId: string): Promise<string | null>;
  getProductImageSource(checkoutId: string, index: number): Promise<string | null>;
  revoke(checkoutId: string): Promise<boolean>;
  resume(): Promise<void>;
}

/**
 * Compact terminal-card copy that keeps the selected variant and the verified
 * merchant order reference together when the card layout has one subtitle.
 */
export function liveCommerceOrderCardLabel(
  event: LiveCommerceStatusEvent,
): string | null {
  if (
    event.state !== "order_confirmed" ||
    event.checkoutResult?.status !== "ordered"
  ) {
    return null;
  }
  const selectedVariant =
    Object.entries(event.selection.offer.options)
      .map(([name, value]) => `${name} ${value}`)
      .join(", ")
      .replace(/\s+/g, " ")
      .trim() || event.selection.offer.variantId.trim();
  const orderId = event.checkoutResult.orderId.replace(/\s+/g, " ").trim();
  if (!selectedVariant || !orderId) return null;
  return `${selectedVariant} | Order ${orderId}`;
}

function cleanId(value: string, label: string): string {
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > 180) throw new Error(`${label} is invalid`);
  return cleaned;
}

function sameMoney(left: CommerceMoney, right: CommerceMoney): boolean {
  return (
    left.currency === right.currency &&
    commerceAmountMinor(left.amount) === commerceAmountMinor(right.amount)
  );
}

function validateQuote(
  quote: CommerceQuote,
  selection: RecoveryEssentialSelection,
  addressId: string,
): void {
  if (
    quote.offer.productId !== selection.offer.productId ||
    quote.offer.variantId !== selection.offer.variantId ||
    quote.offer.merchant.domain !== selection.offer.merchant.domain
  ) {
    throw new Error("Prava quote does not match the selected merchant variant");
  }
  if (quote.addressId !== addressId) {
    throw new Error("Prava quote does not match the confirmed delivery address");
  }
  const currency = quote.total.currency;
  if (
    quote.subtotal.currency !== currency ||
    quote.shipping.currency !== currency ||
    quote.tax.currency !== currency
  ) {
    throw new Error("Prava quote returned mixed currencies");
  }
  const calculated =
    commerceAmountMinor(quote.subtotal.amount) +
    commerceAmountMinor(quote.shipping.amount) +
    commerceAmountMinor(quote.tax.amount);
  if (calculated !== commerceAmountMinor(quote.total.amount)) {
    throw new Error("Prava quote total does not match subtotal, shipping, and tax");
  }
  assertWithinRecoveryCap(quote.total);
  if (!Number.isFinite(Date.parse(quote.expiresAt))) {
    throw new Error("Prava quote returned an invalid expiry");
  }
  if (Date.parse(quote.expiresAt) <= Date.now()) {
    throw new Error("Prava quote expired before it could be reviewed");
  }
}

function validatePaymentSession(
  session: CommercePaymentSession,
  quote: CommerceQuote,
): void {
  if (session.quoteId !== quote.quoteId || !sameMoney(session.total, quote.total)) {
    throw new Error("Prava payment session does not match the approved quote");
  }
  const url = new URL(session.paymentUrl);
  if (
    url.protocol !== "https:" ||
    !/(^|\.)prava\.space$/i.test(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error("Prava returned an untrusted payment approval URL");
  }
  if (!Number.isFinite(Date.parse(session.expiresAt))) {
    throw new Error("Prava payment session returned an invalid expiry");
  }
}

function validateCheckoutResult(
  result: CommerceCheckoutResult,
  quote: CommerceQuote,
): void {
  if (result.status !== "ordered") return;
  if (!result.orderId.trim() || !sameMoney(result.amount, quote.total)) {
    throw new Error("Prava checkout result does not match the approved quote");
  }
}

export function assessDeliveryDeadline(input: {
  needByIso?: string | null;
  estimatedArrival?: string | null;
}): DeliveryDeadlineAssessment {
  if (!input.needByIso || !input.estimatedArrival) return "unverified";
  const requested = Date.parse(input.needByIso);
  const estimated = Date.parse(input.estimatedArrival);
  if (!Number.isFinite(requested) || !Number.isFinite(estimated)) {
    return "unverified";
  }
  return estimated <= requested ? "meets" : "misses";
}

function publicStatus(
  snapshot: CheckoutWorkflowSnapshot<LiveCommerceWorkflowPayload>,
): LiveCommercePublicStatus {
  if (snapshot.state === "offer_review") return { status: "offer_review" };
  if (snapshot.state === "quote_review") return { status: "quote_review" };
  if (snapshot.state === "approval_pending") return { status: "approval_pending" };
  if (snapshot.state === "merchant_checkout_pending") {
    return { status: "merchant_checkout_pending" };
  }
  if (snapshot.state === "order_confirmed") {
    const result = snapshot.payload.checkoutResult;
    if (result?.status !== "ordered") {
      return {
        status: "reconciliation_required",
        message: "The stored merchant result is incomplete. No order details are being claimed.",
      };
    }
    return {
      status: "completed",
      merchantOrderId: result.orderId,
      merchantOutcome: "live",
    };
  }
  if (snapshot.state === "reconciliation_required") {
    const result = snapshot.payload.checkoutResult;
    return {
      status: "reconciliation_required",
      ...(result?.status === "reconciliation_required"
        ? { code: result.code }
        : {}),
      message:
        result?.status === "reconciliation_required"
          ? result.message
          : "Tavra could not verify the merchant outcome. No additional checkout will be attempted.",
    };
  }
  if (snapshot.state === "canceled") {
    return {
      status: "canceled",
      message: "This approval was canceled before merchant checkout.",
    };
  }
  const failed = snapshot.payload.checkoutResult;
  return {
    status: "failed",
    ...(failed?.status === "failed" ? { code: failed.code } : {}),
    message:
      failed?.status === "failed"
        ? failed.message
        : "The secure approval or merchant checkout did not complete.",
  };
}

export function createLiveCommerceService(options: {
  provider: CommerceProvider;
  store: CheckoutStateStore;
  publicBaseUrl: string;
  /** Records spend-adjacent workflow evidence before it is shown or monitored. */
  onPrepared?: (
    snapshot: CheckoutWorkflowSnapshot<LiveCommerceWorkflowPayload>,
  ) => Promise<void>;
  onStatus?: (event: LiveCommerceStatusEvent) => Promise<void>;
  monitorIntervalMs?: number;
  checkoutClaimLeaseMs?: number;
  now?: () => Date;
}): LiveCommerceService {
  if (options.provider.mode !== "live") {
    throw new Error("Live commerce service requires a live provider");
  }
  const publicBaseUrl = new URL(options.publicBaseUrl);
  if (publicBaseUrl.protocol !== "https:") {
    throw new Error("Live commerce card URLs require HTTPS");
  }
  const progressRequests = new Map<
    string,
    Promise<CheckoutWorkflowSnapshot<LiveCommerceWorkflowPayload> | null>
  >();
  const monitorTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const paymentStatusPollAt = new Map<string, number>();
  const intervalMs = Math.max(3_000, options.monitorIntervalMs ?? 3_000);
  const checkoutClaimLeaseMs = Math.max(
    30_000,
    options.checkoutClaimLeaseMs ?? 5 * 60_000,
  );
  const now = options.now ?? (() => new Date());
  const checkoutWorkerId = `checkout-worker-${randomBytes(16).toString("base64url")}`;

  async function save(
    snapshot: CheckoutWorkflowSnapshot<LiveCommerceWorkflowPayload>,
  ): Promise<CheckoutWorkflowSnapshot<LiveCommerceWorkflowPayload>> {
    snapshot.updatedAt = new Date().toISOString();
    await options.store.saveWorkflow(snapshot);
    return snapshot;
  }

  async function recordPrepared(
    snapshot: CheckoutWorkflowSnapshot<LiveCommerceWorkflowPayload>,
  ): Promise<void> {
    await options.onPrepared?.(structuredClone(snapshot));
  }

  async function notifyTerminal(
    snapshot: CheckoutWorkflowSnapshot<LiveCommerceWorkflowPayload>,
  ): Promise<void> {
    if (!options.onStatus || snapshot.payload.terminalNotified || !snapshot.payload.quote) {
      return;
    }
    if (
      snapshot.state !== "order_confirmed" &&
      snapshot.state !== "failed" &&
      snapshot.state !== "reconciliation_required" &&
      snapshot.state !== "canceled"
    ) {
      return;
    }
    const event: LiveCommerceStatusEvent = {
      checkoutId: snapshot.checkoutId,
      caseId: snapshot.caseId,
      chatId: snapshot.chatId,
      employeeId: snapshot.payload.request.employeeId,
      employeePhone: snapshot.payload.request.employeePhone,
      state: snapshot.state,
      selection: snapshot.payload.selection,
      quote: snapshot.payload.quote,
      paymentSessionId: snapshot.payload.paymentSession?.sessionId ?? null,
      checkoutResult: snapshot.payload.checkoutResult,
    };
    await options.store.enqueueNotification({
      checkoutId: snapshot.checkoutId,
      chatId: snapshot.chatId,
      payload: event,
      attempts: 0,
      createdAt: new Date().toISOString(),
    });
    try {
      await options.onStatus(event);
      snapshot.payload.terminalNotified = true;
      await save(snapshot);
      await options.store.markNotificationDelivered(snapshot.checkoutId);
    } catch (error) {
      console.warn(
        JSON.stringify({
          scope: "live_commerce_notification",
          checkoutRef: snapshot.checkoutId.slice(0, 8),
          status: "pending_retry",
          error: error instanceof Error ? error.message : "Unknown notification error",
        }),
      );
    }
  }

  function stopMonitor(checkoutId: string): void {
    const timer = monitorTimers.get(checkoutId);
    if (timer) clearTimeout(timer);
    monitorTimers.delete(checkoutId);
    paymentStatusPollAt.delete(checkoutId);
  }

  async function reconcileCheckoutIfAbandoned(
    snapshot: CheckoutWorkflowSnapshot<LiveCommerceWorkflowPayload>,
  ): Promise<CheckoutWorkflowSnapshot<LiveCommerceWorkflowPayload>> {
    const claim = await options.store.getMerchantCheckoutClaim(snapshot.checkoutId);
    const observedAt = now();
    if (claim && Date.parse(claim.leaseExpiresAt) > observedAt.getTime()) {
      return snapshot;
    }
    snapshot.state = "reconciliation_required";
    snapshot.payload.checkoutResult = {
      status: "reconciliation_required",
      message: claim
        ? "The merchant-checkout worker stopped before Tavra could verify its result. The outcome must be reconciled before any retry."
        : "Tavra found a merchant checkout in progress without its durable execution claim. The outcome must be reconciled before any retry.",
    };
    snapshot.updatedAt = observedAt.toISOString();
    const transitioned = await options.store.reconcileAbandonedMerchantCheckout(
      snapshot,
      observedAt.toISOString(),
    );
    const current = transitioned
      ? snapshot
      : await options.store.getWorkflow<LiveCommerceWorkflowPayload>(
          snapshot.checkoutId,
        );
    if (current && current.state !== "merchant_checkout_pending") {
      stopMonitor(current.checkoutId);
      await notifyTerminal(current);
    }
    return current ?? snapshot;
  }

  function scheduleMonitor(checkoutId: string): void {
    if (monitorTimers.has(checkoutId)) return;
    const timer = setTimeout(() => {
      monitorTimers.delete(checkoutId);
      void progress(checkoutId)
        .then((snapshot) => {
          if (
            snapshot &&
            (snapshot.state === "approval_pending" ||
              snapshot.state === "merchant_checkout_pending")
          ) {
            scheduleMonitor(checkoutId);
          }
        })
        .catch((error) => {
          console.warn(
            JSON.stringify({
              scope: "live_commerce_monitor",
              checkoutRef: checkoutId.slice(0, 8),
              status: "retrying",
              error: error instanceof Error ? error.message : "Unknown monitor error",
            }),
          );
          scheduleMonitor(checkoutId);
        });
    }, intervalMs);
    timer.unref?.();
    monitorTimers.set(checkoutId, timer);
  }

  async function progress(
    checkoutId: string,
  ): Promise<CheckoutWorkflowSnapshot<LiveCommerceWorkflowPayload> | null> {
    const active = progressRequests.get(checkoutId);
    if (active) return active;
    const operation = (async () => {
      const snapshot = await options.store.getWorkflow<LiveCommerceWorkflowPayload>(
        checkoutId,
      );
      if (!snapshot) return null;
      if (
        snapshot.state === "order_confirmed" ||
        snapshot.state === "failed" ||
        snapshot.state === "reconciliation_required" ||
        snapshot.state === "canceled"
      ) {
        stopMonitor(checkoutId);
        await notifyTerminal(snapshot);
        return snapshot;
      }
      if (snapshot.state === "merchant_checkout_pending") {
        return reconcileCheckoutIfAbandoned(snapshot);
      }
      if (snapshot.state !== "approval_pending") return snapshot;
      const paymentSession = snapshot.payload.paymentSession;
      const quote = snapshot.payload.quote;
      if (!paymentSession || !quote) {
        snapshot.state = "reconciliation_required";
        snapshot.payload.checkoutResult = {
          status: "reconciliation_required",
          message: "The approved payment session is not bound to a stored live quote.",
        };
        await save(snapshot);
        await notifyTerminal(snapshot);
        return snapshot;
      }
      if (Date.parse(paymentSession.expiresAt) <= Date.now()) {
        snapshot.state = "failed";
        snapshot.payload.checkoutResult = {
          status: "failed",
          message: "The Prava approval expired before it was completed.",
        };
        await save(snapshot);
        await notifyTerminal(snapshot);
        return snapshot;
      }
      const observedAt = now().getTime();
      const previousPollAt = paymentStatusPollAt.get(checkoutId) ?? 0;
      if (observedAt - previousPollAt < intervalMs) return snapshot;
      paymentStatusPollAt.set(checkoutId, observedAt);
      const status = await options.provider.getPaymentStatus(paymentSession.sessionId);
      if (status.status === "pending") return snapshot;
      if (status.status === "failed" || status.status === "not_found") {
        snapshot.state = "failed";
        snapshot.payload.checkoutResult = {
          status: "failed",
          ...(status.status === "failed" ? { code: status.code } : {}),
          message:
            status.status === "failed"
              ? status.message && status.code &&
                !status.message.toLowerCase().includes(status.code.toLowerCase())
                ? `${status.code}: ${status.message}`
                : status.message ?? status.code ?? "Prava approval failed."
              : "The Prava approval session was not found.",
        };
        await save(snapshot);
        await notifyTerminal(snapshot);
        return snapshot;
      }
      if (status.status === "unknown") {
        snapshot.state = "reconciliation_required";
        snapshot.payload.checkoutResult = {
          status: "reconciliation_required",
          message: `Prava returned an unsupported payment state (${status.rawStatus}).`,
        };
        await save(snapshot);
        await notifyTerminal(snapshot);
        return snapshot;
      }

      const claimedAt = now();
      const claimed = await options.store.claimMerchantCheckout<LiveCommerceWorkflowPayload>({
        checkoutId: snapshot.checkoutId,
        ownerId: checkoutWorkerId,
        claimedAt: claimedAt.toISOString(),
        leaseExpiresAt: new Date(
          claimedAt.getTime() + checkoutClaimLeaseMs,
        ).toISOString(),
      });
      if (!claimed) {
        const current = await options.store.getWorkflow<LiveCommerceWorkflowPayload>(
          snapshot.checkoutId,
        );
        if (!current) return null;
        return current.state === "merchant_checkout_pending"
          ? reconcileCheckoutIfAbandoned(current)
          : current;
      }
      let result: CommerceCheckoutResult;
      try {
        result = await options.provider.checkout({
          quote: claimed.payload.quote as CommerceQuote,
          paymentSession: claimed.payload.paymentSession as CommercePaymentSession,
          idempotencyKey: `${claimed.checkoutId}:merchant-checkout`,
          userApprovedTotal: Boolean(
            claimed.payload.purchaseAuthorizationEventId,
          ),
        });
        validateCheckoutResult(result, quote);
      } catch (error) {
        result = {
          status: "reconciliation_required",
          message:
            error instanceof Error
              ? `Merchant checkout outcome is unknown: ${error.message}`
              : "Merchant checkout outcome is unknown.",
        };
      }
      claimed.payload.checkoutResult = result;
      claimed.state =
        result.status === "ordered"
          ? "order_confirmed"
          : result.status === "failed"
            ? "failed"
            : "reconciliation_required";
      claimed.updatedAt = now().toISOString();
      const completed = await options.store.completeMerchantCheckout(
        claimed,
        checkoutWorkerId,
      );
      if (!completed) {
        return (
          (await options.store.getWorkflow<LiveCommerceWorkflowPayload>(
            claimed.checkoutId,
          )) ?? claimed
        );
      }
      await notifyTerminal(claimed);
      return claimed;
    })().finally(() => progressRequests.delete(checkoutId));
    progressRequests.set(checkoutId, operation);
    return operation;
  }

  return {
    health() {
      return options.provider.health();
    },

    listAddresses() {
      return options.provider.listAddresses();
    },

    addAddress(request) {
      return options.provider.addAddress(request);
    },

    async prepareOffer(request) {
      const health = await options.provider.health();
      if (!health.ready || health.missingScopes.length > 0) {
        throw new Error(
          health.message ||
            `Prava commerce is not ready (${health.missingScopes.join(", ") || "not connected"})`,
        );
      }
      cleanId(request.caseId, "Recovery case ID");
      cleanId(request.chatId, "Chat ID");
      if (!request.address.id.trim()) {
        throw new Error("Live recovery requires a confirmed Prava address");
      }
      const selection = await selectRecoveryEssential(options.provider, request.essentials);
      if (!selection) return null;
      if (!isValidHttpsProductImage(selection.offer.imageUrl)) {
        throw new Error("Selected UCP offer has no trusted HTTPS product image");
      }
      const checkoutId = randomBytes(24).toString("base64url");
      const snapshot: CheckoutWorkflowSnapshot<LiveCommerceWorkflowPayload> = {
        checkoutId,
        caseId: request.caseId,
        chatId: request.chatId,
        state: "offer_review",
        payload: {
          schemaVersion: 1,
          request: structuredClone(request),
          selection: structuredClone(selection),
          quote: null,
          paymentSession: null,
          checkoutResult: null,
          deadlineAssessment: "unverified",
          offerAuthorizationEventId: null,
          purchaseAuthorizationEventId: null,
          terminalNotified: false,
        },
        updatedAt: new Date().toISOString(),
      };
      await options.store.saveWorkflow(snapshot);
      await recordPrepared(snapshot);
      return {
        checkoutId,
        selection: structuredClone(selection),
        address: structuredClone(request.address),
      };
    },

    async createQuote({ checkoutId, authorizationEventId }) {
      const snapshot = await options.store.getWorkflow<LiveCommerceWorkflowPayload>(
        checkoutId,
      );
      if (!snapshot) throw new Error("Live recovery workflow was not found");
      if (snapshot.payload.quote) return snapshot;
      if (snapshot.state !== "offer_review") {
        throw new Error("This live offer can no longer be quoted");
      }
      snapshot.payload.offerAuthorizationEventId = cleanId(
        authorizationEventId,
        "Offer authorization event ID",
      );
      const quote = await options.provider.quote({
        offer: structuredClone(snapshot.payload.selection.offer),
        addressId: snapshot.payload.request.address.id,
        quantity: 1,
        ...(snapshot.payload.request.employeeEmail
          ? { email: snapshot.payload.request.employeeEmail }
          : {}),
        userApprovedOffer: true,
      });
      validateQuote(
        quote,
        snapshot.payload.selection,
        snapshot.payload.request.address.id,
      );
      snapshot.payload.quote = quote;
      snapshot.payload.deadlineAssessment = assessDeliveryDeadline({
        needByIso: snapshot.payload.request.needByIso,
        estimatedArrival: quote.estimatedArrival,
      });
      snapshot.state = "quote_review";
      const saved = await save(snapshot);
      await recordPrepared(saved);
      return saved;
    },

    async createApproval({ checkoutId, authorizationEventId, incident }) {
      const snapshot = await options.store.getWorkflow<LiveCommerceWorkflowPayload>(
        checkoutId,
      );
      if (!snapshot || !snapshot.payload.quote) {
        throw new Error("A live quote is required before payment approval");
      }
      if (snapshot.payload.paymentSession) {
        if (
          snapshot.state !== "approval_pending" ||
          Date.parse(snapshot.payload.paymentSession.expiresAt) <= now().getTime()
        ) {
          throw new Error("This Prava approval is no longer active");
        }
        return {
          checkoutId,
          url: new URL(`/pay/${encodeURIComponent(checkoutId)}`, publicBaseUrl).toString(),
          expiresAt: snapshot.payload.paymentSession.expiresAt,
        };
      }
      if (snapshot.state !== "quote_review") {
        throw new Error("This live quote can no longer be approved");
      }
      if (Date.parse(snapshot.payload.quote.expiresAt) <= Date.now()) {
        throw new Error("The live quote expired and must be refreshed");
      }
      snapshot.payload.purchaseAuthorizationEventId = cleanId(
        authorizationEventId,
        "Purchase authorization event ID",
      );
      if (incident) {
        snapshot.payload.request.incident = structuredClone(incident);
      }
      const paymentSession = await options.provider.createPaymentSession({
        quote: structuredClone(snapshot.payload.quote),
        idempotencyKey: `${checkoutId}:payment-session`,
        userApprovedTotal: true,
      });
      validatePaymentSession(paymentSession, snapshot.payload.quote);
      snapshot.payload.paymentSession = paymentSession;
      snapshot.state = "approval_pending";
      await save(snapshot);
      try {
        await recordPrepared(snapshot);
      } catch (error) {
        snapshot.state = "failed";
        snapshot.payload.checkoutResult = {
          status: "failed",
          message:
            "Tavra could not persist the recovery evidence required before merchant checkout.",
        };
        await save(snapshot);
        throw error;
      }
      scheduleMonitor(checkoutId);
      return {
        checkoutId,
        url: new URL(`/pay/${encodeURIComponent(checkoutId)}`, publicBaseUrl).toString(),
        expiresAt: paymentSession.expiresAt,
      };
    },

    getWorkflow(checkoutId) {
      return options.store.getWorkflow<LiveCommerceWorkflowPayload>(checkoutId);
    },

    async getStatus(checkoutId) {
      const snapshot = await progress(checkoutId);
      return snapshot ? publicStatus(snapshot) : null;
    },

    async getApprovalTarget(checkoutId) {
      const snapshot = await options.store.getWorkflow<LiveCommerceWorkflowPayload>(
        checkoutId,
      );
      if (
        !snapshot?.payload.paymentSession ||
        snapshot.state !== "approval_pending" ||
        Date.parse(snapshot.payload.paymentSession.expiresAt) <= now().getTime()
      ) {
        return null;
      }
      return snapshot.payload.paymentSession.paymentUrl;
    },

    async getProductImageSource(checkoutId, index) {
      if (index !== 0) return null;
      const snapshot = await options.store.getWorkflow<LiveCommerceWorkflowPayload>(
        checkoutId,
      );
      const value = snapshot?.payload.selection.offer.imageUrl;
      return isValidHttpsProductImage(value) ? value : null;
    },

    async revoke(checkoutId) {
      const snapshot = await options.store.getWorkflow<LiveCommerceWorkflowPayload>(
        checkoutId,
      );
      if (!snapshot) return false;
      if (
        snapshot.state === "merchant_checkout_pending" ||
        snapshot.state === "order_confirmed" ||
        snapshot.state === "reconciliation_required"
      ) {
        return false;
      }
      snapshot.state = "canceled";
      stopMonitor(checkoutId);
      await save(snapshot);
      await notifyTerminal(snapshot);
      return true;
    },

    async resume() {
      const interrupted = await options.store.listWorkflows<LiveCommerceWorkflowPayload>([
        "merchant_checkout_pending",
      ]);
      for (const snapshot of interrupted) {
        const current = await reconcileCheckoutIfAbandoned(snapshot);
        if (current.state === "merchant_checkout_pending") {
          scheduleMonitor(current.checkoutId);
        }
      }
      const active = await options.store.listWorkflows<LiveCommerceWorkflowPayload>([
        "approval_pending",
      ]);
      for (const snapshot of active) scheduleMonitor(snapshot.checkoutId);
      for (const pending of await options.store.pendingNotifications()) {
        const snapshot = await options.store.getWorkflow<LiveCommerceWorkflowPayload>(
          pending.checkoutId,
        );
        if (snapshot) await notifyTerminal(snapshot);
      }
    },
  };
}

export function quoteDisplayAmount(quote: CommerceQuote): string {
  return `${quote.total.currency} ${normalizeCommerceAmount(quote.total.amount)}`;
}
