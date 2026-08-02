import Foundation
import Testing
@testable import TavraMessagesCore

private let validCheckoutID = "B3V6ABeOkyMV0T4M-G_ID32b9aMs5EAH"
private let trustedHost = "pcjfd1p7-3000.euw.devtunnels.ms"

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
    "http://pcjfd1p7-3000.euw.devtunnels.ms/pay/\(validCheckoutID)",
    "https://evil.example/pay/\(validCheckoutID)",
    "https://child.pcjfd1p7-3000.euw.devtunnels.ms/pay/\(validCheckoutID)",
    "https://user:password@pcjfd1p7-3000.euw.devtunnels.ms/pay/\(validCheckoutID)",
    "https://pcjfd1p7-3000.euw.devtunnels.ms:444/pay/\(validCheckoutID)",
    "https://pcjfd1p7-3000.euw.devtunnels.ms/pay/\(validCheckoutID)?preview=1",
    "https://pcjfd1p7-3000.euw.devtunnels.ms/pay/short",
    "https://pcjfd1p7-3000.euw.devtunnels.ms/not-pay/\(validCheckoutID)",
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

@Test(arguments: [
    (#"{"status":"pending"}"#, CheckoutPublicStatus.pending),
    (#"{"status":"awaiting_result"}"#, CheckoutPublicStatus.awaitingResult),
    (
        #"{"status":"completed","merchantOrderId":"SIM-123","merchantOutcome":"simulated"}"#,
        CheckoutPublicStatus.completed(merchantOrderID: "SIM-123", outcome: .simulated)
    ),
    (
        #"{"status":"reconciliation_required","message":"Support is checking this approval."}"#,
        CheckoutPublicStatus.reconciliationRequired(message: "Support is checking this approval.")
    ),
    (
        #"{"status":"failed","message":"Nothing was ordered."}"#,
        CheckoutPublicStatus.failed(message: "Nothing was ordered.")
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
