import assert from "node:assert/strict";
import test from "node:test";

import {
  createCheckoutIMessageAppCard,
  createCheckoutIMessageAppUpdate,
  validateIMessageAppIdentity,
} from "../src/imessage-app.js";

const identity = {
  name: "Tavra",
  teamId: "A1B2C3D4E5",
  bundleId: "com.example.tavra.MessagesExtension",
};

const productMedia = [
  {
    productRef: "b-shirt-001",
    lineItemDescription: "Neutral basic T-shirt, size M",
    url: "https://tavra.example/checkout-assets/products/b-shirt-001.png",
    altText: "Neutral basic T-shirt. Proposed item: size M.",
    caption: "Neutral basic T-shirt, size M\nIllustrative sandbox image",
    source: {
      kind: "synthetic_demo_asset" as const,
      label: "Tavra synthetic demo catalog",
      assetFilename: "b-shirt-001.png",
      mediaUrl:
        "https://tavra.example/checkout-assets/products/b-shirt-001.png",
    },
  },
];

test("builds an interactive checkout card from the exact order and first selected image", () => {
  const card = createCheckoutIMessageAppCard({
    identity,
    checkoutId: "B3V6ABeOkyMV0T4M-G_ID32b9aMs5EAH",
    approvalUrl:
      "https://tavra.example/pay/B3V6ABeOkyMV0T4M-G_ID32b9aMs5EAH",
    totalAmount: "154.00",
    currency: "USD",
    products: [
      {
        productRef: "b-shirt-001",
        description: "Neutral basic T-shirt, size M",
        unitPrice: "54.00",
        quantity: 1,
      },
      {
        productRef: "b-toiletry-001",
        description: "Essential toiletry kit",
        unitPrice: "22.00",
        quantity: 2,
      },
    ],
    productMedia,
  });

  assert.equal(card.interactive, true);
  assert.equal(card.layout.subcaption, "3 items ready for review");
  assert.equal(card.layout.trailingCaption, "USD 154.00");
  assert.equal(card.layout.imageUrl, productMedia[0]?.url);
  assert.equal(card.fallbackText, "Open secure Tavra approval");
  assert.doesNotMatch(card.fallbackText, /\d|today|tomorrow|:/i);
});

test("builds truthful terminal card updates", () => {
  const update = createCheckoutIMessageAppUpdate({
    approvalUrl:
      "https://tavra.example/pay/B3V6ABeOkyMV0T4M-G_ID32b9aMs5EAH",
    totalAmount: "154.00",
    currency: "USD",
    status: "completed",
    merchantOutcome: "simulated",
    productMedia,
  });
  assert.equal(update.layout.caption, "Sandbox approval complete");
  assert.match(update.layout.subcaption ?? "", /No live merchant order/i);
  assert.equal(update.interactive, true);
});

test("rejects an identity that cannot match an installed Apple extension", () => {
  assert.throws(
    () =>
      validateIMessageAppIdentity({
        name: "Tavra",
        teamId: "personal-team",
        bundleId: "not a bundle",
      }),
    /Team ID/i,
  );
});
