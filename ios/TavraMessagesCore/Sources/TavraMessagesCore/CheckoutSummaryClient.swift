import Foundation

public enum CheckoutClientError: Error, Equatable, LocalizedError, Sendable {
    case invalidHTTPResponse
    case untrustedRedirect
    case httpStatus(Int)
    case responseTooLarge
    case mismatchedSummary
    case invalidSummary
    case invalidProductImage

    public var errorDescription: String? {
        switch self {
        case .invalidHTTPResponse:
            "Tavra returned an invalid response."
        case .untrustedRedirect:
            "Tavra refused an unexpected checkout redirect."
        case let .httpStatus(status):
            status == 404
                ? "This checkout card is invalid or expired."
                : "Tavra could not load this checkout right now."
        case .responseTooLarge:
            "Tavra returned more checkout data than expected."
        case .mismatchedSummary:
            "The checkout summary did not match this card."
        case .invalidSummary:
            "The checkout summary was incomplete or malformed."
        case .invalidProductImage:
            "Tavra refused an untrusted product image."
        }
    }
}

public struct CheckoutSummaryClient: Sendable {
    private let session: URLSession

    public init(session: URLSession = CheckoutSummaryClient.ephemeralSession()) {
        self.session = session
    }

    public func summary(for link: CheckoutLink) async throws -> CheckoutSummary {
        let data = try await fetch(try link.summaryURL, link: link)
        let summary: CheckoutSummary
        do {
            summary = try JSONDecoder().decode(CheckoutSummary.self, from: data)
        } catch {
            throw CheckoutClientError.invalidSummary
        }
        try summary.validate(for: link)
        return summary
    }

    public func status(for link: CheckoutLink) async throws -> CheckoutPublicStatus {
        let data = try await fetch(try link.statusURL, link: link)
        do {
            return try JSONDecoder().decode(CheckoutPublicStatus.self, from: data)
        } catch {
            throw CheckoutClientError.invalidSummary
        }
    }

    public func productImage(at url: URL, for link: CheckoutLink) async throws -> CheckoutProductImage {
        guard link.allowsProductImage(url) else {
            throw CheckoutClientError.invalidProductImage
        }
        var request = URLRequest(
            url: url,
            cachePolicy: .reloadIgnoringLocalAndRemoteCacheData,
            timeoutInterval: 15
        )
        request.setValue(CheckoutImagePolicy.acceptHeader, forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw CheckoutClientError.invalidHTTPResponse
        }
        guard http.url == url,
              link.hasSameOrigin(as: http.url),
              link.allowsProductImage(http.url ?? url) else {
            throw CheckoutClientError.untrustedRedirect
        }
        guard (200..<300).contains(http.statusCode) else {
            throw CheckoutClientError.httpStatus(http.statusCode)
        }
        guard let contentType = http.value(forHTTPHeaderField: "Content-Type")?
            .split(separator: ";", maxSplits: 1)
            .first?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased(),
              CheckoutImagePolicy.acceptedMIMETypes.contains(contentType) else {
            throw CheckoutClientError.invalidProductImage
        }
        guard data.count <= CheckoutImagePolicy.maximumBytes else {
            throw CheckoutClientError.responseTooLarge
        }
        guard let image = CheckoutImagePolicy.downsampledImage(
            from: data,
            mimeType: contentType
        ) else {
            throw CheckoutClientError.invalidProductImage
        }
        return image
    }

    public static func ephemeralSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 30
        configuration.waitsForConnectivity = true
        return URLSession(configuration: configuration)
    }

    private func fetch(_ url: URL, link: CheckoutLink) async throws -> Data {
        var request = URLRequest(
            url: url,
            cachePolicy: .reloadIgnoringLocalAndRemoteCacheData,
            timeoutInterval: 15
        )
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw CheckoutClientError.invalidHTTPResponse
        }
        guard http.url == url, link.hasSameOrigin(as: http.url) else {
            throw CheckoutClientError.untrustedRedirect
        }
        guard (200..<300).contains(http.statusCode) else {
            throw CheckoutClientError.httpStatus(http.statusCode)
        }
        guard data.count <= 128 * 1024 else {
            throw CheckoutClientError.responseTooLarge
        }
        return data
    }
}
