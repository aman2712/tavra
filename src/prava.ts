import { randomBytes } from "node:crypto";

export interface PravaProduct {
  /** Stable catalog/SKU reference used across media, checkout, and evidence. */
  productRef?: string;
  description: string;
  unitPrice: string;
  quantity: number;
  /** HTTPS image supplied by the discovered merchant catalog. */
  imageUrl?: string;
  merchantName?: string;
  merchantUrl?: string;
  /** Exact merchant-owned variant/SKU identifier used by the checkout executor. */
  merchantVariantId?: string;
  /** HTTPS end-merchant checkout/cart continuation URL. */
  checkoutUrl?: string;
}

export interface RecoveryCheckoutContext {
  caseId: string;
  passengerName?: string | null;
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

export interface MerchantMetadata {
  name: string;
  url: string;
  countryCodeIso2: string;
  categoryCode: string;
  category: string;
}

/** Sanitized proof of the end-merchant submission. Payment credentials are forbidden here. */
export interface MerchantAttemptEvidence {
  merchantName: string;
  merchantUrl: string;
  attemptedAt: string;
  responseText: string;
  responseCode: string;
  reference: string | null;
}

export interface MerchantCheckoutResult {
  status: "approved" | "declined";
  orderId: string | null;
  authorizationCode: string | null;
  responseCode: string;
  simulated: boolean;
  expectedSandboxDecline: boolean;
  evidence: MerchantAttemptEvidence;
}

export interface MerchantCheckoutAdapter {
  mode: "sandbox_simulator" | "sandbox_merchant" | "live";
  merchant: MerchantMetadata;
  checkout(request: {
    idempotencyKey: string;
    amount: string;
    currency: string;
    products: PravaProduct[];
    recovery: RecoveryCheckoutContext | null;
    buyer: {
      email: string;
      phone: string;
      firstName?: string;
      lastName?: string;
    };
    credential: MerchantPaymentCredential;
  }): Promise<MerchantCheckoutResult>;
}

export function createSandboxMerchantCheckoutAdapter(): MerchantCheckoutAdapter {
  const attempts = new Map<string, MerchantCheckoutResult>();
  const merchant: MerchantMetadata = {
    name: "Tavra Sandbox Merchant Simulator",
    url: "https://merchant-simulator.example.com/",
    countryCodeIso2: "US",
    categoryCode: "5311",
    category: "Department Stores",
  };
  return {
    mode: "sandbox_simulator",
    merchant,
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
            expectedSandboxDecline: false,
            evidence: {
              merchantName: merchant.name,
              merchantUrl: merchant.url,
              attemptedAt: new Date().toISOString(),
              responseText: "Sandbox merchant simulator approved the checkout",
              responseCode: "00",
              reference: null,
            },
          }
        : {
            status: "declined",
            orderId: null,
            authorizationCode: null,
            responseCode: "14",
            simulated: true,
            expectedSandboxDecline: false,
            evidence: {
              merchantName: merchant.name,
              merchantUrl: merchant.url,
              attemptedAt: new Date().toISOString(),
              responseText: "Sandbox merchant simulator rejected an invalid credential",
              responseCode: "14",
              reference: null,
            },
          };
      attempts.set(request.idempotencyKey, result);
      return structuredClone(result);
    },
  };
}

export interface CreatePravaCheckoutRequest {
  employeeId: string;
  employeeName?: string;
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
      merchantOutcome: "simulated" | "sandbox_merchant" | "live";
    }
  | {
      status: "sandbox_validated";
      merchantAttempt: MerchantAttemptEvidence;
    }
  | { status: "reconciliation_required"; code?: string; message: string }
  | { status: "failed"; code?: string; message: string };

type PravaTerminalStatus =
  | {
      status: "completed";
      merchantOrderId: string;
      merchantOutcome: "simulated" | "sandbox_merchant" | "live";
    }
  | {
      status: "sandbox_validated";
      merchantAttempt: MerchantAttemptEvidence;
    }
  | { status: "reconciliation_required"; code?: string; message: string }
  | { status: "failed"; code?: string; message: string };

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
  status: "completed" | "sandbox_validated" | "failed" | "reconciliation_required";
  pravaOrderId: string;
  merchantOrderId: string | null;
  totalAmount: string;
  currency: string;
  employeeId: string;
  employeePhone: string;
  products: PravaProduct[];
  recovery: RecoveryCheckoutContext | null;
  merchantOutcome: "simulated" | "sandbox_merchant" | "live" | "not_attempted";
  /** Present for newly processed events; optional only for legacy persisted event fixtures. */
  merchantAttempt?: MerchantAttemptEvidence | null;
  /** Sanitized Prava failure detail for failed or reconciliation events. */
  failureCode?: string | null;
  failureMessage?: string | null;
}

