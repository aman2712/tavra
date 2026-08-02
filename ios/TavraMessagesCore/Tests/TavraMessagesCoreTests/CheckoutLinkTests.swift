import Foundation
import Testing
@testable import TavraMessagesCore

private let validCheckoutID = "demo_checkout_0123456789ABCDEFGH"
private let trustedHost = "tavratest-3000.euw.devtunnels.ms"

@Test func acceptsExactTrustedHTTPSCheckoutLink() throws {
    let link = try CheckoutLink(
        url: #require(URL(string: "https://\(trustedHost)/pay/\(validCheckoutID)")),
        allowedHosts: [trustedHost]
    )
    #expect(link.checkoutID == validCheckoutID)
    #expect(try link.summaryURL.absoluteString == "https://\(trustedHost)/api/prava/checkouts/\(validCheckoutID)/summary")
    #expect(try link.statusURL.absoluteString == "https://\(trustedHost)/api/prava/checkouts/\(validCheckoutID)/status")
}

@Test(arguments: [
    "http://tavratest-3000.euw.devtunnels.ms/pay/\(validCheckoutID)",
    "https://evil.example/pay/\(validCheckoutID)",
    "https://child.tavratest-3000.euw.devtunnels.ms/pay/\(validCheckoutID)",
    "https://user:password@tavratest-3000.euw.devtunnels.ms/pay/\(validCheckoutID)",
    "https://tavratest-3000.euw.devtunnels.ms:444/pay/\(validCheckoutID)",
    "https://tavratest-3000.euw.devtunnels.ms/pay/\(validCheckoutID)?preview=1",
    "https://tavratest-3000.euw.devtunnels.ms/pay/short",
    "https://tavratest-3000.euw.devtunnels.ms/not-pay/\(validCheckoutID)",
])
func rejectsUntrustedOrMalformedLinks(rawURL: String) {
    #expect(throws: CheckoutLinkError.self) {
        _ = try CheckoutLink(
            url: #require(URL(string: rawURL)),
            allowedHosts: [trustedHost]
        )
    }
}

@Test func refusesUnconfiguredPlaceholderHosts() {
    #expect(throws: CheckoutLinkError.noAllowedHosts) {
        _ = try CheckoutLink(
            url: #require(URL(string: "https://tavra.example/pay/\(validCheckoutID)")),
            allowedHosts: ["$(TAVRA_CHECKOUT_HOST)"]
        )
    }
}

