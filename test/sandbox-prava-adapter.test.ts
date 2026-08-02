import assert from "node:assert/strict";
import test from "node:test";

import {
  MerchantCheckoutPreSubmitError,
  MerchantCheckoutUncertainError,
  type MerchantCheckoutAdapter,
  type PravaProduct,
} from "../src/prava.js";
import { createMedduPravaMerchantAdapter } from "../src/sandbox-prava-adapter.js";
import {
  MEDDU_MERCHANT,
  MEDDU_MERCHANT_CONFIG,
  type SandboxMerchantAttemptResult,
  type SandboxMerchantBrowserExecutor,
  type SandboxMerchantPaymentRequest,
} from "../src/sandbox-merchant.js";

// Generated shape-only placeholders, never Prava sandbox credentials.
const MOCK_ONE_TIME_TOKEN = "8".repeat(16);
const SECOND_MOCK_ONE_TIME_TOKEN = "6".repeat(16);
const MOCK_DYNAMIC_CVV = "4".repeat(3);
const SECOND_MOCK_DYNAMIC_CVV = "5".repeat(3);

const attemptedAt = "2026-08-02T12:00:00.000Z";
const variantId = "gid://shopify/ProductVariant/46624128270499";
const checkoutUrl =
  "https://edqvrb-i5.myshopify.com/cart/46624128270499:1";
const imageUrl =
  "https://cdn.shopify.com/s/files/1/0697/4213/3411/files/Sensodyne_Deep_Clean_Gel_Toothpaste_-_75ml_Toothpaste_1.jpg?v=1774107076";

function product(overrides: Partial<PravaProduct> = {}): PravaProduct {
  return {
    productRef: "meddu-46624128270499",
    description: "Sensodyne Deep Clean Gel Toothpaste - 75ml",
    unitPrice: "47.81",
    quantity: 1,
    imageUrl,
    merchantName: MEDDU_MERCHANT.name,
    merchantUrl: MEDDU_MERCHANT_CONFIG.origin,
    merchantVariantId: variantId,
    checkoutUrl,
    ...overrides,
  };
}

function request(
  overrides: Partial<Parameters<MerchantCheckoutAdapter["checkout"]>[0]> = {},
): Parameters<MerchantCheckoutAdapter["checkout"]>[0] {
  return {
    idempotencyKey: "checkout-1:merchant-attempt",
    amount: "47.81",
    currency: "AED",
    products: [product()],
    recovery: {
      caseId: "RCV-1234",
      passengerName: "Demo Traveler",
      needBy: "08:00 tomorrow",
      deliveryArea: "Abu Dhabi, United Arab Emirates",
      deliveryAddress: "MBZUAI, Masdar City, Abu Dhabi, Room 308",
      deliveryAddressSource: "linq_location",
      airline: "Emirates",
      arrivalAirport: "AUH",
      baggageReference: "RF392942",
      noticeAttachmentIds: ["attachment-1"],
    },
    buyer: {
      email: "traveler@example.com",
      phone: "+971501234567",
      firstName: "Demo",
      lastName: "Traveler",
    },
    credential: {
      token: MOCK_ONE_TIME_TOKEN,
      dynamicCvv: MOCK_DYNAMIC_CVV,
      expiryMonth: "12",
      expiryYear: "2030",
    },
    ...overrides,
  };
}

type AttemptCore = SandboxMerchantAttemptResult extends infer Result
  ? Result extends SandboxMerchantAttemptResult
    ? Omit<
        Result,
        "merchant" | "checkoutHost" | "attemptedAt" | "paymentSubmitted"
      >
    : never
  : never;

function result(value: AttemptCore): SandboxMerchantAttemptResult {
  return {
    ...value,
    merchant: MEDDU_MERCHANT,
    checkoutHost: "edqvrb-i5.myshopify.com",
    attemptedAt,
    paymentSubmitted:
      value.status === "expected_decline" || value.status === "approved",
  } as SandboxMerchantAttemptResult;
}

function fakeExecutor(
  output: SandboxMerchantAttemptResult,
  observed: SandboxMerchantPaymentRequest[] = [],
): SandboxMerchantBrowserExecutor {
  return {
    async attempt(input) {
      observed.push(input);
      return output;
    },
  };
}

