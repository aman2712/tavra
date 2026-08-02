import { randomBytes } from "node:crypto";

export interface PravaProduct {
  /** Stable catalog/SKU reference used across media, checkout, and evidence. */
  productRef?: string;
  description: string;
  unitPrice: string;
  quantity: number;
}

export interface RecoveryCheckoutContext {
  caseId: string;
  needBy: string;
  deliveryArea: string;
  deliveryAddress: string;
  deliveryAddressSource: "message" | "linq_location";
  airline: string;
  arrivalAirport: string;
  baggageReference: string | null;
  noticeAttachmentIds: string[];
}

export interface MerchantPaymentCredential {
  token: string;
  dynamicCvv: string;
  expiryMonth: string;
  expiryYear: string;
}

export interface MerchantCheckoutResult {
  status: "approved" | "declined";
  orderId: string | null;
  authorizationCode: string | null;
  responseCode: string;
  simulated: boolean;
}

export interface MerchantCheckoutAdapter {
  mode: "sandbox_simulator" | "live";
  checkout(request: {
    idempotencyKey: string;
    amount: string;
    currency: string;
    products: PravaProduct[];
    recovery: RecoveryCheckoutContext | null;
    credential: MerchantPaymentCredential;
  }): Promise<MerchantCheckoutResult>;
}

export function createSandboxMerchantCheckoutAdapter(): MerchantCheckoutAdapter {
  const attempts = new Map<string, MerchantCheckoutResult>();
  return {
    mode: "sandbox_simulator",
    async checkout(request) {
      const existing = attempts.get(request.idempotencyKey);
      if (existing) return structuredClone(existing);
      const credentialValid =
        /^\d{16,19}$/.test(request.credential.token) &&
        /^\d{3,4}$/.test(request.credential.dynamicCvv) &&
        /^\d{1,2}$/.test(request.credential.expiryMonth) &&
        /^\d{2,4}$/.test(request.credential.expiryYear);
      const result: MerchantCheckoutResult = credentialValid
        ? {
            status: "approved",
            orderId: `SIM-${randomBytes(4).toString("hex").toUpperCase()}`,
            authorizationCode: `SIMAUTH${randomBytes(4).toString("hex").toUpperCase()}`,
            responseCode: "00",
            simulated: true,
          }
        : {
            status: "declined",
            orderId: null,
            authorizationCode: null,
            responseCode: "14",
            simulated: true,
          };
      attempts.set(request.idempotencyKey, result);
      return structuredClone(result);
    },
  };
}

export interface CreatePravaCheckoutRequest {
  employeeId: string;
  employeeEmail: string;
  employeePhone: string;
  chatId: string;
  totalAmount: string;
  currency: string;
  description: string;
  products: PravaProduct[];
  recovery?: RecoveryCheckoutContext;
}

export interface PravaCheckoutLink {
  checkoutId: string;
  url: string;
  expiresAt: string;
}

export interface PravaCheckoutProvider {
  createCheckout(request: CreatePravaCheckoutRequest): Promise<PravaCheckoutLink>;
}

export type PravaPublicStatus =
  | { status: "pending" | "awaiting_result" }
  | {
      status: "completed";
      merchantOrderId: string;
      merchantOutcome: "simulated" | "live";
    }
  | { status: "reconciliation_required"; message: string }
  | { status: "failed"; message: string };

type PravaTerminalStatus =
  | {
      status: "completed";
      merchantOrderId: string;
      merchantOutcome: "simulated" | "live";
    }
  | { status: "reconciliation_required"; message: string }
  | { status: "failed"; message: string };

export interface PravaClientSession {
  checkoutMode: "embedded" | "hosted";
  publishableKey: string;
  sessionToken: string;
  iframeUrl: string;
  expiresAt: string;
  order: {
    description: string;
    totalAmount: string;
    currency: string;
    products: PravaProduct[];
  };
}

export interface PravaStatusEvent {
  chatId: string;
  checkoutId: string;
  status: "completed" | "failed" | "reconciliation_required";
  pravaOrderId: string;
  merchantOrderId: string | null;
  totalAmount: string;
  currency: string;
  employeeId: string;
  employeePhone: string;
  products: PravaProduct[];
  recovery: RecoveryCheckoutContext | null;
  merchantOutcome: "simulated" | "live" | "not_attempted";
}

