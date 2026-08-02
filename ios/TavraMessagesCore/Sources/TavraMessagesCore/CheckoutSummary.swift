import Foundation

public struct CheckoutSummary: Decodable, Equatable, Sendable {
    public struct Merchant: Decodable, Equatable, Sendable {
        public let name: String
        public let domain: String?
        public let countryCode: String?
        public let provenance: String?

        public init(
            name: String,
            domain: String? = nil,
            countryCode: String? = nil,
            provenance: String? = nil
        ) {
            self.name = name
            self.domain = domain
            self.countryCode = countryCode
            self.provenance = provenance
        }
    }

    public struct Destination: Decodable, Equatable, Sendable {
        public let maskedLabel: String

        public init(maskedLabel: String) {
            self.maskedLabel = maskedLabel
        }
    }

    public struct Delivery: Decodable, Equatable, Sendable {
        public let label: String
        public let estimatedArrival: String?
        public let verified: Bool

        public init(
            label: String,
            estimatedArrival: String? = nil,
            verified: Bool
        ) {
            self.label = label
            self.estimatedArrival = estimatedArrival
            self.verified = verified
        }
    }

    public struct Allowance: Decodable, Equatable, Sendable {
        public let amount: String
        public let currency: String

        public init(amount: String, currency: String) {
            self.amount = amount
            self.currency = currency
        }
    }

    public struct Quote: Decodable, Equatable, Sendable {
        public let id: String?
        public let expiresAt: String

        public init(id: String? = nil, expiresAt: String) {
            self.id = id
            self.expiresAt = expiresAt
        }
    }

    public struct Pricing: Decodable, Equatable, Sendable {
        public let subtotal: String
        public let shipping: String
        public let tax: String
        public let discount: String?
        public let total: String

        public init(
            subtotal: String,
            shipping: String,
            tax: String,
            discount: String? = nil,
            total: String
        ) {
            self.subtotal = subtotal
            self.shipping = shipping
            self.tax = tax
            self.discount = discount
            self.total = total
        }
    }

    public struct Order: Decodable, Equatable, Sendable {
        public struct Product: Decodable, Equatable, Sendable {
            public let productRef: String?
            public let variantRef: String?
            public let description: String
            public let variant: String?
            public let options: [String: String]?
            public let unitPrice: String
            public let quantity: Int
            public let imageUrl: URL?
            public let imageAltText: String?

            public init(
                productRef: String? = nil,
                variantRef: String? = nil,
                description: String,
                variant: String? = nil,
                options: [String: String]? = nil,
                unitPrice: String,
                quantity: Int,
                imageUrl: URL? = nil,
                imageAltText: String? = nil
            ) {
                self.productRef = productRef
                self.variantRef = variantRef
                self.description = description
                self.variant = variant
                self.options = options
                self.unitPrice = unitPrice
                self.quantity = quantity
                self.imageUrl = imageUrl
                self.imageAltText = imageAltText
            }

            public var displayVariant: String? {
                if let variant = variant?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !variant.isEmpty {
                    return variant
                }
                guard let options, !options.isEmpty else { return nil }
                return options
                    .sorted { $0.key.localizedCaseInsensitiveCompare($1.key) == .orderedAscending }
                    .map { "\($0.key) \($0.value)" }
                    .joined(separator: " · ")
            }
        }

        public let description: String
        public let totalAmount: String
        public let currency: String
        public let products: [Product]
        public let merchant: Merchant?
        public let destination: Destination?
        public let delivery: Delivery?
        public let allowance: Allowance?
        public let quote: Quote?
        public let pricing: Pricing?