test("uses Meddu's bare Prava origin and pharmacy merchant metadata", () => {
  const adapter = createMedduPravaMerchantAdapter({
    executor: fakeExecutor(
      result({
        status: "expected_decline",
        reason: "test_card",
        responseCode: "sandbox_expected_decline",
      }),
    ),
  });
  assert.deepEqual(adapter.merchant, {
    name: "Meddu",
    url: "https://meddu.com/",
    countryCodeIso2: "AE",
    categoryCode: "5912",
    category: "Drug Stores and Pharmacies",
  });
});

for (const reason of ["insufficient_funds", "test_card"] as const) {
  test(`marks ${reason} as the organizer's expected sandbox decline`, async () => {
    const observed: SandboxMerchantPaymentRequest[] = [];
    const adapter = createMedduPravaMerchantAdapter({
      executor: fakeExecutor(
        result({
          status: "expected_decline",
          reason,
          responseCode: "sandbox_expected_decline",
        }),
        observed,
      ),
    });

    const outcome = await adapter.checkout(request());

    assert.equal(outcome.status, "declined");
    assert.equal(outcome.expectedSandboxDecline, true);
    assert.equal(outcome.simulated, false);
    assert.equal(outcome.responseCode, reason === "insufficient_funds" ? "51" : "05");
    assert.deepEqual(outcome.evidence, {
      merchantName: "Meddu",
      merchantUrl: "https://meddu.com/",
      attemptedAt,
      responseText:
        reason === "insufficient_funds"
          ? "Merchant checkout declined the approved one-time card for insufficient funds"
          : "Merchant checkout declined the approved one-time card because it is a sandbox test credential",
      responseCode: reason === "insufficient_funds" ? "51" : "05",
      reference: null,
    });
    assert.equal(observed.length, 1);
    assert.equal(observed[0]?.expectedTotal.amount, "47.81");
    assert.equal(observed[0]?.expectedTotal.currency, "AED");
    assert.equal(observed[0]?.checkout.offer.variantId, variantId);
    assert.equal(observed[0]?.shippingAddress.addressCountry, "AE");
    assert.equal(observed[0]?.shippingAddress.streetAddress, request().recovery?.deliveryAddress);
  });
}

test("treats a generic merchant decline as a normal failure", async () => {
  const adapter = createMedduPravaMerchantAdapter({
    executor: fakeExecutor(
      result({
        status: "expected_decline",
        reason: "merchant_declined",
        responseCode: "sandbox_expected_decline",
      }),
    ),
  });

  const outcome = await adapter.checkout(request());

  assert.equal(outcome.status, "declined");
  assert.equal(outcome.expectedSandboxDecline, false);
  assert.equal(outcome.responseCode, "05");
  assert.equal(outcome.evidence.responseText, "Merchant checkout declined the approved payment");
});

test("preserves the merchant's redacted processor message in attempt evidence", async () => {
  const processorMessage = "Your card was declined due to insufficient funds";
  const adapter = createMedduPravaMerchantAdapter({
    executor: fakeExecutor(
      result({
        status: "expected_decline",
        reason: "insufficient_funds",
        responseCode: "sandbox_expected_decline",
        message: processorMessage,
      }),
    ),
  });

  const outcome = await adapter.checkout(request());
  assert.equal(outcome.evidence.responseText, processorMessage);
});

