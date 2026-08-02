import Foundation

public enum CheckoutApprovalSurface: Equatable, Sendable {
    case systemBrowser
    case embeddedWebView
}

public enum CheckoutApprovalPolicyError: Error, Equatable, LocalizedError, Sendable {
    case embeddedWebViewUnsupported

    public var errorDescription: String? {
        switch self {
        case .embeddedWebViewUnsupported:
            "Prava passkey approval cannot run inside an embedded webview. Open the secure checkout in Safari on a device with Face ID or Touch ID."
        }
    }
}

/// The Messages extension renders the native order review. Prava approval must
/// be handed to the system browser so WebAuthn can use the platform authenticator.
public enum CheckoutApprovalPolicy {
    public static let capabilityMessage =
        "Secure approval continues in Safari and uses Face ID or Touch ID."

    public static func validate(surface: CheckoutApprovalSurface) throws {
        guard surface == .systemBrowser else {
            throw CheckoutApprovalPolicyError.embeddedWebViewUnsupported
        }
    }
}