        public init(
            description: String,
            totalAmount: String,
            currency: String,
            products: [Product],
            merchant: Merchant? = nil,
            destination: Destination? = nil,
            delivery: Delivery? = nil,
            allowance: Allowance? = nil,
            quote: Quote? = nil,
            pricing: Pricing? = nil
        ) {
            self.description = description
            self.totalAmount = totalAmount
            self.currency = currency
            self.products = products
            self.merchant = merchant
            self.destination = destination
            self.delivery = delivery
            self.allowance = allowance
            self.quote = quote
            self.pricing = pricing
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

    public var requiredLiveProductImageIndexes: [Int] {
        guard order.merchant?.provenance?
            .range(of: "Prava UCP", options: .caseInsensitive) != nil else {
            return []
        }
        return order.products.indices.filter { order.products[$0].imageUrl != nil }
    }

    public func validate(for link: CheckoutLink) throws {
        let locale = Locale(identifier: "en_US_POSIX")
        guard checkoutId == link.checkoutID,
              approvalUrl == link.approvalURL,
              link.hasSameOrigin(as: approvalUrl) else {
            throw CheckoutClientError.mismatchedSummary
        }
        guard isPresent(order.description, maximum: 240),
              !order.products.isEmpty,
              order.products.count <= 20,
              isCurrency(order.currency),
              let declaredTotal = decimal(order.totalAmount, locale: locale),
              isTimestamp(expiresAt) else {
            throw CheckoutClientError.invalidSummary
        }

        var calculatedSubtotal = Decimal.zero
        for product in order.products {
            guard isPresent(product.description, maximum: 240),
                  product.quantity > 0,
                  product.quantity <= 100,
                  let unitPrice = decimal(product.unitPrice, locale: locale),
                  isSafeReference(product.productRef),
                  isSafeReference(product.variantRef),
                  isOptionalText(product.variant, maximum: 160),
                  isOptionalText(product.imageAltText, maximum: 300),
                  areSafeOptions(product.options),
                  (product.imageUrl.map { link.allowsProductImage($0) } ?? true) else {
                throw CheckoutClientError.invalidSummary
            }
            calculatedSubtotal += unitPrice * Decimal(product.quantity)
        }

        if let pricing = order.pricing {
            guard let subtotal = decimal(pricing.subtotal, locale: locale),
                  let shipping = decimal(pricing.shipping, locale: locale),
                  let tax = decimal(pricing.tax, locale: locale),
                  let discount = decimal(pricing.discount ?? "0", locale: locale),
                  let total = decimal(pricing.total, locale: locale),
                  calculatedSubtotal == subtotal,
                  subtotal + shipping + tax - discount == total,
                  total == declaredTotal else {
                throw CheckoutClientError.invalidSummary
            }
        } else if calculatedSubtotal != declaredTotal {
            throw CheckoutClientError.invalidSummary
        }

        if let merchant = order.merchant {
            guard isPresent(merchant.name, maximum: 100),
                  isOptionalText(merchant.domain, maximum: 253),
                  merchant.domain?.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
                  (merchant.countryCode == nil || merchant.countryCode?.range(
                    of: #"^[A-Z]{2}$"#,
                    options: .regularExpression
                  ) != nil),
                  isOptionalText(merchant.provenance, maximum: 160) else {
                throw CheckoutClientError.invalidSummary
            }
        }
        if let destination = order.destination,
           !isPresent(destination.maskedLabel, maximum: 180) {
            throw CheckoutClientError.invalidSummary
        }
        if let delivery = order.delivery {
            guard isPresent(delivery.label, maximum: 160),
                  (delivery.estimatedArrival == nil || isTimestamp(
                    delivery.estimatedArrival ?? ""
                  )) else {
                throw CheckoutClientError.invalidSummary
            }
        }
        if let allowance = order.allowance {
            guard allowance.currency == order.currency,
                  decimal(allowance.amount, locale: locale) != nil else {
                throw CheckoutClientError.invalidSummary
            }
        }
        if let quote = order.quote {
            guard isOptionalText(quote.id, maximum: 160),
                  isTimestamp(quote.expiresAt) else {
                throw CheckoutClientError.invalidSummary
            }
        }
    }

    private func decimal(_ value: String, locale: Locale) -> Decimal? {
        guard let result = Decimal(string: value, locale: locale), result >= 0 else {
            return nil
        }
        return result
    }

    private func isCurrency(_ value: String) -> Bool {
        value.range(of: #"^[A-Z]{3}$"#, options: .regularExpression) != nil
    }

    private func isTimestamp(_ value: String) -> Bool {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if parser.date(from: value) != nil { return true }
        parser.formatOptions = [.withInternetDateTime]
        return parser.date(from: value) != nil
    }

    private func isPresent(_ value: String, maximum: Int) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed.count <= maximum
    }

    private func isOptionalText(_ value: String?, maximum: Int) -> Bool {
        value == nil || isPresent(value ?? "", maximum: maximum)
    }

    private func isSafeReference(_ value: String?) -> Bool {
        value == nil || value?.range(
            of: #"^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$"#,
            options: .regularExpression
        ) != nil
    }

    private func areSafeOptions(_ options: [String: String]?) -> Bool {
        guard let options else { return true }
        return options.count <= 12 && options.allSatisfy {
            isPresent($0.key, maximum: 48) && isPresent($0.value, maximum: 96)
        }
    }
}

public enum MerchantOutcome: String, Decodable, Equatable, Sendable {
    case simulated
    case sandboxMerchant = "sandbox_merchant"
    case live
}

public struct MerchantAttempt: Decodable, Equatable, Sendable {
    public let merchantName: String
    public let merchantUrl: String
    public let attemptedAt: String
    public let responseText: String
    public let responseCode: String
    public let reference: String?

