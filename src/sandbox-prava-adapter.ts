import {
  MerchantCheckoutPreSubmitError,
  MerchantCheckoutUncertainError,
  type MerchantCheckoutAdapter,
  type MerchantCheckoutResult,
  type PravaProduct,
  type RecoveryCheckoutContext,
} from "./prava.js";
import {
  MEDDU_MCP_URL,
  MEDDU_MERCHANT,
  MEDDU_MERCHANT_CONFIG,
  createPlaywrightShopifyBrowserExecutor,
  validateMedduCheckoutUrl,
  type MedduOffer,
  type MerchantBuyer,
  type MerchantMoney,
  type MerchantShippingAddress,
  type PreparedMerchantCheckout,
  type SandboxMerchantAttemptResult,
  type SandboxMerchantBrowserExecutor,
} from "./sandbox-merchant.js";

const MERCHANT_ORIGIN = MEDDU_MERCHANT_CONFIG.origin;
const MERCHANT_ORIGIN_URL = new URL(MERCHANT_ORIGIN);
const MAX_TOTAL_MINOR = MEDDU_MERCHANT_CONFIG.maxTotalMinor;
const IMAGE_HOSTS = new Set<string>(MEDDU_MERCHANT_CONFIG.imageHosts);
const CHECKOUT_HOSTS = new Set<string>(MEDDU_MERCHANT_CONFIG.checkoutHosts);

interface AdapterRequest {
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
  credential: {
    token: string;
    dynamicCvv: string;
    expiryMonth: string;
    expiryYear: string;
  };
}

interface ValidatedMerchantRequest {
  buyer: MerchantBuyer;
  shippingAddress: MerchantShippingAddress;
  checkout: PreparedMerchantCheckout;
  expectedTotal: MerchantMoney;
}

function preSubmit(message: string): never {
  throw new MerchantCheckoutPreSubmitError(message);
}

function minorAmount(value: string, label: string): bigint {
  const trimmed = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(trimmed)) {
    return preSubmit(`${label} must be an exact decimal amount`);
  }
  const [whole = "0", fraction = ""] = trimmed.split(".");
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (amount <= 0n) return preSubmit(`${label} must be positive`);
  return amount;
}

function moneyFromMinor(amount: bigint): MerchantMoney {
  return {
    amount: `${amount / 100n}.${(amount % 100n).toString().padStart(2, "0")}`,
    currency: "AED",
    minorAmount: amount.toString(),
  };
}

function requiredText(value: string | undefined | null, label: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    return preSubmit(`Merchant checkout requires ${label}`);
  }
  return trimmed;
}

function exactMerchantOrigin(value: string | undefined): string {
  const raw = requiredText(value, "the merchant origin");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return preSubmit("Merchant product provenance has an invalid origin");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.origin !== MERCHANT_ORIGIN_URL.origin ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    return preSubmit("Merchant product provenance does not match Meddu");
  }
  return url.toString();
}

function trustedImageUrl(value: string | undefined): string {
  const raw = requiredText(value, "the merchant product image");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return preSubmit("Merchant product provenance has an invalid image URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !IMAGE_HOSTS.has(url.hostname.toLowerCase())
  ) {
    return preSubmit("Merchant product image is not from an approved merchant host");
  }
  return url.toString();
}

function merchantVariantId(value: string | undefined): string {
  const variantId = requiredText(value, "the merchant variant ID");
  if (!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(variantId)) {
    return preSubmit("Merchant product provenance has an invalid Shopify variant ID");
  }
  return variantId;
}

function selectedMerchantProduct(products: PravaProduct[]): PravaProduct {
  const merchantProducts = products.filter(
    (product) =>
      product.merchantName !== undefined ||
      product.merchantUrl !== undefined ||
      product.merchantVariantId !== undefined ||
      product.checkoutUrl !== undefined,
  );
  if (merchantProducts.length !== 1) {
    return preSubmit("Merchant checkout requires exactly one provenance-bound product");
  }
  const selected = merchantProducts[0];
  if (!selected) return preSubmit("Merchant checkout omitted its selected product");
  if (selected.quantity !== 1) {
    return preSubmit("Meddu sandbox checkout supports exactly one selected item");
  }
  return selected;
}

