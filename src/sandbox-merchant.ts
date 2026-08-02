/**
 * The single reviewed-merchant trust boundary for Tavra's sandbox commerce
 * path. Every URL, host, currency, limit, and synthetic fulfillment line must
 * be derived from this immutable record.
 */
export const MEDDU_MERCHANT_CONFIG = Object.freeze({
  name: "Meddu",
  domain: "meddu.com",
  origin: "https://meddu.com/",
  country: "AE",
  currency: "AED",
  ucpEndpoint: "https://meddu.com/api/ucp/mcp",
  checkoutHosts: Object.freeze([
    "meddu.com",
    "www.meddu.com",
    "edqvrb-i5.myshopify.com",
  ]),
  imageHosts: Object.freeze([
    "cdn.shopify.com",
    "meddu.com",
    "www.meddu.com",
  ]),
  maxTotalMinor: 25_000n,
  fulfillmentRef: "meddu-fulfillment",
} as const);

export const MEDDU_MCP_URL = MEDDU_MERCHANT_CONFIG.ucpEndpoint;

export const SHOPIFY_PUBLIC_AGENT_PROFILE =
  "https://shopify.dev/ucp/agent-profiles/2026-04-08/valid-with-capabilities.json";

export const MEDDU_MERCHANT = Object.freeze({
  name: MEDDU_MERCHANT_CONFIG.name,
  domain: MEDDU_MERCHANT_CONFIG.domain,
  country: MEDDU_MERCHANT_CONFIG.country,
} as const);

const MEDDU_CHECKOUT_HOSTS = new Set<string>(
  MEDDU_MERCHANT_CONFIG.checkoutHosts,
);
const MEDDU_IMAGE_HOSTS = new Set<string>(MEDDU_MERCHANT_CONFIG.imageHosts);

const DEFAULT_RECOVERY_CAP_MINOR = MEDDU_MERCHANT_CONFIG.maxTotalMinor;

type UnknownRecord = Record<string, unknown>;

const ROUTABLE_EMAIL_TLDS = new Set([
  "ae",
  "ai",
  "app",
  "au",
  "be",
  "biz",
  "br",
  "ca",
  "ch",
  "cn",
  "co",
  "com",
  "de",
  "dev",
  "dk",
  "edu",
  "eg",
  "es",
  "fi",
  "fr",
  "gov",
  "hk",
  "ie",
  "in",
  "info",
  "int",
  "io",
  "it",
  "jp",
  "kr",
  "kw",
  "me",
  "mil",
  "mx",
  "net",
  "nl",
  "no",
  "nz",
  "om",
  "online",
  "org",
  "pt",
  "qa",
  "sa",
  "se",
  "sg",
  "shop",
  "space",
  "store",
  "tech",
  "travel",
  "uk",
  "us",
  "xyz",
  "za",
]);

export interface MerchantMoney {
  /** Normalized decimal amount, for example `74.00`. */
  amount: string;
  /** The merchant's ISO 4217 currency. */
  currency: "AED";
  /** Exact amount returned by UCP, expressed in currency minor units. */
  minorAmount: string;
}

export interface MerchantProductProvenance {
  source: "merchant_ucp";
  merchantDomain: typeof MEDDU_MERCHANT.domain;
  endpoint: string;
  retrievedAt: string;
}

export interface MedduOffer {
  merchant: typeof MEDDU_MERCHANT;
  productId: string | null;
  variantId: string;
  title: string;
  variantTitle: string | null;
  description: string;
  available: true;
  imageUrl: string;
  checkoutUrl: string;
  price: MerchantMoney;
  provenance: MerchantProductProvenance;
}

export interface MedduUcpClientOptions {
  endpoint?: string;
  fetch?: typeof fetch;
  agentProfile?: string;
  now?: () => Date;
  timeoutMs?: number;
}

export interface MerchantBuyer {
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
}

export interface MerchantShippingAddress {
  firstName: string;
  lastName: string;
  streetAddress: string;
  addressLocality: string;
  addressRegion: string;
  addressCountry: "AE";
  postalCode?: string;
  extendedAddress?: string;
  phone?: string;
}

export interface PreparedMerchantCheckout {
  merchant: typeof MEDDU_MERCHANT;
  offer: MedduOffer;
  checkoutUrl: string;
  checkoutId: string | null;
  status: string;
  /** Exact merchant total when returned by `create_checkout`; null for a cart URL. */
  total: MerchantMoney | null;
  source: "ucp_catalog_checkout_url" | "ucp_checkout";
  preparedAt: string;
}

export interface MedduUcpClient {
  discoverRecoveryOffer(input?: {
    query?: string;
    capMinor?: bigint;
  }): Promise<MedduOffer>;
  /**
   * Creates an authenticated UCP checkout when the merchant grants checkout
   * access. Public catalog users can use `prepareCatalogCheckout` instead.
   */
  createCheckout(input: {
    offer: MedduOffer;
    buyer: MerchantBuyer;
    shippingAddress: MerchantShippingAddress;
    idempotencyKey: string;
    accessToken?: string;
  }): Promise<PreparedMerchantCheckout>;
  createCheckoutDraft(input: {
    offer: MedduOffer;
    buyer: MerchantBuyer;
    shippingAddress: MerchantShippingAddress;
    idempotencyKey: string;
    accessToken?: string;
  }): Promise<PreparedMerchantCheckout>;
}

interface RecordContext {
  record: UnknownRecord;
  ancestors: UnknownRecord[];
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function firstString(record: UnknownRecord, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = nonEmptyString(record[key]);
    if (value) return value;
  }
  return null;
}

