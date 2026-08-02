import {
  REQUIRED_PRAVA_COMMERCE_SCOPES,
  assertWithinRecoveryCap,
  commerceAmountMinor,
  isValidHttpsProductImage,
  normalizeCommerceAmount,
  type AddCommerceAddressRequest,
  type CommerceAddress,
  type CommerceCheckoutResult,
  type CommerceHealth,
  type CommerceMerchant,
  type CommerceMoney,
  type CommerceOffer,
  type CommercePaymentSession,
  type CommercePaymentStatus,
  type CommerceProduct,
  type CommerceProvider,
  type CommerceProvenance,
  type CommerceQuote,
  type CommerceSearchPage,
  type CommerceSearchRequest,
  type CommerceSearchResult,
  type PravaCommerceScope,
} from "./commerce.js";
import { isPlausiblePublicHostname } from "./prava.js";

export const DEFAULT_PRAVA_MCP_URL = "https://mcp.pay.prava.space/mcp";

export type PravaCommerceToolName =
  | "ping"
  | "list_agents"
  | "shop_list_addresses"
  | "shop_add_address"
  | "shop_search"
  | "shop_product"
  | "shop_quote"
  | "create_payment_session"
  | "get_payment_status"
  | "shop_checkout";

export interface PravaCommerceTransport {
  getGrantedScopes(): Promise<ReadonlySet<string>>;
  callTool(name: PravaCommerceToolName, args: Record<string, unknown>): Promise<unknown>;
}

export interface PravaUcpCommerceProviderOptions {
  transport: PravaCommerceTransport;
  now?: () => Date;
}

type UnknownRecord = Record<string, unknown>;

const TOOL_SCOPES: Readonly<
  Partial<Record<PravaCommerceToolName, PravaCommerceScope>>
> = {
  list_agents: "payments:read",
  shop_list_addresses: "payments:read",
  shop_add_address: "payments:write",
  shop_search: "payments:read",
  shop_product: "payments:read",
  shop_quote: "payments:write",
  create_payment_session: "checkout:run",
  get_payment_status: "payments:read",
  shop_checkout: "checkout:run",
};

function asRecord(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Prava ${label} response was not an object`);
  }
  return value as UnknownRecord;
}

function optionalRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function optionalString(record: UnknownRecord, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function sanitizePravaFailureText(value: string): string {
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

function pravaFailureDetail(
  value: unknown,
  fallbackCode: string | null,
  fallbackMessage: string | null,
): { code: string | null; message: string | null } {
  const payload = optionalRecord(value);
  const source = optionalRecord(payload?.error) ?? payload;
  const rawCode = source ? optionalString(source, "code", "error_code") : null;
  const rawMessage = source ? optionalString(source, "message", "error_message") : null;
  const error = value instanceof Error ? value : null;
  const errorCode = error
    ? optionalString(error as unknown as UnknownRecord, "code")
    : null;
  return {
    code: sanitizePravaFailureText(rawCode ?? errorCode ?? fallbackCode ?? "") || null,
    message:
      sanitizePravaFailureText(rawMessage ?? error?.message ?? fallbackMessage ?? "") ||
      null,
  };
}

function failureMessage(detail: {
  code: string | null;
  message: string | null;
}): string | null {
  if (!detail.message) return detail.code;
  if (!detail.code || detail.message.toLowerCase().includes(detail.code.toLowerCase())) {
    return detail.message;
  }
  return `${detail.code}: ${detail.message}`;
}

function requiredString(
  record: UnknownRecord,
  label: string,
  ...keys: string[]
): string {
  const value = optionalString(record, ...keys);
  if (!value) throw new Error(`Prava ${label} response omitted ${keys[0]}`);
  return value;
}

function firstArray(record: UnknownRecord, ...keys: string[]): unknown[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function requiredArray(record: UnknownRecord, label: string, ...keys: string[]): unknown[] {
  const array = firstArray(record, ...keys);
  if (array.length === 0) {
    const hasArray = keys.some((key) => Array.isArray(record[key]));
    if (!hasArray) throw new Error(`Prava ${label} response omitted ${keys[0]}`);
  }
  return array;
}

function parseIsoCountry(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) {
    throw new Error("Prava returned an invalid merchant country");
  }
  return normalized;
}

function parseMerchantDomain(value: string): string {
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(value)
    ? value
    : `https://${value}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("Prava returned an invalid merchant domain");
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
    throw new Error("Prava returned an untrusted merchant domain");
  }
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!isPlausiblePublicHostname(hostname)) {
    throw new Error("Prava returned a merchant domain without a recognized public TLD");
  }
  return hostname;
}