function validateLineItems(products: PravaProduct[], amount: bigint): void {
  if (products.length === 0) return preSubmit("Merchant checkout omitted its line items");
  let sum = 0n;
  for (const product of products) {
    if (!Number.isSafeInteger(product.quantity) || product.quantity <= 0) {
      return preSubmit("Merchant checkout contains an invalid quantity");
    }
    const unit = minorAmount(product.unitPrice, "Merchant line-item price");
    sum += unit * BigInt(product.quantity);

    if (product.merchantVariantId === undefined) {
      if (
        product.productRef !== MEDDU_MERCHANT_CONFIG.fulfillmentRef ||
        product.quantity !== 1 ||
        !/^merchant shipping and tax$/i.test(product.description.trim()) ||
        product.imageUrl !== undefined ||
        product.merchantName !== undefined ||
        product.merchantUrl !== undefined ||
        product.checkoutUrl !== undefined
      ) {
        return preSubmit("Merchant checkout contains an unverified non-product line item");
      }
    }
  }
  if (sum !== amount) {
    return preSubmit("Merchant line items do not equal the exact approved total");
  }
}

function buyerNames(request: AdapterRequest): { firstName: string; lastName: string } {
  const directFirst = request.buyer.firstName?.trim();
  const directLast = request.buyer.lastName?.trim();
  if (directFirst && directLast) {
    return {
      firstName: requiredText(directFirst, "the buyer first name"),
      lastName: requiredText(directLast, "the buyer last name"),
    };
  }
  const passengerName = request.recovery?.passengerName?.trim() ?? "";
  const parts = passengerName.split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    return preSubmit("Merchant checkout requires the confirmed recipient name");
  }
  return {
    firstName: requiredText(parts.slice(0, -1).join(" "), "the buyer first name"),
    lastName: requiredText(parts.at(-1), "the buyer last name"),
  };
}

function confirmedUaeAddress(
  recovery: RecoveryCheckoutContext | null,
  names: { firstName: string; lastName: string },
  phone: string,
): MerchantShippingAddress {
  if (!recovery) return preSubmit("Merchant checkout requires a confirmed recovery case");
  if (
    recovery.deliveryAddressSource !== "message" &&
    recovery.deliveryAddressSource !== "linq_location"
  ) {
    return preSubmit("Merchant checkout requires a confirmed delivery-address source");
  }
  const deliveryAddress = requiredText(
    recovery.deliveryAddress,
    "the confirmed delivery address",
  );
  const deliveryArea = requiredText(recovery.deliveryArea, "the delivery area");
  const combined = `${deliveryAddress} ${deliveryArea}`;
  if (
    /\[(?:delivery )?address omitted\]|\b(?:unknown|tbd|not provided)\b/i.test(
      combined,
    ) ||
    !/\b(?:united arab emirates|uae|abu dhabi|dubai|sharjah|ajman|fujairah|ras al khaimah|umm al quwain)\b/i.test(
      combined,
    )
  ) {
    return preSubmit("Meddu checkout requires a confirmed UAE address");
  }
  const locality = /\babu dhabi\b/i.test(combined)
    ? "Abu Dhabi"
    : /\bdubai\b/i.test(combined)
      ? "Dubai"
      : deliveryArea;
  return {
    firstName: names.firstName,
    lastName: names.lastName,
    streetAddress: deliveryAddress,
    addressLocality: locality,
    addressRegion: locality,
    addressCountry: "AE",
    phone: requiredText(phone, "the recipient phone number"),
  };
}

