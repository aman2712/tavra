export const REQUIRED_PRAVA_COMMERCE_SCOPES = [
  "payments:read",
  "payments:write",
  "checkout:run",
] as const;

export type PravaCommerceScope =
  (typeof REQUIRED_PRAVA_COMMERCE_SCOPES)[number];

export type CommerceMode = "live" | "sandbox";

export interface CommerceMoney {
  amount: string;
  currency: "AED" | "USD";
}

export interface CommerceMerchant {
  name: string;
  domain: string;
  country: string | null;
}

export interface CommerceProvenance {
  source: "prava_ucp" | "explicit_sandbox";
  merchantDomain: string;
  retrievedAt: string;
}

export interface CommerceAddress {
  id: string;
  label: string;
  /** Masked city/region/country summary returned by Prava. */
  summary: string;
  country: string | null;
  isDefault: boolean;
  contactPhoneOnFile: boolean;
}

export interface AddCommerceAddressRequest {
  firstName: string;
  lastName: string;
  street: string;
  street2?: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  label?: string;
  phone?: string;
  setDefault?: boolean;
}

export type RecoveryEssentialCategory = "tshirt" | "toiletries" | "trousers";

export interface CommerceSearchRequest {
  query: string;
  category: RecoveryEssentialCategory;
  shipsTo: string;
  merchant?: string;
  cursor?: string;
}

export interface CommerceSearchResult {
  productId: string;
  title: string;
  merchant: CommerceMerchant;
  estimatedPrice: CommerceMoney | null;
  imageUrl: string | null;
  provenance: CommerceProvenance;
}

export interface CommerceSearchPage {
  results: CommerceSearchResult[];
  nextCursor: string | null;
}

export interface CommerceOffer {
  productId: string;
  variantId: string;
  title: string;
  description: string;
  merchant: CommerceMerchant;
  options: Readonly<Record<string, string>>;
  unitPrice: CommerceMoney;
  available: boolean;
  imageUrl: string | null;
  provenance: CommerceProvenance;
}

export interface CommerceProduct {
  productId: string;
  title: string;
  description: string;
  merchant: CommerceMerchant;
  images: string[];
  offers: CommerceOffer[];
  provenance: CommerceProvenance;
}

export interface CommerceQuote {
  quoteId: string;
  offer: CommerceOffer;
  addressId: string;
  quantity: number;
  subtotal: CommerceMoney;
  shipping: CommerceMoney;
  tax: CommerceMoney;
  total: CommerceMoney;
  deliveryLabel: string | null;
  estimatedArrival: string | null;
  /** True only when Prava explicitly marks the delivery estimate as verified. */
  deliveryEstimateVerified?: boolean;
  expiresAt: string;
}

export interface CommercePaymentSession {
  sessionId: string;
  paymentUrl: string;
  expiresAt: string;
  replayed: boolean;
  quoteId: string;
  total: CommerceMoney;
}

export type CommercePaymentStatus =
  | { status: "pending" }
  | { status: "completed" }
  | { status: "failed"; code: string | null; message: string | null }
  | { status: "not_found" }
  | { status: "unknown"; rawStatus: string };

export type CommerceCheckoutResult =
  | {
      status: "ordered";
      orderId: string;
      amount: CommerceMoney;
      replayed: boolean;
    }
  | { status: "failed"; code?: string | null; message: string }
  | { status: "reconciliation_required"; code?: string | null; message: string };

export interface CommerceHealth {
  ready: boolean;
  mode: CommerceMode;
  connectedAgentCount: number;
  savedAddressCount: number;
  missingScopes: PravaCommerceScope[];
  message: string | null;
}

export interface CommerceProvider {
  readonly mode: CommerceMode;
  health(): Promise<CommerceHealth>;
  listAddresses(): Promise<CommerceAddress[]>;
  addAddress(request: AddCommerceAddressRequest): Promise<CommerceAddress>;
  search(request: CommerceSearchRequest): Promise<CommerceSearchPage>;
  getProduct(input: {
    productId: string;
    merchant?: string;
  }): Promise<CommerceProduct>;
  quote(input: {
    offer: CommerceOffer;
    addressId: string;
    quantity?: number;
    email?: string;
    /** Must reflect a user confirmation before the spend-adjacent quote call. */
    userApprovedOffer: boolean;
  }): Promise<CommerceQuote>;
  createPaymentSession(input: {
    quote: CommerceQuote;
    idempotencyKey: string;
    /** Must reflect approval of the exact merchant, item, address, and total. */
    userApprovedTotal: boolean;
  }): Promise<CommercePaymentSession>;
  getPaymentStatus(sessionId: string): Promise<CommercePaymentStatus>;
  checkout(input: {
    quote: CommerceQuote;
    paymentSession: CommercePaymentSession;
    idempotencyKey: string;
    /** Required again because this call places the order. */
    userApprovedTotal: boolean;
  }): Promise<CommerceCheckoutResult>;
}

const RECOVERY_CAP_MINOR: Readonly<Record<CommerceMoney["currency"], bigint>> = {
  AED: 25_000n,
  USD: 6_800n,
};

export function normalizeCommerceAmount(value: string): string {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) {
    throw new Error("Commerce amounts must be non-negative decimal strings");
  }
  const [whole = "0", fraction = ""] = value.split(".");
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return `${minor / 100n}.${(minor % 100n).toString().padStart(2, "0")}`;
}

export function commerceAmountMinor(value: string): bigint {
  const normalized = normalizeCommerceAmount(value);
  const [whole = "0", fraction = "00"] = normalized.split(".");
  return BigInt(whole) * 100n + BigInt(fraction);
}

