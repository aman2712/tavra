import Foundation

public enum CheckoutExperienceStage: Equatable, Sendable {
    case review
    case approvalPending
    case authorized
    case orderPlaced
    case sandboxApproved
    case sandboxValidated
    case failed
    case reconciliation
}

public enum CheckoutExperienceTone: Equatable, Sendable {
    case neutral
    case active
    case success
    case warning
    case failure
}

public enum CheckoutProductImageReadiness: Equatable, Sendable {
    case notRequired
    case loading
    case ready
    case unavailable

    public static func aggregate(
        _ requiredImages: [CheckoutProductImageReadiness]
    ) -> Self {
        guard !requiredImages.isEmpty else { return .notRequired }
        if requiredImages.contains(.unavailable) { return .unavailable }
        if requiredImages.allSatisfy({ $0 == .ready }) { return .ready }
        return .loading
    }

    public var allowsApproval: Bool {
        self == .notRequired || self == .ready
    }
}

public struct CheckoutExperienceCopy: Equatable, Sendable {
    public let stage: CheckoutExperienceStage
    public let status: String
    public let title: String
    public let detail: String
    public let trust: String
    public let buttonTitle: String?
    public let buttonEnabled: Bool
    public let tone: CheckoutExperienceTone
    public let dismissesSecureApproval: Bool

    public var showsExpiration: Bool {
        stage == .review || stage == .approvalPending
    }

    public init(
        stage: CheckoutExperienceStage,
        status: String,
        title: String,
        detail: String,
        trust: String,
        buttonTitle: String?,
        buttonEnabled: Bool,
        tone: CheckoutExperienceTone,
        dismissesSecureApproval: Bool
    ) {
        self.stage = stage
        self.status = status
        self.title = title
        self.detail = detail
        self.trust = trust
        self.buttonTitle = buttonTitle
        self.buttonEnabled = buttonEnabled
        self.tone = tone
        self.dismissesSecureApproval = dismissesSecureApproval
    }

    public static func review(orderDescription: String) -> Self {
        .init(
            stage: .review,
            status: "Review, not purchased",
            title: "Review your recovery order",
            detail: clean(orderDescription),
            trust: "Not purchased. Tavra never receives your card details. Secure approval continues in Safari and uses Face ID or Touch ID.",
            buttonTitle: "Continue securely in Safari",
            buttonEnabled: true,
            tone: .neutral,
            dismissesSecureApproval: false
        )
    }

