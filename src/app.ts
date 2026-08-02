import express, { type Request } from "express";
import { lookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { resolve } from "node:path";
import type LinqAPIV3 from "@linqapp/sdk";
import { Agent, type Dispatcher } from "undici";

import type { ServerConfig } from "./config.js";
import type { TavraLinqWebhookEvent } from "./linq-events.js";
import { unwrapLinqWebhook } from "./linq.js";
import type { MessageReplyResult } from "./message-reply.js";
import type { PravaCheckoutService } from "./prava.js";
import { DEMO_PRODUCT_MEDIA_ASSETS } from "./product-media.js";
import type {
  LiveCommerceService,
  LiveCommerceWorkflowPayload,
} from "./live-commerce.js";
import type { CheckoutWorkflowSnapshot } from "./checkout-state-store.js";

const demoProductImageFilenames = new Map<string, string>(
  DEMO_PRODUCT_MEDIA_ASSETS.map((asset) => [asset.productRef, asset.assetFilename]),
);

const MAX_PRODUCT_IMAGE_BYTES = 8 * 1024 * 1024;
const SAFE_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const MAX_PRODUCT_IMAGE_DIMENSION = 8_192;
const MAX_PRODUCT_IMAGE_PIXELS = 20_000_000;
const MAX_CONCURRENT_PRODUCT_IMAGES = 6;
const PRODUCT_IMAGE_CACHE_TTL_MS = 10 * 60_000;
const MAX_PRODUCT_IMAGE_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_PRODUCT_IMAGE_CACHE_ENTRIES = 16;
const PRODUCT_IMAGE_RATE_WINDOW_MS = 60_000;
const MAX_PRODUCT_IMAGE_REQUESTS_PER_WINDOW = 30;
const MAX_PRODUCT_IMAGE_RATE_BUCKETS = 1_024;
const ACTIVE_CHECKOUT_DETAIL_GRACE_MS = 15 * 60_000;
const ACTIVE_CHECKOUT_DETAIL_RETENTION_MS = 24 * 60 * 60_000;
const TERMINAL_CHECKOUT_DETAIL_RETENTION_MS = 7 * 24 * 60 * 60_000;
const TERMINAL_CHECKOUT_STATUS_RETENTION_MS = 30 * 24 * 60 * 60_000;

const blockedImageAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedImageAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedImageAddresses.addSubnet(network, prefix, "ipv6");
}

interface ResolvedImageAddress {
  address: string;
  family: 4 | 6;
}

interface CachedProductImage {
  bytes: Buffer;
  contentType: string;
  cachedAt: number;
}

function isTerminalLiveWorkflow(
  snapshot: CheckoutWorkflowSnapshot<LiveCommerceWorkflowPayload>,
): boolean {
  return (
    snapshot.state === "order_confirmed" ||
    snapshot.state === "failed" ||
    snapshot.state === "reconciliation_required" ||
    snapshot.state === "canceled"
  );
}

function liveWorkflowWithinRetention(
  snapshot: CheckoutWorkflowSnapshot<LiveCommerceWorkflowPayload>,
  capability: "details" | "status",
  nowMs: number,
): boolean {
  const updatedAt = Date.parse(snapshot.updatedAt);
  if (!Number.isFinite(updatedAt)) return false;
  if (isTerminalLiveWorkflow(snapshot)) {
    const retention =
      capability === "status"
        ? TERMINAL_CHECKOUT_STATUS_RETENTION_MS
        : TERMINAL_CHECKOUT_DETAIL_RETENTION_MS;
    return nowMs <= updatedAt + retention;
  }
  if (capability === "status") return true;
  const expiry =
    snapshot.payload.paymentSession?.expiresAt ?? snapshot.payload.quote?.expiresAt;
  const expiryAt = expiry ? Date.parse(expiry) : Number.NaN;
  return Number.isFinite(expiryAt)
    ? nowMs <= expiryAt + ACTIVE_CHECKOUT_DETAIL_GRACE_MS
    : nowMs <= updatedAt + ACTIVE_CHECKOUT_DETAIL_RETENTION_MS;
}