    public init(
        merchantName: String,
        merchantUrl: String,
        attemptedAt: String,
        responseText: String,
        responseCode: String,
        reference: String? = nil
    ) {
        self.merchantName = merchantName
        self.merchantUrl = merchantUrl
        self.attemptedAt = attemptedAt
        self.responseText = responseText
        self.responseCode = responseCode
        self.reference = reference
    }
}

public enum CheckoutPublicStatus: Equatable, Sendable {
    case pending
    case awaitingResult
    case completed(merchantOrderID: String, outcome: MerchantOutcome)
    case sandboxValidated(merchantAttempt: MerchantAttempt)
    case reconciliationRequired(message: String)
    case failed(message: String)

    public var isTerminal: Bool {
        switch self {
        case .pending, .awaitingResult:
            false
        case .completed, .sandboxValidated, .reconciliationRequired, .failed:
            true
        }
    }
}

extension CheckoutPublicStatus: Decodable {
    private enum CodingKeys: String, CodingKey {
        case status
        case merchantOrderId
        case merchantOutcome
        case merchantAttempt
        case code
        case message
    }

    private static func failureDetail(
        from container: KeyedDecodingContainer<CodingKeys>
    ) throws -> String {
        let message = try container.decode(String.self, forKey: .message)
        guard let code = try container.decodeIfPresent(String.self, forKey: .code),
              !code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !message.localizedCaseInsensitiveContains(code) else {
            return message
        }
        return "\(code): \(message)"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let status = try container.decode(String.self, forKey: .status)
        switch status {
        case "pending", "approval_pending":
            self = .pending
        case "awaiting_result", "authorized":
            self = .awaitingResult
        case "completed", "order_placed":
            self = .completed(
                merchantOrderID: try container.decode(String.self, forKey: .merchantOrderId),
                outcome: try container.decode(MerchantOutcome.self, forKey: .merchantOutcome)
            )
        case "sandbox_validated":
            self = .sandboxValidated(
                merchantAttempt: try container.decode(
                    MerchantAttempt.self,
                    forKey: .merchantAttempt
                )
            )
        case "reconciliation_required":
            self = .reconciliationRequired(
                message: try Self.failureDetail(from: container)
            )
        case "failed":
            self = .failed(message: try Self.failureDetail(from: container))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .status,
                in: container,
                debugDescription: "Unknown Tavra checkout status"
            )
        }
    }
}