function responseRoots(value: unknown): unknown[] {
  const envelope = asRecord(value);
  if (!envelope) throw new Error("Merchant UCP returned an invalid response");
  const error = asRecord(envelope.error);
  if (error) {
    const code =
      typeof error.code === "string" || typeof error.code === "number"
        ? String(error.code)
        : "unknown";
    throw new Error(`Merchant UCP request failed (${code})`);
  }
  const result = asRecord(envelope.result) ?? envelope;
  const roots: unknown[] = [];
  if (result.structuredContent !== undefined) {
    roots.push(result.structuredContent);
  }
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      const content = asRecord(item);
      const text = content && nonEmptyString(content.text);
      if (!text) continue;
      try {
        roots.push(JSON.parse(text) as unknown);
      } catch {
        // Human-readable MCP content is not authoritative product data.
      }
    }
  }
  if (roots.length === 0) roots.push(result);
  return roots;
}

function collectRecordContexts(value: unknown): RecordContext[] {
  const contexts: RecordContext[] = [];
  const seen = new Set<object>();
  function visit(current: unknown, ancestors: UnknownRecord[]): void {
    if (!current || typeof current !== "object" || seen.has(current as object)) {
      return;
    }
    seen.add(current as object);
    if (Array.isArray(current)) {
      for (const item of current) visit(item, ancestors);
      return;
    }
    const record = current as UnknownRecord;
    contexts.push({ record, ancestors });
    const nextAncestors = [...ancestors, record];
    for (const child of Object.values(record)) visit(child, nextAncestors);
  }
  visit(value, []);
  return contexts;
}

function contextChain(context: RecordContext): UnknownRecord[] {
  return [context.record, ...[...context.ancestors].reverse()];
}

function firstContextString(
  contexts: UnknownRecord[],
  ...keys: string[]
): string | null {
  for (const context of contexts) {
    const value = firstString(context, ...keys);
    if (value) return value;
  }
  return null;
}