function safeCheckoutReference(value: string): string | undefined {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value) ? value : undefined;
}

function compactText(value: string, maximum: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maximum
    ? normalized
    : `${normalized.slice(0, maximum - 1).trimEnd()}…`;
}

function liveCheckoutSummary(
  snapshot: CheckoutWorkflowSnapshot<LiveCommerceWorkflowPayload>,
  publicBaseUrl: string,
) {
  const quote = snapshot.payload.quote;
  const paymentSession = snapshot.payload.paymentSession;
  if (!quote || !paymentSession) return null;
  const selection = snapshot.payload.selection;
  const offer = selection.offer;
  const imageSource = offer.imageUrl;
  const approvalUrl = new URL(
    `/pay/${encodeURIComponent(snapshot.checkoutId)}`,
    publicBaseUrl,
  ).toString();
  return {
    checkoutId: snapshot.checkoutId,
    approvalUrl,
    expiresAt: paymentSession.expiresAt,
    order: {
      description: compactText(`Recovery essential from ${offer.merchant.name}`, 240),
      totalAmount: quote.total.amount,
      currency: quote.total.currency,
      products: [
        {
          ...(safeCheckoutReference(offer.productId)
            ? { productRef: offer.productId }
            : {}),
          ...(safeCheckoutReference(offer.variantId)
            ? { variantRef: offer.variantId }
            : {}),
          description: compactText(offer.title || offer.description, 240),
          variant: compactText(
            Object.entries(offer.options)
              .map(([name, value]) => `${name} ${value}`)
              .join(" · ") || offer.description,
            160,
          ),
          options: Object.fromEntries(
            Object.entries(offer.options)
              .slice(0, 12)
              .map(([name, value]) => [
                compactText(name, 48),
                compactText(value, 96),
              ]),
          ),
          unitPrice: quote.subtotal.amount,
          quantity: 1,
          ...(imageSource
            ? {
                imageUrl: new URL(
                  `/api/prava/checkouts/${encodeURIComponent(snapshot.checkoutId)}/products/0/image`,
                  publicBaseUrl,
                ).toString(),
                imageAltText: compactText(`${offer.title} from ${offer.merchant.name}`, 300),
              }
            : {}),
        },
      ],
      merchant: {
        name: compactText(offer.merchant.name, 100),
        domain: offer.merchant.domain,
        ...(offer.merchant.country ? { countryCode: offer.merchant.country } : {}),
        provenance: "Prava UCP live merchant",
      },
      destination: {
        maskedLabel: compactText(snapshot.payload.request.address.summary, 180),
      },
      delivery: {
        label: compactText(quote.deliveryLabel ?? "Delivery timing not verified", 160),
        ...(quote.estimatedArrival
          ? { estimatedArrival: quote.estimatedArrival }
          : {}),
        verified: quote.deliveryEstimateVerified === true,
      },
      ...(snapshot.payload.request.employeeAllowance?.currency === quote.total.currency
        ? {
            allowance: {
              amount: snapshot.payload.request.employeeAllowance.amount,
              currency: snapshot.payload.request.employeeAllowance.currency,
            },
          }
        : {}),
      quote: {
        id: safeCheckoutReference(quote.quoteId),
        expiresAt: quote.expiresAt,
      },
      pricing: {
        subtotal: quote.subtotal.amount,
        shipping: quote.shipping.amount,
        tax: quote.tax.amount,
        total: quote.total.amount,
      },
    },
  };
}

function isSafeRemoteImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      /^127\./.test(hostname) ||
      /^10\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^169\.254\./.test(hostname) ||
      /^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname) ||
      (isIP(hostname) > 0 && !isPublicImageAddress(hostname))
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function isPublicImageAddress(address: string): boolean {
  const normalized = address.replace(/%.+$/, "").toLowerCase();
  const family = isIP(normalized);
  if (family === 4) {
    return !blockedImageAddresses.check(normalized, "ipv4");
  }
  if (family !== 6 || blockedImageAddresses.check(normalized, "ipv6")) {
    return false;
  }
  const firstHextet = Number.parseInt(normalized.split(":", 1)[0] || "0", 16);
  return firstHextet >= 0x2000 && firstHextet <= 0x3fff;
}

export async function resolvePublicImageAddress(
  hostname: string,
  resolver: (hostname: string) => Promise<readonly ResolvedImageAddress[]>,
): Promise<ResolvedImageAddress> {
  const addresses = await resolver(hostname);
  if (
    addresses.length === 0 ||
    addresses.some(
      ({ address, family }) =>
        (family !== 4 && family !== 6) || !isPublicImageAddress(address),
    )
  ) {
    throw new Error("Product image hostname did not resolve only to public addresses");
  }
  return addresses[0] as ResolvedImageAddress;
}

function pinnedImageAgent(
  expectedHostname: string,
  resolved: ResolvedImageAddress,
): Agent {
  const pinnedLookup: LookupFunction = (hostname, options, callback) => {
    if (hostname.toLowerCase() !== expectedHostname.toLowerCase()) {
      callback(new Error("Unexpected image hostname"), "", 0);
      return;
    }
    if (options.all) {
      callback(null, [resolved]);
      return;
    }
    callback(null, resolved.address, resolved.family);
  };
  return new Agent({ connect: { lookup: pinnedLookup } });
}

function imageDimensions(
  contentType: string,
  bytes: Buffer,
): { width: number; height: number } | null {
  if (contentType === "image/png") {
    if (
      bytes.length < 24 ||
      !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ) return null;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (contentType === "image/webp") {
    if (
      bytes.length < 30 ||
      bytes.toString("ascii", 0, 4) !== "RIFF" ||
      bytes.toString("ascii", 8, 12) !== "WEBP"
    ) return null;
    const kind = bytes.toString("ascii", 12, 16);
    if (kind === "VP8X") {
      return {
        width: 1 + bytes.readUIntLE(24, 3),
        height: 1 + bytes.readUIntLE(27, 3),
      };
    }
    if (kind === "VP8L" && bytes[20] === 0x2f) {
      const b1 = bytes[21] as number;
      const b2 = bytes[22] as number;
      const b3 = bytes[23] as number;
      const b4 = bytes[24] as number;
      return {
        width: 1 + (((b2 & 0x3f) << 8) | b1),
        height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | (b2 >> 6)),
      };
    }
    if (
      kind === "VP8 " &&
      bytes[23] === 0x9d &&
      bytes[24] === 0x01 &&
      bytes[25] === 0x2a
    ) {
      return {
        width: bytes.readUInt16LE(26) & 0x3fff,
        height: bytes.readUInt16LE(28) & 0x3fff,
      };
    }
    return null;
  }
  if (contentType === "image/jpeg") {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1] as number;
      offset += 2;
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        continue;
      }
      if (offset + 2 > bytes.length) return null;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return null;
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        if (length < 7) return null;
        return {
          height: bytes.readUInt16BE(offset + 3),
          width: bytes.readUInt16BE(offset + 5),
        };
      }
      offset += length;
    }
  }
  return null;
}

export function hasSafeImageDimensions(contentType: string, bytes: Buffer): boolean {
  const dimensions = imageDimensions(contentType, bytes);
  return Boolean(
    dimensions &&
      dimensions.width > 0 &&
      dimensions.height > 0 &&
      dimensions.width <= MAX_PRODUCT_IMAGE_DIMENSION &&
      dimensions.height <= MAX_PRODUCT_IMAGE_DIMENSION &&
      dimensions.width * dimensions.height <= MAX_PRODUCT_IMAGE_PIXELS,
  );
}

