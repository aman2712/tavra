import Foundation

public enum CheckoutLinkError: Error, Equatable, LocalizedError, Sendable {
    case noAllowedHosts
    case insecureScheme
    case untrustedHost
    case unexpectedPort
    case credentialsInURL
    case unexpectedQueryOrFragment
    case invalidPath
    case invalidCheckoutID
    case unableToBuildEndpoint

    public var errorDescription: String? {
        switch self {
        case .noAllowedHosts:
            "No trusted Tavra checkout host is configured."
        case .insecureScheme:
            "The Tavra checkout link must use HTTPS."
        case .untrustedHost:
            "This checkout card does not use the configured Tavra host."
        case .unexpectedPort:
            "This checkout card uses an unexpected network port."
        case .credentialsInURL:
            "Checkout links cannot include URL credentials."
        case .unexpectedQueryOrFragment:
            "This checkout card contains unexpected URL state."
        case .invalidPath, .invalidCheckoutID:
            "This checkout card is malformed or expired."
        case .unableToBuildEndpoint:
            "Tavra could not construct its checkout endpoint."
        }
    }
}

/// A capability URL delivered in an `MSMessage`. It contains only a high-entropy
/// checkout identifier. Treat it as sensitive even though it contains no card data.
public struct CheckoutLink: Equatable, Sendable {
    public let approvalURL: URL
    public let checkoutID: String

    private let scheme: String
    private let host: String
    private let port: Int?

    public init(url: URL, allowedHosts: Set<String>) throws {
        let trustedHosts = Set(
            allowedHosts
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
                .filter { !$0.isEmpty && !$0.contains("$(") }
        )
        guard !trustedHosts.isEmpty else { throw CheckoutLinkError.noAllowedHosts }

        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == "https" else {
            throw CheckoutLinkError.insecureScheme
        }
        guard components.user == nil, components.password == nil else {
            throw CheckoutLinkError.credentialsInURL
        }
        guard let normalizedHost = components.host?.lowercased(),
              trustedHosts.contains(normalizedHost) else {
            throw CheckoutLinkError.untrustedHost
        }
        guard components.port == nil || components.port == 443 else {
            throw CheckoutLinkError.unexpectedPort
        }
        guard components.query == nil, components.fragment == nil else {
            throw CheckoutLinkError.unexpectedQueryOrFragment
        }

        let segments = components.percentEncodedPath.split(separator: "/", omittingEmptySubsequences: false)
        guard segments.count == 3, segments[0].isEmpty, segments[1] == "pay" else {
            throw CheckoutLinkError.invalidPath
        }
        let checkoutID = String(segments[2])
        guard checkoutID.range(
            of: #"^[A-Za-z0-9_-]{20,128}$"#,
            options: .regularExpression
        ) != nil else {
            throw CheckoutLinkError.invalidCheckoutID
        }

        var canonical = URLComponents()
        canonical.scheme = "https"
        canonical.host = normalizedHost
        canonical.port = components.port
        canonical.percentEncodedPath = "/pay/\(checkoutID)"
        guard let approvalURL = canonical.url else {
            throw CheckoutLinkError.unableToBuildEndpoint
        }

        self.approvalURL = approvalURL
        self.checkoutID = checkoutID
        self.scheme = "https"
        self.host = normalizedHost
        self.port = components.port
    }

    public var summaryURL: URL {
        get throws {
            try endpoint(named: "summary")
        }
    }

    public var statusURL: URL {
        get throws {
            try endpoint(named: "status")
        }
    }

    public func hasSameOrigin(as url: URL?) -> Bool {
        guard let url,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return false
        }
        let normalizedPort = components.port == 443 ? nil : components.port
        let ownPort = port == 443 ? nil : port
        return components.scheme?.lowercased() == scheme &&
            components.host?.lowercased() == host &&
            normalizedPort == ownPort
    }

    /// Product thumbnails are limited to Tavra's versioned public checkout asset
    /// path on the exact checkout origin. Remote merchant URLs are intentionally
    /// not accepted by the native extension.
    public func allowsProductImage(_ url: URL) -> Bool {
        guard hasSameOrigin(as: url),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil else {
            return false
        }
        return components.percentEncodedPath.range(
            of: #"^/checkout-assets/products/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:png|jpe?g|webp|heic|heif)$"#,
            options: [.regularExpression, .caseInsensitive]
        ) != nil
    }

    private func endpoint(named endpoint: String) throws -> URL {
        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        components.port = port
        components.percentEncodedPath = "/api/prava/checkouts/\(checkoutID)/\(endpoint)"
        guard let url = components.url else {
            throw CheckoutLinkError.unableToBuildEndpoint
        }
        return url
    }
}