function firstNestedStringByKey(
  value: unknown,
  keys: ReadonlySet<string>,
  depth = 0,
): string | null {
  if (depth > 4) return null;
  const record = asRecord(value);
  if (record) {
    for (const [key, child] of Object.entries(record)) {
      if (keys.has(key)) {
        const direct = nonEmptyString(child);
        if (direct) return direct;
      }
    }
    for (const child of Object.values(record)) {
      const nested = firstNestedStringByKey(child, keys, depth + 1);
      if (nested) return nested;
    }
  } else if (Array.isArray(value)) {
    for (const child of value) {
      const nested = firstNestedStringByKey(child, keys, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

function validatedImageUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      !MEDDU_IMAGE_HOSTS.has(url.hostname.toLowerCase())
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function validateMedduCheckoutUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Merchant UCP returned an invalid checkout URL");
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !MEDDU_CHECKOUT_HOSTS.has(host)
  ) {
    throw new Error("Merchant UCP returned an untrusted checkout URL");
  }
  if (!/^\/(?:cart|checkouts?|checkout)\b/i.test(url.pathname)) {
    throw new Error("Merchant UCP checkout URL does not target a checkout");
  }
  return url.toString();
}

function variantIdFrom(context: RecordContext): string | null {
  for (const record of contextChain(context)) {
    const explicit = firstString(record, "variant_id", "variantId");
    if (explicit) return explicit;
    const id = firstString(record, "id");
    if (id?.includes("/ProductVariant/")) return id;
  }
  return null;
}

function productIdFrom(contexts: UnknownRecord[]): string | null {
  for (const record of contexts) {
    const explicit = firstString(record, "product_id", "productId");
    if (explicit) return explicit;
    const id = firstString(record, "id");
    if (id?.includes("/Product/") && !id.includes("/ProductVariant/")) return id;
  }
  return null;
}

function availabilityFrom(contexts: UnknownRecord[]): boolean | null {
  for (const record of contexts) {
    for (const key of [
      "available",
      "available_for_sale",
      "availableForSale",
      "is_available",
      "in_stock",
    ]) {
      const value = record[key];
      if (typeof value === "boolean") return value;
    }
    const status = firstString(record, "availability", "stock_status");
    if (status) {
      if (/^(available|in[_ -]?stock)$/i.test(status)) return true;
      if (/^(unavailable|out[_ -]?of[_ -]?stock|sold[_ -]?out)$/i.test(status)) {
        return false;
      }
    }
  }
  return null;
}

function integerMinorAmount(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  return null;
}

function priceFrom(contexts: UnknownRecord[]): MerchantMoney | null {
  for (const record of contexts) {
    for (const key of ["price", "unit_price", "unitPrice"]) {
      const raw = record[key];
      let amount = integerMinorAmount(raw);
      const nested = asRecord(raw);
      if (nested) {
        amount =
          integerMinorAmount(nested.amount) ??
          integerMinorAmount(nested.value) ??
          integerMinorAmount(nested.min);
      }
      if (amount === null || amount <= 0n) continue;
      const currency =
        (nested && firstString(nested, "currency", "currency_code")) ??
        firstContextString(contexts, "currency", "currency_code") ??
        "AED";
      if (currency.toUpperCase() !== "AED") continue;
      return {
        amount: `${amount / 100n}.${(amount % 100n)
          .toString()
          .padStart(2, "0")}`,
        currency: "AED",
        minorAmount: amount.toString(),
      };
    }
  }
  return null;
}

function meaningfulTitle(contexts: UnknownRecord[]): {
  title: string;
  variantTitle: string | null;
} {
  const variantTitle = firstString(
    contexts[0] ?? {},
    "variant_title",
    "variantTitle",
    "title",
    "name",
  );
  for (const context of contexts) {
    const explicit = firstString(context, "product_title", "productTitle");
    if (explicit) return { title: explicit, variantTitle };
    const id = firstString(context, "id", "product_id", "productId");
    if (id?.includes("/Product/") && !id.includes("/ProductVariant/")) {
      const title = firstString(context, "title", "name");
      if (title) return { title, variantTitle };
    }
  }
  for (const context of contexts) {
    const title = firstString(context, "title", "name");
    if (title && !/^default title$/i.test(title)) {
      return { title, variantTitle };
    }
  }
  return { title: "Travel essential", variantTitle };
}

function imageFrom(contexts: UnknownRecord[]): string | null {
  const imageKeys = new Set([
    "image_url",
    "imageUrl",
    "src",
    "original_src",
    "originalSource",
    "url",
  ]);
  for (const context of contexts) {
    const direct = validatedImageUrl(
      firstString(context, "image_url", "imageUrl", "featured_image"),
    );
    if (direct) return direct;
    for (const key of ["image", "images", "media", "featured_media"]) {
      const nested = validatedImageUrl(
        firstNestedStringByKey(context[key], imageKeys),
      );
      if (nested) return nested;
    }
  }
  return null;
}

function checkoutUrlFrom(contexts: UnknownRecord[]): string | null {
  const checkoutKeys = new Set(["checkout_url", "checkoutUrl", "continue_url"]);
  for (const context of contexts) {
    const candidate =
      firstString(context, "checkout_url", "checkoutUrl", "continue_url") ??
      firstNestedStringByKey(context, checkoutKeys);
    if (!candidate) continue;
    try {
      return validateMedduCheckoutUrl(candidate);
    } catch {
      // Keep searching. A malformed URL elsewhere in the envelope is not a product.
    }
  }
  return null;
}

/** Parse merchant search data without relying on a particular MCP envelope. */
export function parseMedduSearchResponse(
  response: unknown,
  input?: {
    endpoint?: string;
    retrievedAt?: string;
    capMinor?: bigint;
  },
): MedduOffer[] {
  const endpoint = input?.endpoint ?? MEDDU_MCP_URL;
  const retrievedAt = input?.retrievedAt ?? new Date().toISOString();
  const capMinor = input?.capMinor ?? DEFAULT_RECOVERY_CAP_MINOR;
  const byVariant = new Map<string, MedduOffer>();

  for (const root of responseRoots(response)) {
    for (const context of collectRecordContexts(root)) {
      const variantId = variantIdFrom(context);
      if (!variantId) continue;
      const contexts = contextChain(context);
      const available = availabilityFrom(contexts);
      const price = priceFrom(contexts);
      const imageUrl = imageFrom(contexts);
      const checkoutUrl = checkoutUrlFrom(contexts);
      if (
        available !== true ||
        !price ||
        BigInt(price.minorAmount) > capMinor ||
        !imageUrl ||
        !checkoutUrl
      ) {
        continue;
      }
      const titles = meaningfulTitle(contexts);
      const description =
        firstContextString(contexts, "description", "summary") ?? titles.title;
      const offer: MedduOffer = {
        merchant: MEDDU_MERCHANT,
        productId: productIdFrom(contexts),
        variantId,
        title: titles.title,
        variantTitle: titles.variantTitle,
        description,
        available: true,
        imageUrl,
        checkoutUrl,
        price,
        provenance: {
          source: "merchant_ucp",
          merchantDomain: MEDDU_MERCHANT.domain,
          endpoint,
          retrievedAt,
        },
      };
      const existing = byVariant.get(variantId);
      if (!existing || BigInt(price.minorAmount) < BigInt(existing.price.minorAmount)) {
        byVariant.set(variantId, offer);
      }
    }
  }

  return [...byVariant.values()].sort((left, right) => {
    const priceOrder =
      BigInt(left.price.minorAmount) < BigInt(right.price.minorAmount)
        ? -1
        : BigInt(left.price.minorAmount) > BigInt(right.price.minorAmount)
          ? 1
          : 0;
    return priceOrder || left.variantId.localeCompare(right.variantId);
  });
}

function requireText(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`Merchant checkout requires ${label}`);
  return trimmed;
}

function normalizedBuyer(buyer: MerchantBuyer): MerchantBuyer {
  const email = requireText(buyer.email, "buyer email").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Merchant checkout requires a valid buyer email");
  }
  const hostname = email.slice(email.lastIndexOf("@") + 1);
  const topLevelDomain = hostname.split(".").at(-1) ?? "";
  if (!ROUTABLE_EMAIL_TLDS.has(topLevelDomain)) {
    throw new Error("Merchant checkout requires an email on a routable domain");
  }
  return {
    email,
    firstName: requireText(buyer.firstName, "buyer first name"),
    lastName: requireText(buyer.lastName, "buyer last name"),
    ...(buyer.phone?.trim() ? { phone: buyer.phone.trim() } : {}),
  };
}

function normalizedAddress(
  address: MerchantShippingAddress,
): MerchantShippingAddress {
  if (address.addressCountry !== "AE") {
    throw new Error("Meddu checkout requires a UAE address");
  }
  return {
    firstName: requireText(address.firstName, "shipping first name"),
    lastName: requireText(address.lastName, "shipping last name"),
    streetAddress: requireText(address.streetAddress, "street address"),
    addressLocality: requireText(address.addressLocality, "address locality"),
    addressRegion: requireText(address.addressRegion, "address region"),
    addressCountry: "AE",
    ...(address.postalCode?.trim()
      ? { postalCode: address.postalCode.trim() }
      : {}),
    ...(address.extendedAddress?.trim()
      ? { extendedAddress: address.extendedAddress.trim() }
      : {}),
    ...(address.phone?.trim() ? { phone: address.phone.trim() } : {}),
  };
}