    public static func status(
        _ status: CheckoutPublicStatus,
        approvalWasOpened: Bool
    ) -> Self {
        switch status {
        case .pending where !approvalWasOpened:
            return .init(
                stage: .review,
                status: "Review, not purchased",
                title: "Review your recovery order",
                detail: "Check the exact item, delivery, and total before approving.",
                trust: "Not purchased. No payment approval has started. Secure approval continues in Safari with Face ID or Touch ID.",
                buttonTitle: "Continue securely in Safari",
                buttonEnabled: true,
                tone: .neutral,
                dismissesSecureApproval: false
            )
        case .pending:
            return .init(
                stage: .approvalPending,
                status: "Approval pending",
                title: "Complete the secure step",
                detail: "Finish the protected Prava approval in Safari to continue.",
                trust: "Not purchased. Face ID or Touch ID requires the system browser, not an embedded webview.",
                buttonTitle: "Resume in Safari",
                buttonEnabled: true,
                tone: .active,
                dismissesSecureApproval: false
            )
        case .awaitingResult:
            return .init(
                stage: .authorized,
                status: "Authorized, confirming order",
                title: "Approval received",
                detail: "Tavra is waiting for a verified merchant outcome.",
                trust: "Authorized, not yet ordered. Do not retry while Tavra confirms the result.",
                buttonTitle: "Confirming merchant order",
                buttonEnabled: false,
                tone: .active,
                dismissesSecureApproval: false
            )
        case let .completed(orderID, .live):
            return .init(
                stage: .orderPlaced,
                status: "Order placed",
                title: "Your merchant order is confirmed",
                detail: "Order \(clean(orderID))",
                trust: "Ordered. Dispatch and delivery are still waiting for merchant confirmation.",
                buttonTitle: nil,
                buttonEnabled: false,
                tone: .success,
                dismissesSecureApproval: true
            )
        case let .completed(reference, .simulated):
            return .init(
                stage: .sandboxApproved,
                status: "Approval complete",
                title: "Order placed",
                detail: "Reference \(clean(reference))",
                trust: "Return to Messages for your order and reimbursement updates.",
                buttonTitle: nil,
                buttonEnabled: false,
                tone: .success,
                dismissesSecureApproval: true
            )
        case let .completed(reference, .sandboxMerchant):
            return .init(
                stage: .sandboxValidated,
                status: "Sandbox flow validated",
                title: "Merchant checkout was tested",
                detail: "Reference \(clean(reference))",
                trust: "Approval complete. One-time card issued. Merchant checkout attempted. No order was placed, and no reimbursable expense was incurred.",
                buttonTitle: nil,
                buttonEnabled: false,
                tone: .success,
                dismissesSecureApproval: true
            )
        case let .sandboxValidated(attempt):
            return .init(
                stage: .sandboxValidated,
                status: "Expected decline recorded",
                title: "Merchant checkout was tested",
                detail: "\(clean(attempt.merchantName)): \(clean(attempt.responseText))",
                trust: "Approval complete. One-time card issued. Merchant checkout attempted. No order was placed, and no reimbursable expense was incurred.",
                buttonTitle: nil,
                buttonEnabled: false,
                tone: .success,
                dismissesSecureApproval: true
            )
        case let .reconciliationRequired(message):
            return .init(
                stage: .reconciliation,
                status: "Order status under review",
                title: "Please do not retry yet",
                detail: clean(message),
                trust: "The merchant outcome is unknown. Tavra is not claiming an order until it is reconciled.",
                buttonTitle: nil,
                buttonEnabled: false,
                tone: .warning,
                dismissesSecureApproval: true
            )
        case let .failed(message):
            return .init(
                stage: .failed,
                status: "No order confirmed",
                title: "The purchase did not complete",
                detail: clean(message),
                trust: "No merchant order is confirmed. Tavra will not retry without a new review.",
                buttonTitle: nil,
                buttonEnabled: false,
                tone: .failure,
                dismissesSecureApproval: true
            )
        }
    }

    public func gatedByProductImage(
        _ readiness: CheckoutProductImageReadiness
    ) -> Self {
        guard stage == .review || stage == .approvalPending else { return self }
        switch readiness {
        case .notRequired, .ready:
            return self
        case .loading:
            return .init(
                stage: stage,
                status: "Checking product image",
                title: "Verifying the exact item",
                detail: "Tavra is safely loading the merchant’s product image before approval.",
                trust: "Not purchased. Approval unlocks after the exact product image is ready.",
                buttonTitle: "Loading product image",
                buttonEnabled: false,
                tone: .neutral,
                dismissesSecureApproval: false
            )
        case .unavailable:
            return .init(
                stage: stage,
                status: "Product image unavailable",
                title: "Approval is paused",
                detail: "Tavra couldn’t safely load the merchant’s exact product image.",
                trust: "Not purchased. Reopen this card to try the image again before approving.",
                buttonTitle: "Image unavailable",
                buttonEnabled: false,
                tone: .warning,
                dismissesSecureApproval: false
            )
        }
    }

    private static func clean(_ value: String) -> String {
        value
            .replacingOccurrences(of: "—", with: ",")
            .replacingOccurrences(of: "–", with: "-")
            .replacingOccurrences(of: "--", with: ",")
            .replacingOccurrences(of: "\n\n\n", with: "\n\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
