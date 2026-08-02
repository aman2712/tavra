import CoreGraphics
import Foundation
import ImageIO
import Testing
@testable import TavraMessagesCore

private let safetyCheckoutID = "demo_checkout_0123456789ABCDEFGH"
private let safetyTrustedHost = "tavratest-3000.euw.devtunnels.ms"

@Test func resumeCapabilityIsShortLivedAndConversationScoped() throws {
    let suiteName = "CheckoutResumeStoreTests.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suiteName))
    defaults.removePersistentDomain(forName: suiteName)
    defer { defaults.removePersistentDomain(forName: suiteName) }

    var now = Date(timeIntervalSince1970: 1_800_000_000)
    let store = CheckoutResumeStore(
        defaults: defaults,
        storageKey: "active-checkout",
        maximumLifetime: 120,
        now: { now }
    )
    let link = try CheckoutLink(
        url: #require(URL(string: "https://\(safetyTrustedHost)/pay/\(safetyCheckoutID)")),
        allowedHosts: [safetyTrustedHost]
    )

    store.save(
        link: link,
        conversationScope: "local:a|remote:b",
        approvalWasOpened: true,
        sessionExpiresAt: now.addingTimeInterval(600)
    )

    #expect(store.restore(
        conversationScope: "local:a|remote:someone-else",
        allowedHosts: [safetyTrustedHost]
    ) == nil)
    let restored = try #require(store.restore(
        conversationScope: "local:a|remote:b",
        allowedHosts: [safetyTrustedHost]
    ))
    #expect(restored.link == link)
    #expect(restored.approvalWasOpened)
    #expect(restored.expiresAt == now.addingTimeInterval(120))

    now = now.addingTimeInterval(121)
    #expect(store.restore(
        conversationScope: "local:a|remote:b",
        allowedHosts: [safetyTrustedHost]
    ) == nil)
}

@Test func resumeCapabilityIsRevalidatedAgainstCurrentTrustedHosts() throws {
    let suiteName = "CheckoutResumeHostTests.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suiteName))
    defaults.removePersistentDomain(forName: suiteName)
    defer { defaults.removePersistentDomain(forName: suiteName) }

    let store = CheckoutResumeStore(
        defaults: defaults,
        storageKey: "active-checkout"
    )
    let link = try CheckoutLink(
        url: #require(URL(string: "https://\(safetyTrustedHost)/pay/\(safetyCheckoutID)")),
        allowedHosts: [safetyTrustedHost]
    )
    store.save(
        link: link,
        conversationScope: "local:a|remote:b",
        approvalWasOpened: false
    )

    #expect(store.restore(
        conversationScope: "local:a|remote:b",
        allowedHosts: ["another.example"]
    ) == nil)
    #expect(store.restore(
        conversationScope: "local:a|remote:b",
        allowedHosts: [safetyTrustedHost]
    ) == nil)
}

@Test func imagePolicyRequiresAValidSafeImageAndRejectsGIF() throws {
    let png = try pngData(width: 24, height: 12)
    let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0, 0xFF, 0xD9])
    let webp = Data(Array("RIFF".utf8) + [0, 0, 0, 0] + Array("WEBP".utf8))
    let heic = Data([0, 0, 0, 24] + Array("ftyp".utf8) + Array("heic".utf8))
    let gif = Data("GIF89a".utf8)

    #expect(CheckoutImagePolicy.validates(png, mimeType: "image/png"))
    #expect(!CheckoutImagePolicy.validates(jpeg, mimeType: "image/jpeg"))
    #expect(!CheckoutImagePolicy.validates(webp, mimeType: "image/webp"))
    #expect(!CheckoutImagePolicy.validates(heic, mimeType: "image/heic"))
    #expect(!CheckoutImagePolicy.validates(gif, mimeType: "image/gif"))
    #expect(!CheckoutImagePolicy.validates(gif, mimeType: "image/png"))

    let link = try CheckoutLink(
        url: #require(URL(string: "https://\(safetyTrustedHost)/pay/\(safetyCheckoutID)")),
        allowedHosts: [safetyTrustedHost]
    )
    let staticGIF = try #require(URL(
        string: "https://\(safetyTrustedHost)/checkout-assets/products/item.gif"
    ))
    #expect(!link.allowsProductImage(staticGIF))
    #expect(!CheckoutImagePolicy.acceptHeader.contains("gif"))
}

