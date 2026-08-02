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
    caption: "Neutral basic T-shirt, size M\nRecovery item preview",
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
    checkoutId: "demo_checkout_0123456789ABCDEFGH",
    approvalUrl:
      "https://tavra.example/pay/demo_checkout_0123456789ABCDEFGH",
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
  assert.equal(card.layout.subcaption, "Neutral basic T-shirt, size M");
  assert.equal(card.layout.trailingCaption, "USD 154.00");
  assert.equal(card.layout.trailingSubcaption, "Review, not purchased");
  assert.equal(card.layout.imageUrl, productMedia[0]?.url);
  assert.equal(card.fallbackText, "Open secure Tavra approval");
  assert.doesNotMatch(card.fallbackText, /\d|today|tomorrow|:/i);
});

test("renders the configured demo completion as approval complete and order placed", () => {
  const update = createCheckoutIMessageAppUpdate({
    approvalUrl:
      "https://tavra.example/pay/demo_checkout_0123456789ABCDEFGH",
    totalAmount: "154.00",
    currency: "USD",
    status: "completed",
    merchantOutcome: "simulated",
    productMedia,
  });
  assert.equal(update.layout.caption, "Approval complete");
  assert.equal(update.layout.subcaption, "Order placed");
  assert.equal(update.layout.trailingSubcaption, "Order placed");
  assert.doesNotMatch(
    [
      update.layout.caption,
      update.layout.subcaption,
      update.layout.trailingSubcaption,
    ].join(" "),
    /sandbox|simulat|no live|no order/i,
  );
  assert.equal(update.interactive, true);
});

test("shows the exact live merchant image, variant, total, and state", () => {
  const liveImage = "https://cdn.shop.example/products/cotton-shirt-m-navy.webp";
  const liveMedia = [
    {
      productRef: "merchant-shirt-42",
      lineItemDescription: "Everyday cotton T-shirt",
      url: liveImage,
      altText: "Navy cotton T-shirt from Example Merchant.",
      caption: "Everyday cotton T-shirt\nExample Merchant",
      source: {
        kind: "official_merchant_asset" as const,
        label: "Example Merchant",
        assetFilename: null,
        mediaUrl: liveImage,
      },
    },
  ];
  const card = createCheckoutIMessageAppCard({
    identity,
    checkoutId: "live-checkout-12345678901234567890",
    approvalUrl: "https://tavra.example/pay/live-checkout-12345678901234567890",
    totalAmount: "61.50",
    currency: "AED",
    products: [
      {
        productRef: "merchant-shirt-42",
        description: "Everyday cotton T-shirt",
        unitPrice: "50.00",
        quantity: 1,
      },
    ],
    productMedia: liveMedia,
    merchantName: "Example Merchant",
    primaryVariant: "Size M, navy",
    state: "approval_pending",
  });

  assert.equal(card.layout.caption, "Example Merchant");
  assert.equal(card.layout.subcaption, "Size M, navy");
  assert.equal(card.layout.trailingCaption, "AED 61.50");
  assert.equal(card.layout.trailingSubcaption, "Approval pending");
  assert.equal(card.layout.imageUrl, liveImage);
  assert.equal(card.layout.imageTitle, "Everyday cotton T-shirt");
  assert.equal(card.layout.imageSubtitle, "Example Merchant");
});

test("renders a live merchant order update without conflating approval and purchase", () => {
  const update = createCheckoutIMessageAppUpdate({
    approvalUrl: "https://tavra.example/pay/live-checkout-12345678901234567890",
    totalAmount: "61.50",
    currency: "AED",
    status: "completed",
    merchantOutcome: "live",
    productMedia: [],
    merchantName: "Example Merchant",
    primaryVariant: "Size M, navy",
    merchantOrderId: "ORDER-42",
  });

  assert.equal(update.layout.caption, "Example Merchant");
  assert.equal(update.layout.subcaption, "Size M, navy");
  assert.equal(update.layout.trailingSubcaption, "Order placed");
  assert.doesNotMatch(JSON.stringify(update), /—|--/);
});

test("renders a validated sandbox merchant attempt without claiming an order", () => {
  const merchantImage = "https://cdn.shop.example/products/toiletry-kit.webp";
  const update = createCheckoutIMessageAppUpdate({
    approvalUrl: "https://tavra.example/pay/sandbox-checkout-123456789012345",
    totalAmount: "47.81",
    currency: "AED",
    status: "sandbox_validated",
    merchantOutcome: "sandbox_merchant",
    productMedia: [
      {
        productRef: "merchant-toiletry-42",
        lineItemDescription: "Travel whitening toothpaste",
        url: merchantImage,
        altText: "Sensodyne travel toothpaste from Meddu.",
        caption: "Sensodyne travel toothpaste\nMeddu",
        source: {
          kind: "official_merchant_asset",
          label: "Meddu",
          assetFilename: null,
          mediaUrl: merchantImage,
        },
      },
    ],
    merchantName: "Meddu",
  });

  assert.equal(update.layout.caption, "Meddu");
  assert.equal(update.layout.subcaption, "Approval complete, checkout attempted");
  assert.equal(update.layout.trailingSubcaption, "Expected decline recorded");
  assert.equal(update.layout.imageUrl, merchantImage);
  assert.doesNotMatch(
    JSON.stringify(update),
    /order placed|order confirmed|reimbursement|incurred|—|--/i,
  );
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
