import type { PravaProduct } from "./prava.js";

export type ProductMediaSourceKind =
  | "synthetic_demo_asset"
  | "official_merchant_asset";

interface ProductMediaAssetBase {
  /** Stable catalog/SKU reference carried by the proposed checkout line item. */
  productRef: string;
  /** Description of what is visibly depicted, independent from checkout copy. */
  imageDescription: string;
  sourceLabel: string;
}

export type ProductMediaAssetDefinition = ProductMediaAssetBase &
  (
    | {
        sourceKind: "synthetic_demo_asset";
        /** Filename below Tavra's configured public product-asset directory. */
        assetFilename: string;
      }
    | {
        sourceKind: "official_merchant_asset";
        /** Exact HTTPS URL supplied by the live merchant catalog. */
        mediaUrl: string;
      }
  );

export interface ResolvedProductMedia {
  productRef: string;
  lineItemDescription: string;
  url: string;
  altText: string;
  caption: string;
  source: {
    kind: ProductMediaSourceKind;
    label: string;
    assetFilename: string | null;
    mediaUrl: string;
  };
}

export interface MissingProductMedia {
  productRef: string | null;
  lineItemDescription: string;
  reason:
    | "missing_product_ref"
    | "unmapped_product_ref"
    | "asset_unavailable"
    | "untrusted_media_url";
}

export interface ProductMediaResolution {
  items: ResolvedProductMedia[];
  missing: MissingProductMedia[];
  complete: boolean;
}

export interface ProductMediaResolver {
  resolve(products: readonly PravaProduct[]): ProductMediaResolution;
}

export interface OfficialMerchantProductMediaInput {
  productRef: string;
  lineItemDescription: string;
  imageUrl: string;
  imageDescription?: string | null;
  merchantName: string;
  /**
   * The caller must bind this URL to the selected catalog response. This hook
   * lets production additionally enforce a provider or merchant allowlist.
   */
  mediaUrlAllowed?: (url: URL, productRef: string) => boolean;
}

/**
 * Builds presentation metadata from an exact live-catalog image. URLs are
 * never invented or repaired here: invalid or untrusted catalog media is
 * suppressed so callers can continue with a truthful text-only review.
 */
export function createOfficialMerchantProductMedia(
  input: OfficialMerchantProductMediaInput,
): ResolvedProductMedia | null {
  const productRef = input.productRef.trim();
  const lineItemDescription = input.lineItemDescription.replace(/\s+/g, " ").trim();
  const merchantName = input.merchantName.replace(/\s+/g, " ").trim();
  if (
    !SAFE_PRODUCT_REF.test(productRef) ||
    !lineItemDescription ||
    !merchantName
  ) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(input.imageUrl);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (input.mediaUrlAllowed && !input.mediaUrlAllowed(url, productRef))
  ) {
    return null;
  }
  const imageDescription =
    input.imageDescription?.replace(/\s+/g, " ").trim() ||
    `Official product image from ${merchantName}`;
  return {
    productRef,
    lineItemDescription,
    url: url.toString(),
    altText: `${imageDescription}. Proposed item: ${lineItemDescription}.`,
    caption: `${lineItemDescription}\n${merchantName}`,
    source: {
      kind: "official_merchant_asset",
      label: merchantName,
      assetFilename: null,
      mediaUrl: url.toString(),
    },
  };
}

/**
 * Linq's transcript card accepts one hero image. Use the complete demo bundle
 * only when every selected line item is backed by the synthetic demo catalog.
 * Live carts continue to use the first exact merchant product image.
 */
export function resolveCheckoutCardMedia(
  resolver: ProductMediaResolver,
  products: readonly PravaProduct[],
): ResolvedProductMedia[] {
  const lineItems = resolver.resolve(products);
  const officialMerchantItem = lineItems.items.find(
    (item) => item.source.kind === "official_merchant_asset",
  );
  if (officialMerchantItem) return [officialMerchantItem];
  if (!lineItems.complete) return [];
  if (
    lineItems.items.length > 1 &&
    lineItems.items.every((item) => item.source.kind === "synthetic_demo_asset")
  ) {
    const bundle = resolver.resolve([
      {
        productRef: "demo-recovery-essentials",
        description: "Recovery essentials kit",
        unitPrice: "0.00",
        quantity: 1,
      },
    ]);
    if (bundle.complete) return bundle.items;
  }
  return lineItems.items;
}

export const DEMO_PRODUCT_MEDIA_ASSETS = [
  {
    productRef: "b-shirt-001",
    assetFilename: "b-shirt-001.png",
    imageDescription: "Neutral basic crew-neck T-shirt on a plain background",
    sourceKind: "synthetic_demo_asset",
    sourceLabel: "Tavra synthetic demo catalog",
  },
  {
    productRef: "b-trouser-001",
    assetFilename: "b-trouser-001.png",
    imageDescription: "Basic neutral trousers on a plain background",
    sourceKind: "synthetic_demo_asset",
    sourceLabel: "Tavra synthetic demo catalog",
  },
  {
    productRef: "b-toiletry-001",
    assetFilename: "b-toiletry-001.png",
    imageDescription: "Travel-size essential toiletry kit on a plain background",
    sourceKind: "synthetic_demo_asset",
    sourceLabel: "Tavra synthetic demo catalog",
  },
  {
    productRef: "demo-recovery-essentials",
    assetFilename: "recovery-bundle.png",
    imageDescription: "Illustrative delayed-baggage recovery essentials bundle",
    sourceKind: "synthetic_demo_asset",
    sourceLabel: "Tavra synthetic demo catalog",
  },
] as const satisfies readonly ProductMediaAssetDefinition[];

