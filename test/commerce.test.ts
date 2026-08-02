import assert from "node:assert/strict";
import test from "node:test";

import {
  assertExplicitSandboxMode,
  assertWithinRecoveryCap,
  isValidHttpsProductImage,
  selectRecoveryEssential,
  type CommerceOffer,
  type CommerceProduct,
  type CommerceProvider,
  type CommerceSearchPage,
  type CommerceSearchRequest,
} from "../src/commerce.js";

function offer(input: {
  productId: string;
  variantId: string;
  options?: Record<string, string>;
  imageUrl?: string | null;
}): CommerceOffer {
  return {
    productId: input.productId,
    variantId: input.variantId,
    title: input.productId,
    description: input.productId,
    merchant: { name: "Live Store", domain: "store.example", country: "AE" },
    options: input.options ?? {},
    unitPrice: { amount: "25.00", currency: "USD" },
    available: true,
    imageUrl: input.imageUrl ?? "https://cdn.example/item.png",
    provenance: {
      source: "prava_ucp",
      merchantDomain: "store.example",
      retrievedAt: "2026-08-02T08:00:00.000Z",
    },
  };
}

function product(item: CommerceOffer): CommerceProduct {
  return {
    productId: item.productId,
    title: item.title,
    description: item.description,
    merchant: item.merchant,
    images: item.imageUrl ? [item.imageUrl] : [],
    offers: [item],
    provenance: item.provenance,
  };
}

function selectionProvider(input: {
  pages: Record<string, CommerceSearchPage>;
  products: Record<string, CommerceProduct>;
  searches: CommerceSearchRequest[];
}): CommerceProvider {
  return {
    mode: "live",
    async health() {
      return {
        ready: true,
        mode: "live",
        connectedAgentCount: 1,
        savedAddressCount: 1,
        missingScopes: [],
        message: null,
      };
    },
    async listAddresses() {
      throw new Error("not used");
    },
    async addAddress() {
      throw new Error("not used");
    },
    async search(request) {
      input.searches.push(request);
      return input.pages[request.category] ?? { results: [], nextCursor: null };
    },
    async getProduct(request) {
      const found = input.products[request.productId];
      if (!found) throw new Error("missing product fixture");
      return found;
    },
    async quote() {
      throw new Error("selection must not quote without user approval");
    },
    async createPaymentSession() {
      throw new Error("not used");
    },
    async getPaymentStatus() {
      throw new Error("not used");
    },
    async checkout() {
      throw new Error("not used");
    },
  };
}

test("enforces exact AED 250 and USD 68 recovery caps with decimal arithmetic", () => {
  assert.doesNotThrow(() =>
    assertWithinRecoveryCap({ amount: "250.00", currency: "AED" }),
  );
  assert.doesNotThrow(() =>
    assertWithinRecoveryCap({ amount: "68.00", currency: "USD" }),
  );
  assert.throws(
    () => assertWithinRecoveryCap({ amount: "250.01", currency: "AED" }),
    /exceeds.*250\.00 AED cap/i,
  );
  assert.throws(
    () => assertWithinRecoveryCap({ amount: "68.01", currency: "USD" }),
    /exceeds.*68\.00 USD cap/i,
  );
});

test("accepts only credential-free HTTPS product images", () => {
  assert.equal(isValidHttpsProductImage("https://cdn.example/item.png"), true);
  assert.equal(isValidHttpsProductImage("http://cdn.example/item.png"), false);
  assert.equal(isValidHttpsProductImage("https://user:pass@cdn.example/item.png"), false);
  assert.equal(isValidHttpsProductImage("not-a-url"), false);
});

test("requires explicit sandbox enablement", () => {
  assert.throws(
    () => assertExplicitSandboxMode({ mode: "sandbox", explicitlyEnabled: false }),
    /explicit enablement/i,
  );
  assert.doesNotThrow(() =>
    assertExplicitSandboxMode({ mode: "sandbox", explicitlyEnabled: true }),
  );
});