function parseMerchant(record: UnknownRecord, fallback?: CommerceMerchant): CommerceMerchant {
  const nested = optionalRecord(record.merchant) ?? optionalRecord(record.merchant_details);
  const merchantString =
    typeof record.merchant === "string" ? record.merchant.trim() : null;
  const domainValue =
    (nested && optionalString(nested, "domain", "merchant_domain", "url", "merchant_url")) ??
    optionalString(record, "merchant_domain", "domain", "merchant_url") ??
    merchantString ??
    fallback?.domain ??
    null;
  if (!domainValue) throw new Error("Prava product response omitted merchant domain");
  const domain = parseMerchantDomain(domainValue);
  const name =
    (nested && optionalString(nested, "name", "merchant_name", "title")) ??
    optionalString(record, "merchant_name") ??
    fallback?.name ??
    domain;
  const country = parseIsoCountry(
    (nested && optionalString(nested, "country", "country_code", "country_code_iso2")) ??
      optionalString(record, "merchant_country", "country", "country_code_iso2") ??
      fallback?.country ??
      null,
  );
  return { name, domain, country };
}

function parseCurrency(value: string | null): CommerceMoney["currency"] {
  const currency = value?.trim().toUpperCase();
  if (currency !== "AED" && currency !== "USD") {
    throw new Error(
      `Prava returned unsupported live-recovery currency ${currency || "(missing)"}`,
    );
  }
  return currency;
}

function parseMoney(
  source: unknown,
  fallbackCurrency: string | null,
  label: string,
): CommerceMoney {
  const nested = optionalRecord(source);
  const amountValue = nested
    ? optionalString(nested, "amount", "value", "total_amount", "price")
    : typeof source === "string" || typeof source === "number"
      ? String(source)
      : null;
  if (!amountValue) throw new Error(`Prava ${label} response omitted amount`);
  const currencyValue = nested
    ? optionalString(nested, "currency", "currency_code") ?? fallbackCurrency
    : fallbackCurrency;
  return {
    amount: normalizeCommerceAmount(amountValue),
    currency: parseCurrency(currencyValue),
  };
}

function parseOptionalMoney(
  source: unknown,
  fallbackCurrency: string | null,
): CommerceMoney | null {
  if (source === undefined || source === null || source === "") return null;
  return parseMoney(source, fallbackCurrency, "search price");
}

function parseDate(value: string, label: string, now: Date): string {
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) throw new Error(`Prava returned an invalid ${label}`);
  if (epoch <= now.getTime()) throw new Error(`Prava returned an expired ${label}`);
  return new Date(epoch).toISOString();
}

function parseTrustedPaymentUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Prava returned an invalid payment URL");
  }
  if (
    url.protocol !== "https:" ||
    !/(^|\.)prava\.space$/i.test(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error("Prava returned an untrusted payment URL");
  }
  return url.toString();
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return null;
}