function extractCheckoutRecord(response: unknown): UnknownRecord {
  for (const root of responseRoots(response)) {
    const record = asRecord(root);
    if (record && firstString(record, "continue_url", "checkout_url")) return record;
    for (const context of collectRecordContexts(root)) {
      if (firstString(context.record, "continue_url", "checkout_url")) {
        return context.record;
      }
    }
  }
  throw new Error("Merchant UCP checkout omitted its continuation URL");
}

function checkoutTotal(record: UnknownRecord): MerchantMoney | null {
  const currency = (firstString(record, "currency", "currency_code") ?? "AED")
    .toUpperCase();
  if (currency !== "AED") return null;
  const totals = Array.isArray(record.totals) ? record.totals : [];
  const totalRecord = totals
    .map(asRecord)
    .find((candidate) =>
      /^(?:total|grand_total|amount_due)$/i.test(
        candidate ? firstString(candidate, "type", "name", "code") ?? "" : "",
      ),
    );
  const direct =
    (totalRecord &&
      (integerMinorAmount(totalRecord.amount) ??
        integerMinorAmount(totalRecord.value))) ??
    integerMinorAmount(record.total_amount) ??
    integerMinorAmount(record.total);
  if (direct === null || direct <= 0n) return null;
  return {
    amount: `${direct / 100n}.${(direct % 100n).toString().padStart(2, "0")}`,
    currency: "AED",
    minorAmount: direct.toString(),
  };
}