function validatedRequest(request: AdapterRequest): ValidatedMerchantRequest {
  if (request.currency.trim().toUpperCase() !== "AED") {
    return preSubmit("Meddu checkout requires AED");
  }
  const totalMinor = minorAmount(request.amount, "Merchant total");
  if (totalMinor > MAX_TOTAL_MINOR) {
    return preSubmit("Merchant total exceeds Tavra's AED 250 recovery limit");
  }
  validateLineItems(request.products, totalMinor);
  const product = selectedMerchantProduct(request.products);
  if (requiredText(product.merchantName, "the merchant name") !== MEDDU_MERCHANT.name) {
    return preSubmit("Merchant product provenance does not match Meddu");
  }
  exactMerchantOrigin(product.merchantUrl);
  const variantId = merchantVariantId(product.merchantVariantId);
  const imageUrl = trustedImageUrl(product.imageUrl);
  const checkoutUrl = validateMedduCheckoutUrl(
    requiredText(product.checkoutUrl, "the merchant checkout URL"),
  );
  const cartVariant = new URL(checkoutUrl).pathname.match(
    /^\/cart\/(\d+):1\/?$/i,
  )?.[1];
  if (cartVariant && !variantId.endsWith(`/${cartVariant}`)) {
    return preSubmit("Merchant checkout URL does not match the selected variant");
  }
  const productMinor = minorAmount(product.unitPrice, "Merchant product price");
  const names = buyerNames(request);
  const buyer: MerchantBuyer = {
    email: requiredText(request.buyer.email, "the buyer email").toLowerCase(),
    firstName: names.firstName,
    lastName: names.lastName,
    phone: requiredText(request.buyer.phone, "the buyer phone number"),
  };
  const shippingAddress = confirmedUaeAddress(
    request.recovery,
    names,
    request.buyer.phone,
  );
  const productPrice = moneyFromMinor(productMinor);
  const offer: MedduOffer = {
    merchant: MEDDU_MERCHANT,
    productId: null,
    variantId,
    title: requiredText(product.description, "the merchant product description"),
    variantTitle: null,
    description: requiredText(product.description, "the merchant product description"),
    available: true,
    imageUrl,
    checkoutUrl,
    price: productPrice,
    provenance: {
      source: "merchant_ucp",
      merchantDomain: MEDDU_MERCHANT.domain,
      endpoint: MEDDU_MCP_URL,
      retrievedAt: new Date().toISOString(),
    },
  };
  return {
    buyer,
    shippingAddress,
    expectedTotal: moneyFromMinor(totalMinor),
    checkout: {
      merchant: MEDDU_MERCHANT,
      offer,
      checkoutUrl,
      checkoutId: null,
      status: "approval_complete",
      total: moneyFromMinor(totalMinor),
      source: /^\/cart\b/i.test(new URL(checkoutUrl).pathname)
        ? "ucp_catalog_checkout_url"
        : "ucp_checkout",
      preparedAt: new Date().toISOString(),
    },
  };
}

