import CoreGraphics
import Foundation
import ImageIO

public struct CheckoutProductImage: @unchecked Sendable {
    public let cgImage: CGImage
    public let sourceWidth: Int
    public let sourceHeight: Int

    public init(cgImage: CGImage, sourceWidth: Int, sourceHeight: Int) {
        self.cgImage = cgImage
        self.sourceWidth = sourceWidth
        self.sourceHeight = sourceHeight
    }
}

public struct CheckoutImageMetadata: Equatable, Sendable {
    public let width: Int
    public let height: Int

    public init(width: Int, height: Int) {
        self.width = width
        self.height = height
    }
}

public enum CheckoutImagePolicy {
    public static let maximumBytes = 8 * 1024 * 1024
    public static let maximumSourceDimension = 8_192
    public static let maximumSourcePixelCount = 20_000_000
    public static let maximumThumbnailDimension = 2_048
    public static let acceptedMIMETypes = Set([
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/heic",
        "image/heif",
    ])
    public static let acceptHeader = acceptedMIMETypes.sorted().joined(separator: ",")

    public static func validates(_ data: Data, mimeType: String) -> Bool {
        metadata(for: data, mimeType: mimeType) != nil
    }

    public static func dimensionsAreSafe(width: Int, height: Int) -> Bool {
        guard width > 0,
              height > 0,
              width <= maximumSourceDimension,
              height <= maximumSourceDimension else {
            return false
        }
        let (pixelCount, overflow) = width.multipliedReportingOverflow(by: height)
        return !overflow && pixelCount <= maximumSourcePixelCount
    }

    public static func metadata(
        for data: Data,
        mimeType: String
    ) -> CheckoutImageMetadata? {
        guard validatesContainer(data, mimeType: mimeType),
              let source = imageSource(for: data),
              CGImageSourceGetCount(source) > 0,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil)
                as? [CFString: Any],
              let width = integerProperty(properties[kCGImagePropertyPixelWidth]),
              let height = integerProperty(properties[kCGImagePropertyPixelHeight]),
              dimensionsAreSafe(width: width, height: height) else {
            return nil
        }
        return CheckoutImageMetadata(width: width, height: height)
    }

    public static func downsampledImage(
        from data: Data,
        mimeType: String,
        maximumDimension: Int = maximumThumbnailDimension
    ) -> CheckoutProductImage? {
        guard maximumDimension > 0,
              maximumDimension <= maximumThumbnailDimension,
              validatesContainer(data, mimeType: mimeType),
              let source = imageSource(for: data),
              CGImageSourceGetCount(source) > 0,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil)
                as? [CFString: Any],
              let width = integerProperty(properties[kCGImagePropertyPixelWidth]),
              let height = integerProperty(properties[kCGImagePropertyPixelHeight]),
              dimensionsAreSafe(width: width, height: height) else {
            return nil
        }

        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maximumDimension,
        ]
        guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(
            source,
            0,
            options as CFDictionary
        ),
            thumbnail.width <= maximumDimension,
            thumbnail.height <= maximumDimension else {
            return nil
        }
        return CheckoutProductImage(
            cgImage: thumbnail,
            sourceWidth: width,
            sourceHeight: height
        )
    }

    private static func validatesContainer(_ data: Data, mimeType: String) -> Bool {
        let normalizedType = normalizedMIMEType(mimeType)
        guard !data.isEmpty,
              data.count <= maximumBytes,
              acceptedMIMETypes.contains(normalizedType) else {
            return false
        }

        switch normalizedType {
        case "image/png":
            return data.starts(with: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
        case "image/jpeg":
            return data.count >= 4 &&
                data.starts(with: [0xFF, 0xD8, 0xFF]) &&
                data.suffix(2).elementsEqual([0xFF, 0xD9])
        case "image/webp":
            return data.count >= 12 &&
                data.prefix(4).elementsEqual(Array("RIFF".utf8)) &&
                data.dropFirst(8).prefix(4).elementsEqual(Array("WEBP".utf8))
        case "image/heic", "image/heif":
            guard data.count >= 12,
                  data.dropFirst(4).prefix(4).elementsEqual(Array("ftyp".utf8)) else {
                return false
            }
            let brand = String(decoding: data.dropFirst(8).prefix(4), as: UTF8.self)
            let acceptedBrands = Set([
                "heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1",
            ])
            return acceptedBrands.contains(brand)
        default:
            return false
        }
    }

    private static func normalizedMIMEType(_ mimeType: String) -> String {
        mimeType
            .split(separator: ";", maxSplits: 1)
            .first?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() ?? ""
    }

    private static func imageSource(for data: Data) -> CGImageSource? {
        let options = [kCGImageSourceShouldCache: false] as CFDictionary
        return CGImageSourceCreateWithData(data as CFData, options)
    }

    private static func integerProperty(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber else { return nil }
        let result = number.intValue
        return result > 0 ? result : nil
    }
}