test("validates provenance, exact AED total, and a confirmed UAE address before executor use", async () => {
  const cases: Array<{
    name: string;
    mutate: Partial<Parameters<MerchantCheckoutAdapter["checkout"]>[0]>;
    pattern: RegExp;
  }> = [
    {
      name: "currency",
      mutate: { currency: "USD" },
      pattern: /requires AED/i,
    },
    {
      name: "total",
      mutate: { amount: "75.00" },
      pattern: /line items do not equal/i,
    },
    {
      name: "merchant origin",
      mutate: { products: [product({ merchantUrl: "https://meddu.com/products/item" })] },
      pattern: /provenance does not match/i,
    },
    {
      name: "variant",
      mutate: { products: [product({ merchantVariantId: "variant-123" })] },
      pattern: /invalid Shopify variant/i,
    },
    {
      name: "checkout variant",
      mutate: {
        products: [
          product({
            checkoutUrl:
              "https://edqvrb-i5.myshopify.com/cart/11111111111111:1",
          }),
        ],
      },
      pattern: /checkout URL does not match/i,
    },
    {
      name: "image",
      mutate: { products: [product({ imageUrl: "https://images.invalid/item.jpg" })] },
      pattern: /approved merchant host/i,
    },
    {
      name: "address",
      mutate: {
        recovery: {
          ...request().recovery!,
          deliveryArea: "Boston, MA",
          deliveryAddress: "1 Main Street, Boston, MA",
        },
      },
      pattern: /confirmed UAE address/i,
    },
  ];

  for (const example of cases) {
    let executorCalls = 0;
    const adapter = createMedduPravaMerchantAdapter({
      executor: {
        async attempt() {
          executorCalls += 1;
          return result({
            status: "expected_decline",
            reason: "test_card",
            responseCode: "sandbox_expected_decline",
          });
        },
      },
    });
    await assert.rejects(
      adapter.checkout(request(example.mutate)),
      (error: unknown) =>
        error instanceof MerchantCheckoutPreSubmitError &&
        example.pattern.test(error.message),
      example.name,
    );
    assert.equal(executorCalls, 0, example.name);
  }
});

test("permits only the exact fulfillment delta and checks the exact total", async () => {
  const observed: SandboxMerchantPaymentRequest[] = [];
  const adapter = createMedduPravaMerchantAdapter({
    executor: fakeExecutor(
      result({
        status: "expected_decline",
        reason: "insufficient_funds",
        responseCode: "sandbox_expected_decline",
      }),
      observed,
    ),
  });
  const fulfillment: PravaProduct = {
    productRef: "meddu-fulfillment",
    description: "Merchant shipping and tax",
    unitPrice: "10.50",
    quantity: 1,
  };

  await adapter.checkout(
    request({
      idempotencyKey: "checkout-with-shipping",
      amount: "58.31",
      products: [product(), fulfillment],
    }),
  );

  assert.equal(observed[0]?.expectedTotal.amount, "58.31");
  assert.equal(observed[0]?.checkout.offer.price.amount, "47.81");
  await assert.rejects(
    adapter.checkout(
      request({
        idempotencyKey: "checkout-with-fake-fee",
        amount: "58.31",
        products: [
          product(),
          { ...fulfillment, productRef: "other-fee" },
        ],
      }),
    ),
    MerchantCheckoutPreSubmitError,
  );
});

test("maps pre-submit and post-submit uncertainty to the Prava service errors", async () => {
  const preSubmitAdapter = createMedduPravaMerchantAdapter({
    executor: fakeExecutor(
      result({
        status: "failed_pre_submit",
        code: "payment_form_unavailable",
        message: "The merchant payment fields were unavailable",
      }),
    ),
  });
  await assert.rejects(
    preSubmitAdapter.checkout(request({ idempotencyKey: "pre-submit" })),
    MerchantCheckoutPreSubmitError,
  );

  const uncertainAdapter = createMedduPravaMerchantAdapter({
    executor: fakeExecutor(
      result({
        status: "reconciliation_required",
        message: "The merchant outcome was not observable",
      }),
    ),
  });
  await assert.rejects(
    uncertainAdapter.checkout(request({ idempotencyKey: "uncertain" })),
    MerchantCheckoutUncertainError,
  );
});

test("never retries an idempotency key or stores a second credential", async () => {
  const observed: SandboxMerchantPaymentRequest[] = [];
  const adapter = createMedduPravaMerchantAdapter({
    executor: fakeExecutor(
      result({
        status: "expected_decline",
        reason: "test_card",
        responseCode: "sandbox_expected_decline",
      }),
      observed,
    ),
  });

  const first = adapter.checkout(request());
  const second = adapter.checkout(
    request({
      credential: {
        token: SECOND_MOCK_ONE_TIME_TOKEN,
        dynamicCvv: SECOND_MOCK_DYNAMIC_CVV,
        expiryMonth: "01",
        expiryYear: "2031",
      },
    }),
  );
  assert.strictEqual(first, second);
  await first;
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.credential.token, MOCK_ONE_TIME_TOKEN);
  assert.equal(JSON.stringify(await second).includes(MOCK_ONE_TIME_TOKEN), false);
  assert.equal(JSON.stringify(await second).includes(MOCK_DYNAMIC_CVV), false);
});