function mappedResult(result: SandboxMerchantAttemptResult): MerchantCheckoutResult {
  const metadataMatches =
    result.merchant.name === MEDDU_MERCHANT.name &&
    result.merchant.domain === MEDDU_MERCHANT.domain &&
    result.merchant.country === MEDDU_MERCHANT.country &&
    CHECKOUT_HOSTS.has(result.checkoutHost.toLowerCase()) &&
    Number.isFinite(Date.parse(result.attemptedAt));
  if (!metadataMatches) {
    if (result.paymentSubmitted) {
      throw new MerchantCheckoutUncertainError(
        "The submitted merchant attempt returned unverifiable evidence",
      );
    }
    return preSubmit("The merchant attempt returned unverifiable evidence");
  }
  const evidenceBase = {
    merchantName: MEDDU_MERCHANT.name,
    merchantUrl: MERCHANT_ORIGIN,
    attemptedAt: result.attemptedAt,
  };
  if (result.status === "failed_pre_submit") {
    const messages = {
      invalid_request: "The merchant attempt did not receive a valid checkout request",
      checkout_unavailable: "The merchant checkout could not be prepared",
      payment_form_unavailable: "The merchant payment form was unavailable",
    } as const;
    return preSubmit(messages[result.code]);
  }
  if (result.status === "reconciliation_required") {
    throw new MerchantCheckoutUncertainError(
      "The merchant may have received the payment submission; reconciliation is required",
    );
  }
  if (!result.paymentSubmitted) {
    return preSubmit("The merchant result did not prove a payment submission");
  }
  if (result.status === "approved") {
    const orderId = result.orderId?.trim();
    if (!orderId) {
      throw new MerchantCheckoutUncertainError(
        "The merchant showed success without a verifiable order reference",
      );
    }
    return {
      status: "approved",
      orderId,
      authorizationCode: orderId,
      // Prava's report-status contract accepts processor response codes with
      // a maximum length of two characters. Use the standard approval code
      // here and keep the merchant-specific text only in sanitized evidence.
      responseCode: "00",
      simulated: false,
      expectedSandboxDecline: false,
      evidence: {
        ...evidenceBase,
        responseText: "Merchant checkout returned an order confirmation",
        responseCode: result.responseCode,
        reference: orderId,
      },
    };
  }

  const expected =
    result.reason === "insufficient_funds" || result.reason === "test_card";
  // Keep Prava's report-status payload processor-compatible. The detailed
  // merchant reason remains in responseText and is never collapsed in the UI.
  const responseCode = result.reason === "insufficient_funds" ? "51" : "05";
  const fallbackResponseText =
    result.reason === "insufficient_funds"
      ? "Merchant checkout declined the approved one-time card for insufficient funds"
      : result.reason === "test_card"
        ? "Merchant checkout declined the approved one-time card because it is a sandbox test credential"
        : "Merchant checkout declined the approved payment";
  const processorMessage = "message" in result ? result.message : undefined;
  const responseText = processorMessage?.trim()
    ? processorMessage.trim().slice(0, 500)
    : fallbackResponseText;
  return {
    status: "declined",
    orderId: null,
    authorizationCode: null,
    responseCode,
    simulated: false,
    expectedSandboxDecline: expected,
    evidence: {
      ...evidenceBase,
      responseText,
      responseCode,
      reference: null,
    },
  };
}

/**
 * Connects Tavra's Prava one-time credential flow to the reviewed Meddu
 * Shopify checkout. Each idempotency key is submitted at most once.
 * The adapter retains only the sanitized result promise, never card data.
 */
export function createMedduPravaMerchantAdapter(
  options: { executor?: SandboxMerchantBrowserExecutor } = {},
): MerchantCheckoutAdapter {
  const executor =
    options.executor ?? createPlaywrightShopifyBrowserExecutor();
  const attempts = new Map<string, Promise<MerchantCheckoutResult>>();
  return {
    mode: "sandbox_merchant",
    merchant: {
      name: MEDDU_MERCHANT.name,
      url: MERCHANT_ORIGIN,
      countryCodeIso2: MEDDU_MERCHANT.country,
      categoryCode: "5912",
      category: "Drug Stores and Pharmacies",
    },
    checkout(request) {
      const idempotencyKey = request.idempotencyKey.trim();
      if (!idempotencyKey) {
        return Promise.reject(
          new MerchantCheckoutPreSubmitError(
            "Merchant checkout requires an idempotency key",
          ),
        );
      }
      const existing = attempts.get(idempotencyKey);
      if (existing) return existing;

      const attempt = (async () => {
        const validated = validatedRequest(request);
        try {
          const result = await executor.attempt({
            idempotencyKey,
            checkout: validated.checkout,
            buyer: validated.buyer,
            shippingAddress: validated.shippingAddress,
            credential: request.credential,
            expectedTotal: validated.expectedTotal,
          });
          return mappedResult(result);
        } catch (error) {
          if (
            error instanceof MerchantCheckoutPreSubmitError ||
            error instanceof MerchantCheckoutUncertainError
          ) {
            throw error;
          }
          throw new MerchantCheckoutUncertainError(
            "The merchant checkout executor ended without a classified outcome",
          );
        }
      })();
      attempts.set(idempotencyKey, attempt);
      return attempt;
    },
  };
}

/** @deprecated Use `createMedduPravaMerchantAdapter`. */
export const createDarAlEmiratesPravaMerchantAdapter =
  createMedduPravaMerchantAdapter;