async function readLimitedResponseBody(
  response: Response,
  maximumBytes: number,
): Promise<Buffer> {
  if (!response.body) throw new Error("Image response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("Image exceeds Tavra's size limit");
        throw new Error("Image exceeds Tavra's size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new Error("Image response is empty");
  return Buffer.concat(chunks, total);
}

function headersFromRequest(request: Request): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") result[name] = value;
    else if (Array.isArray(value)) result[name] = value.join(",");
  }
  return result;
}

function publicPaymentFailure(
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): { code: string; message: string } {
  const source =
    error && typeof error === "object"
      ? (error as { code?: unknown; message?: unknown })
      : null;
  const rawCode =
    typeof source?.code === "string" ? source.code.trim() : fallbackCode;
  const rawMessage =
    typeof source?.message === "string"
      ? source.message.trim()
      : error instanceof Error
        ? error.message.trim()
        : fallbackMessage;
  const code = /^[A-Za-z0-9_.:-]{2,80}$/.test(rawCode)
    ? rawCode
    : fallbackCode;
  const message = (rawMessage || fallbackMessage)
    .replace(/\b(?:pk|sk)_(?:test|live)_[A-Za-z0-9_-]+\b/g, "[redacted-key]")
    .replace(/\b\d{12,19}\b/g, "[redacted-card]")
    .replace(/\b(?:dynamic[_ -]?cvv|cvv|security code)\s*[:=]?\s*\d{3,4}\b/gi, "[redacted-security-code]")
    .slice(0, 500);
  return { code, message };
}