@Test func imagePolicyRejectsUnsafeSourceDimensionsAndPixelCounts() {
    #expect(CheckoutImagePolicy.dimensionsAreSafe(width: 1, height: 1))
    #expect(CheckoutImagePolicy.dimensionsAreSafe(width: 5_000, height: 4_000))
    #expect(!CheckoutImagePolicy.dimensionsAreSafe(width: 0, height: 100))
    #expect(!CheckoutImagePolicy.dimensionsAreSafe(width: 8_193, height: 1))
    #expect(!CheckoutImagePolicy.dimensionsAreSafe(width: 5_001, height: 4_000))
    #expect(!CheckoutImagePolicy.dimensionsAreSafe(width: .max, height: 2))
}

@Test func imagePolicyDownsamplesWithoutDecodingTheFullSourceIntoUIKit() throws {
    let data = try pngData(width: 4_096, height: 2)
    let metadata = try #require(
        CheckoutImagePolicy.metadata(for: data, mimeType: "image/png; charset=binary")
    )
    #expect(metadata == CheckoutImageMetadata(width: 4_096, height: 2))

    let image = try #require(
        CheckoutImagePolicy.downsampledImage(from: data, mimeType: "image/png")
    )
    #expect(image.sourceWidth == 4_096)
    #expect(image.sourceHeight == 2)
    #expect(image.cgImage.width <= CheckoutImagePolicy.maximumThumbnailDimension)
    #expect(image.cgImage.height <= CheckoutImagePolicy.maximumThumbnailDimension)
    #expect(image.cgImage.width == 2_048)
}

@Test func productImageReadinessDeterministicallyGatesApproval() {
    #expect(CheckoutProductImageReadiness.aggregate([]) == .notRequired)
    #expect(CheckoutProductImageReadiness.aggregate([.loading, .ready]) == .loading)
    #expect(CheckoutProductImageReadiness.aggregate([.ready, .ready]) == .ready)
    #expect(CheckoutProductImageReadiness.aggregate([.ready, .unavailable]) == .unavailable)

    let review = CheckoutExperienceCopy.status(.pending, approvalWasOpened: false)
    let loading = review.gatedByProductImage(.loading)
    #expect(!loading.buttonEnabled)
    #expect(loading.status == "Checking product image")
    #expect(loading.trust.contains("Not purchased"))

    let unavailable = review.gatedByProductImage(.unavailable)
    #expect(!unavailable.buttonEnabled)
    #expect(unavailable.status == "Product image unavailable")
    #expect(unavailable.detail.contains("exact product image"))
    #expect(unavailable.trust.contains("Not purchased"))

    #expect(review.gatedByProductImage(.ready) == review)
    let authorized = CheckoutExperienceCopy.status(
        .awaitingResult,
        approvalWasOpened: true
    )
    #expect(authorized.gatedByProductImage(.unavailable) == authorized)
}

@Test func secureApprovalRequiresTheSystemBrowser() throws {
    try CheckoutApprovalPolicy.validate(surface: .systemBrowser)
    #expect(throws: CheckoutApprovalPolicyError.embeddedWebViewUnsupported) {
        try CheckoutApprovalPolicy.validate(surface: .embeddedWebView)
    }
    #expect(CheckoutApprovalPolicy.capabilityMessage.contains("Safari"))
    #expect(CheckoutApprovalPolicy.capabilityMessage.contains("Face ID"))

    let review = CheckoutExperienceCopy.status(.pending, approvalWasOpened: false)
    #expect(review.buttonTitle == "Continue securely in Safari")
    #expect(review.trust.contains("Touch ID"))
    let pending = CheckoutExperienceCopy.status(.pending, approvalWasOpened: true)
    #expect(pending.buttonTitle == "Resume in Safari")
    #expect(pending.trust.localizedCaseInsensitiveContains("embedded webview"))
}

private func pngData(width: Int, height: Int) throws -> Data {
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue
    let context = try #require(CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width * 4,
        space: colorSpace,
        bitmapInfo: bitmapInfo
    ))
    context.setFillColor(red: 0.2, green: 0.3, blue: 0.4, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let image = try #require(context.makeImage())
    let output = NSMutableData()
    let destination = try #require(CGImageDestinationCreateWithData(
        output,
        "public.png" as CFString,
        1,
        nil
    ))
    CGImageDestinationAddImage(destination, image, nil)
    try #require(CGImageDestinationFinalize(destination))
    return output as Data
}