const SAFE_PRODUCT_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_ASSET_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:png|jpe?g|webp)$/i;

function validateEntry(entry: ProductMediaAssetDefinition): void {
  if (!SAFE_PRODUCT_REF.test(entry.productRef)) {
    throw new Error(`Invalid product-media reference: ${entry.productRef}`);
  }
  if (
    entry.sourceKind === "synthetic_demo_asset" &&
    !SAFE_ASSET_FILENAME.test(entry.assetFilename)
  ) {
    throw new Error(`Invalid product-media filename: ${entry.assetFilename}`);
  }
  if (entry.sourceKind === "official_merchant_asset") {
    const mediaUrl = new URL(entry.mediaUrl);
    if (mediaUrl.protocol !== "https:") {
      throw new Error(`Official product media must use HTTPS: ${entry.productRef}`);
    }
  }
  if (!entry.imageDescription.trim() || !entry.sourceLabel.trim()) {
    throw new Error(`Product-media metadata is incomplete for ${entry.productRef}`);
  }
}

export function createProductMediaResolver(options: {
  publicBaseUrl: string;
  assets?: readonly ProductMediaAssetDefinition[];
  /** Allows the runtime to fail closed when a catalog filename is not installed. */
  assetAvailable?: (assetFilename: string) => boolean;
  /** Production can restrict merchant-hosted images to its verified URL allowlist. */
  liveMediaUrlAllowed?: (url: URL, productRef: string) => boolean;
}): ProductMediaResolver {
  const publicBaseUrl = new URL(options.publicBaseUrl);
  if (publicBaseUrl.protocol !== "https:") {
    throw new Error("Product media requires a public HTTPS base URL");
  }
  const definitions = options.assets ?? DEMO_PRODUCT_MEDIA_ASSETS;
  const assets = new Map<string, ProductMediaAssetDefinition>();
  for (const definition of definitions) {
    validateEntry(definition);
    if (assets.has(definition.productRef)) {
      throw new Error(`Duplicate product-media reference: ${definition.productRef}`);
    }
    assets.set(definition.productRef, { ...definition });
  }

  return {
    resolve(products) {
      const items: ResolvedProductMedia[] = [];
      const missing: MissingProductMedia[] = [];
      for (const product of products) {
        const productRef = product.productRef?.trim() || null;
        if (!productRef) {
          missing.push({
            productRef: null,
            lineItemDescription: product.description,
            reason: "missing_product_ref",
          });
          continue;
        }
        const definition = assets.get(productRef);
        if (!definition) {
          const official =
            product.imageUrl && product.merchantName
              ? createOfficialMerchantProductMedia({
                  productRef,
                  lineItemDescription: product.description,
                  imageUrl: product.imageUrl,
                  merchantName: product.merchantName,
                  mediaUrlAllowed: options.liveMediaUrlAllowed,
                })
              : null;
          if (official) {
            items.push(official);
            continue;
          }
          missing.push({
            productRef,
            lineItemDescription: product.description,
            reason:
              product.imageUrl && product.merchantName
                ? "untrusted_media_url"
                : "unmapped_product_ref",
          });
          continue;
        }
        if (
          definition.sourceKind === "synthetic_demo_asset" &&
          options.assetAvailable &&
          !options.assetAvailable(definition.assetFilename)
        ) {
          missing.push({
            productRef,
            lineItemDescription: product.description,
            reason: "asset_unavailable",
          });
          continue;
        }
        const mediaUrl =
          definition.sourceKind === "synthetic_demo_asset"
            ? new URL(
                `/checkout-assets/products/${definition.assetFilename}`,
                publicBaseUrl,
              )
            : new URL(definition.mediaUrl);
        if (
          definition.sourceKind === "official_merchant_asset" &&
          options.liveMediaUrlAllowed &&
          !options.liveMediaUrlAllowed(mediaUrl, productRef)
        ) {
          missing.push({
            productRef,
            lineItemDescription: product.description,
            reason: "untrusted_media_url",
          });
          continue;
        }
        const url = mediaUrl.toString();
        const disclosure =
          definition.sourceKind === "synthetic_demo_asset"
            ? "Recovery item preview"
            : definition.sourceLabel;
        items.push({
          productRef,
          lineItemDescription: product.description,
          url,
          altText: `${definition.imageDescription}. Proposed item: ${product.description}.`,
          caption: `${product.description}\n${disclosure}`,
          source: {
            kind: definition.sourceKind,
            label: definition.sourceLabel,
            assetFilename:
              definition.sourceKind === "synthetic_demo_asset"
                ? definition.assetFilename
                : null,
            mediaUrl: url,
          },
        });
      }
      return {
        items,
        missing,
        complete: products.length > 0 && missing.length === 0,
      };
    },
  };
}