@Test func validatesSummaryAgainstTheSelectedCard() throws {
    let link = try CheckoutLink(
        url: #require(URL(string: "https://\(trustedHost)/pay/\(validCheckoutID)")),
        allowedHosts: [trustedHost]
    )
    let shirtImageURL = try #require(URL(
        string: "https://\(trustedHost)/checkout-assets/products/b-shirt-001.png"
    ))
    let trouserImageURL = try #require(URL(
        string: "https://\(trustedHost)/checkout-assets/products/b-trouser-001.png"
    ))
    let toiletryImageURL = try #require(URL(
        string: "https://\(trustedHost)/checkout-assets/products/b-toiletry-001.png"
    ))
    let unsafeImageURL = try #require(URL(
        string: "https://evil.example/toiletries.png"
    ))
    let order = CheckoutSummary.Order(
        description: "Tavra delayed-baggage recovery essentials",
        totalAmount: "154.00",
        currency: "USD",
        products: [
            .init(
                productRef: "b-shirt-001",
                description: "Neutral basic T-shirt, size M",
                unitPrice: "54.00",
                quantity: 1,
                imageUrl: shirtImageURL
            ),
            .init(
                productRef: "b-trouser-001",
                description: "Basic trousers, 32x30",
                unitPrice: "78.00",
                quantity: 1,
                imageUrl: trouserImageURL
            ),
            .init(
                productRef: "b-toiletry-001",
                description: "Essential toiletry kit",
                unitPrice: "22.00",
                quantity: 1,
                imageUrl: toiletryImageURL
            ),
        ]
    )
    let summary = CheckoutSummary(
        checkoutId: validCheckoutID,
        approvalUrl: link.approvalURL,
        expiresAt: "2099-08-01T12:15:00.000Z",
        order: order
    )
    try summary.validate(for: link)

    let mismatched = CheckoutSummary(
        checkoutId: String(repeating: "x", count: 32),
        approvalUrl: link.approvalURL,
        expiresAt: summary.expiresAt,
        order: order
    )
    #expect(throws: CheckoutClientError.mismatchedSummary) {
        try mismatched.validate(for: link)
    }

    let incorrectTotal = CheckoutSummary(
        checkoutId: validCheckoutID,
        approvalUrl: link.approvalURL,
        expiresAt: summary.expiresAt,
        order: .init(
            description: order.description,
            totalAmount: "155.00",
            currency: order.currency,
            products: order.products
        )
    )
    #expect(throws: CheckoutClientError.invalidSummary) {
        try incorrectTotal.validate(for: link)
    }

    let unsafeImage = CheckoutSummary(
        checkoutId: validCheckoutID,
        approvalUrl: link.approvalURL,
        expiresAt: summary.expiresAt,
        order: .init(
            description: order.description,
            totalAmount: order.totalAmount,
            currency: order.currency,
            products: [
                order.products[0],
                order.products[1],
                .init(
                    productRef: "b-toiletry-001",
                    description: "Essential toiletry kit",
                    unitPrice: "22.00",
                    quantity: 1,
                    imageUrl: unsafeImageURL
                ),
            ]
        )
    )
    #expect(throws: CheckoutClientError.invalidSummary) {
        try unsafeImage.validate(for: link)
    }
}

@Test func validatesLiveMerchantSummaryWithCheckoutScopedImageAndQuoteBreakdown() throws {
    let link = try CheckoutLink(
        url: #require(URL(string: "https://\(trustedHost)/pay/\(validCheckoutID)")),
        allowedHosts: [trustedHost]
    )
    let imageURL = try #require(URL(
        string: "https://\(trustedHost)/api/prava/checkouts/\(validCheckoutID)/products/0/image"
    ))
    let product = CheckoutSummary.Order.Product(
        productRef: "gid:shopify:Product:42",
        variantRef: "gid:shopify:ProductVariant:84",
        description: "Everyday cotton T-shirt",
        variant: "Size M, navy",
        options: ["Size": "M", "Color": "Navy"],
        unitPrice: "50.00",
        quantity: 1,
        imageUrl: imageURL,
        imageAltText: "Navy cotton T-shirt from Example Merchant"
    )
    let summary = CheckoutSummary(
        checkoutId: validCheckoutID,
        approvalUrl: link.approvalURL,
        expiresAt: "2099-08-01T12:15:00.000Z",
        order: .init(
            description: "One replacement essential",
            totalAmount: "61.50",
            currency: "AED",
            products: [product],
            merchant: .init(
                name: "Example Merchant",
                domain: "shop.example.com",
                countryCode: "AE",
                provenance: "Prava UCP"
            ),
            destination: .init(maskedLabel: "MBZUAI, Masdar City"),
            delivery: .init(
                label: "Tomorrow by 8:00 AM",
                estimatedArrival: "2099-08-02T08:00:00.000Z",
                verified: true
            ),
            allowance: .init(amount: "250.00", currency: "AED"),
            quote: .init(id: "quote:ucp:123", expiresAt: "2099-08-01T12:10:00.000Z"),
            pricing: .init(
                subtotal: "50.00",
                shipping: "10.00",
                tax: "2.50",
                discount: "1.00",
                total: "61.50"
            )
        )
    )

    try summary.validate(for: link)
    #expect(summary.order.products.count == 1)
    #expect(summary.order.products[0].displayVariant == "Size M, navy")
    #expect(summary.requiredLiveProductImageIndexes == [0])
    #expect(link.allowsProductImage(imageURL))

    let anotherCheckoutImage = try #require(URL(
        string: "https://\(trustedHost)/api/prava/checkouts/another-checkout-1234567890/products/0/image"
    ))
    #expect(!link.allowsProductImage(anotherCheckoutImage))
}