/**
 * Throw after a merchant submission when its final outcome cannot be determined.
 * Tavra will stop retries and require reconciliation.
 */
export class MerchantCheckoutUncertainError extends Error {
  constructor(message = "The merchant outcome is uncertain") {
    super(message);
    this.name = "MerchantCheckoutUncertainError";
  }
}

/** Throw only when the adapter proves no end-merchant submission occurred. */
export class MerchantCheckoutPreSubmitError extends Error {
  constructor(message = "The merchant checkout could not be prepared") {
    super(message);
    this.name = "MerchantCheckoutPreSubmitError";
  }
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
  error?: { code?: string | number; message?: string };
  transactions?: Array<{
    error?: { code?: string | number; message?: string };
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
  notifiedStatus:
    | "completed"
    | "sandbox_validated"
    | "failed"
    | "reconciliation_required"
    | null;
  monitorUntil: number;
  monitorTimer: ReturnType<typeof setTimeout> | null;
  lastPaymentStatusPollAt: number;
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

const RESERVED_TLDS = new Set([
  "local",
  "test",
  "example",
  "demo",
  "invalid",
  "localhost",
  "internal",
  "devices",
]);

const RECOGNIZED_GENERIC_TLDS = new Set([
  "aero",
  "ai",
  "app",
  "biz",
  "cloud",
  "co",
  "com",
  "company",
  "dev",
  "edu",
  "gov",
  "info",
  "io",
  "me",
  "museum",
  "name",
  "net",
  "online",
  "org",
  "pro",
  "shop",
  "solutions",
  "space",
  "store",
  "tech",
  "travel",
  "xyz",
]);

const RECOGNIZED_COUNTRY_TLDS = new Set(
  "ac ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bl bm bn bo bq br bs bt bv bw by bz ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg er es et eu fi fj fk fm fo fr ga gb gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mf mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sj sk sl sm sn so sr ss st sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug uk us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw".split(" "),
);

export function isPlausiblePublicHostname(value: string): boolean {
  const hostname = value.trim().toLowerCase().replace(/\.$/, "");
  const labels = hostname.split(".");
  if (
    labels.length < 2 ||
    labels.some(
      (label) =>
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
    )
  ) {
    return false;
  }
  const tld = labels.at(-1) as string;
  if (RESERVED_TLDS.has(tld)) return false;
  return RECOGNIZED_COUNTRY_TLDS.has(tld) || RECOGNIZED_GENERIC_TLDS.has(tld);
}

function isValidEmployeeEmail(value: string): boolean {
  const match = /^([^\s@]{1,64})@([^\s@]{1,253})$/.exec(value.trim());
  if (!match) return false;
  const local = match[1] as string;
  const domain = match[2] as string;
  return (
    !local.startsWith(".") &&
    !local.endsWith(".") &&
    !local.includes("..") &&
    isPlausiblePublicHostname(domain)
  );
}

function buyerName(value: string | undefined): { firstName?: string; lastName?: string } {
  const normalized = value?.trim().replace(/\s+/g, " ");
  if (!normalized) return {};
  const [firstName, ...remaining] = normalized.split(" ");
  return {
    ...(firstName ? { firstName } : {}),
    ...(remaining.length > 0 ? { lastName: remaining.join(" ") } : {}),
  };
}

function validateMerchantMetadata(merchant: MerchantMetadata): MerchantMetadata {
  const merchantUrl = new URL(merchant.url);
  if (
    merchantUrl.protocol !== "https:" ||
    merchantUrl.username ||
    merchantUrl.password ||
    merchantUrl.port ||
    merchantUrl.pathname !== "/" ||
    merchantUrl.search ||
    merchantUrl.hash
  ) {
    throw new Error("Merchant checkout URL must be a bare HTTPS origin");
  }
  if (!isPlausiblePublicHostname(merchantUrl.hostname)) {
    throw new Error("Merchant checkout URL must use a recognized public domain");
  }
  const name = merchant.name.trim();
  const countryCodeIso2 = merchant.countryCodeIso2.trim().toUpperCase();
  const categoryCode = merchant.categoryCode.trim();
  const category = merchant.category.trim();
  if (!name || name.length > 120) {
    throw new Error("Merchant checkout metadata has an invalid name");
  }
  if (!/^[A-Z]{2}$/.test(countryCodeIso2)) {
    throw new Error("Merchant checkout metadata has an invalid country code");
  }
  if (!/^\d{4}$/.test(categoryCode)) {
    throw new Error("Merchant checkout metadata has an invalid category code");
  }
  if (!category || category.length > 120) {
    throw new Error("Merchant checkout metadata has an invalid category");
  }
  return {
    name,
    url: merchantUrl.toString(),
    countryCodeIso2,
    categoryCode,
    category,
  };
}

function httpsUrl(value: string, field: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error(`${field} must use HTTPS`);
  }
  return url.toString();
}

function validateProduct(product: PravaProduct, merchant: MerchantMetadata): PravaProduct {
  const description = product.description.trim();
  if (!description || description.length > 500) {
    throw new Error("Prava product descriptions must be between 1 and 500 characters");
  }
  const merchantName = product.merchantName?.trim();
  const merchantUrl = product.merchantUrl
    ? httpsUrl(product.merchantUrl, "Prava product merchant URL")
    : undefined;
  if ((merchantName && !merchantUrl) || (!merchantName && merchantUrl)) {
    throw new Error("Prava product merchant provenance must include both name and URL");
  }
  if (
    (merchantName && merchantName !== merchant.name) ||
    (merchantUrl && merchantUrl !== merchant.url)
  ) {
    throw new Error("Prava product provenance does not match the checkout merchant");
  }
  const validated: PravaProduct = {
    description,
    unitPrice: parseAmount(product.unitPrice),
    quantity: product.quantity,
  };
  if (product.productRef) validated.productRef = product.productRef;
  if (product.imageUrl) {
    validated.imageUrl = httpsUrl(product.imageUrl, "Prava product image URL");
  }
  if (merchantName && merchantUrl) {
    validated.merchantName = merchantName;
    validated.merchantUrl = merchantUrl;
  }
  if (product.merchantVariantId !== undefined) {
    const merchantVariantId = product.merchantVariantId.trim();
    if (
      !merchantVariantId ||
      merchantVariantId.length > 500 ||
      /[\u0000-\u001f\u007f]/.test(merchantVariantId)
    ) {
      throw new Error("Prava product merchant variant identifiers must be bounded strings");
    }
    validated.merchantVariantId = merchantVariantId;
  }
  if (product.checkoutUrl) {
    validated.checkoutUrl = httpsUrl(
      product.checkoutUrl,
      "Prava product checkout URL",
    );
  }
  return validated;
}

function merchantOutcome(adapter: MerchantCheckoutAdapter): "simulated" | "sandbox_merchant" | "live" {
  if (adapter.mode === "sandbox_simulator") return "simulated";
  return adapter.mode;
}

function containsCredential(
  value: unknown,
  credential: MerchantPaymentCredential,
): boolean {
  const serialized = JSON.stringify(value);
  if (serialized.includes(credential.token)) return true;
  const escapedCvv = credential.dynamicCvv.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\D)${escapedCvv}(?:\\D|$)`).test(serialized);
}

function isExpectedSandboxDecline(result: MerchantCheckoutResult): boolean {
  const reason = [
    result.responseCode,
    result.evidence.responseCode,
    result.evidence.responseText,
  ].join(" ");
  return /(?:^|\D)51(?:\D|$)|insufficient[\s_-]*funds?|test[\s_-]*card|sandbox[\s_-]*card/i.test(reason);
}

function validateMerchantResult(
  adapter: MerchantCheckoutAdapter,
  result: MerchantCheckoutResult,
  credential: MerchantPaymentCredential,
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
  if (result.expectedSandboxDecline) {
    if (
      adapter.mode !== "sandbox_merchant" ||
      result.status !== "declined" ||
      !isExpectedSandboxDecline(result)
    ) {
      throw new Error("Merchant checkout mislabeled its sandbox decline");
    }
  }
  if (
    result.status === "approved" &&
    (!result.orderId?.trim() || !result.authorizationCode?.trim())
  ) {
    throw new Error("Approved merchant checkout omitted its order or authorization reference");
  }
  const evidenceUrl = new URL(result.evidence.merchantUrl);
  const adapterUrl = new URL(adapter.merchant.url);
  if (
    result.evidence.merchantName.trim() !== adapter.merchant.name.trim() ||
    evidenceUrl.toString() !== adapterUrl.toString()
  ) {
    throw new Error("Merchant attempt evidence does not match the configured merchant");
  }
  if (!Number.isFinite(Date.parse(result.evidence.attemptedAt))) {
    throw new Error("Merchant attempt evidence omitted a valid attempt timestamp");
  }
  const responseText = result.evidence.responseText.trim();
  const evidenceResponseCode = result.evidence.responseCode.trim();
  const reference = result.evidence.reference?.trim() || null;
  if (!responseText || responseText.length > 500 || !/^\S+$/.test(evidenceResponseCode)) {
    throw new Error("Merchant attempt evidence omitted its sanitized response");
  }
  if (evidenceResponseCode !== result.responseCode.trim()) {
    throw new Error("Merchant attempt evidence response code does not match the checkout result");
  }
  if (reference && reference.length > 160) {
    throw new Error("Merchant attempt evidence reference is too long");
  }
  if (containsCredential(result, credential)) {
    throw new Error("Merchant attempt evidence contained payment credentials");
  }
  return {
    ...result,
    orderId: result.orderId?.trim() || null,
    authorizationCode: result.authorizationCode?.trim() || null,
    responseCode: result.responseCode.trim(),
    evidence: {
      merchantName: result.evidence.merchantName.trim(),
      merchantUrl: evidenceUrl.toString(),
      attemptedAt: new Date(result.evidence.attemptedAt).toISOString(),
      responseText,
      responseCode: evidenceResponseCode,
      reference,
    },
  };
}

function reportAcknowledged(payload: PravaReportStatusResponse | null): boolean {
  const status = payload?.status?.trim().toLowerCase();
  const confirmation = payload?.visa_confirmation?.trim().toLowerCase();
  if (status) return status === "confirmed" || status === "completed";
  return confirmation === "success" || confirmation === "confirmed";
}

function safePravaFailureMessage(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(?:pk|sk)_(?:test|live)_[A-Za-z0-9_-]+\b/g, "[redacted-key]")
    .replace(/\b\d{12,19}\b/g, "[redacted-card]")
    .replace(
      /\b(?:dynamic[_ -]?cvv|cvv|security code)\s*[:=]?\s*\d{3,4}\b/gi,
      "[redacted-security-code]",
    )
    .trim()
    .slice(0, 500);
}

function errorDetail(
  value: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): { code: string; message: string } {
  if (!value || typeof value !== "object") {
    return { code: fallbackCode, message: fallbackMessage };
  }
  const payload = value as Record<string, unknown>;
  const source =
    payload.error && typeof payload.error === "object"
      ? payload.error as Record<string, unknown>
      : payload;
  const message =
    typeof source.message === "string"
      ? safePravaFailureMessage(source.message)
      : "";
  const code =
    typeof source.code === "string"
      ? source.code.trim()
      : typeof source.code === "number"
        ? String(source.code)
        : "";
  return {
    code: code || fallbackCode,
    message: message || fallbackMessage,
  };
}

class PravaApiFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(
      message.toLowerCase().includes(code.toLowerCase())
        ? message
        : `${code}: ${message}`,
    );
    this.name = "PravaApiFailure";
  }
}

function pravaApiFailure(
  value: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): PravaApiFailure {
  const detail = errorDetail(value, fallbackCode, fallbackMessage);
  return new PravaApiFailure(detail.code, detail.message);
}

function paymentFailureDetail(payload: PravaPaymentResult): {
  code: string;
  message: string;
} {
  const candidates = [
    payload.error,
    ...(payload.transactions ?? []).map((transaction) => transaction.error),
  ];
  for (const candidate of candidates) {
    if (candidate?.code !== undefined || candidate?.message?.trim()) {
      return errorDetail(
        candidate,
        "PRAVA_PAYMENT_FAILED",
        "Secure approval failed.",
      );
    }
  }
  return {
    code: "PRAVA_PAYMENT_FAILED",
    message: "Secure approval failed.",
  };
}

function safeLogError(value: unknown, fallback: string): string {
  const message = value instanceof Error ? value.message : fallback;
  return message
    .replace(/\b\d{12,19}\b/g, "[redacted-card]")
    .replace(
      /\b(?:dynamic[_ -]?cvv|cvv|security code)\s*[:=]?\s*\d{3,4}\b/gi,
      "[redacted-security-code]",
    );
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
  const statusMonitorIntervalMs = Math.min(
    30_000,
    Math.max(3_000, options.statusMonitorIntervalMs ?? 3_000),
  );
  const statusMonitorWindowMs = Math.min(
    15 * 60_000,
    Math.max(statusMonitorIntervalMs, options.statusMonitorWindowMs ?? 90_000),
  );
  const checkoutMode = options.checkoutMode ?? "embedded";
  const mode = options.mode ?? "sandbox";
  const merchantCheckout =
    options.merchantCheckout ?? createSandboxMerchantCheckoutAdapter();
  const merchant = validateMerchantMetadata(merchantCheckout.merchant);
  if (
    (mode === "live" && merchantCheckout.mode !== "live") ||
    (mode === "sandbox" && merchantCheckout.mode === "live")
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
      throw pravaApiFailure(
        payload,
        `PRAVA_HTTP_${response.status}`,
        `Prava card lookup failed with HTTP ${response.status}`,
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
    const outcome = record.merchantAttempt
      ? merchantOutcome(merchantCheckout)
      : "not_attempted";
    const failure =
      record.terminalStatus?.status === "failed" ||
      record.terminalStatus?.status === "reconciliation_required"
        ? record.terminalStatus
        : null;
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
      merchantOutcome: outcome,
      merchantAttempt: record.merchantAttempt
        ? structuredClone(record.merchantAttempt.result.evidence)
        : null,
      failureCode: failure?.code ?? null,
      failureMessage: failure?.message ?? null,
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
          error: safeLogError(error, "Unknown delivery error"),
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
      const pollStartedAt = Date.now();
      if (
        record.lastPaymentStatusPollAt > 0 &&
        pollStartedAt - record.lastPaymentStatusPollAt < statusMonitorIntervalMs
      ) {
        return record.lastObservedState?.startsWith("awaiting_result:")
          ? { status: "awaiting_result" }
          : { status: "pending" };
      }
      record.lastPaymentStatusPollAt = pollStartedAt;
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
          const failure = errorDetail(
            payload,
            "PRAVA_PAYMENT_SESSION_NOT_FOUND",
            "This secure approval no longer exists.",
          );
          record.terminalStatus = {
            status: "failed",
            code: failure.code,
            message: `${failure.message} Nothing was ordered.`,
          };
          await notify(record);
          return record.terminalStatus;
        }
        throw pravaApiFailure(
          payload,
          `PRAVA_HTTP_${response.status}`,
          `Prava payment status failed with HTTP ${response.status}`,
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
        const credential: MerchantPaymentCredential = {
          token: credentialLineItem.token as string,
          dynamicCvv: credentialLineItem.dynamic_cvv as string,
          expiryMonth: credentialLineItem.expiry_month as string,
          expiryYear: credentialLineItem.expiry_year as string,
        };
        let merchantAttempt = record.merchantAttempt;
        if (!merchantAttempt) {
          try {
            const result = validateMerchantResult(
              merchantCheckout,
              await merchantCheckout.checkout({
                idempotencyKey: `${record.checkoutId}:${transactionReferenceId}`,
                amount: record.request.totalAmount,
                currency: record.request.currency,
                products: structuredClone(record.request.products),
                recovery: record.request.recovery
                  ? structuredClone(record.request.recovery)
                  : null,
                buyer: {
                  email: record.request.employeeEmail,
                  phone: record.request.employeePhone,
                  ...buyerName(
                    record.request.employeeName ??
                      record.request.recovery?.passengerName ??
                      "Tavra Traveler",
                  ),
                },
                credential,
              }),
              credential,
            );
            merchantAttempt = { transactionReferenceId, result };
          } catch (error) {
            record.terminalStatus = error instanceof MerchantCheckoutPreSubmitError
              ? {
                  status: "failed",
                  message:
                    "The end-merchant checkout could not be submitted. Tavra will not retry it automatically, and nothing was ordered.",
                }
              : {
                  status: "reconciliation_required",
                  message:
                    error instanceof MerchantCheckoutUncertainError
                      ? "The end-merchant payment was submitted, but its outcome could not be verified. Tavra will not retry it; support must reconcile the attempt."
                      : "The end-merchant attempt did not return a verified outcome. Tavra will not retry it; support must confirm whether a submission occurred.",
                };
            await notify(record);
            return record.terminalStatus;
          }
        }
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
          throw pravaApiFailure(
            reportPayload,
            `PRAVA_HTTP_${reportResponse.status}`,
            `Prava outcome reporting failed with HTTP ${reportResponse.status}`,
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
            merchantMode: merchantCheckout.mode,
            confirmation: reportPayload?.visa_confirmation ?? "received",
            merchantOrderId: merchantAttempt.result.orderId,
          }),
        );
        if (!merchantApproved) {
          if (merchantAttempt.result.expectedSandboxDecline) {
            record.terminalStatus = {
              status: "sandbox_validated",
              merchantAttempt: structuredClone(merchantAttempt.result.evidence),
            };
            await notify(record);
            if (!options.onStatus || record.notifiedStatus === "sandbox_validated") {
              stopStatusMonitor(record);
            }
            return record.terminalStatus;
          }
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
          merchantOutcome: merchantOutcome(merchantCheckout),
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
            merchantOutcome: merchantOutcome(merchantCheckout),
          };
        } else if (record.merchantAttempt.result.expectedSandboxDecline) {
          record.terminalStatus = {
            status: "sandbox_validated",
            merchantAttempt: structuredClone(record.merchantAttempt.result.evidence),
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
        const failure = paymentFailureDetail(payload);
        record.terminalStatus =
          record.merchantAttempt?.result.status === "approved"
            ? {
                status: "reconciliation_required",
                code: failure.code,
                message:
                  `${failure.message} The merchant approved the checkout, so Tavra stopped and support must reconcile the outcome.`,
              }
            : {
                status: "failed",
                code: failure.code,
                message: `${failure.message} Nothing was ordered.`,
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
      const now = Date.now();
      record.monitorUntil = Math.max(
        record.monitorUntil,
        Math.min(
          now + statusMonitorWindowMs,
          Date.parse(record.session.expires_at) + 30_000,
        ),
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
              error: safeLogError(error, "Unknown polling error"),
            }),
          );
        }
        const notificationDelivered =
          status?.status === "completed" ||
          status?.status === "sandbox_validated" ||
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
      if (!isValidEmployeeEmail(request.employeeEmail)) {
        throw new Error("Prava checkout requires a valid employee email");
      }
      if (
        request.employeeName !== undefined &&
        (!request.employeeName.trim() || request.employeeName.trim().length > 120)
      ) {
        throw new Error("Prava checkout employee name must be between 1 and 120 characters");
      }
      if (request.employeeName) request.employeeName = request.employeeName.trim();
      if (request.products.length === 0) {
        throw new Error("Prava checkout requires at least one product");
      }
      if (!request.products.every((product) => Number.isInteger(product.quantity) && product.quantity > 0)) {
        throw new Error("Prava product quantities must be positive integers");
      }
      request.products = request.products.map((product) =>
        validateProduct(product, merchant),
      );
      if (
        !request.products.every(
          (product) =>
            product.productRef === undefined ||
            /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(product.productRef),
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
                name: merchant.name,
                url: merchant.url,
                country_code_iso2: merchant.countryCodeIso2,
                category_code: merchant.categoryCode,
                category: merchant.category,
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
        throw pravaApiFailure(
          payload,
          `PRAVA_HTTP_${response.status}`,
          `Prava session creation failed with HTTP ${response.status}`,
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
        lastPaymentStatusPollAt: 0,
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