interface PravaSessionResponse {
  session_id: string;
  session_token: string;
  iframe_url: string;
  order_id: string;
  expires_at: string;
}

interface PravaPaymentResult {
  session_id?: string;
  order_id?: string | null;
  status?: string;
  transactions?: Array<{
    error?: { message?: string };
    line_items?: Array<{
      txn_ref_id?: string;
      token?: string | null;
      dynamic_cvv?: string | null;
      expiry_month?: string | null;
      expiry_year?: string | null;
      products?: Array<{
        product_ref_id?: string;
        unit_price?: string;
      }>;
    }>;
  }>;
}

interface PravaReportStatusResponse {
  status?: string;
  visa_confirmation?: string;
}

interface PravaCardListResponse {
  cards?: Array<{
    card_id?: string;
    is_default?: boolean;
    status?: string;
  }>;
}

interface CheckoutRecord {
  checkoutId: string;
  session: PravaSessionResponse;
  request: CreatePravaCheckoutRequest;
  notifiedStatus: "completed" | "failed" | "reconciliation_required" | null;
  monitorUntil: number;
  monitorTimer: ReturnType<typeof setTimeout> | null;
  lastObservedState: string | null;
  terminalStatus: PravaTerminalStatus | null;
  merchantAttempt: {
    transactionReferenceId: string;
    result: MerchantCheckoutResult;
  } | null;
  cancelState: "active" | "cancel_pending" | "canceled";
  pendingNotification: PravaStatusEvent | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Prava returned an invalid response");
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Prava response omitted ${key}`);
  }
  return value.trim();
}

function parseSession(value: unknown): PravaSessionResponse {
  const record = asRecord(value);
  const iframeUrl = new URL(requiredString(record, "iframe_url"));
  if (iframeUrl.protocol !== "https:" || !/(^|\.)prava\.space$/i.test(iframeUrl.hostname)) {
    throw new Error("Prava returned an untrusted iframe URL");
  }
  const expiresAt = requiredString(record, "expires_at");
  if (!Number.isFinite(Date.parse(expiresAt))) {
    throw new Error("Prava returned an invalid session expiry");
  }
  return {
    session_id: requiredString(record, "session_id"),
    session_token: requiredString(record, "session_token"),
    iframe_url: iframeUrl.toString(),
    order_id: requiredString(record, "order_id"),
    expires_at: expiresAt,
  };
}

function parseAmount(value: string): string {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value) || Number(value) <= 0) {
    throw new Error("Prava checkout amount must use a positive decimal string");
  }
  const [whole = "0", fraction = ""] = value.split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (cents <= 0n || cents > 10_000_000n) {
    throw new Error("Prava checkout amount must be between $0.01 and $100,000.00");
  }
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

function amountCents(value: string): bigint {
  const normalized = parseAmount(value);
  const [whole = "0", fraction = "00"] = normalized.split(".");
  return BigInt(whole) * 100n + BigInt(fraction);
}

function validateMerchantResult(
  adapter: MerchantCheckoutAdapter,
  result: MerchantCheckoutResult,
): MerchantCheckoutResult {
  if (result.status !== "approved" && result.status !== "declined") {
    throw new Error("Merchant checkout returned an invalid status");
  }
  if (!/^\S+$/.test(result.responseCode)) {
    throw new Error("Merchant checkout omitted its response code");
  }
  const expectedSimulated = adapter.mode === "sandbox_simulator";
  if (result.simulated !== expectedSimulated) {
    throw new Error("Merchant checkout result does not match the configured adapter mode");
  }
  if (
    result.status === "approved" &&
    (!result.orderId?.trim() || !result.authorizationCode?.trim())
  ) {
    throw new Error("Approved merchant checkout omitted its order or authorization reference");
  }
  return {
    ...result,
    orderId: result.orderId?.trim() || null,
    authorizationCode: result.authorizationCode?.trim() || null,
    responseCode: result.responseCode.trim(),
  };
}

function reportAcknowledged(payload: PravaReportStatusResponse | null): boolean {
  const status = payload?.status?.trim().toLowerCase();
  const confirmation = payload?.visa_confirmation?.trim().toLowerCase();
  if (status) return status === "confirmed" || status === "completed";
  return confirmation === "success" || confirmation === "confirmed";
}

function errorMessage(value: unknown, fallback: string): string {
  if (!value || typeof value !== "object") return fallback;
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== "object") return fallback;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.trim() ? message.trim() : fallback;
}

export interface PravaCheckoutService extends PravaCheckoutProvider {
  getClientSession(checkoutId: string): PravaClientSession | null;
  getStatus(checkoutId: string): Promise<PravaPublicStatus | null>;
  revoke(checkoutId: string): Promise<boolean>;
}

export function createPravaCheckoutService(options: {
  backendUrl: string;
  publishableKey: string;
  secretKey: string;
  publicBaseUrl: string;
  fetch?: typeof fetch;
  onStatus?: (event: PravaStatusEvent) => Promise<void>;
  statusMonitorIntervalMs?: number;
  statusMonitorWindowMs?: number;
  checkoutMode?: "embedded" | "hosted";
  preselectSavedCard?: boolean;
  mode?: "sandbox" | "live";
  merchantCheckout?: MerchantCheckoutAdapter;
}): PravaCheckoutService {
  const backendUrl = new URL(options.backendUrl);
  const publicBaseUrl = new URL(options.publicBaseUrl);
  const fetchImpl = options.fetch ?? fetch;
  const checkouts = new Map<string, CheckoutRecord>();
  const statusRequests = new Map<string, Promise<PravaPublicStatus | null>>();
  const statusMonitorIntervalMs = Math.max(1, options.statusMonitorIntervalMs ?? 3_000);
  const statusMonitorWindowMs = Math.max(
    statusMonitorIntervalMs,
    options.statusMonitorWindowMs ?? 90_000,
  );
  const checkoutMode = options.checkoutMode ?? "embedded";
  const mode = options.mode ?? "sandbox";
  const merchantCheckout =
    options.merchantCheckout ?? createSandboxMerchantCheckoutAdapter();
  if (
    (mode === "live" && merchantCheckout.mode !== "live") ||
    (mode === "sandbox" && merchantCheckout.mode !== "sandbox_simulator")
  ) {
    throw new Error(
      `PRAVA_MODE=${mode} does not match merchant adapter mode ${merchantCheckout.mode}`,
    );
  }

  async function defaultSavedCardId(customerId: string): Promise<string | null> {
    if (!options.preselectSavedCard) return null;
    const query = new URLSearchParams({
      customer_id: customerId,
      status: "active",
      include_card_art: "false",
    });
    const response = await fetchImpl(
      new URL(`v1/listCards?${query.toString()}`, backendUrl),
      {
        headers: { Authorization: `Bearer ${options.secretKey}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (response.status === 404) return null;
    const payload = (await response.json().catch(() => null)) as
      | PravaCardListResponse
      | null;
    if (!response.ok) {
      const code =
        payload && typeof payload === "object" && "error" in payload
          ? JSON.stringify(payload)
          : "";
      if (/CUSTOMER_NOT_FOUND/i.test(code)) return null;
      throw new Error(
        errorMessage(payload, `Prava card lookup failed with HTTP ${response.status}`),
      );
    }
    const active = (payload?.cards ?? []).filter(
      (card) => card.status?.toLowerCase() === "active" && card.card_id,
    );
    return active.find((card) => card.is_default)?.card_id ?? null;
  }

  function activeRecord(checkoutId: string): CheckoutRecord | null {
    const record = checkouts.get(checkoutId) ?? null;
    if (!record) return null;
    if (Date.parse(record.session.expires_at) <= Date.now()) {
      return null;
    }
    return record;
  }

  function notificationEvent(record: CheckoutRecord): PravaStatusEvent {
    if (!record.terminalStatus) {
      throw new Error("Cannot notify before checkout reaches a terminal state");
    }
    if (record.pendingNotification) return record.pendingNotification;
    const merchantOutcome = record.merchantAttempt
      ? record.merchantAttempt.result.simulated
        ? "simulated"
        : "live"
      : "not_attempted";
    record.pendingNotification = {
      chatId: record.request.chatId,
      checkoutId: record.checkoutId,
      status: record.terminalStatus.status,
      pravaOrderId: record.session.order_id,
      merchantOrderId: record.merchantAttempt?.result.orderId ?? null,
      totalAmount: record.request.totalAmount,
      currency: record.request.currency,
      employeeId: record.request.employeeId,
      employeePhone: record.request.employeePhone,
      products: structuredClone(record.request.products),
      recovery: record.request.recovery
        ? structuredClone(record.request.recovery)
        : null,
      merchantOutcome,
    };
    return record.pendingNotification;
  }

  async function notify(record: CheckoutRecord): Promise<void> {
    if (!record.terminalStatus) return;
    const event = notificationEvent(record);
    if (!options.onStatus || record.notifiedStatus === event.status) return;
    try {
      await options.onStatus(structuredClone(event));
      record.notifiedStatus = event.status;
    } catch (error) {
      console.error(
        JSON.stringify({
          scope: "prava_status_notification",
          status: "retrying",
          checkoutRef: record.checkoutId.slice(0, 8),
          error: error instanceof Error ? error.message : "Unknown delivery error",
        }),
      );
    }
  }

  function stopStatusMonitor(record: CheckoutRecord): void {
    if (record.monitorTimer) clearTimeout(record.monitorTimer);
    record.monitorTimer = null;
    record.monitorUntil = 0;
  }

  async function checkStatus(checkoutId: string): Promise<PravaPublicStatus | null> {
    const active = statusRequests.get(checkoutId);
    if (active) return active;
    const request = (async (): Promise<PravaPublicStatus | null> => {
      const record = checkouts.get(checkoutId) ?? null;
      if (!record) return null;
      if (
        !record.terminalStatus &&
        Date.parse(record.session.expires_at) <= Date.now()
      ) {
        record.terminalStatus = {
          status: "failed",
          message: "This secure approval expired. Nothing was ordered.",
        };
      }
      if (record.terminalStatus) {
        await notify(record);
        if (
          !options.onStatus ||
          record.notifiedStatus === record.terminalStatus.status
        ) {
          stopStatusMonitor(record);
        }
        return record.terminalStatus;
      }
      if (record.cancelState !== "active") {
        return { status: "pending" };
      }
      const response = await fetchImpl(
        new URL(
          `v1/sessions/${encodeURIComponent(record.session.session_id)}/payment-result?_t=${Date.now()}`,
          backendUrl,
        ),
        {
          headers: { Authorization: `Bearer ${options.secretKey}` },
          signal: AbortSignal.timeout(15_000),
        },
      );
      const payload = (await response.json().catch(() => null)) as
        | PravaPaymentResult
        | null;
      if (!response.ok) {
        if (response.status === 404) {
          record.terminalStatus = {
            status: "failed",
            message: "This secure approval no longer exists. Nothing was ordered.",
          };
          await notify(record);
          return record.terminalStatus;
        }
        throw new Error(
          errorMessage(
            payload,
            `Prava payment status failed with HTTP ${response.status}`,
          ),
        );
      }
      if (!payload) {
        throw new Error("Prava payment status returned an invalid response");
      }
      if (
        (payload.session_id && payload.session_id !== record.session.session_id) ||
        (payload.order_id && payload.order_id !== record.session.order_id)
      ) {
        record.terminalStatus = {
          status: "reconciliation_required",
          message:
            "Prava returned a result for a different session reference. Nothing further was attempted; support must reconcile this approval.",
        };
        await notify(record);
        return record.terminalStatus;
      }
      const status = payload.status?.trim().toLowerCase();
      const transactions = payload.transactions ?? [];
      const lineItems = transactions.flatMap((transaction) => transaction.line_items ?? []);
      const credentialLineItems = lineItems.filter(
        (lineItem) =>
          Boolean(lineItem.txn_ref_id) &&
          Boolean(lineItem.token) &&
          Boolean(lineItem.dynamic_cvv) &&
          Boolean(lineItem.expiry_month) &&
          Boolean(lineItem.expiry_year),
      );
      const credentialLineItem = credentialLineItems[0];
      const credentialReady = credentialLineItems.length === 1;
      const observedState = [
        status ?? "unknown",
        transactions.length,
        lineItems.length,
        credentialLineItems.length,
      ].join(":");
      if (record.lastObservedState !== observedState) {
        record.lastObservedState = observedState;
        console.info(
          JSON.stringify({
            scope: "prava_payment_status",
            checkoutRef: record.checkoutId.slice(0, 8),
            status: status ?? "unknown",
            transactions: transactions.length,
            lineItems: lineItems.length,
            credentialReady,
          }),
        );
      }
      if (credentialLineItems.length > 1) {
        record.terminalStatus = {
          status: "reconciliation_required",
          message:
            "Prava returned multiple payment credentials for this single-merchant checkout. Tavra did not choose one; support must reconcile the session.",
        };
        await notify(record);
        return record.terminalStatus;
      }
      if (record.cancelState !== "active") {
        return { status: "pending" };
      }
      // Prava exposes the one-time credential while the session is awaiting_result.
      // The session becomes completed only after the merchant outcome is reported.
      if (status === "awaiting_result" && credentialLineItem) {
        const transactionReferenceId = credentialLineItem.txn_ref_id as string;
        if (
          record.merchantAttempt &&
          record.merchantAttempt.transactionReferenceId !== transactionReferenceId
        ) {
          record.terminalStatus = {
            status: "reconciliation_required",
            message:
              "Prava changed the transaction reference after a merchant attempt. Tavra stopped and requires reconciliation.",
          };
          await notify(record);
          return record.terminalStatus;
        }
        const merchantAttempt = record.merchantAttempt ?? {
          transactionReferenceId,
          result: validateMerchantResult(
            merchantCheckout,
            await merchantCheckout.checkout({
              idempotencyKey: `${record.checkoutId}:${transactionReferenceId}`,
              amount: record.request.totalAmount,
              currency: record.request.currency,
              products: structuredClone(record.request.products),
              recovery: record.request.recovery
                ? structuredClone(record.request.recovery)
                : null,
              credential: {
                token: credentialLineItem.token as string,
                dynamicCvv: credentialLineItem.dynamic_cvv as string,
                expiryMonth: credentialLineItem.expiry_month as string,
                expiryYear: credentialLineItem.expiry_year as string,
              },
            }),
          ),
        };
        record.merchantAttempt = merchantAttempt;
        const merchantApproved = merchantAttempt.result.status === "approved";
        const productStatuses = (credentialLineItem.products ?? [])
          .filter(
            (product) =>
              typeof product.product_ref_id === "string" &&
              product.product_ref_id.length > 0,
          )
          .map((product) => ({
            product_ref_id: product.product_ref_id,
            status: merchantApproved ? "COMPLETED" : "FAILED",
            amount_paid: merchantApproved ? product.unit_price : "0.00",
          }));
        const reportResponse = await fetchImpl(
          new URL(
            `v1/sessions/${encodeURIComponent(record.session.session_id)}/report-status`,
            backendUrl,
          ),
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${options.secretKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              txn_ref_id: transactionReferenceId,
              txn_status: merchantApproved ? "APPROVED" : "DECLINED",
              txn_type: "PURCHASE",
              ...(merchantApproved && merchantAttempt.result.authorizationCode
                ? {
                    authorization_code: merchantAttempt.result.authorizationCode,
                    response_code: merchantAttempt.result.responseCode,
                  }
                : { response_code: merchantAttempt.result.responseCode }),
              amount_paid: merchantApproved ? record.request.totalAmount : "0.00",
              ...(productStatuses.length > 0
                ? { product_statuses: productStatuses }
                : {}),
            }),
            signal: AbortSignal.timeout(15_000),
          },
        );
        const reportPayload = (await reportResponse.json().catch(() => null)) as
          | PravaReportStatusResponse
          | null;
        if (!reportResponse.ok) {
          throw new Error(
            errorMessage(
              reportPayload,
              `Prava outcome reporting failed with HTTP ${reportResponse.status}`,
            ),
          );
        }
        if (!reportAcknowledged(reportPayload)) {
          throw new Error(
            "Prava did not acknowledge the reported merchant outcome; reconciliation is still pending",
          );
        }
        console.info(
          JSON.stringify({
            scope: "prava_checkout_report",
            checkoutRef: record.checkoutId.slice(0, 8),
            outcome: merchantApproved ? "APPROVED" : "DECLINED",
            merchantMode: merchantAttempt.result.simulated ? "simulated" : "live",
            confirmation: reportPayload?.visa_confirmation ?? "received",
            merchantOrderId: merchantAttempt.result.orderId,
          }),
        );
        if (!merchantApproved) {
          record.terminalStatus = {
            status: "failed",
            message: "The merchant checkout did not complete. Nothing was ordered.",
          };
          await notify(record);
          if (!options.onStatus || record.notifiedStatus === "failed") {
            stopStatusMonitor(record);
          }
          return record.terminalStatus;
        }
        record.terminalStatus = {
          status: "completed",
          merchantOrderId: merchantAttempt.result.orderId as string,
          merchantOutcome: merchantAttempt.result.simulated ? "simulated" : "live",
        };
        await notify(record);
        if (!options.onStatus || record.notifiedStatus === "completed") {
          stopStatusMonitor(record);
        }
        return record.terminalStatus;
      }
      if (status === "completed") {
        if (!record.merchantAttempt) {
          record.terminalStatus = {
            status: "reconciliation_required",
            message:
              "Prava completed the approval, but Tavra has no verified merchant outcome for this process. No order is being claimed; support must reconcile the session.",
          };
        } else if (record.merchantAttempt.result.status === "approved") {
          record.terminalStatus = {
            status: "completed",
            merchantOrderId: record.merchantAttempt.result.orderId as string,
            merchantOutcome: record.merchantAttempt.result.simulated
              ? "simulated"
              : "live",
          };
        } else {
          record.terminalStatus = {
            status: "failed",
            message: "The merchant declined the checkout. Nothing was ordered.",
          };
        }
        await notify(record);
        if (
          !options.onStatus ||
          record.notifiedStatus === record.terminalStatus.status
        ) {
          stopStatusMonitor(record);
        }
        return record.terminalStatus;
      }
      if (status === "failed") {
        record.terminalStatus =
          record.merchantAttempt?.result.status === "approved"
            ? {
                status: "reconciliation_required",
                message:
                  "The merchant approved the checkout but Prava reported a failed session. Tavra stopped and support must reconcile the outcome.",
              }
            : {
                status: "failed",
                message: "Secure approval failed. Nothing was ordered.",
              };
        await notify(record);
        if (
          !options.onStatus ||
          record.notifiedStatus === record.terminalStatus.status
        ) {
          stopStatusMonitor(record);
        }
        return record.terminalStatus;
      }
      return { status: status === "awaiting_result" ? "awaiting_result" : "pending" };
    })().finally(() => statusRequests.delete(checkoutId));
    statusRequests.set(checkoutId, request);
    return request;
  }

  function scheduleStatusMonitor(record: CheckoutRecord, extendWindow: boolean): void {
    if (extendWindow) {
      record.monitorUntil = Math.max(
        record.monitorUntil,
        Date.now() + statusMonitorWindowMs,
        Date.parse(record.session.expires_at) + 30_000,
      );
    }
    if (record.monitorTimer || Date.now() >= record.monitorUntil) return;
    record.monitorTimer = setTimeout(() => {
      record.monitorTimer = null;
      void (async () => {
        let status: PravaPublicStatus | null = null;
        try {
          status = await checkStatus(record.checkoutId);
        } catch (error) {
          console.warn(
            JSON.stringify({
              scope: "prava_status_monitor",
              status: "retrying",
              checkoutId: record.checkoutId,
              error: error instanceof Error ? error.message : "Unknown polling error",
            }),
          );
        }
        const notificationDelivered =
          status?.status === "completed" ||
          status?.status === "failed" ||
          status?.status === "reconciliation_required"
            ? !options.onStatus || record.notifiedStatus === status.status
            : false;
        if (!notificationDelivered && checkouts.has(record.checkoutId)) {
          scheduleStatusMonitor(record, false);
        }
      })();
    }, statusMonitorIntervalMs);
    record.monitorTimer.unref?.();
  }

  return {
    async createCheckout(request) {
      request = structuredClone(request);
      const totalAmount = parseAmount(request.totalAmount);
      if (!/^[A-Z]{3}$/.test(request.currency)) {
        throw new Error("Prava checkout currency must be an ISO 4217 code");
      }
      if (!/^\S+@\S+\.\S+$/.test(request.employeeEmail)) {
        throw new Error("Prava checkout requires a valid employee email");
      }
      if (request.products.length === 0) {
        throw new Error("Prava checkout requires at least one product");
      }
      if (!request.products.every((product) => Number.isInteger(product.quantity) && product.quantity > 0)) {
        throw new Error("Prava product quantities must be positive integers");
      }
      if (
        !request.products.every(
          (product) =>
            product.productRef === undefined ||
            /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(product.productRef),
        )
      ) {
        throw new Error("Prava product references must be stable catalog identifiers");
      }
      const productTotal = request.products.reduce(
        (sum, product) => sum + amountCents(product.unitPrice) * BigInt(product.quantity),
        0n,
      );
      if (productTotal !== amountCents(totalAmount)) {
        throw new Error("Prava product total must match checkout total");
      }
      const checkoutId = randomBytes(24).toString("base64url");
      const savedCardId = await defaultSavedCardId(request.employeeId);
      const response = await fetchImpl(new URL("v1/sessions", backendUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.secretKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: request.employeeId,
          user_email: request.employeeEmail,
          user_phone: request.employeePhone,
          total_amount: totalAmount,
          currency: request.currency,
          external_order_ref: `tavra_${checkoutId}`,
          integration_type:
            checkoutMode === "hosted" ? "full_checkout" : "embedding",
          ...(savedCardId ? { card: { card_id: savedCardId } } : {}),
          ...(checkoutMode === "hosted"
            ? {
                callback_url: new URL(
                  `/pay/${checkoutId}?prava_return=1`,
                  publicBaseUrl,
                ).toString(),
              }
            : {}),
          description: request.description,
          purchase_context: [
            {
              merchant_details: {
                name: mode === "sandbox" ? "Tavra Recovery Sandbox" : "Tavra Recovery",
                url: new URL("/", publicBaseUrl).toString(),
                country_code_iso2: "US",
                category_code: "5311",
                category: "Department Stores",
              },
              product_details: request.products.map((product, index) => ({
                product_id: product.productRef ?? `tavra_item_${index + 1}`,
                description: product.description,
                unit_price: parseAmount(product.unitPrice),
                quantity: product.quantity,
              })),
              effective_until_minutes: 15,
            },
          ],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          errorMessage(payload, `Prava session creation failed with HTTP ${response.status}`),
        );
      }
      const session = parseSession(payload);
      checkouts.set(checkoutId, {
        checkoutId,
        session,
        request: { ...request, totalAmount },
        notifiedStatus: null,
        monitorUntil: 0,
        monitorTimer: null,
        lastObservedState: null,
        terminalStatus: null,
        merchantAttempt: null,
        cancelState: "active",
        pendingNotification: null,
      });
      return {
        checkoutId,
        url: new URL(`/pay/${checkoutId}`, publicBaseUrl).toString(),
        expiresAt: session.expires_at,
      };
    },

    getClientSession(checkoutId) {
      const record = activeRecord(checkoutId);
      if (!record || record.cancelState !== "active") return null;
      scheduleStatusMonitor(record, true);
      return {
        checkoutMode,
        publishableKey: options.publishableKey,
        sessionToken: record.session.session_token,
        iframeUrl: record.session.iframe_url,
        expiresAt: record.session.expires_at,
        order: {
          description: record.request.description,
          totalAmount: record.request.totalAmount,
          currency: record.request.currency,
          products: structuredClone(record.request.products),
        },
      };
    },

    async getStatus(checkoutId) {
      const record = activeRecord(checkoutId);
      if (record) scheduleStatusMonitor(record, true);
      return checkStatus(checkoutId);
    },

    async revoke(checkoutId) {
      const record = checkouts.get(checkoutId);
      if (
        !record ||
        record.cancelState !== "active" ||
        record.terminalStatus ||
        record.merchantAttempt
      ) {
        return false;
      }
      record.cancelState = "cancel_pending";
      const inFlight = statusRequests.get(checkoutId);
      if (inFlight) await inFlight.catch(() => null);
      if (record.merchantAttempt || record.terminalStatus) {
        record.cancelState = "active";
        return false;
      }
      try {
        const response = await fetchImpl(
          new URL(`v1/sessions/${encodeURIComponent(record.session.session_id)}/revoke`, backendUrl),
          {
            method: "POST",
            headers: { Authorization: `Bearer ${options.secretKey}` },
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (!response.ok) {
          record.cancelState = "active";
          scheduleStatusMonitor(record, true);
          return false;
        }
        record.cancelState = "canceled";
        record.terminalStatus = {
          status: "failed",
          message: "This secure approval was canceled. Nothing was ordered.",
        };
        stopStatusMonitor(record);
        await notify(record);
        return true;
      } catch (error) {
        record.cancelState = "active";
        scheduleStatusMonitor(record, true);
        throw error;
      }
    },
  };
}