@Test func keepsLegacyCheckoutSummaryDecodingCompatible() throws {
    let json = #"""
    {
      "checkoutId": "demo_checkout_0123456789ABCDEFGH",
      "approvalUrl": "https://tavratest-3000.euw.devtunnels.ms/pay/demo_checkout_0123456789ABCDEFGH",
      "expiresAt": "2099-08-01T12:15:00.000Z",
      "order": {
        "description": "Recovery essentials",
        "totalAmount": "22.00",
        "currency": "USD",
        "products": [{
          "description": "Essential toiletry kit",
          "unitPrice": "22.00",
          "quantity": 1
        }]
      }
    }
    """#
    let summary = try JSONDecoder().decode(
        CheckoutSummary.self,
        from: #require(json.data(using: .utf8))
    )
    #expect(summary.order.merchant == nil)
    #expect(summary.order.pricing == nil)
    #expect(summary.requiredLiveProductImageIndexes.isEmpty)
}

@Test(arguments: [
    (#"{"status":"pending"}"#, CheckoutPublicStatus.pending),
    (#"{"status":"awaiting_result"}"#, CheckoutPublicStatus.awaitingResult),
    (
        #"{"status":"completed","merchantOrderId":"SIM-123","merchantOutcome":"simulated"}"#,
        CheckoutPublicStatus.completed(merchantOrderID: "SIM-123", outcome: .simulated)
    ),
    (
        #"{"status":"sandbox_validated","merchantAttempt":{"merchantName":"Meddu","merchantUrl":"https://meddu.com/","attemptedAt":"2026-08-02T16:00:00.000Z","responseText":"Test card declined","responseCode":"TEST_CARD_DECLINED","reference":"attempt-42"}}"#,
        CheckoutPublicStatus.sandboxValidated(
            merchantAttempt: MerchantAttempt(
                merchantName: "Meddu",
                merchantUrl: "https://meddu.com/",
                attemptedAt: "2026-08-02T16:00:00.000Z",
                responseText: "Test card declined",
                responseCode: "TEST_CARD_DECLINED",
                reference: "attempt-42"
            )
        )
    ),
    (
        #"{"status":"reconciliation_required","message":"Support is checking this approval."}"#,
        CheckoutPublicStatus.reconciliationRequired(message: "Support is checking this approval.")
    ),
    (
        #"{"status":"failed","message":"Nothing was ordered."}"#,
        CheckoutPublicStatus.failed(message: "Nothing was ordered.")
    ),
    (
        #"{"status":"failed","code":"PASSKEY_REG_FAILED","message":"Passkey registration failed. Nothing was ordered."}"#,
        CheckoutPublicStatus.failed(
            message: "PASSKEY_REG_FAILED: Passkey registration failed. Nothing was ordered."
        )
    ),
])
func decodesEveryPublicCheckoutStatus(
    json: String,
    expected: CheckoutPublicStatus
) throws {
    let decoded = try JSONDecoder().decode(
        CheckoutPublicStatus.self,
        from: #require(json.data(using: .utf8))
    )
    #expect(decoded == expected)
}

@Test(arguments: [
    (#"{"status":"approval_pending"}"#, CheckoutPublicStatus.pending),
    (#"{"status":"authorized"}"#, CheckoutPublicStatus.awaitingResult),
    (
        #"{"status":"order_placed","merchantOrderId":"ORDER-42","merchantOutcome":"live"}"#,
        CheckoutPublicStatus.completed(merchantOrderID: "ORDER-42", outcome: .live)
    ),
])
func decodesCommerceStatusAliases(
    json: String,
    expected: CheckoutPublicStatus
) throws {
    let decoded = try JSONDecoder().decode(
        CheckoutPublicStatus.self,
        from: #require(json.data(using: .utf8))
    )
    #expect(decoded == expected)
}

@Test func checkoutExperienceCopyKeepsAuthorizationAndOrderingDistinct() {
    let review = CheckoutExperienceCopy.status(.pending, approvalWasOpened: false)
    let pending = CheckoutExperienceCopy.status(.pending, approvalWasOpened: true)
    let authorized = CheckoutExperienceCopy.status(.awaitingResult, approvalWasOpened: true)
    let ordered = CheckoutExperienceCopy.status(
        .completed(merchantOrderID: "ORDER-42", outcome: .live),
        approvalWasOpened: true
    )
    let demoOrdered = CheckoutExperienceCopy.status(
        .completed(merchantOrderID: "SIM-123", outcome: .simulated),
        approvalWasOpened: true
    )
    let sandboxValidated = CheckoutExperienceCopy.status(
        .sandboxValidated(
            merchantAttempt: MerchantAttempt(
                merchantName: "Meddu",
                merchantUrl: "https://meddu.com/",
                attemptedAt: "2026-08-02T16:00:00.000Z",
                responseText: "Test card declined",
                responseCode: "TEST_CARD_DECLINED",
                reference: "attempt-42"
            )
        ),
        approvalWasOpened: true
    )
    let reconciled = CheckoutExperienceCopy.status(
        .reconciliationRequired(message: "Issuer approved — merchant result unknown"),
        approvalWasOpened: true
    )

    #expect(review.stage == .review)
    #expect(review.trust.contains("Not purchased"))
    #expect(review.showsExpiration)
    #expect(pending.stage == .approvalPending)
    #expect(pending.trust.contains("Not purchased"))
    #expect(pending.showsExpiration)
    #expect(authorized.stage == .authorized)
    #expect(authorized.trust.contains("not yet ordered"))
    #expect(!authorized.showsExpiration)
    #expect(ordered.stage == .orderPlaced)
    #expect(ordered.detail.contains("ORDER-42"))
    #expect(ordered.dismissesSecureApproval)
    #expect(!ordered.showsExpiration)
    #expect(demoOrdered.stage == .sandboxApproved)
    #expect(demoOrdered.status == "Approval complete")
    #expect(demoOrdered.title == "Order placed")
    #expect(demoOrdered.detail.contains("SIM-123"))
    #expect(!demoOrdered.trust.localizedCaseInsensitiveContains("sandbox"))
    #expect(!demoOrdered.trust.localizedCaseInsensitiveContains("no order"))
    #expect(demoOrdered.dismissesSecureApproval)
    #expect(sandboxValidated.stage == .sandboxValidated)
    #expect(sandboxValidated.status == "Expected decline recorded")
    #expect(sandboxValidated.title == "Merchant checkout was tested")
    #expect(sandboxValidated.detail.contains("Meddu"))
    #expect(sandboxValidated.trust.contains("Approval complete"))
    #expect(sandboxValidated.trust.contains("One-time card issued"))
    #expect(sandboxValidated.trust.contains("Merchant checkout attempted"))
    #expect(sandboxValidated.trust.localizedCaseInsensitiveContains("no order was placed"))
    #expect(sandboxValidated.trust.localizedCaseInsensitiveContains("no reimbursable expense"))
    #expect(!sandboxValidated.title.localizedCaseInsensitiveContains("order placed"))
    #expect(!sandboxValidated.detail.localizedCaseInsensitiveContains("reimbursement"))
    #expect(sandboxValidated.dismissesSecureApproval)
    #expect(reconciled.stage == .reconciliation)
    #expect(!reconciled.detail.contains("—"))
    #expect(!reconciled.showsExpiration)
}