function parseOptions(value: unknown): Record<string, string> {
  const record = optionalRecord(value);
  if (record) {
    return Object.fromEntries(
      Object.entries(record)
        .filter((entry): entry is [string, string | number] =>
          typeof entry[1] === "string" || typeof entry[1] === "number",
        )
        .map(([key, option]) => [key.trim(), String(option).trim()])
        .filter(([key, option]) => Boolean(key && option)),
    );
  }
  if (!Array.isArray(value)) return {};
  const entries: Array<[string, string]> = [];
  for (const item of value) {
    const option = optionalRecord(item);
    if (!option) continue;
    const key = optionalString(option, "name", "key", "option");
    const optionValue = optionalString(option, "value", "label");
    if (key && optionValue) entries.push([key, optionValue]);
  }
  return Object.fromEntries(entries);
}

function parseImage(value: unknown): string | null {
  const direct = typeof value === "string" ? value.trim() : null;
  const record = optionalRecord(value);
  const candidate =
    direct ?? (record && optionalString(record, "url", "src", "image_url"));
  return isValidHttpsProductImage(candidate) ? candidate : null;
}

function parseImages(record: UnknownRecord): string[] {
  const images = firstArray(record, "images", "image_urls")
    .map(parseImage)
    .filter((image): image is string => Boolean(image));
  const single = parseImage(record.image_url ?? record.image ?? record.thumbnail);
  return [...new Set(single ? [single, ...images] : images)];
}

function provenance(merchant: CommerceMerchant, now: Date): CommerceProvenance {
  return {
    source: "prava_ucp",
    merchantDomain: merchant.domain,
    retrievedAt: now.toISOString(),
  };
}

function validateIdentifier(value: string, label: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(trimmed)) {
    throw new Error(`${label} is invalid`);
  }
  return trimmed;
}

function validateAddressRequest(request: AddCommerceAddressRequest): void {
  const required = [
    request.firstName,
    request.lastName,
    request.street,
    request.city,
    request.region,
    request.postalCode,
  ];
  if (required.some((value) => !value.trim())) {
    throw new Error("A complete delivery address is required before saving it to Prava");
  }
  if (!/^[A-Za-z]{2}$/.test(request.country.trim())) {
    throw new Error("Delivery country must use a two-letter ISO code");
  }
  if (request.phone && !/^\+[1-9]\d{7,14}$/.test(request.phone.trim())) {
    throw new Error("Delivery contact phone must use E.164 format");
  }
}

function addressFromPayload(value: unknown): CommerceAddress {
  const record = asRecord(value, "address");
  const summary = optionalString(record, "masked_summary", "short_summary");
  if (!summary) {
    throw new Error(
      "Prava address response omitted an explicit masked_summary or short_summary",
    );
  }
  return {
    id: validateIdentifier(requiredString(record, "address", "id", "address_id"), "Address ID"),
    label: optionalString(record, "label", "name") ?? "Delivery address",
    summary,
    country: parseIsoCountry(optionalString(record, "country", "country_code")),
    isDefault: parseBoolean(record.is_default ?? record.default) ?? false,
    contactPhoneOnFile:
      parseBoolean(
        record.contact_phone_on_file ?? record.phone_on_file ?? record.has_phone,
      ) ?? false,
  };
}

function checkoutFingerprint(input: {
  quote: CommerceQuote;
  paymentSession: CommercePaymentSession;
}): string {
  return [
    input.quote.quoteId,
    input.quote.total.currency,
    input.quote.total.amount,
    input.paymentSession.sessionId,
  ].join("|");
}

