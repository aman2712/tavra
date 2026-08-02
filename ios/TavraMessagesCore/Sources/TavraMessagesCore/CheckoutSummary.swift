import Foundation

public struct CheckoutSummary: Decodable, Equatable, Sendable {
    public struct Order: Decodable, Equatable, Sendable {
        public struct Product: Decodable, Equatable, Sendable {
            public let productRef: String?
            public let description: String
            public let unitPrice: String
            public let quantity: Int
            public let imageUrl: URL?

            public init(
                productRef: String? = nil,
                description: String,
                unitPrice: String,
                quantity: Int,
                imageUrl: URL? = nil
            ) {
                self.productRef = productRef
                self.description = description
                self.unitPrice = unitPrice
                self.quantity = quantity
                self.imageUrl = imageUrl
            }
        }

        public let description: String
        public let totalAmount: String
        public let currency: String
        public let products: [Product]

        public init(
            description: String,
            totalAmount: String,
            currency: String,
            products: [Product]
        ) {
            self.description = description
            self.totalAmount = totalAmount
            self.currency = currency
            self.products = products
        }
    }

    public let checkoutId: String
    public let approvalUrl: URL
    public let expiresAt: String
    public let order: Order

    public init(
        checkoutId: String,
        approvalUrl: URL,
        expiresAt: String,
        order: Order
    ) {
        self.checkoutId = checkoutId
        self.approvalUrl = approvalUrl
        self.expiresAt = expiresAt
        self.order = order
    }

    public func validate(for link: CheckoutLink) throws {
        let timestampParser = ISO8601DateFormatter()
        timestampParser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard checkoutId == link.checkoutID,
              approvalUrl == link.approvalURL,
              link.hasSameOrigin(as: approvalUrl) else {
            throw CheckoutClientError.mismatchedSummary
        }
        let locale = Locale(identifier: "en_US_POSIX")
        guard !order.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !order.products.isEmpty,
              order.products.count <= 20,
              order.currency.range(of: #"^[A-Z]{3}$"#, options: .regularExpression) != nil,
              let declaredTotal = Decimal(string: order.totalAmount, locale: locale),
              declaredTotal >= 0,
              timestampParser.date(from: expiresAt) != nil else {
            throw CheckoutClientError.invalidSummary
        }

        var calculatedTotal = Decimal.zero
        for product in order.products {
            guard !product.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  product.quantity > 0,
                  product.quantity <= 100,
                  let unitPrice = Decimal(string: product.unitPrice, locale: locale),
                  unitPrice >= 0,
                  (product.productRef == nil || product.productRef?.range(
                      of: #"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"#,
                      options: .regularExpression
                  ) != nil),
                  (product.imageUrl.map { link.allowsProductImage($0) } ?? true) else {
                throw CheckoutClientError.invalidSummary
            }
            calculatedTotal += unitPrice * Decimal(product.quantity)
        }
        guard calculatedTotal == declaredTotal else {
            throw CheckoutClientError.invalidSummary
        }
    }
}

public enum MerchantOutcome: String, Decodable, Equatable, Sendable {
    case simulated
    case live
}

public enum CheckoutPublicStatus: Equatable, Sendable {
    case pending
    case awaitingResult
    case completed(merchantOrderID: String, outcome: MerchantOutcome)
    case reconciliationRequired(message: String)
    case failed(message: String)
}

extension CheckoutPublicStatus: Decodable {
    private enum CodingKeys: String, CodingKey {
        case status
        case merchantOrderId
        case merchantOutcome
        case message
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let status = try container.decode(String.self, forKey: .status)
        switch status {
        case "pending":
            self = .pending
        case "awaiting_result":
            self = .awaitingResult
        case "completed":
            self = .completed(
                merchantOrderID: try container.decode(String.self, forKey: .merchantOrderId),
                outcome: try container.decode(MerchantOutcome.self, forKey: .merchantOutcome)
            )
        case "reconciliation_required":
            self = .reconciliationRequired(
                message: try container.decode(String.self, forKey: .message)
            )
        case "failed":
            self = .failed(message: try container.decode(String.self, forKey: .message))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .status,
                in: container,
                debugDescription: "Unknown Tavra checkout status"
            )
        }
    }
}