test("selects T-shirt, then toiletries, then trousers without quoting", async () => {
  const searches: CommerceSearchRequest[] = [];
  const invalidShirt = offer({
    productId: "shirt-1",
    variantId: "shirt-m",
    options: { Size: "M" },
    imageUrl: "http://merchant.example/shirt.png",
  });
  const toiletries = offer({
    productId: "kit-1",
    variantId: "kit-default",
  });
  const result = (id: string) => ({
    productId: id,
    title: id,
    merchant: { name: "Live Store", domain: "store.example", country: "AE" },
    estimatedPrice: { amount: "25.00", currency: "USD" } as const,
    imageUrl: id === "shirt-1" ? "http://merchant.example/shirt.png" : "https://cdn.example/kit.png",
    provenance: {
      source: "prava_ucp" as const,
      merchantDomain: "store.example",
      retrievedAt: "2026-08-02T08:00:00.000Z",
    },
  });
  const provider = selectionProvider({
    pages: {
      tshirt: { results: [result("shirt-1")], nextCursor: null },
      toiletries: { results: [result("kit-1")], nextCursor: null },
    },
    products: {
      "shirt-1": { ...product(invalidShirt), images: [] },
      "kit-1": product(toiletries),
    },
    searches,
  });

  const selected = await selectRecoveryEssential(provider, {
    shipsTo: "AE",
    tShirtSize: "M",
    trouserWaist: "32",
    trouserInseam: "30",
  });

  assert.equal(selected?.category, "toiletries");
  assert.deepEqual(
    searches.map((search) => search.category),
    ["tshirt", "toiletries"],
  );
});

test("requires an exact T-shirt size match before selecting it", async () => {
  const searches: CommerceSearchRequest[] = [];
  const wrongSize = offer({
    productId: "shirt-1",
    variantId: "shirt-l",
    options: { Size: "L" },
  });
  const provider = selectionProvider({
    pages: {
      tshirt: {
        results: [
          {
            productId: "shirt-1",
            title: "Shirt",
            merchant: { name: "Live Store", domain: "store.example", country: "AE" },
            estimatedPrice: { amount: "25.00", currency: "USD" },
            imageUrl: "https://cdn.example/shirt.png",
            provenance: wrongSize.provenance,
          },
        ],
        nextCursor: null,
      },
    },
    products: { "shirt-1": product(wrongSize) },
    searches,
  });

  const selected = await selectRecoveryEssential(provider, {
    shipsTo: "AE",
    tShirtSize: "M",
  });

  assert.equal(selected, null);
  assert.deepEqual(
    searches.map((search) => search.category),
    ["tshirt", "toiletries"],
  );
});

test("skips variants the employee already rejected and selects the next qualified offer", async () => {
  const searches: CommerceSearchRequest[] = [];
  const first = offer({
    productId: "shirt-1",
    variantId: "shirt-m-black",
    options: { Size: "M", Color: "Black" },
  });
  const second = {
    ...offer({
      productId: "shirt-1",
      variantId: "shirt-m-navy",
      options: { Size: "M", Color: "Navy" },
    }),
    unitPrice: { amount: "26.00", currency: "USD" as const },
  };
  const result = {
    productId: "shirt-1",
    title: "Shirt",
    merchant: first.merchant,
    estimatedPrice: first.unitPrice,
    imageUrl: first.imageUrl,
    provenance: first.provenance,
  };
  const provider = selectionProvider({
    pages: {
      tshirt: { results: [result], nextCursor: null },
    },
    products: {
      "shirt-1": {
        ...product(first),
        offers: [first, second],
      },
    },
    searches,
  });

  const selected = await selectRecoveryEssential(provider, {
    shipsTo: "AE",
    tShirtSize: "M",
    excludedVariantIds: [first.variantId],
  });

  assert.equal(selected?.offer.variantId, second.variantId);
});
