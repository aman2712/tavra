// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "TavraMessagesCore",
    platforms: [
        .iOS(.v17),
        .macOS(.v13),
    ],
    products: [
        .library(name: "TavraMessagesCore", targets: ["TavraMessagesCore"]),
    ],
    targets: [
        .target(name: "TavraMessagesCore"),
        .testTarget(
            name: "TavraMessagesCoreTests",
            dependencies: ["TavraMessagesCore"]
        ),
    ]
)