async function ucpCall(input: {
  endpoint: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  name: string;
  arguments: UnknownRecord;
  accessToken?: string;
}): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (input.accessToken?.trim()) {
    headers.Authorization = `Bearer ${input.accessToken.trim()}`;
  }
  const response = await input.fetchImpl(input.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `tavra-${input.name}`,
      method: "tools/call",
      params: { name: input.name, arguments: input.arguments },
    }),
    signal: AbortSignal.timeout(input.timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Merchant UCP request failed with HTTP ${response.status}`);
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new Error("Merchant UCP returned invalid JSON");
  }
}

export function prepareCatalogCheckout(
  offer: MedduOffer,
  now: () => Date = () => new Date(),
): PreparedMerchantCheckout {
  return {
    merchant: MEDDU_MERCHANT,
    offer: structuredClone(offer),
    checkoutUrl: validateMedduCheckoutUrl(offer.checkoutUrl),
    checkoutId: null,
    status: "catalog_ready",
    total: null,
    source: "ucp_catalog_checkout_url",
    preparedAt: now().toISOString(),
  };
}

export function createMedduUcpClient(
  options: MedduUcpClientOptions = {},
): MedduUcpClient {
  const endpoint = options.endpoint ?? MEDDU_MCP_URL;
  const endpointUrl = new URL(endpoint);
  if (endpointUrl.protocol !== "https:" && endpointUrl.hostname !== "localhost") {
    throw new Error("Merchant UCP endpoint must use HTTPS");
  }
  const fetchImpl = options.fetch ?? fetch;
  const agentProfile = options.agentProfile ?? SHOPIFY_PUBLIC_AGENT_PROFILE;
  const now = options.now ?? (() => new Date());
  const timeoutMs = Math.max(1, options.timeoutMs ?? 15_000);

  async function createCheckoutDraft(input: {
    offer: MedduOffer;
    buyer: MerchantBuyer;
    shippingAddress: MerchantShippingAddress;
    idempotencyKey: string;
    accessToken?: string;
  }): Promise<PreparedMerchantCheckout> {
      const buyer = normalizedBuyer(input.buyer);
      const address = normalizedAddress(input.shippingAddress);
      const idempotencyKey = requireText(input.idempotencyKey, "idempotency key");
      const response = await ucpCall({
        endpoint,
        fetchImpl,
        timeoutMs,
        name: "create_checkout",
        accessToken: input.accessToken,
        arguments: {
          meta: {
            "ucp-agent": { profile: agentProfile },
            "idempotency-key": idempotencyKey,
          },
          checkout: {
            currency: input.offer.price.currency,
            line_items: [
              {
                quantity: 1,
                item: { id: input.offer.variantId },
              },
            ],
            buyer: {
              email: buyer.email,
              first_name: buyer.firstName,
              last_name: buyer.lastName,
              ...(buyer.phone ? { phone_number: buyer.phone } : {}),
            },
            fulfillment: {
              methods: [
                {
                  type: "shipping",
                  destinations: [
                    {
                      first_name: address.firstName,
                      last_name: address.lastName,
                      street_address: address.streetAddress,
                      address_locality: address.addressLocality,
                      address_region: address.addressRegion,
                      address_country: address.addressCountry,
                      ...(address.postalCode
                        ? { postal_code: address.postalCode }
                        : {}),
                      ...(address.extendedAddress
                        ? { extended_address: address.extendedAddress }
                        : {}),
                      ...(address.phone ? { phone_number: address.phone } : {}),
                    },
                  ],
                },
              ],
            },
          },
        },
      });
      const record = extractCheckoutRecord(response);
      const checkoutUrl = validateMedduCheckoutUrl(
        firstString(record, "continue_url", "checkout_url") ?? "",
      );
      return {
        merchant: MEDDU_MERCHANT,
        offer: structuredClone(input.offer),
        checkoutUrl,
        checkoutId: firstString(record, "id", "checkout_id"),
        status: firstString(record, "status") ?? "incomplete",
        total: checkoutTotal(record),
        source: "ucp_checkout",
        preparedAt: now().toISOString(),
      };
  }

  return {
    async discoverRecoveryOffer(input = {}) {
      const requestedQuery = input.query?.trim();
      const queries = [...new Set([
        requestedQuery || "travel toiletries toothpaste face wash",
        "travel toiletries toothpaste face wash",
        "travel-size toothpaste",
        "toothpaste",
      ])];
      for (const query of queries) {
        const response = await ucpCall({
          endpoint,
          fetchImpl,
          timeoutMs,
          name: "search_catalog",
          arguments: {
            meta: { "ucp-agent": { profile: agentProfile } },
            catalog: {
              query,
              context: {
                address_country: "AE",
                intent: "replacement travel essential for delayed baggage",
              },
              pagination: { limit: 20 },
            },
          },
        });
        const offers = parseMedduSearchResponse(response, {
          endpoint,
          retrievedAt: now().toISOString(),
          capMinor: input.capMinor,
        });
        const selected = offers[0];
        if (selected) return selected;
      }
      throw new Error(
        "Meddu returned no available travel essential with an exact trusted image and checkout under the spend cap",
      );
    },

    createCheckout: createCheckoutDraft,
    createCheckoutDraft,
  };
}

/** Stable application-facing name for the current reviewed sandbox merchant. */
export type SandboxMerchantCatalog = MedduUcpClient;
export const createSandboxMerchantCatalog = createMedduUcpClient;

/** @deprecated Use the Meddu names. Retained for callers compiled before the reviewed-merchant switch. */
export const DAR_AL_EMIRATES_MCP_URL = MEDDU_MCP_URL;
/** @deprecated Use `MEDDU_MERCHANT`. */
export const DAR_AL_EMIRATES_MERCHANT = MEDDU_MERCHANT;
/** @deprecated Use `MedduOffer`. */
export type DarAlEmiratesOffer = MedduOffer;
/** @deprecated Use `MedduUcpClientOptions`. */
export type DarAlEmiratesUcpClientOptions = MedduUcpClientOptions;
/** @deprecated Use `MedduUcpClient`. */
export type DarAlEmiratesUcpClient = MedduUcpClient;
/** @deprecated Use `validateMedduCheckoutUrl`. */
export const validateDarAlEmiratesCheckoutUrl = validateMedduCheckoutUrl;
/** @deprecated Use `parseMedduSearchResponse`. */
export const parseDarAlEmiratesSearchResponse = parseMedduSearchResponse;
/** @deprecated Use `createMedduUcpClient`. */
export const createDarAlEmiratesUcpClient = createMedduUcpClient;

export interface TransientMerchantCard {
  token: string;
  dynamicCvv: string;
  expiryMonth: string;
  expiryYear: string;
}

export type SandboxMerchantDeclineReason =
  | "insufficient_funds"
  | "test_card"
  | "merchant_declined";

interface BrowserAttemptEvidence {
  merchant: typeof MEDDU_MERCHANT;
  checkoutHost: string;
  attemptedAt: string;
  /** Proves a merchant submission occurred without exposing payment data. */
  paymentSubmitted: boolean;
}

export type SandboxMerchantAttemptResult =
  | (BrowserAttemptEvidence & {
      status: "expected_decline";
      reason: SandboxMerchantDeclineReason;
      responseCode: "sandbox_expected_decline";
      /** A bounded, redacted message observed on the merchant checkout. */
      message?: string;
    })
  | (BrowserAttemptEvidence & {
      status: "declined";
      reason: "merchant_declined";
      responseCode: "merchant_declined";
      /** A bounded, redacted message observed on the merchant checkout. */
      message: string;
    })
  | (BrowserAttemptEvidence & {
      status: "approved";
      orderId: string | null;
      responseCode: "merchant_approved";
    })
  | (BrowserAttemptEvidence & {
      status: "failed_pre_submit";
      code: "invalid_request" | "checkout_unavailable" | "payment_form_unavailable";
      message: string;
    })
  | (BrowserAttemptEvidence & {
      status: "reconciliation_required";
      message: string;
    });

export interface SandboxMerchantPaymentRequest {
  idempotencyKey: string;
  checkout: PreparedMerchantCheckout;
  buyer: MerchantBuyer;
  shippingAddress: MerchantShippingAddress;
  credential: TransientMerchantCard;
  /** Exact address-aware UCP checkout total approved by the buyer and Prava. */
  expectedTotal: MerchantMoney;
}

export interface SandboxMerchantBrowserExecutor {
  attempt(
    request: SandboxMerchantPaymentRequest,
  ): Promise<SandboxMerchantAttemptResult>;
}

interface LocatorLike {
  count(): Promise<number>;
  nth(index: number): LocatorLike;
  isVisible(): Promise<boolean>;
  fill(value: string): Promise<void>;
  selectOption(value: string): Promise<unknown>;
  click(options?: { timeout?: number }): Promise<void>;
  textContent(): Promise<string | null>;
}

interface FrameLike {
  locator(selector: string): LocatorLike;
}

interface PageLike extends FrameLike {
  goto(
    url: string,
    options: { waitUntil: "domcontentloaded"; timeout: number },
  ): Promise<unknown>;
  frames(): FrameLike[];
  getByRole(
    role: "button",
    options: { name: RegExp },
  ): LocatorLike;
  waitForTimeout(milliseconds: number): Promise<void>;
  url(): string;
}

interface BrowserContextLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

interface BrowserLike {
  newContext(options: {
    locale: string;
    recordVideo?: undefined;
  }): Promise<BrowserContextLike>;
  close(): Promise<void>;
}

interface PlaywrightLike {
  chromium: {
    launch(options: { headless: true }): Promise<BrowserLike>;
  };
}

export interface PlaywrightShopifyExecutorOptions {
  now?: () => Date;
  navigationTimeoutMs?: number;
  postSubmitWaitMs?: number;
  /** Test seam. Production uses a dynamic import and keeps Playwright server-only. */
  loadPlaywright?: () => Promise<PlaywrightLike>;
}

function validCredential(credential: TransientMerchantCard): boolean {
  return (
    /^\d{12,19}$/.test(credential.token) &&
    /^\d{3,4}$/.test(credential.dynamicCvv) &&
    /^(?:0?[1-9]|1[0-2])$/.test(credential.expiryMonth) &&
    /^\d{2}(?:\d{2})?$/.test(credential.expiryYear)
  );
}

async function firstVisible(
  roots: FrameLike[],
  selectors: readonly string[],
): Promise<LocatorLike | null> {
  for (const root of roots) {
    for (const selector of selectors) {
      const locator = root.locator(selector);
      const count = await locator.count();
      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        if (await candidate.isVisible()) return candidate;
      }
    }
  }
  return null;
}

async function fillOptional(
  roots: FrameLike[],
  selectors: readonly string[],
  value: string | undefined,
): Promise<boolean> {
  if (!value) return false;
  const locator = await firstVisible(roots, selectors);
  if (!locator) return false;
  await locator.fill(value);
  return true;
}

async function fillRequired(
  roots: FrameLike[],
  selectors: readonly string[],
  value: string,
): Promise<void> {
  const locator = await firstVisible(roots, selectors);
  if (!locator) throw new Error("required_payment_field_missing");
  await locator.fill(value);
}

async function selectOptional(
  roots: FrameLike[],
  selectors: readonly string[],
  value: string,
): Promise<void> {
  const locator = await firstVisible(roots, selectors);
  if (locator) await locator.selectOption(value);
}

function redactPaymentDetails(value: string): string {
  return value
    .replace(/\b(?:\d[ -]?){11,18}\d\b/g, "[redacted card]")
    .replace(
      /\b(?:dynamic[ _-]?cvv|cvv|cvc|security code)\s*[:=#-]?\s*\d{3,4}\b/gi,
      "[redacted security code]",
    );
}

function visibleProcessorMessage(text: string, pattern: RegExp): string {
  const lines = text
    .split(/[\r\n]+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const line = lines.find((candidate) => pattern.test(candidate));
  const source = line ?? text.replace(/\s+/g, " ").trim();
  const match = source.match(pattern);
  if (!match || match.index === undefined) return "Merchant payment was declined";
  const start = Math.max(0, match.index - 80);
  const end = Math.min(source.length, match.index + match[0].length + 120);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < source.length ? "..." : "";
  return redactPaymentDetails(`${prefix}${source.slice(start, end)}${suffix}`)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 260);
}

export function classifyShopifyPaymentOutcome(text: string):
  | {
      status: "expected_decline";
      reason: "insufficient_funds" | "test_card";
      message: string;
    }
  | { status: "declined"; reason: "merchant_declined"; message: string }
  | { status: "approved"; orderId: string | null }
  | { status: "unknown" } {
  const normalized = text.replace(/\s+/g, " ").trim();
  const insufficientFunds = /insufficient (?:funds|balance)/i;
  if (insufficientFunds.test(normalized)) {
    return {
      status: "expected_decline",
      reason: "insufficient_funds",
      message: visibleProcessorMessage(text, insufficientFunds),
    };
  }
  const testCredential = /test card|test payment|sandbox card/i;
  if (testCredential.test(normalized)) {
    return {
      status: "expected_decline",
      reason: "test_card",
      message: visibleProcessorMessage(text, testCredential),
    };
  }
  const genericDecline =
    /card (?:was |has been )?declined|payment (?:was |has been )?(?:declined|failed)|could(?: not|n't) process (?:the )?payment|card (?:is )?not accepted/i;
  if (genericDecline.test(normalized)) {
    return {
      status: "declined",
      reason: "merchant_declined",
      message: visibleProcessorMessage(text, genericDecline),
    };
  }
  if (/thank you for your (?:purchase|order)|order (?:is )?confirmed/i.test(normalized)) {
    const order = normalized.match(/(?:order|confirmation)\s*#?\s*([A-Z0-9-]{4,})/i);
    return { status: "approved", orderId: order?.[1] ?? null };
  }
  return { status: "unknown" };
}

function aedMinorAmountsFromText(text: string): bigint[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  const expressions = [
    /(?:AED|Dhs?\.?|د\.?إ\.?)\s*((?:\d{1,3}(?:,\d{3})+|\d+))(?:\.(\d{1,2}))?/gi,
    /((?:\d{1,3}(?:,\d{3})+|\d+))(?:\.(\d{1,2}))?\s*(?:AED|Dhs?\.?|د\.?إ\.?)/gi,
  ];
  const amounts = new Set<bigint>();
  for (const expression of expressions) {
    for (const match of normalized.matchAll(expression)) {
      const whole = match[1]?.replace(/,/g, "") ?? "";
      const fraction = (match[2] ?? "").padEnd(2, "0");
      if (/^\d+$/.test(whole) && /^\d{2}$/.test(fraction)) {
        amounts.add(BigInt(whole) * 100n + BigInt(fraction));
      }
    }
  }
  return [...amounts];
}

type AuthoritativeCheckoutTotal =
  | { status: "verified"; minorAmount: bigint }
  | { status: "missing" | "ambiguous" };

async function authoritativeCheckoutTotal(
  page: PageLike,
): Promise<AuthoritativeCheckoutTotal> {
  const selectors = [
    "[data-checkout-payment-due-target]",
    '[data-testid="payment-due"]',
    '[data-testid="total-price"]',
    '[data-testid="updated-total-price"]',
    ".payment-due__price",
    '[aria-label="Total"]',
    '[aria-label^="Updated total price"]',
    'div[role="row"]:has(div[role="rowheader"] :text-is("Total")) div[role="cell"]',
    'div[role="row"]:has(div[role="rowheader"] :text-is("Updated total")) div[role="cell"]',
    'div[role="row"]:has(div[role="rowheader"] :text-is("Updated total price")) div[role="cell"]',
  ] as const;
  const observed = new Set<bigint>();
  let ambiguousText = false;
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (!(await candidate.isVisible())) continue;
      const text = await candidate.textContent();
      if (!text) continue;
      const amounts = aedMinorAmountsFromText(text);
      if (amounts.length > 1) ambiguousText = true;
      for (const amount of amounts) observed.add(amount);
    }
  }
  if (ambiguousText || observed.size > 1) return { status: "ambiguous" };
  const minorAmount = [...observed][0];
  return minorAmount === undefined
    ? { status: "missing" }
    : { status: "verified", minorAmount };
}

async function checkoutOutcomeText(page: PageLike): Promise<string> {
  const parts: string[] = [];
  for (const root of [page, ...page.frames()]) {
    const bodies = root.locator("body");
    const count = await bodies.count();
    for (let index = 0; index < count; index += 1) {
      const body = bodies.nth(index);
      if (!(await body.isVisible())) continue;
      const text = await body.textContent();
      if (text?.trim()) parts.push(text);
    }
  }
  return parts.join("\n");
}

async function dynamicPlaywrightImport(): Promise<PlaywrightLike> {
  const packageName = "playwright";
  return (await import(packageName)) as unknown as PlaywrightLike;
}

/**
 * Executes one payment submission at the real Shopify merchant. The browser is
 * ephemeral: no screenshots, traces, recordings, storage state, or card data
 * are persisted. A post-submit unknown outcome always requires reconciliation.
 */
export function createPlaywrightShopifyBrowserExecutor(
  options: PlaywrightShopifyExecutorOptions = {},
): SandboxMerchantBrowserExecutor {
  const now = options.now ?? (() => new Date());
  const navigationTimeoutMs = Math.max(1, options.navigationTimeoutMs ?? 25_000);
  const postSubmitWaitMs = Math.max(1, options.postSubmitWaitMs ?? 8_000);
  const loadPlaywright = options.loadPlaywright ?? dynamicPlaywrightImport;
  const attempts = new Map<
    string,
    Promise<SandboxMerchantAttemptResult>
  >();

  return {
    attempt(request) {
      const key = request.idempotencyKey.trim();
      const existing = attempts.get(key);
      if (existing) return existing;

      const attemptPromise = (async (): Promise<SandboxMerchantAttemptResult> => {
        const attemptedAt = now().toISOString();
        let checkoutHost: string = MEDDU_MERCHANT.domain;
        let paymentSubmitted = false;
        let browser: BrowserLike | null = null;
        let context: BrowserContextLike | null = null;
        try {
          if (!key || !validCredential(request.credential)) {
            return {
              status: "failed_pre_submit",
              code: "invalid_request",
              message: "The merchant attempt did not receive a valid checkout request",
              merchant: MEDDU_MERCHANT,
              checkoutHost,
              attemptedAt,
              paymentSubmitted,
            };
          }
          const buyer = normalizedBuyer(request.buyer);
          const address = normalizedAddress(request.shippingAddress);
          const checkoutUrl = validateMedduCheckoutUrl(
            request.checkout.checkoutUrl,
          );
          checkoutHost = new URL(checkoutUrl).hostname.toLowerCase();
          const playwright = await loadPlaywright();
          browser = await playwright.chromium.launch({ headless: true });
          context = await browser.newContext({
            locale: "en-AE",
            recordVideo: undefined,
          });
          const page = await context.newPage();
          await page.goto(checkoutUrl, {
            waitUntil: "domcontentloaded",
            timeout: navigationTimeoutMs,
          });
          const pageRoots: FrameLike[] = [page];
          await fillOptional(
            pageRoots,
            [
              'input[name="email"]',
              'input[name="checkout[email]"]',
              'input[autocomplete="email"]',
            ],
            buyer.email,
          );
          await fillOptional(
            pageRoots,
            [
              'input[name="firstName"]',
              'input[name="checkout[shipping_address][first_name]"]',
              'input[autocomplete="given-name"]',
            ],
            address.firstName,
          );
          await fillOptional(
            pageRoots,
            [
              'input[name="lastName"]',
              'input[name="checkout[shipping_address][last_name]"]',
              'input[autocomplete="family-name"]',
            ],
            address.lastName,
          );
          await fillOptional(
            pageRoots,
            [
              'input[name="address1"]',
              'input[name="checkout[shipping_address][address1]"]',
              'input[autocomplete="address-line1"]',
            ],
            address.streetAddress,
          );
          await fillOptional(
            pageRoots,
            [
              'input[name="address2"]',
              'input[name="checkout[shipping_address][address2]"]',
              'input[autocomplete="address-line2"]',
            ],
            address.extendedAddress,
          );
          await fillOptional(
            pageRoots,
            [
              'input[name="city"]',
              'input[name="checkout[shipping_address][city]"]',
              'input[autocomplete="address-level2"]',
            ],
            address.addressLocality,
          );
          await fillOptional(
            pageRoots,
            [
              'input[name="postalCode"]',
              'input[name="checkout[shipping_address][zip]"]',
              'input[autocomplete="postal-code"]',
            ],
            address.postalCode,
          );
          await fillOptional(
            pageRoots,
            [
              'input[name="phone"]',
              'input[name="checkout[shipping_address][phone]"]',
              'input[autocomplete="tel"]',
            ],
            address.phone ?? buyer.phone,
          );
          await selectOptional(
            pageRoots,
            [
              'select[name="countryCode"]',
              'select[name="checkout[shipping_address][country]"]',
              'select[autocomplete="country"]',
            ],
            "AE",
          );

          for (let step = 0; step < 2; step += 1) {
            const continueButton = page.getByRole("button", {
              name: /continue to (?:shipping|payment)|continue/i,
            });
            if (
              (await continueButton.count()) === 0 ||
              !(await continueButton.nth(0).isVisible())
            ) {
              break;
            }
            await continueButton.nth(0).click({ timeout: navigationTimeoutMs });
            await page.waitForTimeout(750);
          }

          const roots: FrameLike[] = [page, ...page.frames()];
          await fillRequired(
            roots,
            [
              'input[name="number"]',
              'input[id="number"]',
              'input[autocomplete="cc-number"]',
            ],
            request.credential.token,
          );
          const month = request.credential.expiryMonth.padStart(2, "0");
          const year = request.credential.expiryYear.slice(-2);
          await fillRequired(
            roots,
            [
              'input[name="expiry"]',
              'input[id="expiry"]',
              'input[autocomplete="cc-exp"]',
            ],
            `${month}/${year}`,
          );
          await fillRequired(
            roots,
            [
              'input[name="verification_value"]',
              'input[id="verification_value"]',
              'input[autocomplete="cc-csc"]',
            ],
            request.credential.dynamicCvv,
          );
          await fillOptional(
            roots,
            [
              'input[name="name"]',
              'input[id="name"]',
              'input[autocomplete="cc-name"]',
            ],
            `${buyer.firstName} ${buyer.lastName}`,
          );

          const approvedMinor = BigInt(request.expectedTotal.minorAmount);
          const merchantTotal = await authoritativeCheckoutTotal(page);
          if (
            merchantTotal.status !== "verified" ||
            merchantTotal.minorAmount !== approvedMinor
          ) {
            return {
              status: "failed_pre_submit",
              code: "checkout_unavailable",
              message:
                merchantTotal.status === "missing"
                  ? "The merchant final total could not be verified"
                  : merchantTotal.status === "ambiguous"
                    ? "The merchant checkout showed ambiguous final totals"
                    : "The merchant total did not match the approved amount",
              merchant: MEDDU_MERCHANT,
              checkoutHost,
              attemptedAt,
              paymentSubmitted,
            };
          }

          const payButton = page.getByRole("button", {
            name: /pay now|complete order|place order|submit payment/i,
          });
          if ((await payButton.count()) === 0 || !(await payButton.nth(0).isVisible())) {
            return {
              status: "failed_pre_submit",
              code: "payment_form_unavailable",
              message: "The merchant payment action was unavailable",
              merchant: MEDDU_MERCHANT,
              checkoutHost,
              attemptedAt,
              paymentSubmitted,
            };
          }
          paymentSubmitted = true;
          await payButton.nth(0).click({ timeout: navigationTimeoutMs });
          await page.waitForTimeout(postSubmitWaitMs);
          const outcomeText = await checkoutOutcomeText(page);
          const outcome = classifyShopifyPaymentOutcome(outcomeText);
          if (outcome.status === "expected_decline") {
            return {
              status: "expected_decline",
              reason: outcome.reason,
              responseCode: "sandbox_expected_decline",
              message: outcome.message,
              merchant: MEDDU_MERCHANT,
              checkoutHost,
              attemptedAt,
              paymentSubmitted,
            };
          }
          if (outcome.status === "declined") {
            return {
              status: "declined",
              reason: outcome.reason,
              responseCode: "merchant_declined",
              message: outcome.message,
              merchant: MEDDU_MERCHANT,
              checkoutHost,
              attemptedAt,
              paymentSubmitted,
            };
          }
          if (outcome.status === "approved") {
            return {
              status: "approved",
              orderId: outcome.orderId,
              responseCode: "merchant_approved",
              merchant: MEDDU_MERCHANT,
              checkoutHost,
              attemptedAt,
              paymentSubmitted,
            };
          }
          return {
            status: "reconciliation_required",
            message:
              "The merchant received the payment submission, but its final outcome was not observable",
            merchant: MEDDU_MERCHANT,
            checkoutHost,
            attemptedAt,
            paymentSubmitted,
          };
        } catch (error) {
          const paymentFieldMissing =
            error instanceof Error && error.message === "required_payment_field_missing";
          if (paymentSubmitted) {
            return {
              status: "reconciliation_required",
              message:
                "The merchant may have received the payment submission; the outcome requires reconciliation",
              merchant: MEDDU_MERCHANT,
              checkoutHost,
              attemptedAt,
              paymentSubmitted,
            };
          }
          return {
            status: "failed_pre_submit",
            code: paymentFieldMissing
              ? "payment_form_unavailable"
              : "checkout_unavailable",
            message: paymentFieldMissing
              ? "The merchant payment fields were unavailable"
              : "The merchant checkout could not be prepared",
            merchant: MEDDU_MERCHANT,
            checkoutHost,
            attemptedAt,
            paymentSubmitted,
          };
        } finally {
          await context?.close().catch(() => undefined);
          await browser?.close().catch(() => undefined);
        }
      })();
      attempts.set(key, attemptPromise);
      return attemptPromise;
    },
  };
}