function parseCheckoutOutcome(
  payload: UnknownRecord,
  quote: CommerceQuote,
): CommerceCheckoutResult {
  try {
    const rawStatus = requiredString(payload, "checkout", "status")
      .trim()
      .toLowerCase();
    if (["failed", "declined", "not_approved"].includes(rawStatus)) {
      const failure = pravaFailureDetail(
        payload,
        "PRAVA_CHECKOUT_FAILED",
        "The merchant did not complete the order",
      );
      return {
        status: "failed",
        code: failure.code,
        message: failureMessage(failure) ?? "The merchant did not complete the order",
      };
    }
    if (!["ordered", "completed", "paid", "success"].includes(rawStatus)) {
      return {
        status: "reconciliation_required",
        message: `Prava returned unrecognized checkout status ${rawStatus}; no order is being claimed`,
      };
    }
    const returnedAmount = parseMoney(
      payload.amount ?? payload.total_amount,
      optionalString(payload, "currency", "currency_code") ?? quote.total.currency,
      "checkout amount",
    );
    if (
      returnedAmount.currency !== quote.total.currency ||
      returnedAmount.amount !== quote.total.amount
    ) {
      return {
        status: "reconciliation_required",
        message:
          "Merchant checkout returned an amount that differs from the approved quote; no completion is being claimed.",
      };
    }
    const orderId = optionalString(payload, "order_id", "merchant_order_id");
    if (!orderId) {
      return {
        status: "reconciliation_required",
        message:
          "Merchant checkout reported success without an order ID; no completion is being claimed.",
      };
    }
    return {
      status: "ordered",
      orderId: validateIdentifier(orderId, "Merchant order ID"),
      amount: returnedAmount,
      replayed: parseBoolean(payload.replayed) ?? false,
    };
  } catch {
    return {
      status: "reconciliation_required",
      message:
        "Prava returned an invalid checkout result. Tavra must reconcile it before retrying or claiming an order.",
    };
  }
}