export function createApp(options: {
  config: ServerConfig;
  client: LinqAPIV3;
  processEvent: (event: TavraLinqWebhookEvent) => Promise<MessageReplyResult>;
  prava?: PravaCheckoutService;
  liveCommerce?: LiveCommerceService;
  productImageFetch?: typeof fetch;
  productImageResolve?: (
    hostname: string,
  ) => Promise<readonly ResolvedImageAddress[]>;
  now?: () => Date;
  reimbursementPacketPath?: string;
}) {
  const app = express();
  let activeProductImageRequests = 0;
  const now = options.now ?? (() => new Date());
  const productImageCache = new Map<string, CachedProductImage>();
  let productImageCacheBytes = 0;
  const productImageRateBuckets = new Map<
    string,
    { startedAt: number; requests: number }
  >();

  function cachedProductImage(key: string, nowMs: number): CachedProductImage | null {
    const cached = productImageCache.get(key);
    if (!cached) return null;
    if (nowMs - cached.cachedAt > PRODUCT_IMAGE_CACHE_TTL_MS) {
      productImageCache.delete(key);
      productImageCacheBytes -= cached.bytes.byteLength;
      return null;
    }
    productImageCache.delete(key);
    productImageCache.set(key, cached);
    return cached;
  }

  function storeProductImage(key: string, image: CachedProductImage): void {
    const replaced = productImageCache.get(key);
    if (replaced) productImageCacheBytes -= replaced.bytes.byteLength;
    productImageCache.delete(key);
    productImageCache.set(key, image);
    productImageCacheBytes += image.bytes.byteLength;
    while (
      productImageCache.size > MAX_PRODUCT_IMAGE_CACHE_ENTRIES ||
      productImageCacheBytes > MAX_PRODUCT_IMAGE_CACHE_BYTES
    ) {
      const oldestKey = productImageCache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const oldest = productImageCache.get(oldestKey);
      productImageCache.delete(oldestKey);
      if (oldest) productImageCacheBytes -= oldest.bytes.byteLength;
    }
  }

  function allowProductImageRequest(checkoutId: string, nowMs: number): boolean {
    const current = productImageRateBuckets.get(checkoutId);
    if (!current || nowMs - current.startedAt >= PRODUCT_IMAGE_RATE_WINDOW_MS) {
      productImageRateBuckets.delete(checkoutId);
      productImageRateBuckets.set(checkoutId, { startedAt: nowMs, requests: 1 });
    } else {
      if (current.requests >= MAX_PRODUCT_IMAGE_REQUESTS_PER_WINDOW) return false;
      current.requests += 1;
      productImageRateBuckets.delete(checkoutId);
      productImageRateBuckets.set(checkoutId, current);
    }
    while (productImageRateBuckets.size > MAX_PRODUCT_IMAGE_RATE_BUCKETS) {
      const oldest = productImageRateBuckets.keys().next().value as string | undefined;
      if (!oldest) break;
      productImageRateBuckets.delete(oldest);
    }
    return true;
  }

  // Product previews are part of the recovery conversation, not a payment
  // capability. Keep their public assets available even when checkout is
  // temporarily disabled so Linq can fetch the exact image it was given.
  const checkoutAssets = resolve(process.cwd(), "web-dist");
  const reimbursementPacketPath =
    options.reimbursementPacketPath ??
    resolve(process.cwd(), "output/pdf/tavra-reimbursement-packet.pdf");
  app.get(
    "/checkout-assets/documents/:deliveryId/:filename",
    (request, response) => {
      const deliveryId = request.params.deliveryId ?? "";
      const filename = request.params.filename ?? "";
      if (
        !/^reimbursement-packet-[A-Za-z0-9_-]{8,180}$/.test(deliveryId) ||
        filename !== "tavra-emirates-reimbursement-packet.pdf"
      ) {
        response.status(404).send("Document not found");
        return;
      }
      response.set({
        "Cache-Control": "private, no-store",
        "Content-Disposition":
          'attachment; filename="tavra-emirates-reimbursement-packet.pdf"',
        "Content-Type": "application/pdf",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      });
      response.sendFile(reimbursementPacketPath, (error) => {
        if (error && !response.headersSent) {
          response.status(404).send("Document not found");
        }
      });
    },
  );
  app.use(
    "/checkout-assets",
    express.static(checkoutAssets, {
      immutable: true,
      maxAge: "1y",
      index: false,
    }),
  );
  app.use(
    "/brand",
    express.static(resolve(process.cwd(), "assets/brand"), {
      immutable: true,
      maxAge: "1y",
      index: false,
    }),
  );

  const landingPage = resolve(process.cwd(), "web-dist/index.html");
  app.get("/", (_request, response) => {
    response.set({
      "Cache-Control": "no-cache",
      "Content-Security-Policy": [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "font-src 'self'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Content-Type-Options": "nosniff",
    });
    response.sendFile(landingPage);
  });

  if (options.prava || options.liveCommerce) {
    const checkoutPage = resolve(process.cwd(), "web-dist/checkout.html");
    app.use("/pay", (_request, response, next) => {
      response.set({
        "Cache-Control": "no-store",
        "Content-Security-Policy": [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self'",
          "img-src 'self' data:",
          "connect-src 'self'",
          "frame-src https://*.prava.space https://prava.space",
          "font-src 'self'",
          "base-uri 'none'",
          "form-action 'self'",
          "frame-ancestors 'none'",
        ].join("; "),
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      });
      next();
    });
    app.get("/pay/:checkoutId", async (request, response) => {
      try {
        const approvalTarget = await options.liveCommerce?.getApprovalTarget(
          request.params.checkoutId,
        );
        if (approvalTarget) {
          response.redirect(303, approvalTarget);
          return;
        }
        const liveWorkflow = await options.liveCommerce?.getWorkflow(
          request.params.checkoutId,
        );
        if (liveWorkflow) {
          if (
            !liveWorkflowWithinRetention(
              liveWorkflow,
              "details",
              now().getTime(),
            )
          ) {
            response.status(410).send("This secure checkout review has expired.");
            return;
          }
          response.sendFile(checkoutPage);
          return;
        }
        if (!options.prava?.getClientSession(request.params.checkoutId)) {
          response.status(404).send("This secure checkout link is invalid or expired.");
          return;
        }
        response.sendFile(checkoutPage);
      } catch (error) {
        const failure = publicPaymentFailure(
          error,
          "PRAVA_CHECKOUT_UNAVAILABLE",
          "The secure Prava approval is temporarily unavailable.",
        );
        response.status(502).send(`${failure.code}: ${failure.message}`);
      }
    });
    app.get("/api/prava/checkouts/:checkoutId/session", (request, response) => {
      response.set("Cache-Control", "no-store");
      const session = options.prava?.getClientSession(request.params.checkoutId);
      if (!session) {
        response.status(404).json({ error: "Checkout link is invalid or expired" });
        return;
      }
      response.json(session);
    });
    app.get("/api/prava/checkouts/:checkoutId/summary", async (request, response) => {
      response.set({
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      const liveWorkflow = await options.liveCommerce?.getWorkflow(
        request.params.checkoutId,
      );
      if (liveWorkflow) {
        if (
          !liveWorkflowWithinRetention(
            liveWorkflow,
            "details",
            now().getTime(),
          )
        ) {
          response.status(410).json({ error: "Checkout review has expired" });
          return;
        }
        const summary = liveCheckoutSummary(
          liveWorkflow,
          options.config.publicBaseUrl,
        );
        if (!summary) {
          response.status(409).json({
            error: "The live order is not ready for secure review",
          });
          return;
        }
        response.json(summary);
        return;
      }
      const session = options.prava?.getClientSession(request.params.checkoutId);
      if (!session) {
        response.status(404).json({ error: "Checkout link is invalid or expired" });
        return;
      }
      const merchantProduct = session.order.products.find(
        (product) => product.merchantName && product.merchantUrl,
      );
      let merchantDomain: string | null = null;
      if (merchantProduct?.merchantUrl) {
        try {
          const merchantUrl = new URL(merchantProduct.merchantUrl);
          if (
            merchantUrl.protocol === "https:" &&
            !merchantUrl.username &&
            !merchantUrl.password
          ) {
            merchantDomain = merchantUrl.hostname;
          }
        } catch {
          merchantDomain = null;
        }
      }
      const order = {
        ...session.order,
        products: session.order.products.map((product, index) => {
          const imageFilename = product.productRef
            ? demoProductImageFilenames.get(product.productRef)
            : undefined;
          if (options.config.pravaMode === "sandbox" && imageFilename) {
            return {
              ...product,
              imageUrl: new URL(
                `/checkout-assets/products/${imageFilename}`,
                options.config.publicBaseUrl,
              ).toString(),
            };
          }
          if (product.imageUrl && isSafeRemoteImageUrl(product.imageUrl)) {
            return {
              ...product,
              imageUrl: new URL(
                `/api/prava/checkouts/${encodeURIComponent(request.params.checkoutId)}/products/${index}/image`,
                options.config.publicBaseUrl,
              ).toString(),
            };
          }
          if (product.imageUrl) {
            const { imageUrl: _untrustedImageUrl, ...safeProduct } = product;
            return safeProduct;
          }
          return product;
        }),
        ...(merchantProduct?.merchantName && merchantDomain
          ? {
              merchant: {
                name: merchantProduct.merchantName,
                domain: merchantDomain,
                provenance: "Prava UCP sandbox merchant",
              },
            }
          : {}),
      };
      response.json({
        checkoutId: request.params.checkoutId,
        approvalUrl: new URL(
          `/pay/${encodeURIComponent(request.params.checkoutId)}`,
          options.config.publicBaseUrl,
        ).toString(),
        expiresAt: session.expiresAt,
        order,
      });
    });
    app.get("/api/prava/checkouts/:checkoutId/status", async (request, response) => {
      response.set("Cache-Control", "no-store");
      try {
        const liveWorkflow = await options.liveCommerce?.getWorkflow(
          request.params.checkoutId,
        );
        if (
          liveWorkflow &&
          !liveWorkflowWithinRetention(
            liveWorkflow,
            "status",
            now().getTime(),
          )
        ) {
          response.status(410).json({ error: "Checkout status has expired" });
          return;
        }
        const status = liveWorkflow
          ? await options.liveCommerce?.getStatus(request.params.checkoutId)
          : await options.prava?.getStatus(request.params.checkoutId);
        if (!status) {
          response.status(404).json({ error: "Checkout link is invalid or expired" });
          return;
        }
        if (liveWorkflow && status) {
          if (status.status === "offer_review" || status.status === "quote_review") {
            response.json({ status: "pending" });
            return;
          }
          if (status.status === "merchant_checkout_pending") {
            response.json({ status: "awaiting_result" });
            return;
          }
          if (status.status === "canceled") {
            response.json({ status: "failed", message: status.message });
            return;
          }
        }
        response.json(status);
      } catch (error) {
        response.status(502).json(
          publicPaymentFailure(
            error,
            "PRAVA_STATUS_UNAVAILABLE",
            "Unable to check secure approval status",
          ),
        );
      }
    });
    app.post("/api/prava/checkouts/:checkoutId/revoke", async (request, response) => {
      response.set("Cache-Control", "no-store");
      try {
        const liveWorkflow = await options.liveCommerce?.getWorkflow(
          request.params.checkoutId,
        );
        const revoked = liveWorkflow
          ? await options.liveCommerce?.revoke(request.params.checkoutId)
          : await options.prava?.revoke(request.params.checkoutId);
        response.status(revoked ? 200 : 404).json({ revoked });
      } catch (error) {
        response.status(502).json(
          publicPaymentFailure(
            error,
            "PRAVA_CANCEL_UNAVAILABLE",
            "Unable to cancel secure checkout",
          ),
        );
      }
    });
    app.get(
      "/api/prava/checkouts/:checkoutId/products/:index/image",
      async (request, response) => {
        response.set({
          "Cache-Control": "private, no-store",
          "Content-Security-Policy": "default-src 'none'",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        });
        const index = Number(request.params.index);
        if (!Number.isSafeInteger(index) || index < 0 || index > 99) {
          response.status(404).end();
          return;
        }
        const liveWorkflow = await options.liveCommerce?.getWorkflow(
          request.params.checkoutId,
        );
        const pravaSession = liveWorkflow
          ? null
          : options.prava?.getClientSession(request.params.checkoutId) ?? null;
        const nowMs = now().getTime();
        if (
          (!liveWorkflow && !pravaSession) ||
          (liveWorkflow &&
            !liveWorkflowWithinRetention(liveWorkflow, "details", nowMs))
        ) {
          response.status(404).end();
          return;
        }
        if (!allowProductImageRequest(request.params.checkoutId, nowMs)) {
          response.set("Retry-After", "60").status(429).end();
          return;
        }
        const cacheKey = `${request.params.checkoutId}:${index}`;
        const cached = cachedProductImage(cacheKey, nowMs);
        if (cached) {
          response.type(cached.contentType).send(cached.bytes);
          return;
        }
        const source = liveWorkflow
          ? await options.liveCommerce?.getProductImageSource(
              request.params.checkoutId,
              index,
            )
          : pravaSession?.order.products[index]?.imageUrl;
        if (!source || !isSafeRemoteImageUrl(source)) {
          response.status(404).end();
          return;
        }
        if (activeProductImageRequests >= MAX_CONCURRENT_PRODUCT_IMAGES) {
          response.status(429).end();
          return;
        }
        activeProductImageRequests += 1;
        let dispatcher: Dispatcher | undefined;
        try {
          const sourceUrl = new URL(source);
          const hostname = sourceUrl.hostname.replace(/^\[|\]$/g, "");
          const resolved = await resolvePublicImageAddress(
            hostname,
            options.productImageResolve ?? (async (value) => {
              const results = await lookup(value, { all: true, verbatim: true });
              return results.flatMap(({ address, family }) =>
                family === 4 || family === 6
                  ? [{ address, family } as ResolvedImageAddress]
                  : [],
              );
            }),
          );
          dispatcher = pinnedImageAgent(hostname, resolved);
          const upstream = await (options.productImageFetch ?? fetch)(source, {
            redirect: "error",
            signal: AbortSignal.timeout(10_000),
            headers: { accept: "image/webp,image/png,image/jpeg" },
            dispatcher,
          } as RequestInit & { dispatcher: Dispatcher });
          const contentType = upstream.headers
            .get("content-type")
            ?.split(";", 1)[0]
            ?.trim()
            .toLowerCase();
          const declaredLength = Number(upstream.headers.get("content-length") ?? "0");
          if (
            !upstream.ok ||
            !contentType ||
            !SAFE_IMAGE_TYPES.has(contentType) ||
            (declaredLength > 0 && declaredLength > MAX_PRODUCT_IMAGE_BYTES)
          ) {
            response.status(404).end();
            return;
          }
          const bytes = await readLimitedResponseBody(
            upstream,
            MAX_PRODUCT_IMAGE_BYTES,
          );
          if (!hasSafeImageDimensions(contentType, bytes)) {
            response.status(404).end();
            return;
          }
          storeProductImage(cacheKey, {
            bytes,
            contentType,
            cachedAt: now().getTime(),
          });
          response.type(contentType).send(bytes);
        } catch {
          response.status(404).end();
        } finally {
          activeProductImageRequests -= 1;
          await dispatcher?.close();
        }
      },
    );
  }

  app.get("/", (_request, response) => {
    response.json({
      service: "tavra",
      status: "ok",
      feature: "linq-openai-senso-prava-recovery",
    });
  });

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.get("/health/commerce", async (_request, response) => {
    if (options.prava && options.config.commerceMode === "sandbox") {
      response.json({
        status: "ready",
        mode: "sandbox",
      });
      return;
    }
    if (!options.liveCommerce) {
      response.status(503).json({
        status: "disabled",
        mode: options.config.commerceMode ?? "disabled",
      });
      return;
    }
    try {
      const health = await options.liveCommerce.health();
      response.status(health.ready ? 200 : 503).json({
        status: health.ready ? "ready" : "unavailable",
        mode: health.mode,
        connectedAgents: health.connectedAgentCount,
        savedAddresses: health.savedAddressCount,
        missingScopes: health.missingScopes,
        message: health.message,
      });
    } catch (error) {
      response.status(503).json({
        status: "unavailable",
        mode: "live",
        connectedAgents: 0,
        savedAddresses: 0,
        missingScopes: [],
        message: error instanceof Error ? error.message : "Prava commerce is unavailable",
      });
    }
  });

  app.post(
    "/webhooks/linq",
    express.raw({ type: "application/json", limit: "2mb" }),
    async (request, response) => {
      const rawBody = Buffer.isBuffer(request.body)
        ? request.body.toString("utf8")
        : "";

      let event: TavraLinqWebhookEvent;
      try {
        event = unwrapLinqWebhook({
          client: options.client,
          rawBody,
          headers: headersFromRequest(request),
          verify: options.config.mode === "live",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.warn(
          JSON.stringify({
            scope: "linq_webhook",
            status: "rejected",
            error: message,
          }),
        );
        response.status(401).json({ ok: false });
        return;
      }

      try {
        const result = await options.processEvent(event);
        console.info(JSON.stringify({ scope: "linq_webhook", ...result }));
        response.status(200).json({ ok: true, status: result.status });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error(
          JSON.stringify({ scope: "linq_webhook", status: "failed", error: message }),
        );
        response.status(500).json({ ok: false });
      }
    },
  );

  return app;
}