export function assertWithinRecoveryCap(money: CommerceMoney): void {
  const cap = RECOVERY_CAP_MINOR[money.currency];
  if (commerceAmountMinor(money.amount) > cap) {
    const capAmount = `${cap / 100n}.${(cap % 100n).toString().padStart(2, "0")}`;
    throw new Error(
      `Live recovery total ${money.amount} ${money.currency} exceeds the ${capAmount} ${money.currency} cap`,
    );
  }
}

export function isValidHttpsProductImage(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function assertExplicitSandboxMode(input: {
  mode: CommerceMode;
  explicitlyEnabled: boolean;
}): void {
  if (input.mode === "sandbox" && !input.explicitlyEnabled) {
    throw new Error(
      "Sandbox commerce requires explicit enablement and must never be an automatic live-commerce fallback",
    );
  }
}

export interface RecoveryEssentialRequest {
  shipsTo: string;
  tShirtSize?: string;
  trouserWaist?: string;
  trouserInseam?: string;
  /** Variants the employee already rejected in this recovery conversation. */
  excludedVariantIds?: readonly string[];
}

export interface RecoveryEssentialSelection {
  category: RecoveryEssentialCategory;
  result: CommerceSearchResult;
  product: CommerceProduct;
  offer: CommerceOffer;
}

interface RecoverySearchStep {
  category: RecoveryEssentialCategory;
  query: string;
}

function recoverySearchSteps(input: RecoveryEssentialRequest): RecoverySearchStep[] {
  const steps: RecoverySearchStep[] = [];
  const shirtSize = input.tShirtSize?.trim();
  if (shirtSize) {
    steps.push({
      category: "tshirt",
      query: `basic neutral T-shirt size ${shirtSize}`,
    });
  }
  steps.push({
    category: "toiletries",
    query: "essential travel-size toiletry kit",
  });
  const waist = input.trouserWaist?.trim();
  const inseam = input.trouserInseam?.trim();
  if (waist && inseam) {
    steps.push({
      category: "trousers",
      query: `basic trousers waist ${waist} inseam ${inseam}`,
    });
  }
  return steps;
}

function normalizedOptionEntries(offer: CommerceOffer): Array<[string, string]> {
  return Object.entries(offer.options).map(([key, value]) => [
    key.trim().toLowerCase().replace(/[^a-z0-9]/g, ""),
    value.trim().toLowerCase().replace(/\s+/g, ""),
  ]);
}

function hasOption(
  entries: Array<[string, string]>,
  keyIncludes: string,
  expected: string,
): boolean {
  const normalizedExpected = expected.trim().toLowerCase().replace(/\s+/g, "");
  return entries.some(
    ([key, value]) => key.includes(keyIncludes) && value === normalizedExpected,
  );
}

function offerMatches(
  category: RecoveryEssentialCategory,
  offer: CommerceOffer,
  input: RecoveryEssentialRequest,
): boolean {
  if (!offer.available) return false;
  const entries = normalizedOptionEntries(offer);
  if (category === "tshirt") {
    return Boolean(
      input.tShirtSize && hasOption(entries, "size", input.tShirtSize),
    );
  }
  if (category === "trousers") {
    const waist = input.trouserWaist;
    const inseam = input.trouserInseam;
    if (!waist || !inseam) return false;
    const combined = `${waist}x${inseam}`.toLowerCase();
    return (
      (hasOption(entries, "waist", waist) && hasOption(entries, "inseam", inseam)) ||
      entries.some(
        ([key, value]) => key.includes("size") && value === combined,
      )
    );
  }
  return true;
}

function compareOffers(left: CommerceOffer, right: CommerceOffer): number {
  const leftCap = RECOVERY_CAP_MINOR[left.unitPrice.currency];
  const rightCap = RECOVERY_CAP_MINOR[right.unitPrice.currency];
  const leftRatio = commerceAmountMinor(left.unitPrice.amount) * rightCap;
  const rightRatio = commerceAmountMinor(right.unitPrice.amount) * leftCap;
  if (leftRatio < rightRatio) return -1;
  if (leftRatio > rightRatio) return 1;
  return (
    left.merchant.domain.localeCompare(right.merchant.domain) ||
    left.variantId.localeCompare(right.variantId)
  );
}

/**
 * Chooses a live recovery item in a deterministic category order. It stops at
 * selection; quoting remains a separate, explicitly approved action.
 */
export async function selectRecoveryEssential(
  provider: CommerceProvider,
  input: RecoveryEssentialRequest,
): Promise<RecoveryEssentialSelection | null> {
  if (provider.mode !== "live") {
    throw new Error("Live recovery discovery requires a live commerce provider");
  }
  const shipsTo = input.shipsTo.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(shipsTo)) {
    throw new Error("Recovery destination must be a two-letter country code");
  }
  const excludedVariantIds = new Set(
    (input.excludedVariantIds ?? []).map((value) => value.trim()).filter(Boolean),
  );

  for (const step of recoverySearchSteps(input)) {
    const page = await provider.search({
      query: step.query,
      category: step.category,
      shipsTo,
    });
    for (const result of page.results) {
      const product = await provider.getProduct({
        productId: result.productId,
        merchant: result.merchant.domain,
      });
      const offers = product.offers
        .filter((offer) => !excludedVariantIds.has(offer.variantId))
        .filter((offer) => offerMatches(step.category, offer, input))
        .filter((offer) => {
          try {
            assertWithinRecoveryCap(offer.unitPrice);
            return true;
          } catch {
            return false;
          }
        })
        .sort(compareOffers);
      for (const offer of offers) {
        const imageUrl = offer.imageUrl ?? product.images[0] ?? result.imageUrl;
        if (!isValidHttpsProductImage(imageUrl)) continue;
        return {
          category: step.category,
          result,
          product,
          offer: { ...offer, imageUrl },
        };
      }
    }
  }
  return null;
}