export function createPravaUcpCommerceProvider(
  options: PravaUcpCommerceProviderOptions,
): CommerceProvider {
  const now = options.now ?? (() => new Date());
  const checkoutAttempts = new Map<
    string,
    { fingerprint: string; promise: Promise<CommerceCheckoutResult> }
  >();

  async function missingScopes(): Promise<PravaCommerceScope[]> {
    const granted = await options.transport.getGrantedScopes();
    return REQUIRED_PRAVA_COMMERCE_SCOPES.filter((scope) => !granted.has(scope));
  }

  async function call(
    tool: PravaCommerceToolName,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    const requiredScope = TOOL_SCOPES[tool];
    if (requiredScope) {
      const granted = await options.transport.getGrantedScopes();
      if (!granted.has(requiredScope)) {
        throw new Error(
          `Prava commerce access is missing required scope ${requiredScope}`,
        );
      }
    }
    return options.transport.callTool(tool, args);
  }

  const provider: CommerceProvider = {
    mode: "live",

    async health(): Promise<CommerceHealth> {
      const missing = await missingScopes();
      if (missing.length > 0) {
        return {
          ready: false,
          mode: "live",
          connectedAgentCount: 0,
          savedAddressCount: 0,
          missingScopes: missing,
          message: `Reconnect Prava and approve: ${missing.join(", ")}`,
        };
      }
      let connectedAgentCount = 0;
      let savedAddressCount = 0;
      try {
        const ping = asRecord(await call("ping"), "ping");
        if (ping.pong !== true) throw new Error("Prava ping was not acknowledged");
        const agentsPayload = asRecord(await call("list_agents"), "agents");
        const agents = firstArray(agentsPayload, "agents", "results", "items");
        connectedAgentCount = agents.length;
        const addressesPayload = asRecord(
          await call("shop_list_addresses"),
          "address list",
        );
        const addresses = requiredArray(
          addressesPayload,
          "address list",
          "addresses",
          "results",
          "items",
        );
        savedAddressCount = addresses.reduce<number>((count, value) => {
          try {
            addressFromPayload(value);
            return count + 1;
          } catch {
            return count;
          }
        }, 0);
        const missingPrerequisites = [
          connectedAgentCount === 0 ? "a connected Prava shopping agent" : null,
          savedAddressCount === 0 ? "a saved masked Prava delivery address" : null,
        ].filter((value): value is string => Boolean(value));
        return {
          ready: missingPrerequisites.length === 0,
          mode: "live",
          connectedAgentCount,
          savedAddressCount,
          missingScopes: [],
          message:
            missingPrerequisites.length === 0
              ? null
              : `Live commerce requires ${missingPrerequisites.join(" and ")}.`,
        };
      } catch (error) {
        return {
          ready: false,
          mode: "live",
          connectedAgentCount,
          savedAddressCount,
          missingScopes: [],
          message: error instanceof Error ? error.message : "Prava commerce is unavailable",
        };
      }
    },

    async listAddresses(): Promise<CommerceAddress[]> {
      const payload = asRecord(
        await call("shop_list_addresses"),
        "address list",
      );
      return requiredArray(payload, "address list", "addresses", "results", "items").map(
        addressFromPayload,
      );
    },

    async addAddress(request): Promise<CommerceAddress> {
      validateAddressRequest(request);
      const payload = await call("shop_add_address", {
        first_name: request.firstName.trim(),
        last_name: request.lastName.trim(),
        street: request.street.trim(),
        ...(request.street2?.trim() ? { street2: request.street2.trim() } : {}),
        city: request.city.trim(),
        region: request.region.trim(),
        postal_code: request.postalCode.trim(),
        country: request.country.trim().toUpperCase(),
        ...(request.label?.trim() ? { label: request.label.trim() } : {}),
        ...(request.phone?.trim() ? { phone: request.phone.trim() } : {}),
        ...(request.setDefault === undefined
          ? {}
          : { set_default: request.setDefault }),
      });
      const record = asRecord(payload, "address");
      return addressFromPayload(record.address ?? record);
    },

    async search(request: CommerceSearchRequest): Promise<CommerceSearchPage> {
      const query = request.query.trim();
      const shipsTo = request.shipsTo.trim().toUpperCase();
      if (!query || query.length > 300) {
        throw new Error("Commerce search requires a concise query");
      }
      if (!/^[A-Z]{2}$/.test(shipsTo)) {
        throw new Error("Commerce search destination must be a two-letter country code");
      }
      const payload = asRecord(
        await call("shop_search", {
          query: `${query}; available for delivery to ${shipsTo}`,
          ...(request.merchant?.trim()
            ? { merchant: parseMerchantDomain(request.merchant.trim()) }
            : {}),
          ...(request.cursor?.trim() ? { cursor: request.cursor.trim() } : {}),
        }),
        "search",
      );
      const retrievedAt = now();
      const results = requiredArray(payload, "search", "results", "products", "items").map(
        (value): CommerceSearchResult => {
          const record = asRecord(value, "search product");
          const merchant = parseMerchant(record);
          const currency = optionalString(record, "currency", "currency_code");
          return {
            productId: validateIdentifier(
              requiredString(record, "search product", "product_id", "id"),
              "Product ID",
            ),
            title: requiredString(record, "search product", "title", "name"),
            merchant,
            estimatedPrice: parseOptionalMoney(
              record.price_estimate ?? record.estimated_price ?? record.price,
              currency,
            ),
            imageUrl: parseImage(record.image_url ?? record.image ?? record.thumbnail),
            provenance: provenance(merchant, retrievedAt),
          };
        },
      );
      return {
        results,
        nextCursor: optionalString(payload, "next_cursor", "cursor"),
      };
    },

    async getProduct(input): Promise<CommerceProduct> {
      const productId = validateIdentifier(input.productId, "Product ID");
      const requestedMerchant = input.merchant?.trim()
        ? parseMerchantDomain(input.merchant.trim())
        : null;
      const payload = asRecord(
        await call("shop_product", {
          product_id: productId,
          ...(requestedMerchant ? { merchant: requestedMerchant } : {}),
        }),
        "product",
      );
      const productRecord = optionalRecord(payload.product) ?? payload;
      const fallbackMerchant = requestedMerchant
        ? { name: requestedMerchant, domain: requestedMerchant, country: null }
        : undefined;
      const merchant = parseMerchant(productRecord, fallbackMerchant);
      if (requestedMerchant && merchant.domain !== requestedMerchant) {
        throw new Error("Prava returned a product from a different merchant");
      }
      const returnedProductId = validateIdentifier(
        requiredString(productRecord, "product", "product_id", "id"),
        "Product ID",
      );
      if (returnedProductId !== productId) {
        throw new Error("Prava returned a different product than requested");
      }
      const retrievedAt = now();
      const productProvenance = provenance(merchant, retrievedAt);
      const images = parseImages(productRecord);
      const productTitle = requiredString(productRecord, "product", "title", "name");
      const offerContainer = ["offers", "variants", "items"].some((key) =>
        Array.isArray(payload[key]),
      )
        ? payload
        : productRecord;
      const offers = requiredArray(
        offerContainer,
        "product",
        "offers",
        "variants",
        "items",
      ).map((value): CommerceOffer => {
        const record = asRecord(value, "product offer");
        const offerMerchant = parseMerchant(record, merchant);
        if (offerMerchant.domain !== merchant.domain) {
          throw new Error("Prava returned a cross-merchant offer without a separate product");
        }
        const currency = optionalString(record, "currency", "currency_code");
        const status = optionalString(record, "availability", "status")?.toLowerCase();
        const explicitAvailability = parseBoolean(record.available ?? record.orderable);
        const available =
          explicitAvailability ??
          (status ? ["available", "in_stock", "instock", "orderable"].includes(status) : false);
        return {
          productId,
          variantId: validateIdentifier(
            requiredString(record, "product offer", "variant_id", "id"),
            "Variant ID",
          ),
          title: optionalString(record, "title", "name", "label") ?? productTitle,
          description:
            optionalString(record, "description") ??
            optionalString(productRecord, "description") ??
            productTitle,
          merchant: offerMerchant,
          options: parseOptions(record.options ?? record.selected_options),
          unitPrice: parseMoney(
            record.price ?? record.unit_price,
            currency,
            "product offer",
          ),
          available,
          imageUrl: parseImage(record.image_url ?? record.image) ?? images[0] ?? null,
          provenance: provenance(offerMerchant, retrievedAt),
        };
      });
      return {
        productId,
        title: productTitle,
        description:
          optionalString(productRecord, "description") ?? productTitle,
        merchant,
        images,
        offers,
        provenance: productProvenance,
      };
    },

    async quote(input): Promise<CommerceQuote> {
      if (!input.userApprovedOffer) {
        throw new Error(
          "A live quote requires the user to approve the merchant and exact variant first",
        );
      }
      if (input.offer.provenance.source !== "prava_ucp") {
        throw new Error("Live quoting accepts only a Prava UCP offer");
      }
      if (!input.offer.available) throw new Error("The selected offer is not orderable");
      if (!isValidHttpsProductImage(input.offer.imageUrl)) {
        throw new Error("The selected offer has no trusted UCP product image");
      }
      const quantity = input.quantity ?? 1;
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
        throw new Error("Commerce quantity must be an integer from 1 to 10");
      }
      const addressId = validateIdentifier(input.addressId, "Address ID");
      const payload = asRecord(
        await call("shop_quote", {
          variant_id: validateIdentifier(input.offer.variantId, "Variant ID"),
          merchant: input.offer.merchant.domain,
          quantity,
          address_id: addressId,
        }),
        "quote",
      );
      const totals = optionalRecord(payload.totals) ?? payload;
      const fallbackCurrency =
        optionalString(totals, "currency", "currency_code") ??
        optionalString(payload, "currency", "currency_code") ??
        input.offer.unitPrice.currency;
      const quote: CommerceQuote = {
        quoteId: validateIdentifier(
          requiredString(
            payload,
            "quote",
            "checkout_session_id",
            "quote_id",
          ),
          "Checkout session ID",
        ),
        offer: input.offer,
        addressId,
        quantity,
        subtotal: parseMoney(totals.subtotal, fallbackCurrency, "quote subtotal"),
        shipping: parseMoney(
          totals.shipping ?? totals.shipping_amount,
          fallbackCurrency,
          "quote shipping",
        ),
        tax: parseMoney(totals.tax ?? totals.tax_amount, fallbackCurrency, "quote tax"),
        total: parseMoney(
          totals.total ?? totals.total_amount,
          fallbackCurrency,
          "quote total",
        ),
        deliveryLabel:
          optionalString(payload, "shipping_label", "delivery_label", "shipping_option") ??
          null,
        estimatedArrival:
          optionalString(payload, "estimated_arrival", "delivery_estimate", "eta") ??
          null,
        deliveryEstimateVerified:
          parseBoolean(
            payload.delivery_estimate_verified ??
              payload.estimated_arrival_verified ??
              payload.delivery_verified,
          ) === true,
        expiresAt: parseDate(
          requiredString(payload, "quote", "expires_at", "expiry"),
          "quote expiry",
          now(),
        ),
      };
      const currencies = [
        quote.subtotal.currency,
        quote.shipping.currency,
        quote.tax.currency,
        quote.total.currency,
      ];
      if (currencies.some((currency) => currency !== quote.total.currency)) {
        throw new Error("Prava quote used inconsistent currencies");
      }
      const computed =
        commerceAmountMinor(quote.subtotal.amount) +
        commerceAmountMinor(quote.shipping.amount) +
        commerceAmountMinor(quote.tax.amount);
      if (computed !== commerceAmountMinor(quote.total.amount)) {
        throw new Error("Prava quote total did not match subtotal, shipping, and tax");
      }
      assertWithinRecoveryCap(quote.total);
      return quote;
    },

    async createPaymentSession(input): Promise<CommercePaymentSession> {
      if (!input.userApprovedTotal) {
        throw new Error("Payment approval requires explicit consent to the exact quoted total");
      }
      const quoteExpiry = Date.parse(input.quote.expiresAt);
      if (!Number.isFinite(quoteExpiry) || quoteExpiry <= now().getTime()) {
        throw new Error("The live quote expired; re-quote before requesting payment approval");
      }
      assertWithinRecoveryCap(input.quote.total);
      if (!input.quote.offer.merchant.country) {
        throw new Error("Prava did not provide the merchant country required for payment approval");
      }
      const idempotencyKey = validateIdentifier(
        input.idempotencyKey,
        "Payment idempotency key",
      );
      const payload = asRecord(
        await call("create_payment_session", {
          total_amount: input.quote.total.amount,
          currency: input.quote.total.currency,
          merchant_name: input.quote.offer.merchant.name,
          merchant_url: `https://${input.quote.offer.merchant.domain}/`,
          merchant_country: input.quote.offer.merchant.country,
          products: [
            {
              description: input.quote.offer.description,
              unit_price: input.quote.subtotal.amount,
              quantity: input.quote.quantity,
            },
          ],
          idempotency_key: idempotencyKey,
        }),
        "payment session",
      );
      return {
        sessionId: validateIdentifier(
          requiredString(payload, "payment session", "session_id"),
          "Payment session ID",
        ),
        paymentUrl: parseTrustedPaymentUrl(
          requiredString(payload, "payment session", "payment_url"),
        ),
        expiresAt: parseDate(
          requiredString(payload, "payment session", "expires_at"),
          "payment session expiry",
          now(),
        ),
        replayed: parseBoolean(payload.replayed) ?? false,
        quoteId: input.quote.quoteId,
        total: input.quote.total,
      };
    },

    async getPaymentStatus(sessionId): Promise<CommercePaymentStatus> {
      const payload = asRecord(
        await call("get_payment_status", {
          session_id: validateIdentifier(sessionId, "Payment session ID"),
        }),
        "payment status",
      );
      const status = requiredString(payload, "payment status", "status")
        .trim()
        .toLowerCase();
      if (status === "pending") return { status: "pending" };
      if (status === "completed") return { status: "completed" };
      if (status === "not_found") return { status: "not_found" };
      if (status === "failed") {
        const failure = pravaFailureDetail(
          payload,
          "PRAVA_PAYMENT_FAILED",
          "Prava payment approval failed.",
        );
        return {
          status: "failed",
          code: failure.code,
          message: failure.message,
        };
      }
      return { status: "unknown", rawStatus: status };
    },

    async checkout(input): Promise<CommerceCheckoutResult> {
      if (!input.userApprovedTotal) {
        throw new Error("Merchant checkout requires explicit approval of the final total");
      }
      const idempotencyKey = validateIdentifier(
        input.idempotencyKey,
        "Checkout idempotency key",
      );
      const fingerprint = checkoutFingerprint(input);
      const existing = checkoutAttempts.get(idempotencyKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new Error("Checkout idempotency key was reused for a different quote");
        }
        return existing.promise;
      }

      const attempt = (async (): Promise<CommerceCheckoutResult> => {
        if (
          input.paymentSession.quoteId !== input.quote.quoteId ||
          input.paymentSession.total.currency !== input.quote.total.currency ||
          input.paymentSession.total.amount !== input.quote.total.amount
        ) {
          return {
            status: "failed",
            message:
              "Payment approval does not match the live quote, so merchant checkout was not attempted.",
          };
        }
        if (Date.parse(input.quote.expiresAt) <= now().getTime()) {
          return {
            status: "failed",
            message:
              "The live quote expired, so merchant checkout was not attempted.",
          };
        }
        try {
          assertWithinRecoveryCap(input.quote.total);
        } catch {
          return {
            status: "failed",
            message:
              "The approved total no longer passes Tavra's recovery limit, so merchant checkout was not attempted.",
          };
        }
        let paymentStatus: CommercePaymentStatus;
        try {
          paymentStatus = await provider.getPaymentStatus(
            input.paymentSession.sessionId,
          );
        } catch (error) {
          const failure = pravaFailureDetail(
            error,
            "PRAVA_STATUS_UNAVAILABLE",
            "Tavra could not re-verify payment approval",
          );
          return {
            status: "failed",
            code: failure.code,
            message: `${failureMessage(failure) ?? "Tavra could not re-verify payment approval"}. Merchant checkout was not attempted.`,
          };
        }
        if (paymentStatus.status !== "completed") {
          return {
            status: "failed",
            ...(paymentStatus.status === "failed"
              ? { code: paymentStatus.code }
              : {}),
            message:
              paymentStatus.status === "failed"
                ? failureMessage(paymentStatus) ??
                  "Prava payment approval failed, so merchant checkout was not attempted."
                : paymentStatus.status === "not_found"
                  ? "Prava payment approval was not found, so merchant checkout was not attempted."
                  : "Prava payment approval is not complete, so merchant checkout was not attempted.",
          };
        }

        let payload: UnknownRecord;
        try {
          // The documented Prava shop_checkout schema accepts only these two
          // identifiers. Tavra therefore uses its atomic SQLite checkout claim
          // as the application idempotency boundary instead of inventing an
          // unsupported upstream parameter.
          payload = asRecord(
            await call("shop_checkout", {
              checkout_session_id: input.quote.quoteId,
              payment_session_id: input.paymentSession.sessionId,
            }),
            "checkout",
          );
        } catch (error) {
          const failure = pravaFailureDetail(
            error,
            "PRAVA_CHECKOUT_OUTCOME_UNKNOWN",
            "The merchant checkout outcome is unknown",
          );
          return {
            status: "reconciliation_required",
            code: failure.code,
            message: `${failureMessage(failure) ?? "The merchant checkout outcome is unknown"}. Tavra must reconcile it before retrying or claiming an order.`,
          };
        }
        return parseCheckoutOutcome(payload, input.quote);
      })();
      checkoutAttempts.set(idempotencyKey, { fingerprint, promise: attempt });
      return attempt;
    },
  };

  return provider;
}
