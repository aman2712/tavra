import assert from "node:assert/strict";
import test from "node:test";

import {
  createProductMediaResolver,
  DEMO_PRODUCT_MEDIA_ASSETS,
  resolveCheckoutCardMedia,
} from "../src/product-media.js";

test("resolves media only for the exact proposed line items and preserves order", () => {
  const resolver = createProductMediaResolver({
    publicBaseUrl: "https://tavra.example",
    assetAvailable: () => true,
  });

  const resolution = resolver.resolve([
    {
      productRef: "b-trouser-001",
      description: "Basic trousers, 32x30",
      unitPrice: "78.00",
      quantity: 1,
    },
    {
      productRef: "b-toiletry-001",
      description: "Essential toiletry kit",
      unitPrice: "22.00",
      quantity: 1,
    },
  ]);

  assert.equal(resolution.complete, true);
  assert.deepEqual(resolution.missing, []);
  assert.deepEqual(
    resolution.items.map((item) => item.productRef),
    ["b-trouser-001", "b-toiletry-001"],
  );
  assert.deepEqual(
    resolution.items.map((item) => item.url),
    [
      "https://tavra.example/checkout-assets/products/b-trouser-001.png",
      "https://tavra.example/checkout-assets/products/b-toiletry-001.png",
    ],
  );
  assert.match(resolution.items[0]?.caption ?? "", /Basic trousers, 32x30/);
  assert.match(resolution.items[0]?.caption ?? "", /Illustrative sandbox image/);
  assert.match(resolution.items[0]?.altText ?? "", /Proposed item: Basic trousers, 32x30/);
  assert.equal(
    resolution.items.some((item) => item.productRef === "b-shirt-001"),
    false,
  );
});

test("reports incomplete media coverage instead of substituting a bundle image", () => {
  const resolver = createProductMediaResolver({
    publicBaseUrl: "https://tavra.example/base",
    assetAvailable: (filename) => filename !== "b-trouser-001.png",
  });

  const resolution = resolver.resolve([
    {
      productRef: "b-shirt-001",
      description: "Neutral basic T-shirt, size M",
      unitPrice: "54.00",
      quantity: 1,
    },
    {
      productRef: "b-trouser-001",
      description: "Basic trousers, 32x30",
      unitPrice: "78.00",
      quantity: 1,
    },
    {
      description: "Unmapped replacement item",
      unitPrice: "10.00",
      quantity: 1,
    },
  ]);

  assert.equal(resolution.complete, false);
  assert.deepEqual(
    resolution.items.map((item) => item.productRef),
    ["b-shirt-001"],
  );
  assert.deepEqual(
    resolution.missing.map((item) => item.reason),
    ["asset_unavailable", "missing_product_ref"],
  );
  assert.equal(
    resolution.items.some((item) => item.url.endsWith("/recovery-bundle.png")),
    false,
  );
});

test("uses one complete bundle hero for a multi-item synthetic checkout card", () => {
  const resolver = createProductMediaResolver({
    publicBaseUrl: "https://tavra.example",
    assetAvailable: () => true,
  });
  const media = resolveCheckoutCardMedia(resolver, [
    {
      productRef: "b-shirt-001",
      description: "Neutral basic T-shirt, size M",
      unitPrice: "54.00",
      quantity: 1,
    },
    {
      productRef: "b-trouser-001",
      description: "Basic trousers, 32x30",
      unitPrice: "78.00",
      quantity: 1,
    },
    {
      productRef: "b-toiletry-001",
      description: "Essential toiletry kit",
      unitPrice: "22.00",
      quantity: 1,
    },
  ]);

  assert.equal(media.length, 1);
  assert.equal(media[0]?.productRef, "demo-recovery-essentials");
  assert.equal(
    media[0]?.url,
    "https://tavra.example/checkout-assets/products/recovery-bundle.png",
  );
});

test("declares one media definition for every eligible demo catalog SKU", () => {
  assert.deepEqual(
    DEMO_PRODUCT_MEDIA_ASSETS.slice(0, 3).map((asset) => ({
      productRef: asset.productRef,
      assetFilename: asset.assetFilename,
    })),
    [
      { productRef: "b-shirt-001", assetFilename: "b-shirt-001.png" },
      { productRef: "b-trouser-001", assetFilename: "b-trouser-001.png" },
      { productRef: "b-toiletry-001", assetFilename: "b-toiletry-001.png" },
    ],
  );
});

test("keeps live merchant catalog media URL-driven and allowlistable", () => {
  const resolver = createProductMediaResolver({
    publicBaseUrl: "https://tavra.example",
    assets: [
      {
        productRef: "merchant-sku-42",
        mediaUrl: "https://images.merchant.example/products/sku-42.webp",
        imageDescription: "Merchant product photograph of a navy shirt",
        sourceKind: "official_merchant_asset",
        sourceLabel: "Example Merchant live catalog",
      },
    ],
    liveMediaUrlAllowed: (url) => url.hostname === "images.merchant.example",
  });

  const resolution = resolver.resolve([
    {
      productRef: "merchant-sku-42",
      description: "Navy travel shirt, size M",
      unitPrice: "49.00",
      quantity: 1,
    },
  ]);

  assert.equal(resolution.complete, true);
  assert.equal(
    resolution.items[0]?.url,
    "https://images.merchant.example/products/sku-42.webp",
  );
  assert.equal(resolution.items[0]?.source.assetFilename, null);
  assert.equal(
    resolution.items[0]?.source.label,
    "Example Merchant live catalog",
  );
  assert.doesNotMatch(
    resolution.items[0]?.caption ?? "",
    /illustrative sandbox/i,
  );
});
